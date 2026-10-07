# GateX walkthrough

Live workspace: https://gatex.ajkadri.dev

A visit takes about three minutes. Step 4 needs an OKX wallet on X Layer; everything else is read-only.

1. Start on Overview. GateX turns human-readable application state machines into verified TapeOut NAND/LATCH circuits on X Layer.
2. Open Workspace and pick the AgentApproval example or one of the five templates. The compile result shows the gate counts and hashes, and the verification chain shows the full check: every state and input case matches the source (256 of 256 for AgentApproval).
3. For the example, click **1. Read circuit from X Layer** and **2. Compare live transition** to compare real circuit 2 with the local result.
4. Edit the rule if you like; the check runs again for the new bytes, and a rule that does not match its own circuit cannot be taped out. Connect the wallet and tape out. There are up to three confirmations: buy NAND transistors, buy LATCH transistors, manufacture the circuit. GateX never holds funds and shows the exact cost first.
5. The verified card shows that the bytes on chain match your compile. Click **Copy verification link**.
6. Open Circuits. Your circuit is at the top, labelled as a byte-identical match to your rule. Open the copied link in another browser to see the rule load and be checked against the circuit.
7. Open Evidence for the historical manufacture records, payload hashes, live transistor prices and the current-session evidence boundary.

GateX is not an AI agent execution or custody product. Before any live check has been run the cards read `NOT RUN`. If a fresh readback fails, the result is labeled `UNAVAILABLE` and the recorded `HISTORICAL EVIDENCE` section is shown instead of local results.
