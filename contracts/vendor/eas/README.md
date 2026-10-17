# Vendored EAS contracts

Unmodified copies of the Ethereum Attestation Service contracts, version
1.4.0, from the npm package `@ethereum-attestation-service/eas-contracts@1.9.0`
(MIT, see `LICENSE`). Upstream: https://github.com/ethereum-attestation-service/eas-contracts

Why vendored instead of installed: that npm package depends on Hardhat 2 and
pulls in about 190 extra packages with known vulnerabilities.

- `resolver/SchemaResolver.sol` and its interfaces are used by `KycResolver`.
- `EAS.sol`, `SchemaRegistry.sol`, `Indexer.sol` and `eip1271/` are used only by
  local tests. Maroo testnet runs this same 1.4.0 code at
  `0x1000…06` (SchemaRegistry), `0x1000…07` (EAS) and `0x1000…08` (Indexer);
  see `docs/CHAIN_NOTES.md` for the bytecode comparison.
