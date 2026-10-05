# GateX gate progress

Updated October 5, 2026 Africa/Lagos. This report extends existing research only. Historical-context reconciliation is complete. Latest decision: CONDITIONAL GO for a tiny NAND/LATCH FSM compiler with caller-owned state. Earlier NO-GO entries below are historical. The final bounded protocol pass follows at the end.

## Newly completed checks

Read-only checks used X Layer block 72,385,471 (`0x45083bf`), timestamp October 4, 22:55:07 UTC (23:55:07 Lagos), hash `0x4731c2916c6607b72d3e7920c8a34fedc211b293bcbcbbd0c99b1ba9c0ebb559`. Both providers returned chain 196 and the same block hash.

The two existing Interlock netlists were decoded from live reads and evaluated locally using candidate NAND/LATCH semantics. Circuit 1: all four inputs. Circuit 2: all 16 inputs for both state-bit values. Both providers matched all 36 cases, giving 72 passing evaluation calls and no mismatch. These are 36 unique cases, not 72 distinct behaviors. `eval` on circuit 2 reverted with `has latch: use step`; nonexistent circuit metadata reverted with `no circuit` on both providers.

This supports sample conformance for constants, packed low bits, NAND, one latch, forward latch feedback and current output/next-state separation. It does not prove general X Layer semantics, multi-byte padding, multiple latch layout, REF, gas/resource ceilings or persistent state ownership. Diagnostic hashing was checked against three known selectors and the known empty Keccak digest. No third-party runtime dependencies were installed.

## Fees and sampled processor state

| Getter | Observed value |
|---|---|
| Factory deployment fee | 6,600,000,000,000,000 wei = 0.0066 OKB |
| Factory protocol fee getter | 660,000,000,000,000 wei = 0.00066 OKB |
| Circuit tapeout fee | 1,300,000,000,000,000 wei = 0.0013 OKB |
| Interlock mint-price getter | 660,000,000,000,000 wei = 0.00066 OKB |
| Interlock protocol-fee getter | 660,000,000,000,000 wei = 0.00066 OKB |
| Interlock supplyCap and minted | Both 10,000 |

All getters agree across providers. The meaning of protocolFee in payment accounting, whether supply is aggregated across IDs, and whether burns restore capacity remain unverified. Equal cap/minted values do not resolve those questions. These are sampled Interlock values, not GateX issuance choices. Getter values alone are not a total transaction quote.

## Newly locked linkage and runtime identities

The sampled processor's ERC-1967 beacon slot points to the previously identified circuit beacon. Its `factory()` points to the expected factory. Its `transistors()` points to `0xd1ce3f46479379b2844cc8513afab96e4f6b48fb`; that token contract's `circuits()` points back to the processor. The token's beacon slot identifies `0x1059ad62cabb6a6925bb65aa617300556c60a51b`, whose implementation is `0x265bf10fab9ddec0ee0a649c6b9db845f1b9a06b`. Factory implementation and circuit beacon implementation were re-read at this newer pin. Both beacon owners are the factory. The factory remains unsealed.

| Runtime | Byte count | Keccak-256 |
|---|---:|---|
| Factory implementation | 7,671 | `0x7fb15e83f925e493ef6e84ee3b1021eed994966552add6011184a1fb3ad7fe81` |
| Circuit implementation | 12,562 | `0x7a15c353205e5245f40f5f5524542a982a4bb3b9a28476e4f10845163f941b30` |
| Transistor implementation | 9,265 | `0x7fa762458d81355706c09e46f4286f61d99fee10a832f21c9fa3317b658e17e9` |

Runtime hashes identify code; they do not establish reviewed source or build provenance. Linkage is proven for the sampled processor, not every factory deployment path. The complete graph/source gate is partially closed, not complete.

## Focused provenance search and remaining gates

