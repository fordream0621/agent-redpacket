// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice TEST-ONLY mock of Agent ID. Anyone can mint. Never use on mainnet.
contract MockAgentID {
    mapping(address => uint256) private _balances;

    function mint(address to) external {
        _balances[to] += 1;
    }

    /// 模拟主网 Agent ID mint 时的名字事件：topic0 = 0x663d34a8…（tokenId indexed, owner indexed, string name）
    function mintNamed(address to, string calldata name) external {
        _balances[to] += 1;
        bytes32 t0 = 0x663d34a86c6277aafbd5c6912c96cc5df091e6702ea3ea91b8f378adcbd8a5e5;
        bytes32 tokenId = keccak256(bytes(name));
        bytes memory data = abi.encode(name);
        assembly {
            log3(add(data, 32), mload(data), t0, tokenId, to)
        }
    }

    function burn(address from) external {
        require(_balances[from] > 0, "none");
        _balances[from] -= 1;
    }

    function balanceOf(address owner) external view returns (uint256) {
        return _balances[owner];
    }
}
