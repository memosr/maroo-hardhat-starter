// Writes web/src/generated.json for the web app: public deployment addresses
// (from deployments/<chainId>.json) and the minimal ABIs it needs (from the
// compiled artifacts). Offline: nothing is read from or sent to the chain.
import { writeFileSync } from "node:fs";
import path from "node:path";

import { artifacts } from "hardhat";

import { loadDeployment } from "../lib/deployments.js";
import { MAROO_TESTNET } from "../lib/network.js";
import { runScript } from "../lib/run.js";

type AbiItem = { type: string; name?: string };

/** Keep only the listed functions/events plus every custom error. */
function pick(abi: readonly unknown[], names: string[]): AbiItem[] {
  return (abi as AbiItem[]).filter((x) => x.type === "error" || (x.name !== undefined && names.includes(x.name)));
}

await runScript(async () => {
  const deployment = loadDeployment(MAROO_TESTNET.chainId);
  if (!deployment?.kyc) throw new Error("Run npm run deploy and npm run kyc:setup first.");

  const [router, eas, indexer, resolver] = await Promise.all(
    ["PaymentRouter", "EAS", "Indexer", "KycResolver"].map((n) => artifacts.readArtifact(n)),
  );

  const out = {
    chainId: deployment.chainId,
    proxy: deployment.proxy,
    implementation: deployment.implementation,
    kyc: deployment.kyc,
    abi: {
      router: pick(router.abi, ["pay", "paymentCount", "maxPayment", "Paid"]),
      eas: pick(eas.abi, ["attest", "revoke", "getAttestation", "Attested"]),
      indexer: pick(indexer.abi, ["indexAttestation", "isAttestationIndexed", "getReceivedAttestationUIDs"]),
      resolver: pick(resolver.abi, []),
    },
  };
  const file = path.resolve("web/src/generated.json");
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${file}`);
});
