// 对拍 skills/agent-redpacket/redpacket.py：编码和 ethers 一致、生成的 calldata 真能在链上用、info 读得对。
// 先开本地链：npx hardhat node --port 8547；再：npx hardhat run scripts/check_skill_tool.js --network local
const { ethers } = require("hardhat");
const { execFileSync } = require("child_process");
const path = require("path");
const PY = path.join(__dirname, "..", "skills", "agent-redpacket", "redpacket.py");
let C, RPC = "http://127.0.0.1:8547";
const py = (...args) => JSON.parse(execFileSync("python3", ["-I", PY, "--contract", C, "--rpc", RPC, ...args]).toString());
let bad = 0;
const eq = (a, b, m) => { if (String(a) !== String(b)) { bad++; console.log("✗", m, "\n   py:", a, "\n   js:", b); } else console.log("✓", m); };

async function main() {
  const [creator, a, b, noId] = await ethers.getSigners();
  const aid = await (await ethers.getContractFactory("MockAgentID")).deploy();
  const rp = await (await ethers.getContractFactory("AgentRedPacket")).deploy(await aid.getAddress());
  const usdt = await (await ethers.getContractFactory("MockERC20")).deploy();
  C = await rp.getAddress();
  await (await aid.mint(a.address)).wait();
  await (await aid.mint(b.address)).wait();
  await (await usdt.mint(creator.address, ethers.parseEther("100"))).wait();
  const I = rp.interface;

  // keccak / 编码对拍
  for (const s of ["", "恭喜发财", "a".repeat(200), "🧧 hello"]) {
    eq(py("calldata", "claim", "7", "--password", s).inputData, I.encodeFunctionData("claim", [7, s]), `claim 编码 ${JSON.stringify(s).slice(0, 20)}`);
  }
  eq(py("calldata", "refund", "3").inputData, I.encodeFunctionData("refund", [3]), "refund 编码");
  const cb = py("calldata", "create-bnb", "--amount", "0.01", "--shares", "4", "--hours", "2", "--password", "恭喜发财", "--memo", "新年快乐🧧");
  eq(cb.inputData, I.encodeFunctionData("create", [ethers.ZeroAddress, ethers.parseEther("0.01"), 4, true, 7200, ethers.id("恭喜发财"), "新年快乐🧧"]), "create-bnb 编码（含 keccak 口令）");
  eq(cb.value, ethers.parseEther("0.01"), "create-bnb value");
  const ap = py("calldata", "approve", "--token", await usdt.getAddress(), "--amount", "12.5");
  eq(ap.inputData, usdt.interface.encodeFunctionData("approve", [C, ethers.parseEther("12.5")]), "approve 编码（精确额度）");
  const ct = py("calldata", "create-token", "--token", await usdt.getAddress(), "--amount", "12.5", "--shares", "2", "--equal", "--hours", "1");
  eq(ct.inputData, I.encodeFunctionData("create", [await usdt.getAddress(), ethers.parseEther("12.5"), 2, false, 3600, ethers.ZeroHash, ""]), "create-token 编码");

  // 用工具生成的 calldata 真发交易
  await (await creator.sendTransaction({ to: cb.to, data: cb.inputData, value: BigInt(cb.value) })).wait();
  await (await creator.sendTransaction({ to: ap.to, data: ap.inputData })).wait();
  await (await creator.sendTransaction({ to: ct.to, data: ct.inputData })).wait();
  eq(await rp.packetCount(), 2, "两个红包都建成");

  let inf = py("info", "1", "--who", a.address);
  eq(inf.total, "0.01", "info 总额"); eq(inf.shares, 4, "info 份数"); eq(inf.needs_password, true, "info 需要口令");
  eq(inf.mode, "拼手气", "info 模式"); eq(inf.token_symbol, "BNB", "info 币种"); eq(inf.can_claim, true, "a 可以抢");
  eq(py("info", "1", "--who", noId.address).reason_code, 6, "没 Agent ID → 6");

  const cl = py("calldata", "claim", "1", "--password", "恭喜发财");
  await (await a.sendTransaction({ to: cl.to, data: cl.inputData })).wait();
  inf = py("info", "1", "--who", a.address);
  eq(inf.reason_code, 5, "抢过 → 5"); eq(inf.claimed, 1, "已抢 1 份");
  eq(inf.already_got, ethers.formatEther(await rp.claimedAmount(1, a.address)).replace(/\.0$/, ""), "already_got 金额");

  // 错口令：拿 revert 数据给 explain
  try { await b.call({ to: C, data: py("calldata", "claim", "1", "--password", "错").inputData }); bad++; console.log("✗ 错口令没 revert"); }
  catch (e) { let d = e.data || e.info?.error?.data || e.error?.data || (String(e.message).match(/0x[0-9a-f]{8}/) || [""])[0]; if (typeof d === "object") d = d.data; console.log("   revert 数据:", d); eq(py("explain", d).error, "WrongPassword", "explain 错口令"); }

  const i2 = py("info", "2");
  eq(i2.token_symbol, "mUSD", "info 代币 symbol"); eq(i2.total, "12.5", "info 代币总额"); eq(i2.mode, "平均分", "info 平均分");
  console.log(bad ? `\n${bad} 项不一致` : "\n全部一致");
  process.exitCode = bad ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
