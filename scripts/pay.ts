// Calls PaymentRouter.pay through the PCL proxy. PCL policies attached to
// pay() run first: a denied sender is rejected during simulation, so nothing
// is sent and no fee is paid.
//
// Env (optional):
//   MAROO_PAY_TO         recipient (default: your own address)
//   MAROO_PAY_AMOUNT     tOKRW to forward (default 0.001)
//   MAROO_FEE_CAP_OKRW   max total fees for this run (default 5)
import { artifacts, network } from "hardhat";
import { encodeFunctionData, getAddress, isAddress, parseEther } from "viem";

import { loadDeployment } from "../lib/deployments.js";
import { assertMarooTestnet, FeeBudget, formatOKRW } from "../lib/maroo.js";
import { MAROO_TESTNET } from "../lib/network.js";
import { sendGuarded } from "../lib/send.js";
import { runScript } from "../lib/run.js";

await runScript(async () => {
  const { viem } = await network.getOrCreate();
  const publicClient = await viem.getPublicClient();
  const [walletClient] = await viem.getWalletClients();
  await assertMarooTestnet(publicClient);

  const deployment = loadDeployment(MAROO_TESTNET.chainId);
  if (!deployment) throw new Error("No deployment found. Run npm run deploy first.");

  const to = process.env.MAROO_PAY_TO ?? walletClient.account.address;
  if (!isAddress(to)) throw new Error(`Invalid MAROO_PAY_TO: ${to}`);
  const amount = parseEther(process.env.MAROO_PAY_AMOUNT ?? "0.001");

  const artifact = await artifacts.readArtifact("PaymentRouter");
  const router = await viem.getContractAt("PaymentRouter", deployment.proxy);
  const before = await router.read.paymentCount();

  console.log(`Paying ${formatOKRW(amount)} to ${getAddress(to)} via ${deployment.proxy}`);
  await sendGuarded(
    {
      publicClient,
      walletClient,
      budget: new FeeBudget(parseEther(process.env.MAROO_FEE_CAP_OKRW ?? "5")),
      errorAbi: artifact.abi,
    },
    {
      label: "pay",
      to: deployment.proxy,
      data: encodeFunctionData({ abi: artifact.abi, functionName: "pay", args: [getAddress(to)] }),
      value: amount,
    },
  );
  console.log(`paymentCount ${before} -> ${await router.read.paymentCount()}`);
});
