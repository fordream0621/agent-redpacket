#!/usr/bin/env python3
"""红包网页用的索引：把红包合约的事件 + Agent ID 名字目录整理成 web/index.json（只用 Python 标准库）。

  python3 scripts/indexer.py                 跑一次
  python3 scripts/indexer.py --loop 30       每 30 秒跑一次（systemd 用）

- 红包事件（PacketCreated / Claimed / Refunded）从部署区块开始。
- Agent ID 名字：Agent ID 合约每次 mint 发一个事件 (tokenId indexed, owner indexed, string name)，
  topic0 = NAME_TOPIC（链上实测，11-25 01:09 区块 135500360 开始 mint）。建一份 地址 → 名字 目录，
  index.json 里只放和红包有关的地址的名字（发红包的人、抢红包的人），外加全网 Agent ID 个数。
- 公共节点 eth_getLogs 一次最多 1 万块（有的后端 5 万），这里每段 9999 块，出错减半重试，两次请求之间停 0.25 秒。
- 状态存 scripts/.indexer_state.json，增量更新；index.json 先写临时文件再替换，网页不会读到半截。
"""
import argparse
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENT_ID = "0x60b9262456de011f7d15a54cdd8c48baaa8b022f"
AGENT_ID_START = 135500360
NAME_TOPIC = "0x663d34a86c6277aafbd5c6912c96cc5df091e6702ea3ea91b8f378adcbd8a5e5"
T_CREATED = "0xc0a4715bdab48509c3c54864aa406780ee5179ca18444d42f20a6c16d37ed412"
T_CLAIMED = "0xbfd414481c8b351ed294b378eba3c6ea9fe425911297fcd2664abf283009e15e"
T_REFUNDED = "0x7ca5472b7ea78c2c0141c5a12ee6d170cf4ce8ed06be3d22c8252ddfc7a6a2c4"
STEP = 9999
CONFIRM = 3  # 只索引到 head − 3 块，避免短暂分叉


class RPC:
    def __init__(self, url):
        self.url = url

    def __call__(self, method, params):
        last = None
        for k in range(5):
            try:
                req = urllib.request.Request(
                    self.url,
                    json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                    {"content-type": "application/json", "user-agent": "agent-redpacket-indexer/0.1"},
                )
                r = json.load(urllib.request.urlopen(req, timeout=30))
                if "error" in r:
                    raise RuntimeError(r["error"].get("message", str(r["error"])))
                return r["result"]
            except Exception as e:  # noqa: BLE001
                last = e
                if "range" in str(e):
                    raise
                time.sleep(1.5 * (k + 1))
        raise last


def logs_range(rpc, address, topics, fr, to):
    """[fr, to] 分段拉日志，超范围就减半。"""
    out, step, cur = [], STEP, fr
    while cur <= to:
        end = min(to, cur + step - 1)
        try:
            out += rpc("eth_getLogs", [{"address": address, "fromBlock": hex(cur), "toBlock": hex(end), "topics": topics}])
            cur = end + 1
            step = min(STEP, step * 2)
        except RuntimeError as e:
            if "range" not in str(e) or step <= 100:
                raise
            step //= 2
        time.sleep(0.25)
    return out


def words(data):
    h = data[2:]
    return [h[i:i + 64] for i in range(0, len(h), 64)]


def dec_string(data, off_word):
    w = words(data)
    off = int(w[off_word], 16) // 32
    n = int(w[off], 16)
    return bytes.fromhex("".join(w[off + 1:])[: 2 * n]).decode("utf-8", "replace")


