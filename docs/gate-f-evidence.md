# Gate F evidence

Gate F is the local/browser product-flow checkpoint after the accepted Gate E manufacture and live-proof milestone. This checkpoint does not create a processor, mint transistors, manufacture a circuit, request a wallet signature, or begin Gate G.

## Product surface

- Overview route: flagship AgentApproval positioning, source DSL, state flow, artifact counts, exhaustive proof result, caller-owned disclosure, and links to Workspace and Evidence.
- Workspace route: editable generic GateX DSL, parser/compiler diagnostics, state diagram, exact artifact binding, verification status ladder, read-only protocol quote, live transition playground, and browser-session disclosure.
- Evidence route: canonical processor/token deployment, TinyApproval and AgentApproval artifact hashes, historical transaction/readback evidence, live comparison count, and protocol limitations.

## Accepted artifacts

AgentApproval is circuit `2` on processor `0x95aaacaa8aaecf6d215706d3e7fff255a35c59ed`.

- 98 NAND, 2 LATCH, 100 records
- 706-byte local container, SHA-256 `d68c9881fbe8bf0fbf7f86cfa92ad2889389e07e09bb0e7f0068f23eded50003`
- 694-byte TapeOut payload, SHA-256 `7e4b5f83032beaf32ce2e7c067f1ee24d08feea1e2db8c64ef7c4d7de231dc45`
- Dimensions `(6,1,2,100)`
- 256 cases per locked provider, zero mismatches

TinyApproval remains circuit `1` with 89 NAND, 2 LATCH, 91 records, a 643-byte local container, and a 631-byte TapeOut payload. Its local hash is `adee32d4133073926d312a711643d16ac7d849c7e662c2bce8f6131c35fd0334`; its payload hash is `7ec1ed9fe2e0c5f92a45b2ad49fe3da969c109f01522d8306fe127aba76cabac`.

## Browser verification

- The local Vite preview rendered Overview, Workspace, and Evidence routes in the Codex in-app browser.
- The Workspace compiled AgentApproval and TinyApproval through the generic parser/compiler path and displayed their exact accepted bytes and hashes.
- A malformed source produced diagnostics and blocked manufacture readiness.
- The clean-wallet view showed wallet disconnected, no signature path, and a disabled manufacture control.
- The live playground read AgentApproval circuit `2` from both locked providers at common block `72532439`, hash `0x3f966ffb...5572c8f1`, and matched the independent local AST result with zero mismatches.
- The quote reader agreed on current locked protocol getters from both providers at block `72532504`, hash `0xe0fa9139...1d2945a3`.
- The browser runtime had no Web Crypto global. The deterministic artifact hash helper therefore uses the already-declared Noble SHA-256 implementation as a byte-identical fallback. Existing hashes and tests remain unchanged.

## Session and claim boundaries

Browser sessions are keyed by artifact digest, chain ID, processor, and circuit ID. Restored history is displayed as `LOCAL SIMULATION`, and source changes invalidate the binding. Fresh dual-provider reads are labeled `LIVE X LAYER`; recorded manufacture and readback are labeled `HISTORICAL EVIDENCE`.

The protocol source/build provenance warning remains unchanged. GateX does not claim protocol immutability, authoritative workflow state, replay-proof approvals, identity-authenticated approvals, custody, agent execution, or a protocol contract audit.

## Checks

- `npm test`: 39 passed, 0 failed
- `npm run typecheck`: passed
- `npm run build`: passed
- `git diff --check`: passed
- Wallet/signature/send selectors are absent from the Gate F product surface. No Gate F state-changing transaction was sent.
