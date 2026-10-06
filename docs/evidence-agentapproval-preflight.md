# AgentApproval read-only preflight evidence

The AgentApproval read-only preflight, run before any transaction was sent, passed at common block `72524344`, hash `0xe6ecf5fa27b249ca2ab0f09fd51270a3b21f9fb387fd85c0b4d7c63586bcc5dc`.

The exact AgentApproval source compiled through the generic GateX parser and compiler to:

- 98 NAND
- 2 LATCH
- 100 records
- 706-byte local container, SHA-256 `d68c9881fbe8bf0fbf7f86cfa92ad2889389e07e09bb0e7f0068f23eded50003`
- 694-byte headerless TapeOut payload, SHA-256 `7e4b5f83032beaf32ce2e7c067f1ee24d08feea1e2db8c64ef7c4d7de231dc45`
- dimensions `(6,1,2)`

Both locked providers, `https://rpc.xlayer.tech` and `https://xlayer.drpc.org`, agreed on chain 196, the common block, all 8 locked runtime identities, canonical processor/token linkage, metadata, inventory, fees, and sender state. The sender was the deployment wallet `0x9fa5db29dfc46e9bfdde271e44364d4ba64244c4` with nonce 5 and balance `46046251677862584` wei.

The live `SIMULATION` candidate proof compared 256 state/input cases per provider, 512 total, across the independent AST interpreter, decoded local netlist simulator, and read-only `step()` boundary. Both providers returned simulated circuit ID 2 and zero mismatches. No transaction or wallet signature was requested.

The REVOKED differentiation kill-test rejected the overlapping guard with the witness `REQUESTED with approve=1, human_ok=1, scope_ok=1`. The disjoint variant compared 512 local cases with zero mismatches.

Current deficits are 98 NAND and 2 LATCH. The exact read-only mint simulations passed with gas estimates 92,951 and 92,986. The exact read-only tapeout simulation passed with gas estimate 510,113. Projected mandatory manufacture spend is `2749234100000000` wei, projected cumulative spend is `18702982422137416` wei, and projected remaining balance is `43297017577862584` wei. The 0.05 OKB ceiling and 0.01 OKB contingency both remain satisfied.

No state-changing transaction had been sent at the time of this preflight.
