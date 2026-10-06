import { AGENT_APPROVAL_SOURCE } from "../src/examples/agentApproval.js";
import { compileMachine } from "../src/compiler/compiler.js";
import { compareCandidateSimulationWithConcurrency } from "../src/protocol/candidate.js";
import { decodeBytesReturn, decodeCircuitInfo, decodeStep, encodeCall, hexFromBytes } from "../src/protocol/abi.js";
import { decodeGateDAddress, decodeGateDBool, decodeGateDUint256, encodeGateDCall, sha256Hex } from "../src/protocol/gate-d-abi.js";
import { loadCanonicalDeployment } from "../src/protocol/deployment.js";
import { runtimeKeccak256 } from "../src/protocol/identity.js";
import { identityTargets, loadProtocolLock } from "../src/protocol/lock.js";
import { providerClients } from "../src/protocol/rpc.js";
import { verifyTapeoutReceipt } from "../src/protocol/receipts.js";
import { buildCanonicalTapeoutTransaction } from "../src/protocol/transaction-integrity.js";

const TAPEOUT_HASH = process.argv[2];
if (TAPEOUT_HASH === undefined || !/^0x[0-9a-fA-F]{64}$/.test(TAPEOUT_HASH)) throw new Error("Usage: gate-e-final-live <tapeout transaction hash>");

