// 部署 AgentRedPacket。
//   主网（56）：Agent ID 地址写死为官方合约，忽略任何环境变量，并先检查它是不是真的「SPACE ID Agent ID」。
//   测试网（97）/ 本地：先部署 MockAgentID（谁都能 mint，只用于测试）。
// 用法：npx hardhat run scripts/deploy.js --network bsc|bscTestnet|hardhat
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const MAINNET_AGENT_ID = "0x60b9262456de011f7d15a54cdd8c48baaa8b022f";

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("没有部署账户：在 .env 里填 DEPLOYER_PRIVATE_KEY（新钱包，别用机器人钱包）");
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`链 ${chainId}  部署地址 ${deployer.address}  余额 ${ethers.formatEther(bal)} BNB`);

  let agentId;
  let mock = false;
  if (chainId === 56) {
    agentId = ethers.getAddress(MAINNET_AGENT_ID);
    const nft = new ethers.Contract(agentId, ["function name() view returns (string)", "function symbol() view returns (string)"], ethers.provider);
    const [name, symbol] = await Promise.all([nft.name(), nft.symbol()]);
    if (name !== "SPACE ID Agent ID" || symbol !== "AI") throw new Error(`Agent ID 合约不对：${name} / ${symbol}`);
    console.log(`Agent ID 合约 ${agentId}（${name} / ${symbol}）✓`);
    if (process.env.CONFIRM_MAINNET !== "yes") {
      throw new Error("主网部署要再确认一次：CONFIRM_MAINNET=yes npx hardhat run scripts/deploy.js --network bsc");
    }
  } else {
    const m = await (await ethers.getContractFactory("MockAgentID")).deploy();
    await m.waitForDeployment();
    agentId = await m.getAddress();
    mock = true;
    console.log(`测试用 MockAgentID ${agentId}（谁都能 mint，只用于测试）`);
  }

  const F = await ethers.getContractFactory("AgentRedPacket");
  const c = await F.deploy(agentId);
  const tx = c.deploymentTransaction();
  console.log(`部署交易 ${tx.hash}，等待上链…`);
  const rc = await tx.wait(chainId === 56 ? 3 : 1);
  const addr = await c.getAddress();
  if ((await c.agentId()).toLowerCase() !== agentId.toLowerCase()) throw new Error("部署后读回的 agentId 不一致");

  const out = {
    network: network.name,
    chainId,
    redPacket: addr,
    agentId,
    mockAgentId: mock,
    deployBlock: rc.blockNumber,
    deployTx: tx.hash,
    deployer: deployer.address,
    time: new Date().toISOString(),
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${chainId}.json`), JSON.stringify(out, null, 2) + "\n");
  console.log(`红包合约 ${addr}  区块 ${rc.blockNumber}  → deployments/${chainId}.json`);
  if (chainId === 56 || chainId === 97) {
    console.log(`验证源码：npx hardhat verify --network ${network.name} ${addr} ${agentId}`);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
