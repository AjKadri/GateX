import "./style.css";
import { compileMachine } from "./compiler/compiler.js";
import { diagnosticFromError, route, routeQuery, type Diagnostic } from "./app/ui-state.js";
import { AGENT_APPROVAL_SOURCE } from "./examples/agentApproval.js";
import { browserClients, browserDeployment, browserLock, readBoundCircuit, readLiveStep, readOnlyQuote, weiToOkb, type LiveStepResult, type ReadOnlyQuote } from "./app/protocol.js";
import { EXAMPLES, compileExample, inputBytes, localStep, stateName, type CompiledExample, type ExampleKey } from "./app/model.js";
import { readSessions, sessionKey, upsertSession, type BrowserSession } from "./app/session.js";
import { assessGasInclusiveSufficiency, liveVerificationStatus, verifyArtifactBinding, type ArtifactBindingResult, type CircuitBindingReadback, type VerificationStatus } from "./app/binding.js";
import { abbreviatedAccount, bindProviderEvents, discoverOkxProvider, installEip6963Discovery, readWallet, requestOkxAccounts, type WalletState } from "./app/wallet.js";
import type { CompiledMachine } from "./compiler/types.js";
import { TapeoutExecutor, safetyLimitViolation, switchToXLayer, type PendingRecord, type PlanResult, type TapeoutPlan, type VerificationResult, type VerificationTarget } from "./app/tapeout.js";
import { browserTapeoutDeps } from "./app/tapeout-deps.js";
import { readMyCircuits, rememberMyCircuit } from "./app/my-circuits.js";
import { TEMPLATES } from "./examples/templates.js";
import { checkAgainstCircuit, checkHeadline, distinctOwners, matchKnownRule, readCircuit, readCircuitCount, readCircuitsPage, type CircuitRecord, type CircuitsDeps, type KnownRule } from "./app/circuits.js";
import { MAX_SHARED_SOURCE_CHARS, decodeSource, parseCircuitParam, verificationLink } from "./app/share.js";
import { extractTapeOutPayload } from "./protocol/wire.js";
import { costOfSize, pricingSentences } from "./app/pricing.js";
import { describeMismatch, runExhaustiveCheck, tapeoutGate, type ExhaustiveUi } from "./app/exhaustive.js";
import deploymentDocument from "../deployments/xlayer-mainnet.json" with { type: "json" };

// One switch for the whole tape-out feature. When false the app looks and behaves exactly as the read-only version.
const TAPEOUT_ENABLED = true;

const app = typeof document === "undefined" ? undefined : document.querySelector<HTMLElement>("#app");

interface UiState {
  key: ExampleKey; source: string; compiled?: CompiledExample; diagnostics: Diagnostic[]; compiling: boolean;
  selectedState: number; inputs: Record<string, boolean>; live?: LiveStepResult; liveError?: string; liveStatus: VerificationStatus; liveLoading: boolean; readback?: CircuitBindingReadback; readbackError?: string; readbackLoading: boolean; binding?: ArtifactBindingResult;
  quote?: ReadOnlyQuote; quoteError?: string; quoteLoading: boolean; restored?: BrowserSession; exhaustive?: ExhaustiveUi; templateKey?: string; sharedSource?: boolean; shareNotice?: string; appliedQuery?: string; circuitCheck?: CircuitCheckUi;
  wallet: WalletState;
}

// Manufacture transactions and dimensions come from deployments/xlayer-mainnet.json (the same file src/protocol/deployment.ts loads).
// That file has no block number for circuit 2 or the provider-read block, so those two values are constants taken from the recorded evidence.
const CIRCUIT_RECORDS = [
  { name: "TinyApproval", ...deploymentDocument.circuits.tinyApproval, block: deploymentDocument.circuits.tinyApproval.manufactureBlock, providerBlock: undefined as number | undefined },
  { name: "AgentApproval", ...deploymentDocument.circuits.agentApproval, block: 72528952, providerBlock: 72529601 as number | undefined }
];
const EXPLORER = "https://www.oklink.com/xlayer";
function extLink(href: string, text: string, cls = ""): string { return `<a ${cls ? `class="${cls}" ` : ""}href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`; }
function txLink(hash: string, text = `${shortHash(hash)} ↗`, cls = ""): string { return extLink(`${EXPLORER}/tx/${hash}`, text, cls); }
function addressLink(address: string, cls = ""): string { return extLink(`${EXPLORER}/address/${address}`, `${address} ↗`, cls); }
const WALLET_CHANGED_NOTICE = "Wallet/account/network changed. Readiness was invalidated.";
interface CircuitCheckUi { id: string; status: "loading" | "ready" | "error"; record?: CircuitRecord; error?: string }
const state: UiState = { key: "agent", source: AGENT_APPROVAL_SOURCE.trim(), diagnostics: [], compiling: true, selectedState: 0, inputs: {}, liveStatus: "PENDING", liveLoading: false, readbackLoading: false, quoteLoading: false, wallet: { status: "unavailable" } };

if (app) void boot(app);

function esc(value: string): string { return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] as string); }
function shortHash(value: string): string { return `${value.slice(0, 10)}…${value.slice(-8)}`; }
function nav(active: string): string { return `<header class="topbar"><a class="brand" href="#/"><svg class="brand-logo" viewBox="0 0 64 64" fill="none" width="26" height="26" aria-hidden="true"><path d="M48 16H16v32h32V32H37" stroke="currentColor" stroke-width="7"/><circle cx="31" cy="32" r="4.5" stroke="currentColor" stroke-width="3.5"/></svg><span class="brand-word">Gate<span class="brand-x">X</span></span></a><nav aria-label="Primary"><a class="nav-link ${active === "/" ? "active" : ""}" href="#/">Overview</a><a class="nav-link ${active === "/workspace" ? "active" : ""}" href="#/workspace">Workspace</a><a class="nav-link ${active === "/circuits" ? "active" : ""}" href="#/circuits">Circuits</a><a class="nav-link ${active === "/evidence" ? "active" : ""}" href="#/evidence">Evidence</a></nav><span class="network-pill"><span class="live-dot"></span>X Layer / 196</span></header>`; }
function badge(label: string, tone: "green" | "amber" | "blue" | "muted" = "muted"): string { return `<span class="badge ${tone}">${esc(label)}</span>`; }
function proofStat(value: string, label: string): string { return `<div class="proof-stat"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`; }
function machineSummary(compiled: CompiledExample): string { const machine = compiled.compiled.machine; return `<div class="summary-grid">${proofStat(String(compiled.compiled.nandCount), "NAND gates")}${proofStat(String(compiled.compiled.latchCount), "LATCH records")}${proofStat(String(machine.states.length), "states")}${proofStat(`${machine.inputs.length} / ${machine.outputs.length}`, "inputs / outputs")}</div>`; }
function stateDiagram(compiled: CompiledMachine): string { const states = compiled.machine.states.map((item, index) => `<span class="state-step">${index > 0 ? `<span class="state-arrow">→</span>` : ""}<span class="state-node ${item.terminal ? "terminal" : ""}">${esc(item.name)}${item.terminal ? " <small>terminal</small>" : ""}<em>${index}</em></span></span>`).join(""); return `<div class="state-diagram" aria-label="State diagram">${states}</div><p class="muted">Reset input: <code>${esc(compiled.machine.resetInput)}</code>. Reset has priority and clears transition-pulse outputs. Terminal states hold until reset.</p>`; }
type RowStatus = VerificationStatus | "warning" | "NOT RUN" | "READING";
function statusRow(label: string, status: RowStatus, detail: string): string { const word = status === "warning" ? "NOTE" : status; const icon = status === "PASSED" ? "✓" : status === "FAILED" ? "×" : status === "STALE" ? "!" : status === "UNAVAILABLE" ? "?" : status === "warning" ? "!" : status === "NOT RUN" ? "–" : status === "READING" ? "…" : "•"; const iconCss = status === "warning" ? "warning" : status.toLowerCase().replace(" ", "-"); const wordCss = status === "warning" ? "note" : iconCss; return `<div class="status-row"><span class="status-icon ${iconCss}">${icon}</span><span><strong>${esc(label)}</strong><small>${esc(detail)}</small></span><span class="status-word ${wordCss}">${word}</span></div>`; }
function formatBytes(bytes: Uint8Array): string { return `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`; }
async function compileCurrent(): Promise<void> {
  const source = state.source; state.compiling = true; state.diagnostics = []; render();
  try { state.compiled = await compileExample(state.key, source); startExhaustive(); state.selectedState = state.compiled.compiled.machine.stateIndex.get(state.compiled.compiled.machine.initialState) ?? 0; state.inputs = Object.fromEntries(state.compiled.compiled.machine.inputs.map((input) => [input.name, false])); state.live = undefined; state.liveError = undefined; state.liveStatus = "PENDING"; state.readback = undefined; state.readbackError = undefined; state.binding = bindingForCurrent(); const restored = readSessions().find((candidate) => sessionKey(candidate) === sessionKey({ artifactDigest: state.compiled?.compiled.hash ?? "", chainId: browserLock.chainId, processor: browserDeployment.processor, circuitId: state.compiled?.definition.circuitId ?? "" }) && candidate.sourceDigest === state.compiled?.sourceDigest); state.restored = restored === undefined ? undefined : { ...restored, history: restored.history.map((entry) => ({ ...entry, origin: "LOCAL SIMULATION" as const })) }; if (artifactEligible()) void refreshReadback(); }
  catch (error) { state.compiled = undefined; state.exhaustive = undefined; state.diagnostics = diagnosticFromError(error, source); }
  finally { state.compiling = false; render(); if (TAPEOUT_ENABLED && state.compiled !== undefined) scheduleTapeoutPlan(600); }
}
/** Runs the full source-vs-netlist comparison for the current compile, off the render path. The result is keyed by the hash of the checked bytes. */
function startExhaustive(): void {
  const compiled = state.compiled;
  if (compiled === undefined) { state.exhaustive = undefined; return; }
  const hash = compiled.compiled.hash;
  state.exhaustive = { hash, status: "running" };
  const finish = (next: ExhaustiveUi): void => {
    if (state.compiled?.compiled.hash !== hash || state.exhaustive?.hash !== hash) return;
    state.exhaustive = next; render();
    if (TAPEOUT_ENABLED && tapeoutGate(next, hash).open) scheduleTapeoutPlan(0);
  };
  void runExhaustiveCheck(compiled.compiled).then((result) => finish({ hash, status: "done", result }), (error: unknown) => finish({ hash, status: "error", message: error instanceof Error ? error.message : String(error) }));
}
function exhaustiveRow(): string {
  const compiled = state.compiled; const check = state.exhaustive;
  if (compiled === undefined) return statusRow("EXHAUSTIVE FSM VERIFIED", "PENDING", "Waiting for valid source.");
  if (check === undefined || check.hash !== compiled.compiled.hash || check.status === "running") return statusRow("EXHAUSTIVE FSM VERIFIED", "READING", "Checking every case…");
  if (check.status === "error") return statusRow("EXHAUSTIVE FSM VERIFIED", "UNAVAILABLE", `The check could not finish: ${check.message}`);
  const { result } = check;
  if (result.matched === result.total) return statusRow("EXHAUSTIVE FSM VERIFIED", "PASSED", `${result.total} of ${result.total} state and input cases match the source.`);
  const first = result.mismatches[0];
  return statusRow("EXHAUSTIVE FSM VERIFIED", "FAILED", `${result.total - result.matched} of ${result.total} cases do not match the source. ${first === undefined ? "" : describeMismatch(compiled.compiled, first)}`);
}
function checkedLine(): string {
  const compiled = state.compiled; const check = state.exhaustive;
  if (compiled === undefined || check === undefined || check.hash !== compiled.compiled.hash || check.status === "running") return `<p class="checked-line">Checked: <strong>checking every case…</strong></p>`;
  if (check.status === "error") return `<p class="checked-line">Checked: <strong>could not finish</strong></p>`;
  return `<p class="checked-line ${check.result.matched === check.result.total ? "ok" : "bad"}">Checked: <strong>${check.result.matched} / ${check.result.total} cases</strong></p>`;
}
function bindingForCurrent(readback = state.readback): ArtifactBindingResult { const compiled = state.compiled; if (compiled === undefined) return { status: "PENDING", liveReady: false, detail: "Compile a valid source first." }; return verifyArtifactBinding({ source: state.source, expectedSource: compiled.definition.source, deterministic: compiled.deterministic, artifactMatch: compiled.artifactMatch, localHash: compiled.compiled.hash, expectedLocalHash: compiled.definition.expected.localSha, payloadBytes: compiled.payload.payload.length, expectedPayloadBytes: compiled.definition.expected.payloadBytes, payloadHash: compiled.payload.payloadHash, expectedPayloadHash: compiled.definition.expected.payloadSha, expectedDimensions: compiled.payload.dimensions, expectedCircuitId: compiled.definition.circuitId, expectedProcessor: browserDeployment.processor, readback }); }
function artifactEligible(): boolean { const compiled = state.compiled; return compiled !== undefined && compiled.deterministic && compiled.artifactMatch && state.source.trim() === compiled.definition.source.trim(); }
function sourceCard(source: string): string { return `<pre class="code-block"><code>${esc(source)}</code></pre>`; }

