// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Test double for the TapeOut processor. A 2-bit machine IDLE(0) -> REQUESTED(1) -> APPROVED(2) -> USED(3).
/// Inputs (bit 0..3): request, approve, execute, cancel. Output bit 0 pulses on APPROVED -> USED. cancel resets (not from USED).
/// Circuit ids 1..3 exist. `mode` 1 makes step return a state of the wrong length.
contract MockProcessor {
    uint8 public mode;

    function setMode(uint8 m) external { mode = m; }

    function ownerOf(uint256 id) external pure returns (address) {
        require(id >= 1 && id <= 3, "no such circuit");
        return address(uint160(0xBEEF));
    }

    function step(uint256, bytes calldata state, bytes calldata inputs)
        external
        view
        returns (bytes memory newState, bytes memory outputs)
    {
        uint8 s = state.length == 0 ? 0 : uint8(state[0]);
        uint8 i = uint8(inputs[0]);
        uint8 n = s;
        uint8 o = 0;
        if (s != 3) {
            if (i & 8 != 0) n = 0;
            else if (s == 0 && i & 1 != 0) n = 1;
            else if (s == 1 && i & 2 != 0) n = 2;
            else if (s == 2 && i & 4 != 0) { n = 3; o = 1; }
        }
        newState = new bytes(mode == 1 ? state.length + 1 : state.length);
        newState[0] = bytes1(n);
        outputs = new bytes(1);
        outputs[0] = bytes1(o);
    }
}
