// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title AgentRedPacket — Agent ID 红包（一人一份）
/// @notice 只有持有 Agent ID（不可转让、每个 KYC 一个）的地址才能抢，每个地址每个红包只能抢一次。
///         无 owner、无管理员、无手续费、不可升级。合约只保管红包里的钱，任何人都无法挪用。
/// @dev    随机金额用 blockhash/prevrandao 生成，**不是安全随机数**，只适合小额娱乐红包。
contract AgentRedPacket {
    // ---------------------------------------------------------------- 常量
    uint256 public constant MAX_SHARES = 500;
    uint64 public constant MIN_DURATION = 10 minutes;
    uint64 public constant MAX_DURATION = 30 days;
    uint256 public constant MAX_MEMO = 140; // 字节

    /// @notice Agent ID 合约（主网 0x60b9262456de011f7d15a54cdd8c48baaa8b022f），部署时写死。
    IAgentID public immutable agentId;

    struct Packet {
        address creator;
        address token; // address(0) = 原生 BNB
        uint64 expiry;
        uint16 shares; // 总份数
        uint16 claimed; // 已抢份数
        bool random; // true = 拼手气，false = 平均分
        bool refunded;
        uint256 total; // 总金额（最小单位）
        uint256 remaining; // 剩余金额
        bytes32 passHash; // 0 = 不要口令；否则 keccak256(bytes(口令))
    }

    uint256 public packetCount;
    mapping(uint256 => Packet) private _packets;
    mapping(uint256 => mapping(address => uint256)) public claimedAmount; // 0 = 没抢过

    uint256 private _lock = 1;

    // ---------------------------------------------------------------- 事件
    event PacketCreated(
        uint256 indexed id,
        address indexed creator,
        address indexed token,
        uint256 total,
        uint16 shares,
        bool random,
        uint64 expiry,
        bool hasPassword,
        string memo
    );
    event Claimed(uint256 indexed id, address indexed claimer, uint256 amount, uint16 index);
    event Refunded(uint256 indexed id, address indexed creator, uint256 amount);

    // ---------------------------------------------------------------- 错误
    error NoAgentID();
    error BadParams();
    error NotFound();
    error Expired();
    error NotExpired();
    error AllClaimed();
    error AlreadyClaimed();
    error WrongPassword();
    error AlreadyRefunded();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address agentId_) {
        if (agentId_ == address(0)) revert BadParams();
        agentId = IAgentID(agentId_);
    }

    // ---------------------------------------------------------------- 发红包
    /// @param token     ERC20 地址；address(0) 表示原生 BNB（此时 msg.value 必须等于 amount）
    /// @param amount    总金额（最小单位），每份至少 1
    /// @param shares    份数 1..500
    /// @param random    true 拼手气 / false 平均分
    /// @param duration  有效期（秒），10 分钟 ~ 30 天；期内发红包的人也不能撤回
    /// @param passHash  0 或 keccak256(bytes(口令))。口令在有人抢过之后链上公开，只是玩法，不是保密手段
    /// @param memo      祝福语，≤140 字节，只写进事件
    function create(
        address token,
        uint256 amount,
        uint16 shares,
        bool random,
        uint64 duration,
        bytes32 passHash,
        string calldata memo
    ) external payable nonReentrant returns (uint256 id) {
        if (shares == 0 || shares > MAX_SHARES) revert BadParams();
        if (amount < shares) revert BadParams();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadParams();
        if (bytes(memo).length > MAX_MEMO) revert BadParams();

        if (token == address(0)) {
            if (msg.value != amount) revert BadParams();
        } else {
            if (msg.value != 0) revert BadParams();
            if (token.code.length == 0) revert BadParams();
            // 只接受足额到账的代币（拒绝转账扣费 / 通缩代币）
            uint256 before = IERC20(token).balanceOf(address(this));
            _safeTransferFrom(token, msg.sender, address(this), amount);
            if (IERC20(token).balanceOf(address(this)) - before != amount) revert BadParams();
        }

        id = ++packetCount;
        uint64 expiry = uint64(block.timestamp) + duration;
        _packets[id] = Packet({
            creator: msg.sender,
            token: token,
            expiry: expiry,
            shares: shares,
            claimed: 0,
            random: random,
            refunded: false,
            total: amount,
            remaining: amount,
            passHash: passHash
        });
        emit PacketCreated(id, msg.sender, token, amount, shares, random, expiry, passHash != bytes32(0), memo);
    }

    // ---------------------------------------------------------------- 抢红包
    /// @param password 没有口令的红包传空字符串
    function claim(uint256 id, string calldata password) external nonReentrant returns (uint256 amount) {
        Packet storage p = _packets[id];
        if (p.creator == address(0)) revert NotFound();
        if (p.refunded) revert AlreadyRefunded();
        if (block.timestamp >= p.expiry) revert Expired();
        if (p.claimed >= p.shares) revert AllClaimed();
        if (claimedAmount[id][msg.sender] != 0) revert AlreadyClaimed();
        if (p.passHash != bytes32(0) && keccak256(bytes(password)) != p.passHash) revert WrongPassword();
        if (agentId.balanceOf(msg.sender) == 0) revert NoAgentID();

        uint256 left = p.shares - p.claimed; // 含这一份
        if (left == 1) {
            amount = p.remaining;
        } else if (p.random) {
            // 二倍均值法：每份在 [1, 2×剩余均值) 内随机，并保证后面每份至少 1
            uint256 maxAmt = (p.remaining / left) * 2;
            uint256 cap = p.remaining - (left - 1);
            if (maxAmt > cap) maxAmt = cap;
            if (maxAmt <= 1) {
                amount = 1;
            } else {
                uint256 r = uint256(
                    keccak256(abi.encodePacked(blockhash(block.number - 1), block.prevrandao, msg.sender, id, p.claimed))
                );
                amount = 1 + (r % (maxAmt - 1));
            }
        } else {
            amount = p.remaining / left;
        }

        // 先改状态再转账
        p.remaining -= amount;
        p.claimed += 1;
        claimedAmount[id][msg.sender] = amount;
        emit Claimed(id, msg.sender, amount, p.claimed);

        _pay(p.token, msg.sender, amount);
    }

    // ---------------------------------------------------------------- 退款
    /// @notice 过期后任何人都可以调用，剩余金额退回发红包的人（不会退给调用者）。
    function refund(uint256 id) external nonReentrant {
        Packet storage p = _packets[id];
        if (p.creator == address(0)) revert NotFound();
        if (p.refunded) revert AlreadyRefunded();
        if (block.timestamp < p.expiry) revert NotExpired();
        uint256 amt = p.remaining;
        p.refunded = true;
        p.remaining = 0;
        emit Refunded(id, p.creator, amt);
        if (amt > 0) _pay(p.token, p.creator, amt);
    }

    // ---------------------------------------------------------------- 只读
    function getPacket(uint256 id) external view returns (Packet memory) {
        return _packets[id];
    }

    /// @notice 抢之前先查能不能抢（给 AI / 网页用，不花 gas）。
    /// @return ok      true = 现在可以抢
    /// @return reason  0 可以 / 1 不存在 / 2 已退款 / 3 已过期 / 4 已抢完 / 5 已抢过 / 6 没有 Agent ID
    ///                 （口令对不对这里不查，口令错时 claim 会报 WrongPassword）
    function canClaim(uint256 id, address who) external view returns (bool ok, uint8 reason) {
        Packet storage p = _packets[id];
        if (p.creator == address(0)) return (false, 1);
        if (p.refunded) return (false, 2);
        if (block.timestamp >= p.expiry) return (false, 3);
        if (p.claimed >= p.shares) return (false, 4);
        if (claimedAmount[id][who] != 0) return (false, 5);
        if (agentId.balanceOf(who) == 0) return (false, 6);
        return (true, 0);
    }

    // ---------------------------------------------------------------- 内部
    function _pay(address token, address to, uint256 amount) private {
        if (token == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _safeTransfer(token, to, amount);
        }
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}

interface IAgentID {
    function balanceOf(address owner) external view returns (uint256);
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}
