const hre = require("hardhat");
const { getContract } = hre;
const Token = getContract("ExpandedERC20");

async function approve(tokenAddress, approver, spender, amount) {
  const token = await Token.at(tokenAddress);

  const tokenDecimals = await token.methods.decimals().call();

  const amountInWei = hre.ethers.utils.parseUnits(amount, tokenDecimals);
  const allowance = await token.methods.allowance(approver, spender).call();

  if (amountInWei.gt(allowance)) {
    await token.methods.approve(spender, amountInWei).send({ from: approver });
  }
}

module.exports = approve;
