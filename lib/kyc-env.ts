import { marooPublicActions } from "@maroo-chain/viem";
import { artifacts, network } from "hardhat";
import { getAddress, isAddress, type Address } from "viem";

import { loadDeployment } from "./deployments.js";
import { assertMarooTestnet } from "./maroo.js";
import { MAROO_TESTNET } from "./network.js";

/** Shared setup for the kyc:* scripts. */
export async function loadKycEnv() {
  const { viem } = await network.getOrCreate();
  const publicClient = await viem.getPublicClient();
  const [walletClient] = await viem.getWalletClients();
  await assertMarooTestnet(publicClient);

  const deployment = loadDeployment(MAROO_TESTNET.chainId);
  if (!deployment) throw new Error("No deployment found. Run npm run deploy first.");

  // EAS addresses come from the chain (EAS precompile), not from constants.
  const params = await publicClient.extend(marooPublicActions()).eas.getParams();
  const eas = getAddress(params.eas);
  const indexer = getAddress(params.indexer);
  const schemaRegistry = getAddress(params.schemaRegistry);

  // ABIs compiled from the vendored, unmodified EAS 1.4.0 sources.
  const [easArtifact, indexerArtifact, registryArtifact, resolverArtifact, routerArtifact] = await Promise.all([
    artifacts.readArtifact("EAS"),
    artifacts.readArtifact("Indexer"),
    artifacts.readArtifact("SchemaRegistry"),
    artifacts.readArtifact("KycResolver"),
    artifacts.readArtifact("PaymentRouter"),
  ]);

  return {
    viem,
    publicClient,
    walletClient,
    deployment,
    addresses: { eas, indexer, schemaRegistry },
    abis: {
      eas: easArtifact.abi,
      indexer: indexerArtifact.abi,
      registry: registryArtifact.abi,
      resolver: resolverArtifact.abi,
      router: routerArtifact.abi,
    },
    resolverArtifact,
  };
}

/** Errors readable in simulations: EAS, resolver and PaymentRouter custom errors. */
export function kycErrorAbi(abis: Awaited<ReturnType<typeof loadKycEnv>>["abis"]): readonly unknown[] {
  return [...abis.eas, ...abis.resolver, ...abis.router].filter((x) => (x as { type?: string }).type === "error");
}

/** Recipient from MAROO_KYC_ADDRESS, defaulting to the signer. */
export function kycTarget(fallback: Address): Address {
  const value = process.env.MAROO_KYC_ADDRESS ?? fallback;
  if (!isAddress(value)) throw new Error(`Invalid MAROO_KYC_ADDRESS: ${value}`);
  return getAddress(value);
}