The deployment draft TAP-10 at the existing pinned repository revision was fetched to cross-check its address register. It adds no verified X Layer execution source. The protocol author's public repository list exposes TAPs, TapeKit and list. TapeKit contains DeWEB contracts, not the missing core circuit/transistor implementation source. Interlock's public repository contains only its README. A targeted exact-address/source search returned no results. Routescan reports chain 196 unsupported. The previous Sourcify no-match and explorer limitations remain unresolved. None of these prove source is absent everywhere or the contract is unsafe.

| Gate | Current state | Next bounded acceptance check |
|---|---|---|
| U01 context | Closed for supplied historical summary | No repeat research |
| U03 graph/source | Sample linkage and runtime hashes passed; source provenance open | Obtain exact X Layer core sources/build settings and reproduce deployed code, including factory deployment configuration |
| U04 semantics | NAND and one-latch sample passed | Multi-bit state/packing cases and an existing stateful REF fixture, locked to the actual implementations |
| U05 economics | Live sampled getters passed; accounting open | Source-backed token IDs, cap/minted/burn, authority and payment math; read-only exact-call simulations |
| U06 fees/resources | Deployment and tapeout getters passed; ceilings open | Gas/cost simulation for bounded demo and REF expansion |
| U07 persistence | Open | Locate reviewed state owner/beat path, prove initialization, sender/owner authority and replay behavior |
| U08/U12 product | Original FSM wedge confirmed; benefit not measured | Same unseen task through closest existing authoring workflow, with explicit time/errors/output comparison |

If source provenance cannot be obtained, do not replace it with black-box tests and call the source lock complete. A preview-only revision or non-REF revision needs an explicit scope decision and another kill-test. No own deployment, mint, burn, state-changing beat or outreach occurred.

Raw evidence is preserved in ignored work files `protocol-probe-results.json` (124 RPC responses), `protocol-linkage-results.json` (12 responses), and their read-only diagnostic scripts. Product tests, typecheck/build, transaction simulations, independent implementation review and release checks remain deferred.

## Exact metadata recovery target

All three runtime trailers contain Solidity CBOR metadata with compiler bytes `00 08 18` (0.8.24) and IPFS multihashes. The derived metadata CIDs are recorded in the [partial machine-readable lock](gatex-protocol-lock.partial.json). Runtime-embedded references identify expected metadata, not retrieved or reviewed source. General gateways ipfs.io and dweb.link returned HTTP 429 for each CID; ipfs.sourcify.dev did not resolve. No metadata response was accepted and no source was fabricated.

Source recovery now needs the exact factory, circuit and transistor metadata JSON identified by those CIDs, plus the source contents/build settings they reference. Validate content commitments, reproduce runtime bytecode with the recorded compiler/settings and inspect relevant semantics. A hash match alone is not source review. This is the bounded next step for U03/U05/U07. The partial lock intentionally says NO-GO.

This paragraph describes the earlier gate policy. The user's latest exit criteria permit behavior-only CONDITIONAL GO when source recovery is unresolved but the tiny core is experimentally supported. The current lock and final decision below supersede the earlier blanket NO-GO.

Evidence consistency check: 67 paired read identities agree across providers when block objects are compared on the block hash and results/reverts on returned bytes. This includes evaluation calls and linkage checks. JSON key order differences in provider block objects are not a semantic mismatch.

## Final bounded protocol pass

Behavior snapshot: X Layer block 72,414,363 (`0x450f49b`), October 5 at 06:56:39 UTC / 07:56:39 Lagos, hash `0x2d33a71f3db5f7eea51af99d17ac7a255bb948a195dde59bf3e2be36363c7b83`. Both providers agree on results used below. All three implementation runtime hashes match the earlier lock at this newer pin. Raw RPC responses and traces are preserved locally. No transaction was signed or broadcast.

### A. Exact source provenance

