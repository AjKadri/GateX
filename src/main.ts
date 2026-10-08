import "./style.css";
import { compileMachine } from "./compiler/compiler.js";
import { diagnosticFromError, route, routeQuery, type Diagnostic } from "./app/ui-state.js";
import { AGENT_APPROVAL_SOURCE } from "./examples/agentApproval.js";
import { browserClients, browserDeployment, browserLock, readBoundCircuit, readLiveStep, readOnlyQuote, weiToOkb, type LiveStepResult, type ReadOnlyQuote } from "./app/protocol.js";
import { EXAMPLES, compileExample, inputBytes, inputMaskFromRecord, localStep, outputNames, bytesLabel, stateName, type CompiledExample, type ExampleKey } from "./app/model.js";
import { readSessions, sessionKey, upsertSession, type BrowserSession } from "./app/session.js";
import { assessGasInclusiveSufficiency, liveVerificationStatus, verifyArtifactBinding, type ArtifactBindingResult, type CircuitBindingReadback, type VerificationStatus } from "./app/binding.js";
import { abbreviatedAccount, bindProviderEvents, discoverOkxProvider, installEip6963Discovery, readWallet, requestOkxAccounts, type WalletState, connectOkx, revokeOkx } from "./app/wallet.js";
import type { CompiledMachine } from "./compiler/types.js";
import { TapeoutExecutor, safetyLimitViolation, switchToXLayer, type PendingRecord, type PlanResult, type TapeoutPlan, type VerificationResult, type VerificationTarget } from "./app/tapeout.js";
import { browserTapeoutDeps } from "./app/tapeout-deps.js";
import { readMyCircuits, rememberMyCircuit } from "./app/my-circuits.js";
import { TEMPLATES } from "./examples/templates.js";
import { checkAgainstCircuit, checkHeadline, distinctOwners, matchKnownRule, readCircuit, readCircuitCount, readCircuitsPage, type CircuitRecord, type CircuitsDeps, type KnownRule } from "./app/circuits.js";
import { MAX_SHARED_SOURCE_CHARS, decodeSource, parseCircuitParam, verificationLink } from "./app/share.js";
import { extractTapeOutPayload } from "./protocol/wire.js";
import { byteLength, encodeInputMask } from "./compiler/encoding.js";
import { RuleGateClient, isDeployed, stateValue, RULEGATE, type OpenResult, type RuleGateFailure, type SessionRecord, type SessionView, type StepResult } from "./app/rulegate.js";
import { browserRuleGateDeps } from "./app/rulegate-deps.js";
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
  walletMenuOpen?: boolean;
  walletConnecting?: boolean;
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
let walletNotice: string | undefined;
const state: UiState = { key: "agent", source: AGENT_APPROVAL_SOURCE.trim(), diagnostics: [], compiling: true, selectedState: 0, inputs: {}, liveStatus: "PENDING", liveLoading: false, readbackLoading: false, quoteLoading: false, wallet: { status: "unavailable" } };

if (app) void boot(app);

function esc(value: string): string { return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] as string); }
function shortHash(value: string): string { return `${value.slice(0, 10)}…${value.slice(-8)}`; }
function walletControl(): string {
  const w = state.wallet;
  if (w.status === "unavailable") return `<div class="wallet-control"><button class="button secondary wallet-btn" type="button" disabled title="OKX Wallet was not detected in this browser.">No<span class="wallet-long"> OKX</span> Wallet</button></div>`;
  if (state.walletConnecting === true) return `<div class="wallet-control"><button class="button secondary wallet-btn" type="button" disabled>Check your wallet…</button></div>`;
  if (w.account === undefined || (w.status !== "ready" && w.status !== "wrong-network")) return `<div class="wallet-control"><button class="button secondary wallet-btn wallet-connect" id="header-connect" type="button">Connect<span class="wallet-long"> wallet</span></button></div>`;
  const ok = w.status === "ready"; const full = w.account; const short = abbreviatedAccount(full); const open = state.walletMenuOpen === true;
  const menu = open ? `<div class="wallet-menu" role="menu">${ok ? "" : `<button class="wallet-item" id="header-switch" type="button" role="menuitem">Switch to X Layer</button>`}<code class="wallet-addr">${esc(full)}</code><a class="wallet-item" role="menuitem" href="https://www.oklink.com/xlayer/address/${esc(full)}" target="_blank" rel="noopener">View on explorer ↗</a><button class="wallet-item" id="header-disconnect" type="button" role="menuitem">Disconnect</button></div>` : "";
  return `<div class="wallet-control"><button class="button secondary wallet-btn wallet-account" id="header-wallet" type="button" aria-expanded="${open}" aria-haspopup="menu" aria-label="Wallet ${esc(full)}${ok ? "" : ", wrong network"}"><span class="wallet-dot ${ok ? "ok" : "warn"}"></span><span class="wallet-long">${esc(short)}</span><span class="wallet-short">${esc(full.slice(-4))}</span></button>${menu}</div>`;
}
const WALLET_CHOICE_KEY = "gatex.wallet.connected";
function rememberedConnection(): boolean { try { return localStorage.getItem(WALLET_CHOICE_KEY) === "1"; } catch { return false; } }
function rememberConnection(on: boolean): void { try { if (on) localStorage.setItem(WALLET_CHOICE_KEY, "1"); else localStorage.removeItem(WALLET_CHOICE_KEY); } catch { /* storage unavailable */ } }
/** The wallet may still have this site approved; GateX only treats it as connected after the visitor chose Connect. */
function applyConnectionChoice(next: WalletState): WalletState { return rememberedConnection() || next.account === undefined ? next : { ...next, account: undefined, status: next.status === "unavailable" ? next.status : "disconnected", error: undefined }; }
function disconnectWallet(): void { rememberConnection(false); void revokeOkx(state.wallet); state.walletMenuOpen = false; state.wallet = { ...state.wallet, status: "disconnected", account: undefined, error: undefined }; state.quote = undefined; if (TAPEOUT_ENABLED) onTapeoutWalletChange(); render(); }

function nav(active: string): string { return `<header class="topbar"><a class="brand" href="#/"><svg class="brand-logo" viewBox="0 0 64 64" fill="none" width="26" height="26" aria-hidden="true"><path d="M48 16H16v32h32V32H37" stroke="currentColor" stroke-width="7"/><circle cx="31" cy="32" r="4.5" stroke="currentColor" stroke-width="3.5"/></svg><span class="brand-word">Gate<span class="brand-x">X</span></span></a><nav aria-label="Primary"><a class="nav-link ${active === "/" ? "active" : ""}" href="#/">Overview</a><a class="nav-link ${active === "/workspace" ? "active" : ""}" href="#/workspace">Workspace</a><a class="nav-link ${active === "/circuits" ? "active" : ""}" href="#/circuits">Circuits</a><a class="nav-link ${active === "/sessions" ? "active" : ""}" href="#/sessions">Sessions</a><a class="nav-link ${active === "/evidence" ? "active" : ""}" href="#/evidence">Evidence</a><a class="nav-link ${active === "/docs" ? "active" : ""}" href="#/docs">Docs</a></nav><span class="network-pill"><span class="live-dot"></span>X Layer / 196</span>${walletControl()}</header>${walletNoticeBar()}`; }
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
const overviewUi: { sessions?: bigint; started: boolean } = { started: false };
/** Loaded once per page load; any failure leaves the dash in place. */
function loadOverviewStats(): void {
  if (overviewUi.started) return;
  overviewUi.started = true;
  if (circuitsUi.status === "idle") void loadCircuits();
  if (ruleGate !== undefined && isDeployed()) void ruleGate.listSessions({ newest: 1 }).then((list) => { overviewUi.sessions = list.count; if (route() === "/") render(); }).catch(() => undefined);
}
function overviewStats(): string {
  const ready = circuitsUi.status === "ready";
  const format = (value: bigint | number): string => value.toLocaleString("en-US");
  const owners = ready ? `${format(distinctOwners(circuitsUi.rows))}${circuitsUi.rows.length < Number(circuitsUi.top) ? "+" : ""}` : "–";
  const cell = (href: string, value: string, label: string): string => `<a class="overview-stat" href="${href}">${proofStat(value, label)}</a>`;
  return `<section class="overview-stats" aria-label="Live counts from X Layer">${cell("#/circuits", ready ? format(circuitsUi.top) : "–", "Circuits on X Layer")}${cell("#/circuits", owners, "Distinct owners")}${cell("#/sessions", overviewUi.sessions === undefined ? "–" : format(overviewUi.sessions), "RuleGate sessions")}${cell("#/evidence", ready && circuitsUi.quote !== undefined ? format(circuitsUi.quote.minted) : "–", "Transistors minted")}</section>`;
}
function landing(): string {
  const compiled = state.key === "agent" ? state.compiled : undefined;
  const expected = EXAMPLES.agent.expected;
  const machine = compiled?.compiled.machine;
  const declaredTransitions = (AGENT_APPROVAL_SOURCE.match(/^\s*\w+\s*->/gm) ?? []).length; // machine.transitions is the validator's expanded list, not the written rules
  const pipeline = `<aside class="panel pipeline"><div class="panel-label">HOW ONE RULE BECOMES A CIRCUIT</div><div class="status-list">${pipelineRow("Written", `AgentApproval: ${machine?.states.length ?? 4} states, ${declaredTransitions} transitions, ${machine?.inputs.length ?? 6} inputs`)}${pipelineRow("Compiled", `${compiled?.compiled.nandCount ?? expected.nand} NAND gates and ${compiled?.compiled.latchCount ?? expected.latch} latches, same bytes every time`)}${pipelineRow("Checked", `${expected.cases} of ${expected.cases} state and input cases match the source`)}${pipelineRow("On X Layer", `Circuit ${EXAMPLES.agent.circuitId}, read back and matched by two providers`)}${pipelineRow("Yours next", "Tape out your own rule from your wallet, then share a link anyone can verify", true)}</div></aside>`;
  return `${nav("/")}<main class="page landing"><section class="hero"><div class="hero-text"><div class="eyebrow">VERIFIED CIRCUIT COMPILER <span>•</span> X LAYER / 196</div><h1>Readable rules,<br><span>verified circuits.</span></h1><p class="hero-copy">Write an approval workflow as a state machine. GateX compiles it to a TapeOut circuit on X Layer and proves the circuit does what the source says.</p><div class="hero-actions"><a class="button primary" href="#/workspace">Open workspace <span>↗</span></a><a class="text-link" href="#/circuits">See all circuits</a></div><div class="hero-proof"><span class="pulse-check">✓</span><span><strong>AgentApproval</strong> is the flagship proof</span><span class="divider"></span><span>${expected.cases} / ${expected.cases} cases matched</span></div></div>${pipeline}</section>${overviewStats()}<section class="overview-grid"><article class="panel dark-panel flagship"><div class="panel-label">FLAGSHIP EXAMPLE <span>${badge("LIVE REFERENCE", "blue")}</span></div><h2>AgentApproval</h2><p class="muted">A small approval flow with explicit human and scope checks, compiled through the same generic GateX language path.</p>${compiled ? machineSummary(compiled) : "<div class=loading>Compiling the example…</div>"}<div class="flagship-foot"><div class="small-rule"></div><div class="state-line">${compiled ? compiled.compiled.machine.states.map((item) => `<span>${esc(item.name)}</span>`).join("<i>→</i>") : "IDLE → REQUESTED → APPROVED → USED"}</div></div></article><article class="panel source-panel"><div class="panel-label">SOURCE DSL <span>${badge("SOURCE VALID", "green")}</span></div>${sourceCard(AGENT_APPROVAL_SOURCE.trim())}<a class="text-link" href="#/workspace">Edit in workspace ↗</a></article></section><section class="callout landing-callout"><div class="callout-icon">◎</div><div><strong>Where state lives</strong><p>TapeOut computes each transition without storing it. In the workspace the state stays in your browser. In a RuleGate session it is stored on X Layer and only the wallet that opened the session can advance it. <a class="text-link" href="#/sessions">Open a session ↗</a></p></div></section></main>${footer()}`;
}

