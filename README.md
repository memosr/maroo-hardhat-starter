# maroo-hardhat-starter

[![CI](https://github.com/memosr/maroo-hardhat-starter/actions/workflows/ci.yml/badge.svg)](https://github.com/memosr/maroo-hardhat-starter/actions/workflows/ci.yml)

A Hardhat 3 + viem starter for building on [Maroo](https://www.maroo.io), the
KRW-native Layer 1. It deploys a contract behind a **PCL proxy** so the chain
can enforce compliance policies (denylist, volume limits, EAS attestations)
before your code runs.

- Hardhat 3, viem, `@maroo-chain/viem`, OpenZeppelin Upgradeable 5
- Solidity tests (forge-std, fuzzing) and TypeScript tests (`node:test`)
- Compiler and local network pinned to **Cancun**, the EVM level Maroo supports
- Safe testnet scripts: chain-ID guard, simulate-before-send, per-run fee cap,
  readable PCL errors
- Private key stored encrypted with Hardhat Keystore, never in `.env`

## Quick start

Requirements: Node.js 22.10+.

```bash
npm install
npm test            # compile + Solidity and TypeScript tests (local, free)
```

## Testnet

1. Store your **test-only** private key, encrypted:
   ```bash
   npx hardhat keystore set MAROO_PRIVATE_KEY
   ```
2. Get tOKRW from the [faucet](https://faucet.maroo.io).
3. Check everything without sending anything:
   ```bash
   npm run check:network
   ```
   It prints your balance and fees, calls the PCL precompile, and simulates
   the deployment to show its cost.
4. Deploy behind a PCL proxy (spends tOKRW):
   ```bash
   npm run deploy
   ```
5. Pay through the proxy:
   ```bash
   npm run pay                      # 0.001 tOKRW to yourself; MAROO_PAY_TO / MAROO_PAY_AMOUNT to change
   ```
6. Verify the source code on Maroo's Blockscout (free, nothing is sent on chain):
   ```bash
   npm run verify                   # PaymentRouter implementation, and KycResolver if set up
   ```
7. See PCL enforce a policy. Deny your own address, pay again, then clear:
   ```bash
   MAROO_DENY=<your address> npm run policy:denylist
   npm run pay                      # ✖ InDenylist(...) [PCL violation: denylist], nothing sent
   npm run policy:denylist          # empty MAROO_DENY clears policies
   ```

### KYC gate with EAS

Make `pay()` available only to addresses holding a KYC attestation that you
issued, the pattern a security-token (STO) app needs.

```bash
npm run kyc:setup    # deploy KycResolver, register schema, attach EAS policy to pay()
npm run kyc:check    # read-only: KYC state, can I pay?, can a stranger self-issue KYC?
npm run pay          # ✖ EasNoAttestationReceived(...) [PCL violation: attestation]
npm run kyc:grant    # attest kycPassed = true (MAROO_KYC_ADDRESS, MAROO_KYC_DAYS) and index it
npm run pay          # ✔ passes
npm run kyc:revoke   # revoke; pay() is blocked again
```

**Why a resolver is required:** Maroo's `EAS_POLICY` passes any sender who
holds a valid attestation of the schema. It does not check who issued it or
what it says, so on its own anyone could self-issue "KYC". `KycResolver` is
registered with the schema and makes EAS reject any attestation that is not
from your issuer, has no expiration, or does not encode `kycPassed = true`.
The schema UID includes the resolver address, so this cannot be bypassed.
Details in [docs/CHAIN_NOTES.md](docs/CHAIN_NOTES.md#eas).

### Measured costs (Maroo testnet, October 2026)

| Action | Fee |
|---|---|
| Deploy implementation | ~7.7 tOKRW |
| Deploy PCL proxy | ~12.1 tOKRW |
| `pay` through the proxy (no policy / EAS policy) | ~2.6 / ~3.3 tOKRW |
| Set denylist / clear policies | ~0.9 / ~0.6 tOKRW |
| `kyc:setup` (resolver + schema + EAS policy) | ~10.6 tOKRW |
| `kyc:grant` (attest + index) / `kyc:revoke` | ~4.7–5.3 / ~1.3 tOKRW |
| Call rejected by a PCL policy | **0**: caught in simulation, never sent |

Failed transactions still pay fees, so every script simulates first and stops
at `MAROO_FEE_CAP_OKRW`. Errors print as one line; set `MAROO_DEBUG=1` for a
full stack trace.

## Layout

```
contracts/PaymentRouter.sol     example contract (proxy-ready, initializer-based)
contracts/PaymentRouter.t.sol   Solidity tests: fuzzing, reentrancy
contracts/KycResolver.sol       EAS schema resolver: trusted issuer, kycPassed = true, expiry required
contracts/vendor/eas/           unmodified EAS 1.4.0 sources (MIT), same code Maroo runs
test/                           TypeScript tests: proxy flow, KYC resolver on real EAS, helpers
lib/                            network constants, fee budget, guarded send, PCL errors, script runner
scripts/                        check-network, deploy, pay, set-denylist, kyc-*
docs/CHAIN_NOTES.md             verified chain facts and why the config looks like this
```

## What can be tested where

| Area | Local (`npm test`) | Maroo testnet |
|---|---|---|
| Contract logic, proxy + initializer | ✅ | ✅ |
| KycResolver on real EAS 1.4.0 | ✅ | ✅ |
| PCL policies, OKRW precompile | ❌ chain-native, not simulated | ✅ |

Locally, OpenZeppelin's `TransparentUpgradeableProxy` stands in for the PCL
proxy. It takes the same `(logic, initialOwner, initializer)` arguments.

## License

MIT
