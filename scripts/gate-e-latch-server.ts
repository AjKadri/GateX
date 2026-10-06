import { createServer } from "node:http";
import { runGateE0Preflight, type GateE0Result } from "../src/protocol/gate-e.js";
import { loadProtocolLock } from "../src/protocol/lock.js";
import { providerClients } from "../src/protocol/rpc.js";

const lock = loadProtocolLock();
const json = (value: unknown): string => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);

function planFrom(result: GateE0Result): Record<string, unknown> {
  const latch = result.mintSimulations.latch;
  if (latch === undefined) throw new Error("LATCH deficit is no longer positive; no LATCH mint may be exposed");
  const gas = latch.estimates.reduce((max, quote) => quote.gas !== undefined && quote.gas > max ? quote.gas : max, 0n);
  const gasPrice = result.providers.reduce((max, provider) => provider.gasPriceWei > max ? provider.gasPriceWei : max, 0n);
  const valueWei = BigInt(latch.transaction.request.value ?? "0x0");
  return {
    status: result.status,
    label: "E_LATCH_MINT_PREFLIGHT",
    commonBlock: result.commonBlock,
    rpcProviders: lock.snapshot.providers,
    sender: result.canonical.creator,
    token: result.canonical.token,
    tokenId: "1",
    amount: result.deficits.latch.toString(),
    transaction: latch.transaction.request,
    calldataSha256: latch.transaction.calldataSha256,
    expectedNonce: result.providers[0]?.nonce.toString(),
    expectedBalanceWei: result.providers[0]?.balanceWei.toString(),
    gasEstimate: gas.toString(),
    gasPriceWei: gasPrice.toString(),
    estimatedGasCostWei: (gas * gasPrice).toString(),
    valueWei: valueWei.toString(),
    estimatedTotalCostWei: (gas * gasPrice + valueWei).toString(),
    inventoryCalls: {
      expectedNandBalance: result.providers[0]?.inventory.nandBalance.toString(),
      expectedLatchBalance: (result.providers[0]?.inventory.latchBalance as bigint + result.deficits.latch).toString(),
      expectedMinted: (result.providers[0]?.inventory.minted as bigint + result.deficits.latch).toString()
    },
    artifact: result.artifact
  };
}

let currentPlan: Record<string, unknown> | undefined;

async function refreshPlan(): Promise<Record<string, unknown>> {
  const result = await runGateE0Preflight(lock, providerClients(lock));
  currentPlan = planFrom(result);
  return currentPlan;
}

