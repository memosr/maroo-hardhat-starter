// Issue a KYC attestation (kycPassed = true) and index it so PCL can see it.
//
// Env (optional):
//   MAROO_KYC_ADDRESS    recipient (default: your own address)
//   MAROO_KYC_DAYS       validity in days (default 30)
//   MAROO_FEE_CAP_OKRW   max total fees for this run (default 10)
import { encodeFunctionData, parseEther, zeroHash } from "viem";

import { kycErrorAbi, kycTarget, loadKycEnv } from "../lib/kyc-env.js";
import { attestedUid, encodeKycData } from "../lib/kyc.js";
import { FeeBudget, formatOKRW } from "../lib/maroo.js";
import { runScript } from "../lib/run.js";
import { sendGuarded } from "../lib/send.js";

await runScript(async () => {
  const env = await loadKycEnv();
  const { publicClient, walletClient, deployment, addresses, abis } = env;
  const kyc = deployment.kyc;
  if (!kyc) throw new Error("KYC is not set up. Run npm run kyc:setup first.");

  const recipient = kycTarget(walletClient.account.address);
  const days = BigInt(process.env.MAROO_KYC_DAYS ?? "30");
  if (days <= 0n) throw new Error("MAROO_KYC_DAYS must be greater than zero.");
  const expirationTime = (await publicClient.getBlock()).timestamp + days * 86_400n;

  const budget = new FeeBudget(parseEther(process.env.MAROO_FEE_CAP_OKRW ?? "10"));
  const ctx = { publicClient, walletClient, budget, errorAbi: kycErrorAbi(abis) };

  // 1. Attest. The resolver rejects it unless you are the issuer.
  const receipt = await sendGuarded(ctx, {
    label: "attest",
    to: addresses.eas,
    data: encodeFunctionData({
      abi: abis.eas,
      functionName: "attest",
      args: [
        {
          schema: kyc.schemaUid,
          data: {
            recipient,
            expirationTime,
            revocable: true,
            refUID: zeroHash,
            data: encodeKycData(true),
            value: 0n,
          },
        },
      ],
    }),
  });
  const uid = attestedUid(receipt.logs, abis.eas, addresses.eas);

  // 2. Index. PCL's EAS_POLICY looks attestations up through the Indexer.
  await sendGuarded(ctx, {
    label: "index",
    to: addresses.indexer,
    data: encodeFunctionData({ abi: abis.indexer, functionName: "indexAttestation", args: [uid] }),
  });
  const indexed = await publicClient.readContract({
    address: addresses.indexer,
    abi: abis.indexer,
    functionName: "isAttestationIndexed",
    args: [uid],
  });
  if (!indexed) throw new Error(`Attestation ${uid} is not indexed.`);

  console.log(`KYC granted to ${recipient}`);
  console.log(`UID ${uid}, expires ${new Date(Number(expirationTime) * 1000).toISOString()}`);
  console.log(`Total fees ${formatOKRW(budget.spentWei)}`);
});
