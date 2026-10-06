# GateX walkthrough

Live workspace: https://gatex.ajkadri.dev

A visit takes about two minutes.

1. Start on Overview. GateX turns human-readable application state machines into verified TapeOut NAND/LATCH circuits on X Layer.
2. Open Workspace. The AgentApproval source is loaded and editable. It uses the same generic GateX language path as TinyApproval.
3. The named-state diagram shows `IDLE → REQUESTED → APPROVED → USED`.
4. The compile result shows 98 NAND, 2 LATCH, 100 records, and the deterministic local and TapeOut hashes.
5. The exhaustive proof result shows 256 / 256 cases matched.
6. Click **1. Read circuit from X Layer** to read real circuit 2 back through two providers. The page shows the circuit ID, dimensions `(6,1,2,100)`, payload identity, owner, and processor binding.
7. Select a state and input combination and click **2. Compare live transition**. The local result appears beside the LIVE X LAYER result.
8. The browser owns the application session state. TapeOut computes a transition and does not store the workflow.
9. Open Evidence to see the historical manufacture records, payload hashes, transaction references, and the current-session evidence boundary.

This is a read-only verification workspace. It is not an AI agent execution, wallet transaction flow, or custody product. Before any check has been run the cards read `NOT RUN`. If a fresh readback fails, the result is labeled `UNAVAILABLE` and the recorded `HISTORICAL EVIDENCE` section is shown instead of local results.
