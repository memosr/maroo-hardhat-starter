# Maroo testnet notes

Facts this template relies on, and how each was verified. Re-check them if
the chain upgrades.

| Fact | Value | How it was verified |
|---|---|---|
| Chain ID | `450815` | `eth_chainId` = `0x6e0ff`; matches `@maroo-chain/viem` `marooTestnet` |
| RPC | `https://rpc-testnet.maroo.io` | `@maroo-chain/viem` chain definition |
| Explorer | `https://explorer-testnet.maroo.io` (Blockscout) | `@maroo-chain/viem` chain definition |
| Native token | tOKRW, 18 decimals | `@maroo-chain/viem` chain definition |
| Fee model | EIP-1559 (base fee ~8,000 gwei, priority ~1,000 gwei) | `baseFeePerGas` present in latest block; `eth_maxPriorityFeePerGas` |
| EVM level | **Cancun**: PUSH0, TSTORE/TLOAD, MCOPY work | `eth_call` with initcode probes, each returned `1` |
| Not supported | **Osaka** CLZ (`0x1e`) | probe returned `invalid opcode: CLZ` |

## Why `evmVersion` is pinned to `cancun`

solc 0.8.34 targets **osaka** by default. Code compiled with the default can
contain CLZ, which Maroo rejects. With `evmVersion: "cancun"` such code fails
at compile time instead of on chain. The local test network is pinned to the
same hardfork, and `test/PaymentRouter.ts` scans deployed bytecode for CLZ.

## PCL proxies

Contracts that need PCL compliance policies run behind a proxy created by the
PCL precompile (`0x1000000000000000000000000000000000000005`):

- `deployPclProxy(kind, value, initData)`; kinds: Transparent `1`, UUPS `2`, Beacon `3`
- Transparent init data: `abi.encode(logic, initialOwner, initializer)`; the
  initializer must be non-empty
- The deployer is atomically bound as the proxy's contract-policy admin
- The proxy address comes from the `PclProxyDeployed(proxy, deployer, kind)`
  event emitted by the precompile

Because the proxy runs your implementation through `initialize`, contracts use
OpenZeppelin `Initializable` with `_disableInitializers()` in the constructor.

## Costs

Measured on testnet with this template (base fee 8,000 gwei):

| Action | Gas / fee |
|---|---|
| Plain transfer (0 value, to self) | ~60,000 gas (Ethereum: 21,000) |
| Deploy `PaymentRouter` implementation | ~7.7 tOKRW |
| `deployPclProxy` (Transparent) | ~12.1 tOKRW |
| `pay` through the PCL proxy | ~2.6 tOKRW |
| `changeContractPolicies` (denylist) / `removeContractPolicies` | ~0.9 / ~0.6 tOKRW |

Failed transactions still pay fees. A PCL policy rejection is visible to
`eth_estimateGas` (for example `InDenylist(address)`), so the scripts simulate
every transaction first, stop there at no cost, and enforce a per-run fee cap.

## ABI versions

Use `@maroo-chain/contracts` 0.0.9+ and `@maroo-chain/viem` 0.4.0+. Older
ABIs call removed methods: for example `globalOkrwEasPeriodicVolume(address)`
now reverts with `ABISetupFailed("no method with id: 0xfcd6064b")`.
