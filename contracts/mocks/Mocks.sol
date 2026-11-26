// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// TEST-ONLY
contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public feeBps; // >0 模拟转账扣费代币
    string public constant symbol = "mUSD";
    uint8 public constant decimals = 18;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function setFee(uint256 bps) external { feeBps = bps; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        require(allowance[f][msg.sender] >= a, "allowance");
        allowance[f][msg.sender] -= a;
        _move(f, to, a);
        return true;
    }
    function _move(address f, address to, uint256 a) internal {
        require(balanceOf[f] >= a, "balance");
        balanceOf[f] -= a;
        uint256 fee = (a * feeBps) / 10000;
        balanceOf[to] += a - fee;
    }
}

interface IRP {
    function claim(uint256 id, string calldata pw) external returns (uint256);
    function refund(uint256 id) external;
}

/// TEST-ONLY：收到 BNB 时尝试重入
contract Reenter {
    IRP public rp;
    uint256 public target;
    bool public tried;
    bool public reenterBlocked;
    constructor(address rp_) { rp = IRP(rp_); }
    function go(uint256 id) external { target = id; rp.claim(id, ""); }
    receive() external payable {
        if (!tried) {
            tried = true;
            try rp.claim(target, "") { } catch { reenterBlocked = true; }
        }
    }
}

/// TEST-ONLY：拒收 BNB
contract Rejecter {
    function go(address rp, uint256 id) external { IRP(rp).claim(id, ""); }
}
