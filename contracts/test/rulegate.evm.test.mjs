// RuleGate behaviour test in an in-process EVM (not part of `npm test`; needs dev-only packages kept out of the repo).
// Run: mkdir /tmp/ev && cd /tmp/ev && npm i solc@0.8.24 @ethereumjs/vm @ethereumjs/common @ethereumjs/util js-sha3
// then, from that directory: GATEX=/path/to/gatex node /path/to/gatex/contracts/test/rulegate.evm.test.mjs
// It compiles contracts/test/MockProcessor.sol, deploys it and contracts/RuleGate.json (bytecode + constructor arg), and asserts.
// Exit code is non-zero if any assertion fails.
import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
import { createRequire } from 'node:module'; import { pathToFileURL, fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.GATEX ?? path.resolve(here, '../..');
const req = createRequire(path.join(process.cwd(), 'x.js'));
const imp = async (name) => import(pathToFileURL(req.resolve(name, { paths: [process.cwd()] })).href).catch(async () => import(name));
const solc = req('solc'); const { keccak256 } = req('js-sha3');
const { createVM } = await imp('@ethereumjs/vm'); const { Common, Mainnet, Hardfork } = await imp('@ethereumjs/common');
const { createAddressFromString, hexToBytes, bytesToHex, createAccount } = await imp('@ethereumjs/util');

// ---- compile the mock
const src = fs.readFileSync(path.join(ROOT, 'contracts/test/MockProcessor.sol'), 'utf8');
const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'M.sol': { content: src } }, settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['evm.bytecode.object'] } } } })));
for (const e of out.errors ?? []) if (e.severity === 'error') throw new Error(e.formattedMessage);
const mockCode = '0x' + out.contracts['M.sol'].MockProcessor.evm.bytecode.object;
const rg = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/RuleGate.json'), 'utf8'));

// ---- tiny abi helpers
const sel = (sig) => keccak256(sig).slice(0, 8);
const w = (v) => BigInt(v).toString(16).padStart(64, '0');
const pad = (hex) => hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
const bytesArg = (hex) => w(hex.length / 2) + pad(hex);
const enc = {
  open: (c, n) => '0x' + sel('open(uint256,uint256)') + w(c) + w(n),
  step: (id, inp) => '0x' + sel('step(uint256,bytes)') + w(id) + w(64) + bytesArg(inp),
  preview: (id, inp) => '0x' + sel('preview(uint256,bytes)') + w(id) + w(64) + bytesArg(inp),
  session: (id) => '0x' + sel('session(uint256)') + w(id),
  count: () => '0x' + sel('sessionCount()'),
  setMode: (m) => '0x' + sel('setMode(uint8)') + w(m)
};
const errSel = (n) => '0x' + sel(n + '()');
const word = (hex, i) => BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
const dyn = (hex, headIndex) => { const off = Number(word(hex, headIndex)) * 2 + 2; const len = Number(BigInt('0x' + hex.slice(off, off + 64))); return hex.slice(off + 64, off + 64 + len * 2); };
const A = createAddressFromString('0x' + 'a1'.repeat(20)), B = createAddressFromString('0x' + 'b2'.repeat(20));

const vm = await createVM({ common: new Common({ chain: Mainnet, hardfork: Hardfork.Paris }) });
for (const a of [A, B]) { const acc = createAccount({ balance: 10n ** 18n }); await vm.stateManager.putAccount(a, acc); }
async function call(from, to, data, value = 0n) {
  const r = await vm.evm.runCall({ caller: from, to, data: hexToBytes(data), value, gasLimit: 8_000_000n, skipBalance: true });
  const e = r.execResult;
  return { ok: e.exceptionError === undefined, ret: bytesToHex(e.returnValue), logs: e.logs ?? [], r };
}
async function deploy(from, initcode) {
  const r = await vm.evm.runCall({ caller: from, data: hexToBytes(initcode), gasLimit: 8_000_000n, skipBalance: true });
  assert.equal(r.execResult.exceptionError, undefined, 'deploy failed');
  // creation via runCall without `to` returns createdAddress
  await vm.stateManager.putAccount(A, (await vm.stateManager.getAccount(A)) ?? createAccount());
  return r.createdAddress;
}

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('ok   ', name); } catch (e) { fail++; console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); } }
const revertsWith = (res, name) => { assert.equal(res.ok, false, 'expected revert'); assert.equal(res.ret, errSel(name), `expected ${name}, got ${res.ret}`); };

