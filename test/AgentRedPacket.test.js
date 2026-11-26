const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const HOUR = 3600;
const ZERO = ethers.ZeroHash;
const pw = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

describe("AgentRedPacket", function () {
  let rp, aid, usdt, creator, a, b, c, d, noId;

  beforeEach(async function () {
    [creator, a, b, c, d, noId] = await ethers.getSigners();
    aid = await (await ethers.getContractFactory("MockAgentID")).deploy();
    rp = await (await ethers.getContractFactory("AgentRedPacket")).deploy(await aid.getAddress());
    usdt = await (await ethers.getContractFactory("MockERC20")).deploy();
    for (const s of [a, b, c, d]) await aid.mint(s.address);
    await usdt.mint(creator.address, ethers.parseEther("1000"));
    await usdt.approve(await rp.getAddress(), ethers.MaxUint256);
  });

  async function mk(opts = {}) {
    const o = { token: await usdt.getAddress(), amount: ethers.parseEther("10"), shares: 3, random: true, dur: HOUR, pass: ZERO, memo: "hi", value: 0n, ...opts };
    const tx = await rp.create(o.token, o.amount, o.shares, o.random, o.dur, o.pass, o.memo, { value: o.value });
    await tx.wait();
    return await rp.packetCount();
  }

  it("构造参数不能是零地址", async function () {
    const F = await ethers.getContractFactory("AgentRedPacket");
    await expect(F.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(rp, "BadParams");
  });

  it("ERC20 拼手气：全部抢完金额守恒、每份 ≥1、每人一次", async function () {
    const id = await mk();
    const amt = [];
    for (const s of [a, b, c]) {
      await expect(rp.connect(s).claim(id, "")).to.emit(rp, "Claimed");
      amt.push(await rp.claimedAmount(id, s.address));
    }
    expect(amt.reduce((x, y) => x + y, 0n)).to.equal(ethers.parseEther("10"));
    amt.forEach((x) => expect(x).to.be.gt(0n));
    expect(await usdt.balanceOf(await rp.getAddress())).to.equal(0n);
    await expect(rp.connect(d).claim(id, "")).to.be.revertedWithCustomError(rp, "AllClaimed");
  });

  it("同一地址不能抢两次", async function () {
    const id = await mk();
    await rp.connect(a).claim(id, "");
    await expect(rp.connect(a).claim(id, "")).to.be.revertedWithCustomError(rp, "AlreadyClaimed");
  });

  it("没有 Agent ID 不能抢", async function () {
    const id = await mk();
    await expect(rp.connect(noId).claim(id, "")).to.be.revertedWithCustomError(rp, "NoAgentID");
    expect((await rp.canClaim(id, noId.address))[1]).to.equal(6);
  });

  it("平均分：最后一份拿余数", async function () {
    const id = await mk({ amount: 10n, shares: 3, random: false });
    for (const s of [a, b, c]) await rp.connect(s).claim(id, "");
    expect(await rp.claimedAmount(id, a.address)).to.equal(3n);
    expect(await rp.claimedAmount(id, b.address)).to.equal(3n);
    expect(await rp.claimedAmount(id, c.address)).to.equal(4n);
  });

  it("极小金额（金额 = 份数）每份正好 1", async function () {
    const id = await mk({ amount: 3n, shares: 3, random: true });
    for (const s of [a, b, c]) await rp.connect(s).claim(id, "");
    for (const s of [a, b, c]) expect(await rp.claimedAmount(id, s.address)).to.equal(1n);
  });

  it("拼手气大量份数：金额守恒", async function () {
    const signers = await ethers.getSigners();
    const n = 15;
    for (const s of signers.slice(0, n)) await aid.mint(s.address);
    const id = await mk({ amount: 1000n, shares: n });
    let sum = 0n;
    for (const s of signers.slice(0, n)) {
      await rp.connect(s).claim(id, "");
      const x = await rp.claimedAmount(id, s.address);
      expect(x).to.be.gt(0n);
      sum += x;
    }
    expect(sum).to.equal(1000n);
  });

  it("口令红包：错口令拒绝，对口令可以", async function () {
    const id = await mk({ pass: pw("恭喜发财") });
    await expect(rp.connect(a).claim(id, "错的")).to.be.revertedWithCustomError(rp, "WrongPassword");
    await rp.connect(a).claim(id, "恭喜发财");
    expect(await rp.claimedAmount(id, a.address)).to.be.gt(0n);
  });

  it("原生 BNB 红包", async function () {
    const v = ethers.parseEther("0.03");
    const id = await mk({ token: ethers.ZeroAddress, amount: v, value: v, shares: 2 });
    const before = await ethers.provider.getBalance(a.address);
    const tx = await rp.connect(a).claim(id, "");
    const r = await tx.wait();
    const got = await rp.claimedAmount(id, a.address);
    expect(await ethers.provider.getBalance(a.address)).to.equal(before + got - r.gasUsed * r.gasPrice);
  });

  it("BNB 红包 msg.value 不对拒绝；ERC20 红包带 BNB 拒绝", async function () {
    await expect(mk({ token: ethers.ZeroAddress, amount: 100n, value: 99n })).to.be.revertedWithCustomError(rp, "BadParams");
    await expect(mk({ value: 1n })).to.be.revertedWithCustomError(rp, "BadParams");
  });

  it("参数检查：份数 / 金额 / 有效期 / 祝福语长度 / 非合约代币", async function () {
    await expect(mk({ shares: 0 })).to.be.revertedWithCustomError(rp, "BadParams");
    await expect(mk({ shares: 501, amount: 1000n })).to.be.revertedWithCustomError(rp, "BadParams");
    await expect(mk({ amount: 2n, shares: 3 })).to.be.revertedWithCustomError(rp, "BadParams");
    await expect(mk({ dur: 599 })).to.be.revertedWithCustomError(rp, "BadParams");
    await expect(mk({ dur: 30 * 24 * HOUR + 1 })).to.be.revertedWithCustomError(rp, "BadParams");
    await expect(mk({ memo: "x".repeat(141) })).to.be.revertedWithCustomError(rp, "BadParams");
    await expect(mk({ token: a.address })).to.be.revertedWithCustomError(rp, "BadParams");
  });

  it("转账扣费代币拒绝", async function () {
    await usdt.setFee(100);
    await expect(mk()).to.be.revertedWithCustomError(rp, "BadParams");
  });

  it("过期前不能退、不能被别人抢走；过期后任何人可触发，钱退给发红包的人", async function () {
    const id = await mk({ amount: 9n, shares: 3, random: false });
    await rp.connect(a).claim(id, "");
    await expect(rp.connect(b).refund(id)).to.be.revertedWithCustomError(rp, "NotExpired");
    await expect(rp.connect(creator).refund(id)).to.be.revertedWithCustomError(rp, "NotExpired");
    await time.increase(HOUR);
    await expect(rp.connect(b).claim(id, "")).to.be.revertedWithCustomError(rp, "Expired");
    const before = await usdt.balanceOf(creator.address);
    await expect(rp.connect(d).refund(id)).to.emit(rp, "Refunded").withArgs(id, creator.address, 6n);
    expect(await usdt.balanceOf(creator.address)).to.equal(before + 6n);
    expect(await usdt.balanceOf(d.address)).to.equal(0n);
    await expect(rp.refund(id)).to.be.revertedWithCustomError(rp, "AlreadyRefunded");
  });

  it("抢完后退款金额为 0 也能标记", async function () {
    const id = await mk({ amount: 2n, shares: 1 });
    await rp.connect(a).claim(id, "");
    await time.increase(HOUR);
    await expect(rp.refund(id)).to.emit(rp, "Refunded").withArgs(id, creator.address, 0n);
  });

  it("不存在的红包", async function () {
    await expect(rp.connect(a).claim(99, "")).to.be.revertedWithCustomError(rp, "NotFound");
    await expect(rp.refund(99)).to.be.revertedWithCustomError(rp, "NotFound");
    expect((await rp.canClaim(99, a.address))[1]).to.equal(1);
  });

  it("canClaim 各种原因", async function () {
    const id = await mk({ amount: 2n, shares: 1 });
    expect(await rp.canClaim(id, a.address)).to.deep.equal([true, 0n]);
    await rp.connect(a).claim(id, "");
    expect((await rp.canClaim(id, a.address))[1]).to.equal(4); // 抢完优先
    const id2 = await mk();
    await rp.connect(a).claim(id2, "");
    expect((await rp.canClaim(id2, a.address))[1]).to.equal(5);
    await time.increase(HOUR);
    expect((await rp.canClaim(id2, b.address))[1]).to.equal(3);
    await rp.refund(id2);
    expect((await rp.canClaim(id2, b.address))[1]).to.equal(2);
  });

  it("重入被挡住", async function () {
    const v = ethers.parseEther("0.02");
    const id = await mk({ token: ethers.ZeroAddress, amount: v, value: v, shares: 2 });
    const R = await (await ethers.getContractFactory("Reenter")).deploy(await rp.getAddress());
    await aid.mint(await R.getAddress());
    await R.go(id);
    expect(await R.reenterBlocked()).to.equal(true);
    const got = await rp.claimedAmount(id, await R.getAddress());
    expect(await ethers.provider.getBalance(await R.getAddress())).to.equal(got);
    expect((await rp.getPacket(id)).claimed).to.equal(1n);
  });

  it("拒收 BNB 的合约抢不了，不影响别人", async function () {
    const v = ethers.parseEther("0.02");
    const id = await mk({ token: ethers.ZeroAddress, amount: v, value: v, shares: 2 });
    const X = await (await ethers.getContractFactory("Rejecter")).deploy();
    await aid.mint(await X.getAddress());
    await expect(X.go(await rp.getAddress(), id)).to.be.revertedWithCustomError(rp, "TransferFailed");
    await rp.connect(a).claim(id, "");
    await rp.connect(b).claim(id, "");
    expect(await ethers.provider.getBalance(await rp.getAddress())).to.equal(0n);
  });

  it("多个红包互不影响", async function () {
    const id1 = await mk({ amount: 6n, shares: 2, random: false });
    const id2 = await mk({ amount: 10n, shares: 2, random: false });
    await rp.connect(a).claim(id1, "");
    await rp.connect(a).claim(id2, "");
    expect(await rp.claimedAmount(id1, a.address)).to.equal(3n);
    expect(await rp.claimedAmount(id2, a.address)).to.equal(5n);
    expect(await usdt.balanceOf(await rp.getAddress())).to.equal(8n);
  });
});
