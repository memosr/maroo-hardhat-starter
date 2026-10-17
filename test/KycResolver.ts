import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData, getAddress, zeroAddress, zeroHash, type Hex } from "viem";

import { attestedUid, encodeKycData, KYC_SCHEMA, kycSchemaUid } from "../lib/kyc.js";
import { describeRevert, extractRevertData } from "../lib/maroo.js";

// Runs the unmodified EAS 1.4.0 contracts (the same code Maroo testnet runs)
// locally, so the resolver is tested against real EAS behaviour.
describe("KycResolver with real EAS 1.4.0", async function () {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [issuer, investor, stranger] = await viem.getWalletClients();

  async function setup() {
    const registry = await viem.deployContract("SchemaRegistry");
    const eas = await viem.deployContract("EAS", [registry.address]);
    const indexer = await viem.deployContract("Indexer", [eas.address]);
    const resolver = await viem.deployContract("KycResolver", [eas.address, issuer.account.address]);
    await registry.write.register([KYC_SCHEMA, resolver.address, true]);
    const schemaUid = kycSchemaUid(resolver.address);
    return { registry, eas, indexer, resolver, schemaUid };
  }

  async function inOneHour() {
    return (await publicClient.getBlock()).timestamp + 3600n;
  }

  async function attest(
    ctx: Awaited<ReturnType<typeof setup>>,
    opts: { from?: typeof issuer; recipient?: Hex; data?: Hex; expirationTime?: bigint } = {},
  ) {
    const from = opts.from ?? issuer;
    return ctx.eas.write.attest(
      [
        {
          schema: ctx.schemaUid,
          data: {
            recipient: opts.recipient ?? investor.account.address,
            expirationTime: opts.expirationTime ?? (await inOneHour()),
            revocable: true,
            refUID: zeroHash,
            data: opts.data ?? encodeKycData(true),
            value: 0n,
          },
        },
      ],
      { account: from.account },
    );
  }

  it("registers the schema under the UID computed off-chain", async function () {
    const { registry, resolver, schemaUid } = await setup();
    const record = await registry.read.getSchema([schemaUid]);
    assert.equal(record.uid, schemaUid);
    assert.equal(getAddress(record.resolver), getAddress(resolver.address));
    assert.equal(record.revocable, true);
    assert.equal(record.schema, KYC_SCHEMA);
    assert.equal(await resolver.read.SCHEMA(), KYC_SCHEMA);
  });

  it("lets the issuer attest kycPassed = true, and the attestation can be indexed", async function () {
    const ctx = await setup();
    const hash = await attest(ctx);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const uid = attestedUid(receipt.logs, ctx.eas.abi, ctx.eas.address);

    const a = await ctx.eas.read.getAttestation([uid]);
    assert.equal(getAddress(a.attester), getAddress(issuer.account.address));
    assert.equal(getAddress(a.recipient), getAddress(investor.account.address));

    await ctx.indexer.write.indexAttestation([uid]);
    assert.equal(await ctx.indexer.read.isAttestationIndexed([uid]), true);
    const uids = await ctx.indexer.read.getReceivedAttestationUIDs([investor.account.address, ctx.schemaUid, 0n, 10n, false]);
    assert.deepEqual(uids, [uid]);
  });

  it("rejects attestations from anyone but the issuer (no self-KYC)", async function () {
    const ctx = await setup();
    await viem.assertions.revertWithCustomError(
      attest(ctx, { from: stranger, recipient: stranger.account.address }),
      ctx.eas,
      "InvalidAttestation",
    );
  });

  it("rejects kycPassed = false", async function () {
    const ctx = await setup();
    await viem.assertions.revertWithCustomError(attest(ctx, { data: encodeKycData(false) }), ctx.eas, "InvalidAttestation");
  });

  it("rejects malformed payloads", async function () {
    const ctx = await setup();
    // Two words instead of one, and a dirty 'true' (value 2).
    const twoWords = (encodeKycData(true) + encodeKycData(true).slice(2)) as Hex;
    const dirty = `0x${"0".repeat(63)}2` as Hex;
    await viem.assertions.revertWithCustomError(attest(ctx, { data: twoWords }), ctx.eas, "InvalidAttestation");
    await viem.assertions.revertWithCustomError(attest(ctx, { data: dirty }), ctx.eas, "InvalidAttestation");
  });

  it("rejects attestations without an expiration time", async function () {
    const ctx = await setup();
    await viem.assertions.revertWithCustomError(attest(ctx, { expirationTime: 0n }), ctx.eas, "InvalidAttestation");
  });

  it("rejects a zero recipient", async function () {
    const ctx = await setup();
    await viem.assertions.revertWithCustomError(attest(ctx, { recipient: zeroAddress }), ctx.eas, "InvalidAttestation");
  });

  it("lets only the issuer revoke", async function () {
    const ctx = await setup();
    const receipt = await publicClient.waitForTransactionReceipt({ hash: await attest(ctx) });
    const uid = attestedUid(receipt.logs, ctx.eas.abi, ctx.eas.address);
    const request = { schema: ctx.schemaUid, data: { uid, value: 0n } };

    await viem.assertions.revertWithCustomError(
      ctx.eas.write.revoke([request], { account: stranger.account }),
      ctx.eas,
      "AccessDenied",
    );
    await ctx.eas.write.revoke([request]);
    assert.ok((await ctx.eas.read.getAttestation([uid])).revocationTime > 0n);
  });

  it("only accepts calls from EAS", async function () {
    const ctx = await setup();
    const fake = await ctx.eas.read.getAttestation([zeroHash]); // empty Attestation struct
    await viem.assertions.revertWithCustomError(ctx.resolver.write.attest([fake]), ctx.resolver, "AccessDenied");
  });

  it("surfaces a stranger's self-KYC as InvalidAttestation in simulation (kyc:check path)", async function () {
    const ctx = await setup();
    const data = encodeFunctionData({
      abi: ctx.eas.abi,
      functionName: "attest",
      args: [
        {
          schema: ctx.schemaUid,
          data: {
            recipient: stranger.account.address,
            expirationTime: await inOneHour(),
            revocable: true,
            refUID: zeroHash,
            data: encodeKycData(true),
            value: 0n,
          },
        },
      ],
    });
    // Same steps as scripts/kyc-check.ts: estimateGas -> revert data -> readable error.
    const error = await publicClient.estimateGas({ account: stranger.account.address, to: ctx.eas.address, data }).then(
      () => assert.fail("simulation should revert"),
      (e: unknown) => e,
    );
    const raw = extractRevertData(error);
    assert.ok(raw, "revert data is available from estimateGas");
    const errorAbi = [...ctx.eas.abi, ...ctx.resolver.abi].filter((x) => x.type === "error");
    assert.equal(describeRevert(raw, errorAbi)?.errorName, "InvalidAttestation");
  });

  it("refuses a zero issuer", async function () {
    const { eas } = await setup();
    await assert.rejects(viem.deployContract("KycResolver", [eas.address, zeroAddress]));
  });
});