function pipelineRow(title: string, detail: string, next = false): string { return `<div class="status-row"><span class="status-icon ${next ? "next" : "passed"}">${next ? "→" : "✓"}</span><span><strong>${esc(title)}</strong><small>${esc(detail)}</small></span></div>`; }
function landing(): string {
  const compiled = state.key === "agent" ? state.compiled : undefined;
  const expected = EXAMPLES.agent.expected;
  const machine = compiled?.compiled.machine;
  const declaredTransitions = (AGENT_APPROVAL_SOURCE.match(/^\s*\w+\s*->/gm) ?? []).length; // machine.transitions is the validator's expanded list, not the written rules
  const pipeline = `<aside class="panel pipeline"><div class="panel-label">HOW ONE RULE BECOMES A CIRCUIT</div><div class="status-list">${pipelineRow("Written", `AgentApproval: ${machine?.states.length ?? 4} states, ${declaredTransitions} transitions, ${machine?.inputs.length ?? 6} inputs`)}${pipelineRow("Compiled", `${compiled?.compiled.nandCount ?? expected.nand} NAND gates and ${compiled?.compiled.latchCount ?? expected.latch} latches, same bytes every time`)}${pipelineRow("Checked", `${expected.cases} of ${expected.cases} state and input cases match the source`)}${pipelineRow("On X Layer", `Circuit ${EXAMPLES.agent.circuitId}, read back and matched by two providers`)}${pipelineRow("Yours next", "Tape out your own rule from your wallet, then share a link anyone can verify", true)}</div></aside>`;
  return `${nav("/")}<main class="page landing"><section class="hero"><div class="hero-text"><div class="eyebrow">VERIFIED CIRCUIT COMPILER <span>•</span> X LAYER / 196</div><h1>Readable rules,<br><span>verified circuits.</span></h1><p class="hero-copy">Write an approval workflow as a state machine. GateX compiles it to a TapeOut circuit on X Layer and proves the circuit does what the source says.</p><div class="hero-actions"><a class="button primary" href="#/workspace">Open workspace <span>↗</span></a><a class="text-link" href="#/circuits">See all circuits</a></div><div class="hero-proof"><span class="pulse-check">✓</span><span><strong>AgentApproval</strong> is the flagship proof</span><span class="divider"></span><span>${expected.cases} / ${expected.cases} cases matched</span></div></div>${pipeline}</section><section class="overview-grid"><article class="panel dark-panel flagship"><div class="panel-label">FLAGSHIP EXAMPLE <span>${badge("LIVE REFERENCE", "blue")}</span></div><h2>AgentApproval</h2><p class="muted">A small approval flow with explicit human and scope checks, compiled through the same generic GateX language path.</p>${compiled ? machineSummary(compiled) : "<div class=loading>Compiling the example…</div>"}<div class="flagship-foot"><div class="small-rule"></div><div class="state-line">${compiled ? compiled.compiled.machine.states.map((item) => `<span>${esc(item.name)}</span>`).join("<i>→</i>") : "IDLE → REQUESTED → APPROVED → USED"}</div></div></article><article class="panel source-panel"><div class="panel-label">SOURCE DSL <span>${badge("SOURCE VALID", "green")}</span></div>${sourceCard(AGENT_APPROVAL_SOURCE.trim())}<a class="text-link" href="#/workspace">Edit in workspace ↗</a></article></section><section class="callout landing-callout"><div class="callout-icon">◎</div><div><strong>Caller-owned state</strong><p>State is stored by this browser. TapeOut computes transitions; it does not store this workflow.</p></div></section></main>${footer()}`;
}

function compilePanel(): string { const compiled = state.compiled; if (state.compiling) return `<section class="panel"><div class="loading">Compiling through the generic GateX path…</div></section>`; if (compiled === undefined) return `<section class="panel error-panel"><div class="panel-label">COMPILER DIAGNOSTICS ${badge("BLOCKED", "amber")}</div><div class="diagnostics">${state.diagnostics.map((item) => `<div class="diagnostic"><code>${esc(item.code)}</code><span>${esc(item.message)}</span><small>${esc(item.location)}</small></div>`).join("")}</div><p class="muted">Invalid source cannot be compiled into a circuit.${TAPEOUT_ENABLED ? "" : " This workspace is read-only."}</p></section>`; const expected = compiled.definition.expected; const sourceExact = state.source.trim() === compiled.definition.source.trim(); return `<section class="panel"><div class="panel-label">COMPILE RESULT <span>${badge("DETERMINISTIC", "green")}</span></div><div class="compile-head"><div><h3>${sourceExact ? `${esc(compiled.definition.label)} <span class="id-chip">circuit ${compiled.definition.circuitId}</span>` : `${esc(compiled.compiled.machine.name)} <span class="id-chip">not manufactured</span>`}</h3><p class="muted">Source valid. Generic parser, independent interpreter, canonical serializer.</p></div><span class="big-check">✓</span></div>${machineSummary(compiled)}${checkedLine()}<div class="kv-grid"><div><small>State encoding</small><code>${compiled.compiled.machine.stateBits} bits · LSB-first</code></div><div><small>Local container</small><code>${compiled.compiled.bytes.length} bytes · ${shortHash(compiled.compiled.hash)}</code></div><div><small>TapeOut payload</small><code>${compiled.payload.payload.length} bytes · ${shortHash(compiled.payload.payloadHash)}</code></div><div><small>Dimensions</small><code>(${compiled.payload.dimensions.nIn}, ${compiled.payload.dimensions.nOut}, ${compiled.payload.dimensions.nState}, ${compiled.payload.dimensions.gateCount})</code></div></div><div class="hash-line"><span>Local SHA-256</span><code>${esc(compiled.compiled.hash)}</code></div><div class="hash-line"><span>Payload SHA-256</span><code>${esc(compiled.payload.payloadHash)}</code></div><p class="compile-note">${sourceExact && compiled.artifactMatch && compiled.deterministic && compiled.compiled.bytes.length === expected.localBytes ? "Matches the circuit manufactured on X Layer." : "This source is valid but differs from the manufactured circuit."}</p></section>`; }
function verificationPanel(): string { const compiled = state.compiled; const sourceExact = compiled !== undefined && state.source.trim() === compiled.definition.source.trim(); const exact = compiled?.artifactMatch === true && compiled.deterministic && sourceExact; const bindingStatus = state.binding?.status ?? "PENDING"; const readbackNotRun = state.readback === undefined && state.readbackError === undefined && bindingStatus === "PENDING"; const readbackStatus: RowStatus = state.readbackLoading ? "READING" : readbackNotRun ? "NOT RUN" : state.readbackError ? state.liveStatus : bindingStatus; const liveNotRun = state.live === undefined && state.liveError === undefined; const liveStatus: RowStatus = state.liveLoading ? "READING" : state.live ? liveVerificationStatus(state.readback, state.live.mismatches.length) : state.liveError ? state.liveStatus : "NOT RUN"; return `<section class="panel"><div class="panel-label">VERIFICATION CHAIN</div><div class="status-list">${statusRow("SOURCE VALID", compiled ? "PASSED" : "PENDING", compiled ? "The parser and validator passed the current source." : "Waiting for valid source.")}${statusRow("COMPILE VERIFIED", exact ? "PASSED" : compiled ? "STALE" : "PENDING", exact ? "Gate counts and hashes match the manufactured circuit." : "This source is valid but differs from the manufactured circuit.")}${exhaustiveRow()}${exact ? statusRow("HISTORICAL MANUFACTURE", "PASSED", `Recorded manufacture evidence matches circuit ${compiled?.definition.circuitId}.`) : compiled ? statusRow("HISTORICAL MANUFACTURE", "NOT RUN", TAPEOUT_ENABLED && (() => { const gate = tapeoutGate(state.exhaustive, compiled?.compiled.hash); return gate.open || gate.kind !== "failed"; })() ? "Not manufactured yet — you can tape it out below" : "Not manufactured yet.") : statusRow("HISTORICAL MANUFACTURE", "STALE", "Recorded manufacture evidence is stale for this source.")}${statusRow("FRESH CIRCUIT READBACK", readbackStatus, state.readbackLoading ? "Reading the circuit from X Layer through two providers…" : readbackNotRun ? (artifactEligible() ? "Not run yet. Use “1. Read circuit from X Layer” in the playground." : "Not run. Reset to the example source to read the circuit.") : state.binding?.detail ?? (state.readbackError ?? "A fresh circuit readback is required."))}${statusRow("LIVE CHAIN MATCH", liveStatus, state.live ? `${state.live.providers.length} providers at block ${state.live.block.number}.` : state.liveLoading ? "Comparing one live transition…" : state.liveError ?? (state.binding?.liveReady === true ? "Not run yet. Use “2. Compare live transition” in the playground." : "Not run yet. Do step 1 in the playground first."))}${statusRow("TAPEOUT SOURCE NOT INDEPENDENTLY VERIFIED", "warning", "GateX verified behaviour for every case it checked. It did not verify the deployed TapeOut contract source.")}</div></section>`; }
function quotePanel(): string {
  const quote = state.quote;
  const quoteStale = quote !== undefined && state.live !== undefined && state.live.block.number > quote.block.number;
  const required = state.compiled?.compiled.nandCount ?? 0;
  const latch = state.compiled?.compiled.latchCount ?? 0;
  const nandDeficit = quote?.nandBalance === undefined ? undefined : BigInt(required) > quote.nandBalance ? BigInt(required) - quote.nandBalance : 0n;
  const latchDeficit = quote?.latchBalance === undefined ? undefined : BigInt(latch) > quote.latchBalance ? BigInt(latch) - quote.latchBalance : 0n;
  const mintTransactions = nandDeficit !== undefined && latchDeficit !== undefined ? (nandDeficit > 0n ? 1n : 0n) + (latchDeficit > 0n ? 1n : 0n) : undefined;
  const projectedValueWei = quote && nandDeficit !== undefined && latchDeficit !== undefined && mintTransactions !== undefined
    ? (nandDeficit + latchDeficit) * quote.mintPriceWei + mintTransactions * quote.protocolFeeWei + quote.tapeoutFeeWei
    : undefined;
  const gasAssessment = assessGasInclusiveSufficiency(quote?.nativeBalanceWei, projectedValueWei, undefined);
  const quoteBody = state.quoteLoading
    ? `<div class="loading">Reading both providers…</div>`
    : state.quoteError
      ? `<div class="inline-error"><strong>UNAVAILABLE</strong><span>${esc(state.quoteError === WALLET_CHANGED_NOTICE ? "Balance needs a refresh after a wallet or network change." : state.quoteError)}</span></div>`
      : quote
        ? `<div class="quote-grid">${proofStat(quote.minted.toString(), "lifetime minted")}${proofStat(quote.cap.toString(), "shared cap")}${proofStat(`${weiToOkb(quote.mintPriceWei)} OKB`, "mint price / asset")}${proofStat(`${weiToOkb(quote.protocolFeeWei)} OKB`, "fixed mint fee / tx")}${proofStat(`${weiToOkb(quote.tapeoutFeeWei)} OKB`, "tapeout fee")}${proofStat(quote.nativeBalanceWei === undefined ? "unavailable" : `${weiToOkb(quote.nativeBalanceWei)} OKB`, "wallet balance")}${proofStat(projectedValueWei === undefined ? "unavailable" : `${weiToOkb(projectedValueWei)} OKB`, "PROTOCOL VALUE BEFORE GAS")}${proofStat("unavailable", "estimated gas")}${proofStat("unavailable", "estimated total including gas")}</div>${gasAssessment.status === "INSUFFICIENT" ? `<div class="inline-error"><strong>INSUFFICIENT OKB</strong><span>Balance is below the gas-inclusive estimate.</span></div>` : `<div class="inline-error"><strong>GAS ESTIMATE UNAVAILABLE</strong><span>PROTOCOL VALUE BEFORE GAS only. No manufacture sufficiency claim is made.</span></div>`}<div class="quote-meta"><span>${quoteStale ? "Quote is stale. Refresh before relying on it." : quote.agreement ? "Both providers agree on displayed fields" : "Provider disagreement: values below are provider-specific"}</span><span>block ${quote.block.number} · ${esc(shortHash(quote.block.hash))}</span><span>gas price ${weiToOkb(quote.gasPriceWei)} OKB per gas unit</span></div>`
        : `<p class="muted">Read the current protocol values from both providers. No wallet connection is requested.</p>`;
  const owned = quote?.nandBalance === undefined ? "unavailable" : `${quote.nandBalance} NAND · ${quote.latchBalance} LATCH`;
  const deficits = nandDeficit === undefined || latchDeficit === undefined ? "unavailable" : `${nandDeficit} NAND · ${latchDeficit} LATCH`;
  const quoteBadge = quoteStale ? badge("STALE", "amber") : badge(state.wallet.status === "ready" ? "ACCOUNT READ" : "NO WALLET", state.wallet.status === "ready" ? "blue" : "muted");
  return `<section class="panel quote-panel"><div class="panel-label">MANUFACTURE COST <span>${quoteBadge}</span></div><h3>What this circuit needs</h3><p class="muted">Needs <strong>${required}</strong> NAND · <strong>${latch}</strong> LATCH. ${owned === "unavailable" ? "" : `Owned: <strong>${owned}</strong>. Short by: <strong>${deficits}</strong>.`}</p>${quoteBody}<div class="quote-actions"><button class="button secondary" id="refresh-quote">Refresh quote</button></div>${walletStep()}<small class="safety-note">${TAPEOUT_ENABLED ? "GateX only asks your wallet to sign when you choose to tape out." : "This workspace is read-only. It never asks for a signature."}</small></section>`;
}

