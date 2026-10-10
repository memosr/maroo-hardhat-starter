// Deploys PaymentRouter behind a Maroo PCL proxy:
//   1. implementation contract (initializers disabled)
//   2. PCL precompile deployPclProxy(Transparent, initialize(owner, maxPayment))
//   3. verifies the proxy is PCL-registered and initialized
// Every transaction is simulated first and checked against a fee cap.
//
// Env (optional):
//   MAROO_FEE_CAP_OKRW   max total fees for this run   (default 30)
//   MAROO_MAX_PAYMENT    PaymentRouter.maxPayment       (default 1)
//   MAROO_REDEPLOY=1     allow replacing an existing deployment record
import { deployPclProxy, isPclProxy, pclProxyKinds } from "@maroo-chain/viem";
import { artifacts, network } from "hardhat";
import { encodeDeployData, encodeFunctionData, getAddress, parseEther } from "viem";

import { loadDeployment, saveDeployment } from "../lib/deployments.js";
import { assertMarooTestnet, FeeBudget, formatOKRW } from "../lib/maroo.js";
import { MAROO_TESTNET } from "../lib/network.js";
import { sendGuarded } from "../lib/send.js";
import { runScript } from "../lib/run.js";

await runScript(async () => {
  const feeCap = parseEther(process.env.MAROO_FEE_CAP_OKRW ?? "30");
  const maxPayment = parseEther(process.env.MAROO_MAX_PAYMENT ?? "1");

  const { viem } = await network.getOrCreate();
  const publicClient = await viem.getPublicClient();
  const [walletClient] = await viem.getWalletClients();
  await assertMarooTestnet(publicClient);

  const existing = loadDeployment(MAROO_TESTNET.chainId);
  if (existing && process.env.MAROO_REDEPLOY !== "1") {
    throw new Error(
      `A deployment already exists (proxy ${existing.proxy}). Set MAROO_REDEPLOY=1 to deploy a new one.`,
    );
  }

  const owner = walletClient.account.address;
  const budget = new FeeBudget(feeCap);
  const artifact = await artifacts.readArtifact("PaymentRouter");
  const ctx = { publicClient, walletClient, budget, errorAbi: artifact.abi };
  console.log(`Deployer ${owner}, fee cap ${formatOKRW(feeCap)}`);

  // 1. Implementation
  const implReceipt = await sendGuarded(ctx, {
    label: "implementation",
    data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode as `0x${string}` }),
  });
  const implementation = implReceipt.contractAddress;
  if (!implementation) throw new Error("Implementation receipt has no contract address.");

  // 2. PCL proxy. The deployer becomes the proxy's contract-policy admin atomically.
  const initializer = encodeFunctionData({
    abi: artifact.abi,
    functionName: "initialize",
    args: [owner, maxPayment],
  });
  const proxyReceipt = await sendGuarded(ctx, {
    label: "pcl proxy",
    ...deployPclProxy.call({
      kind: pclProxyKinds.Transparent,
      logic: implementation,
      initialOwner: owner,
      initializer,
    }),
  });
  // extractEvent only trusts logs emitted by the PCL precompile itself.
  const proxy = getAddress(deployPclProxy.extractEvent(proxyReceipt.logs).args.proxy);

  // 3. Verify on chain
  const router = await viem.getContractAt("PaymentRouter", proxy);
  const checks = {
    pclRegistered: await isPclProxy(publicClient, { proxy }),
    ownerMatches: getAddress(await router.read.owner()) === getAddress(owner),
    maxPaymentMatches: (await router.read.maxPayment()) === maxPayment,
  };
  console.log("Checks", checks);
  if (!Object.values(checks).every(Boolean)) throw new Error("Post-deploy verification failed.");

  const file = saveDeployment({
    chainId: MAROO_TESTNET.chainId,
    deployer: owner,
    implementation,
    proxy,
    maxPaymentWei: maxPayment.toString(),
    transactions: { implementation: implReceipt.transactionHash, proxy: proxyReceipt.transactionHash },
    deployedAt: new Date().toISOString(),
  });
  console.log(`Proxy ${proxy}`);
  console.log(`Explorer ${MAROO_TESTNET.explorerUrl}/address/${proxy}`);
  console.log(`Saved ${file}. Total fees ${formatOKRW(budget.spentWei)}`);
});
