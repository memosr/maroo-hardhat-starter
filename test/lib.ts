import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Abis } from "@maroo-chain/viem";
import { encodeErrorResult, getAddress, parseEther } from "viem";

import { assertMarooTestnet, describeRevert, FeeBudget, formatOKRW } from "../lib/maroo.js";
import { MAROO_TESTNET } from "../lib/network.js";

describe("lib/maroo", () => {
  describe("assertMarooTestnet", () => {
    it("accepts chain 450815", async () => {
      await assertMarooTestnet({ getChainId: async () => 450815 });
      assert.equal(MAROO_TESTNET.chainId, 450815);
    });

    it("rejects any other chain", async () => {
      await assert.rejects(assertMarooTestnet({ getChainId: async () => 1 }), /Wrong network/);
    });
  });

  describe("FeeBudget", () => {
    const gwei = 1_000_000_000n;

    it("reserves worst-case fees and settles the real fee", () => {
      const budget = new FeeBudget(parseEther("5"));
      const reserved = budget.reserve(200_000n, 9_000n * gwei); // 1.8 tOKRW worst case
      const fee = budget.settle(reserved, { gasUsed: 100_000n, effectiveGasPrice: 9_000n * gwei });
      assert.equal(fee, parseEther("0.9"));
      assert.equal(budget.spentWei, parseEther("0.9"));
    });

    it("refuses a transaction that could exceed the cap", () => {
      const budget = new FeeBudget(parseEther("1"));
      assert.throws(() => budget.reserve(200_000n, 9_000n * gwei), /Fee cap exceeded/);
    });

    it("counts pending reservations against the cap", () => {
      const budget = new FeeBudget(parseEther("2"));
      budget.reserve(200_000n, 9_000n * gwei); // 1.8 reserved
      assert.throws(() => budget.reserve(50_000n, 9_000n * gwei), /Fee cap exceeded/);
    });

    it("rejects non-positive inputs", () => {
      assert.throws(() => new FeeBudget(0n));
      assert.throws(() => new FeeBudget(1n).reserve(0n, 1n));
    });
  });

  describe("describeRevert", () => {
    it("decodes a real Maroo testnet revert (removed PCL method)", () => {
      // Captured from rpc-testnet.maroo.io: calling the removed
      // globalOkrwEasPeriodicVolume(address) on the PCL precompile.
      const data =
        "0xcc49c7b10000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001d6e6f206d6574686f6420776974682069643a2030786663643630363462000000";
      const result = describeRevert(data);
      assert.equal(result?.errorName, "ABISetupFailed");
      assert.deepEqual(result?.args, ["no method with id: 0xfcd6064b"]);
    });

    it("maps a PCL denylist revert to a structured violation", () => {
      const sender = "0x00000000000000000000000000000000000000aa";
      const data = encodeErrorResult({ abi: Abis.errors, errorName: "InDenylist", args: [sender] });
      const result = describeRevert(data);
      assert.equal(result?.errorName, "InDenylist");
      assert.deepEqual(result?.violation, { kind: "denylist", sender: getAddress(sender) });
    });

    it("returns null for unknown data", () => {
      assert.equal(describeRevert("0xdeadbeef"), null);
    });
  });

  it("formats tOKRW amounts", () => {
    assert.equal(formatOKRW(parseEther("1.5")), "1.5 tOKRW");
  });
});
