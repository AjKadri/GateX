export type VerificationStatus = "PASSED" | "PENDING" | "FAILED" | "STALE" | "UNAVAILABLE";

export interface CircuitBindingReadback {
  status: "ready" | "failed" | "unavailable";
  circuitId: string;
  owner: string;
  processor: string;
  nIn: number;
  nOut: number;
  nState: number;
  gateCount: number;
  payloadBytes: number;
  payloadSha256: string;
  expectedPayloadSha256: string;
  detail?: string;
}

export interface ArtifactBindingInput {
  source: string;
  expectedSource: string;
  deterministic: boolean;
  artifactMatch: boolean;
  localHash: string;
  expectedLocalHash: string;
  payloadBytes: number;
  expectedPayloadBytes: number;
  payloadHash: string;
  expectedPayloadHash: string;
  expectedDimensions: { nIn: number; nOut: number; nState: number; gateCount: number };
  expectedCircuitId: string;
  expectedProcessor: string;
  readback?: CircuitBindingReadback;
}

export interface ArtifactBindingResult {
  status: VerificationStatus;
  liveReady: boolean;
  detail: string;
}

function normalizedHash(value: string): string { return value.toLowerCase().replace(/^0x/, ""); }

export function verifyArtifactBinding(input: ArtifactBindingInput): ArtifactBindingResult {
  if (input.source.trim() !== input.expectedSource.trim()) {
    return { status: "STALE", liveReady: false, detail: "Current valid source differs from the accepted deployment source." };
  }
  if (!input.deterministic || !input.artifactMatch || normalizedHash(input.localHash) !== normalizedHash(input.expectedLocalHash) || input.payloadBytes !== input.expectedPayloadBytes || normalizedHash(input.payloadHash) !== normalizedHash(input.expectedPayloadHash)) {
    return { status: "FAILED", liveReady: false, detail: "Current deterministic artifact does not match the accepted deployment binding." };
  }
  if (input.readback === undefined) {
    return { status: "PENDING", liveReady: false, detail: "A fresh dual-provider circuit readback is required before a live read." };
  }
  if (input.readback.status === "unavailable") {
    return { status: "UNAVAILABLE", liveReady: false, detail: input.readback.detail ?? "Fresh circuit readback is unavailable." };
  }
  if (input.readback.status === "failed") {
    return { status: "FAILED", liveReady: false, detail: input.readback.detail ?? "Fresh circuit readback does not match the deployment binding." };
  }
  const dimensions = input.expectedDimensions;
  const matches = input.readback.circuitId === input.expectedCircuitId
    && input.readback.processor.toLowerCase() === input.expectedProcessor.toLowerCase()
    && input.readback.nIn === dimensions.nIn
    && input.readback.nOut === dimensions.nOut
    && input.readback.nState === dimensions.nState
    && input.readback.gateCount === dimensions.gateCount
    && input.readback.payloadBytes === input.expectedPayloadBytes
    && normalizedHash(input.readback.payloadSha256) === normalizedHash(input.expectedPayloadHash);
  return matches
    ? { status: "PASSED", liveReady: true, detail: `Fresh readback bound circuit ${input.expectedCircuitId} to the accepted artifact.` }
    : { status: "FAILED", liveReady: false, detail: "Fresh circuit readback disagrees with the accepted artifact or processor binding." };
}

export function liveVerificationStatus(read?: CircuitBindingReadback, mismatches = 0): VerificationStatus {
  if (read === undefined) return "PENDING";
  if (read.status === "unavailable") return "UNAVAILABLE";
  if (read.status === "failed" || mismatches > 0) return "FAILED";
  return "PASSED";
}

export function assessGasInclusiveSufficiency(nativeBalanceWei: bigint | undefined, protocolValueBeforeGasWei: bigint | undefined, estimatedGasWei: bigint | undefined): { status: "SUFFICIENT" | "INSUFFICIENT" | "UNAVAILABLE"; label: string } {
  if (nativeBalanceWei === undefined || protocolValueBeforeGasWei === undefined || estimatedGasWei === undefined) return { status: "UNAVAILABLE", label: "PROTOCOL VALUE BEFORE GAS" };
  const total = protocolValueBeforeGasWei + estimatedGasWei;
  return nativeBalanceWei >= total ? { status: "SUFFICIENT", label: "ESTIMATED TOTAL INCLUDING GAS" } : { status: "INSUFFICIENT", label: "ESTIMATED TOTAL INCLUDING GAS" };
}