function walletStep(): string {
  const wallet = state.wallet;
  const intro = `<p class="muted wallet-intro">Optional: connect an OKX wallet to check your own transistor balance against what this circuit needs.</p>`;
  if (wallet.status === "unavailable") return `<div class="wallet-step">${intro}<div class="wallet-row"><button class="button secondary small-button" id="connect-wallet" disabled>Connect OKX Wallet</button><small class="muted">OKX Wallet not detected in this browser.</small></div></div>`;
  const detail = wallet.status === "ready" ? `${wallet.name ?? "OKX Wallet"} · ${abbreviatedAccount(wallet.account)} · X Layer / 196` : wallet.status === "wrong-network" ? `Wrong network ${wallet.chainId ?? "unknown"}. Switch manually before connecting.` : wallet.error ?? "No account connected.";
  const action = wallet.status === "ready" ? `<button class="button secondary small-button" id="disconnect-wallet">Disconnect</button>` : `<button class="button secondary small-button" id="connect-wallet">Connect OKX Wallet</button>`;
  return `<div class="wallet-step">${wallet.status === "ready" ? "" : intro}<div class="wallet-state"><span class="status-icon ${wallet.status === "ready" ? "passed" : ""}">${wallet.status === "ready" ? "✓" : "•"}</span><span><strong>${wallet.status === "ready" ? "Wallet connected" : wallet.status === "wrong-network" ? "Wrong network" : "Wallet disconnected"}</strong><small>${esc(detail)}</small></span>${action}</div></div>`;
}

function formatStateBytes(compiled: CompiledMachine, bytes: Uint8Array): string { const value = bytes.reduce((result, byte, index) => result | (byte << (index * 8)), 0); return stateName(compiled, value); }
function playground(): string { const compiled = state.compiled; if (compiled === undefined) return `<section class="panel muted-panel"><div class="panel-label">LIVE TRANSITION PLAYGROUND</div><p>Compile valid source to enable the comparison.</p></section>`; const machine = compiled.compiled.machine; const mask = machine.inputs.reduce((result, input, index) => result | (state.inputs[input.name] ? 1 << index : 0), 0); const local = localStep(compiled.compiled, state.selectedState, mask); const live = state.live; const inputControls = machine.inputs.map((input) => `<label class="toggle"><input type="checkbox" data-input="${esc(input.name)}" ${state.inputs[input.name] ? "checked" : ""}><span>${esc(input.name)}</span></label>`).join(""); const ready = state.binding?.liveReady === true; const readbackNotRun = state.readback === undefined && state.readbackError === undefined && !state.readbackLoading; const readBlock = state.readback?.detail?.match(/block (\d+)/)?.[1];
  const liveBadge = live ? badge(live.mismatches.length === 0 ? "MATCH" : "MISMATCH", live.mismatches.length === 0 ? "green" : "amber") : state.readbackLoading ? badge("READING", "muted") : state.liveError ? badge(state.liveStatus, "amber") : ready ? badge("READY", "blue") : readbackNotRun ? badge("NOT RUN", "muted") : badge(state.liveStatus, "amber");
  const liveIdle = state.readbackLoading ? `<strong class="idle">Reading circuit…</strong><div>Reading the manufactured circuit from X Layer.</div><code>Reading from two providers</code>` : state.liveError ? `<strong>${state.liveStatus}</strong><div>${esc(state.liveError)}</div><code>${state.readback ? esc(state.readback.detail ?? "Fresh readback recorded") : "No live result recorded"}</code>` : ready ? `<strong>Ready</strong><div>${readBlock ? `Circuit read at block ${readBlock}.` : "Circuit read from X Layer."} Run step 2 to compare.</div><code>${esc(state.readback?.detail ?? "Fresh readback recorded")}</code>` : readbackNotRun ? `<strong class="idle">Not run yet</strong><div>${artifactEligible() ? "Use the two buttons above." : "Reset to the example to compare against X Layer."}</div><code>No live result recorded</code>` : `<strong>${state.liveStatus}</strong><div>A fresh circuit readback is required.</div><code>${state.readback ? esc(state.readback.detail ?? "Fresh readback recorded") : "No live result recorded"}</code>`;
  return `<section class="panel playground"><div class="panel-label">LIVE TRANSITION PLAYGROUND <span>${badge("READ-ONLY", "blue")}</span></div><div class="play-head"><div><h3>Compare one transition</h3><p class="muted">Read the manufactured circuit from X Layer, then run one transition there and locally and compare the results.</p></div><div class="quote-actions"><button class="button ${ready ? "secondary" : "primary"} small-button" id="refresh-readback" ${state.readbackLoading || !artifactEligible() ? "disabled" : ""}>${state.readbackLoading ? "Reading circuit…" : "1. Read circuit from X Layer"}</button><button class="button ${ready ? "primary" : "secondary"} small-button" id="run-live" ${state.liveLoading || !ready ? "disabled" : ""}>${state.liveLoading ? "Reading…" : "2. Compare live transition"}</button></div></div><div class="play-controls"><label>Current state<select id="state-select">${machine.states.map((item, index) => `<option value="${index}" ${index === state.selectedState ? "selected" : ""}>${esc(item.name)} (${index})</option>`).join("")}</select></label><div><span class="control-label">Inputs</span><div class="toggles">${inputControls}</div></div></div><div class="comparison-grid"><div class="result-card local"><div class="result-label">LOCAL SIMULATION ${badge("AST INTERPRETER", "muted")}</div><strong>${esc(stateName(compiled.compiled, local.nextState))}</strong><div>output: ${local.outputs.map((value, index) => `${esc(machine.outputs[index]?.name ?? "output")}=${value ? "1" : "0"}`).join(" · ")}</div><code>next ${formatBytes(local.nextStateBytes)} · out ${formatBytes(local.outputBytes)}</code></div><div class="result-card live"><div class="result-label">LIVE X LAYER ${liveBadge}</div>${live ? `<strong>${esc(formatStateBytes(compiled.compiled, live.nextState))}</strong><div>output: ${esc(formatBytes(live.outputs))}</div><code>block ${live.block.number} · ${esc(shortHash(live.block.hash))}</code>${live.mismatches.length > 0 ? `<div class="inline-error">${live.mismatches.map(esc).join(" ")}</div>` : ""}` : liveIdle}</div></div><div class="provider-line">${live ? `Providers: ${live.providers.map(esc).join(" · ")} · common block ${live.block.number}` : state.readback ? "Circuit read from two providers. No live step yet." : "No current-session live evidence recorded"}</div></section>`; }