function compilePanel(): string { const compiled = state.compiled; if (state.compiling) return `<section class="panel"><div class="loading">Compiling through the generic GateX path…</div></section>`; if (compiled === undefined) return `<section class="panel error-panel"><div class="panel-label">COMPILER DIAGNOSTICS ${badge("BLOCKED", "amber")}</div><div class="diagnostics">${state.diagnostics.map((item) => `<div class="diagnostic"><code>${esc(item.code)}</code><span>${esc(item.message)}</span><small>${esc(item.location)}</small></div>`).join("")}</div><p class="muted">Invalid source cannot be compiled into a circuit.${TAPEOUT_ENABLED ? "" : " This workspace is read-only."}</p></section>`; const expected = compiled.definition.expected; const sourceExact = state.source.trim() === compiled.definition.source.trim(); return `<section class="panel" id="ws-compile"><div class="panel-label">COMPILE RESULT <span>${badge("DETERMINISTIC", "green")}</span></div><div class="compile-head"><div><h3>${sourceExact ? `${esc(compiled.definition.label)} <span class="id-chip">circuit ${compiled.definition.circuitId}</span>` : `${esc(compiled.compiled.machine.name)} <span class="id-chip">not manufactured</span>`}</h3><p class="muted">Compiled the same way every time and checked against the source for every case.</p></div><span class="big-check">✓</span></div>${machineSummary(compiled)}${checkedLine()}<details class="tech-details"><summary>Technical details</summary><div class="kv-grid"><div><small>State encoding</small><code>${compiled.compiled.machine.stateBits} bits · LSB-first</code></div><div><small>Local container</small><code>${compiled.compiled.bytes.length} bytes · ${shortHash(compiled.compiled.hash)}</code></div><div><small>TapeOut payload</small><code>${compiled.payload.payload.length} bytes · ${shortHash(compiled.payload.payloadHash)}</code></div><div><small>Dimensions</small><code>(${compiled.payload.dimensions.nIn}, ${compiled.payload.dimensions.nOut}, ${compiled.payload.dimensions.nState}, ${compiled.payload.dimensions.gateCount})</code></div></div><div class="hash-line"><span>Local SHA-256</span><code>${esc(compiled.compiled.hash)}</code></div><div class="hash-line"><span>Payload SHA-256</span><code>${esc(compiled.payload.payloadHash)}</code></div></details><p class="compile-note">${sourceExact && compiled.artifactMatch && compiled.deterministic && compiled.compiled.bytes.length === expected.localBytes ? "Matches the circuit manufactured on X Layer." : "Not on X Layer yet. You can tape it out below."}</p></section>`; }
function verificationPanel(): string { const compiled = state.compiled; const sourceExact = compiled !== undefined && state.source.trim() === compiled.definition.source.trim(); const exact = compiled?.artifactMatch === true && compiled.deterministic && sourceExact; const bindingStatus = state.binding?.status ?? "PENDING"; const readbackNotRun = state.readback === undefined && state.readbackError === undefined && bindingStatus === "PENDING"; const newRule = compiled !== undefined && !artifactEligible(); const readbackStatus: RowStatus = newRule ? "NOT RUN" : state.readbackLoading ? "READING" : readbackNotRun ? "NOT RUN" : state.readbackError ? state.liveStatus : bindingStatus; const liveNotRun = state.live === undefined && state.liveError === undefined; const liveStatus: RowStatus = state.liveLoading ? "READING" : state.live ? liveVerificationStatus(state.readback, state.live.mismatches.length) : state.liveError ? state.liveStatus : "NOT RUN"; return `<section class="panel"><div class="panel-label">VERIFICATION CHAIN</div><div class="status-list">${statusRow("SOURCE VALID", compiled ? "PASSED" : "PENDING", compiled ? "The parser and validator passed the current source." : "Waiting for valid source.")}${statusRow("COMPILE VERIFIED", exact ? "PASSED" : compiled ? "NOT RUN" : "PENDING", exact ? "Gate counts and hashes match the manufactured circuit." : "This source is valid but differs from the manufactured circuit.")}${exhaustiveRow()}${exact ? statusRow("HISTORICAL MANUFACTURE", "PASSED", `Recorded manufacture evidence matches circuit ${compiled?.definition.circuitId}.`) : compiled ? statusRow("HISTORICAL MANUFACTURE", "NOT RUN", TAPEOUT_ENABLED && (() => { const gate = tapeoutGate(state.exhaustive, compiled?.compiled.hash); return gate.open || gate.kind !== "failed"; })() ? "Not manufactured yet — you can tape it out below" : "Not manufactured yet.") : statusRow("HISTORICAL MANUFACTURE", "STALE", "Recorded manufacture evidence is stale for this source.")}${statusRow("FRESH CIRCUIT READBACK", readbackStatus, newRule ? "Nothing on X Layer to read for this rule yet." : state.readbackLoading ? "Reading the circuit from X Layer through two providers…" : readbackNotRun ? (artifactEligible() ? "Not run yet. Use “1. Read circuit from X Layer” in the playground." : "Not run. Reset to the example source to read the circuit.") : state.binding?.detail ?? (state.readbackError ?? "A fresh circuit readback is required."))}${statusRow("LIVE CHAIN MATCH", liveStatus, state.live ? `${state.live.providers.length} providers at block ${state.live.block.number}.` : state.liveLoading ? "Comparing one live transition…" : state.liveError ?? (state.binding?.liveReady === true ? "Not run yet. Use “2. Compare live transition” in the playground." : "Not run yet. Do step 1 in the playground first."))}${statusRow("TAPEOUT SOURCE NOT INDEPENDENTLY VERIFIED", "warning", "GateX verified behaviour for every case it checked. It did not verify the deployed TapeOut contract source.")}</div></section>`; }
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
function stepBar(): string {
  const compiled = state.compiled;
  const mine = compiled === undefined ? undefined : readMyCircuits().find((entry) => entry.payloadSha256.toLowerCase() === compiled.payload.payloadHash.toLowerCase());
  const passed = compiled !== undefined && tapeoutGate(state.exhaustive, compiled.compiled.hash).open;
  const current = compiled === undefined ? 0 : !passed ? 1 : mine === undefined ? 2 : 3;
  const steps: Array<[string, string, string]> = [["Write", "#ws-editor", ""], ["Check", "#ws-compile", ""], ["Tape out", "#tapeout-region", ""], ["Run", "#tapeout-region", mine === undefined ? "" : `#/sessions?circuit=${mine.id}`]];
  const items = steps.map(([label, target, href], index) => {
    const cls = index < current ? "done" : index === current ? "current" : "future";
    const inner = `<span class="step-num">${index < current ? "✓" : index + 1}</span><span class="step-name">${label}</span>`;
    return href !== "" ? `<a class="step ${cls}" href="${esc(href)}">${inner}</a>` : `<button type="button" class="step ${cls}" data-step-scroll="${target}" ${index === current ? 'aria-current="step"' : ""}>${inner}</button>`;
  }).join("");
  return `<nav class="stepbar" aria-label="Workspace steps">${items}</nav>`;
}
function workspace(): string { const compiled = state.compiled; const selected = state.templateKey !== undefined || state.sharedSource === true ? "" : state.key === "agent" ? "AgentApproval" : "TinyApproval"; const templateRow = `<div class="template-row"><span class="template-label">Start from a template:</span>${TEMPLATES.map((template) => `<button class="template-button ${state.templateKey === template.key ? "active" : ""}" data-template="${esc(template.key)}" title="${esc(template.blurb)}">${esc(template.name)}</button>`).join("")}${state.templateKey !== undefined ? `<small class="template-note">${esc(TEMPLATES.find((template) => template.key === state.templateKey)?.blurb ?? "")}. Not on chain${TAPEOUT_ENABLED ? ": tape it out below to put it there" : ""}.</small>` : ""}</div>`; const restored = state.restored ? `<p class="local-history"><strong>LOCAL</strong> Restored history for circuit ${esc(state.restored.circuitId)}. It is not fresh live evidence.</p>` : ""; return `${nav("/workspace")}<main class="page workspace"><section class="page-heading"><div><div class="eyebrow">WORKSPACE</div><h1>Compile. Inspect. Compare.</h1><p>Edit the rule, compile it, and compare the result with the circuit on X Layer.</p></div></section>${stepBar()}<div class="example-tabs"><button class="tab ${selected === "AgentApproval" ? "active" : ""}" data-example="agent">AgentApproval <small>circuit 2</small></button><button class="tab ${selected === "TinyApproval" ? "active" : ""}" data-example="tiny">TinyApproval <small>circuit 1</small></button></div>${templateRow}${state.shareNotice ? `<p class="share-notice">${esc(state.shareNotice)}</p>` : ""}${circuitBanner()}<section class="workspace-grid"><div class="workspace-main"><section class="panel editor-panel" id="ws-editor"><div class="panel-label">DSL SOURCE <span>${badge(compiled ? "EDITABLE" : "DIAGNOSTICS", compiled ? "blue" : "amber")}</span></div><textarea id="source-editor" spellcheck="false" aria-label="GateX DSL source">${esc(state.source)}</textarea><div class="editor-foot"><span>Generic GateX language · reset priority · transition-pulse outputs</span><button class="button secondary small-button" id="reset-source">${state.templateKey !== undefined ? "Reset to template" : "Reset to example"}</button></div></section>${compilePanel()}${TAPEOUT_ENABLED ? `<div class="tapeout-region" id="tapeout-region">${tapeoutRegionHtml()}</div>` : ""}${playground()}</div><aside class="workspace-side">${verificationPanel()}<section class="panel"><div class="panel-label">STATE MACHINE</div>${compiled ? stateDiagram(compiled.compiled) : `<p class="muted">State diagram waits for valid source.</p>`}</section>${quotePanel()}<section class="panel disclosure"><div class="panel-label">SESSION STORAGE</div><p>In the workspace the state is stored by this browser. TapeOut computes transitions; it does not store this workflow. To store it on X Layer, run the circuit as a <a class="text-link" href="#/sessions">RuleGate session</a>.</p>${restored}<p class="muted">Restored histories are labeled LOCAL, never fresh live evidence. Changing the source clears the circuit check.</p></section></aside></section></main>${footer()}`; }

