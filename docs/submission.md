# GateX submission

## Project name

GateX

## One-liner

Readable approval rules, compiled to verified TapeOut circuits on X Layer, with on-chain sessions that remember their state.

## Description

GateX turns readable approval rules into verified TapeOut circuits on X Layer. You write a rule as a small state machine, for example "a request must be approved before it is used". GateX compiles it to NAND and LATCH gates, checks every state and input combination against the source in your browser, and only then lets you tape it out from your own wallet. Afterwards it confirms that the bytes on chain match your compile, and gives you a link anyone can use to verify it.

RuleGate, the GateX contract, makes those circuits decide something on chain. It stores a rule's state on X Layer and lets it advance only the way the circuit allows. It holds no funds, has no admin and cannot be upgraded.

## Required details

- Processor: [`0x95aaacaa8aaecf6d215706d3e7fff255a35c59ed`](https://www.oklink.com/xlayer/address/0x95aaacaa8aaecf6d215706d3e7fff255a35c59ed)
- Deployment wallet: [`0x9fa5db29dfc46e9bfdde271e44364d4ba64244c4`](https://www.oklink.com/xlayer/address/0x9fa5db29dfc46e9bfdde271e44364d4ba64244c4)
- Processor creation tx: [`0x3e12f5f4173c998a07bb9c2a2cc463fecf9d1e7fbf6ca03291200683c496bd48`](https://www.oklink.com/xlayer/tx/0x3e12f5f4173c998a07bb9c2a2cc463fecf9d1e7fbf6ca03291200683c496bd48)
- Demo: https://gatex.ajkadri.dev
- Demo video: to be added before submission
- Repository: https://github.com/AjKadri/GateX

## Transistor terms

- Token: GateX (GTX), [`0x62f8409177a511b71ea888beef47b894be1221cb`](https://www.oklink.com/xlayer/address/0x62f8409177a511b71ea888beef47b894be1221cb)
- Supply cap: 1,000,000 GTX
- Unit price: 0.000001 OKB (1,000,000,000,000 wei)
- Both were set when the processor was created and are recorded in [`deployments/xlayer-mainnet.json`](../deployments/xlayer-mainnet.json).
- A circuit the size of AgentApproval (98 NAND and 2 LATCH) costs 0.00142 OKB in transistors plus a 0.0013 OKB TapeOut fee, before gas, as read from X Layer on 2026-10-07. The Evidence page shows the live figure.

## RuleGate

- Contract: [`0xefa64bfc4f2f06465cfe2ff6dfa97cfbeac5732c`](https://www.oklink.com/xlayer/address/0xefa64bfc4f2f06465cfe2ff6dfa97cfbeac5732c)
- Deployment tx: [`0x473171ae7ec0556f5be8741457161926c15a9ab576fa339738bff8df5ca9c749`](https://www.oklink.com/xlayer/tx/0x473171ae7ec0556f5be8741457161926c15a9ab576fa339738bff8df5ca9c749)
- Source: [`contracts/RuleGate.sol`](../contracts/RuleGate.sol). Compiler and settings: [`contracts/RuleGate.json`](../contracts/RuleGate.json).
- First session: session 1 on circuit 2 ran IDLE, REQUESTED, APPROVED, USED in three transactions and emitted `permit` in step 3.

## Circuits on the processor

1. TinyApproval, 89 NAND and 2 LATCH. Manufacture tx [`0xda598818354c8020e72b433803720dcbed628e20fc4c9d7f84ab4ce509f176e4`](https://www.oklink.com/xlayer/tx/0xda598818354c8020e72b433803720dcbed628e20fc4c9d7f84ab4ce509f176e4)
2. AgentApproval, 98 NAND and 2 LATCH. Manufacture tx [`0xf8fca87f75de3ebf9326071b0341c9307dd5d768c90558542c6013100816a8be`](https://www.oklink.com/xlayer/tx/0xf8fca87f75de3ebf9326071b0341c9307dd5d768c90558542c6013100816a8be)
3. AgentApproval, taped out from the browser by a second wallet belonging to the author, as the live test of the tape-out flow.

The Circuits page lists every circuit live from chain.

## What a visitor can do

- Write a rule or start from a template, and see it checked for every state and input combination.
- Tape it out from an OKX wallet and get it verified against the compile.
- Share a verification link, and check any rule against any circuit on the processor.
- Open a RuleGate session on a circuit and step it on chain.

## Limitations

- GateX has not been audited by a third party, and RuleGate has not been audited.
- GateX has not audited the TapeOut contracts or verified their deployed source.
- A circuit does not check who calls it. RuleGate limits each session to the wallet that opened it.
- Tape-out and sessions work with OKX Wallet.

See [`README.md`](../README.md), [`demo.md`](demo.md), [`rulegate.md`](rulegate.md) and [`protocol-limitations.md`](protocol-limitations.md) for more.