const page = `<!doctype html>
<meta charset="utf-8">
<title>GateX Gate E LATCH authorization</title>
<style>
  body { margin: 40px; max-width: 760px; font: 16px system-ui, sans-serif; color: #111; }
  h1 { font-size: 24px; }
  pre { padding: 16px; background: #f3f3f3; overflow-wrap: anywhere; }
  button { padding: 12px 18px; font-size: 16px; cursor: pointer; }
  button[hidden] { display: none; }
  .ok { color: #075e2b; }
  .error { color: #a00; white-space: pre-wrap; }
</style>
<h1>Gate E: LATCH inventory authorization</h1>
<p id="status">Discovering the verified OKX provider.</p>
<pre id="plan">Loading the current read-only preflight...</pre>
<button id="connect" hidden>Connect OKX Wallet</button>
<button id="authorize" hidden>Authorize one LATCH mint in OKX Wallet</button>
<pre id="result"></pre>
<script>
(() => {
  const expectedAccount = "0x9fa5db29dfc46e9bfdde271e44364d4ba64244c4";
  const expectedChain = "0xc4";
  const status = document.querySelector("#status");
  const planElement = document.querySelector("#plan");
  const resultElement = document.querySelector("#result");
  const connectButton = document.querySelector("#connect");
  const authorizeButton = document.querySelector("#authorize");
  let selected;
  let plan;
  let ready = false;
  let refreshInFlight = false;
  const lower = value => String(value).toLowerCase();
  const setStatus = (value, kind = "") => { status.textContent = value; status.className = kind; };
  const fail = value => { ready = false; authorizeButton.hidden = true; setStatus(String(value), "error"); };
  const rpc = async (url, method, params) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = await response.json();
    if (body.error) throw new Error(url + " " + method + " " + JSON.stringify(body.error));
    return body.result;
  };
  const discover = () => new Promise(resolve => {
    const providers = [];
    const handler = event => { if (event.detail && event.detail.providerInfo) providers.push(event.detail); };
    window.addEventListener("eip6963:announceProvider", handler);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", handler);
      const announced = providers.find(item => item.providerInfo.rdns === "com.okex.wallet" && (item.provider.isOkxWallet === true || item.providerInfo.name.toLowerCase().includes("okx")));
      if (announced) { announced.provider.__gatexProviderSource = "eip6963"; resolve(announced.provider); return; }
      if (window.okxwallet && window.okxwallet.isOkxWallet === true) { window.okxwallet.__gatexProviderSource = "legacy-explicit"; resolve(window.okxwallet); return; }
      resolve(undefined);
    }, 1500);
  });
  const account = async () => (await selected.request({ method: "eth_accounts" }))[0] || "";
  const verify = async () => {
    if (!selected) throw new Error("Verified OKX provider was not discovered");
    const chain = lower(await selected.request({ method: "eth_chainId" }));
    if (chain !== expectedChain) throw new Error("OKX provider chain is " + chain + ", expected 0xc4");
    const active = await account();
    if (lower(active) !== expectedAccount) throw new Error("OKX provider account is " + (active || "empty") + ", expected " + expectedAccount);
    const remoteChains = await Promise.all(plan.rpcProviders.map(url => rpc(url, "eth_chainId", [])));
    if (remoteChains.some(chainId => Number(BigInt(chainId)) !== 196)) throw new Error("Locked RPC chain identity changed");
  };
  const renderPlan = () => {
    planElement.textContent = JSON.stringify({
      purpose: "Acquire AgentApproval LATCH inventory",
      network: "X Layer / 196",
      sender: plan.sender,
      target: plan.transaction.to,
      method: "mint(uint256,uint256)",
      tokenId: plan.tokenId,
      amount: plan.amount,
      valueWei: plan.valueWei,
      valueOKB: (Number(plan.valueWei) / 1e18).toFixed(18),
      estimatedGas: plan.gasEstimate,
      gasPriceWei: plan.gasPriceWei,
      estimatedGasCostWei: plan.estimatedGasCostWei,
      estimatedTotalCostWei: plan.estimatedTotalCostWei,
      calldataSha256: plan.calldataSha256,
      commonBlock: plan.commonBlock
    }, null, 2);
  };
  const refresh = async () => {
    const response = await fetch("/plan?refresh=1");
    if (!response.ok) throw new Error("Fresh Gate E preflight failed with HTTP " + response.status);
    plan = await response.json();
    renderPlan();
    await verify();
    const nonce = await Promise.all(plan.rpcProviders.map(url => rpc(url, "eth_getTransactionCount", [plan.sender, plan.commonBlock.tag])));
    if (nonce.some(value => BigInt(value) !== BigInt(plan.expectedNonce))) throw new Error("Sender nonce changed since the displayed preflight");
    const balances = await Promise.all(plan.rpcProviders.map(url => rpc(url, "eth_getBalance", [plan.sender, plan.commonBlock.tag])));
    if (balances.some(value => BigInt(value) !== BigInt(plan.expectedBalanceWei))) throw new Error("Sender balance changed since the displayed preflight");
    const simulations = await Promise.all(plan.rpcProviders.map(url => rpc(url, "eth_call", [{ from: plan.transaction.from, to: plan.transaction.to, data: plan.transaction.data, value: plan.transaction.value }, plan.commonBlock.tag])));
    if (simulations.some(value => value !== "0x")) throw new Error("LATCH mint simulation returned an unexpected result");
    const estimates = await Promise.all(plan.rpcProviders.map(url => rpc(url, "eth_estimateGas", [{ from: plan.transaction.from, to: plan.transaction.to, data: plan.transaction.data, value: plan.transaction.value }, plan.commonBlock.tag])));
    if (estimates.some(value => BigInt(value) !== BigInt(plan.gasEstimate))) throw new Error("LATCH gas estimate changed since the displayed preflight");
  };
  const prepare = async () => {
    if (refreshInFlight) return;
    refreshInFlight = true; authorizeButton.disabled = true; setStatus("Refreshing the dual-provider Gate E proof before authorization...");
    try { await refresh(); ready = true; authorizeButton.disabled = false; setStatus("Ready with " + (selected.__gatexProviderSource === "eip6963" ? "EIP-6963" : "explicit legacy") + " OKX provider. Review the exact plan above, then click the single authorization button.", "ok"); authorizeButton.hidden = false; }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    finally { refreshInFlight = false; }
  };
  connectButton.addEventListener("click", async () => { try { await selected.request({ method: "eth_requestAccounts" }); await prepare(); } catch (error) { fail(error instanceof Error ? error.message : String(error)); } });
  authorizeButton.addEventListener("click", async () => {
    if (!ready) return;
    authorizeButton.disabled = true;
    try { const hash = await selected.request({ method: "eth_sendTransaction", params: [{ from: plan.transaction.from, to: plan.transaction.to, data: plan.transaction.data, value: plan.transaction.value }] }); resultElement.textContent = "Transaction submitted. Hash: " + hash; setStatus("Submitted once. Do not retry. Receipt verification is now required.", "ok"); }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  });
  (async () => {
    selected = await discover();
    if (!selected) { fail("Verified OKX provider com.okex.wallet was not found. The generic window.ethereum provider is not accepted."); return; }
    if (typeof selected.on === "function") { selected.on("accountsChanged", () => fail("Provider account changed. Readiness invalidated.")); selected.on("chainChanged", () => fail("Provider chain changed. Readiness invalidated.")); }
    try {
      const chain = lower(await selected.request({ method: "eth_chainId" }));
      if (chain !== expectedChain) throw new Error("OKX provider chain is " + chain + ", expected 0xc4");
      const active = await account();
      if (!active) { setStatus("OKX is on X Layer. Click Connect OKX Wallet to expose the authorized account."); connectButton.hidden = false; return; }
      if (lower(active) !== expectedAccount) throw new Error("Connected account is not the authorized GateX sender");
      await prepare();
    } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  })();
})();
</script>`;

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(page); return; }
    if (request.url?.startsWith("/plan")) { const result = await refreshPlan(); response.writeHead(200, { "content-type": "application/json" }); response.end(json(result)); return; }
    response.writeHead(404); response.end("Not found");
  } catch (error) { response.writeHead(500, { "content-type": "text/plain" }); response.end(error instanceof Error ? error.message : String(error)); }
});

server.listen(4173, "127.0.0.1", () => console.log("Gate E LATCH authorization: http://127.0.0.1:4173/"));
