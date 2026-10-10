import type { Account, Address, Chain, Hex, PublicClient, TransactionReceipt, Transport, WalletClient } from "viem";

import { describeRevert, extractRevertData, formatOKRW, type FeeBudget } from "./maroo.js";

export type TxRequest = {
  /** Short label printed in logs, e.g. "deploy implementation". */
  label: string;
  /** Omit `to` for contract creation. */
  to?: Address;
  data: Hex;
  value?: bigint;
};

type Clients = {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  budget: FeeBudget;
  /** Extra error ABI (e.g. your contract's custom errors) for readable reverts. */
  errorAbi?: readonly unknown[];
};

/** Gas estimates on Maroo can be tight around PCL checks: add 30% headroom. */
const GAS_BUFFER_PERCENT = 130n;

/**
 * Send a transaction safely on Maroo:
 *  1. Simulate with eth_estimateGas. A revert (including PCL policy
 *     violations) stops here, BEFORE any fee is paid, with a readable reason.
 *  2. Reserve the worst-case fee in the session budget.
 *  3. Send, wait for the receipt, record the real fee.
 *  4. Throw if the transaction reverted on chain.
 */
export async function sendGuarded(
  { publicClient, walletClient, budget, errorAbi = [] }: Clients,
  request: TxRequest,
): Promise<TransactionReceipt> {
  const account = walletClient.account;
  const value = request.value ?? 0n;

  let estimated: bigint;
  try {
    estimated = await publicClient.estimateGas({ account, to: request.to, data: request.data, value });
  } catch (error) {
    const data = extractRevertData(error);
    const reason = data ? describeRevert(data, errorAbi) : null;
    const detail = reason
      ? `${reason.errorName}(${reason.args.map(String).join(", ")})` +
        (reason.violation ? ` [PCL violation: ${reason.violation.kind}]` : "")
      : (error as Error).message.split("\n")[0];
    throw new Error(`[${request.label}] simulation reverted, nothing was sent: ${detail}`);
  }

  const gas = (estimated * GAS_BUFFER_PERCENT) / 100n;
  const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
  const balance = await publicClient.getBalance({ address: account.address });
  if (balance < gas * maxFeePerGas + value) {
    throw new Error(
      `[${request.label}] insufficient balance: need up to ${formatOKRW(gas * maxFeePerGas + value)}, have ${formatOKRW(balance)}.`,
    );
  }

  const reserved = budget.reserve(gas, maxFeePerGas);
  let hash: Hex;
  try {
    hash = await walletClient.sendTransaction({
      account,
      chain: walletClient.chain,
      to: request.to,
      data: request.data,
      value,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
  } catch (error) {
    budget.release(reserved);
    throw error;
  }
  console.log(`[${request.label}] sent ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  const fee = budget.settle(reserved, receipt);
  console.log(`[${request.label}] ${receipt.status} in block ${receipt.blockNumber}, fee ${formatOKRW(fee)}`);

  if (receipt.status !== "success") {
    throw new Error(`[${request.label}] transaction ${hash} reverted on chain (fee was still charged).`);
  }
  return receipt;
}
