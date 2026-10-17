import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Abis } from "@maroo-chain/viem";
import { BaseError, encodeErrorResult, parseEther, type Hex } from "viem";

import { attestationState, CodedError, verdictFromError, verdictFromRevert, worstCaseFee } from "../web/src/core.js";
import { LANGS, message, messages, pickLang, ui } from "../web/src/i18n.js";

/** A viem-shaped error carrying revert data, like estimateGas throws. */
function revertError(data: Hex): BaseError {
  const err = new BaseError("execution reverted");
  (err as unknown as { data: Hex }).data = data;
  return err;
}

describe("web/src/core", () => {
  it("maps real PCL policy errors to chain-stage verdicts", () => {
    const sender = "0x00000000000000000000000000000000000000aa";
    const cases: [string, string][] = [
      ["EasNoAttestationReceived", "noKyc"],
      ["EasAttestationRevoked", "kycRevoked"],
      ["EasAttestationExpired", "kycExpired"],
      ["InDenylist", "denylisted"],
    ];
    for (const [errorName, code] of cases) {
      const data = encodeErrorResult({ abi: Abis.errors, errorName: errorName as "InDenylist", args: [sender] });
      const v = verdictFromError(revertError(data));
      assert.deepEqual([v.allowed, v.code, v.stage], [false, code, "chain"], errorName);
    }
  });

  it("maps contract errors to contract-stage verdicts, with the limit", () => {
    const v = verdictFromRevert("AmountAboveMax", [parseEther("2"), parseEther("1")], false);
    assert.deepEqual(v, { allowed: false, code: "amountAboveMax", vars: { max: "1 tOKRW" }, stage: "contract" });
    assert.equal(verdictFromRevert("SomethingElse", [], false).code, "reverted");
    assert.equal(verdictFromRevert("NewPolicyError", [], true).stage, "chain");
  });

  it("recognises wallet, balance and coded errors", () => {
    assert.equal(verdictFromError(new Error("insufficient funds for gas * price + value")).code, "insufficientFunds");
    assert.equal(verdictFromError(new Error("User rejected the request.")).code, "walletRejected");
    assert.deepEqual(verdictFromError(new CodedError("wrongChain", { chainId: "1" })).vars, { chainId: "1" });
    assert.deepEqual(verdictFromError(new Error("boom\nstack")).vars, { message: "boom" });
  });

  it("classifies attestations like PCL does", () => {
    const now = 1_000n;
    assert.equal(attestationState({ revocationTime: 0n, expirationTime: 2_000n }, now), "active");
    assert.equal(attestationState({ revocationTime: 0n, expirationTime: 0n }, now), "active");
    assert.equal(attestationState({ revocationTime: 0n, expirationTime: 1_000n }, now), "expired");
    assert.equal(attestationState({ revocationTime: 5n, expirationTime: 2_000n }, now), "revoked");
  });

  it("adds 30% gas headroom to the fee preview", () => {
    assert.deepEqual(worstCaseFee(100_000n, 10n), { gas: 130_000n, fee: 1_300_000n });
  });
});

describe("web/src/i18n", () => {
  it("defines the same keys in English and Turkish", () => {
    for (const table of [ui, messages]) {
      const en = Object.keys(table.en).sort();
      for (const lang of LANGS) assert.deepEqual(Object.keys(table[lang]).sort(), en, lang);
    }
  });

  it("uses the same placeholders in both languages", () => {
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    for (const key of Object.keys(ui.en)) assert.equal(holes(ui.tr[key]), holes(ui.en[key]), key);
    for (const key of Object.keys(messages.en)) {
      assert.equal(holes(messages.tr[key].title + messages.tr[key].detail), holes(messages.en[key].title + messages.en[key].detail), key);
    }
  });

  it("has a message for every code the app can produce", () => {
    const codes = ["noKyc", "kycRevoked", "kycExpired", "kycLookupFailed", "denylisted", "chainRule", "amountAboveMax", "zeroAmount", "zeroRecipient", "transferFailed", "invalidAttestation", "accessDenied", "reverted", "insufficientFunds", "walletRejected", "unknown", "noWallet", "noAccount", "connectFirst", "wrongChain", "revertedOnChain", "feeTooHigh", "payAllowed", "grantAllowed", "indexReady", "revokeAllowed"];
    for (const code of codes) for (const lang of LANGS) assert.ok(messages[lang][code], `${lang}.${code}`);
  });

  it("fills placeholders and picks a language", () => {
    assert.equal(message("tr", "amountAboveMax", { max: "1 tOKRW" }).detail, "Sözleşme ödeme başına en fazla 1 tOKRW kabul eder.");
    assert.equal(pickLang(null, ["tr-TR", "en"]), "tr");
    assert.equal(pickLang(null, ["de-DE"]), "en");
    assert.equal(pickLang("en", ["tr-TR"]), "en");
  });
});
