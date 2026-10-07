import solc from 'solc'; import fs from 'fs';
const src = fs.readFileSync('./contracts/RuleGate.sol','utf8');
const settings = { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi','evm.bytecode.object','evm.deployedBytecode.object'] } } };
const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'RuleGate.sol': { content: src } }, settings })));
for (const e of out.errors ?? []) console.log(e.severity, e.formattedMessage);
const c = out.contracts['RuleGate.sol'].RuleGate;
fs.writeFileSync('./contracts/RuleGate.json', JSON.stringify({ contract: 'RuleGate', source: 'contracts/RuleGate.sol', compiler: solc.version(), settings: { optimizer: settings.optimizer, evmVersion: settings.evmVersion }, abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2) + '\n');
console.log(solc.version(), 'bytecode bytes', c.evm.bytecode.object.length / 2);
