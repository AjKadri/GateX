// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The part of a TapeOut processor that RuleGate uses. `step` is a pure evaluation:
/// it takes the current state and the inputs and returns the next state and the outputs.
interface ITapeOutProcessor {
    function step(uint256 id, bytes calldata state, bytes calldata inputs)
        external
        view
        returns (bytes memory newState, bytes memory outputs);

    function ownerOf(uint256 id) external view returns (address);
}

/// @title RuleGate
/// @notice Keeps the state of a rule on chain. A TapeOut circuit decides each transition; RuleGate
/// remembers the result, so a rule can only move forward the way its circuit allows.
/// @dev Holds no funds, has no owner, no admin and no upgrade path. Anyone can open a session on any
/// circuit of the processor; only the wallet that opened a session can advance it.
contract RuleGate {
    ITapeOutProcessor public immutable processor;

    uint256 public constant MAX_STATE_BYTES = 32;
    uint256 public constant MAX_INPUT_BYTES = 32;

    struct Session {
        address owner;
        uint64 circuitId;
        uint32 steps;
        bytes state;
        bytes lastOutputs;
    }

    uint256 public sessionCount;
    mapping(uint256 => Session) private _sessions;

    event SessionOpened(uint256 indexed sessionId, uint256 indexed circuitId, address indexed owner, uint256 stateBytes);
    event Stepped(
        uint256 indexed sessionId,
        uint256 indexed circuitId,
        address indexed caller,
        uint32 step,
        bytes inputs,
        bytes newState,
        bytes outputs
    );

    error NoSuchSession();
    error NotSessionOwner();
    error BadLength();
    error CircuitChangedStateLength();

    constructor(ITapeOutProcessor processor_) {
        processor = processor_;
    }

    /// @notice Opens a session on `circuitId`, starting from the all-zero state (the rule's first declared state).
    /// @param stateBytes Length of the circuit's state in bytes (state bits rounded up to whole bytes).
    function open(uint256 circuitId, uint256 stateBytes) external returns (uint256 sessionId) {
        if (stateBytes == 0 || stateBytes > MAX_STATE_BYTES) revert BadLength();
        if (circuitId > type(uint64).max) revert BadLength();
        processor.ownerOf(circuitId); // reverts if the circuit does not exist
        sessionId = ++sessionCount;
        Session storage s = _sessions[sessionId];
        s.owner = msg.sender;
        s.circuitId = uint64(circuitId);
        s.state = new bytes(stateBytes);
        emit SessionOpened(sessionId, circuitId, msg.sender, stateBytes);
    }

    /// @notice Advances a session by one transition. The circuit computes the next state from the stored
    /// state and `inputs`; the result replaces the stored state. Only the session's opener may call this.
    function step(uint256 sessionId, bytes calldata inputs) external returns (bytes memory newState, bytes memory outputs) {
        Session storage s = _sessions[sessionId];
        if (s.owner == address(0)) revert NoSuchSession();
        if (s.owner != msg.sender) revert NotSessionOwner();
        if (inputs.length == 0 || inputs.length > MAX_INPUT_BYTES) revert BadLength();
        (newState, outputs) = processor.step(s.circuitId, s.state, inputs);
        if (newState.length != s.state.length) revert CircuitChangedStateLength();
        if (outputs.length > MAX_INPUT_BYTES) revert BadLength();
        s.state = newState;
        s.lastOutputs = outputs;
        s.steps += 1;
        emit Stepped(sessionId, s.circuitId, msg.sender, s.steps, inputs, newState, outputs);
    }

    /// @notice What `step` would return right now, without changing anything.
    function preview(uint256 sessionId, bytes calldata inputs) external view returns (bytes memory newState, bytes memory outputs) {
        Session storage s = _sessions[sessionId];
        if (s.owner == address(0)) revert NoSuchSession();
        return processor.step(s.circuitId, s.state, inputs);
    }

    function session(uint256 sessionId)
        external
        view
        returns (address owner, uint256 circuitId, uint256 steps, bytes memory state, bytes memory lastOutputs)
    {
        Session storage s = _sessions[sessionId];
        if (s.owner == address(0)) revert NoSuchSession();
        return (s.owner, s.circuitId, s.steps, s.state, s.lastOutputs);
    }
}