function workspace(): string { const compiled = state.compiled; const selected = state.templateKey !== undefined || state.sharedSource === true ? "" : state.key === "agent" ? "AgentApproval" : "TinyApproval"; const templateRow = `<div class="template-row"><span class="template-label">Start from a template:</span>${TEMPLATES.map((template) => `<button class="template-button ${state.templateKey === template.key ? "active" : ""}" data-template="${esc(template.key)}" title="${esc(template.blurb)}">${esc(template.name)}</button>`).join("")}${state.templateKey !== undefined ? `<small class="template-note">${esc(TEMPLATES.find((template) => template.key === state.templateKey)?.blurb ?? "")}. Not on chain${TAPEOUT_ENABLED ? ": tape it out below to put it there" : ""}.</small>` : ""}</div>`; const restored = state.restored ? `<p class="local-history"><strong>LOCAL</strong> Restored history for circuit ${esc(state.restored.circuitId)}. It is not fresh live evidence.</p>` : ""; return `${nav("/workspace")}<main class="page workspace"><section class="page-heading"><div><div class="eyebrow">WORKSPACE</div><h1>Compile. Inspect. Compare.</h1><p>Edit the rule, compile it, and compare the result with the circuit on X Layer.</p></div></section><div class="example-tabs"><button class="tab ${selected === "AgentApproval" ? "active" : ""}" data-example="agent">AgentApproval <small>circuit 2</small></button><button class="tab ${selected === "TinyApproval" ? "active" : ""}" data-example="tiny">TinyApproval <small>circuit 1</small></button></div>${templateRow}${state.shareNotice ? `<p class="share-notice">${esc(state.shareNotice)}</p>` : ""}${circuitBanner()}<section class="workspace-grid"><div class="workspace-main"><section class="panel editor-panel"><div class="panel-label">DSL SOURCE <span>${badge(compiled ? "EDITABLE" : "DIAGNOSTICS", compiled ? "blue" : "amber")}</span></div><textarea id="source-editor" spellcheck="false" aria-label="GateX DSL source">${esc(state.source)}</textarea><div class="editor-foot"><span>Generic GateX language · reset priority · transition-pulse outputs</span><button class="button secondary small-button" id="reset-source">${state.templateKey !== undefined ? "Reset to template" : "Reset to example"}</button></div></section>${compilePanel()}${TAPEOUT_ENABLED ? `<div class="tapeout-region" id="tapeout-region">${tapeoutRegionHtml()}</div>` : ""}${playground()}</div><aside class="workspace-side">${verificationPanel()}<section class="panel"><div class="panel-label">STATE MACHINE</div>${compiled ? stateDiagram(compiled.compiled) : `<p class="muted">State diagram waits for valid source.</p>`}</section>${quotePanel()}<section class="panel disclosure"><div class="panel-label">SESSION STORAGE</div><p>State is stored by this browser. TapeOut computes transitions; it does not store this workflow.</p>${restored}<p class="muted">Restored histories are labeled LOCAL, never fresh live evidence. Changing the source clears the circuit check.</p></section></aside></section></main>${footer()}`; }

function artifactEvidence(counts: string, bytes: string, localSha: string, payloadSha: string, cases: string): string { return `<div class="artifact-list"><div><span>${esc(counts)}</span><strong>${esc(cases)}</strong></div><div><span>${esc(bytes)}</span><small>dimensions recorded in readback</small></div><div><small>local SHA-256</small><code>${esc(localSha)}</code></div><div><small>TapeOut payload SHA-256</small><code>${esc(payloadSha)}</code></div></div>`; }
function evidence(): string { const current = state.readback && state.binding?.liveReady ? `<section class="panel history-panel"><div class="panel-label">CURRENT SESSION FRESH READBACK <span>${badge("LIVE X LAYER", "blue")}</span></div><p class="muted">Circuit ${esc(state.readback.circuitId)} was read from both providers in this browser session and matched the manufactured circuit.</p><div class="history-grid"><div><small>Payload</small><code>${esc(shortHash(state.readback.payloadSha256))}</code></div><div><small>Dimensions</small><code>(${state.readback.nIn}, ${state.readback.nOut}, ${state.readback.nState}, ${state.readback.gateCount})</code></div><div><small>Owner</small><code>${esc(state.readback.owner)}</code></div><div><small>Processor</small><code>${esc(state.readback.processor)}</code></div></div></section>` : `${state.readbackLoading ? `<section class="panel history-panel"><div class="panel-label">CURRENT SESSION FRESH READBACK <span>${badge("READING", "muted")}</span></div><p class="muted">Reading the circuit from X Layer…</p></section>` : state.readback === undefined && state.readbackError === undefined ? `<section class="panel history-panel"><div class="panel-label">CURRENT SESSION FRESH READBACK <span>${badge("NOT RUN", "muted")}</span></div><p class="muted">No live check has been run in this browser session yet. <a class="text-link" href="#/workspace">Run one in the workspace ↗</a></p></section>` : `<section class="panel history-panel"><div class="panel-label">CURRENT SESSION FRESH READBACK <span>${badge("UNAVAILABLE", "amber")}</span></div><p class="muted">Recorded manufacture evidence remains historical. This session could not read the circuit from X Layer.</p></section>`}`; return `${nav("/evidence")}<main class="page evidence"><section class="page-heading"><div><div class="eyebrow">EVIDENCE / READ-ONLY RECORD</div><h1>What has been proven.</h1><p>What was manufactured on X Layer, what was checked, and where to verify it yourself.</p></div>${badge("VERIFIED", "green")}</section><section class="evidence-hero panel dark-panel"><div><div class="panel-label">GATEX ON X LAYER</div><h2>Two circuits, manufactured and verified.</h2><div class="deploy-lines"><div><small>Processor</small><code>${addressLink(browserDeployment.processor)}</code></div><div><small>Token</small><code>${addressLink(browserDeployment.token)}</code></div><div><small>Deployment wallet</small><code>${addressLink(browserDeployment.creator)}</code></div></div><p class="muted">Chain ${browserDeployment.chainId} · registry index ${browserDeployment.registryIndex}</p></div><div class="evidence-count">${proofStat("512", "historical comparisons")}${proofStat("0", "mismatches")}</div></section><section class="panel terms-panel"><div class="panel-label">TRANSISTOR TERMS</div><div class="proof-grid">${proofStat(browserDeployment.metadata.symbol, "TOKEN")}${proofStat(browserDeployment.metadata.cap.toLocaleString("en-US"), "SUPPLY CAP")}${proofStat(`${weiToOkb(browserDeployment.metadata.priceWei)} OKB`, "UNIT PRICE")}<div class="proof-stat"><strong class="stat-link">${txLink(browserDeployment.creationTransaction)}</strong><span>SET AT CREATION</span></div></div><p class="muted terms-note">Supply cap and unit price were fixed when the processor was created on X Layer.</p>${pricingLines()}</section><div class="evidence-grid"><article class="panel evidence-card"><div class="panel-label">TINYAPPROVAL <span>${badge("HISTORICAL EVIDENCE", "muted")}</span></div><h2>circuit 1</h2><p class="muted">LOCKED → READY → USED</p><p class="card-link">${txLink(CIRCUIT_RECORDS[0]?.manufactureTransaction ?? "", "View manufacture tx ↗", "text-link")}</p>${artifactEvidence("89 NAND · 2 LATCH · 91 records", "643 bytes local · 631 bytes TapeOut", "adee32d4133073926d312a711643d16ac7d849c7e662c2bce8f6131c35fd0334", "7ec1ed9fe2e0c5f92a45b2ad49fe3da969c109f01522d8306fe127aba76cabac", "32 / 32 cases")}</article><article class="panel evidence-card featured"><div class="panel-label">AGENTAPPROVAL <span>${badge("HISTORICAL EVIDENCE", "muted")}</span></div><h2>circuit 2</h2><p class="muted">IDLE → REQUESTED → APPROVED → USED</p><p class="card-link">${txLink(CIRCUIT_RECORDS[1]?.manufactureTransaction ?? "", "View manufacture tx ↗", "text-link")}</p>${artifactEvidence("98 NAND · 2 LATCH · 100 records", "706 bytes local · 694 bytes TapeOut", "d68c9881fbe8bf0fbf7f86cfa92ad2889389e07e09bb0e7f0068f23eded50003", "7e4b5f83032beaf32ce2e7c067f1ee24d08feea1e2db8c64ef7c4d7de231dc45", "256 / 256 cases matched")}</article></div>${current}<section class="panel history-panel"><div class="panel-label">HISTORICAL MANUFACTURE RECORD</div>${CIRCUIT_RECORDS.map((record) => `<div class="record-title">circuit ${record.id} · ${record.name}</div><div class="history-grid"><div><small>Manufacture tx</small>${txLink(record.manufactureTransaction)}</div><div><small>Block</small><code>${record.block}</code></div><div><small>Dimensions</small><code>(${record.dimensions.join(", ")})</code></div><div><small>Provider check</small><code>${record.providerCount} providers · ${record.providerCases} cases${record.providerBlock ? ` · block ${record.providerBlock}` : ""}</code></div></div>`).join("")}<p class="limitation">Note: GateX verified behaviour for every case it checked. It did not verify the deployed TapeOut contract source, and it does not provide immutability, stored workflow state, custody or replay protection.</p></section><section class="callout"><div class="callout-icon">◎</div><div><strong>Evidence labels are scoped.</strong><p>Historical manufacture records are labeled HISTORICAL EVIDENCE. LIVE X LAYER is reserved for a fresh current-session readback and live step.</p></div></section></main>${footer()}`; }
// ---------------------------------------------------------------------------------------------------------------------
// Tape out on X Layer (everything below is inert unless TAPEOUT_ENABLED is true)

interface TapeoutUi {
  status: "idle" | "ready" | "checking" | "confirm" | "waiting" | "refused" | "done";
  plan?: TapeoutPlan;
  refusal?: string;
  refusalCode?: string;
  note?: string;
  completed: Array<{ label: string; hash: string }>;
  waiting?: { hash: string; label: string; timedOut: boolean; message?: string };
  done?: { circuitId: string; hash: string; owner: string; payloadSha256: string; source?: string; verification?: VerificationResult; verifying: boolean };
  switching: boolean;
  switchError?: string;
}
const tapeout: TapeoutUi = { status: "idle", completed: [], switching: false };
const tapeoutExecutor = TAPEOUT_ENABLED && app ? new TapeoutExecutor(browserTapeoutDeps()) : undefined;
let tapeoutToken = 0;
let tapeoutTimer = 0;

function resetTapeout(): void { tapeoutToken += 1; window.clearTimeout(tapeoutTimer); tapeout.status = "idle"; tapeout.plan = undefined; tapeout.refusal = undefined; tapeout.refusalCode = undefined; tapeout.note = undefined; tapeout.completed = []; tapeout.waiting = undefined; tapeout.done = undefined; tapeout.switchError = undefined; }
function tapeoutInFlight(): boolean { return tapeout.status === "checking" || tapeout.status === "confirm"; }
function updateTapeout(): void { const region = document.querySelector<HTMLElement>("#tapeout-region"); if (region === null) return; region.innerHTML = tapeoutRegionHtml(); bindTapeoutEvents(); }
function scheduleTapeoutPlan(delay: number): void { if (!TAPEOUT_ENABLED) return; window.clearTimeout(tapeoutTimer); tapeoutTimer = window.setTimeout(() => void refreshTapeoutPlan(), delay); }

function existingCircuitNote(compiled: CompiledExample): string {
  const match = Object.values(EXAMPLES).find((example) => example.expected.payloadSha.toLowerCase() === compiled.payload.payloadHash.toLowerCase().replace(/^0x/, ""));
  return match === undefined ? "" : `<p class="tapeout-note">This exact circuit already exists as circuit ${esc(match.circuitId)}. You can still manufacture your own copy.</p>`;
}

function costRow(label: string, value: string, extra = ""): string { return `<div class="cost-row ${extra}"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`; }
function stepLabelFor(record: PendingRecord): string { return record.kind === "tapeout" ? "Manufacture circuit" : `Buy ${record.amount ?? "?"} ${record.kind === "mint-nand" ? "NAND" : "LATCH"} transistors`; }

