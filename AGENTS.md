# GateX Agent Instructions

## Project

GateX turns human-readable application state machines into verified TapeOut NAND/LATCH circuits on X Layer.

AgentApproval is the flagship example, not the product category.

## Authoritative files

Before making changes, read:

1. `docs/BUILD_HANDOFF.md`
2. `protocol/lock.json`
3. `docs/gatex-gate-progress.md`
4. `docs/protocol-limitations.md`

These files override model memory and generic assumptions.

## Protocol source rule

Do not implement TapeOut, X Layer, IGNIX, or OKX protocol behavior from model memory.

Before using any of the following:

- contract addresses
- ABIs
- RPC endpoints
- chain IDs
- TAP/netlist formats
- NAND semantics
- LATCH semantics
- REF semantics
- signal ordering
- processor creation
- transistor supply/cap behavior
- pricing or fees
- burn behavior
- manufacture calls
- `netlist`
- `circuitInfo`
- `step`
- wallet transaction requirements

Consult `protocol/lock.json` and the linked primary evidence.

If documentation, deployed behavior, or the protocol lock conflict:

1. Stop the affected work.
2. Record the conflict.
3. Do not guess.
4. Escalate before changing protocol assumptions.

Do not silently replace pinned information with blog posts, tutorials, old documentation, or model knowledge.

## Known protocol limitations

Current evidence is behavior-verified, not exact-source/build verified.

GateX may claim:

- compilation into TapeOut NAND/LATCH circuits
- exhaustive FSM verification
- real circuit manufacture on X Layer
- circuit readback
- live transition computation
- local/live comparison

GateX may not claim:

- TapeOut stores authoritative application workflow state
- replay-proof approvals
- identity-authenticated approvals
- custody
- agent execution
- protocol contract audits
- protocol immutability
- exact deployed-source verification

Application state is caller/browser managed.

Use “live transition computation” or “live circuit evaluation” for read-only `step()` calls.

Do not describe `step()` as an on-chain state-changing execution.

## Build discipline

Implement the build gates in order.

Do not skip ahead to polished UI before the compiler proof passes.

### Gate A

Compiler semantics.

### Gate B

TinyApproval exhaustive local proof.

### Gate C

Protocol adapter and candidate simulation.

### Gate D

First real GateX manufacture.

### Gate E

AgentApproval flagship.

### Gate F

Product flow and clean-wallet checks.

### Gate G

Submission freeze.

If a hard gate fails, diagnose it before continuing downstream.

## First implementation target

The first compiler proof is `TinyApproval`:

```text
LOCKED -> READY -> USED
```

It must pass all 32 encoded-state/input combinations exactly as defined in `docs/BUILD_HANDOFF.md`.

No wallet transactions, processor creation, polished frontend, or real manufacture should happen before Gates A and B pass.

## Scope control

Locked MVP:

- bounded FSM DSL
- deterministic compiler
- independent interpreter
- NAND/LATCH lowering
- decoded-netlist simulator
- exhaustive verification
- TinyApproval
- AgentApproval
- real processor
- tiny and flagship manufacture
- readback
- live comparison
- evidence export
- caller-owned state/session
- static frontend
- documentation and demo

Optional only after the core passes:

- one REF demonstration

Do not add:

- custody
- escrow settlement
- replay-proof approval claims
- actual agent execution
- arbitrary HDL
- AI-generated logic
- marketplace
- backend database
- indexer
- arbitrary REF nesting
- speculative token mechanics

## Correctness rules

Never show success before receipt and readback.

Never silently fall back from live comparison to local simulation.

Clearly distinguish:

- `LOCAL SIMULATION`
- `LIVE X LAYER`
- `HISTORICAL EVIDENCE`

Compilation must be deterministic.

The independent FSM interpreter must not reuse compiler equations or the lowered NAND graph.

Protocol calculations must use integer wei arithmetic.

Never automatically spend beyond the approved network budget.

## Repository safety

Before modifying files:

- confirm the actual GateX repository root
- read existing instructions
- inspect existing work
- do not initialize inside an unrelated parent repo
- do not overwrite unrelated files

Do not commit:

- credentials
- private keys
- `.env`
- internal scratch research
- raw private traces
- machine-specific secrets

## Engineering principle

Continue until the work is done properly.

Treat failed attempts as information, investigate the cause, consult the best available evidence, and proceed only when the next step is justified.

Do not design around expected failure.

Do not claim success when required checks are deferred or incomplete.

## Commits

Use Conventional Commits after verified milestones.

Run targeted tests during development.

At major gates run:

- full tests
- typecheck
- relevant protocol checks
- production build where applicable

Record deviations from the handoff explicitly.