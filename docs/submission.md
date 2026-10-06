# GateX submission draft

## Project name

GateX

## One-liner

GateX turns human-readable application state machines into verified TapeOut NAND/LATCH circuits on X Layer.

## Short description

GateX makes application lifecycle logic inspectable after it becomes circuit data. A bounded DSL names states, inputs, guards, resets, terminals, and transition outputs. GateX validates the machine, compiles it deterministically into NAND/LATCH records, proves the artifact with an independent AST interpreter and decoded-netlist simulator, manufactures the exact TapeOut payload, reads the real circuit back, and compares live read-only transitions on X Layer. AgentApproval is the flagship proof. The browser keeps workflow state caller-owned and exposes a clear boundary between local simulation, historical manufacture evidence, and fresh live evaluation.

## Problem

Human-readable approval and lifecycle rules are easy to discuss but difficult to connect to low-level manufactured circuit behavior. The proof is often split between source intent, generated logic, and deployed runtime behavior.

## Solution

DSL → validation → deterministic compile → NAND/LATCH → exhaustive local proof → TapeOut manufacture → readback → live transition comparison

## Why TapeOut

TapeOut is the deployed transition boundary being evaluated. It makes the compiled circuit a concrete, read-only X Layer artifact instead of a diagram or software-only simulation. GateX compares the manufactured result against the independent local proof without presenting `step()` as a state-changing workflow execution.

## Flagship proof

AgentApproval is circuit 2 with 98 NAND, 2 LATCH, and 100 records. It passed 256 unique local cases, 256 cases per locked provider, 512 live evaluations total, and zero mismatches.

## X Layer deployment

- Chain: `196`
- Processor: `0x95aaacaa8aaecf6d215706d3e7fff255a35c59ed`
- Token: `0x62f8409177a511b71ea888beef47b894be1221cb`
- Evidence: [`public/evidence/release.json`](../public/evidence/release.json)

## Repository

https://github.com/AjKadri/GateX

## Demo URL

https://gatex.ajkadri.dev

## Demo video

PENDING FINAL CAPTURE

## Limitations

- Workflow state is caller-owned by the browser.
- GateX makes no replay-proof approval claim.
- GateX makes no identity-authenticated approval claim.
- GateX provides no custody.
- GateX does not execute an AI agent.
- Protocol source and build provenance remain unresolved.

## Run locally

See [`README.md`](../README.md), [`docs/demo-script.md`](demo-script.md), and [`docs/protocol-limitations.md`](protocol-limitations.md).
