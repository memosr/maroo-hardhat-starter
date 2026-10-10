import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Address, Hex } from "viem";

export type Deployment = {
  chainId: number;
  deployer: Address;
  implementation: Address;
  proxy: Address;
  maxPaymentWei: string;
  transactions: Record<string, Hex>;
  deployedAt: string;
};

const DIR = path.resolve("deployments");

function fileFor(chainId: number): string {
  return path.join(DIR, `${chainId}.json`);
}

export function loadDeployment(chainId: number): Deployment | undefined {
  const file = fileFor(chainId);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Deployment) : undefined;
}

export function saveDeployment(deployment: Deployment): string {
  mkdirSync(DIR, { recursive: true });
  const file = fileFor(deployment.chainId);
  writeFileSync(file, JSON.stringify(deployment, null, 2) + "\n");
  return file;
}
