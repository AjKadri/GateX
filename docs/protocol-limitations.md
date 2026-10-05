# GateX protocol limitations

This document records the established limits in the GateX handoff and protocol lock. It does not expand the protocol claims.

## Evidence and provenance

- The current lock is behavior-verified for the listed read-only checks. Exact deployed source, compiler rebuild, optimizer settings, and source/build provenance remain unresolved.
- Runtime hashes and metadata CIDs are recorded for the sampled factory, circuit, transistor, processor, and transistor proxy identities. Metadata retrieval and exact source recovery were not accepted.
- The factory remains unsealed in the locked evidence. Runtime identity checks do not establish immutability, audit status, or exact deployed-source verification.

## Format and semantic scope

- TAP-02 is recorded as a Draft. The lock records bounded core conformance and explicitly does not record full X Layer conformance.
- The locked sampled semantics identify NAND opcode `0x00`, LATCH opcode `0x01`, big-endian u24 signal indices, LSB-first vector packing within a byte, and outputs as the last produced signals.
- The lock covers the sampled NAND, one-latch, multi-bit, and checked REF behavior listed in the evidence. It does not establish universal netlist, state, calldata, gas, REF depth, expanded-gate, or resource limits.
- The client bounds in `protocol/lock.json` are safety limits for GateX. They are not protocol limits.

## State and authority

- `eval` and `step` compute from caller-supplied state and inputs. They do not establish an authoritative protocol-owned FSM state.
- No authoritative persistent `beat` consumer, state storage path, reset authority, replay protection, identity authentication, custody, or asset enforcement was established for this MVP.
- GateX must describe read-only `step()` behavior as live transition computation or live circuit evaluation. It must not describe it as an on-chain state-changing execution.
- Application or caller state is replayable and remains outside the protocol-owned persistence boundary.

## REF and composition

- REF is optional after the core compiler proof. The checked fixtures do not establish arbitrary nesting, unlimited depth, resource-free reuse, or universal composition limits.
- The real REF parent and child recorded in the lock are diagnostic fixtures, not GateX-manufactured circuits.

## Economics and transactions

- The observed fees, prices, caps, balances, and gas values are pinned samples, not current transaction quotes or GateX issuance decisions.
- The sampled processor was sold out. Any future transaction requires refreshed getters, exact call simulation, current balances, reviewed values, and explicit wallet and budget authorization.
- The protocol lock records that funds-writing authorization is false for this work. Gate C is read-only and must not create processors, mint transistors, manufacture circuits, or request signatures.

## Claim boundary

GateX may claim deterministic compilation, local exhaustive verification, read-only live comparison where independently checked, and the listed behavior-verified protocol boundary. GateX may not claim protocol immutability, exact deployed-source verification, authoritative workflow state, replay-proof approvals, identity-authenticated approvals, custody, agent execution, or a protocol contract audit.
