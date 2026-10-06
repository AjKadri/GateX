# GateX

GateX turns human-readable application state machines into verified TapeOut NAND/LATCH circuits on X Layer.

Application intent is easy to explain and difficult to audit once it becomes low-level circuit data. GateX keeps the named states and guards visible, compiles them deterministically, proves the result through an independent interpreter and decoded-netlist simulator, then compares the manufactured circuit through the read-only protocol boundary.

The public product is a verification workspace. TapeOut is structurally part of the workflow because it is the deployed transition boundary being evaluated. Application state remains caller-owned in the browser, and TapeOut does not store an authoritative workflow state.

## Verified release

The canonical X Layer deployment is on chain 196:

- Processor: `0x95aaacaa8aaecf6d215706d3e7fff255a35c59ed`
- Transistor token: `0x62f8409177a511b71ea888beef47b894be1221cb`
- Creator: `0x9fa5db29dfc46e9bfdde271e44364d4ba64244c4`
- Project spend: `18687009842800492` wei (`0.018687009842800492` OKB)
- Remaining under the `0.05` OKB ceiling: `31312990157199508` wei

TinyApproval is circuit 1 with 89 NAND, 2 LATCH, 91 records, a 643-byte local container, and a 631-byte TapeOut payload. Its payload SHA-256 is `7ec1ed9fe2e0c5f92a45b2ad49fe3da969c109f01522d8306fe127aba76cabac`.

AgentApproval is circuit 2 with 98 NAND, 2 LATCH, 100 records, a 706-byte local container, and a 694-byte TapeOut payload. Its local SHA-256 is `d68c9881fbe8bf0fbf7f86cfa92ad2889389e07e09bb0e7f0068f23eded50003` and its payload SHA-256 is `7e4b5f83032beaf32ce2e7c067f1ee24d08feea1e2db8c64ef7c4d7de231dc45`.

The flagship artifact was compared through the independent AST interpreter, decoded local netlist simulator, and both locked providers for 256 cases per provider with zero mismatches. TinyApproval passed the same chain for 32 cases per provider. The manufacture records and current product readback are listed in [`public/evidence/release.json`](public/evidence/release.json).

## Run locally

```sh
npm install
npm test
npm run typecheck
npm run build
npm run dev
```

The browser workspace supports local compilation, deterministic artifact inspection, read-only quotes, fresh dual-provider circuit readback, and read-only live transition comparison. Wallet signing and state-changing protocol actions are outside the release product path.

For protocol verification from a configured environment:

```sh
npm run gatec:live
npm run gatee:final:live -- 0xf8fca87f75de3ebf9326071b0341c9307dd5d768c90558542c6013100816a8be
```

See [`docs/language.md`](docs/language.md), [`docs/verification.md`](docs/verification.md), [`docs/protocol-limitations.md`](docs/protocol-limitations.md), and [`docs/demo-script.md`](docs/demo-script.md) for the language, proof boundary, known limitations, and judge-facing demo sequence.

## Claim boundary

GateX demonstrates behavior-verified compilation and live circuit evaluation for the locked scope. It does not claim exact deployed-source verification, protocol immutability, authoritative workflow state, replay-proof approvals, identity-authenticated approvals, custody, agent execution, or a protocol contract audit.

## License

GateX is released under the [MIT License](LICENSE).
