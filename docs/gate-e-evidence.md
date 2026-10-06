# Gate E evidence

Gate E passed after the exact AgentApproval artifact was compiled, acquired, manufactured, read back, and evaluated at the live X Layer boundary.

## Artifact

- Source: the locked AgentApproval DSL through the generic GateX parser/compiler
- 98 NAND, 2 LATCH, 100 records
- Local container: 706 bytes
- Local SHA-256: `d68c9881fbe8bf0fbf7f86cfa92ad2889389e07e09bb0e7f0068f23eded50003`
- TapeOut payload: 694 bytes
- TapeOut payload SHA-256: `7e4b5f83032beaf32ce2e7c067f1ee24d08feea1e2db8c64ef7c4d7de231dc45`
- Dimensions: `(nIn=6, nOut=1, nState=2)`

TinyApproval regression remained exact at 89 NAND, 2 LATCH, 91 records, 643-byte local container, 631-byte payload, and the locked local and payload hashes.

## State-changing transactions

All transactions used the canonical processor/token deployment and the authorized creator `0x9fa5db29dfc46e9bfdde271e44364d4ba64244c4`. Each was exposed one at a time after a fresh dual-provider simulation and approved manually in OKX Wallet.

### NAND acquisition

- Transaction: `0x207f612748b300a4aecde0782eff075b3dcba90500f46f10fbdd398b795040b7`
- Block: `72526667`, `0x05719902f4990cf88adea2affa754e47788a45d166d940d19c8f04e98face409`
- Target: `0x62f8409177a511b71ea888beef47b894be1221cb`
- ID and amount: `0 / 98`
- Value: `758000000000000` wei
- Calldata SHA-256: `0x32abdf74e346d00ea5b28e459b9e912c460e8c8e51015c34f76b644a3844d72c`
- Gas used: `86399`
- Effective gas price: `20000001` wei
- Actual total: `759727980086399` wei
- Receipt and `Minted`/`TransferSingle` checks passed on both providers.

### LATCH acquisition

- Transaction: `0xe52d44e818866b9a854de1468c59ab3b1c0e1e2d8f3d7adf82d51f76ca4a21c6`
- Block: `72527473`, `0xb1745bf79bef93aa6ece15fd78f8f2c373120a6d79654b675855163b590142f7`
- Target: `0x62f8409177a511b71ea888beef47b894be1221cb`
- ID and amount: `1 / 2`
- Value: `662000000000000` wei
- Calldata SHA-256: `0xc5e2cffe669f42b7391e15f8d28d978de895b515b77146b2d762b2d1a3914703`
- Gas used: `86434`
- Effective gas price: `20000001` wei
- Actual total: `663728680086434` wei
- Receipt and `Minted`/`TransferSingle` checks passed on both providers.

### AgentApproval manufacture

- Transaction: `0xf8fca87f75de3ebf9326071b0341c9307dd5d768c90558542c6013100816a8be`
- Block: `72528952`, `0x13356c8fcae06c6c27167ff6d51ea2a19c7d4516fb03bc05b0767d0fb6c3ab53`
- Target: `0x95aaacaa8aaecf6d215706d3e7fff255a35c59ed`
- Payload: 694 bytes, dimensions `(6,1)`, exact payload hash above
- Value: `1300000000000000` wei
- Calldata SHA-256: `0xc0c6cde63c441eb0179d1764cf90f7a604a0fc68c4b1c15624f744c2fce48ba1`
- Gas used: `490243`
- Effective gas price: `20000001` wei
- Actual total: `1309804860490243` wei
- `TapedOut` and circuit `Transfer` events recovered real circuit ID `2`, author `0x9fa5db29dfc46e9bfdde271e44364d4ba64244c4`, gate count `100`, and state bits `2`.

## Live verification

Both locked providers passed at common block `72529601`, hash `0x4f2192bc6819e1efc1620444e5387b6487f2dacf3fff091c7e9dee9e25a89963`.

- 8 locked runtime identities per provider: matched
- Canonical processor/token registry and reciprocal linkage: matched
- Circuit owner: authorized creator
- Readback: 694 bytes, `(6,1,2,100)`, exact payload bytes and hash
- Independent AST interpreter to decoded local netlist to live `step()` comparison: 256 cases per provider, 512 total, zero mismatches
- Post-manufacture inventory: NAND 0, LATCH 0, lifetime minted 191
- Sender nonce: 8
- Final sender balance: `43312990157199508` wei

The final verification is reproducible with:

```text
npm run gatee:final:live -- 0xf8fca87f75de3ebf9326071b0341c9307dd5d768c90558542c6013100816a8be
```

## REVOKED differentiation

- Overlapping revocation guard rejected with witness `REQUESTED with approve=1, human_ok=1, scope_ok=1`.
- Corrected disjoint variant: 512 local cases, zero mismatches.

## Spend

- Gate E actual spend: `2733261520663076` wei (`0.002733261520663076` OKB)
- Cumulative project spend: `18687009842800492` wei (`0.018687009842800492` OKB)
- Remaining under the `0.05` OKB ceiling: `31312990157199508` wei
- Remaining balance above the requested `0.01` OKB contingency: `33312990157199508` wei

The Gate E wallet handoff used the explicitly identified OKX legacy object because this Chrome origin did not announce EIP-6963. It never used the generic `window.ethereum` provider. One transient read-only transport failure from `https://rpc.xlayer.tech` was retried with bounded backoff and then passed. No Gate F work began.