The existing OKLink/Sourcify limitations were not repeatedly retried. Four additional independent circuit-metadata routes were attempted with short timeouts: Pinata timed out, Lighthouse returned HTTP 402, w3s.link returned HTTP 429, and Filebase timed out. Earlier IPFS gateways returned 429 and the verification gateway failed DNS. No metadata/source file was retrieved or accepted. No Swarm field exists in the three examined implementation trailers. Exact metadata/source hashes and optimizer settings cannot be recovered from a CID alone. Compiler bytes identify 0.8.24, not the complete compiler binary/build configuration. No source rebuild was run or matched.

Important diagnostic correction: Solidity's embedded IPFS commitment is the CID produced by IPFS import, not the plain SHA-256 of the metadata JSON. The earlier retrieval helper used the wrong proposed acceptance comparison, but accepted no file, so it created no false verification. It now explicitly leaves retrieved files unverified pending CID authentication. [Solidity metadata documentation](https://docs.soliditylang.org/en/latest/metadata.html).

Factory, circuit and transistor implementations are classified VERIFIED BEHAVIOR ONLY for the listed tests, with exact source/build provenance UNRESOLVED. This does not mean audited, verified-exact source, immutable code or general security certification. Core dependency identities, code hashes and metadata CIDs remain locked. Full source verification is required before any verified-source claim, and remains a risk to review before public fund-facing release.

### B. REF

A bounded search read 22 existing netlists from three X Layer processors and found 13 REF parents. The reproducible real fixture is processor `0x0565ea48ca41ae559d8d491dbb0a9ec945db551b`, circuit 1, referencing `0xf044d395c91e77459e6b2155015e14f0dd9b349f`, circuit 102. The parent is a 31-byte zero-input/one-output REF record. Child and parent have two state bits and expanded gate count 10. All four parent state combinations match the local recursively decoded model on both providers, eight passing calls. These are actual deployed circuits, not newly manufactured GateX artifacts.

Record addressing is opcode 02, 20-byte processor address, big-endian u64 ID, one-byte input/output arity, then big-endian u24 signal indices. Additional transient manufacture tests mapped a parent's inputs `[2,3]` into existing AND circuit 1 and matched all four inputs. A REF to existing stateful circuit 2 matched all 32 state/input cases on each provider. Traced REF-only manufacture changed no transistor balance, even though expanded metadata includes the child gates. Thus no referenced NAND/LATCH was burned again in those simulations.

A simulated parent referencing the real parent above exercised depth-two REF and matched all four states on each provider. No hard depth cap was established. Creation-time registered-target checks and backward input ordering are visible in runtime/revert behavior. Existing real fixture has zero inputs, so nonzero input mapping and depth-two manufacture remain simulation-only proofs. No own REF circuit was deployed.

REF is removed from the first compiler proof's critical path. Optional later integration is limited to the tested format and a checked dependency closure. No claim of arbitrary nesting, depth independence or resource-free reuse is allowed.

### C. Persistence and authority

`step(id,state,inputs)` calculates `(nextState,outputs)` from supplied state. Two different caller addresses returned identical results for identical arguments. `eval` and `step` pre/post traces show no circuit, processor or token storage writes. The trace transaction envelope can show a synthetic sender nonce change; that is not persistent FSM state. Short vectors are zero-filled and extra/high padding bits ignored in the tested samples. GateX must enforce canonical lengths and padding itself.

The examined circuit/factory/transistor dispatchers have no `beat(address,uint256,bytes)` selector. Direct calls to that selector on the sampled processor and transistor contract revert. No authoritative X Layer beat consumer was identified. The draft's beat statement cannot be assigned to this processor. No persistent execution-state storage slot, reset method or persistence event is established for it.

Multiple callers can independently calculate transitions with separate supplied state vectors. The frontend/application must carry prior state. A reset is a defined FSM transition or application state reset, not proof of an exclusive chain reset. An external consumer could persist state, but that path is outside this MVP. GateX wording must say it compiles and verifies transition logic, with caller/application-owned execution state. It must not promise authoritative persistence, replay-proof approvals or asset enforcement.

