import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData, getAddress, parseEther, zeroAddress } from "viem";

const PROXY = "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy";
const MAX = parseEther("10");

describe("PaymentRouter behind a Transparent proxy (PCL proxy stand-in)", async function () {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [owner, payer, recipient, stranger] = await viem.getWalletClients();

  async function deploy() {
    const implementation = await viem.deployContract("PaymentRouter");
    // Same init data shape Maroo's deployPclProxy(kind = Transparent) uses:
    // (logic, initialOwner, initializer)
    const initializer = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [owner.account.address, MAX],
    });
    const proxy = await viem.deployContract(PROXY, [implementation.address, owner.account.address, initializer]);
    const router = await viem.getContractAt("PaymentRouter", proxy.address);
    return { implementation, router };
  }

  it("initializes state through the proxy", async function () {
    const { router } = await deploy();
    assert.equal(getAddress(await router.read.owner()), getAddress(owner.account.address));
    assert.equal(await router.read.maxPayment(), MAX);
    assert.equal(await router.read.paymentCount(), 0n);
  });

  it("locks the implementation contract", async function () {
    const { implementation } = await deploy();
    await viem.assertions.revertWithCustomError(
      implementation.write.initialize([stranger.account.address, MAX]),
      implementation,
      "InvalidInitialization",
    );
  });

  it("cannot be initialized twice", async function () {
    const { router } = await deploy();
    await viem.assertions.revertWithCustomError(
      router.write.initialize([stranger.account.address, MAX]),
      router,
      "InvalidInitialization",
    );
  });

  it("forwards the payment, counts it and emits Paid", async function () {
    const { router } = await deploy();
    const amount = parseEther("1");
    const tx = router.write.pay([recipient.account.address], { value: amount, account: payer.account });

    await viem.assertions.balancesHaveChanged(tx, [
      { address: recipient.account.address, amount },
      { address: router.address, amount: 0n },
    ]);
    assert.equal(await router.read.paymentCount(), 1n);

    const [event] = await router.getEvents.Paid();
    assert.equal(getAddress(event.args.payer!), getAddress(payer.account.address));
    assert.equal(getAddress(event.args.recipient!), getAddress(recipient.account.address));
    assert.equal(event.args.amount, amount);
  });

  it("rejects zero amount, zero recipient and amounts above maxPayment", async function () {
    const { router } = await deploy();
    await viem.assertions.revertWithCustomError(
      router.write.pay([recipient.account.address], { value: 0n }),
      router,
      "ZeroAmount",
    );
    await viem.assertions.revertWithCustomError(
      router.write.pay([zeroAddress], { value: 1n }),
      router,
      "ZeroRecipient",
    );
    await viem.assertions.revertWithCustomErrorWithArgs(
      router.write.pay([recipient.account.address], { value: MAX + 1n }),
      router,
      "AmountAboveMax",
      [MAX + 1n, MAX],
    );
  });

  it("lets only the owner change maxPayment, and never to zero", async function () {
    const { router } = await deploy();
    await viem.assertions.revertWithCustomError(
      router.write.setMaxPayment([1n], { account: stranger.account }),
      router,
      "OwnableUnauthorizedAccount",
    );
    await viem.assertions.revertWithCustomError(router.write.setMaxPayment([0n]), router, "ZeroMaxPayment");
    await viem.assertions.emitWithArgs(router.write.setMaxPayment([5n]), router, "MaxPaymentUpdated", [MAX, 5n]);
    assert.equal(await router.read.maxPayment(), 5n);
  });

  it("deploys runtime bytecode without opcodes newer than Cancun", async function () {
    // Maroo testnet rejects Osaka's CLZ (0x1e). Guard against compiler drift.
    const { implementation } = await deploy();
    const code = await publicClient.getCode({ address: implementation.address });
    assert.ok(code && code.length > 2, "implementation has code");
    assert.deepEqual(findOpcodes(code, [0x1e]), [], "bytecode must not contain CLZ (0x1e)");
  });
});

/** Return offsets of the given opcodes, skipping PUSH data and the CBOR metadata tail. */
function findOpcodes(hex: string, opcodes: number[]): number[] {
  const bytes = Buffer.from(hex.slice(2), "hex");
  const metadataLength = bytes.length >= 2 ? bytes.readUInt16BE(bytes.length - 2) + 2 : 0;
  const end = metadataLength <= bytes.length ? bytes.length - metadataLength : bytes.length;
  const hits: number[] = [];
  for (let i = 0; i < end; i++) {
    const op = bytes[i];
    if (opcodes.includes(op)) hits.push(i);
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f; // PUSH1..PUSH32 data
  }
  return hits;
}
