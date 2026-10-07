import { weiToOkb, type ReadOnlyQuote } from "./protocol.js";

// What a circuit of a given size costs, from the same read-only quote the tape-out planner uses. Pure bigint arithmetic.
// A circuit needs NAND and LATCH transistors, bought in two mint calls (one per kind) that each carry the protocol's fixed mint fee,
// plus the TapeOut fee. Gas is not included.

export type PricingQuote = Pick<ReadOnlyQuote, "minted" | "cap" | "mintPriceWei" | "protocolFeeWei" | "tapeoutFeeWei">;

export interface SizedCost {
  transistorsWei: bigint;
  tapeoutFeeWei: bigint;
  minted: bigint;
  cap: bigint;
  /** Whole circuits of this size that still fit under the supply cap. */
  room: bigint;
}

export function costOfSize(quote: PricingQuote, nand: bigint, latch: bigint): SizedCost {
  const mintCalls = (nand > 0n ? 1n : 0n) + (latch > 0n ? 1n : 0n);
  const size = nand + latch;
  const left = quote.cap > quote.minted ? quote.cap - quote.minted : 0n;
  return { transistorsWei: size * quote.mintPriceWei + mintCalls * quote.protocolFeeWei, tapeoutFeeWei: quote.tapeoutFeeWei, minted: quote.minted, cap: quote.cap, room: size === 0n ? 0n : left / size };
}

export function formatCount(value: bigint): string {
  return value.toLocaleString("en-US");
}

export function pricingSentences(cost: SizedCost, name: string, nand: bigint, latch: bigint): [string, string] {
  return [
    `A circuit the size of ${name} (${nand} NAND + ${latch} LATCH) costs ${weiToOkb(cost.transistorsWei)} OKB in transistors plus a ${weiToOkb(cost.tapeoutFeeWei)} OKB TapeOut fee, before gas.`,
    `${formatCount(cost.minted)} of ${formatCount(cost.cap)} transistors minted — room for about ${formatCount(cost.room)} more circuits of that size.`
  ];
}
