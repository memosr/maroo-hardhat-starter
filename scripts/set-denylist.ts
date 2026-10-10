// Attaches a PCL DENYLIST policy to PaymentRouter.pay on the deployed proxy.
// Calls to pay() from a denied sender are rejected by the chain before the
// contract runs. Passing an empty list removes the restriction.
//
// Env:
//   MAROO_DENY           comma-separated addresses to deny (empty = allow all)
//   MAROO_FEE_CAP_OKRW   max total fees for this run (default 10)
import { marooPublicActions, marooWalletActions, policy, PolicySet } from "@maroo-chain/viem";
import { network } from "hardhat";
import { getAddress, isAddress, parseEther, toFunctionSelector } from "viem";

import { loadDeployment } from "../lib/deployments.js";
import { assertMarooTestnet, FeeBudget } from "../lib/maroo.js";
import { MAROO_TESTNET } from "../lib/network.js";
import { sendGuarded } from "../lib/send.js";
import { runScript } from "../lib/run.js";

await runScript(async () => {
  const deny = (process.env.MAROO_DENY ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const a of deny) if (!isAddress(a)) throw new Error(`Invalid address in MAROO_DENY: ${a}`);

  const { viem } = await network.getOrCreate();
  const publicClient = (await viem.getPublicClient()).extend(marooPublicActions());
  const [base] = await viem.getWalletClients();
  const walletClient = base.extend(marooWalletActions());
  await assertMarooTestnet(publicClient);

  const deployment = loadDeployment(MAROO_TESTNET.chainId);
  if (!deployment) throw new Error("No deployment found. Run npm run deploy first.");

  const selector = toFunctionSelector("pay(address)");
  const ctx = {
    publicClient,
    walletClient: base,
    budget: new FeeBudget(parseEther(process.env.MAROO_FEE_CAP_OKRW ?? "10")),
  };

  if (deny.length) {
    // One root policy per selector; the deployer is the proxy's policy admin.
    await sendGuarded(ctx, {
      label: `denylist ${deny.length} address(es)`,
      ...walletClient.pcl.changeContractPolicies.call({
        contract: deployment.proxy,
        admin: base.account.address,
        policies: [policy.denylist({ addresses: deny.map((a) => getAddress(a)), selector })],
      }),
    });
  } else {
    // Clearing keeps the admin binding; it only removes the rules.
    await sendGuarded(ctx, {
      label: "clear policies",
      ...walletClient.pcl.removeContractPolicies.call({ contract: deployment.proxy }),
    });
  }

  const current = await publicClient.pcl.contractPolicies({ contract: deployment.proxy });
  console.log("Active contract policies:", JSON.stringify(current.policies.map(PolicySet.decode), (_k, v) =>
    typeof v === "bigint" ? v.toString() : v, 2));
});