function artifactEvidence(counts: string, bytes: string, localSha: string, payloadSha: string, cases: string): string { return `<div class="artifact-list"><div><span>${esc(counts)}</span><strong>${esc(cases)}</strong></div><div><span>${esc(bytes)}</span><small>dimensions recorded in readback</small></div><div><small>local SHA-256</small><code>${esc(localSha)}</code></div><div><small>TapeOut payload SHA-256</small><code>${esc(payloadSha)}</code></div></div>`; }
function evidence(): string { const current = state.readback && state.binding?.liveReady ? `<section class="panel history-panel"><div class="panel-label">CURRENT SESSION FRESH READBACK <span>${badge("LIVE X LAYER", "blue")}</span></div><p class="muted">Circuit ${esc(state.readback.circuitId)} was read from both providers in this browser session and matched the manufactured circuit.</p><div class="history-grid"><div><small>Payload</small><code>${esc(shortHash(state.readback.payloadSha256))}</code></div><div><small>Dimensions</small><code>(${state.readback.nIn}, ${state.readback.nOut}, ${state.readback.nState}, ${state.readback.gateCount})</code></div><div><small>Owner</small><code>${esc(state.readback.owner)}</code></div><div><small>Processor</small><code>${esc(state.readback.processor)}</code></div></div></section>` : `${state.readbackLoading ? `<section class="panel history-panel"><div class="panel-label">CURRENT SESSION FRESH READBACK <span>${badge("READING", "muted")}</span></div><p class="muted">Reading the circuit from X Layer…</p></section>` : state.readback === undefined && state.readbackError === undefined ? `<section class="panel history-panel"><div class="panel-label">CURRENT SESSION FRESH READBACK <span>${badge("NOT RUN", "muted")}</span></div><p class="muted">No live check has been run in this browser session yet. <a class="text-link" href="#/workspace">Run one in the workspace ↗</a></p></section>` : `<section class="panel history-panel"><div class="panel-label">CURRENT SESSION FRESH READBACK <span>${badge("UNAVAILABLE", "amber")}</span></div><p class="muted">Recorded manufacture evidence remains historical. This session could not read the circuit from X Layer.</p></section>`}`; return `${nav("/evidence")}<main class="page evidence"><section class="page-heading"><div><div class="eyebrow">EVIDENCE / READ-ONLY RECORD</div><h1>What has been proven.</h1><p>What was manufactured on X Layer, what was checked, and where to verify it yourself.</p></div>${badge("VERIFIED", "green")}</section><section class="evidence-hero panel dark-panel"><div><div class="panel-label">GATEX ON X LAYER</div><h2>Manufactured and verified on X Layer.</h2><div class="deploy-lines"><div><small>Processor</small><code>${addressLink(browserDeployment.processor)}</code></div><div><small>Token</small><code>${addressLink(browserDeployment.token)}</code></div><div><small>Deployment wallet</small><code>${addressLink(browserDeployment.creator)}</code></div></div><p class="muted">Chain ${browserDeployment.chainId} · registry index ${browserDeployment.registryIndex}</p><a class="text-link" href="#/circuits">See every circuit on the processor ↗</a></div><div class="evidence-count">${proofStat("512", "RECORDED COMPARISONS · CIRCUITS 1–2")}${proofStat("0", "MISMATCHES")}</div></section><section class="panel terms-panel"><div class="panel-label">TRANSISTOR TERMS</div><div class="proof-grid">${proofStat(browserDeployment.metadata.symbol, "TOKEN")}${proofStat(browserDeployment.metadata.cap.toLocaleString("en-US"), "SUPPLY CAP")}${proofStat(`${weiToOkb(browserDeployment.metadata.priceWei)} OKB`, "UNIT PRICE")}<div class="proof-stat"><strong class="stat-link">${txLink(browserDeployment.creationTransaction)}</strong><span>SET AT CREATION</span></div></div><p class="muted terms-note">Supply cap and unit price were fixed when the processor was created on X Layer.</p>${pricingLines()}</section><div class="evidence-grid"><article class="panel evidence-card"><div class="panel-label">TINYAPPROVAL <span>${badge("HISTORICAL EVIDENCE", "muted")}</span></div><h2>circuit 1</h2><p class="muted">LOCKED → READY → USED</p><p class="card-link">${txLink(CIRCUIT_RECORDS[0]?.manufactureTransaction ?? "", "View manufacture tx ↗", "text-link")}</p>${artifactEvidence("89 NAND · 2 LATCH · 91 records", "643 bytes local · 631 bytes TapeOut", "adee32d4133073926d312a711643d16ac7d849c7e662c2bce8f6131c35fd0334", "7ec1ed9fe2e0c5f92a45b2ad49fe3da969c109f01522d8306fe127aba76cabac", "32 / 32 cases")}</article><article class="panel evidence-card featured"><div class="panel-label">AGENTAPPROVAL <span>${badge("HISTORICAL EVIDENCE", "muted")}</span></div><h2>circuit 2</h2><p class="muted">IDLE → REQUESTED → APPROVED → USED</p><p class="card-link">${txLink(CIRCUIT_RECORDS[1]?.manufactureTransaction ?? "", "View manufacture tx ↗", "text-link")}</p>${artifactEvidence("98 NAND · 2 LATCH · 100 records", "706 bytes local · 694 bytes TapeOut", "d68c9881fbe8bf0fbf7f86cfa92ad2889389e07e09bb0e7f0068f23eded50003", "7e4b5f83032beaf32ce2e7c067f1ee24d08feea1e2db8c64ef7c4d7de231dc45", "256 / 256 cases matched")}</article></div>${current}<section class="panel history-panel"><div class="panel-label">HISTORICAL MANUFACTURE RECORD</div>${CIRCUIT_RECORDS.map((record) => `<div class="record-title">circuit ${record.id} · ${record.name}</div><div class="history-grid"><div><small>Manufacture tx</small>${txLink(record.manufactureTransaction)}</div><div><small>Block</small><code>${record.block}</code></div><div><small>Dimensions</small><code>(${record.dimensions.join(", ")})</code></div><div><small>Provider check</small><code>${record.providerCount} providers · ${record.providerCases} cases${record.providerBlock ? ` · block ${record.providerBlock}` : ""}</code></div></div>`).join("")}<p class="limitation">Note: GateX verified behaviour for every case it checked. It did not verify the deployed TapeOut contract source, and it does not provide immutability, stored workflow state, custody or replay protection.</p></section><section class="callout"><div class="callout-icon">◎</div><div><strong>Evidence labels are scoped.</strong><p>Historical manufacture records are labeled HISTORICAL EVIDENCE. LIVE X LAYER is reserved for a fresh current-session readback and live step.</p></div></section></main>${footer()}`; }
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
    return `<div class="result-box ok"><strong>Circuit #${esc(done.circuitId)} is on X Layer</strong><p>The bytes on chain match your compile.</p><div class="result-lines"><span>Transaction ${txLink(done.hash)}</span></div><details class="tech-details"><summary>Technical details</summary><p class="muted">SHA-256 ${esc(shortHash(done.payloadSha256))}</p><div class="result-lines"><span>Owner <code>${esc(abbreviatedAccount(done.owner))}</code></span></div>${liveLine}</details><small class="muted">Byte-hash equality is the proof. The live transition is a sanity check of the evaluation path.</small><div class="tapeout-actions"><a class="button primary small-button" href="#/sessions?circuit=${esc(done.circuitId)}">Run it as a session ↗</a>${done.source !== undefined ? `<button class="button secondary small-button" data-copy-link="done">Copy verification link</button>` : ""}<button class="button secondary small-button" id="tapeout-again">Manufacture another copy</button></div></div>`;
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
  state.wallet = applyConnectionChoice(await readWallet(state.wallet)); state.quote = undefined; render();
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

function footer(): string { return `<footer><span class="foot-left"><span>GateX</span>${extLink("https://github.com/AjKadri/GateX", "GitHub")}${extLink(`${EXPLORER}/address/${browserDeployment.processor}`, "Processor on X Layer")}${`<a href="#/docs">Docs</a>`}</span><span>${TAPEOUT_ENABLED ? "Verified circuit compiler · RuleGate sessions on X Layer" : "Read-only product verification · caller-owned state"}</span></footer>`; }
function render(): void {
  if (!app) return;
  const editor = document.activeElement instanceof HTMLTextAreaElement && document.activeElement.id === "source-editor" ? document.activeElement : undefined;
  const caret = editor === undefined ? undefined : { start: editor.selectionStart, end: editor.selectionEnd, scroll: editor.scrollTop };
  const current = route(); app.innerHTML = current === "/" ? landing() : current === "/workspace" ? workspace() : current === "/circuits" ? circuitsPage() : current === "/sessions" ? sessionsPage() : current === "/docs" ? docs() : evidence(); bindEvents();
  if (caret !== undefined) { const next = document.querySelector<HTMLTextAreaElement>("#source-editor"); if (next !== null) { next.focus({ preventScroll: true }); next.setSelectionRange(caret.start, caret.end); next.scrollTop = caret.scroll; } }
}

