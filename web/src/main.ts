// UI wiring. All page text is set with textContent, never innerHTML.
// Every visible string is re-rendered when the language changes.
import { formatEther, getAddress, isAddress, isAddressEqual, parseEther, type Address, type Hex, type TransactionReceipt } from "viem";

import * as chain from "./chain.js";
import { shortHex, verdictFromError, type Stage, type Vars, type Verdict } from "./core.js";
import { locale, message, pickLang, text, type Lang } from "./i18n.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const okrw = (wei: bigint) => `${formatEther(wei)} tOKRW`;

// ---------------------------------------------------------------- language

let lang: Lang = pickLang(safeGet("lang"), navigator.languages ?? [navigator.language]);

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: the choice just isn't remembered
  }
}

const t = (key: string, vars?: Vars) => text(lang, key, vars);
const dateText = (seconds: bigint) => new Date(Number(seconds) * 1000).toLocaleDateString(locale(lang), { year: "numeric", month: "long", day: "numeric" });

/** Text that depends on the language, keyed by element id. */
const dynamic = new Map<string, () => string>();
function setText(id: string, fn: () => string) {
  dynamic.set(id, fn);
  $(id).textContent = fn();
}

function renderLanguage() {
  document.documentElement.lang = lang;
  document.title = t("docTitle");
  document.querySelector('meta[name="description"]')?.setAttribute("content", t("docDescription"));
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n!)));
  document.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nAria!)));
  document.querySelectorAll<HTMLButtonElement>(".lang-btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
  if (account) $("connect").textContent = shortHex(account, 4);
  for (const [id, fn] of dynamic) $(id).textContent = fn();
  renderVerdict();
  renderLog();
}

function setLang(next: Lang) {
  lang = next;
  safeSet("lang", next);
  renderLanguage();
}

// ---------------------------------------------------------------- verdict plate

type PlateState = "idle" | "busy" | "allowed" | "blocked";
type View = { state: PlateState; code: string; vars?: () => Vars; stage?: Stage; link?: string };

let view: View = { state: "idle", code: "connectStart" };

function setView(next: View) {
  view = next;
  renderVerdict();
}

function show(v: Verdict) {
  const vars = v.vars;
  setView({ state: v.allowed ? "allowed" : "blocked", code: v.code, vars: vars ? () => vars : undefined, stage: v.stage });
}

function renderVerdict() {
  const m = message(lang, view.code, view.vars?.());
  $("verdict").dataset.state = view.state;
  $("verdict-title").textContent = m.title;
  const detail = $("verdict-detail");
  detail.textContent = m.detail;
  if (view.link) {
    const a = document.createElement("a");
    a.href = view.link;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = t("explorer");
    detail.append(" ", a);
  }

  // Which gate stopped it: Maroo's chain rule (PCL) runs before the contract.
  const showTrail = view.stage !== undefined && (view.state === "allowed" || view.state === "blocked");
  $("trail").hidden = !showTrail;
  if (!showTrail) return;
  const chainState = view.state === "allowed" || view.stage === "contract" ? "pass" : "fail";
  const contractState = view.state === "allowed" ? "pass" : view.stage === "contract" ? "fail" : "skip";
  for (const [id, state] of [["gate-chain", chainState], ["gate-contract", contractState]] as const) {
    const gate = $(id);
    gate.dataset.state = state;
    gate.querySelector(".gate-state")!.textContent = t(state === "pass" ? "gatePass" : state === "fail" ? "gateFail" : "gateSkip");
  }
}

// ---------------------------------------------------------------- activity log

type LogEntry = { key: string; vars: Vars; href: string };
const entries: LogEntry[] = [];

function log(key: string, vars: Vars, hash: Hex) {
  entries.unshift({ key, vars: { ...vars, hash: shortHex(hash) }, href: chain.explorerTx(hash) });
  renderLog();
}

function renderLog() {
  const list = $("log");
  list.replaceChildren(
    ...entries.map((e) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = e.href;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = `${t(e.key, e.vars)} (${e.vars.hash})`;
      li.append(a);
      return li;
    }),
  );
}

// ---------------------------------------------------------------- helpers

