require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// 部署私钥只从本机环境变量读，不要提交 .env
const accounts = process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [];

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" },
  },
  networks: {
    local: { url: "http://127.0.0.1:8547" },
    bscTestnet: { url: process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.bnbchain.org:8545", chainId: 97, accounts },
    bsc: { url: process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.bnbchain.org", chainId: 56, accounts },
  },
  etherscan: { apiKey: process.env.BSCSCAN_API_KEY || "" },
  sourcify: { enabled: false },
};