function tapeoutChecklist(includePlan = true): string {
  const items: string[] = [];
  let number = 0;
  tapeout.completed.forEach((entry) => { number += 1; items.push(`<li class="done"><span class="status-icon passed">✓</span><span>${esc(entry.label)}<small>${txLink(entry.hash)}</small></span></li>`); });
  (includePlan ? tapeout.plan?.steps ?? [] : []).forEach((step, index) => {
    number += 1;
    const active = index === 0 && (tapeout.status === "waiting" || tapeoutInFlight());
    items.push(`<li class="${active ? "active" : ""}"><span class="step-num">${number}</span><span>${esc(step.label)} — ${esc(weiToOkb(step.valueWei))} OKB${active ? `<small>in progress</small>` : ""}</span></li>`);
  });
  return items.length === 0 ? "" : `<ol class="step-list">${items.join("")}</ol>`;
}

function tapeoutStatusLine(): string {
  if (tapeout.status === "checking") return `<div class="tapeout-status" role="status"><span class="spinner"></span>Checking the transaction on both providers…</div>`;
  if (tapeout.status === "confirm") return `<div class="tapeout-status" role="status"><span class="spinner"></span>Confirm in your wallet</div>`;
  if (tapeout.status === "waiting" && tapeout.waiting !== undefined) {
    const waiting = tapeout.waiting;
    if (waiting.timedOut) return `<div class="tapeout-status" role="status"><span>${esc(waiting.message ?? "Still waiting.")} ${txLink(waiting.hash)}</span></div><div class="tapeout-actions"><button class="button secondary small-button" id="tapeout-recheck">Check again</button><button class="button secondary small-button" id="tapeout-release">The transaction never appeared</button></div>`;
    return `<div class="tapeout-status" role="status"><span class="spinner"></span><span>Waiting for confirmation… ${txLink(waiting.hash)}</span></div>`;
  }
  return "";
}

function tapeoutPlanView(plan: TapeoutPlan): string {
  const busy = tapeout.status !== "ready";
  const next = plan.steps[0];
  const upperBound = plan.steps.some((step) => step.gasIsUpperBound);
  const transistors = plan.totals.nandValueWei + plan.totals.latchValueWei;
  const cost = `<div class="cost-list">${costRow("NAND transistors", `need ${plan.needNand}, you have ${plan.haveNand}, buying ${plan.steps.find((step) => step.kind === "mint-nand")?.amount ?? 0n}`)}${costRow("LATCH transistors", `need ${plan.needLatch}, you have ${plan.haveLatch}, buying ${plan.steps.find((step) => step.kind === "mint-latch")?.amount ?? 0n}`)}${costRow("Transistors", `${weiToOkb(transistors)} OKB`)}${costRow("TapeOut fee", `${weiToOkb(plan.totals.tapeoutFeeWei)} OKB`)}${costRow("Estimated gas", `${weiToOkb(plan.totals.estGasWei)} OKB`)}${costRow("Total", `${weiToOkb(plan.totals.totalWei)} OKB`, "total")}</div><small class="muted tapeout-meta">Read from ${plan.quote.providers.length} providers at block ${plan.quoteBlock.number}.${upperBound ? " Gas for the last step is shown at its safety ceiling; it can only be estimated once the transistors exist." : ""}</small>`;
  const button = next === undefined ? "" : `<div class="tapeout-actions"><button class="button primary" id="tapeout-next" ${busy ? "disabled" : ""}>${esc(next.label)}</button></div>`;
  return `${cost}${tapeoutChecklist()}${tapeoutStatusLine()}${tapeout.note ? `<p class="muted tapeout-note-line">${esc(tapeout.note)}</p>` : ""}<p class="tapeout-disclaimer">You are sending real transactions on X Layer mainnet from your own wallet. GateX never holds your funds.</p>${button}`;
}

function tapeoutDoneView(): string {
  const done = tapeout.done;
  const compiled = state.compiled;
  if (done === undefined || compiled === undefined) return "";
  const verification = done.verification;
  const links = `<div class="result-lines"><span>Transaction ${txLink(done.hash)}</span><span>Owner <code>${esc(abbreviatedAccount(done.owner))}</code></span></div>`;
  if (done.verifying || verification === undefined) return `<div class="result-box"><strong>Circuit #${esc(done.circuitId)} is on X Layer</strong><p class="muted">Verifying the bytes on chain through two providers…</p>${links}</div>`;
  if (verification.verified) {
    const live = verification.live;
    const liveLine = live === undefined ? "" : `<div class="live-compare"><small>One live transition, initial state with all inputs 0, block ${live.blockNumber}</small><div><span>Local: <code>${esc(stateName(compiled.compiled, Number.parseInt(live.local.nextStateHex.slice(2), 16)))} · out ${esc(live.local.outputsHex)}</code></span><span>Chain: <code>${esc(stateName(compiled.compiled, Number.parseInt(live.chain.nextStateHex.slice(2), 16)))} · out ${esc(live.chain.outputsHex)}</code></span><span class="match">${live.match ? "match" : "differs"}</span></div></div>`;
    return `<div class="result-box ok"><strong>Circuit #${esc(done.circuitId)} is on X Layer</strong><p>The bytes on chain match your compile (SHA-256 ${esc(shortHash(done.payloadSha256))}).</p>${links}${liveLine}<small class="muted">Byte-hash equality is the proof. The live transition is a sanity check of the evaluation path.</small><div class="tapeout-actions">${done.source !== undefined ? `<button class="button primary small-button" data-copy-link="done">Copy verification link</button>` : ""}<button class="button secondary small-button" id="tapeout-again">Manufacture another copy</button></div></div>`;
  }
  const failed = verification.outcome === "mismatch";
  return `<div class="result-box warn"><strong>${failed ? `Circuit #${esc(done.circuitId)} was manufactured, but the check failed` : "Manufactured, verification pending"}</strong><p>${esc(verification.detail)}</p>${links}<small class="muted">${failed ? "GateX does not claim this circuit matches your compile." : "Nothing is claimed as verified until the readback completes."}</small><div class="tapeout-actions"><button class="button secondary small-button" id="tapeout-verify">Verify again</button><button class="button secondary small-button" id="tapeout-again">Manufacture another copy</button></div></div>`;
}

function tapeoutBody(): string {
  const wallet = state.wallet;
  if (tapeout.status === "done" && tapeout.done !== undefined) return tapeoutDoneView();
  if (wallet.status === "unavailable") return `<p class="muted">Connect an OKX wallet to see the exact cost.</p><div class="tapeout-actions"><button class="button secondary" id="tapeout-connect" disabled>Connect OKX Wallet</button></div><small class="muted">OKX Wallet not detected in this browser.</small>`;
  if (wallet.status === "wrong-network") return `<p class="muted">Your wallet is not on X Layer (chain 196).</p><div class="tapeout-actions"><button class="button primary" id="tapeout-switch" ${tapeout.switching ? "disabled" : ""}>Switch to X Layer</button></div>${tapeout.switchError ? `<div class="inline-error"><strong>NOT SWITCHED</strong><span>${esc(tapeout.switchError)}</span></div>` : ""}`;
  if (wallet.status !== "ready") return `<p class="muted">Connect an OKX wallet to see the exact cost.</p><div class="tapeout-actions"><button class="button primary" id="tapeout-connect">Connect OKX Wallet</button></div>${wallet.error ? `<small class="muted">${esc(wallet.error)}</small>` : ""}`;
  if (tapeout.status === "refused") return `${tapeoutChecklist(false)}<div class="inline-error"><strong>NOT SENT</strong><span>${esc(tapeout.refusal ?? "This step was refused.")}</span></div><div class="tapeout-actions">${tapeout.refusalCode === "pending-signing" ? `<button class="button secondary small-button" id="tapeout-discard">Nothing was sent, continue</button>` : ""}<button class="button secondary small-button" id="tapeout-refresh">Refresh</button></div>`;
  if (tapeout.plan !== undefined) return tapeoutPlanView(tapeout.plan);
  if (tapeout.status === "waiting") return `${tapeoutChecklist()}${tapeoutStatusLine()}`;
  return `<div class="loading">Reading X Layer through two providers…</div>`;
}

function tapeoutPanel(): string {
  const compiled = state.compiled;
  if (state.compiling || compiled === undefined) return "";
  const violation = safetyLimitViolation(browserLock, compiled.compiled, compiled.payload.payload.length, compiled.payload.dimensions);
  const tone = violation ? badge("NOT AVAILABLE", "muted") : tapeout.status === "done" ? badge(tapeout.done?.verification?.verified ? "VERIFIED" : "MANUFACTURED", tapeout.done?.verification?.verified ? "green" : "amber") : tapeout.status === "refused" ? badge("NOT SENT", "amber") : tapeout.plan !== undefined || tapeout.status === "waiting" ? badge("MAINNET", "blue") : badge("WALLET", "muted");
  const gate = tapeoutGate(state.exhaustive, compiled.compiled.hash);
  const body = violation ? `<p class="muted">${esc(violation.reason)} This circuit is not offered for tape-out here.</p>` : gate.open ? tapeoutBody() : gate.kind === "checking" ? `<div class="loading" role="status">${esc(gate.message)}</div>` : `<div class="inline-error"><strong>NOT AVAILABLE</strong><span>${esc(gate.message)}</span></div>`;
  const toneShown = !violation && !gate.open ? badge(gate.kind === "checking" ? "CHECKING" : "NOT AVAILABLE", "muted") : tone;
  return `<section class="panel tapeout-panel"><div class="panel-label">TAPE OUT ON X LAYER <span>${toneShown}</span></div><h3>Manufacture this circuit</h3>${gate.open ? existingCircuitNote(compiled) : ""}${body}</section>`;
}

function myCircuitsPanel(): string {
  const list = readMyCircuits().slice(0, 5);
  if (list.length === 0) return "";
  return `<section class="panel my-circuits"><div class="panel-label">YOUR CIRCUITS</div><div class="circuit-list">${list.map((circuit) => `<div class="circuit-row"><span><strong>#${esc(circuit.id)} ${esc(circuit.name)}</strong><small>${esc(circuit.date.slice(0, 10))} · ${esc(shortHash(circuit.payloadSha256))} · ${esc(abbreviatedAccount(circuit.owner))}</small></span><span class="circuit-actions">${txLink(circuit.tx, "tx ↗", "text-link")}${circuit.source !== undefined ? `<button class="button secondary small-button" data-copy-link="${esc(circuit.tx)}">Copy verification link</button>` : ""}</span></div>`).join("")}</div></section>`;
}

function tapeoutRegionHtml(): string { const panel = tapeoutPanel(); return panel === "" ? "" : `${panel}${myCircuitsPanel()}`; }

function verificationTarget(): VerificationTarget | undefined {
  const compiled = state.compiled; const account = state.wallet.account;
  if (compiled === undefined || account === undefined) return undefined;
  const dims = compiled.payload.dimensions;
  return { account, payloadSha256: compiled.payload.payloadHash, payloadBytes: compiled.payload.payload.length, nIn: dims.nIn, nOut: dims.nOut, nState: dims.nState, gateCount: dims.gateCount, compiled: compiled.compiled };
}

function applyPlan(result: PlanResult): void {
  if (result.ok) { tapeout.status = "ready"; tapeout.plan = result; tapeout.refusal = undefined; tapeout.refusalCode = undefined; }
  else { tapeout.status = "refused"; tapeout.plan = undefined; tapeout.refusal = result.reason; tapeout.refusalCode = result.code; }
}