/** Disable every button while one action runs, so nothing is sent twice. */
async function busy<T>(fn: () => Promise<T>): Promise<T | undefined> {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button:not(.lang-btn)")];
  buttons.forEach((b) => (b.disabled = true));
  try {
    return await fn();
  } catch (error) {
    show(verdictFromError(error));
    return undefined;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    if (!chain.hasWallet()) $<HTMLButtonElement>("connect").disabled = true;
  }
}

function link(el: HTMLAnchorElement, address: Address) {
  el.href = chain.explorerAddress(address);
  el.textContent = address;
}

function readAddress(id: string): Address | null {
  const value = $<HTMLInputElement>(id).value.trim();
  return isAddress(value) ? getAddress(value) : null;
}

const badAddress = () => show({ allowed: false, code: "badAddress" });

// ---------------------------------------------------------------- your status

let account: Address | null = null;

async function refresh() {
  if (!account) return;
  link($("you-address"), account);
  const [balance, kyc] = await Promise.all([chain.readBalance(account), chain.readKyc(account)]);
  setText("you-balance", () => okrw(balance));
  setText("you-kyc", () =>
    kyc.state === "none"
      ? t("kycNone")
      : kyc.state === "active"
        ? t("kycActive", { date: dateText(kyc.expirationTime) })
        : kyc.state === "revoked"
          ? t("kycRevoked")
          : t("kycExpired"),
  );
}

// ---------------------------------------------------------------- connect

async function onConnect() {
  await busy(async () => {
    setView({ state: "busy", code: "connecting" });
    account = await chain.connect();
    $("connect").textContent = shortHex(account, 4);
    $<HTMLInputElement>("pay-to").value ||= account;
    $<HTMLInputElement>("grant-to").value ||= account;
    $("you").hidden = false;
    $("pay").hidden = false;
    $("issuer").hidden = !isAddressEqual(account, chain.addresses.issuer);
    const max = await chain.readMaxPayment();
    setText("pay-limit", () => t("payLimit", { max: okrw(max) }));
    await refresh();
    setView({ state: "idle", code: "ready" });
  });
}

// ---------------------------------------------------------------- lookup (no wallet)

async function onLookup(event: Event) {
  event.preventDefault();
  const address = readAddress("lookup-address");
  if (!address) return badAddress();
  await busy(async () => {
    setView({ state: "busy", code: "lookingUp" });
    const kyc = await chain.readKyc(address);
    const addr = shortHex(address, 4);
    if (kyc.state === "active") {
      return setView({ state: "allowed", code: "lookupActive", vars: () => ({ addr, date: dateText(kyc.expirationTime) }) });
    }
    const code = kyc.state === "none" ? "lookupNone" : kyc.state === "revoked" ? "lookupRevoked" : "lookupExpired";
    setView({ state: "blocked", code, vars: () => ({ addr }) });
  });
}

// ---------------------------------------------------------------- pay

let pendingPay: chain.Prepared | null = null;

async function onCheckPay(event: Event) {
  event.preventDefault();
  $("pay-confirm").hidden = true;
  pendingPay = null;
  const to = readAddress("pay-to");
  if (!to) return badAddress();
  let amount: bigint;
  try {
    amount = parseEther($<HTMLInputElement>("pay-amount").value.trim().replace(",", "."));
  } catch {
    return show({ allowed: false, code: "badAmount" });
  }
  await busy(async () => {
    setView({ state: "busy", code: "checking" });
    const result = await chain.checkPay(to, amount);
    if (!result.ok) return show(result.verdict);
    pendingPay = result.prepared;
    show(result.prepared.verdict);
    const fee = result.prepared.fee;
    setText("pay-fee", () => t("payFee", { amount: okrw(amount), to: shortHex(to, 4), fee: okrw(fee) }));
    setText("pay-send", () => t("paySend", { amount: okrw(amount) }));
    $("pay-confirm").hidden = false;
    $("pay-send").focus();
  });
}

async function onSendPay() {
  const prepared = pendingPay;
  if (!prepared) return;
  $("pay-confirm").hidden = true;
  pendingPay = null;
  await busy(async () => {
    setView({ state: "busy", code: "waitingWallet" });
    const receipt = await chain.send(prepared);
    setView({ state: "allowed", code: "paySent", link: chain.explorerTx(receipt.transactionHash) });
    log("logPaid", { amount: okrw(prepared.request.value) }, receipt.transactionHash);
    await refresh();
  });
}

