import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

import { MAROO_TESTNET } from "./lib/network.js";

// Maroo testnet supports Cancun opcodes (PUSH0, TSTORE/TLOAD, MCOPY) but NOT
// Osaka (CLZ). Pin the EVM version explicitly: newer solc defaults may target
// a newer EVM and emit opcodes the chain rejects. See docs/CHAIN_NOTES.md.
const EVM_VERSION = "cancun";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    // Local stand-in for the proxy that Maroo's PCL precompile deploys with
    // `deployPclProxy(kind = Transparent, ...)`: its init data is
    // abi.encode(logic, initialOwner, initializer), the same arguments as this
    // proxy's constructor, so tests exercise the real proxy + initializer path.
    npmFilesToBuild: [
      "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol",
    ],
    // Two compilers: 0.8.34 for this project, 0.8.29 for the unmodified EAS
    // 1.4.0 sources in contracts/vendor/eas (they pin `pragma solidity 0.8.29`).
    // Hardhat picks the newest compiler each file's pragma allows.
    profiles: {
      default: {
        compilers: [
          { version: "0.8.34", settings: { evmVersion: EVM_VERSION } },
          { version: "0.8.29", settings: { evmVersion: EVM_VERSION } },
        ],
      },
      production: {
        compilers: [
          { version: "0.8.34", settings: { evmVersion: EVM_VERSION, optimizer: { enabled: true, runs: 200 } } },
          { version: "0.8.29", settings: { evmVersion: EVM_VERSION, optimizer: { enabled: true, runs: 200 } } },
        ],
      },
    },
  },
  networks: {
    // Local simulated chain pinned to the same hardfork as Maroo testnet, so
    // local tests cannot pass with opcodes the real chain would reject.
    default: {
      type: "edr-simulated",
      chainType: "l1",
      hardfork: EVM_VERSION,
    },
    marooTestnet: {
      type: "http",
      chainType: "l1",
      chainId: MAROO_TESTNET.chainId,
      url: MAROO_TESTNET.rpcUrl,
      // Stored encrypted with: npx hardhat keystore set MAROO_PRIVATE_KEY
      accounts: [configVariable("MAROO_PRIVATE_KEY")],
    },
  },
  chainDescriptors: {
    [MAROO_TESTNET.chainId]: {
      name: "Maroo Testnet",
      blockExplorers: {
        blockscout: {
          name: "Maroo Blockscout",
          url: MAROO_TESTNET.explorerUrl,
          apiUrl: MAROO_TESTNET.explorerApiUrl,
        },
      },
    },
  },
});
