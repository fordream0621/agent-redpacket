// 对拍 scripts/indexer.py：本地链上造红包 / 抢 / 退款 / Agent ID 名字，跑索引，结果和合约状态一致。
// 先开本地链：npx hardhat node --port 8547；再：npx hardhat run scripts/check_indexer.js --network local
const { ethers, network } = require("hardhat");
const { execFileSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
let bad = 0; const eq = (a, b, m) => { if (String(a) !== String(b)) { bad++; console.log("✗", m, "\n   idx:", a, "\n   链上:", b); } else console.log("✓", m); };

async function main() {
  const [creator, a, b, c] = await ethers.getSigners();
  const aid = await (await ethers.getContractFactory("MockAgentID")).deploy();
  const rp = await (await ethers.getContractFactory("AgentRedPacket")).deploy(await aid.getAddress());
  const deployBlock = (await rp.deploymentTransaction().wait()).blockNumber;
  await (await aid.mintNamed(a.address, "alice")).wait();
  await (await aid.mintNamed(b.address, "小明🧧")).wait();
  await (await aid.mint(c.address)).wait(); // 没名字事件
  const v = ethers.parseEther("0.03");
  await (await rp.create(ethers.ZeroAddress, v, 3, true, 3600, ethers.ZeroHash, "新年快乐，一人一份", { value: v })).wait();
  await (await rp.create(ethers.ZeroAddress, 10n, 2, false, 600, ethers.id("口令"), "", { value: 10n })).wait();
  for (const s of [a, b, c]) await (await rp.connect(s).claim(1, "")).wait();
  await (await rp.connect(a).claim(2, "口令")).wait();
  await network.provider.send("evm_increaseTime", [700]); await network.provider.send("evm_mine");
  await (await rp.refund(2)).wait();
  for (let i = 0; i < 4; i++) await network.provider.send("evm_mine"); // 超过 CONFIRM

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idx-"));
  const cfg = { chainId: 31337, contract: await rp.getAddress(), agentId: await aid.getAddress(), agentIdStart: 0, deployBlock, logsRpc: "http://127.0.0.1:8547" };
  fs.writeFileSync(path.join(dir, "config.js"), "window.RP_CONFIG = " + JSON.stringify(cfg, null, 2) + ";\n");
  const run = () => execFileSync("python3", ["-I", path.join(__dirname, "indexer.py"), "--config", path.join(dir, "config.js"), "--out", path.join(dir, "index.json"), "--state", path.join(dir, "st.json")]).toString();
  console.log(run().trim());
  let j = JSON.parse(fs.readFileSync(path.join(dir, "index.json")));
  eq(Object.keys(j.created).length, 2, "红包个数"); eq(j.created["1"].memo, "新年快乐，一人一份", "中文祝福语");
  eq(j.created["1"].total, v, "总额"); eq(j.created["2"].hasPassword, true, "口令标记"); eq(j.created["2"].random, false, "平均分");
  eq(j.claims.length, 4, "被抢次数");
  for (const cl of j.claims) eq(cl.amount, await rp.claimedAmount(cl.id, cl.claimer), `#${cl.id} ${cl.claimer.slice(0, 8)} 金额`);
  eq(j.refunded["2"].amount, 5n, "退款金额");
  eq(j.names[a.address.toLowerCase()], "alice", "名字 alice"); eq(j.names[b.address.toLowerCase()], "小明🧧", "名字（中文 + emoji）");
  eq(j.names[c.address.toLowerCase()], undefined, "没名字事件的地址不乱填"); eq(j.agentIdTotal, 2, "全网 Agent ID 计数");
  // 增量：再抢一次，重跑，不重复
  const d = (await ethers.getSigners())[4]; await (await aid.mintNamed(d.address, "dave")).wait();
  const id3 = 3; await (await rp.create(ethers.ZeroAddress, 6n, 2, false, 3600, ethers.ZeroHash, "", { value: 6n })).wait();
  await (await rp.connect(d).claim(id3, "")).wait();
  for (let i = 0; i < 4; i++) await network.provider.send("evm_mine");
  run(); run();
  j = JSON.parse(fs.readFileSync(path.join(dir, "index.json")));
  eq(j.claims.length, 5, "增量后被抢次数（重跑两次不重复）"); eq(j.names[d.address.toLowerCase()], "dave", "增量名字"); eq(j.agentIdTotal, 3, "增量全网计数");
  fs.rmSync(dir, { recursive: true });
  console.log(bad ? `\n${bad} 项不一致` : "\n全部一致"); process.exitCode = bad ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