async function refreshTapeoutPlan(): Promise<void> {
  const executor = tapeoutExecutor; const compiled = state.compiled; const wallet = state.wallet;
  if (!TAPEOUT_ENABLED || executor === undefined || compiled === undefined || tapeoutInFlight()) return;
  if (!tapeoutGate(state.exhaustive, compiled.compiled.hash).open) { tapeout.status = "idle"; tapeout.plan = undefined; updateTapeout(); return; }
  if (wallet.status !== "ready" || wallet.account === undefined) { tapeout.status = "idle"; tapeout.plan = undefined; updateTapeout(); return; }
  tapeoutToken += 1; const token = tapeoutToken; const account = wallet.account; const sha = compiled.payload.payloadHash;
  tapeout.status = "idle"; tapeout.plan = undefined; tapeout.refusal = undefined; tapeout.note = undefined; updateTapeout();
  const pending = executor.pending(account, sha);
  if (pending !== undefined) { resumePending(pending, token); return; }
  const result = await executor.plan({ compiled: compiled.compiled, account, walletChainId: wallet.chainId });
  if (token !== tapeoutToken) return;
  applyPlan(result); updateTapeout();
}

function resumePending(record: PendingRecord, token: number): void {
  if (record.phase === "submitted" && record.hash !== undefined) { tapeout.status = "waiting"; tapeout.waiting = { hash: record.hash, label: stepLabelFor(record), timedOut: false }; updateTapeout(); void followPending(record, token); return; }
  if (record.phase === "confirmed" && record.kind === "tapeout" && record.hash !== undefined && record.circuitId !== undefined) { void completeTapeout(record.circuitId, record.hash, token); return; }
  tapeout.status = "refused"; tapeout.refusalCode = "pending-signing"; tapeout.refusal = "A signature request from an earlier visit was interrupted and may have been sent. Check your wallet activity before continuing."; updateTapeout();
}

async function followPending(record: PendingRecord, token: number): Promise<void> {
  const executor = tapeoutExecutor; const compiled = state.compiled; const account = state.wallet.account;
  if (executor === undefined || compiled === undefined || account === undefined) return;
  const label = stepLabelFor(record);
  const receipt = await executor.awaitReceipt(record);
  if (token !== tapeoutToken) return;
  if (!receipt.ok) {
    if (receipt.timedOut) { tapeout.status = "waiting"; tapeout.waiting = { hash: receipt.hash, label, timedOut: true, message: receipt.reason }; }
    else { tapeout.status = "refused"; tapeout.refusal = receipt.reason; tapeout.refusalCode = receipt.final ? "failed" : "receipt"; tapeout.plan = undefined; tapeout.waiting = undefined; }
    updateTapeout(); return;
  }
  tapeout.completed.push({ label, hash: receipt.hash }); tapeout.waiting = undefined;
  if (receipt.kind === "tapeout" && receipt.circuitId !== undefined) { await completeTapeout(receipt.circuitId.toString(), receipt.hash, token); return; }
  tapeout.status = "idle"; tapeout.plan = undefined; updateTapeout();
  const plan = await executor.planAfter({ compiled: compiled.compiled, account, walletChainId: state.wallet.chainId }, Number(receipt.blockNumber));
  if (token !== tapeoutToken) return;
  applyPlan(plan); updateTapeout();
}

async function completeTapeout(circuitId: string, hash: string, token: number): Promise<void> {
  const compiled = state.compiled; const account = state.wallet.account;
  if (compiled === undefined || account === undefined) return;
  const sha = compiled.payload.payloadHash;
  const source = compiled.source.length <= MAX_SHARED_SOURCE_CHARS ? compiled.source : undefined;
  rememberMyCircuit({ id: circuitId, name: compiled.compiled.machine.name, payloadSha256: sha, owner: account, tx: hash, date: new Date().toISOString(), ...(source === undefined ? {} : { source }) });
  tapeout.status = "done"; tapeout.plan = undefined; tapeout.waiting = undefined; tapeout.done = { circuitId, hash, owner: account, payloadSha256: sha, ...(source === undefined ? {} : { source }), verifying: true };
  updateTapeout();
  await verifyDone(token);
}

async function verifyDone(token: number): Promise<void> {
  const executor = tapeoutExecutor; const target = verificationTarget(); const done = tapeout.done;
  if (executor === undefined || target === undefined || done === undefined) return;
  done.verifying = true; updateTapeout();
  const verification = await executor.verifyNewCircuit(done.circuitId, target);
  if (token !== tapeoutToken || tapeout.done !== done) return;
  done.verification = verification; done.verifying = false; updateTapeout();
}

async function runTapeoutStep(): Promise<void> {
  const executor = tapeoutExecutor; const plan = tapeout.plan; const provider = state.wallet.provider; const step = plan?.steps[0];
  if (executor === undefined || plan === undefined || provider === undefined || step === undefined || tapeout.status !== "ready") return;
  const gate = tapeoutGate(state.exhaustive, state.compiled?.compiled.hash);
  if (!gate.open) { tapeout.status = "idle"; tapeout.plan = undefined; tapeout.note = undefined; updateTapeout(); return; }
  const token = tapeoutToken;
  tapeout.status = "checking"; tapeout.note = undefined; updateTapeout();
  const sent = await executor.sendStep(provider, plan, step, (phase) => { if (token === tapeoutToken) { tapeout.status = phase; updateTapeout(); } });
  if (token !== tapeoutToken) return;
  if (sent.status === "cancelled") { tapeout.status = "ready"; tapeout.note = sent.message; updateTapeout(); return; }
  if (sent.status === "refused") { tapeout.status = "refused"; tapeout.refusal = sent.reason; tapeout.refusalCode = sent.code === "pending" ? "pending" : sent.code; updateTapeout(); return; }
  tapeout.status = "waiting"; tapeout.waiting = { hash: sent.hash, label: step.label, timedOut: false }; updateTapeout();
  await followPending(sent.record, token);
}

async function switchNetwork(): Promise<void> {
  const provider = state.wallet.provider;
  if (provider === undefined || tapeout.switching) return;
  tapeout.switching = true; tapeout.switchError = undefined; updateTapeout();
  const result = await switchToXLayer(provider);
  tapeout.switching = false;
  if (!result.ok) tapeout.switchError = result.reason;
  state.wallet = await readWallet(state.wallet); state.quote = undefined; render();
  if (state.wallet.status === "ready") void refreshTapeoutPlan();
}

function onTapeoutWalletChange(): void {
  if (!TAPEOUT_ENABLED || tapeoutInFlight()) return;
  if (state.wallet.status === "ready") void refreshTapeoutPlan();
  else { tapeoutToken += 1; tapeout.status = "idle"; tapeout.plan = undefined; tapeout.done = undefined; tapeout.waiting = undefined; tapeout.completed = []; updateTapeout(); }
}

async function copyText(text: string): Promise<boolean> {
  try { if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall through to the older method */ }
  try {
    const area = document.createElement("textarea"); area.value = text; area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0";
    document.body.appendChild(area); area.select(); const copied = document.execCommand("copy"); area.remove(); return copied;
  } catch { return false; }
}

/** A link that opens the workspace with this rule loaded and checked against the circuit. The source travels in the link, base64url encoded. */
async function copyVerificationLink(button: HTMLButtonElement): Promise<void> {
  const key = button.dataset.copyLink;
  const entry = key === "done" ? undefined : readMyCircuits().find((candidate) => candidate.tx === key);
  const target = key === "done" ? (tapeout.done === undefined ? undefined : { id: tapeout.done.circuitId, source: tapeout.done.source }) : entry === undefined ? undefined : { id: entry.id, source: entry.source };
  if (target === undefined || target.source === undefined) return;
  const link = verificationLink(`${window.location.origin}${window.location.pathname}${window.location.search}`, target.id, target.source);
  const original = button.textContent ?? "Copy verification link";
  const copied = await copyText(link);
  button.textContent = copied ? "Link copied" : "Copy failed: select the link below";
  if (!copied && button.parentElement !== null && button.parentElement.querySelector(".link-fallback") === null) { const input = document.createElement("input"); input.className = "link-fallback"; input.readOnly = true; input.value = link; input.setAttribute("aria-label", "Verification link"); button.parentElement.appendChild(input); input.select(); }
  window.setTimeout(() => { if (button.isConnected && copied) button.textContent = original; }, 2000);
}

function bindTapeoutEvents(): void {
  const on = (selector: string, handler: () => void): void => { document.querySelector<HTMLButtonElement>(selector)?.addEventListener("click", handler); };
  document.querySelectorAll<HTMLButtonElement>("[data-copy-link]").forEach((button) => button.addEventListener("click", () => void copyVerificationLink(button)));
  on("#tapeout-connect", () => void connectWallet());
  on("#tapeout-switch", () => void switchNetwork());
  on("#tapeout-next", () => void runTapeoutStep());
  on("#tapeout-refresh", () => void refreshTapeoutPlan());
  on("#tapeout-verify", () => void verifyDone(tapeoutToken));
  on("#tapeout-again", () => { const account = state.wallet.account; const compiled = state.compiled; if (account && compiled) tapeoutExecutor?.clearConfirmed(account, compiled.payload.payloadHash); tapeout.done = undefined; tapeout.completed = []; void refreshTapeoutPlan(); });
  on("#tapeout-discard", () => { const account = state.wallet.account; const compiled = state.compiled; if (account && compiled) tapeoutExecutor?.discardInterruptedSigning(account, compiled.payload.payloadHash); void refreshTapeoutPlan(); });
  on("#tapeout-recheck", () => { const account = state.wallet.account; const compiled = state.compiled; const record = account && compiled ? tapeoutExecutor?.pending(account, compiled.payload.payloadHash) : undefined; if (record) { tapeout.waiting = { hash: record.hash ?? "", label: stepLabelFor(record), timedOut: false }; updateTapeout(); void followPending(record, tapeoutToken); } });
  on("#tapeout-release", () => { const account = state.wallet.account; const compiled = state.compiled; if (!account || !compiled || tapeoutExecutor === undefined) return; void tapeoutExecutor.releaseDroppedPending(account, compiled.payload.payloadHash).then((result) => { if (result.released) void refreshTapeoutPlan(); else if (tapeout.waiting) { tapeout.waiting.message = result.reason; updateTapeout(); } }); });
}

function footer(): string { return `<footer><span class="foot-left"><span>GateX</span>${extLink("https://github.com/AjKadri/GateX", "GitHub")}${extLink(`${EXPLORER}/address/${browserDeployment.processor}`, "Processor on X Layer")}${extLink("https://github.com/AjKadri/GateX/tree/main/docs", "Docs")}</span><span>${TAPEOUT_ENABLED ? "Verified circuit compiler · caller-owned state" : "Read-only product verification · caller-owned state"}</span></footer>`; }
function render(): void {
  if (!app) return;
  const editor = document.activeElement instanceof HTMLTextAreaElement && document.activeElement.id === "source-editor" ? document.activeElement : undefined;
  const caret = editor === undefined ? undefined : { start: editor.selectionStart, end: editor.selectionEnd, scroll: editor.scrollTop };
  const current = route(); app.innerHTML = current === "/" ? landing() : current === "/workspace" ? workspace() : current === "/circuits" ? circuitsPage() : evidence(); bindEvents();
  if (caret !== undefined) { const next = document.querySelector<HTMLTextAreaElement>("#source-editor"); if (next !== null) { next.focus({ preventScroll: true }); next.setSelectionRange(caret.start, caret.end); next.scrollTop = caret.scroll; } }
}

