// Verify the deployed contracts' source code on Maroo's Blockscout explorer:
//   - PaymentRouter implementation (the PCL proxy itself is created by the
//     PCL precompile and has no source to verify)
//   - KycResolver, when `npm run kyc:setup` has been run
//
// Must run with the SAME build profile the contracts were deployed with.
// `hardhat run` deploys with the "default" profile, while `hardhat verify`
// falls back to "production" (optimizer on) when none is given, which would
// never match. The npm script passes --build-profile default.
import hre, { network } from "hardhat";

import { loadDeployment } from "../lib/deployments.js";
import { assertMarooTestnet } from "../lib/maroo.js";
import { MAROO_TESTNET } from "../lib/network.js";
import { runScript } from "../lib/run.js";

await runScript(async () => {
  if (hre.globalOptions.buildProfile !== "default") {
    throw new Error('Run with "--build-profile default" (use: npm run verify) so the bytecode matches the deployment.');
  }
  const { viem } = await network.getOrCreate();
  await assertMarooTestnet(await viem.getPublicClient());

  const deployment = loadDeployment(MAROO_TESTNET.chainId);
  if (!deployment) throw new Error("No deployment found. Run npm run deploy first.");

  const targets: { label: string; address: string; contract: string; constructorArgs: string[] }[] = [
    {
      label: "PaymentRouter (implementation)",
      address: deployment.implementation,
      contract: "contracts/PaymentRouter.sol:PaymentRouter",
      constructorArgs: [],
    },
  ];
  if (deployment.kyc) {
    targets.push({
      label: "KycResolver",
      address: deployment.kyc.resolver,
      contract: "contracts/KycResolver.sol:KycResolver",
      constructorArgs: [deployment.kyc.eas, deployment.kyc.issuer],
    });
  }

  for (const t of targets) {
    console.log(`\n${t.label} ${t.address}`);
    await hre.tasks.getTask(["verify", "blockscout"]).run({
      address: t.address,
      contract: t.contract,
      constructorArgs: t.constructorArgs,
    });
  }
});
