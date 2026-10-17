// Read-only. Shows the KYC state of an address and proves, by simulation and
// at no cost, that (1) PCL lets it pay or explains why not, and (2) a stranger
// cannot issue themselves a KYC attestation under this schema.
//
// Env (optional):
//   MAROO_KYC_ADDRESS    address to inspect (default: your own address)
import { marooPublicActions, PolicySet } from "@maroo-chain/viem";
import { encodeFunctionData, parseEther, zeroHash, type Address, type Hex } from "viem";

import { kycErrorAbi, kycTarget, loadKycEnv } from "../lib/kyc-env.js";
import { encodeKycData } from "../lib/kyc.js";
import { describeRevert, extractRevertData } from "../lib/maroo.js";
import { runScript } from "../lib/run.js";

/** A well-known address nobody controls, used as the "stranger". */
const STRANGER: Address = "0x000000000000000000000000000000000000dEaD";

await runScript(async () => {
  const env = await loadKycEnv();
  const { publicClient, walletClient, deployment, addresses, abis } = env;
  const kyc = deployment.kyc;
  if (!kyc) throw new Error("KYC is not set up. Run npm run kyc:setup first.");
  const errorAbi = kycErrorAbi(abis);
  const target = kycTarget(walletClient.account.address);

  /** Simulate a call; return "OK" or a readable revert reason. */
  async function simulate(account: Address, to: Address, data: Hex, value = 0n): Promise<string> {
    try {
      await publicClient.estimateGas({ account, to, data, value });
      return "OK";
    } catch (error) {
      const raw = extractRevertData(error);
      const reason = raw ? describeRevert(raw, errorAbi) : null;
      if (!reason) return `REVERT (${(error as Error).message.split("\n")[0]})`;
      const violation = reason.violation ? ` [PCL violation: ${reason.violation.kind}]` : "";
      return `REVERT ${reason.errorName}(${reason.args.map(String).join(", ")})${violation}`;
    }
  }

  console.log(`Proxy    ${deployment.proxy}`);
  console.log(`Resolver ${kyc.resolver} (issuer ${kyc.issuer})`);
  console.log(`Schema   ${kyc.schemaUid}`);

  const pcl = publicClient.extend(marooPublicActions()).pcl;
  const { policies } = await pcl.contractPolicies({ contract: deployment.proxy });
  console.log(`Policies ${policies.map((p) => PolicySet.decode(p).templateId).join(", ") || "none"}`);

  // Attestations of the target, straight from the Indexer.
  const uids = await publicClient.readContract({
    address: addresses.indexer,
    abi: abis.indexer,
    functionName: "getReceivedAttestationUIDs",
    args: [target, kyc.schemaUid, 0n, 100n, false],
  });
  const now = (await publicClient.getBlock()).timestamp;
  console.log(`\nKYC attestations of ${target}: ${uids.length}`);
  for (const uid of uids) {
    const a = await publicClient.readContract({ address: addresses.eas, abi: abis.eas, functionName: "getAttestation", args: [uid] });
    const state = a.revocationTime > 0n ? "REVOKED" : a.expirationTime !== 0n && a.expirationTime <= now ? "EXPIRED" : "ACTIVE";
    console.log(`  ${uid}  ${state}  expires ${new Date(Number(a.expirationTime) * 1000).toISOString()}`);
  }

  // 1. Can the target pay through the PCL proxy right now?
  const payData = encodeFunctionData({ abi: abis.router, functionName: "pay", args: [target] });
  console.log(`\npay() by ${target}: ${await simulate(target, deployment.proxy, payData, parseEther("0.001"))}`);

  // 2. Can a stranger self-issue KYC under this schema? Must be rejected.
  const selfKyc = encodeFunctionData({
    abi: abis.eas,
    functionName: "attest",
    args: [
      {
        schema: kyc.schemaUid,
        data: { recipient: STRANGER, expirationTime: now + 86_400n, revocable: true, refUID: zeroHash, data: encodeKycData(true), value: 0n },
      },
    ],
  });
  const strangerResult = await simulate(STRANGER, addresses.eas, selfKyc);
  console.log(`Self-KYC by a stranger: ${strangerResult}`);
  console.log(strangerResult.includes("InvalidAttestation") ? "  ✔ resolver blocks self-issued KYC" : "  ✖ UNEXPECTED: self-issued KYC was not rejected");
});