const mock = await deploy(A, mockCode);
const rulegate = await deploy(A, rg.bytecode + w(BigInt(mock.toString())));
const M = mock, R = rulegate;
const topic = (sig) => '0x' + keccak256(sig);
const logTopics = (log) => log[1].map((x) => bytesToHex(x));
const logData = (log) => bytesToHex(log[2]);
const addrWord = (a) => '0x' + '0'.repeat(24) + a.toString().slice(2);

await t('processor() is the constructor argument', async () => { const r = await call(A, R, '0x' + sel('processor()')); assert.equal(word(r.ret, 0), BigInt(mock.toString())); });
await t('open starts at zero state of the given length and emits SessionOpened', async () => {
  const r = await call(A, R, enc.open(1, 2)); assert.ok(r.ok); assert.equal(word(r.ret, 0), 1n);
  assert.equal(r.logs.length, 1); const l = r.logs[0];
  assert.equal(bytesToHex(l[0]), R.toString());
  const tp = logTopics(l); assert.equal(tp[0], topic('SessionOpened(uint256,uint256,address,uint256)'));
  assert.equal(BigInt(tp[1]), 1n); assert.equal(BigInt(tp[2]), 1n); assert.equal(tp[3], addrWord(A)); assert.equal(word(logData(l), 0), 2n);
  const s = await call(A, R, enc.session(1)); assert.ok(s.ok);
  assert.equal(BigInt('0x' + s.ret.slice(2, 66)), BigInt(A.toString())); assert.equal(word(s.ret, 1), 1n); assert.equal(word(s.ret, 2), 0n);
  assert.equal(dyn(s.ret, 3), '0000'); assert.equal(dyn(s.ret, 4), '');
  assert.equal(word((await call(A, R, enc.count())).ret, 0), 1n);
});
await t('open reverts for stateBytes 0', async () => revertsWith(await call(A, R, enc.open(1, 0)), 'BadLength'));
await t('open reverts for stateBytes 33', async () => revertsWith(await call(A, R, enc.open(1, 33)), 'BadLength'));
await t('open accepts stateBytes 32', async () => { const r = await call(A, R, enc.open(1, 32)); assert.ok(r.ok); await call(A, R, enc.session(2)); });
await t('open reverts for unknown circuit', async () => { const r = await call(A, R, enc.open(99, 1)); assert.equal(r.ok, false); });
await t('open reverts for circuit id above uint64', async () => revertsWith(await call(A, R, enc.open(2n ** 64n, 1)), 'BadLength'));
await t('failed opens did not bump sessionCount', async () => assert.equal(word((await call(A, R, enc.count())).ret, 0), 2n));

