const { default: BigNumber } = require("bignumber.js");
const { assert } = require("chai");
const hre = require("hardhat");
const { getContract } = hre;
const Token = getContract("ExpandedERC20");

async function erc20Approve(tokenAddress, approver, spender, amount) {
  const token = await Token.at(tokenAddress);
  await token.methods.approve(spender, amount).send({ from: approver });
  assert(new BigNumber(await token.methods.allowance(approver, spender).call()).gte(new BigNumber(amount)));
}

async function getUsdc(tokenAddress, spender) {
  const usdcTreasury = "0x75C0c372da875a4Fc78E8A37f58618a6D18904e8";
  await hre.ethers.provider.send("hardhat_impersonateAccount", [usdcTreasury]);
  const usdcTreasurysigner = await hre.ethers.getSigner(usdcTreasury);
  const usdc = await hre.ethers.getContractAt(Token.options.jsonInterface, tokenAddress, usdcTreasurysigner);
  const transferTx = await usdc.transfer(spender, "1000000000");
  await transferTx.wait();
}

module.exports = { erc20Approve, getUsdc };