function bindEvents(): void {
  document.querySelector<HTMLButtonElement>("#wallet-notice-close")?.addEventListener("click", () => { walletNotice = undefined; render(); });
  document.querySelector<HTMLButtonElement>("#header-connect")?.addEventListener("click", () => void (route() === "/sessions" ? connectSessionsWallet() : connectWallet()));
  document.querySelector<HTMLButtonElement>("#header-wallet")?.addEventListener("click", (event) => { event.stopPropagation(); state.walletMenuOpen = state.walletMenuOpen !== true; render(); if (state.walletMenuOpen === true) document.querySelector<HTMLElement>(".wallet-menu .wallet-item")?.focus(); });
  document.querySelector<HTMLButtonElement>("#header-disconnect")?.addEventListener("click", disconnectWallet);
  document.querySelector<HTMLButtonElement>("#header-switch")?.addEventListener("click", () => { state.walletMenuOpen = false; void (route() === "/sessions" ? switchSessionsNetwork() : switchNetwork()); });
  document.querySelectorAll<HTMLButtonElement>("[data-example]").forEach((button) => button.addEventListener("click", () => { const key = button.dataset.example as ExampleKey; state.key = key; state.templateKey = undefined; state.sharedSource = false; state.source = EXAMPLES[key].source; state.compiled = undefined; state.restored = undefined; state.quote = undefined; state.quoteError = undefined; state.live = undefined; state.readback = undefined; state.binding = undefined; if (TAPEOUT_ENABLED) resetTapeout(); void compileCurrent(); }));
  document.querySelectorAll<HTMLButtonElement>("[data-step-scroll]").forEach((button) => button.addEventListener("click", () => document.querySelector<HTMLElement>(button.dataset.stepScroll ?? "")?.scrollIntoView({ behavior: "smooth", block: "start" })));
  const editor = document.querySelector<HTMLTextAreaElement>("#source-editor");
  editor?.addEventListener("input", () => { state.source = editor.value; if (TAPEOUT_ENABLED) resetTapeout(); state.compiled = undefined; state.restored = undefined; state.quote = undefined; state.quoteError = undefined; state.live = undefined; state.liveError = undefined; state.liveStatus = "PENDING"; state.readback = undefined; state.binding = undefined; state.diagnostics = []; if (TAPEOUT_ENABLED) updateTapeout(); window.clearTimeout(compileTimer); compileTimer = window.setTimeout(() => void compileCurrent(), 350); });
  document.querySelectorAll<HTMLButtonElement>("[data-template]").forEach((button) => button.addEventListener("click", () => { const template = TEMPLATES.find((candidate) => candidate.key === button.dataset.template); if (template === undefined) return; loadTemplate(template.key); }));
  document.querySelector<HTMLButtonElement>("#reset-source")?.addEventListener("click", () => { state.sharedSource = false; state.source = state.templateKey !== undefined ? TEMPLATES.find((template) => template.key === state.templateKey)?.source ?? EXAMPLES[state.key].source : EXAMPLES[state.key].source; state.quote = undefined; state.quoteError = undefined; if (TAPEOUT_ENABLED) resetTapeout(); void compileCurrent(); });
  document.querySelector<HTMLButtonElement>("#refresh-quote")?.addEventListener("click", () => void refreshQuote());
  document.querySelector<HTMLButtonElement>("#refresh-readback")?.addEventListener("click", () => void refreshReadback());
  document.querySelector<HTMLButtonElement>("#connect-wallet")?.addEventListener("click", () => void connectWallet());
  document.querySelector<HTMLButtonElement>("#disconnect-wallet")?.addEventListener("click", disconnectWallet);
  document.querySelector<HTMLSelectElement>("#state-select")?.addEventListener("change", (event) => { state.selectedState = Number((event.target as HTMLSelectElement).value); state.live = undefined; state.liveError = undefined; render(); });
  document.querySelectorAll<HTMLInputElement>("[data-input]").forEach((input) => input.addEventListener("change", () => { const name = input.dataset.input; if (name) state.inputs[name] = input.checked; state.live = undefined; state.liveError = undefined; render(); }));
  document.querySelector<HTMLButtonElement>("#run-live")?.addEventListener("click", () => void runLive());
  document.querySelector<HTMLButtonElement>("#circuits-retry")?.addEventListener("click", () => { circuitsUi.status = "idle"; void loadCircuits(); });
  document.querySelector<HTMLButtonElement>("#circuits-more")?.addEventListener("click", () => void loadMoreCircuits());
  bindSessionsEvents();
  document.querySelectorAll<HTMLButtonElement>("[data-doc-target]").forEach((button) => button.addEventListener("click", () => document.getElementById(button.dataset.docTarget ?? "")?.scrollIntoView({ behavior: "smooth", block: "start" })));
  if (TAPEOUT_ENABLED) bindTapeoutEvents();
}
function bindSessionsEvents(): void {
  if (route() !== "/sessions") return;
  const click = (selector: string, run: () => void): void => document.querySelector<HTMLButtonElement>(selector)?.addEventListener("click", run);
  click("#sessions-connect", () => void connectSessionsWallet());
  click("#sessions-switch", () => void switchSessionsNetwork());
  click("#sessions-open", () => void runOpenSession());
  click("#sessions-step", () => void runStepSession());
  click("#sessions-deploy", () => void runDeployRuleGate());
  click("#sessions-retry", () => { sessionsUi.recent.status = "idle"; void loadRecentSessions(); });
  click("#sessions-discard", () => { const account = state.wallet.account; if (account !== undefined && ruleGate?.discardInterruptedSigning(account) === true) { sessionsUi.action = { status: "idle" }; render(); } });
  click("#try-agent", () => { sessionsUi.pick = "2"; render(); document.querySelector<HTMLElement>(".open-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }); });
  document.querySelectorAll<HTMLInputElement>("[data-pick]").forEach((input) => input.addEventListener("change", () => { sessionsUi.pick = input.dataset.pick; render(); }));
  document.querySelectorAll<HTMLInputElement>("[data-session-input]").forEach((input) => input.addEventListener("change", () => { const name = input.dataset.sessionInput; if (name) sessionsUi.inputs[name] = input.checked; void refreshPreview(); }));
  document.querySelectorAll<HTMLButtonElement>("[data-sessions-copy]").forEach((button) => button.addEventListener("click", () => void copyText(button.dataset.sessionsCopy ?? "").then((copied) => { button.textContent = copied ? "Copied" : "Copy failed"; })));
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
  if (current === "/") loadOverviewStats();
  else if (current === "/workspace") applyHashParams();
  else if (current === "/circuits" && circuitsUi.status === "idle") void loadCircuits();
  else if (current === "/sessions") loadSessionsPage();
  else if ((current === "/evidence" || current === "/docs") && (pricingUi.status === "idle" || pricingUi.status === "error")) void loadPricing();
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
  pricingUi.status = "loading"; if (route() === "/evidence" || route() === "/docs") render();
  try { pricingUi.quote = await readOnlyQuote(); pricingUi.status = "ready"; } catch { pricingUi.quote = undefined; pricingUi.status = "error"; }
  if (route() === "/evidence" || route() === "/docs") render();
}

function pricingLines(errorText = "Live prices could not be read from X Layer just now. The unit price and cap above are fixed."): string {
  if (pricingUi.status === "ready" && pricingUi.quote !== undefined) {
    const agent = EXAMPLES.agent.expected;
    const [cost, room] = pricingSentences(costOfSize(pricingUi.quote, BigInt(agent.nand), BigInt(agent.latch)), EXAMPLES.agent.label, BigInt(agent.nand), BigInt(agent.latch));
    return `<div class="pricing-live"><p>${esc(cost)}</p><p>${esc(room)}</p><small class="muted">Read from ${pricingUi.quote.providers.length} providers at block ${pricingUi.quote.block.number}.</small></div>`;
  }
  if (pricingUi.status === "error") return `<div class="pricing-live"><p class="muted">${esc(errorText)}</p></div>`;
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
    knownMachines.set(rule.payloadSha256, compiled);
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
  if (route() === "/circuits" || route() === "/sessions") render();
}

async function loadCircuits(): Promise<void> {
  if (circuitsUi.status === "loading") return;
  circuitsToken += 1; const token = circuitsToken;
  Object.assign(circuitsUi, { status: "loading", error: undefined, rows: [], top: 0n, cursor: 0n, moreError: undefined, loadingMore: false });
  if (route() === "/circuits" || route() === "/sessions" || route() === "/") render();
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
  if (route() === "/circuits" || route() === "/sessions" || route() === "/") render();
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
  return `<article class="panel circuit-card ${row.confirmed ? "" : "unconfirmed"}">${head}${row.note ? `<p class="circuit-note">${esc(row.note)}</p>` : ""}<div class="circuit-facts"><div><small>Owner</small>${extLink(`${EXPLORER}/address/${row.owner}`, `${abbreviatedAccount(row.owner)} ↗`, "text-link")}</div><div><small>Gates</small><code>${esc(gates)}</code></div><div><small>Dimensions</small><code>(${dims.nIn}, ${dims.nOut}, ${dims.nState}, ${dims.gateCount})</code></div><div><small>Payload SHA-256</small><code>${esc(shortHash(row.payloadSha256))}</code></div></div>${matchLine}${isDeployed() ? `<a class="button secondary small-button open-session-link" href="#/sessions?circuit=${esc(row.id)}">Run as a session ↗</a>` : ""}</article>`;
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

// ---------------------------------------------------------------------------------------------------------------------
// Docs page (static content; the live cost line reuses pricingLines())

// ---------------------------------------------------------------------------------------------------------------------
// Sessions page (RuleGate)

interface HistoryEntry { step: number; inputs: string[]; stateName: string; outputs: string[]; hash: string }
interface PreviewUi { key: string; status: "loading" | "ready" | "error"; newState?: Uint8Array; outputs?: Uint8Array; error?: string }
interface SessionsUi {
  recent: { status: "idle" | "loading" | "ready" | "error"; rows: SessionRecord[]; count: bigint; block?: number; error?: string };
  view: { id?: bigint; status: "none" | "loading" | "ready" | "missing" | "error"; record?: SessionView; error?: string };
  preview?: PreviewUi;
  pick?: string;
  inputs: Record<string, boolean>;
  action: { status: "idle" | "checking" | "confirm" | "waiting" | "error"; message?: string; hash?: string; code?: string };
  history: Map<string, HistoryEntry[]>;
  banner?: { sessionId: string; step: number; names: string[]; hash: string };
  minBlock: number;
  appliedQuery?: string;
  deploy: { status: "idle" | "checking" | "confirm" | "waiting" | "done" | "error"; message?: string; hash?: string; address?: string };
}
const sessionsUi: SessionsUi = { recent: { status: "idle", rows: [], count: 0n }, view: { status: "none" }, inputs: {}, action: { status: "idle" }, history: new Map(), minBlock: 0, deploy: { status: "idle" } };
const ruleGate = app ? new RuleGateClient(browserRuleGateDeps()) : undefined;
const knownMachines = new Map<string, CompiledMachine>();
const circuitRecords = new Map<string, CircuitRecord | undefined>();
let sessionsToken = 0;
const rerenderSessions = (): void => { if (route() === "/sessions") render(); };

interface RuleOf { known: KnownRule; compiled: CompiledMachine }
function ruleOfRecord(record: CircuitRecord | undefined): RuleOf | undefined {
  if (record === undefined) return undefined;
  const known = matchKnownRule(record, circuitsUi.known);
  const compiled = known === undefined ? undefined : knownMachines.get(known.payloadSha256);
  return known === undefined || compiled === undefined ? undefined : { known, compiled };
}
function ruleOfCircuit(id: string): RuleOf | undefined { return ruleOfRecord(circuitRecords.get(id) ?? circuitsUi.rows.find((row) => row.id === id)); }
/** Why a circuit cannot be opened as a session from this browser, or undefined when it can. */
function openBlocker(row: CircuitRecord): string | undefined {
  if (!row.confirmed || row.unreadable) return "Not confirmed by both providers";
  const rule = ruleOfRecord(row);
  if (rule === undefined) return "Rule not known to this browser";
  const machine = rule.compiled.machine;
  if (machine.states[0]?.name !== machine.initialState) return "Starts in a state RuleGate cannot represent";
  return undefined;
}
function ownerIs(record: SessionRecord | undefined): boolean { return record !== undefined && state.wallet.status === "ready" && state.wallet.account?.toLowerCase() === record.owner; }
function inputMaskNow(compiled: CompiledMachine): number { return inputMaskFromRecord(compiled, sessionsUi.inputs); }
function setOutputNames(compiled: CompiledMachine, bytes: Uint8Array): string[] { return outputNames(compiled).filter((_, index) => ((bytes[Math.floor(index / 8)] ?? 0) >> (index % 8)) & 1); }
function setInputNames(compiled: CompiledMachine, mask: number): string[] { return compiled.machine.inputs.map((input) => input.name).filter((_, index) => (mask >> index) & 1); }
const hexBytesOf = (bytes: Uint8Array): string => bytesLabel(bytes);

async function ensureCircuitRecords(ids: Array<bigint | string>): Promise<void> {
  if (ruleGate === undefined) return;
  const missing = [...new Set(ids.map(String))].filter((id) => !circuitRecords.has(id) && !circuitsUi.rows.some((row) => row.id === id));
  if (missing.length === 0) return;
  try {
    const block = await ruleGate.commonBlock();
    const deps = circuitsDeps(block);
    const found = await Promise.all(missing.map((id) => readCircuit(deps, BigInt(id))));
    missing.forEach((id, index) => circuitRecords.set(id, found[index]));
  } catch { /* the name stays unknown; the session itself is still shown */ }
  rerenderSessions();
}

async function loadRecentSessions(): Promise<void> {
  if (ruleGate === undefined || !isDeployed() || sessionsUi.recent.status === "loading") return;
  sessionsUi.recent.status = "loading"; rerenderSessions();
  try {
    const list = await ruleGate.listSessions({ newest: 20 });
    sessionsUi.recent = { status: "ready", rows: list.rows, count: list.count, block: list.block };
    void ensureCircuitRecords(list.rows.map((row) => row.circuitId));
  } catch (error) { sessionsUi.recent = { status: "error", rows: [], count: 0n, error: error instanceof Error ? error.message : String(error) }; }
  rerenderSessions();
}

async function loadSession(id: bigint, minBlock = 0): Promise<void> {
  if (ruleGate === undefined) return;
  sessionsToken += 1; const token = sessionsToken;
  if (sessionsUi.view.id !== id) { sessionsUi.banner = undefined; sessionsUi.action = { status: "idle" }; sessionsUi.preview = undefined; }
  sessionsUi.view = { id, status: "loading", record: sessionsUi.view.id === id ? sessionsUi.view.record : undefined }; rerenderSessions();
  try {
    const record = await ruleGate.readSession(id, { minBlock });
    if (token !== sessionsToken) return;
    sessionsUi.view = record === undefined ? { id, status: "missing" } : { id, status: "ready", record };
    if (record !== undefined) { await ensureCircuitRecords([record.circuitId]); if (token === sessionsToken) void refreshPreview(); }
  } catch (error) {
    if (token !== sessionsToken) return;
    sessionsUi.view = { id, status: "error", error: error instanceof Error ? error.message : String(error) };
  }
  rerenderSessions();
}

async function refreshPreview(): Promise<void> {
  const record = sessionsUi.view.record;
  if (ruleGate === undefined || record === undefined) return;
  const rule = ruleOfCircuit(record.circuitId.toString());
  if (rule === undefined) { sessionsUi.preview = undefined; rerenderSessions(); return; }
  const mask = inputMaskNow(rule.compiled);
  const key = `${record.id}:${record.steps}:${mask}`;
  sessionsUi.preview = { key, status: "loading" }; rerenderSessions();
  try {
    const result = await ruleGate.previewStep(record.id, encodeInputMask(mask, rule.compiled.machine.inputs.length), { minBlock: sessionsUi.minBlock });
    if (sessionsUi.preview?.key === key) sessionsUi.preview = { key, status: "ready", newState: result.newState, outputs: result.outputs };
  } catch (error) { if (sessionsUi.preview?.key === key) sessionsUi.preview = { key, status: "error", error: error instanceof Error ? error.message : String(error) }; }
  rerenderSessions();
}

/** Applies ?id= and ?circuit= once per change of the query. */
function applySessionsParams(): void {
  const raw = routeQuery().toString();
  if (raw === (sessionsUi.appliedQuery ?? "")) return;
  sessionsUi.appliedQuery = raw;
  const params = routeQuery();
  const circuit = parseCircuitParam(params.get("circuit"));
  if (circuit !== undefined) sessionsUi.pick = circuit;
  const idText = params.get("id");
  if (idText !== null && /^[1-9][0-9]{0,15}$/.test(idText)) void loadSession(BigInt(idText));
  else { sessionsUi.view = { status: "none" }; sessionsUi.preview = undefined; sessionsUi.banner = undefined; sessionsUi.action = { status: "idle" }; }
  rerenderSessions();
}

function loadSessionsPage(): void {
  if (circuitsUi.status === "idle" && isDeployed()) void loadCircuits();
  if (!isDeployed()) return;
  applySessionsParams();
  if (sessionsUi.recent.status === "idle") void loadRecentSessions();
  void followPendingSession();
}

let resumedFor = "";
async function followPendingSession(): Promise<void> {
  const account = state.wallet.account;
  if (ruleGate === undefined || account === undefined || resumedFor === account.toLowerCase()) return;
  const record = ruleGate.pending(account);
  if (record === undefined || record.phase !== "submitted" || record.kind === "deploy") return;
  resumedFor = account.toLowerCase();
  sessionsUi.action = { status: "waiting", message: "A transaction sent earlier is waiting for confirmation.", hash: record.hash }; rerenderSessions();
  const result = await ruleGate.resume(account);
  if (result === undefined) return;
  await afterWrite(result);
}

async function afterWrite(result: OpenResult | StepResult | RuleGateFailure): Promise<void> {
  if (!result.ok) { sessionsUi.action = { status: "error", message: result.reason, code: result.code, hash: result.hash }; rerenderSessions(); return; }
  sessionsUi.action = { status: "idle" };
  sessionsUi.minBlock = Number(result.blockNumber);
  if ("step" in result) {
    const idKey = result.sessionId.toString();
    const rule = ruleOfCircuit(sessionsUi.view.record?.circuitId.toString() ?? "");
    const names = rule === undefined ? [] : setOutputNames(rule.compiled, result.outputs);
    const entry: HistoryEntry = { step: result.step, inputs: rule === undefined ? [hexBytesOf(result.inputs)] : setInputNames(rule.compiled, stateValue(result.inputs)), stateName: rule === undefined ? hexBytesOf(result.newState) : stateName(rule.compiled, stateValue(result.newState)), outputs: names, hash: result.hash };
    sessionsUi.history.set(idKey, [...(sessionsUi.history.get(idKey) ?? []), entry]);
    if (result.outputs.some((byte) => byte !== 0)) sessionsUi.banner = { sessionId: idKey, step: result.step, names: names.length > 0 ? names : [hexBytesOf(result.outputs)], hash: result.hash };
    const current = sessionsUi.view.record;
    if (current !== undefined && current.id === result.sessionId) sessionsUi.view = { id: current.id, status: "ready", record: { ...current, steps: result.step, state: result.newState, lastOutputs: result.outputs } };
    rerenderSessions();
    sessionsUi.recent.status = "idle"; void loadRecentSessions();
    await loadSession(result.sessionId, Number(result.blockNumber));
  } else {
    sessionsUi.recent.status = "idle";
    window.location.hash = `#/sessions?id=${result.sessionId}`;
    void loadRecentSessions();
  }
}

function sessionWriteBusy(): boolean { return sessionsUi.action.status === "checking" || sessionsUi.action.status === "confirm" || sessionsUi.action.status === "waiting"; }
function onSessionPhase(phase: "checking" | "confirm" | "waiting", hash?: string): void { sessionsUi.action = { status: phase, hash }; rerenderSessions(); }

async function runOpenSession(): Promise<void> {
  const provider = state.wallet.provider; const account = state.wallet.account;
  const row = circuitsUi.rows.find((candidate) => candidate.id === sessionsUi.pick);
  const rule = row === undefined ? undefined : ruleOfRecord(row);
  if (ruleGate === undefined || provider === undefined || account === undefined || state.wallet.status !== "ready" || row === undefined || rule === undefined || openBlocker(row) !== undefined || sessionWriteBusy()) return;
  sessionsUi.action = { status: "checking" }; rerenderSessions();
  await afterWrite(await ruleGate.openSession(provider, account, BigInt(row.id), byteLength(rule.compiled.machine.stateBits), onSessionPhase));
}

async function runStepSession(): Promise<void> {
  const provider = state.wallet.provider; const account = state.wallet.account; const record = sessionsUi.view.record;
  const rule = record === undefined ? undefined : ruleOfCircuit(record.circuitId.toString());
  if (ruleGate === undefined || provider === undefined || account === undefined || record === undefined || rule === undefined || !ownerIs(record) || sessionWriteBusy() || !stepAgreement(record, rule.compiled).agree) return;
  sessionsUi.action = { status: "checking" }; rerenderSessions();
  await afterWrite(await ruleGate.stepSession(provider, account, record.id, encodeInputMask(inputMaskNow(rule.compiled), rule.compiled.machine.inputs.length), onSessionPhase));
}

async function connectSessionsWallet(): Promise<void> { await connectFlow(); render(); void followPendingSession(); }
async function switchSessionsNetwork(): Promise<void> { const provider = state.wallet.provider; if (provider === undefined) return; await switchToXLayer(provider); state.wallet = applyConnectionChoice(await readWallet(state.wallet)); render(); }

async function runDeployRuleGate(): Promise<void> {
  const provider = state.wallet.provider; const account = state.wallet.account;
  if (!import.meta.env.DEV || ruleGate === undefined || provider === undefined || account === undefined || state.wallet.status !== "ready" || ["checking", "confirm", "waiting"].includes(sessionsUi.deploy.status)) return;
  const set = (next: SessionsUi["deploy"]): void => { sessionsUi.deploy = next; rerenderSessions(); };
  set({ status: "checking" });
  const sent = await ruleGate.deployRuleGate(provider, account, (phase, hash) => set({ status: phase, hash: hash ?? sessionsUi.deploy.hash }));
  if (!sent.ok) { set({ status: "error", message: sent.reason }); return; }
  set({ status: "waiting", hash: sent.hash });
  const done = await ruleGate.awaitDeployment(sent.hash);
  set(done.ok ? { status: "done", hash: done.hash, address: done.address } : { status: "error", message: done.reason, hash: done.hash });
}

function stepAgreement(record: SessionRecord, compiled: CompiledMachine): { agree: boolean; line: string; tone: "ok" | "warn" | "wait" } {
  const preview = sessionsUi.preview;
  const mask = inputMaskNow(compiled);
  const index = stateValue(record.state);
  if (index >= compiled.machine.states.length) return { agree: false, tone: "warn", line: "The stored state is not a state of this rule." };
  if (preview === undefined || preview.status === "loading" || preview.key !== `${record.id}:${record.steps}:${mask}`) return { agree: false, tone: "wait", line: "Asking the contract what this step would do…" };
  if (preview.status === "error" || preview.newState === undefined || preview.outputs === undefined) return { agree: false, tone: "warn", line: `The contract could not preview this step: ${preview.error ?? "unknown error"}` };
  let local: ReturnType<typeof localStep>;
  try { local = localStep(compiled, index, mask); } catch (error) { return { agree: false, tone: "warn", line: `The local interpreter could not run this step: ${error instanceof Error ? error.message : String(error)}` }; }
  const sameState = hexBytesOf(local.nextStateBytes) === hexBytesOf(preview.newState);
  const sameOutputs = hexBytesOf(local.outputBytes) === hexBytesOf(preview.outputs);
  const from = stateName(compiled, index);
  const chainTo = stateName(compiled, stateValue(preview.newState));
  const chainOut = setOutputNames(compiled, preview.outputs);
  if (!sameState || !sameOutputs) return { agree: false, tone: "warn", line: `Local and chain disagree. Local: ${from} → ${stateName(compiled, local.nextState)}${setOutputNames(compiled, local.outputBytes).length > 0 ? ` emitting ${setOutputNames(compiled, local.outputBytes).join(", ")}` : ""}. Chain: ${from} → ${chainTo}${chainOut.length > 0 ? ` emitting ${chainOut.join(", ")}` : ""}. Stepping is disabled.` };
  return { agree: true, tone: "ok", line: `${from} → ${chainTo}${chainOut.length > 0 ? `, emits ${chainOut.join(", ")}` : ", no output"}. The local interpreter and the contract agree.` };
}

function sessionsWalletBlock(): string {
  const wallet = state.wallet;
  if (wallet.status === "unavailable") return `<div class="wallet-row"><button class="button secondary small-button" disabled>Connect OKX Wallet</button><small class="muted">OKX Wallet not detected in this browser.</small></div>`;
  if (wallet.status === "ready") return `<div class="wallet-row"><span class="muted">${esc(wallet.name ?? "OKX Wallet")} · <code>${esc(abbreviatedAccount(wallet.account))}</code> · X Layer / 196</span></div>`;
  if (wallet.status === "wrong-network") return `<div class="wallet-row"><button class="button secondary small-button" id="sessions-switch">Switch to X Layer</button><small class="muted">Wallet is on network ${esc(wallet.chainId ?? "unknown")}.</small></div>`;
  return `<div class="wallet-row"><button class="button secondary small-button" id="sessions-connect">Connect OKX Wallet</button>${wallet.error ? `<small class="muted">${esc(wallet.error)}</small>` : ""}</div>`;
}

function copyBlock(label: string, text: string): string {
  return `<pre class="code-block"><code>${esc(text)}</code></pre><button class="button secondary small-button" data-sessions-copy="${esc(text)}">${esc(label)}</button>`;
}

function deployTool(): string {
  if (!import.meta.env.DEV) return "";
  const d = sessionsUi.deploy;
  const busy = d.status === "checking" || d.status === "confirm" || d.status === "waiting";
  const status = d.status === "checking" ? "Simulating on both providers…" : d.status === "confirm" ? "Confirm in your wallet." : d.status === "waiting" ? "Waiting for the deployment to confirm on both providers…" : d.status === "error" ? d.message ?? "Failed." : "";
  const result = d.status === "done" && d.address !== undefined && d.hash !== undefined ? `<div class="result-box ok"><strong>RuleGate deployed</strong><p>Send these two values to be saved in deployments/rulegate.json</p>${copyBlock("Copy both values", `address: ${d.address}\ndeployTransaction: ${d.hash}`)}<div class="result-lines"><span>Contract ${addressLink(d.address)}</span><span>Transaction ${txLink(d.hash)}</span></div></div>` : "";
  return `<section class="panel dev-tool"><div class="panel-label">OWNER TOOL <span>${badge("DEV BUILD ONLY", "amber")}</span></div><h3>Deploy RuleGate</h3><p class="muted">Deploys contracts/RuleGate.sol against the GateX processor from your wallet. This tool is not part of production builds.</p>${sessionsWalletBlock()}<div class="tapeout-actions"><button class="button primary small-button" id="sessions-deploy" ${state.wallet.status === "ready" && !busy && d.status !== "done" ? "" : "disabled"}>Deploy RuleGate</button></div>${status ? `<p class="${d.status === "error" ? "inline-error" : "muted"}" role="status">${esc(status)}</p>` : ""}${d.status === "error" && state.wallet.account !== undefined && ruleGate?.pending(state.wallet.account as string)?.phase === "signing" ? `<div class="tapeout-actions"><button class="button secondary small-button" id="sessions-discard">I checked my wallet: nothing was sent. Try again</button></div>` : ""}${d.hash && d.status !== "done" ? `<p class="muted">Transaction ${txLink(d.hash)}</p>` : ""}${result}</section>`;
}

function openPanel(): string {
  const rows = circuitsUi.rows;
  const list = circuitsUi.status === "idle" || circuitsUi.status === "loading" ? `<p class="muted reading" role="status">Reading circuits…</p>`
    : circuitsUi.status === "error" ? `<div class="inline-error"><strong>UNAVAILABLE</strong><span>Could not read the circuit list: ${esc(circuitsUi.error ?? "")}</span></div>`
    : `<div class="pick-list" role="radiogroup" aria-label="Circuit">${rows.map((row) => {
      const reason = circuitsUi.knownReady ? openBlocker(row) : "Checking known rules…";
      const rule = ruleOfRecord(row);
      return `<label class="pick ${reason === undefined ? "" : "disabled"} ${sessionsUi.pick === row.id ? "chosen" : ""}"><input type="radio" name="circuit" value="${esc(row.id)}" data-pick="${esc(row.id)}" ${reason === undefined ? "" : "disabled"} ${sessionsUi.pick === row.id ? "checked" : ""}><span><strong>#${esc(row.id)}${rule === undefined ? "" : ` · ${esc(rule.known.name)}`}</strong>${reason === undefined ? "" : `<small>${esc(reason)}</small>`}</span></label>`;
    }).join("")}</div>`;
  const pickedRow = rows.find((row) => row.id === sessionsUi.pick);
  const picked = pickedRow === undefined || openBlocker(pickedRow) !== undefined ? undefined : ruleOfRecord(pickedRow);
  const detail = picked === undefined ? `<p class="muted">Pick a circuit to see its rule.</p>` : `<div class="picked-rule"><h3>${esc(picked.known.name)}</h3>${stateDiagram(picked.compiled)}</div>`;
  const ready = state.wallet.status === "ready";
  const action = sessionsUi.action;
  const note = action.status === "checking" ? "Simulating on both providers…" : action.status === "confirm" ? "Confirm in your wallet." : action.status === "waiting" ? "Waiting for confirmation on both providers…" : "";
  const openError = action.status === "error" && sessionsUi.view.status !== "ready" ? `<div class="inline-error"><strong>${/nothing was sent|not sent|will not be sent/i.test(action.message ?? "") ? "NOT SENT" : "CHECK"}</strong><span>${esc(action.message ?? "")}</span></div>` : "";
  return `<section class="panel open-panel"><div class="panel-label">OPEN A SESSION</div>${list}${detail}${sessionsWalletBlock()}<div class="tapeout-actions"><button class="button primary" id="sessions-open" ${picked !== undefined && ready && !sessionWriteBusy() ? "" : "disabled"}>Open session</button></div>${note ? `<p class="muted" role="status">${esc(note)}</p>` : ""}${openError}<small class="safety-note">Opening a session starts the rule in its first state. It costs gas only.</small></section>`;
}

function sessionLink(id: bigint | string): string { return `#/sessions?id=${esc(String(id))}`; }

function sessionPanel(): string {
  const view = sessionsUi.view;
  if (view.status === "none") return `<section class="panel session-panel"><div class="panel-label">SESSION</div><p class="muted">Open a session on the left, or choose one from the recent sessions below.</p></section>`;
  const title = `Session #${esc(String(view.id))}`;
  if (view.status === "loading" && view.record === undefined) return `<section class="panel session-panel"><div class="panel-label">${title}</div><p class="muted reading" role="status">Reading X Layer…</p></section>`;
  if (view.status === "missing") return `<section class="panel session-panel"><div class="panel-label">${title}</div><p>There is no such session.</p></section>`;
  if (view.status === "error") return `<section class="panel session-panel"><div class="panel-label">${title}</div><div class="inline-error"><strong>UNAVAILABLE</strong><span>${esc(view.error ?? "")}</span></div></section>`;
  const record = view.record as SessionView;
  const rule = ruleOfCircuit(record.circuitId.toString());
  const index = stateValue(record.state);
  const current = rule === undefined ? hexBytesOf(record.state) : stateName(rule.compiled, index);
  const lastOutputs = rule === undefined ? (record.lastOutputs.length === 0 ? "none yet" : hexBytesOf(record.lastOutputs)) : record.steps === 0 ? "none yet" : setOutputNames(rule.compiled, record.lastOutputs).join(", ") || "none";
  const facts = `<div class="kv-grid session-facts"><div><small>Rule</small><strong>${rule === undefined ? "Rule not known to this browser" : esc(rule.known.name)}</strong></div><div><small>Circuit</small><strong>#${esc(record.circuitId.toString())}</strong></div><div><small>Owner</small>${extLink(`${EXPLORER}/address/${record.owner}`, `${abbreviatedAccount(record.owner)} ↗`, "text-link")}</div><div><small>Steps</small><strong>${record.steps}</strong></div></div>`;
  const history = sessionsUi.history.get(record.id.toString()) ?? [];
  const banner = sessionsUi.banner !== undefined && sessionsUi.banner.sessionId === record.id.toString() ? `<div class="result-box ok permit-banner" role="status"><strong>${esc(sessionsUi.banner.names.join(", "))} emitted on chain in step ${sessionsUi.banner.step}</strong><p>The circuit produced this output and RuleGate recorded it on X Layer. ${txLink(sessionsUi.banner.hash, "View the transaction ↗")}</p></div>` : "";
  let controls = "";
  if (rule === undefined) controls = `<p class="muted">This browser does not know the rule of circuit #${esc(record.circuitId.toString())}, so it cannot compute or preview steps. The stored state is shown as raw bytes.</p>`;
  else if (!ownerIs(record)) {
    controls = `<p class="readonly-note"><strong>Only the wallet that opened this session can advance it.</strong> This page is read-only for you.</p>${state.wallet.status === "ready" ? "" : sessionsWalletBlock()}`;
  } else {
    const compiled = rule.compiled;
    const agreement = stepAgreement(record, compiled);
    const action = sessionsUi.action;
    const busy = sessionWriteBusy();
    const inputsHtml = compiled.machine.inputs.map((input) => `<label class="input-toggle"><input type="checkbox" data-session-input="${esc(input.name)}" ${sessionsUi.inputs[input.name] ? "checked" : ""} ${busy ? "disabled" : ""}><span>${esc(input.name)}</span></label>`).join("");
    const terminal = compiled.machine.states[index]?.terminal === true ? `<p class="muted">This rule is finished: it is in a terminal state. ${compiled.machine.resetInput ? `The reset input <code>${esc(compiled.machine.resetInput)}</code> still decides what happens.` : ""}</p>` : "";
    const status = action.status === "checking" ? "Simulating on both providers…" : action.status === "confirm" ? "Confirm in your wallet." : action.status === "waiting" ? "Waiting for confirmation on both providers…" : "";
    const err = action.status === "error" ? `<div class="inline-error"><strong>${/nothing was sent|not sent|will not be sent/i.test(action.message ?? "") ? "NOT SENT" : "CHECK"}</strong><span>${esc(action.message ?? "")}</span></div>${action.code === "pending" && state.wallet.account !== undefined && ruleGate?.pending(state.wallet.account as string)?.phase === "signing" ? `<button class="button secondary small-button" id="sessions-discard">I checked my wallet: nothing was sent. Try again</button>` : ""}` : "";
    controls = `${terminal}<div class="input-toggles" role="group" aria-label="Inputs for this step">${inputsHtml}</div><p class="what-happens ${agreement.tone}" role="status"><strong>What will happen</strong> ${esc(agreement.line)}</p><div class="tapeout-actions"><button class="button primary" id="sessions-step" ${agreement.agree && !busy ? "" : "disabled"}>Step on X Layer</button></div>${status ? `<p class="muted" role="status">${esc(status)}${action.hash ? ` ${txLink(action.hash)}` : ""}</p>` : ""}${err}`;
  }
  const historyHtml = history.length === 0 ? "" : `<h3>Steps taken here</h3><div class="history-list">${history.map((entry) => `<div class="history-row"><strong>Step ${entry.step}</strong><span>inputs: ${entry.inputs.length === 0 ? "none" : esc(entry.inputs.join(", "))}</span><span>→ ${esc(entry.stateName)}</span><span>${entry.outputs.length === 0 ? "no output" : `emitted ${esc(entry.outputs.join(", "))}`}</span>${txLink(entry.hash)}</div>`).join("")}</div>`;
  return `<section class="panel session-panel"><div class="panel-label">${title} <span>${view.status === "loading" ? badge("REFRESHING", "muted") : badge(`BLOCK ${record.block}`, "muted")}</span></div>${banner}<div class="current-state"><small>Current state</small><strong>${esc(current)}</strong><span class="muted">Last outputs: ${esc(lastOutputs)}</span></div>${facts}${controls}${historyHtml}</section>`;
}

function recentPanel(): string {
  const recent = sessionsUi.recent;
  const body = recent.status === "idle" || recent.status === "loading" ? `<p class="muted reading" role="status">Reading X Layer…</p>`
    : recent.status === "error" ? `<div class="inline-error"><strong>UNAVAILABLE</strong><span>${esc(recent.error ?? "")}</span></div><div class="tapeout-actions"><button class="button secondary small-button" id="sessions-retry">Retry</button></div>`
    : recent.rows.length === 0 ? `<p class="muted">No sessions have been opened yet.</p>`
    : `<div class="session-rows"><div class="session-row head"><span>Session</span><span>Circuit</span><span>Owner</span><span>Steps</span><span>State</span></div>${recent.rows.map((row) => {
      const rule = ruleOfCircuit(row.circuitId.toString());
      return `<div class="session-row"><a class="text-link" href="${sessionLink(row.id)}">#${esc(row.id.toString())}</a><span>#${esc(row.circuitId.toString())}${rule === undefined ? "" : ` · ${esc(rule.known.name)}`}</span>${extLink(`${EXPLORER}/address/${row.owner}`, `${abbreviatedAccount(row.owner)} ↗`, "text-link")}<span>${row.steps}</span><span>${esc(rule === undefined ? hexBytesOf(row.state) : stateName(rule.compiled, stateValue(row.state)))}</span></div>`;
    }).join("")}</div><p class="muted foot-note">Newest ${recent.rows.length} of ${recent.count.toString()}, read from two providers at block ${recent.block ?? "?"}.</p>`;
  return `<section class="panel recent-panel"><div class="panel-label">RECENT SESSIONS</div>${body}</section>`;
}

function sessionsPage(): string {
  const heading = `<section class="page-heading"><div><div class="eyebrow">SESSIONS / RULEGATE</div><h1>Rules that remember.</h1><p>A circuit decides each move. RuleGate stores the result on X Layer, so a rule can only advance the way its circuit allows.</p></div></section>`;
  if (!isDeployed()) return `${nav("/sessions")}<main class="page sessions">${heading}<section class="panel neutral-panel"><div class="panel-label">RULEGATE</div><h3>RuleGate is not deployed yet.</h3><p class="muted">Sessions need the RuleGate contract on X Layer. Until it is deployed there is nothing to open or read here.</p></section>${deployTool()}</main>${footer()}`;
  return `${nav("/sessions")}<main class="page sessions">${heading}${routeQuery().get("id") === null ? `<section class="panel first-visit"><div><strong>New here?</strong> Try it with AgentApproval: open a session on circuit #2 and step it from IDLE to USED.</div><div class="first-visit-actions"><button class="button primary small-button" id="try-agent">Try with AgentApproval</button><a class="text-link" href="#/sessions?id=1">Or watch a finished session ↗</a></div></section>` : ""}<div class="sessions-layout">${openPanel()}${sessionPanel()}</div>${recentPanel()}</main>${footer()}`;
}

const GITHUB = "https://github.com/AjKadri/GateX";
const DOC_SECTIONS: Array<[string, string]> = [["what", "What it is"], ["write", "Write a rule"], ["check", "The full check"], ["tapeout", "Tape out"], ["verify", "Verify a circuit"], ["use", "Use a circuit"], ["vaults", "For vault builders"], ["security", "Security"], ["questions", "Questions"]];
const KEYWORD_ROWS: Array<[string, string, string]> = [
  ["machine", "Names the rule and wraps everything else.", "machine AgentApproval { … }"],
  ["states", "Declares the states.", "states IDLE, REQUESTED, APPROVED, USED;"],
  ["initial", "The state the circuit starts in and returns to.", "initial IDLE;"],
  ["inputs", "Declares the input signals. Each is true or false on every step.", "inputs request, approve, cancel;"],
  ["outputs", "Declares the output signals. An output is a pulse on one step, not a stored flag.", "outputs permit;"],
  ["terminal", "States that stay where they are until reset.", "terminal USED;"],
  ["reset_on", "An input that sends the circuit back to the initial state and takes priority over every transition.", "reset_on cancel;"],
  ["A -> B when … emit …;", "Moves from A to B when the condition is true. The optional emit lists outputs that pulse on that move.", "APPROVED -> USED when execute emit permit;"],
  ["&&   ||   !", "And, or, not, inside a condition.", "approve && human_ok && !scope_bad"],
  ["( )   true   false", "Grouping and the two constants.", "(approve || override) && human_ok"],
  ["state == NAME", "True while the circuit is in that state.", "state == READY && execute"]
];
function docCode(text: string): string { return `<pre class="code-block"><code>${esc(text)}</code></pre>`; }
function docSection(id: string, title: string, body: string): string { return `<section class="doc-section" id="doc-${id}"><h2>${esc(title)}</h2>${body}</section>`; }
function docList(items: string[]): string { return `<ul class="doc-list">${items.map((item) => `<li>${item}</li>`).join("")}</ul>`; }
function docs(): string {
  const processor = extLink(`${EXPLORER}/address/${browserDeployment.processor}`, `${browserDeployment.processor} ↗`);
  const token = extLink(`${EXPLORER}/address/${browserDeployment.token}`, `${browserDeployment.token} ↗`);
  const limitsRow = (label: string, value: string): string => `<div><small>${esc(label)}</small><strong>${esc(value)}</strong></div>`;
  const sections = [
    docSection("what", "What it is", `<p>A rule is a state machine written as text: named states, named inputs, and the moves between states. GateX turns a rule into a circuit of NAND and LATCH gates and, if you choose, puts that circuit on X Layer through the TapeOut protocol. A circuit is called verified when the bytes stored on chain are the same bytes GateX compiled from your rule, and when the circuit and the rule gave the same answer for every state and input combination in a full local check.</p>`),
    docSection("write", "Write a rule", `<p>This is the AgentApproval rule, the main example in the workspace.</p>${docCode(EXAMPLES.agent.source.trim())}
      ${docList([
        "<code>states</code>, <code>initial</code>, <code>inputs</code>, <code>outputs</code> declare the names the rule uses.",
        "<code>terminal USED</code> marks a state that stays put once reached.",
        "<code>reset_on cancel</code> sends the circuit back to <code>IDLE</code> whenever <code>cancel</code> is true.",
        "Each line with <code>-&gt;</code> is a move: from a state, to a state, when a condition holds. <code>emit permit</code> pulses that output on that move only."
      ])}
      <div class="doc-table-wrap"><table class="doc-table"><thead><tr><th>Keyword</th><th>What it does</th><th>Example</th></tr></thead><tbody>${KEYWORD_ROWS.map(([keyword, what, example]) => `<tr><td data-label="Keyword"><code>${esc(keyword)}</code></td><td data-label="What it does">${esc(what)}</td><td data-label="Example"><code>${esc(example)}</code></td></tr>`).join("")}</tbody></table></div>
      <p>Every state must be reachable from the initial state. Every state and every input combination must select exactly one move, so an uncovered or ambiguous row is an error. Comments start with <code>//</code>.</p>
      <h3>Limits</h3>
      <div class="doc-limits">${limitsRow("Inputs", "up to 8")}${limitsRow("States", "up to 8")}${limitsRow("Outputs", "up to 4")}${limitsRow("Gate records", "up to 512")}</div>
      <p>The compiler enforces the first three. The record limit and a 3,584 byte limit on the circuit are GateX safety limits checked before tape-out, not limits of the protocol.</p>
      <p>The workspace has five templates to start from: TwoPersonApproval, SpendingLimit, EscrowRelease, TimeboxedPermit and VaultRelease. <a class="text-link" href="#/workspace">Open the workspace ↗</a></p>`),
    docSection("check", "The full check", `<p>GateX compiles your rule to gates, then runs every state encoding with every combination of inputs. For each case it compares two independent engines: an interpreter that reads your rule directly, and a simulator that runs the compiled NAND and LATCH records. Both must give the same next state and outputs.</p>
      <p>Tape-out is not offered unless every case matches, for the exact bytes you are about to send.</p>
      <p>AgentApproval has 4 state encodings and 6 inputs, so 256 cases. TinyApproval has 4 state encodings and 3 inputs, so 32 cases.</p>`),
    docSection("tapeout", "Tape out", `<p>A circuit is built from transistors, which are a token, and manufactured by the processor, which burns them. Your wallet sends up to three transactions, in this order. A step is skipped if you already hold enough transistors.</p>
      ${docList(["Buy NAND transistors from the transistor token.", "Buy LATCH transistors from the transistor token.", "Manufacture the circuit on the processor."])}
      <p>Before each signature, GateX rebuilds the transaction and compares it with the plan, simulates it from your address on two RPC providers, and reads prices and balances again. If anything has changed, or a simulation fails, it sends nothing and tells you why. A step is never offered twice, including after a page reload while a transaction is pending.</p>
      <p>Use OKX Wallet, set to X Layer (chain 196).</p>
      <h3>What it costs now</h3>
      ${pricingLines("Live prices could not be read from X Layer just now.")}
      <p class="muted">Gas is paid on top. Overpaying a mint is not refunded, which is why each transaction is built from numbers read a moment earlier.</p>`),
    docSection("verify", "Verify a circuit", `<p>GateX reads the circuit back from X Layer through two providers and compares the bytes stored on chain with the bytes compiled in your browser. Identical bytes mean identical behaviour.</p>
      <p>After a tape-out you can copy a verification link. Anyone who opens it gets your rule and a read-only check against your circuit. The Circuits page lists every circuit on the processor and marks the ones that match a rule your browser knows. <a class="text-link" href="#/circuits">See the circuits ↗</a></p>`),
    docSection("use", "Use a circuit", `<p>An app or agent evaluates a circuit with a read-only call to the processor, <code>step(uint256 id, bytes state, bytes inputs)</code>. It takes the circuit id, the current state and the inputs, and returns the next state and the outputs as two <code>bytes</code> values. Nothing is written on chain and no fee is paid.</p>
      <p>The caller stores the state between calls and passes it back in next time. State and inputs are bits packed least-significant-bit first: the state is its index in the declaration order, and input number <em>n</em> is the <em>n</em>th declared input. The processor is ${processor}.</p>
      <p>The exact encoding and decoding is in <a class="text-link" href="${GITHUB}/blob/main/src/app/protocol.ts" target="_blank" rel="noopener">src/app/protocol.ts ↗</a> (<code>readLiveStep</code>).</p>
      <p><strong class="doc-strong">The circuit decides. It does not remember.</strong> The processor stores no workflow state and has no replay protection. RuleGate, below, adds both.</p>
      <h3>Rules that remember (RuleGate)</h3>
      <p>RuleGate is a small contract that keeps the state of a rule on chain. Anyone can open a session on a circuit of the processor; it starts in the rule's first declared state. Each step sends the inputs, the processor's circuit computes the next state and outputs, and RuleGate stores the result, so a rule can only advance the way its circuit allows. It stores, per session: the opener, the circuit, the step count, the current state and the outputs of the last step.</p>
      ${docList([
        "Only the wallet that opened a session can advance it. Anyone can read it.",
        "RuleGate holds no funds, has no admin and cannot be upgraded.",
        "It has not been audited, and it trusts the processor's <code>step</code> as it is.",
        `Source: <a class="text-link" href="${GITHUB}/blob/main/contracts/RuleGate.sol" target="_blank" rel="noopener">contracts/RuleGate.sol ↗</a>. Details: <a class="text-link" href="${GITHUB}/blob/main/docs/rulegate.md" target="_blank" rel="noopener">docs/rulegate.md ↗</a>.`,
        RULEGATE.address === null ? "" : `RuleGate on X Layer: ${extLink(`${EXPLORER}/address/${RULEGATE.address}`, `${RULEGATE.address} ↗`)}.`
      ].filter((item) => item !== ""))}
      <p><a class="text-link" href="#/sessions">Open the sessions page ↗</a></p>`),
    docSection("vaults", "For vault builders", `<p>A vault can keep its release rule in a circuit instead of in contract code. The rule is then readable, checked for every case before it goes on chain, and replaceable by taping out a new circuit from GTX transistors.</p>
      <p>The VaultRelease template in the workspace is a starting point: a payout needs a request, a delay that has passed and a guardian, and nothing moves while the vault is paused.</p>
      ${docList([
        "Write the rule and tape it out. Each input is a fact the vault contract already knows: whether the delay has passed, whether the guardian approved, whether the vault is paused.",
        "Let the vault contract open a RuleGate session on that circuit. The opener is the only caller that can advance a session, so only the vault can move its own rule.",
        "On each action the vault calls <code>step</code> with the current input bits and pays out only when the returned outputs include <code>release</code>.",
        "A vault that prefers to store the state itself can call the processor's <code>step</code> directly, as described in Use a circuit."
      ])}
      <p>GateX does not ship a vault contract. RuleGate and the circuits are the pieces a vault would build on. <a class="text-link" href="#/workspace">Open the workspace</a> and pick VaultRelease to try the rule, or <a class="text-link" href="#/sessions">run it as a session</a> once it is on chain.</p>`),
    docSection("security", "Security", `<div class="doc-two"><div class="panel doc-box"><h3>What GateX does</h3>${docList([
        `Sends transactions only to the GateX transistor token (${token}) and the GateX processor.`,
        "Never asks for token approvals or message signatures.",
        "Simulates every transaction before you are asked to sign.",
        "Never holds funds or keys. Your wallet signs.",
        `RuleGate's source is verified on the X Layer explorer: <a class="text-link" href="https://www.oklink.com/xlayer/address/0xefa64bfc4f2f06465cfe2ff6dfa97cfbeac5732c" target="_blank" rel="noopener">view the contract ↗</a>.`,
        `All code is open source under the MIT license: <a class="text-link" href="${GITHUB}" target="_blank" rel="noopener">github.com/AjKadri/GateX ↗</a>.`
      ])}</div><div class="panel doc-box"><h3>What GateX has not done</h3>${docList([
        "It has not audited the TapeOut contracts.",
        "It has not verified the deployed source of the TapeOut contracts.",
        "Its only contract is RuleGate, which holds no funds, has no admin and cannot be upgraded. It has not been audited.",
        "It has not been audited by a third party.",
        "Circuits do not check who calls them."
      ])}</div></div>`),
    docSection("questions", "Questions", `${[
      ["What does it cost?", `Transistors at the current mint price, a protocol fee on each mint, a TapeOut fee, and gas. The live figure is in Tape out above, and the workspace shows the exact total for your circuit before you sign.`],
      ["Which wallet?", "OKX Wallet on X Layer. GateX does not accept a generic browser wallet."],
      ["Who owns the circuit?", "The wallet that manufactured it. The owner is recorded on chain and shown on the Circuits page."],
      ["Can I check someone else's circuit?", `Yes. Open it from the Circuits page, or use a verification link, and check a rule against it. The check is read-only.`],
      ["What if a transaction fails, or I leave the page?", "If a simulation fails or a price moves, nothing is sent. If you reject a request in your wallet, nothing is sent. If you reload the page after sending, the pending step is remembered and resumes at waiting for confirmation instead of being offered again. If you close the tab, check your wallet activity and the Circuits page before starting over. A new plan is built from your real balances, so transistors you already bought are not bought twice."]
    ].map(([question, answer]) => `<div class="doc-qa"><h3>${esc(question as string)}</h3><p>${esc(answer as string)}</p></div>`).join("")}`)
  ];
  const toc = DOC_SECTIONS.map(([id, label]) => `<button type="button" class="doc-link" data-doc-target="doc-${id}">${esc(label)}</button>`).join("");
  return `${nav("/docs")}<main class="page docs"><section class="page-heading"><div><div class="eyebrow">DOCS</div><h1>How GateX works.</h1><p>Write a rule, check it, put it on X Layer, and let anyone verify it.</p></div></section><div class="docs-layout"><aside class="docs-toc" aria-label="Sections">${toc}</aside><div class="docs-body">${sections.join("")}</div></div></main>${footer()}`;
}

async function refreshQuote(): Promise<void> { state.quoteLoading = true; state.quoteError = undefined; render(); try { state.quote = await readOnlyQuote(state.wallet.account); } catch (error) { state.quote = undefined; state.quoteError = error instanceof Error ? error.message : String(error); } finally { state.quoteLoading = false; render(); } }
/** Explicit connect from any button: asks the wallet, switches it to X Layer if needed, and always leaves a visible message when it cannot finish. */
async function connectFlow(): Promise<void> {
  walletNotice = undefined;
  if (state.wallet.provider === undefined) { walletNotice = "OKX Wallet was not found in this browser. On a phone, open this site inside the OKX Wallet app's browser."; render(); return; }
  state.walletConnecting = true; render();
  try {
    let next = await connectOkx(state.wallet);
    if (next.status === "wrong-network") {
      walletNotice = "Approve the switch to X Layer in your wallet.";
      render();
      const switched = await switchToXLayer(state.wallet.provider);
      next = switched.ok ? await connectOkx(next) : next;
      if (!switched.ok) walletNotice = `Your wallet is not on X Layer. ${switched.reason}`;
    }
    state.wallet = next;
    rememberConnection(next.account !== undefined && next.status === "ready");
    if (next.status === "ready") walletNotice = undefined;
    else if (walletNotice === undefined || walletNotice.startsWith("Approve")) walletNotice = next.error ?? (next.status === "wrong-network" ? "Your wallet is not on X Layer. Switch to X Layer in the wallet and connect again." : "The wallet did not connect. Open your wallet and try again.");
  } catch (error) {
    walletNotice = `The wallet did not connect: ${error instanceof Error ? error.message : String(error)}`;
  } finally { state.walletConnecting = false; }
}
function walletNoticeBar(): string { return walletNotice === undefined ? "" : `<div class="wallet-notice" role="status"><span>${esc(walletNotice)}</span><button type="button" class="wallet-notice-close" id="wallet-notice-close" aria-label="Dismiss">×</button></div>`; }
async function connectWallet(): Promise<void> { await connectFlow(); if (state.wallet.status === "ready") { try { state.quote = await readOnlyQuote(state.wallet.account); } catch (error) { state.quote = undefined; state.quoteError = error instanceof Error ? error.message : String(error); } } render(); if (TAPEOUT_ENABLED && state.wallet.status === "ready") void refreshTapeoutPlan(); }
async function refreshReadback(): Promise<void> { const compiled = state.compiled; if (!artifactEligible()) return; state.readbackLoading = true; state.readbackError = undefined; render(); try { state.readback = await readBoundCircuit(compiled?.definition.circuitId ?? "", compiled?.payload.payloadHash ?? ""); state.binding = bindingForCurrent(state.readback); if (!state.binding.liveReady) { state.readbackError = state.binding.detail; state.liveStatus = state.binding.status; } else state.liveStatus = "PENDING"; state.live = undefined; state.liveError = undefined; } catch (error) { state.readback = undefined; state.readbackError = error instanceof Error ? error.message : String(error); state.binding = bindingForCurrent(); state.liveStatus = error instanceof Error && "status" in error ? (error as { status: VerificationStatus }).status : "UNAVAILABLE"; } finally { state.readbackLoading = false; render(); } }
async function runLive(): Promise<void> { if (state.compiled === undefined || state.binding?.liveReady !== true || state.readback === undefined) return; state.liveLoading = true; state.liveError = undefined; render(); try { const machine = state.compiled.compiled.machine; const mask = machine.inputs.reduce((result, input, index) => result | (state.inputs[input.name] ? 1 << index : 0), 0); state.live = await readLiveStep(state.compiled.definition.circuitId, new Uint8Array([state.selectedState]), inputBytes(state.compiled.compiled, state.inputs)); const local = localStep(state.compiled.compiled, state.selectedState, mask); const localState = formatStateBytes(state.compiled.compiled, local.nextStateBytes); const liveState = formatStateBytes(state.compiled.compiled, state.live.nextState); const localOutput = formatBytes(local.outputBytes); const liveOutput = formatBytes(state.live.outputs); if (localState !== liveState || localOutput !== liveOutput) state.live.mismatches.push(`AST/local mismatch: local ${localState}/${localOutput}, live ${liveState}/${liveOutput}`); state.liveStatus = state.live.mismatches.length === 0 ? "PASSED" : "FAILED"; if (state.liveStatus === "PASSED") { const session: BrowserSession = { artifactDigest: state.compiled.compiled.hash, chainId: browserLock.chainId, processor: browserDeployment.processor, circuitId: state.compiled.definition.circuitId, sourceDigest: state.compiled.sourceDigest, activeState: liveState, history: [{ state: stateName(state.compiled.compiled, state.selectedState), inputs: { ...state.inputs }, localNext: localState, localOutput, origin: "LIVE X LAYER", recordedAt: new Date().toISOString() }] }; upsertSession(session); state.restored = session; } } catch (error) { state.live = undefined; state.liveStatus = error instanceof Error && "status" in error ? (error as { status: VerificationStatus }).status : "UNAVAILABLE"; state.liveError = error instanceof Error ? error.message : String(error); } finally { state.liveLoading = false; render(); } }
async function boot(root: HTMLElement): Promise<void> {
  root.innerHTML = `${nav("/")}<main class="page loading-page"><div class="loading">Loading GateX…</div></main>`;
  installEip6963Discovery();
  state.wallet = applyConnectionChoice(await readWallet(discoverOkxProvider()));
  bindProviderEvents(state.wallet, (next) => { state.wallet = applyConnectionChoice(next); state.quote = undefined; state.quoteError = WALLET_CHANGED_NOTICE; render(); onTapeoutWalletChange(); });
  document.addEventListener("click", (event) => { if (state.walletMenuOpen === true && !(event.target as Element).closest(".wallet-control")) { state.walletMenuOpen = false; render(); } });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && state.walletMenuOpen === true) { state.walletMenuOpen = false; render(); document.querySelector<HTMLElement>("#header-wallet")?.focus(); } });
  window.addEventListener("hashchange", () => { state.walletMenuOpen = false; render(); routeEffects(); });
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
