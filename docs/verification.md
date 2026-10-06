# Verification model

GateX keeps compilation, local proof, protocol readback, and live evaluation as separate evidence layers.

## Independent local path

The AST interpreter evaluates the validated machine directly. It selects a transition from the old state and current input assignment, computes transition-pulse outputs from that same old state, and returns the next state.

The compiler uses a separate lowering path. Boolean expressions are normalized, converted into deterministic truth functions, lowered to NAND records, and connected to LATCH records for the state bits. The decoded-netlist simulator evaluates serialized NAND/LATCH records independently of the AST interpreter. The two local paths are compared exhaustively.

Compilation is deterministic. The local container and headerless TapeOut payload are serialized in canonical order and hashed before any protocol operation. The TapeOut payload excludes the local container header.

## Protocol boundary

Candidate evaluation uses the locked read-only protocol adapter and the recorded transient-fixture method. Manufactured evaluation uses the canonical processor, fresh circuit readback, and the locked `step()` surface. Readback checks the circuit ID, owner where applicable, dimensions, payload identity, and processor binding from both locked providers at a common block.

`step()` is live transition computation. It is a read-only call and is not an on-chain state-changing workflow execution.

## Evidence states

- `LOCAL SIMULATION` means the AST interpreter or decoded local netlist ran without a provider call.
- `HISTORICAL EVIDENCE` means a previously verified manufacture, readback, or live comparison record.
- `LIVE X LAYER` is reserved for a fresh current-session readback and live step from both locked providers.
- A valid source edit stays locally compilable but becomes stale and cannot use the selected manufactured circuit binding.
- Provider disagreement or a local/live mismatch is `FAILED`.
- RPC or live-read failure is `UNAVAILABLE`.

## Accepted artifacts

### TinyApproval, circuit 1

TinyApproval has 89 NAND records, 2 LATCH records, 91 total records, a 643-byte local container, and a 631-byte TapeOut payload. The payload SHA-256 is `7ec1ed9fe2e0c5f92a45b2ad49fe3da969c109f01522d8306fe127aba76cabac`, with dimensions `(3,1,2,91)`. Its 32 encoded state/input cases matched through the independent local paths and both locked-provider evaluations with zero mismatches.

### AgentApproval, circuit 2

AgentApproval has 98 NAND records, 2 LATCH records, 100 total records, a 706-byte local container, and a 694-byte TapeOut payload. The local SHA-256 is `d68c9881fbe8bf0fbf7f86cfa92ad2889389e07e09bb0e7f0068f23eded50003`. The payload SHA-256 is `7e4b5f83032beaf32ce2e7c067f1ee24d08feea1e2db8c64ef7c4d7de231dc45`, with dimensions `(6,1,2,100)`. All 256 cases matched per locked provider, for 512 live comparisons and zero mismatches.

## Provenance boundary

The protocol lock records behavior-verified facts and unresolved provenance warnings. These results do not establish exact deployed-source verification, protocol immutability, authoritative workflow state, replay-proof approvals, identity-authenticated approvals, custody, agent execution, or a protocol contract audit. Application state remains caller-owned by the browser.

## Release revision

`public/evidence/release.json` keeps `releaseRevision` at `6fb16e3`, the revision of the frozen application and release content, because later commits changed only documentation and metadata.
