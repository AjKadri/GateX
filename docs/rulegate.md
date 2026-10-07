# RuleGate

A TapeOut circuit decides each move of a rule but does not remember anything: the caller has to store the state
between calls. RuleGate is a small contract that stores it on X Layer. A session is opened on a circuit, starts in the
rule's first declared state, and can only move forward the way the circuit allows.

Source: [`contracts/RuleGate.sol`](../contracts/RuleGate.sol). Compiled ABI and bytecode: `contracts/RuleGate.json`.
Tests in a local EVM: `contracts/test/rulegate.evm.test.mjs` (not part of `npm test`). The browser client is
`src/app/rulegate.ts`, the page is `#/sessions`, and the deployed address is recorded in `deployments/rulegate.json`
(`address` is `null` until it is deployed).

## The four functions

- `open(uint256 circuitId, uint256 stateBytes) returns (uint256 sessionId)` opens a session on a circuit of the
  GateX processor. `stateBytes` is the length of the circuit's state in bytes (state bits rounded up), 1 to 32. The
  state starts as that many zero bytes, which is the rule's first declared state. It reverts for an unknown circuit.
- `step(uint256 sessionId, bytes inputs) returns (bytes newState, bytes outputs)` asks the processor's `step` for
  the next state and outputs, stores them, adds one to the step count and emits `Stepped`. Only the opener can call it.
  `inputs` is 1 to 32 bytes. It reverts if the circuit returns a state of a different length.
- `preview(uint256 sessionId, bytes inputs)` is a view: what `step` would return right now, changing nothing.
- `session(uint256 sessionId)` is a view: owner, circuit id, step count, current state and the outputs of the last step.

`sessionCount()` and `processor()` are plain getters.

## The two events

- `SessionOpened(uint256 indexed sessionId, uint256 indexed circuitId, address indexed owner, uint256 stateBytes)`
- `Stepped(uint256 indexed sessionId, uint256 indexed circuitId, address indexed caller, uint32 step, bytes inputs, bytes newState, bytes outputs)`

Errors: `NoSuchSession`, `NotSessionOwner`, `BadLength`, `CircuitChangedStateLength`.

## Guarantees

- It holds no funds. It has no `receive` or `fallback`, and no function is payable.
- It has no owner, no admin and no upgrade path. Nobody can change a session except its opener, and the opener can
  only change it by running a step through the circuit.
- Only the wallet that opened a session can advance it.
- A session starts at the all-zero state. GateX only offers circuits whose rule's first declared state is also its
  initial state, so zero means the rule's start.
- A step never stores anything the circuit did not return, and never changes the length of the state.

## Not guaranteed

- It has not been audited.
- The processor's `step` is trusted as it is. If the processor, or the circuit stored in it, is wrong, RuleGate
  records the wrong answer.
- RuleGate does not know which rule a circuit implements. The page names the rule only when this browser has a rule
  whose compiled bytes are identical to the circuit on chain.
- Opening is open to everyone, so anyone can create sessions on any circuit. A session proves only that its opener
  advanced it through that circuit, not that the opener is trusted.
- Output bits are returned and stored as the last outputs of the circuit. A rule that emits `permit` on a move
  produces a pulse in one step; RuleGate does not turn it into a stored permit.
- Gas is paid by the caller of each transaction.
