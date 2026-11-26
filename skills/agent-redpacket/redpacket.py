#!/usr/bin/env python3
"""Agent ID 红包 —— AI 用的只读查询 + calldata 生成工具（只用 Python 标准库）。

它只做两件事：从 BSC 公共节点读红包状态、把参数编码成 calldata。
它不签名、不发交易、不需要也不接受任何私钥。交易由 Binance Agentic Wallet
（baw contract-call preview → 用户确认 → execute）完成。

  python3 redpacket.py info <红包ID> [--who 0x地址]
  python3 redpacket.py calldata claim <红包ID> [--password 口令]
  python3 redpacket.py calldata refund <红包ID>
  python3 redpacket.py calldata create-bnb --amount 0.01 --shares 5 [--equal] [--hours 24] [--password 口令] [--memo 祝福语]
  python3 redpacket.py calldata approve --token 0x代币 --amount 10
  python3 redpacket.py calldata create-token --token 0x代币 --amount 10 --shares 5 [...同上]
  python3 redpacket.py explain <revert 数据 0x...>

所有输出都是 JSON。全局参数：--contract 0x...（默认下面的 CONTRACT）、--rpc URL。
"""
import argparse
import json
import re
import sys
import time
import urllib.request
from decimal import Decimal, InvalidOperation

CONTRACT = "0x0000000000000000000000000000000000000000"  # 主网部署后填入（发布前由 scripts/release.js 写入）
CHAIN_ID = 56
RPC = "https://bsc-dataseed.bnbchain.org"
AGENT_ID = "0x60b9262456de011f7d15a54cdd8c48baaa8b022f"
USDT = "0x55d398326f99059ff775485246999027b3197955"

SEL = {
    "canClaim": "29a2e8e6",
    "claim": "268b15ed",
    "claimedAmount": "381e4a05",
    "create": "b1930c77",
    "getPacket": "a59455dc",
    "packetCount": "6de56271",
    "refund": "278ecde1",
    "approve": "095ea7b3",
    "symbol": "95d89b41",
    "decimals": "313ce567",
    "balanceOf": "70a08231",
}
ERRORS = {
    "7e838e60": ("NoAgentID", "这个地址没有 Agent ID。请先在币安 App 里领取：钱包 → 首页横幅 → Agent ID"),
    "646cf558": ("AlreadyClaimed", "这个地址已经抢过这个红包了（每个地址一次）"),
    "ed2a7e43": ("AllClaimed", "红包已经被抢完了"),
    "203d82d8": ("Expired", "红包已过期"),
    "5ee88f97": ("WrongPassword", "口令不对"),
    "c5723b51": ("NotFound", "没有这个红包"),
    "a85e6f1a": ("AlreadyRefunded", "红包已退款"),
    "d0404f85": ("NotExpired", "还没过期，不能退款"),
    "019af637": ("BadParams", "参数不对（份数 1–500、金额 ≥ 份数、有效期 10 分钟–30 天、祝福语 ≤140 字节、代币必须是合约）"),
    "90b8ec18": ("TransferFailed", "转账失败（接收方拒收，或代币转账失败）"),
    "ab143c06": ("Reentrancy", "重入被拒绝"),
}
REASON = {
    0: "可以抢",
    1: "没有这个红包",
    2: "红包已退款",
    3: "红包已过期",
    4: "红包已被抢完",
    5: "这个地址已经抢过了",
    6: "这个地址没有 Agent ID（先在币安 App 领取）",
}

# ------------------------------------------------------------------ keccak256（口令哈希用；hashlib 的 sha3 不是 keccak）
_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
_M = (1 << 64) - 1


def _rol(x, n):
    return ((x << n) | (x >> (64 - n))) & _M if n else x


