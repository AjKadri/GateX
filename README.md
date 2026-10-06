# GateX

**Write an approval workflow as a readable state machine. GateX compiles it to a TapeOut circuit on X Layer and proves the circuit does what the source says.**

[Live workspace](https://gatex.ajkadri.dev)

## Why it exists

Teams that put an agent or an automation in front of something valuable need a gate: a small rule such as
"a request has to be approved before it can be used". Written as source, that rule is easy to read.
Compiled to NAND gates and latches, it is not. Anyone relying on the circuit has to trust that it still
means what the source said.

GateX removes that trust step. You keep the named states and guards, and GateX shows that the manufactured
circuit behaves identically for every state and input.

## What you can do in the workspace

- Edit a state machine and see its named-state diagram.
- Compile it to a NAND/LATCH netlist. The same source always gives the same bytes and hashes.
- Check the compiled circuit against the source for every state and input combination.
- Read the manufactured circuit back from X Layer through two independent RPC providers and compare a live
  transition with the local result, side by side.

The flagship example, AgentApproval, moves through `IDLE → REQUESTED → APPROVED → USED`.

## On X Layer

| | |
| --- | --- |
| Chain | X Layer (196) |
| Processor | [`0x95aaacaa8aaecf6d215706d3e7fff255a35c59ed`](https://www.oklink.com/xlayer/address/0x95aaacaa8aaecf6d215706d3e7fff255a35c59ed) |
| Transistor token | [`0x62f8409177a511b71ea888beef47b894be1221cb`](https://www.oklink.com/xlayer/address/0x62f8409177a511b71ea888beef47b894be1221cb) |
| Deployment wallet | [`0x9fa5db29dfc46e9bfdde271e44364d4ba64244c4`](https://www.oklink.com/xlayer/address/0x9fa5db29dfc46e9bfdde271e44364d4ba64244c4) |
| Processor deployment | [`0x3e12f5f4173c998a07bb9c2a2cc463fecf9d1e7fbf6ca03291200683c496bd48`](https://www.oklink.com/xlayer/tx/0x3e12f5f4173c998a07bb9c2a2cc463fecf9d1e7fbf6ca03291200683c496bd48) |
| Transistor supply cap | 1,000,000 GTX |
| Transistor unit price | 0.000001 OKB (1,000,000,000,000 wei) |

Supply cap and unit price were set when the processor was created and are recorded in [`deployments/xlayer-mainnet.json`](deployments/xlayer-mainnet.json).

| Circuit | Gates | Payload | Checked | Manufacture tx |
| --- | --- | --- | --- | --- |
| 1 TinyApproval | 89 NAND, 2 LATCH | 631 bytes | 32 cases per provider, 0 mismatches | [`0xda598818354c8020e72b433803720dcbed628e20fc4c9d7f84ab4ce509f176e4`](https://www.oklink.com/xlayer/tx/0xda598818354c8020e72b433803720dcbed628e20fc4c9d7f84ab4ce509f176e4) |
| 2 AgentApproval | 98 NAND, 2 LATCH | 694 bytes | 256 cases per provider, 0 mismatches | [`0xf8fca87f75de3ebf9326071b0341c9307dd5d768c90558542c6013100816a8be`](https://www.oklink.com/xlayer/tx/0xf8fca87f75de3ebf9326071b0341c9307dd5d768c90558542c6013100816a8be) |

Payload hashes and block references are in [`public/evidence/release.json`](public/evidence/release.json).

## What GateX does not do

GateX checks behaviour. The workflow state lives with the caller, in the browser, and TapeOut computes each
transition without storing it. So GateX does not provide replay protection, identity checks, custody or agent
execution, and it is not an audit of the TapeOut contracts. Details are in
[`docs/protocol-limitations.md`](docs/protocol-limitations.md).

## Run locally

```sh
npm install
npm test
npm run typecheck
npm run build
npm run dev
```

The browser workspace supports local compilation, deterministic artifact inspection, read-only quotes, fresh dual-provider circuit readback, and read-only live transition comparison. Wallet signing and state-changing protocol actions are outside the release product path.

These commands read X Layer through the two providers listed in `protocol/lock.json` (`https://rpc.xlayer.tech` and `https://xlayer.drpc.org`). They need no environment variables.

```sh
npm run gatec:live
npm run gatee:final:live -- 0xf8fca87f75de3ebf9326071b0341c9307dd5d768c90558542c6013100816a8be
```

See [`docs/language.md`](docs/language.md) for the language, [`docs/verification.md`](docs/verification.md) for the proof model, [`docs/protocol-limitations.md`](docs/protocol-limitations.md) for known limitations, and [`docs/demo.md`](docs/demo-script.md) for a walkthrough.

## License

GateX is released under the [MIT License](LICENSE).
