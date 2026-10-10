import { Abis, PclViolation } from "@maroo-chain/viem";
import {
  BaseError,
  decodeErrorResult,
  formatEther,
  isHex,
  type Hex,
  type TransactionReceipt,
} from "viem";

import { MAROO_TESTNET } from "./network.js";

/** Format a wei amount of the native token as a human-readable tOKRW string. */
export function formatOKRW(wei: bigint): string {
  return `${formatEther(wei)} tOKRW`;
}

/**
 * Refuse to continue unless the connected chain is Maroo testnet.
 * Protects against signing with a key on the wrong network.
 */
export async function assertMarooTestnet(client: {
  getChainId: () => Promise<number>;
}): Promise<void> {
  const chainId = await client.getChainId();
  if (chainId !== MAROO_TESTNET.chainId) {
    throw new Error(
      `Wrong network: connected to chain ${chainId}, expected Maroo testnet (${MAROO_TESTNET.chainId}).`,
    );
  }
}

/**
 * Session fee cap. Maroo testnet gas is expensive (~9,000 gwei; a plain
 * transfer costs ~1 tOKRW and failed transactions still pay fees), so every
 * script reserves the worst-case fee before sending and records the real fee
 * after the receipt.
 */
export class FeeBudget {
  #spent = 0n;
  #reserved = 0n;

  constructor(readonly capWei: bigint) {
    if (capWei <= 0n) throw new Error("Fee cap must be greater than zero.");
  }

  get spentWei(): bigint {
    return this.#spent;
  }

  /** Reserve `gasLimit * maxFeePerGas` before sending. Throws if the cap would be exceeded. */
  reserve(gasLimit: bigint, maxFeePerGas: bigint): bigint {
    if (gasLimit <= 0n || maxFeePerGas <= 0n) {
      throw new Error("gasLimit and maxFeePerGas must be greater than zero.");
    }
    const worstCase = gasLimit * maxFeePerGas;
    if (this.#spent + this.#reserved + worstCase > this.capWei) {
      throw new Error(
        `Fee cap exceeded: this transaction may cost up to ${formatOKRW(worstCase)}, ` +
          `already spent ${formatOKRW(this.#spent)} of ${formatOKRW(this.capWei)}.`,
      );
    }
    this.#reserved += worstCase;
    return worstCase;
  }

  /** Release a reservation and record the actual fee paid. */
  settle(reservedWei: bigint, receipt: Pick<TransactionReceipt, "gasUsed" | "effectiveGasPrice">): bigint {
    this.#reserved -= reservedWei;
    const fee = receipt.gasUsed * receipt.effectiveGasPrice;
    this.#spent += fee;
    return fee;
  }

  /** Release a reservation when the transaction was never sent. */
  release(reservedWei: bigint): void {
    this.#reserved -= reservedWei;
  }
}

/** Extract revert data from a viem error (walks the `cause` chain). */
export function extractRevertData(error: unknown): Hex | undefined {
  if (!(error instanceof BaseError)) return undefined;
  let data: Hex | undefined;
  error.walk((e) => {
    const candidate = (e as { data?: unknown }).data;
    if (typeof candidate === "string" && isHex(candidate) && candidate.length >= 10) {
      data = candidate;
      return true;
    }
    const nested = (candidate as { data?: unknown } | undefined)?.data;
    if (typeof nested === "string" && isHex(nested) && nested.length >= 10) {
      data = nested;
      return true;
    }
    return false;
  });
  return data;
}

export type DescribedRevert = {
  errorName: string;
  args: readonly unknown[];
  /** Structured PCL policy violation, when the revert came from a policy. */
  violation: PclViolation | null;
};

/**
 * Turn raw revert data into a readable error using Maroo's precompile error
 * ABIs (PCL policy errors, ABISetupFailed, ...) plus Solidity Error/Panic.
 * Returns null when the data does not match any known error.
 */
export function describeRevert(data: Hex, extraAbi: readonly unknown[] = []): DescribedRevert | null {
  for (const abi of [Abis.errors, extraAbi]) {
    try {
      const decoded = decodeErrorResult({ abi: abi as typeof Abis.errors, data });
      return {
        errorName: decoded.errorName,
        args: (decoded.args ?? []) as readonly unknown[],
        violation: abi === Abis.errors ? PclViolation.from(decoded) : null,
      };
    } catch {
      // try the next ABI
    }
  }
  return null;
}