def addr_of(topic):
    return "0x" + topic[-40:]


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def run_once(cfg, state_path, out_path, rpc):
    st = load_json(state_path, None)
    if not st or st.get("contract", "").lower() != cfg["contract"].lower():
        st = {"contract": cfg["contract"], "last": cfg["deployBlock"] - 1, "names_last": cfg.get("agentIdStart", AGENT_ID_START) - 1,
              "created": {}, "claims": [], "refunded": {}, "names": {}}
    head = int(rpc("eth_blockNumber", []), 16) - CONFIRM

    # 红包事件
    if head > st["last"]:
        for lg in logs_range(rpc, cfg["contract"], [], st["last"] + 1, head):
            t0, blk, tx = lg["topics"][0], int(lg["blockNumber"], 16), lg["transactionHash"]
            w = words(lg["data"])
            if t0 == T_CREATED:
                pid = int(lg["topics"][1], 16)
                st["created"][str(pid)] = {
                    "id": pid, "creator": addr_of(lg["topics"][2]), "token": addr_of(lg["topics"][3]),
                    "total": str(int(w[0], 16)), "shares": int(w[1], 16), "random": bool(int(w[2], 16)),
                    "expiry": int(w[3], 16), "hasPassword": bool(int(w[4], 16)), "memo": dec_string(lg["data"], 5),
                    "blk": blk, "tx": tx,
                }
            elif t0 == T_CLAIMED:
                key = tx + ":" + str(int(lg["logIndex"], 16))
                if not any(c["key"] == key for c in st["claims"][-500:]):
                    st["claims"].append({"key": key, "id": int(lg["topics"][1], 16), "claimer": addr_of(lg["topics"][2]),
                                         "amount": str(int(w[0], 16)), "index": int(w[1], 16), "blk": blk, "tx": tx})
            elif t0 == T_REFUNDED:
                st["refunded"][str(int(lg["topics"][1], 16))] = {"amount": str(int(w[0], 16)), "blk": blk, "tx": tx}
        st["last"] = head

    # Agent ID 名字目录（全网）
    if head > st["names_last"]:
        for lg in logs_range(rpc, cfg["agentId"], [cfg.get("nameTopic", NAME_TOPIC)], st["names_last"] + 1, head):
            try:
                st["names"][addr_of(lg["topics"][2])] = dec_string(lg["data"], 0)
            except Exception:  # noqa: BLE001
                continue
        st["names_last"] = head

    write_json(state_path, st)
    involved = {c["claimer"] for c in st["claims"]} | {p["creator"] for p in st["created"].values()}
    out = {
        "contract": st["contract"], "chainId": cfg["chainId"], "last": st["last"], "updated": int(time.time()),
        "created": st["created"], "claims": st["claims"], "refunded": st["refunded"],
        "names": {a: st["names"][a] for a in involved if a in st["names"]},
        "agentIdTotal": len(st["names"]),
    }
    write_json(out_path, out)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(ROOT, "web", "config.js"))
    ap.add_argument("--out", default=os.path.join(ROOT, "web", "index.json"))
    ap.add_argument("--state", default=os.path.join(ROOT, "scripts", ".indexer_state.json"))
    ap.add_argument("--rpc", help="默认用 config.js 里的 logsRpc")
    ap.add_argument("--loop", type=int, default=0, help="每隔多少秒跑一次；0 = 只跑一次")
    a = ap.parse_args()
    txt = open(a.config).read()
    try:
        cfg = json.loads(txt[txt.index("{"): txt.rindex("}") + 1])
    except ValueError:
        sys.exit("config.js 还是未部署的占位（先 node scripts/release.js 56）")
    cfg.setdefault("agentId", AGENT_ID)
    if int(cfg.get("contract", "0x0"), 16) == 0 or not cfg.get("deployBlock"):
        sys.exit("config.js 里还没有合约地址 / 部署区块（先 node scripts/release.js 56）")
    rpc = RPC(a.rpc or cfg.get("logsRpc") or "https://bsc-rpc.publicnode.com")
    while True:
        t = time.time()
        try:
            o = run_once(cfg, a.state, a.out, rpc)
            print(f"{time.strftime('%m-%d %H:%M:%S')} 区块 {o['last']}：红包 {len(o['created'])} 个、被抢 {len(o['claims'])} 次、"
                  f"全网 Agent ID {o['agentIdTotal']}", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"{time.strftime('%m-%d %H:%M:%S')} 出错：{e}", file=sys.stderr, flush=True)
            if not a.loop:
                sys.exit(1)
        if not a.loop:
            return
        time.sleep(max(5, a.loop - (time.time() - t)))


if __name__ == "__main__":
    main()
