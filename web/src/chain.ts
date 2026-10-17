// Everything that talks to the chain or the wallet. Reads go over Maroo's
// public RPC; only signing goes through the browser wallet.
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  getAddress,
  http,
  isAddressEqual,
  numberToHex,
  zeroHash,
  type Abi,
  type Address,
  type EIP1193Provider,
  type Hex,
  type TransactionReceipt,
} from "viem";

import { attestedUid, encodeKycData } from "../../lib/kyc.js";
import { MAROO_TESTNET } from "../../lib/network.js";
import { attestationState, CodedError, MAX_FEE_PER_ACTION, verdictFromError, worstCaseFee, type AttestationState, type Verdict } from "./core.js";
import config from "./generated.json";

const chain = MAROO_TESTNET.chain;

export const addresses = {
  router: getAddress(config.proxy),
  eas: getAddress(config.kyc.eas),
  indexer: getAddress(config.kyc.indexer),
  issuer: getAddress(config.kyc.issuer),
  schemaUid: config.kyc.schemaUid as Hex,
};

const abi = {
  router: config.abi.router as Abi,
  eas: config.abi.eas as Abi,
  indexer: config.abi.indexer as Abi,
};

/** Custom errors from every contract the app calls (PCL errors come from lib/maroo.ts). */
const errorAbi = [...config.abi.router, ...config.abi.eas, ...config.abi.indexer, ...config.abi.resolver].filter(
  (x) => x.type === "error",
);

export const publicClient = createPublicClient({ chain, transport: http(MAROO_TESTNET.rpcUrl) });

export function explorerTx(hash: Hex): string {
  return `${MAROO_TESTNET.explorerUrl}/tx/${hash}`;
}
export function explorerAddress(address: Address): string {
  return `${MAROO_TESTNET.explorerUrl}/address/${address}`;
}

// ---------------------------------------------------------------- wallet

type Wallet = { provider: EIP1193Provider; account: Address };
let wallet: Wallet | null = null;

function injected(): EIP1193Provider | undefined {
  return (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
}

export function hasWallet(): boolean {
  return injected() !== undefined;
}

/** Ask the wallet for an account and switch it to Maroo testnet (adding the network if needed). */
export async function connect(): Promise<Address> {
  const provider = injected();
  if (!provider) throw new CodedError("noWallet");
  const [account] = await provider.request({ method: "eth_requestAccounts" });
  if (!account) throw new CodedError("noAccount");
  await switchToMaroo(provider);
  wallet = { provider, account: getAddress(account) };
  return wallet.account;
}

async function switchToMaroo(provider: EIP1193Provider): Promise<void> {
  const chainId = numberToHex(chain.id);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (error) {
    // 4902: the wallet does not know this chain yet.
    if ((error as { code?: number }).code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [MAROO_TESTNET.rpcUrl],
          blockExplorerUrls: [MAROO_TESTNET.explorerUrl],
        },
      ],
    });
  }
}

/**
 * Call `handler` when a connected wallet changes account or leaves Maroo.
 * Ignores the chainChanged that connect() itself triggers when switching to Maroo.
 */
export function onWalletChange(handler: () => void): void {
  const provider = injected();
  provider?.on("accountsChanged", (accounts) => {
    if (!wallet) return;
    if (accounts[0] && isAddressEqual(getAddress(accounts[0]), wallet.account)) return;
    wallet = null;
    handler();
  });
  provider?.on("chainChanged", (chainId) => {
    if (!wallet || Number(chainId) === chain.id) return;
    wallet = null;
    handler();
  });
}

// ---------------------------------------------------------------- reads

export type KycStatus =
  | { state: "none" }
  | { state: AttestationState; uid: Hex; expirationTime: bigint };

/** Latest indexed KYC attestation from the issuer for `address`. */
export async function readKyc(address: Address): Promise<KycStatus> {
  const uids = (await publicClient.readContract({
    address: addresses.indexer,
    abi: abi.indexer,
    functionName: "getReceivedAttestationUIDs",
    args: [address, addresses.schemaUid, 0n, 20n, true],
  })) as Hex[];
  const now = (await publicClient.getBlock()).timestamp;
  for (const uid of uids) {
    const a = (await publicClient.readContract({
      address: addresses.eas,
      abi: abi.eas,
      functionName: "getAttestation",
      args: [uid],
    })) as { attester: Address; revocationTime: bigint; expirationTime: bigint };
    if (!isAddressEqual(a.attester, addresses.issuer)) continue;
    return { state: attestationState(a, now), uid, expirationTime: a.expirationTime };
  }
  return { state: "none" };
}

