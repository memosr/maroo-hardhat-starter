import { marooTestnet } from "@maroo-chain/viem";

/**
 * Single source of truth for Maroo testnet constants, derived from the
 * official `@maroo-chain/viem` chain definition so they cannot drift.
 */
export const MAROO_TESTNET = {
  chainId: marooTestnet.id,
  rpcUrl: marooTestnet.rpcUrls.default.http[0],
  explorerUrl: marooTestnet.blockExplorers.default.url,
  explorerApiUrl: marooTestnet.blockExplorers.default.apiUrl,
  chain: marooTestnet,
} as const;

/** Maroo precompile addresses (verified on testnet, see docs/CHAIN_NOTES.md). */
export const PRECOMPILES = {
  OKRW: "0x1000000000000000000000000000000000000001",
  PCL: "0x1000000000000000000000000000000000000005",
  EAS: "0x1000000000000000000000000000000000000009",
  AGENT: "0x100000000000000000000000000000000000000A",
  PRIVACY: "0x100000000000000000000000000000000000000B",
} as const;
