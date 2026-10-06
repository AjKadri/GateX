# GateX demo script

Target duration: 90 to 150 seconds.

1. Start on Overview and say: “GateX turns human-readable application state machines into verified TapeOut NAND/LATCH circuits on X Layer.”
2. Open Workspace and point to the editable AgentApproval source. Explain that it uses the same generic GateX language path as TinyApproval.
3. Show the named-state diagram: `IDLE → REQUESTED → APPROVED → USED`.
4. Show the compile result: 98 NAND, 2 LATCH, 100 records, and the deterministic local and TapeOut hashes.
5. Point to the exhaustive proof result: 256 / 256 cases matched.
6. Refresh the current dual-provider readback for real circuit 2. Show the circuit ID, dimensions `(6,1,2,100)`, payload identity, owner, and processor binding.
7. Select one state and input combination, run the read-only live transition, and show the local result beside the LIVE X LAYER result.
8. Explain that the browser owns the application session state. TapeOut computes a transition and does not store the workflow.
9. Open Evidence and show the historical manufacture records, payload hashes, transaction references, and the current-session evidence boundary.

Keep the demo read-only. Do not present it as an AI agent execution, wallet transaction flow, or custody product. If a fresh readback is unavailable, leave the result labeled `UNAVAILABLE` and use the recorded `HISTORICAL EVIDENCE` section rather than substituting local results.

## Final capture checklist

- Use a clean browser session on the correct production domain.
- Keep developer tools closed unless they are needed to explain a read-only result.
- Confirm AgentApproval is loaded and the named-state diagram is visible.
- Confirm fresh circuit 2 readback succeeds before running the live transition.
- Show one successful local/live transition match.
- Open the Evidence route and confirm transaction links work.
- Keep the caller-owned-state disclosure visible.
- Do not show local development URLs, wallet signing, or deployment controls.
