# GateX submission

## Project name

GateX

## One-liner

Write an approval workflow as a readable state machine. GateX compiles it to a TapeOut circuit on X Layer and proves the circuit does what the source says.

## Description

GateX compiles readable approval workflows into TapeOut NAND/LATCH circuits on X Layer and proves the manufactured circuit matches the source. A team writes a rule such as "a request must be approved before it is used" as a named state machine. GateX compiles it deterministically, checks every state and input combination against an independent interpreter and a netlist simulator, then reads the circuit back from X Layer through two RPC providers and compares live transitions with the local result. Two circuits are taped out on our processor: TinyApproval (89 NAND, 2 LATCH) and AgentApproval (98 NAND, 2 LATCH), both with zero mismatches. The transistor supply cap is 1,000,000 GTX at 0.000001 OKB per transistor, set at processor creation.

## Processor contract address

[`0x95aaacaa8aaecf6d215706d3e7fff255a35c59ed`](https://www.oklink.com/xlayer/address/0x95aaacaa8aaecf6d215706d3e7fff255a35c59ed)

## Deployment wallet

[`0x9fa5db29dfc46e9bfdde271e44364d4ba64244c4`](https://www.oklink.com/xlayer/address/0x9fa5db29dfc46e9bfdde271e44364d4ba64244c4)

## Processor creation tx

[`0x3e12f5f4173c998a07bb9c2a2cc463fecf9d1e7fbf6ca03291200683c496bd48`](https://www.oklink.com/xlayer/tx/0x3e12f5f4173c998a07bb9c2a2cc463fecf9d1e7fbf6ca03291200683c496bd48)

## Circuits

1. TinyApproval, 89 NAND and 2 LATCH. Manufacture tx [`0xda598818354c8020e72b433803720dcbed628e20fc4c9d7f84ab4ce509f176e4`](https://www.oklink.com/xlayer/tx/0xda598818354c8020e72b433803720dcbed628e20fc4c9d7f84ab4ce509f176e4)
2. AgentApproval, 98 NAND and 2 LATCH. Manufacture tx [`0xf8fca87f75de3ebf9326071b0341c9307dd5d768c90558542c6013100816a8be`](https://www.oklink.com/xlayer/tx/0xf8fca87f75de3ebf9326071b0341c9307dd5d768c90558542c6013100816a8be)

## Transistor terms

- Token: GateX (GTX), [`0x62f8409177a511b71ea888beef47b894be1221cb`](https://www.oklink.com/xlayer/address/0x62f8409177a511b71ea888beef47b894be1221cb)
- Supply cap: 1,000,000 GTX
- Unit price: 0.000001 OKB (1,000,000,000,000 wei)
- Recorded in [`deployments/xlayer-mainnet.json`](../deployments/xlayer-mainnet.json)

## Repository

https://github.com/AjKadri/GateX

## Demo URL

https://gatex.ajkadri.dev

## Demo video

To be added before submission.

## Limitations

- Workflow state is owned by the caller in the browser.
- GateX does not provide replay-proof approvals.
- GateX does not provide identity-authenticated approvals.
- GateX does not provide custody.
- GateX does not execute an AI agent.
- Protocol source and build provenance remain unresolved.

See [`README.md`](../README.md), [`demo.md`](demo.md) and [`protocol-limitations.md`](protocol-limitations.md) for more.
