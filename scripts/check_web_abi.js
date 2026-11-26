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
  // 「复制给 AI」：网页生成的 calldata（同样的写法）直接当裸交易发，结果要对
  const ERC20 = eval(html.match(/const ERC20 = (\[[\s\S]*?\]);/)[1]);
  const usdt = await (await ethers.getContractFactory("MockERC20")).deploy();
  await (await usdt.mint(creator.address, ethers.parseEther("5"))).wait();
  const amt = ethers.parseUnits("1.5", 18), tok = await usdt.getAddress();
  const approveData = new ethers.Interface(ERC20).encodeFunctionData("approve", [addr, amt]);
  const createData = C.interface.encodeFunctionData("create", [tok, amt, 3, true, BigInt(24 * 3600), ethers.id("恭喜发财"), "新年快乐"]);
  await (await creator.sendTransaction({ to: tok, value: 0n, data: approveData })).wait();
  eq(await usdt.allowance(creator.address, addr), amt, "AI 授权：精确额度");
  const rc2 = await (await creator.sendTransaction({ to: addr, value: 0n, data: createData })).wait();
  const ev2 = rc2.logs.map((l) => { try { return C.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "PacketCreated");
  eq(ev2.args.total, amt, "AI 发红包：金额"); eq(ev2.args.memo, "新年快乐", "AI 发红包：祝福语");
  const pid = Number(ev2.args.id);
  await (await a.sendTransaction({ to: addr, value: 0n, data: C.interface.encodeFunctionData("claim", [pid, "恭喜发财"]) })).wait();
  eq((await C.claimedAmount(pid, a.address)) > 0n, true, "AI 抢红包：口令红包抢到");
  const vb = ethers.parseEther("0.02");
  const rc3 = await (await creator.sendTransaction({ to: addr, value: vb, data: C.interface.encodeFunctionData("create", [ethers.ZeroAddress, vb, 2, false, 3600n, ethers.ZeroHash, ""]) })).wait();
  eq(rc3.status, 1, "AI 发 BNB 红包：一笔交易 value=金额");
  console.log(bad ? `\n${bad} 项不一致` : "\n全部一致"); process.exitCode = bad ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
