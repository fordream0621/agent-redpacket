// 检查 web/index.html 里手写的 ABI 和真合约一致：getPacket 解码、事件解析、自定义错误、分段 getLogs。
// npx hardhat run scripts/check_web_abi.js --network local
const fs = require("fs"), path = require("path");
const { ethers } = require("hardhat");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const abiSrc = html.match(/const ABI = (\[[\s\S]*?\]);/)[1];
const ABI = eval(abiSrc);
let bad = 0; const eq = (a, b, m) => { if (String(a) !== String(b)) { bad++; console.log("✗", m, a, b); } else console.log("✓", m); };

async function main() {
  const [creator, a] = await ethers.getSigners();
  const aid = await (await ethers.getContractFactory("MockAgentID")).deploy();
  const real = await (await ethers.getContractFactory("AgentRedPacket")).deploy(await aid.getAddress());
  await (await aid.mint(a.address)).wait();
  const addr = await real.getAddress();
  const C = new ethers.Contract(addr, ABI, creator);
  // 页面 ABI 的选择器都必须在真合约里
  const realSel = new Set(); real.interface.forEachFunction((f) => realSel.add(f.selector)); real.interface.forEachEvent((e) => realSel.add(e.topicHash)); real.interface.forEachError((e) => realSel.add(e.selector));
  C.interface.forEachFunction((f) => eq(realSel.has(f.selector), true, "函数 " + f.format()));
  C.interface.forEachEvent((e) => eq(realSel.has(e.topicHash), true, "事件 " + e.name));
  C.interface.forEachError((e) => eq(realSel.has(e.selector), true, "错误 " + e.name));

  const v = ethers.parseEther("0.01");
  const rc = await (await C.create(ethers.ZeroAddress, v, 3, true, 3600, ethers.id("口令"), "新年快乐", { value: v })).wait();
  const ev = rc.logs.map((l) => { try { return C.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "PacketCreated");
  eq(ev.args.id, 1, "PacketCreated id"); eq(ev.args.memo, "新年快乐", "PacketCreated memo");
  const p = await C.getPacket(1);
  eq(p.shares, 3, "getPacket.shares"); eq(p.total, v, "getPacket.total"); eq(p.random, true, "getPacket.random"); eq(p.creator, creator.address, "getPacket.creator");
  eq(p.passHash, ethers.id("口令"), "getPacket.passHash = ethers.id(口令)（页面发红包用的哈希和合约校验一致）");
  try { await C.connect(a).claim.staticCall(1, "错"); bad++; } catch (e) {
    const d = e.data; eq(C.interface.parseError(typeof d === "string" ? d : d.data).name, "WrongPassword", "页面能解析自定义错误");
  }
  await (await C.connect(a).claim(1, "口令")).wait();
  const logs = await ethers.provider.getLogs({ address: addr, fromBlock: 0, toBlock: "latest" });
  const names = logs.map((l) => { try { return C.interface.parseLog(l).name; } catch { return "?"; } });
  eq(names.join(","), "PacketCreated,Claimed", "getLogs 解析");
  const [ok, reason] = await C.canClaim(1, a.address); eq(`${ok},${reason}`, "false,5", "canClaim 抢过");
  console.log(bad ? `\n${bad} 项不一致` : "\n全部一致"); process.exitCode = bad ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