let steps = 0;
await t('step by opener stores state, increments steps, stores lastOutputs, emits Stepped', async () => {
  const r = await call(A, R, enc.step(1, '01')); assert.ok(r.ok); steps++;
  assert.equal(dyn(r.ret, 0), '0100'); assert.equal(dyn(r.ret, 1), '00');
  const l = r.logs[0]; const tp = logTopics(l);
  assert.equal(tp[0], topic('Stepped(uint256,uint256,address,uint32,bytes,bytes,bytes)'));
  assert.equal(BigInt(tp[1]), 1n); assert.equal(BigInt(tp[2]), 1n); assert.equal(tp[3], addrWord(A));
  const d = logData(l); assert.equal(word(d, 0), 1n); assert.equal(dyn(d, 1), '01'); assert.equal(dyn(d, 2), '0100'); assert.equal(dyn(d, 3), '00');
  const s = await call(A, R, enc.session(1)); assert.equal(word(s.ret, 2), 1n); assert.equal(dyn(s.ret, 3), '0100'); assert.equal(dyn(s.ret, 4), '00');
});
await t('walks IDLE -> REQUESTED -> APPROVED -> USED and the last step carries the output bit', async () => {
  let r = await call(A, R, enc.step(1, '02')); assert.equal(dyn(r.ret, 0), '0200');
  r = await call(A, R, enc.step(1, '04')); assert.equal(dyn(r.ret, 0), '0300'); assert.equal(dyn(r.ret, 1), '01');
  const s = await call(A, R, enc.session(1)); assert.equal(word(s.ret, 2), 3n); assert.equal(dyn(s.ret, 4), '01');
  const l = r.logs[0]; assert.equal(word(logData(l), 0), 3n);
});
await t('terminal state holds', async () => { const r = await call(A, R, enc.step(1, '0f')); assert.equal(dyn(r.ret, 0), '0300'); });
await t('step by another account reverts NotSessionOwner and changes nothing', async () => {
  const before = (await call(A, R, enc.session(1))).ret;
  revertsWith(await call(B, R, enc.step(1, '01')), 'NotSessionOwner');
  assert.equal((await call(A, R, enc.session(1))).ret, before);
});
await t('step on unknown session reverts NoSuchSession (0 and 999)', async () => { revertsWith(await call(A, R, enc.step(999, '01')), 'NoSuchSession'); revertsWith(await call(A, R, enc.step(0, '01')), 'NoSuchSession'); });
await t('step with empty inputs reverts BadLength', async () => revertsWith(await call(A, R, enc.step(2, '')), 'BadLength'));
await t('step with 33 input bytes reverts BadLength', async () => revertsWith(await call(A, R, enc.step(2, '00'.repeat(33))), 'BadLength'));
await t('step with 32 input bytes works', async () => { const r = await call(A, R, enc.step(2, '01' + '00'.repeat(31))); assert.ok(r.ok); });
await t('processor returning a different state length reverts CircuitChangedStateLength', async () => {
  const o = await call(A, R, enc.open(1, 1)); const id = word(o.ret, 0);
  await call(A, M, enc.setMode(1));
  revertsWith(await call(A, R, enc.step(id, '01')), 'CircuitChangedStateLength');
  const s = await call(A, R, enc.session(id)); assert.equal(word(s.ret, 2), 0n);
  await call(A, M, enc.setMode(0));
});
await t('preview does not change state and returns what step would', async () => {
  const o = await call(A, R, enc.open(1, 1)); const id = word(o.ret, 0);
  const before = (await call(A, R, enc.session(id))).ret;
  const p = await call(B, R, enc.preview(id, '01')); assert.ok(p.ok); assert.equal(dyn(p.ret, 0), '01'); assert.equal(p.logs.length, 0);
  assert.equal((await call(A, R, enc.session(id))).ret, before);
  const s = await call(A, R, enc.step(id, '01')); assert.equal(s.ret, p.ret);
});
await t('preview on unknown session reverts NoSuchSession', async () => revertsWith(await call(A, R, enc.preview(777, '01')), 'NoSuchSession'));
await t('session on unknown id reverts NoSuchSession', async () => revertsWith(await call(A, R, enc.session(777)), 'NoSuchSession'));
await t('two sessions on the same circuit are independent', async () => {
  const x = word((await call(A, R, enc.open(2, 1))).ret, 0), y = word((await call(B, R, enc.open(2, 1))).ret, 0);
  await call(A, R, enc.step(x, '01'));
  const sx = await call(A, R, enc.session(x)), sy = await call(A, R, enc.session(y));
  assert.equal(dyn(sx.ret, 3), '01'); assert.equal(dyn(sy.ret, 3), '00'); assert.equal(word(sx.ret, 2), 1n); assert.equal(word(sy.ret, 2), 0n);
  assert.equal(BigInt('0x' + sy.ret.slice(2, 66)), BigInt(B.toString()));
  revertsWith(await call(A, R, enc.step(y, '01')), 'NotSessionOwner');
});
await t('plain value transfer is rejected', async () => { const r = await call(A, R, '0x', 1n); assert.equal(r.ok, false); });
await t('value sent with a call to a nonpayable function is rejected', async () => { const r = await call(A, R, enc.open(1, 1), 1n); assert.equal(r.ok, false); });
await t('call with unknown selector is rejected', async () => { const r = await call(A, R, '0xdeadbeef'); assert.equal(r.ok, false); });
await t('contract holds no balance', async () => { const acc = await vm.stateManager.getAccount(R); assert.equal((acc?.balance ?? 0n), 0n); });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
