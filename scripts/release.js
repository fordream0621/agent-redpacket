// 部署后把合约地址 / 部署区块写进 网页配置、Skill 工具、SKILL.md。
//   node scripts/release.js 56     （默认 56；测试网 97）
const fs = require("fs");
const path = require("path");

const chainId = Number(process.argv[2] || 56);
const root = path.join(__dirname, "..");
const dep = JSON.parse(fs.readFileSync(path.join(root, "deployments", `${chainId}.json`), "utf8"));
const addr = dep.redPacket;
if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error("deployments 里的地址不对");

const NET = {
  56: { rpc: ["https://bsc-dataseed.bnbchain.org", "https://bsc-rpc.publicnode.com"], logsRpc: "https://bsc-rpc.publicnode.com", explorer: "https://bscscan.com", name: "BNB Smart Chain" },
  97: { rpc: ["https://data-seed-prebsc-1-s1.bnbchain.org:8545"], logsRpc: "https://bsc-testnet-rpc.publicnode.com", explorer: "https://testnet.bscscan.com", name: "BSC Testnet" },
}[chainId];
if (!NET) throw new Error("只支持 56 / 97");

const cfg = {
  chainId,
  chainName: NET.name,
  contract: addr,
  agentId: dep.agentId,
  mockAgentId: !!dep.mockAgentId,
  deployBlock: dep.deployBlock,
  rpc: NET.rpc,
  logsRpc: NET.logsRpc,
  explorer: NET.explorer,
};
fs.writeFileSync(path.join(root, "web", "config.js"), `// 由 scripts/release.js 生成，别手改\nwindow.RP_CONFIG = ${JSON.stringify(cfg, null, 2)};\n`);
console.log("web/config.js ✓");

if (chainId === 56) {
  const py = path.join(root, "skills", "agent-redpacket", "redpacket.py");
  let s = fs.readFileSync(py, "utf8");
  s = s.replace(/^CONTRACT = "0x[0-9a-fA-F]{40}"/m, `CONTRACT = "${addr}"`);
  fs.writeFileSync(py, s);
  const md = path.join(root, "skills", "agent-redpacket", "SKILL.md");
  let m = fs.readFileSync(md, "utf8");
  m = m.replace(/- 红包合约：`0x[0-9a-fA-F]{40}`[^\n]*/, `- 红包合约：\`${addr}\``);
  fs.writeFileSync(md, m);
  console.log("skills/agent-redpacket（redpacket.py + SKILL.md）✓");
}