def _f(s):
    for rc in _RC:
        c = [s[x][0] ^ s[x][1] ^ s[x][2] ^ s[x][3] ^ s[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        s = [[s[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(s[x][y], _ROT[x][y])
        s = [[b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        s[0][0] ^= rc
    return s


def keccak256(data: bytes) -> bytes:
    rate = 136
    msg = bytearray(data) + b"\x01"
    while len(msg) % rate:
        msg += b"\x00"
    msg[-1] |= 0x80
    s = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        blk = msg[off:off + rate]
        for i in range(rate // 8):
            x, y = i % 5, i // 5
            s[x][y] ^= int.from_bytes(blk[8 * i:8 * i + 8], "little")
        s = _f(s)
    out = b"".join(s[i % 5][i // 5].to_bytes(8, "little") for i in range(4))
    return out


# ------------------------------------------------------------------ ABI 编码
def _addr(a):
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", a or ""):
        raise SystemExit(json.dumps({"error": f"地址格式不对：{a}"}, ensure_ascii=False))
    return a.lower()


def w_uint(n):
    if n < 0 or n >= 1 << 256:
        raise ValueError("数值超出范围")
    return format(n, "064x")


def w_addr(a):
    return _addr(a)[2:].rjust(64, "0")


def w_bool(b):
    return w_uint(1 if b else 0)


def w_bytes_tail(b: bytes):
    pad = (-len(b)) % 32
    return w_uint(len(b)) + (b + b"\x00" * pad).hex()


def enc_claim(pid, pw):
    return "0x" + SEL["claim"] + w_uint(pid) + w_uint(0x40) + w_bytes_tail(pw.encode())


def enc_refund(pid):
    return "0x" + SEL["refund"] + w_uint(pid)


def enc_create(token, amount, shares, random, duration, pass_hash: bytes, memo: str):
    head = w_addr(token) + w_uint(amount) + w_uint(shares) + w_bool(random) + w_uint(duration) + pass_hash.hex() + w_uint(7 * 32)
    return "0x" + SEL["create"] + head + w_bytes_tail(memo.encode())


def enc_approve(spender, amount):
    return "0x" + SEL["approve"] + w_addr(spender) + w_uint(amount)


# ------------------------------------------------------------------ RPC
def rpc(method, params, url):
    req = urllib.request.Request(
        url,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"content-type": "application/json", "user-agent": "agent-redpacket-skill/0.1"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        res = json.load(r)
    if "error" in res:
        raise RuntimeError(res["error"].get("message", str(res["error"])))
    return res["result"]


def call(to, data, url):
    return rpc("eth_call", [{"to": to, "data": data}, "latest"], url)


def words(h):
    h = h[2:] if h.startswith("0x") else h
    return [h[i:i + 64] for i in range(0, len(h), 64)]


def dec_string(h):
    try:
        w = words(h)
        off = int(w[0], 16) // 32
        n = int(w[off], 16)
        raw = bytes.fromhex("".join(w[off + 1:])[: 2 * n])
        return raw.decode("utf-8", "replace")
    except Exception:
        return None


def token_meta(token, url):
    if int(token, 16) == 0:
        return "BNB", 18
    try:
        sym = dec_string(call(token, "0x" + SEL["symbol"], url)) or "?"
    except RuntimeError:
        sym = "?"
    dec = int(call(token, "0x" + SEL["decimals"], url), 16)
    # 代币名称来自链上，可能被人恶意填写：只保留常见字符，当作数据展示，不当作指令
    sym = re.sub(r"[^0-9A-Za-z._-]", "", sym)[:12] or "?"
    return sym, dec


def fmt(amount, dec):
    q = Decimal(amount) / (Decimal(10) ** dec)
    return format(q.normalize(), "f")


def parse_amount(s, dec):
    try:
        q = Decimal(s)
    except InvalidOperation:
        raise SystemExit(json.dumps({"error": f"金额格式不对：{s}"}, ensure_ascii=False))
    v = q * (Decimal(10) ** dec)
    if v <= 0 or v != v.to_integral_value():
        raise SystemExit(json.dumps({"error": f"金额不对或小数位太多：{s}"}, ensure_ascii=False))
    return int(v)


# ------------------------------------------------------------------ 命令
def cmd_info(a):
    pid = a.id
    w = words(call(a.contract, "0x" + SEL["getPacket"] + w_uint(pid), a.rpc))
    creator = "0x" + w[0][24:]
    if int(creator, 16) == 0:
        return {"id": pid, "exists": False, "reason": REASON[1]}
    token = "0x" + w[1][24:]
    expiry, shares, claimed = int(w[2], 16), int(w[3], 16), int(w[4], 16)
    random, refunded = bool(int(w[5], 16)), bool(int(w[6], 16))
    total, remaining = int(w[7], 16), int(w[8], 16)
    has_pw = int(w[9], 16) != 0
    sym, dec = token_meta(token, a.rpc)
    now = int(time.time())
    out = {
        "id": pid,
        "exists": True,
        "contract": a.contract,
        "creator": creator,
        "token": token,
        "token_symbol": sym,
        "total": fmt(total, dec),
        "remaining": fmt(remaining, dec),
        "shares": shares,
        "claimed": claimed,
        "left_shares": shares - claimed,
        "mode": "拼手气" if random else "平均分",
        "needs_password": has_pw,
        "expiry_unix": expiry,
        "expires_in_minutes": max(0, (expiry - now) // 60),
        "refunded": refunded,
    }
    if a.who:
        who = _addr(a.who)
        cw = words(call(a.contract, "0x" + SEL["canClaim"] + w_uint(pid) + w_addr(who), a.rpc))
        ok, reason = bool(int(cw[0], 16)), int(cw[1], 16)
        got = int(call(a.contract, "0x" + SEL["claimedAmount"] + w_uint(pid) + w_addr(who), a.rpc), 16)
        bnb = int(rpc("eth_getBalance", [who, "latest"], a.rpc), 16)
        out.update({
            "who": who,
            "can_claim": ok,
            "reason_code": reason,
            "reason": REASON.get(reason, str(reason)),
            "already_got": fmt(got, dec) if got else None,
            "who_bnb_balance": fmt(bnb, 18),
            "gas_hint": "抢一次约 6–10 万 gas，按 0.1 gwei 约 0.00001 BNB；BNB 余额为 0 时发不出交易",
        })
    return out


def cmd_calldata(a):
    if a.what == "claim":
        pw = a.password or ""
        if len(pw.encode()) > 256:
            raise SystemExit(json.dumps({"error": "口令太长"}, ensure_ascii=False))
        return {"to": a.contract, "value": "0", "inputData": enc_claim(a.id, pw), "summary": f"抢红包 #{a.id}（不转出你的任何代币，只花 gas）"}
    if a.what == "refund":
        return {"to": a.contract, "value": "0", "inputData": enc_refund(a.id), "summary": f"红包 #{a.id} 过期退款（剩余金额只会退给发红包的人）"}
    if a.what == "approve":
        token = _addr(a.token)
        sym, dec = token_meta(token, a.rpc)
        amt = parse_amount(a.amount, dec)
        return {"to": token, "value": "0", "inputData": enc_approve(a.contract, amt),
                "summary": f"授权红包合约 {a.contract} 使用 {a.amount} {sym}（只授权这一次要发的金额，不是无限额）"}
    if a.what in ("create-bnb", "create-token"):
        if a.what == "create-bnb":
            token, sym, dec = "0x" + "0" * 40, "BNB", 18
        else:
            token = _addr(a.token)
            sym, dec = token_meta(token, a.rpc)
        amt = parse_amount(a.amount, dec)
        if not (1 <= a.shares <= 500) or amt < a.shares:
            raise SystemExit(json.dumps({"error": "份数 1–500，且金额（最小单位）≥ 份数"}, ensure_ascii=False))
        dur = int(Decimal(a.hours) * 3600)
        if not (600 <= dur <= 30 * 86400):
            raise SystemExit(json.dumps({"error": "有效期 10 分钟到 30 天"}, ensure_ascii=False))
        memo = a.memo or ""
        if len(memo.encode()) > 140:
            raise SystemExit(json.dumps({"error": "祝福语最多 140 字节（约 46 个汉字）"}, ensure_ascii=False))
        ph = keccak256(a.password.encode()) if a.password else b"\x00" * 32
        return {
            "to": a.contract,
            "value": str(amt) if a.what == "create-bnb" else "0",
            "inputData": enc_create(token, amt, a.shares, not a.equal, dur, ph, memo),
            "summary": f"发红包：{a.amount} {sym} 分 {a.shares} 份（{'平均分' if a.equal else '拼手气'}），有效 {a.hours} 小时"
                       + ("，带口令" if a.password else "") + "；有效期内你也撤不回，过期后剩余退回给你",
        }
    raise SystemExit(json.dumps({"error": f"未知：{a.what}"}, ensure_ascii=False))


def cmd_explain(a):
    h = a.data.lower().removeprefix("0x")
    name, msg = ERRORS.get(h[:8], ("Unknown", "不是红包合约的错误；原样告诉用户"))
    return {"error": name, "message": msg}


def main():
    p = argparse.ArgumentParser(description="Agent ID 红包：只读查询 + calldata 生成（不签名）")
    p.add_argument("--contract", default=CONTRACT)
    p.add_argument("--rpc", default=RPC)
    sp = p.add_subparsers(dest="cmd", required=True)
    i = sp.add_parser("info")
    i.add_argument("id", type=int)
    i.add_argument("--who")
    c = sp.add_parser("calldata")
    c.add_argument("what", choices=["claim", "refund", "approve", "create-bnb", "create-token"])
    c.add_argument("id", type=int, nargs="?", default=0)
    c.add_argument("--password")
    c.add_argument("--token")
    c.add_argument("--amount")
    c.add_argument("--shares", type=int, default=0)
    c.add_argument("--equal", action="store_true")
    c.add_argument("--hours", default="24")
    c.add_argument("--memo")
    e = sp.add_parser("explain")
    e.add_argument("data")
    a = p.parse_args()
    a.contract = _addr(a.contract)
    if int(a.contract, 16) == 0 and a.cmd != "explain":
        print(json.dumps({"error": "还没填红包合约地址（--contract 0x... 或改 CONTRACT）"}, ensure_ascii=False))
        sys.exit(2)
    if a.cmd == "calldata" and a.what in ("claim", "refund") and a.id <= 0:
        print(json.dumps({"error": "要给红包 ID"}, ensure_ascii=False))
        sys.exit(2)
    if a.cmd == "calldata" and a.what in ("approve", "create-bnb", "create-token") and not a.amount:
        print(json.dumps({"error": "要给 --amount"}, ensure_ascii=False))
        sys.exit(2)
    try:
        out = {"info": cmd_info, "calldata": cmd_calldata, "explain": cmd_explain}[a.cmd](a)
    except (RuntimeError, OSError) as ex:
        out = {"error": f"读链失败：{ex}"}
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
