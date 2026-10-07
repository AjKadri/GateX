# Tape out your own circuit

The workspace can manufacture the circuit you compiled on the GateX processor on X Layer (chain 196), from your own wallet. This page describes what is sent, what it costs, what is checked before each signature, and what "verified" means. It is the only part of GateX that sends transactions.

The feature is behind the `TAPEOUT_ENABLED` constant at the top of `src/main.ts`. With it set to `false` the workspace is the read-only workspace.

## The three transactions

A circuit is built from transistors (an ERC-1155 token) and manufactured by the processor, which burns them. Your wallet may need to send up to three transactions, in this order. A step is skipped when your balance already covers it.

| Step | Contract | Call | Value sent |
| --- | --- | --- | --- |
| Buy NAND transistors | transistor token | `mint(0, amount)` | `amount * mintPrice() + protocolFee()` |
| Buy LATCH transistors | transistor token | `mint(1, amount)` | `amount * mintPrice() + protocolFee()` |
| Manufacture circuit | processor | `tapeout(payload, nIn, nOut)` | `TAPEOUT_FEE()` |

`amount` is only the shortfall: the circuit's NAND (or LATCH) count minus the NAND (or LATCH) balance your account already holds. Token ids 0 (NAND) and 1 (LATCH) come from the protocol lock. The processor burns the circuit's transistors from the sender itself, so no approval transaction exists in this flow. This is what the lock records for the checked contracts (`approvalRequired: false`); it was not re-tested on chain for this feature.

NAND and LATCH mints count against the same supply cap (`supplyCap()` against `minted()`), and each mint call pays the fixed `protocolFee()` once.

## What it costs

Nothing is hard-coded. The panel reads `mintPrice()`, `protocolFee()`, `TAPEOUT_FEE()`, `supplyCap()`, `minted()`, your transistor balances, your OKB balance and `eth_gasPrice` from both RPC providers at one common block, and shows:

- the transistors you need, hold and would buy;
- the cost of the transistors, the TapeOut fee, estimated gas and the total.

Gas for the mints is estimated with `eth_estimateGas` on both providers. The tape-out cannot be estimated until its transistors exist, so while mints are still pending it is shown at the locked per-artifact gas ceiling (`provisionalPerArtifactGasCeiling` in `protocol/lock.json`) and labelled as such.

Example only, using the values in the repository at the time of writing and not guaranteed to be current: with a mint price of 0.000001 OKB and a protocol fee of 0.00066 OKB, buying 98 NAND costs 98 x 0.000001 + 0.00066 = 0.000758 OKB, and the TapeOut fee is 0.0013 OKB.

Overpaying a mint is not refunded automatically, so each transaction is built from the numbers read a moment earlier and re-checked before signing.

## Checks before each signature

Before the wallet is asked to sign anything, in this order:

1. The step is the next remaining step of the plan, and no transaction for this circuit is already pending or finished (the pending record survives a page reload).
2. Browser storage works. If it does not, nothing is sent, because the double-send protection could not be kept.
3. The transaction is rebuilt from the plan's own numbers with the canonical builders in `src/protocol/transaction-integrity.ts` and compared byte for byte, including the target address (token for mints, processor for tape-out), sender and value. For tape-out the payload hash must still equal the hash of your compile.
4. `eth_call` and `eth_estimateGas` from your account on both providers, at the plan's block and at the current head. Both must succeed, agree, and stay within the gas ceiling. A revert is shown to you with the node's message.
5. A fresh quote must still agree between providers and show the same prices, fees, cap and your balances as the plan. If anything moved, the plan is refreshed and nothing is sent.
6. The wallet must report chain 196 and its active account must be the account the plan was made for.

Only then is `eth_sendTransaction` called with exactly `from`, `to`, `data` and `value`. GateX never asks for message signatures, approvals, transfers or any other address.

It refuses, with a plain-English reason, when: the providers disagree or are not on chain 196; no account is connected; the circuit exceeds a client safety limit (inputs, states, state bits, outputs, records, netlist bytes); the payload is empty; not enough transistors remain under the supply cap; your balance cannot cover the value plus estimated gas; any simulation reverts or exceeds the gas ceiling.

Rejecting the request in your wallet is not an error: the panel says "Cancelled in wallet. Nothing was sent." and nothing is recorded as pending.

## After each transaction

The receipt is read from both providers. Both must report success, in the same block, with at least two confirmations, and the receipt and transaction must match what GateX sent (target, calldata, value, and the locked `Minted`/`TransferSingle` or `TapedOut`/`Transfer` events). The plan is then rebuilt from a fresh quote that is at least as recent as the confirmed block; old balances are never reused.

If you reload while a transaction is pending, the panel resumes at "Waiting for confirmation" instead of offering the same step again.

## What "verified" means

After the tape-out is confirmed, GateX reads the new circuit back from X Layer through both providers and checks that:

- the SHA-256 of the netlist bytes stored on chain equals the SHA-256 of the payload GateX compiled locally;
- the circuit's owner is your account and its dimensions match;
- one live transition (initial state, all inputs 0) computed on chain equals the local result.

Byte-hash equality is the proof: the same bytes behave the same way. The single live transition is a sanity check of the evaluation path, not a second proof. If the readback cannot complete, the circuit is reported as "Manufactured, verification pending" and is never called verified until the readback succeeds. Verification does not cover the TapeOut contract source, which GateX did not audit (see [`protocol-limitations.md`](protocol-limitations.md)).

The panel remembers circuits you manufactured in this browser's local storage (`gatex.myCircuits`) as a convenience. That list is not evidence; the chain is.
