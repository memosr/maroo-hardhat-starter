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
| `pay` through the PCL proxy with an `EAS_POLICY` | ~3.3 tOKRW |
| Deploy `KycResolver` / register schema / attach `EAS_POLICY` | ~8.4 / ~1.2 / ~0.9 tOKRW |
| EAS `attest` / `Indexer.indexAttestation` / EAS `revoke` | ~2.5 / ~2.1–2.7 / ~1.3 tOKRW |

Failed transactions still pay fees. A PCL policy rejection is visible to
`eth_estimateGas` (for example `InDenylist(address)`), so the scripts simulate
every transaction first, stop there at no cost, and enforce a per-run fee cap.

## ABI versions

Use `@maroo-chain/contracts` 0.0.9+ and `@maroo-chain/viem` 0.4.0+. Older
ABIs call removed methods: for example `globalOkrwEasPeriodicVolume(address)`
now reverts with `ABISetupFailed("no method with id: 0xfcd6064b")`.

## EAS

| Contract | Address | On-chain `version()` |
|---|---|---|
| SchemaRegistry | `0x1000000000000000000000000000000000000006` | `0.0.0` (see below) |
| EAS | `0x1000000000000000000000000000000000000007` | `1.4.0` |
| Indexer | `0x1000000000000000000000000000000000000008` | `1.4.0` |

Addresses come from the EAS precompile (`0x1000…09`) `getParams()`; scripts
read them from there instead of hard-coding them.

**These are standard EAS 1.4.0 EVM contracts.** Their runtime bytecode was
compared byte by byte with the official build
(`@ethereum-attestation-service/eas-contracts@1.9.0`). Sizes match exactly
(2,741 / 18,925 / 4,340 bytes), and every differing byte is either an
immutable value (registry and EAS addresses, version numbers, EIP-712
name/version and cached domain) or the solc version in the metadata
(0.8.28 on chain, 0.8.29 in the package). The logic is identical, so schema
resolvers work as in standard EAS.

Side notes from that comparison, both harmless:

- SchemaRegistry's version immutables are zero, so `version()` returns
  `0.0.0`. Registration and lookups use storage and are unaffected.
- EAS's cached EIP-712 domain was built for chain `31337` at
  `0x5FbDB2315678afecb367f032d93f642f64180aa3` (a local Hardhat deploy that was
  copied into genesis). OpenZeppelin's EIP712 detects the mismatch and
  recomputes the domain, so signatures still verify.

### What `EAS_POLICY` checks, and what it does not

A PCL `EAS_POLICY` (`easContract`, `indexContract`, `schemaUid`) lets a sender
pass when the Indexer finds a valid attestation of that schema for them (per
Maroo's identity docs and the workshop's testnet results; PCL's internal
algorithm is not public). The
policy errors are `EasAttestationRequired`, `EasNoAttestationReceived`,
`EasAttestationRevoked`, `EasAttestationExpired` and
`EasAttestationLookupFailed`.

It does **not** check:

- **who issued the attestation**: there is no issuer field in the policy,
  and the Indexer returns attestations from any attester;
- **what the attestation says**: a `false` payload passes (observed on
  testnet by [maroo-devrel-workshop](https://github.com/nubro999/maroo-devrel-workshop/blob/main/docs/POLICY_CAVEATS.md)).

Without a resolver, nothing stops anyone from self-issuing an attestation of
the schema, and the policy has no field to tell it apart from yours. Register
the schema with a resolver (here `KycResolver`): EAS calls it on every
attestation and reverts the attestation when it returns false. The schema UID
is `keccak256(schema, resolver, revocable)`, so attestations that skipped the
resolver cannot exist under it. `npm run kyc:check` simulates a stranger's
self-issued attestation to show the rejection on chain at no cost.

Attestations must also be **indexed** (`Indexer.indexAttestation(uid)`)
before PCL sees them; `npm run kyc:grant` does both steps.

## Source verification

`npm run verify` verifies the `PaymentRouter` implementation and `KycResolver`
on Maroo's Blockscout (`https://explorer-testnet.maroo.io/blockscout/api`,
Etherscan-compatible API). Verified on testnet in October 2026.

Build profiles must match: `hardhat run` deploys with the `default` profile
(optimizer off), but `hardhat verify` uses `production` (optimizer on) when no
profile is given, and the bytecode would never match. The npm script passes
`--build-profile default`, and `scripts/verify.ts` refuses to run otherwise.
The PCL proxy is created by the PCL precompile and has no source to verify.
