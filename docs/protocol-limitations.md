# GateX protocol limitations

This page lists what GateX has and has not verified about the TapeOut protocol on X Layer.

## Evidence and provenance

- The protocol lock (`protocol/lock.json`) is behavior-verified for the listed read-only checks. Exact deployed source, compiler rebuild, optimizer settings, and source/build provenance remain unresolved.
- Runtime hashes and metadata CIDs are recorded for the sampled factory, circuit, transistor, processor, and transistor proxy identities. Metadata retrieval and exact source recovery were unsuccessful.
- The factory remains unsealed in the recorded evidence. Runtime identity checks do not establish immutability, audit status, or exact deployed-source verification.

## Format and semantic scope

- TAP-02 is recorded as a Draft. The lock records bounded core conformance and does not record full X Layer conformance.
- The sampled semantics identify NAND opcode `0x00`, LATCH opcode `0x01`, big-endian u24 signal indices, LSB-first vector packing within a byte, and outputs as the last produced signals.
- The lock covers the sampled NAND, one-latch, multi-bit, and checked REF behavior listed in the evidence. It does not establish universal netlist, state, calldata, gas, REF depth, expanded-gate, or resource limits.
- The client bounds in `protocol/lock.json` are safety limits for GateX. They are not protocol limits.

## State and authority

- `eval` and `step` compute from caller-supplied state and inputs. They do not establish an authoritative protocol-owned FSM state.
- No authoritative persistent `beat` consumer, state storage path, reset authority, replay protection, identity authentication, custody, or asset enforcement was established for this MVP.
- `step()` is read-only. It computes a transition and changes nothing on chain. GateX describes it as live transition computation or live circuit evaluation, not as state-changing on-chain execution.
- Application or caller state is replayable and remains outside the protocol-owned persistence boundary.

## REF and composition

- REF is optional after the core compiler proof. The checked fixtures do not establish arbitrary nesting, unlimited depth, resource-free reuse, or universal composition limits.
- The real REF parent and child recorded in the lock are diagnostic fixtures, not GateX-manufactured circuits.

## Economics and transactions

- The observed fees, prices, caps, balances, and gas values in the lock file are historical samples, not current transaction quotes or GateX issuance decisions. GateX's own transistor terms are in the [README table](../README.md#on-x-layer).
- The sampled processor was sold out. Any future transaction requires refreshed getters, exact call simulation, current balances, reviewed values, and explicit wallet and budget approval.

## Claim boundary

GateX provides deterministic compilation, local exhaustive verification, read-only live comparison where independently checked, and the listed behavior-verified protocol boundary. GateX does not provide protocol immutability, exact deployed-source verification, authoritative workflow state, replay-proof approvals, identity-authenticated approvals, custody, agent execution, or a protocol contract audit.