function bindEvents(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-example]").forEach((button) => button.addEventListener("click", () => { const key = button.dataset.example as ExampleKey; state.key = key; state.templateKey = undefined; state.sharedSource = false; state.source = EXAMPLES[key].source; state.compiled = undefined; state.restored = undefined; state.quote = undefined; state.quoteError = undefined; state.live = undefined; state.readback = undefined; state.binding = undefined; if (TAPEOUT_ENABLED) resetTapeout(); void compileCurrent(); }));
  const editor = document.querySelector<HTMLTextAreaElement>("#source-editor");
  editor?.addEventListener("input", () => { state.source = editor.value; if (TAPEOUT_ENABLED) resetTapeout(); state.compiled = undefined; state.restored = undefined; state.quote = undefined; state.quoteError = undefined; state.live = undefined; state.liveError = undefined; state.liveStatus = "PENDING"; state.readback = undefined; state.binding = undefined; state.diagnostics = []; if (TAPEOUT_ENABLED) updateTapeout(); window.clearTimeout(compileTimer); compileTimer = window.setTimeout(() => void compileCurrent(), 350); });
  document.querySelectorAll<HTMLButtonElement>("[data-template]").forEach((button) => button.addEventListener("click", () => { const template = TEMPLATES.find((candidate) => candidate.key === button.dataset.template); if (template === undefined) return; loadTemplate(template.key); }));
  document.querySelector<HTMLButtonElement>("#reset-source")?.addEventListener("click", () => { state.sharedSource = false; state.source = state.templateKey !== undefined ? TEMPLATES.find((template) => template.key === state.templateKey)?.source ?? EXAMPLES[state.key].source : EXAMPLES[state.key].source; state.quote = undefined; state.quoteError = undefined; if (TAPEOUT_ENABLED) resetTapeout(); void compileCurrent(); });
  document.querySelector<HTMLButtonElement>("#refresh-quote")?.addEventListener("click", () => void refreshQuote());
  document.querySelector<HTMLButtonElement>("#refresh-readback")?.addEventListener("click", () => void refreshReadback());
  document.querySelector<HTMLButtonElement>("#connect-wallet")?.addEventListener("click", () => void connectWallet());
  document.querySelector<HTMLButtonElement>("#disconnect-wallet")?.addEventListener("click", () => { state.wallet = { ...state.wallet, status: "disconnected", account: undefined, error: undefined }; state.quote = undefined; if (TAPEOUT_ENABLED) onTapeoutWalletChange(); render(); });
  document.querySelector<HTMLSelectElement>("#state-select")?.addEventListener("change", (event) => { state.selectedState = Number((event.target as HTMLSelectElement).value); state.live = undefined; state.liveError = undefined; render(); });
  document.querySelectorAll<HTMLInputElement>("[data-input]").forEach((input) => input.addEventListener("change", () => { const name = input.dataset.input; if (name) state.inputs[name] = input.checked; state.live = undefined; state.liveError = undefined; render(); }));
  document.querySelector<HTMLButtonElement>("#run-live")?.addEventListener("click", () => void runLive());
  document.querySelector<HTMLButtonElement>("#circuits-retry")?.addEventListener("click", () => { circuitsUi.status = "idle"; void loadCircuits(); });
  document.querySelector<HTMLButtonElement>("#circuits-more")?.addEventListener("click", () => void loadMoreCircuits());
  if (TAPEOUT_ENABLED) bindTapeoutEvents();
}
let compileTimer = 0;
/** Loads a source into the editor through the same path as typing: new source, everything derived from the old compile cleared, then a normal compile. */
function loadSourceText(source: string, options: { template?: string; shared?: boolean } = {}): void {
  const example = (Object.keys(EXAMPLES) as ExampleKey[]).find((key) => EXAMPLES[key].source.trim() === source.trim());
  const template = options.template ?? TEMPLATES.find((candidate) => candidate.source.trim() === source.trim())?.key;
  if (example !== undefined) { state.key = example; state.templateKey = undefined; state.sharedSource = false; } else { state.templateKey = template; state.sharedSource = options.shared === true && template === undefined; }
  state.source = source; state.compiled = undefined; state.restored = undefined; state.quote = undefined; state.quoteError = undefined; state.live = undefined; state.liveError = undefined; state.liveStatus = "PENDING"; state.readback = undefined; state.binding = undefined; state.diagnostics = [];
  if (TAPEOUT_ENABLED) resetTapeout();
  void compileCurrent();
}
function loadTemplate(key: string): void {
  const template = TEMPLATES.find((candidate) => candidate.key === key);
  if (template !== undefined) loadSourceText(template.source, { template: template.key });
}

// ---------------------------------------------------------------------------------------------------------------------
// Routes that read from the hash: #/workspace?circuit=N&src=..., and the Circuits page.

function routeEffects(): void {
  const current = route();
  if (current === "/workspace") applyHashParams();
  else if (current === "/circuits" && circuitsUi.status === "idle") void loadCircuits();
  else if (current === "/evidence" && (pricingUi.status === "idle" || pricingUi.status === "error")) void loadPricing();
}

function applyHashParams(): void {
  const raw = routeQuery().toString();
  if (raw === (state.appliedQuery ?? "")) return;
  state.appliedQuery = raw;
  const params = routeQuery();
  const circuit = parseCircuitParam(params.get("circuit"));
  const src = params.get("src");
  state.shareNotice = undefined;
  if (src !== null) {
    const decoded = decodeSource(src);
    if (decoded.ok) { state.shareNotice = "Loaded the rule from a shared link."; loadSourceText(decoded.source, { shared: true }); }
    else state.shareNotice = `The rule in that link could not be read (${decoded.reason}, limit ${MAX_SHARED_SOURCE_CHARS} characters), so it was ignored.`;
  }
  if (circuit === undefined) { state.circuitCheck = undefined; render(); return; }
  void loadCircuitCheck(circuit);
}

function circuitsDeps(block: { tag: string }): CircuitsDeps { return { lock: browserLock, processor: browserDeployment.processor, clients: browserClients, blockTag: block.tag }; }

async function loadCircuitCheck(id: string): Promise<void> {
  const check: CircuitCheckUi = { id, status: "loading" };
  state.circuitCheck = check; render();
  try {
    const quote = await readOnlyQuote();
    const record = await readCircuit(circuitsDeps(quote.block), BigInt(id));
    if (state.circuitCheck !== check) return;
    if (record === undefined) { check.status = "error"; check.error = `Circuit #${id} does not exist on the GateX processor.`; } else { check.status = "ready"; check.record = record; }
  } catch {
    if (state.circuitCheck !== check) return;
    check.status = "error"; check.error = `Could not read circuit #${id} from X Layer right now.`;
  }
  if (route() === "/workspace") render();
}

