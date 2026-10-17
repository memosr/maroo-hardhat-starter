// Pure logic for the web app (no DOM, no wallet). Tested from test/web-core.ts.
// Verdicts carry a message code; web/src/i18n.ts turns codes into text.
import { formatEther, type Hex } from "viem";

import { describeRevert, extractRevertData } from "../../lib/maroo.js";

/** Where a check stopped: Maroo's compliance layer (PCL), the contract, or before either. */
export type Stage = "chain" | "contract" | "other";

export type Vars = Record<string, string>;
export type Verdict = { allowed: boolean; code: string; vars?: Vars; stage?: Stage };

/** An error that already knows which message to show. */
export class CodedError extends Error {
  constructor(
    readonly code: string,
    readonly vars: Vars = {},
  ) {
    super(code);
  }
}

/** PCL policy errors (raised by the chain before the contract runs). */
const CHAIN_CODES: Record<string, string> = {
  EasNoAttestationReceived: "noKyc",
  EasAttestationRequired: "noKyc",
  EasAttestationRevoked: "kycRevoked",
  EasAttestationExpired: "kycExpired",
  EasAttestationLookupFailed: "kycLookupFailed",
  InDenylist: "denylisted",
};

/** Custom errors from this repo's contracts and EAS. */
const CONTRACT_CODES: Record<string, string> = {
  AmountAboveMax: "amountAboveMax",
  ZeroAmount: "zeroAmount",
  ZeroRecipient: "zeroRecipient",
  TransferFailed: "transferFailed",
  InvalidAttestation: "invalidAttestation",
  AccessDenied: "accessDenied",
};

const okrw = (v: unknown) => (typeof v === "bigint" ? `${formatEther(v)} tOKRW` : String(v));

/** Map a decoded revert to a verdict. `isPclViolation` comes from lib/maroo.ts. */
export function verdictFromRevert(errorName: string, args: readonly unknown[], isPclViolation: boolean): Verdict {
  const chainCode = CHAIN_CODES[errorName];
  if (chainCode) return { allowed: false, code: chainCode, stage: "chain" };
  if (isPclViolation) return { allowed: false, code: "chainRule", vars: { name: errorName }, stage: "chain" };

  const code = CONTRACT_CODES[errorName];
  if (code === "amountAboveMax") return { allowed: false, code, vars: { max: okrw(args[1]) }, stage: "contract" };
  if (code) return { allowed: false, code, stage: "contract" };
  return { allowed: false, code: "reverted", vars: { name: errorName }, stage: "contract" };
}

/** Turn a failed simulation or wallet error into a verdict a person can act on. */
export function verdictFromError(error: unknown, errorAbi: readonly unknown[] = []): Verdict {
  if (error instanceof CodedError) return { allowed: false, code: error.code, vars: error.vars };

  const data: Hex | undefined = extractRevertData(error);
  const decoded = data ? describeRevert(data, errorAbi) : null;
  if (decoded) return verdictFromRevert(decoded.errorName, decoded.args, decoded.violation !== undefined && decoded.violation !== null);

  const message = error instanceof Error ? error.message : String(error);
  if (/insufficient funds/i.test(message)) return { allowed: false, code: "insufficientFunds" };
  if (/user rejected|denied/i.test(message)) return { allowed: false, code: "walletRejected" };
  return { allowed: false, code: "unknown", vars: { message: message.split("\n")[0] } };
}

export type AttestationState = "active" | "revoked" | "expired";

/** Same rules PCL applies: revoked wins, then expiry (0 = never expires). */
export function attestationState(a: { revocationTime: bigint; expirationTime: bigint }, now: bigint): AttestationState {
  if (a.revocationTime > 0n) return "revoked";
  if (a.expirationTime !== 0n && a.expirationTime <= now) return "expired";
  return "active";
}

/** Gas headroom applied before showing a fee or sending (same as lib/send.ts). */
export const GAS_BUFFER_PERCENT = 130n;

/** Worst-case fee for a simulated transaction. */
export function worstCaseFee(estimatedGas: bigint, maxFeePerGas: bigint): { gas: bigint; fee: bigint } {
  const gas = (estimatedGas * GAS_BUFFER_PERCENT) / 100n;
  return { gas, fee: gas * maxFeePerGas };
}

/** Never let one click spend more than this in fees. */
export const MAX_FEE_PER_ACTION = 10n * 10n ** 18n;

export function shortHex(value: string, keep = 6): string {
  return value.length <= keep * 2 + 2 ? value : `${value.slice(0, keep + 2)}…${value.slice(-keep)}`;
}
