// Read-only: checks the connection, account, fees and PCL precompile access.
// Nothing is signed or sent.
import { marooPublicActions } from "@maroo-chain/viem";
import { artifacts, network } from "hardhat";
import { encodeDeployData, formatGwei } from "viem";

import { loadDeployment } from "../lib/deployments.js";
import { assertMarooTestnet, formatOKRW } from "../lib/maroo.js";
import { MAROO_TESTNET } from "../lib/network.js";
import { runScript } from "../lib/run.js";

await runScript(async () => {
  const { viem } = await network.getOrCreate();
  const publicClient = (await viem.getPublicClient()).extend(marooPublicActions());
  const [wallet] = await viem.getWalletClients();

  await assertMarooTestnet(publicClient);
  console.log(`Network   : Maroo testnet (chain ${MAROO_TESTNET.chainId})`);
  console.log(`Block     : ${await publicClient.getBlockNumber()}`);

  const account = wallet.account.address;
  console.log(`Account   : ${account}`);
  console.log(`Balance   : ${formatOKRW(await publicClient.getBalance({ address: account }))}`);

  const block = await publicClient.getBlock();
  const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
  console.log(`Base fee  : ${formatGwei(block.baseFeePerGas ?? 0n)} gwei`);
  console.log(`Max fee   : ${formatGwei(maxFeePerGas)} gwei (priority ${formatGwei(maxPriorityFeePerGas)} gwei)`);
  // Measured, not assumed: on Maroo a plain transfer uses far more than
  // Ethereum's 21,000 gas (~60,000 observed).
  const transferGas = await publicClient.estimateGas({ account, to: account, value: 0n });
  console.log(`Transfer  : ${transferGas} gas, ~${formatOKRW(transferGas * maxFeePerGas)} worst case`);

  // Proves the installed PCL ABI matches the chain (an old ABI reverts here).
  const params = await publicClient.pcl.getParams();
  console.log(`PCL       : reachable, getParams() OK`, params);

  // Simulate deploying the implementation: proves the compiled bytecode is
  // accepted by Maroo (no unsupported opcodes) and estimates its fee.
  const artifact = await artifacts.readArtifact("PaymentRouter");
  const deployGas = await publicClient.estimateGas({
    account,
    data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode as `0x${string}` }),
  });
  console.log(`Deploy sim: implementation OK, ${deployGas} gas, ~${formatOKRW(deployGas * maxFeePerGas)} worst case`);

  const deployment = loadDeployment(MAROO_TESTNET.chainId);
  console.log(deployment ? `Deployment: proxy ${deployment.proxy}` : "Deployment: none yet (run npm run deploy)");
});
