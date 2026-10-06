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

- The local Vite preview rendered Overview, Workspace, and Evidence routes in a fresh browser context.
- The Workspace compiled AgentApproval and TinyApproval through the generic parser/compiler path and displayed their exact accepted bytes and hashes.
- A malformed source produced diagnostics and blocked manufacture readiness.
- Wallet discovery is restricted to an identifiable EIP-6963 or legacy OKX provider (`com.okex.wallet` / `isOkxWallet`). Account access is available only from the explicit `Connect OKX Wallet` action. The wallet layer rereads the same provider after `eth_requestAccounts` and invalidates readiness on account or chain changes.
- A prior clean-wallet session read AgentApproval circuit `2` from both locked providers at common block `72534785`, matched the independent local AST result, and displayed `LIVE X LAYER` in that session. This is recorded historical evidence, not a current-session claim.
- A later block made the quote visibly `STALE`, and the UI kept the stale warning until refresh.
- The browser runtime had no Web Crypto global. The deterministic artifact hash helper therefore uses the already-declared Noble SHA-256 implementation as a byte-identical fallback. Existing hashes and tests remain unchanged.

## Session and claim boundaries

Browser sessions are keyed by artifact digest, chain ID, processor, and circuit ID. Restored history is displayed as `LOCAL SIMULATION`, and source changes invalidate the binding. Recorded manufacture and readback are labeled `HISTORICAL EVIDENCE`. Only a fresh current-session dual-provider circuit readback followed by a live step can earn `LIVE X LAYER`.

The protocol source/build provenance warning remains unchanged. GateX does not claim protocol immutability, authoritative workflow state, replay-proof approvals, identity-authenticated approvals, custody, agent execution, or a protocol contract audit.

## Checks

- `npm test`: 47 passed, 0 failed
- `npm run typecheck`: passed
- `npm run build`: passed
- `git diff --check`: passed
- `npm run test:e2e`: 7 passed, 0 failed, Playwright `1.63.0`
- `npm run gatec:live`: passed. TinyApproval remained `SIMULATION`, with all locked fixtures and 32 candidate cases matching on both providers.
- `npm run gatee:final:live -- 0xf8fca87f75de3ebf9326071b0341c9307dd5d768c90558542c6013100816a8be`: passed. Circuit `2` readback matched `(6,1,2,100)`, and 256 cases matched on each provider, 512 live comparisons total.
- `eth_sendTransaction`, signing, and network-add paths are absent. Network switching was exercised only manually in the OKX site-connection UI. `eth_requestAccounts` is user-triggered only. No Gate F state-changing transaction was sent.

## HISTORICAL CLEAN-WALLET CHECKS

- Fresh Chrome origin: `http://127.0.0.1:4173/?clean=1#/workspace`, with no restored `LOCAL` session before connection.
- Provider: OKX EIP-6963 provider, RDNS `com.okex.wallet`, `isOkxWallet: true`.
- Clean account: `0x845d…dc3f`. It is separate from the deployment account and was not used for any transaction.
- Connection: explicit `Connect OKX Wallet` flow. The same provider reported X Layer `0xc4` / `196` and the clean account.
- Account-change invalidation: changing from the previously connected account to the clean account cleared readiness and quote state before refresh.
- Wrong-network recovery: the OKX GateX site connection was switched to Ethereum `0x1`. GateX showed `Wrong network 0x1` and kept the wallet-dependent path unavailable. Switching the same site connection back to X Layer restored the wallet state and required a fresh quote.
- Disconnect/reconnect: the app disconnected the clean wallet locally, then reconnected it through the explicit OKX account request. No signature or transaction request was made.
- Earlier quote at block `72534771`, hash `0x002120f1…b22dd2aa`: `0 NAND`, `0 LATCH`, `98 NAND` and `2 LATCH` deficit, lifetime minted `191`, cap `1000000`, mint price `0.000001` OKB, fixed mint fee `0.00066` OKB per mint transaction, tapeout fee `0.0013` OKB, and displayed wallet balance `0.00272` OKB. The current UI labels this value as `PROTOCOL VALUE BEFORE GAS`, shows estimated gas and gas-inclusive total as unavailable, and makes no manufacture sufficiency claim without gas.
- No transaction, signature, approval, mint, manufacture, or OKB spend occurred. The only wallet request used was `eth_requestAccounts`.
- The clean browser ran a live AgentApproval read at block `72534785` with both locked providers and showed a zero-mismatch match against the local AST result. This remains historical evidence.
- The wallet-independent read-only adapter separately verified the real circuit `2` readback and all 256 AgentApproval cases on both providers, for 512 live cases total. Identical state/input arguments produced identical results irrespective of the connected clean account.

## PLAYWRIGHT AUTOMATED UX CHECKS

- Playwright `1.63.0` is installed as a development dependency with `test:e2e` and `test:e2e:headed` scripts.
- Seven browser tests passed. They cover landing to workspace, both examples, editable DSL recompilation, invalid diagnostics, artifact counts, evidence links, stale quotes, LOCAL session restore, source-change invalidation, explicit OKX provider UX, wrong-network and account-change invalidation, disconnect/reconnect, no fallback from live to local, keyboard activation, reduced-motion CSS, and 320px, 390px, and desktop overflow checks.
- The wallet extension is represented by a deterministic injected provider only in wallet-UX tests. The live comparison test uses the two real locked X Layer providers and no wallet mock for its protocol results.
- The Playwright Chromium run uses a test-only browser CORS relaxation so the browser can call the locked public RPC endpoints. This does not change product runtime behavior.

## HISTORICAL GATE D/E EVIDENCE

- AgentApproval artifact: circuit `2`, 98 NAND, 2 LATCH, 100 records, 706-byte local container, 694-byte TapeOut payload, local SHA-256 `d68c9881fbe8bf0fbf7f86cfa92ad2889389e07e09bb0e7f0068f23eded50003`, payload SHA-256 `7e4b5f83032beaf32ce2e7c067f1ee24d08feea1e2db8c64ef7c4d7de231dc45`.
- Real circuit `2` readback at common block `72534360`, hash `0x9a0168fe9736b93d579818a6584fb0fb956c23c8b884c04858197154debceafc` matched the compiled payload and dimensions `(6,1,2,100)` on both locked providers.
- Both providers returned 256 matching live cases for circuit `2`, with zero mismatches per provider and zero provider disagreement.
- Gate C live regression passed after the remediation. TinyApproval stayed at 89 NAND, 2 LATCH, 91 records, 643-byte local container, 631-byte TapeOut payload, and its existing hashes.

## CURRENT-SESSION EVIDENCE RULE

- Current-session `LIVE X LAYER` requires the selected source to match the accepted source identity, deterministic local artifact, expected payload/hash/dimensions, bound processor, bound circuit ID, and a fresh readback from both locked providers.
- A different valid source remains locally compilable and simulatable but is `STALE` and cannot call circuit `1` or `2` or persist live history.
- Provider disagreement or local/live mismatch is `FAILED`. RPC or live-read failure is `UNAVAILABLE`. A valid edited source is `STALE`.
- Gate F wallet behavior is mocked Playwright UX evidence. It is not wallet-signature or transaction evidence.