// ---------------------------------------------------------------- issuer

type IssuerStep = { prepared: chain.Prepared; label: string; after: (receipt: TransactionReceipt) => Promise<void> };
let pendingIssuer: IssuerStep | null = null;

function offerIssuerStep(step: IssuerStep) {
  pendingIssuer = step;
  show(step.prepared.verdict);
  const fee = step.prepared.fee;
  setText("issuer-fee", () => t("issuerFee", { fee: okrw(fee) }));
  setText("issuer-send", () => t(step.label));
  $("issuer-confirm").hidden = false;
  $("issuer-send").focus();
}

async function onCheckGrant(event: Event) {
  event.preventDefault();
  $("issuer-confirm").hidden = true;
  const to = readAddress("grant-to");
  const days = Number($<HTMLInputElement>("grant-days").value);
  if (!to) return badAddress();
  if (!Number.isInteger(days) || days <= 0 || days > 3650) return show({ allowed: false, code: "badDays" });
  const addr = shortHex(to, 4);
  await busy(async () => {
    setView({ state: "busy", code: "checking" });
    const result = await chain.checkGrant(to, days);
    if (!result.ok) return show(result.verdict);
    offerIssuerStep({
      prepared: result.prepared,
      label: "stepGrant",
      after: async (receipt) => {
        log("logAttested", { addr }, receipt.transactionHash);
        const index = await chain.indexFromReceipt(receipt);
        if (!index.ok) return show(index.verdict);
        offerIssuerStep({
          prepared: index.prepared,
          label: "stepIndex",
          after: async (r) => {
            log("logIndexed", { addr }, r.transactionHash);
            setView({ state: "allowed", code: "kycGranted", vars: () => ({ addr }), link: chain.explorerTx(r.transactionHash) });
          },
        });
      },
    });
  });
}

async function onCheckRevoke() {
  $("issuer-confirm").hidden = true;
  const to = readAddress("grant-to");
  if (!to) return badAddress();
  const addr = shortHex(to, 4);
  await busy(async () => {
    setView({ state: "busy", code: "lookingUp" });
    const kyc = await chain.readKyc(to);
    if (kyc.state !== "active") return show({ allowed: false, code: "nothingToRevoke" });
    const result = await chain.checkRevoke(kyc.uid);
    if (!result.ok) return show(result.verdict);
    offerIssuerStep({
      prepared: result.prepared,
      label: "stepRevoke",
      after: async (receipt) => {
        log("logRevoked", { addr }, receipt.transactionHash);
        setView({ state: "blocked", code: "kycRevokedDone", vars: () => ({ addr }), link: chain.explorerTx(receipt.transactionHash) });
      },
    });
  });
}

async function onSendIssuer() {
  const step = pendingIssuer;
  if (!step) return;
  $("issuer-confirm").hidden = true;
  pendingIssuer = null;
  await busy(async () => {
    setView({ state: "busy", code: "waitingWallet" });
    const receipt = await chain.send(step.prepared);
    await step.after(receipt);
    await refresh();
  });
}

function cancel(confirmId: string) {
  $(confirmId).hidden = true;
  pendingPay = null;
  pendingIssuer = null;
  setView({ state: "idle", code: "cancelled" });
}

// ---------------------------------------------------------------- boot

link($("addr-router"), chain.addresses.router);
link($("addr-issuer"), chain.addresses.issuer);

if (!chain.hasWallet()) {
  view = { state: "idle", code: "noWallet" };
  $<HTMLButtonElement>("connect").disabled = true;
}
renderLanguage();

document.querySelectorAll<HTMLButtonElement>(".lang-btn").forEach((b) => b.addEventListener("click", () => setLang(b.dataset.lang as Lang)));
$("connect").addEventListener("click", onConnect);
$("lookup-form").addEventListener("submit", onLookup);
$("pay-form").addEventListener("submit", onCheckPay);
$("pay-send").addEventListener("click", onSendPay);
$("pay-cancel").addEventListener("click", () => cancel("pay-confirm"));
$("grant-form").addEventListener("submit", onCheckGrant);
$("revoke-check").addEventListener("click", onCheckRevoke);
$("issuer-send").addEventListener("click", onSendIssuer);
$("issuer-cancel").addEventListener("click", () => cancel("issuer-confirm"));

chain.onWalletChange(() => location.reload());