export async function readBalance(address: Address): Promise<bigint> {
  return publicClient.getBalance({ address });
}

export async function readMaxPayment(): Promise<bigint> {
  return (await publicClient.readContract({ address: addresses.router, abi: abi.router, functionName: "maxPayment" })) as bigint;
}

// ---------------------------------------------------------------- writes

type TxRequest = { to: Address; data: Hex; value: bigint };

/** A simulated transaction, ready to send once the person confirms the fee. */
export type Prepared = {
  verdict: Verdict;
  request: TxRequest;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  fee: bigint;
};

export type Checked = { ok: true; prepared: Prepared } | { ok: false; verdict: Verdict };

function requireWallet(): Wallet {
  if (!wallet) throw new CodedError("connectFirst");
  return wallet;
}

/**
 * Simulate with eth_estimateGas. PCL policy rejections show up here, so a
 * blocked action never reaches the wallet and costs nothing.
 */
async function check(request: TxRequest, allowed: Verdict): Promise<Checked> {
  const { account } = requireWallet();
  let estimated: bigint;
  try {
    estimated = await publicClient.estimateGas({ account, ...request });
  } catch (error) {
    return { ok: false, verdict: verdictFromError(error, errorAbi) };
  }
  const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
  const { gas, fee } = worstCaseFee(estimated, maxFeePerGas);
  if (fee > MAX_FEE_PER_ACTION) {
    return { ok: false, verdict: { allowed: false, code: "feeTooHigh" } };
  }
  const balance = await publicClient.getBalance({ address: account });
  if (balance < fee + request.value) {
    return { ok: false, verdict: { allowed: false, code: "insufficientFunds" } };
  }
  return {
    ok: true,
    prepared: { verdict: allowed, request, gas, maxFeePerGas, maxPriorityFeePerGas, fee },
  };
}

/** Send a prepared transaction through the wallet and wait for it. */
export async function send(prepared: Prepared): Promise<TransactionReceipt> {
  const { provider, account } = requireWallet();
  const walletClient = createWalletClient({ account, chain, transport: custom(provider) });
  // The wallet may have been switched to another network since connecting.
  const walletChain = await walletClient.getChainId();
  if (walletChain !== chain.id) throw new CodedError("wrongChain", { chainId: String(walletChain) });

  const hash = await walletClient.sendTransaction({
    ...prepared.request,
    gas: prepared.gas,
    maxFeePerGas: prepared.maxFeePerGas,
    maxPriorityFeePerGas: prepared.maxPriorityFeePerGas,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new CodedError("revertedOnChain", { hash });
  return receipt;
}

export function checkPay(recipient: Address, amount: bigint): Promise<Checked> {
  return check(
    { to: addresses.router, data: encodeFunctionData({ abi: abi.router, functionName: "pay", args: [recipient] }), value: amount },
    { allowed: true, code: "payAllowed", stage: "contract" },
  );
}

export function checkGrant(recipient: Address, days: number): Promise<Checked> {
  const expirationTime = BigInt(Math.floor(Date.now() / 1000) + days * 86_400);
  const data = encodeFunctionData({
    abi: abi.eas,
    functionName: "attest",
    args: [
      {
        schema: addresses.schemaUid,
        data: { recipient, expirationTime, revocable: true, refUID: zeroHash, data: encodeKycData(true), value: 0n },
      },
    ],
  });
  return check({ to: addresses.eas, data, value: 0n }, { allowed: true, code: "grantAllowed", vars: { days: String(days) }, stage: "contract" });
}

/** After attest: index the new attestation so PCL's EAS policy finds it. */
export async function indexFromReceipt(receipt: TransactionReceipt): Promise<Checked> {
  const uid = attestedUid(receipt.logs, abi.eas, addresses.eas);
  return check(
    { to: addresses.indexer, data: encodeFunctionData({ abi: abi.indexer, functionName: "indexAttestation", args: [uid] }), value: 0n },
    { allowed: true, code: "indexReady", stage: "contract" },
  );
}

export function checkRevoke(uid: Hex): Promise<Checked> {
  const data = encodeFunctionData({ abi: abi.eas, functionName: "revoke", args: [{ schema: addresses.schemaUid, data: { uid, value: 0n } }] });
  return check({ to: addresses.eas, data, value: 0n }, { allowed: true, code: "revokeAllowed", stage: "contract" });
}
