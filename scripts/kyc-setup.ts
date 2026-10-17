// KYC gate for PaymentRouter.pay, in three transactions:
//   1. deploy KycResolver (only you can issue KYC; kycPassed must be true)
//   2. register the EAS schema "bool kycPassed" with that resolver
//   3. attach a PCL EAS_POLICY to pay(): senders need a valid KYC attestation
// Each step is simulated first and checked against a fee cap.
//
// Env (optional):
//   MAROO_FEE_CAP_OKRW   max total fees for this run (default 20)
//   MAROO_KYC_RESETUP=1  replace an existing KYC setup
import { marooWalletActions, policy } from "@maroo-chain/viem";
import { encodeDeployData, encodeFunctionData, getAddress, parseEther, toFunctionSelector } from "viem";

import { saveDeployment } from "../lib/deployments.js";
import { kycErrorAbi, loadKycEnv } from "../lib/kyc-env.js";
import { KYC_SCHEMA, kycSchemaUid } from "../lib/kyc.js";
import { FeeBudget, formatOKRW } from "../lib/maroo.js";
import { MAROO_TESTNET } from "../lib/network.js";
import { runScript } from "../lib/run.js";
import { sendGuarded } from "../lib/send.js";

await runScript(async () => {
  const env = await loadKycEnv();
  const { publicClient, walletClient, deployment, addresses, abis } = env;
  if (deployment.kyc && process.env.MAROO_KYC_RESETUP !== "1") {
    throw new Error(`KYC is already set up (resolver ${deployment.kyc.resolver}). Set MAROO_KYC_RESETUP=1 to replace it.`);
  }

  const issuer = walletClient.account.address;
  const budget = new FeeBudget(parseEther(process.env.MAROO_FEE_CAP_OKRW ?? "20"));
  const ctx = { publicClient, walletClient, budget, errorAbi: kycErrorAbi(abis) };
  console.log(`Issuer ${issuer}, EAS ${addresses.eas}, fee cap ${formatOKRW(budget.capWei)}`);

  // 1. Resolver
  const resolverReceipt = await sendGuarded(ctx, {
    label: "kyc resolver",
    data: encodeDeployData({
      abi: abis.resolver,
      bytecode: env.resolverArtifact.bytecode as `0x${string}`,
      args: [addresses.eas, issuer],
    }),
  });
  const resolver = resolverReceipt.contractAddress;
  if (!resolver) throw new Error("Resolver receipt has no contract address.");

  // 2. Schema. The UID commits to the resolver, so it is computed up front
  //    and then checked against what the registry stored.
  const schemaUid = kycSchemaUid(resolver);
  await sendGuarded(ctx, {
    label: "register schema",
    to: addresses.schemaRegistry,
    data: encodeFunctionData({ abi: abis.registry, functionName: "register", args: [KYC_SCHEMA, resolver, true] }),
  });
  const record = await publicClient.readContract({
    address: addresses.schemaRegistry,
    abi: abis.registry,
    functionName: "getSchema",
    args: [schemaUid],
  });
  const schemaOk =
    record.uid === schemaUid &&
    getAddress(record.resolver) === getAddress(resolver) &&
    record.revocable &&
    record.schema === KYC_SCHEMA;
  if (!schemaOk) throw new Error(`Schema verification failed: ${JSON.stringify(record)}`);

  // 3. PCL policy on pay(). Replaces any other policy on that selector.
  const wallet = walletClient.extend(marooWalletActions());
  await sendGuarded(ctx, {
    label: "attach EAS policy",
    ...wallet.pcl.changeContractPolicies.call({
      contract: deployment.proxy,
      admin: issuer,
      policies: [
        policy.eas({
          easContract: addresses.eas,
          indexContract: addresses.indexer,
          schemaUid,
          selector: toFunctionSelector("pay(address)"),
        }),
      ],
    }),
  });

  const file = saveDeployment({
    ...deployment,
    kyc: { resolver, schemaUid, issuer, ...addresses },
  });
  console.log(`Resolver ${resolver}`);
  console.log(`Schema   ${schemaUid}`);
  console.log(`Explorer ${MAROO_TESTNET.explorerUrl}/address/${resolver}`);
  console.log(`Saved ${file}. Total fees ${formatOKRW(budget.spentWei)}`);
  console.log("Next: npm run kyc:check (pay should now be blocked until you run npm run kyc:grant)");
});
