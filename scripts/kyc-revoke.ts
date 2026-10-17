// Revoke every active KYC attestation of an address. UIDs are read from the
// chain's Indexer, not from a local file, so nothing can get out of sync.
//
// Env (optional):
//   MAROO_KYC_ADDRESS    whose KYC to revoke (default: your own address)
//   MAROO_FEE_CAP_OKRW   max total fees for this run (default 10)
import { encodeFunctionData, parseEther, type Hex } from "viem";

import { kycErrorAbi, kycTarget, loadKycEnv } from "../lib/kyc-env.js";
import { FeeBudget, formatOKRW } from "../lib/maroo.js";
import { runScript } from "../lib/run.js";
import { sendGuarded } from "../lib/send.js";

await runScript(async () => {
  const env = await loadKycEnv();
  const { publicClient, walletClient, deployment, addresses, abis } = env;
  const kyc = deployment.kyc;
  if (!kyc) throw new Error("KYC is not set up. Run npm run kyc:setup first.");

  const recipient = kycTarget(walletClient.account.address);
  const uids = await publicClient.readContract({
    address: addresses.indexer,
    abi: abis.indexer,
    functionName: "getReceivedAttestationUIDs",
    args: [recipient, kyc.schemaUid, 0n, 100n, false],
  });

  const active: Hex[] = [];
  for (const uid of uids) {
    const a = await publicClient.readContract({ address: addresses.eas, abi: abis.eas, functionName: "getAttestation", args: [uid] });
    if (a.revocationTime === 0n) active.push(uid);
  }
  if (active.length === 0) throw new Error(`No active KYC attestation found for ${recipient}.`);

  const budget = new FeeBudget(parseEther(process.env.MAROO_FEE_CAP_OKRW ?? "10"));
  const ctx = { publicClient, walletClient, budget, errorAbi: kycErrorAbi(abis) };
  for (const uid of active) {
    await sendGuarded(ctx, {
      label: `revoke ${uid.slice(0, 10)}…`,
      to: addresses.eas,
      data: encodeFunctionData({
        abi: abis.eas,
        functionName: "revoke",
        args: [{ schema: kyc.schemaUid, data: { uid, value: 0n } }],
      }),
    });
  }
  console.log(`Revoked ${active.length} attestation(s) of ${recipient}. Total fees ${formatOKRW(budget.spentWei)}`);
});