### D. Transistors and manufacture economics

NAND is ERC-1155 ID 0 and LATCH is ID 1, confirmed by getters. The sampled transistor contract uses one aggregate lifetime `minted` counter (slot 6) and `supplyCap` (slot 5), not independent per-ID caps. Mint traces for both IDs increment the same counter. Current values are 10,000/10,000, and an unmodified mint reverts `supply cap`. Mint tests below restore capacity only inside read-only overrides. Burn traces do not decrement this counter, so burning does not restore sampled mint capacity.

Payment is native OKB, with 18-decimal wei units. Both asset IDs share the sampled mint-price getter P = 660,000,000,000,000 wei. F = 660,000,000,000,000 wei is a fixed fee per mint call, not per asset. The exact minimum for a call minting q assets is `q*P + F`. q=1 and q=2 exact thresholds passed; one wei below failed. Token ID 2 and zero quantity revert. Overpayment is credited to the caller's `owed` mapping, not automatically returned. Creator proceeds q*P and fixed protocol fee F accrue as withdrawable credits.

Creator recipient is `0xe13a4ca61a0f3f72709668be265856180f1469c4`. Protocol credits accrue to `0x571d447f4f24688ec35ccf07f1d6993655f6af15`, stored in slot 2; its credit is in the address-keyed mapping rooted at slot 7. Factory deployment fee 0.0066 OKB accrues to that same recipient in a mapping rooted at factory slot 8. Tapeout fee 0.0013 OKB is transferred to `0xebecedea36e598b64e17f8d519eb77441c539f76`. Mint/factory fee credits remain in their respective contracts until withdrawal. These recipient identities and deltas come from traces/storage, not inferred names.

Each top-level NAND consumes one ID-0 asset and each LATCH one ID-1 asset. Traces call `burnFrom(owner,id,count)` (`124d91e5`) from the processor. An unrelated caller reverts `only circuits`; the bound processor is accepted. The sampled owner has no ERC-1155 operator approval for the processor, yet traced manufacture succeeds. Unused assets remained transferable through successful owner-initiated `safeTransferFrom` simulations for both IDs. No public mint-price setter was established. Price mutability and privileged reinitialization are not source-verified, and the upgradeable beacon can change behavior. Refresh getters and code identities before any concrete wallet call.

Worked examples use sampled values, not selected GateX issuance values. This existing processor is sold out, so these mint costs describe a newly available processor with the same parameters or an explicitly simulated capacity override. Secondary acquisition prices are unknown.

Example A: hand-written two-bit counter transition fixture uses 9 NAND + 2 LATCH. Buying exact requirements through two mint calls costs `11*P + 2*F = 0.00858 OKB`. Tapeout adds 0.0013, total 0.00988 OKB plus gas. A new processor adds 0.0066, giving 0.01648 OKB plus gas. Exact purchases leave zero unused assets. Buying 12 NAND + 3 LATCH instead costs 0.01122 for minting, then 0.0013 tapeout, leaving 3 NAND + 1 LATCH transferable. These are arithmetic examples supported by tested pricing/consumption, not a mainnet quote.

Example B: two independent copies of that fixture require 18 NAND + 4 LATCH, four mint calls and two tapeouts: 0.01976 OKB plus gas. Manufacturing the child once and a REF-only parent requires 9 NAND + 2 LATCH, two mint calls and two tapeouts: 0.01118 OKB plus gas, saving 0.00858 OKB in that workflow. If the child already exists and is reusable, the REF-only parent's tested manufacture consumes no transistor and pays only 0.0013 OKB plus gas. REF adds evaluation/dependency work and does not imply lower execution gas.

### E. Limits and measured scope