const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function withRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await operation(); } catch (error) { lastError = error; if (attempt < 2) await pause(250 * (attempt + 1)); }
  }
  throw new Error(`${label} failed after 3 attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function quantity(value: bigint): string { return `0x${value.toString(16)}`; }
function address(value: string): string { return value.toLowerCase(); }

try {
  const lock = loadProtocolLock();
  const deployment = loadCanonicalDeployment();
  const compiled = await compileMachine(AGENT_APPROVAL_SOURCE);
  const { extractTapeOutPayload } = await import("../src/protocol/wire.js");
  const extracted = await extractTapeOutPayload(lock, compiled.bytes);
  const tapeout = buildCanonicalTapeoutTransaction(lock, { sender: deployment.creator, processor: deployment.processor, payload: extracted.payload, nIn: extracted.dimensions.nIn, nOut: extracted.dimensions.nOut, feeWei: 1_300_000_000_000_000n });
  const clients = providerClients(lock);
  const request = async (provider: string, method: "eth_chainId" | "eth_blockNumber" | "eth_getBlockByNumber" | "eth_getCode" | "eth_getBalance" | "eth_getTransactionCount" | "eth_getTransactionByHash" | "eth_getTransactionReceipt" | "eth_call", params: readonly unknown[]): Promise<unknown> => withRetry(() => (clients.get(provider) as { request: (name: typeof method, values: readonly unknown[]) => Promise<unknown> }).request(method, params), `${provider} ${method}`);

  const heads = await Promise.all(lock.snapshot.providers.map(async (provider) => BigInt(String(await request(provider, "eth_blockNumber", [])))));
  const blockNumber = heads.reduce((left, right) => left < right ? left : right);
  const blockTag = quantity(blockNumber);
  const blocks = await Promise.all(lock.snapshot.providers.map((provider) => request(provider, "eth_getBlockByNumber", [blockTag, false]) as Promise<{ hash: string }>));
  if (new Set(blocks.map((block) => block.hash.toLowerCase())).size !== 1) throw new Error("Providers disagree on the final common block");

  const receipts = [];
  for (const provider of lock.snapshot.providers) {
    const [receipt, transaction, head] = await Promise.all([
      request(provider, "eth_getTransactionReceipt", [TAPEOUT_HASH]),
      request(provider, "eth_getTransactionByHash", [TAPEOUT_HASH]),
      request(provider, "eth_blockNumber", [])
    ]);
    receipts.push(verifyTapeoutReceipt(lock, provider, receipt, transaction, head, { transactionHash: TAPEOUT_HASH, sender: deployment.creator, processor: deployment.processor, data: tapeout.request.data, valueWei: 1_300_000_000_000_000n, gateCount: compiled.artifact.records.length, nState: extracted.dimensions.nState }));
  }
  if (new Set(receipts.map((receipt) => receipt.blockHash)).size !== 1) throw new Error("Providers disagree on tapeout receipt block");
  if (new Set(receipts.map((receipt) => receipt.tapedOut.circuitId.toString())).size !== 1) throw new Error("Providers disagree on receipt circuit ID");
  const circuitId = receipts[0]?.tapedOut.circuitId as bigint;
  const providerResults = [];
  for (const provider of lock.snapshot.providers) {
    const call = (to: string, data: string): Promise<string> => request(provider, "eth_call", [{ to, data }, blockTag]).then((value) => String(value));
    const chainId = Number(BigInt(String(await request(provider, "eth_chainId", []))));
    if (chainId !== lock.chainId) throw new Error(`${provider} chain ${chainId} != ${lock.chainId}`);
    for (const target of identityTargets(lock)) {
      const code = String(await request(provider, "eth_getCode", [target.address, blockTag]));
      if (runtimeKeccak256(code).toLowerCase() !== target.expectedRuntimeKeccak256.toLowerCase()) throw new Error(`${provider} runtime mismatch for ${target.key}`);
    }
    const [registryProcessor, isCPU, processorToken, tokenProcessor, creator, owner, info, netlist, nand, latch, minted, cap, priceWei, fixedMintFeeWei, tapeoutFeeWei] = await Promise.all([
      call(lock.factory.proxy, encodeGateDCall(lock, "cpuAt(uint256)", [deployment.registryIndex])).then(decodeGateDAddress),
      call(lock.factory.proxy, encodeGateDCall(lock, "isCPU(address)", [deployment.processor])).then(decodeGateDBool),
      call(deployment.processor, encodeGateDCall(lock, "transistors()")).then(decodeGateDAddress),
      call(deployment.token, encodeGateDCall(lock, "circuits()")).then(decodeGateDAddress),
      call(deployment.token, encodeGateDCall(lock, "creator()")).then(decodeGateDAddress),
      call(deployment.processor, encodeGateDCall(lock, "ownerOf(uint256)", [circuitId])).then(decodeGateDAddress),
      call(deployment.processor, encodeGateDCall(lock, "circuitInfo(uint256)", [circuitId])).then(decodeCircuitInfo),
      call(deployment.processor, encodeGateDCall(lock, "netlist(uint256)", [circuitId])).then(decodeBytesReturn),
      call(deployment.token, encodeGateDCall(lock, "balanceOf(address,uint256)", [deployment.creator, 0n])).then(decodeGateDUint256),
      call(deployment.token, encodeGateDCall(lock, "balanceOf(address,uint256)", [deployment.creator, 1n])).then(decodeGateDUint256),
      call(deployment.token, encodeGateDCall(lock, "minted()")).then(decodeGateDUint256),
      call(deployment.token, encodeGateDCall(lock, "supplyCap()")).then(decodeGateDUint256),
      call(deployment.token, encodeGateDCall(lock, "mintPrice()")).then(decodeGateDUint256),
      call(deployment.token, encodeGateDCall(lock, "protocolFee()")).then(decodeGateDUint256),
      call(deployment.processor, encodeGateDCall(lock, "TAPEOUT_FEE()")).then(decodeGateDUint256)
    ]);
    const netlistHex = hexFromBytes(netlist);
    const expectedHash = `0x${extracted.payloadHash.replace(/^0x/, "")}`;
    if (address(registryProcessor) !== deployment.processor || !isCPU || address(processorToken) !== deployment.token || address(tokenProcessor) !== deployment.processor || address(creator) !== deployment.creator || address(owner) !== deployment.creator || info.nIn !== extracted.dimensions.nIn || info.nOut !== extracted.dimensions.nOut || info.nState !== extracted.dimensions.nState || info.gateCount !== extracted.dimensions.gateCount || sha256Hex(netlistHex).toLowerCase() !== expectedHash.toLowerCase() || netlistHex.toLowerCase() !== hexFromBytes(extracted.payload).toLowerCase() || nand !== 0n || latch !== 0n || minted !== 191n || cap !== 1_000_000n || priceWei !== 1_000_000_000_000n || fixedMintFeeWei !== 660_000_000_000_000n || tapeoutFeeWei !== 1_300_000_000_000_000n) throw new Error(`${provider} final readback or state mismatch`);
    const candidate = { evaluate: async (stateBytes: Uint8Array, inputBytes: Uint8Array) => { const step = decodeStep(await call(deployment.processor, encodeCall(lock, "step(uint256,bytes,bytes)", [circuitId, stateBytes, inputBytes]))); return { nextStateBytes: step.nextState, outputBytes: step.outputs }; } };
    const comparison = await compareCandidateSimulationWithConcurrency(compiled, candidate, 8);
    if (comparison.mismatches.length > 0) throw new Error(`${provider} live candidate mismatches: ${comparison.mismatches.join(", ")}`);
    providerResults.push({ provider, chainId, circuitId: circuitId.toString(), dimensions: info, payloadBytes: netlist.length, payloadSha256: sha256Hex(netlistHex), casesCompared: comparison.casesCompared, mismatches: comparison.mismatches, nandBalance: nand.toString(), latchBalance: latch.toString(), minted: minted.toString(), senderBalanceWei: String(await request(provider, "eth_getBalance", [deployment.creator, blockTag])), senderNonce: String(await request(provider, "eth_getTransactionCount", [deployment.creator, blockTag])) });
  }
  console.log(JSON.stringify({ status: "PASS", transactionHash: TAPEOUT_HASH, commonBlock: { number: blockNumber.toString(), hash: blocks[0]?.hash }, realCircuitId: circuitId.toString(), artifact: { nand: compiled.nandCount, latch: compiled.latchCount, records: compiled.artifact.records.length, localBytes: compiled.bytes.length, localSha256: compiled.hash, payloadBytes: extracted.payloadBytes, payloadSha256: extracted.payloadHash }, receipts: receipts.map((receipt) => ({ provider: receipt.provider, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, confirmations: receipt.confirmations.toString(), gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString(), actualGasCostWei: receipt.actualGasCostWei.toString(), actualTransactionCostWei: receipt.actualTransactionCostWei.toString() })), providers: providerResults }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