function circuitBanner(): string {
  const check = state.circuitCheck;
  if (check === undefined) return "";
  const head = `<strong>Checking this rule against circuit #${esc(check.id)}</strong>`;
  let tone = "neutral"; let body = "";
  if (check.status === "loading") body = "Reading the circuit from X Layer through two providers…";
  else if (check.status === "error") body = esc(check.error ?? "The circuit could not be read.");
  else if (check.record !== undefined) {
    const record = check.record; const compiled = state.compiled;
    if (!record.confirmed) body = `The providers did not agree about this circuit, so no match is claimed. ${esc(record.note ?? "")}`;
    else if (compiled === undefined) body = state.compiling ? "Compiling the rule…" : "Waiting for a valid rule to compile.";
    else {
      const result = checkAgainstCircuit(compiled.payload.payloadHash, record.payloadSha256, { compiled: compiled.payload.dimensions, onChain: record.dimensions });
      tone = result.matches ? "match" : "neutral";
      body = `<span class="banner-result">${esc(checkHeadline(result, check.id))}</span> <span class="banner-meta">Owner ${extLink(`${EXPLORER}/address/${record.owner}`, `${abbreviatedAccount(record.owner)} ↗`)} · ${extLink(`${EXPLORER}/address/${browserDeployment.processor}`, "Processor on X Layer ↗")}</span>`;
    }
  }
  return `<div class="circuit-banner ${tone}" role="status">${head}<span>${body}</span></div>`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Live pricing on the Evidence page (read-only quote, no wallet)

const pricingUi: { status: "idle" | "loading" | "ready" | "error"; quote?: ReadOnlyQuote } = { status: "idle" };

async function loadPricing(): Promise<void> {
  if (pricingUi.status === "loading") return;
  pricingUi.status = "loading"; if (route() === "/evidence") render();
  try { pricingUi.quote = await readOnlyQuote(); pricingUi.status = "ready"; } catch { pricingUi.quote = undefined; pricingUi.status = "error"; }
  if (route() === "/evidence") render();
}

function pricingLines(): string {
  if (pricingUi.status === "ready" && pricingUi.quote !== undefined) {
    const agent = EXAMPLES.agent.expected;
    const [cost, room] = pricingSentences(costOfSize(pricingUi.quote, BigInt(agent.nand), BigInt(agent.latch)), EXAMPLES.agent.label, BigInt(agent.nand), BigInt(agent.latch));
    return `<div class="pricing-live"><p>${esc(cost)}</p><p>${esc(room)}</p><small class="muted">Read from ${pricingUi.quote.providers.length} providers at block ${pricingUi.quote.block.number}.</small></div>`;
  }
  if (pricingUi.status === "error") return `<div class="pricing-live"><p class="muted">Live prices could not be read from X Layer just now. The unit price and cap above are fixed.</p></div>`;
  return `<div class="pricing-live"><p class="muted" role="status">Reading X Layer…</p></div>`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Circuits page

interface CircuitsUi { status: "idle" | "loading" | "ready" | "error"; error?: string; quote?: ReadOnlyQuote; top: bigint; cursor: bigint; rows: CircuitRecord[]; loadingMore: boolean; moreError?: string; known: KnownRule[]; knownReady: boolean }
const circuitsUi: CircuitsUi = { status: "idle", top: 0n, cursor: 0n, rows: [], loadingMore: false, known: [], knownReady: false };
let circuitsToken = 0;
const knownCache = new Map<string, KnownRule | null>();

async function compileKnown(source: string): Promise<KnownRule | null> {
  const cached = knownCache.get(source);
  if (cached !== undefined) return cached;
  let rule: KnownRule | null = null;
  try {
    const compiled = await compileMachine(source);
    const extracted = await extractTapeOutPayload(browserLock, compiled.bytes);
    rule = { name: compiled.machine.name, source, payloadSha256: extracted.payloadHash.toLowerCase().replace(/^0x/, ""), dimensions: extracted.dimensions };
  } catch { rule = null; }
  knownCache.set(source, rule);
  return rule;
}

/** Every source this browser knows: the two examples, the templates and the sources saved with circuits taped out here. */
async function ensureKnownRules(): Promise<void> {
  const sources = [...Object.values(EXAMPLES).map((example) => example.source), ...TEMPLATES.map((template) => template.source), ...readMyCircuits().flatMap((entry) => entry.source === undefined ? [] : [entry.source])];
  const unique = [...new Set(sources)];
  const compiled = await Promise.all(unique.map((source) => compileKnown(source)));
  circuitsUi.known = compiled.filter((rule): rule is KnownRule => rule !== null);
  circuitsUi.knownReady = true;
  if (route() === "/circuits") render();
}

async function loadCircuits(): Promise<void> {
  if (circuitsUi.status === "loading") return;
  circuitsToken += 1; const token = circuitsToken;
  Object.assign(circuitsUi, { status: "loading", error: undefined, rows: [], top: 0n, cursor: 0n, moreError: undefined, loadingMore: false });
  if (route() === "/circuits") render();
  void ensureKnownRules();
  try {
    const quote = await readOnlyQuote();
    const deps = circuitsDeps(quote.block);
    const count = await readCircuitCount(deps);
    const page = await readCircuitsPage(deps, count.top);
    if (token !== circuitsToken) return;
    Object.assign(circuitsUi, { status: "ready", quote, top: count.top, cursor: page.nextCursor, rows: page.rows });
  } catch (error) {
    if (token !== circuitsToken) return;
    circuitsUi.status = "error"; circuitsUi.error = error instanceof Error ? error.message : String(error);
  }
  if (route() === "/circuits") render();
}

async function loadMoreCircuits(): Promise<void> {
  const quote = circuitsUi.quote;
  if (quote === undefined || circuitsUi.loadingMore || circuitsUi.cursor < 1n) return;
  const token = circuitsToken;
  circuitsUi.loadingMore = true; circuitsUi.moreError = undefined; if (route() === "/circuits") render();
  try {
    const page = await readCircuitsPage(circuitsDeps(quote.block), circuitsUi.cursor);
    if (token !== circuitsToken) return;
    circuitsUi.rows = [...circuitsUi.rows, ...page.rows]; circuitsUi.cursor = page.nextCursor;
  } catch (error) {
    if (token !== circuitsToken) return;
    circuitsUi.moreError = error instanceof Error ? error.message : String(error);
  }
  circuitsUi.loadingMore = false;
  if (route() === "/circuits") render();
}

function circuitCard(row: CircuitRecord): string {
  const head = `<div class="circuit-card-head"><strong>#${esc(row.id)}</strong>${row.confirmed ? badge("TWO PROVIDERS AGREE", "muted") : badge("UNCONFIRMED", "amber")}</div>`;
  if (row.unreadable) return `<article class="panel circuit-card unconfirmed">${head}<p class="muted">${esc(row.note ?? "This circuit could not be read.")}</p></article>`;
  const dims = row.dimensions;
  const gates = row.nand !== undefined && row.latch !== undefined ? `${row.nand} NAND · ${row.latch} LATCH` : `${dims.gateCount} records`;
  const known = matchKnownRule(row, circuitsUi.known);
  const matchLine = !row.confirmed ? `<div class="match-line none">No match is claimed while the providers disagree.</div>`
    : known !== undefined ? `<div class="match-line ok"><span class="status-icon passed">✓</span><span>Matches ${esc(known.name)} — bytes identical</span><a class="text-link" href="${esc(verificationLink("", row.id, known.source))}">Open rule</a></div>`
    : circuitsUi.knownReady ? `<div class="match-line none"><span>Rule not known to this browser</span><a class="text-link" href="#/workspace?circuit=${esc(row.id)}">Check a rule against it</a></div>`
    : `<div class="match-line none"><span>Checking known rules…</span></div>`;
  return `<article class="panel circuit-card ${row.confirmed ? "" : "unconfirmed"}">${head}${row.note ? `<p class="circuit-note">${esc(row.note)}</p>` : ""}<div class="circuit-facts"><div><small>Owner</small>${extLink(`${EXPLORER}/address/${row.owner}`, `${abbreviatedAccount(row.owner)} ↗`, "text-link")}</div><div><small>Gates</small><code>${esc(gates)}</code></div><div><small>Dimensions</small><code>(${dims.nIn}, ${dims.nOut}, ${dims.nState}, ${dims.gateCount})</code></div><div><small>Payload SHA-256</small><code>${esc(shortHash(row.payloadSha256))}</code></div></div>${matchLine}</article>`;
}

function circuitsPage(): string {
  const ui = circuitsUi;
  const quote = ui.quote;
  const format = (value: bigint | number): string => value.toLocaleString("en-US");
  const stats = ui.status === "ready" && quote !== undefined ? `<div class="circuit-stats">${proofStat(format(ui.top), "circuits")}${proofStat(format(distinctOwners(ui.rows)), ui.rows.length < Number(ui.top) ? `owners in the newest ${ui.rows.length}` : "distinct owners")}${proofStat(`${format(quote.minted)} of ${format(quote.cap)}`, "transistors minted")}</div>` : "";
  const skeleton = `<div class="circuit-list-grid" aria-hidden="true">${[0, 1, 2].map(() => `<div class="panel circuit-card skeleton"><span></span><span></span><span></span></div>`).join("")}</div>`;
  const body = ui.status === "idle" || ui.status === "loading" ? `<p class="muted reading" role="status">Reading X Layer…</p>${skeleton}`
    : ui.status === "error" ? `<section class="panel error-panel"><div class="inline-error"><strong>UNAVAILABLE</strong><span>Could not read the circuit list from X Layer.</span></div><small class="muted">${esc(ui.error ?? "")}</small><div class="tapeout-actions"><button class="button primary small-button" id="circuits-retry">Retry</button></div></section>`
    : ui.rows.length === 0 ? `<section class="panel"><p class="muted">No circuits have been manufactured on this processor yet.</p></section>`
    : `<div class="circuit-list-grid">${ui.rows.map(circuitCard).join("")}</div><div class="circuits-foot"><span class="muted">Showing ${ui.rows.length} of ${format(ui.top)}, newest first. Read from two providers at block ${quote?.block.number ?? "?"}.</span>${ui.cursor >= 1n ? `<button class="button secondary small-button" id="circuits-more" ${ui.loadingMore ? "disabled" : ""}>${ui.loadingMore ? "Reading X Layer…" : "Load more"}</button>` : ""}</div>${ui.moreError ? `<div class="inline-error"><strong>NOT LOADED</strong><span>${esc(ui.moreError)}</span></div>` : ""}`;
  return `${nav("/circuits")}<main class="page circuits"><section class="page-heading"><div><div class="eyebrow">CIRCUITS / READ LIVE</div><h1>Circuits on the GateX processor.</h1><p>Every circuit here was manufactured from GTX transistors. Anyone can add one.</p></div><a class="button primary" href="#/workspace">Tape out your own <span>↗</span></a></section>${stats}${body}</main>${footer()}`;
}

async function refreshQuote(): Promise<void> { state.quoteLoading = true; state.quoteError = undefined; render(); try { state.quote = await readOnlyQuote(state.wallet.account); } catch (error) { state.quote = undefined; state.quoteError = error instanceof Error ? error.message : String(error); } finally { state.quoteLoading = false; render(); } }
async function connectWallet(): Promise<void> { state.wallet = await requestOkxAccounts(state.wallet); if (state.wallet.status === "ready") { try { state.quote = await readOnlyQuote(state.wallet.account); } catch (error) { state.quote = undefined; state.quoteError = error instanceof Error ? error.message : String(error); } } render(); if (TAPEOUT_ENABLED && state.wallet.status === "ready") void refreshTapeoutPlan(); }
async function refreshReadback(): Promise<void> { const compiled = state.compiled; if (!artifactEligible()) return; state.readbackLoading = true; state.readbackError = undefined; render(); try { state.readback = await readBoundCircuit(compiled?.definition.circuitId ?? "", compiled?.payload.payloadHash ?? ""); state.binding = bindingForCurrent(state.readback); if (!state.binding.liveReady) { state.readbackError = state.binding.detail; state.liveStatus = state.binding.status; } else state.liveStatus = "PENDING"; state.live = undefined; state.liveError = undefined; } catch (error) { state.readback = undefined; state.readbackError = error instanceof Error ? error.message : String(error); state.binding = bindingForCurrent(); state.liveStatus = error instanceof Error && "status" in error ? (error as { status: VerificationStatus }).status : "UNAVAILABLE"; } finally { state.readbackLoading = false; render(); } }
async function runLive(): Promise<void> { if (state.compiled === undefined || state.binding?.liveReady !== true || state.readback === undefined) return; state.liveLoading = true; state.liveError = undefined; render(); try { const machine = state.compiled.compiled.machine; const mask = machine.inputs.reduce((result, input, index) => result | (state.inputs[input.name] ? 1 << index : 0), 0); state.live = await readLiveStep(state.compiled.definition.circuitId, new Uint8Array([state.selectedState]), inputBytes(state.compiled.compiled, state.inputs)); const local = localStep(state.compiled.compiled, state.selectedState, mask); const localState = formatStateBytes(state.compiled.compiled, local.nextStateBytes); const liveState = formatStateBytes(state.compiled.compiled, state.live.nextState); const localOutput = formatBytes(local.outputBytes); const liveOutput = formatBytes(state.live.outputs); if (localState !== liveState || localOutput !== liveOutput) state.live.mismatches.push(`AST/local mismatch: local ${localState}/${localOutput}, live ${liveState}/${liveOutput}`); state.liveStatus = state.live.mismatches.length === 0 ? "PASSED" : "FAILED"; if (state.liveStatus === "PASSED") { const session: BrowserSession = { artifactDigest: state.compiled.compiled.hash, chainId: browserLock.chainId, processor: browserDeployment.processor, circuitId: state.compiled.definition.circuitId, sourceDigest: state.compiled.sourceDigest, activeState: liveState, history: [{ state: stateName(state.compiled.compiled, state.selectedState), inputs: { ...state.inputs }, localNext: localState, localOutput, origin: "LIVE X LAYER", recordedAt: new Date().toISOString() }] }; upsertSession(session); state.restored = session; } } catch (error) { state.live = undefined; state.liveStatus = error instanceof Error && "status" in error ? (error as { status: VerificationStatus }).status : "UNAVAILABLE"; state.liveError = error instanceof Error ? error.message : String(error); } finally { state.liveLoading = false; render(); } }
async function boot(root: HTMLElement): Promise<void> {
  root.innerHTML = `${nav("/")}<main class="page loading-page"><div class="loading">Loading GateX…</div></main>`;
  installEip6963Discovery();
  state.wallet = await readWallet(discoverOkxProvider());
  bindProviderEvents(state.wallet, (next) => { state.wallet = next; state.quote = undefined; state.quoteError = WALLET_CHANGED_NOTICE; render(); onTapeoutWalletChange(); });
  window.addEventListener("hashchange", () => { render(); routeEffects(); });
  render();
  const watchdog = window.setTimeout(() => {
    if (state.compiling) {
      state.compiling = false;
      state.diagnostics = [{ code: "BROWSER_RUNTIME", message: TAPEOUT_ENABLED ? "The browser compiler did not settle." : "The browser compiler did not settle. The workspace remains read-only.", location: "runtime" }];
      render();
    }
  }, 5000);
  try { state.compiled = await compileExample("agent"); startExhaustive(); state.inputs = Object.fromEntries(state.compiled.compiled.machine.inputs.map((input) => [input.name, false])); state.binding = bindingForCurrent(); const restored = readSessions().find((candidate) => sessionKey(candidate) === sessionKey({ artifactDigest: state.compiled?.compiled.hash ?? "", chainId: browserLock.chainId, processor: browserDeployment.processor, circuitId: state.compiled?.definition.circuitId ?? "" }) && candidate.sourceDigest === state.compiled?.sourceDigest); state.restored = restored === undefined ? undefined : { ...restored, history: restored.history.map((entry) => ({ ...entry, origin: "LOCAL SIMULATION" as const })) }; if (artifactEligible()) void refreshReadback(); }
  catch (error) { state.diagnostics = diagnosticFromError(error, state.source); }
  finally { window.clearTimeout(watchdog); }
  state.compiling = false;
  render();
  if (TAPEOUT_ENABLED && state.compiled !== undefined) scheduleTapeoutPlan(0);
  routeEffects();
}

export { compileMachine, readSessions, sessionKey };