| Label | Finding |
|---|---|
| HARD PROTOCOL LIMIT | Inputs above 65,536 and outputs above 65,536 revert `too many pins`. 65,536 inputs with a constant-output design passed simulated manufacture. Outputs also require enough produced signals; zero outputs revert |
| HARD PROTOCOL RULE | NAND future references and out-of-range LATCH D references revert. Unknown opcode reverts. ID/record widths constrain representation; no measured universal record/netlist/state cap was established |
| CHAIN/GAS PRACTICAL LIMIT | Observed block gas limit is 210,000,000 at the pin. This is not a guaranteed per-transaction or RPC ceiling. Exact caller/provider estimates still govern |
| MEASURED SAMPLE | Two-NAND AND tapeout estimate 218,089 gas. One-NAND/one-LATCH toggle 229,454. 512 NAND / 3,584 netlist bytes 1,672,417. Eight LATCH 226,458. Estimates depend on storage, call data and current configuration |
| MEASURED SAMPLE | Evaluation of the transient 512-NAND fixture estimates 1,222,889 gas. Eight-latch step estimates 74,064 and correctly preserves old output byte A5 while returning next-state FF |
| CLIENT SAFETY LIMIT | Core proposal remains at most 8 inputs, 8 states/3 state bits, 4 outputs, 512 total top-level NAND/LATCH records. Without REF that is at most 3,584 netlist bytes. Require exact per-artifact simulation and a provisional 3,000,000 gas safety ceiling for manufacturing/evaluation; reject unavailable/over-budget estimates |
| UNKNOWN | Universal netlist/state/depth/expanded-gate/calldata caps, transaction gas ceiling, worst-case evaluation bound and beat limits are not established. Do not label the client bounds protocol limits |

The 512-record measurement is one fixture, not a worst-case proof for every 512-record circuit. The first coding proof is smaller and must verify its own serialized behavior and gas. GateX should reject unsupported features before wallet prompts.

Final provenance inventory also records five proxy/beacon runtime hashes and metadata CIDs at this pin. All match across providers. Compiler trailers identify 0.8.24 for those records. Optimizer/source/rebuild fields remain null or empty rather than inferred. Empty beat reverts are represented differently by providers: one includes data `0x` and the other omits data. Both reject the call, but absent data is not proof of byte-identical revert payload. Other paired behavior results used for the stated checks agree.

## Exit decision

CONDITIONAL GO for a deterministic tiny NAND/LATCH FSM compiler, independent specification interpreter, canonical serializer, local exhaustive verification and pinned read-only chain comparisons. Manufacture integration may be developed around simulated calls, with every real transaction still requiring current exact simulation, reviewed values, wallet/budget authorization and recorded receipts.

Locked behavior includes small NAND/LATCH evaluation, two-bit state transition timing, low/high bit packing within one byte, exact sampled burn/fee accounting, ordinary transfers, creation linkage and basic REF composition. Exact source/build verification, general REF/depth limits and external persistent consumers remain unresolved but do not invalidate the core transition compiler.

Removed from critical MVP: protocol-owned persistent execution, custody/asset enforcement, replay-proof approvals, arbitrary REF/nesting and generic formal-security claims. Checked REF can be added after the core proof but is not a start condition.

First technical proof to code next: a three-state LOCKED → READY → USED machine with authorize/execute/reset inputs, explicitly prioritized reset, one transition per step, invalid encoding routed safely to LOCKED with zero authorization, and authorization asserted only for READY+execute without reset. Compare an independent table interpreter with decoded NAND/LATCH bytes over all 4 encoded states × 8 input combinations = 32 cases, then test sequential traces. Manufacture/evaluate only through read-only simulation first. No UI, custom persistence contract or mainnet transaction belongs in that first milestone.

Passed in this pass: existing deployed two-state-bit REF fixture (8 provider evaluations), transient counter (8), input-mapped stateless REF (8), stateful REF (64), nested REF (8), exact mint thresholds/authority checks, simulated factory/tapeout paths and listed gas measurements. Real deployment receipts, full source rebuild, product tests/typecheck/build, independent implementation review and release verification remain deferred. Research diagnostics are not shipped product code.
