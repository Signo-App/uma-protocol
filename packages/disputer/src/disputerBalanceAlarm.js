/* eslint-disable prettier/prettier */
// disputer/src/DisputerBalanceAlarm.js
class DisputerBalanceAlarm {
  constructor({ logger, financialContractClient, financialContract, bufferPercentage }) {
    this.logger = logger;
    this.financialContractClient = financialContractClient;
    this.financialContract = financialContract;
    this.bufferPercentage = bufferPercentage;
    this.disputerBondPercentage = this.financialContract.methods.disputeBondPercentage().call();
    this.numOfOpenPositions = 0;
    this.totalCollateralAmount = 0;
  }

  async updateNumOfOpenPositions() {
    this.numOfOpenPositions = await this.financialContractClient.getAllPositions().length;
  }

  async checkDisputerBotBalanceAgainstStrategy(currentCollateralBalance) {
    await this.updateNumOfOpenPositions();
    try {
      // Disputer Bot wallet USDC collateral balance should be >= UsdcTargetWalletBalance
      const targetUsdcWalletBalance = await this.calculateUsdcTargetBalance();
      console.log("checkDisputerBotBalanceAgainstStrategy called...");
      console.log("Current Collateral Balance: ", currentCollateralBalance);
      console.log("Target USDC Wallet Balance: ", targetUsdcWalletBalance);

      if (currentCollateralBalance < targetUsdcWalletBalance) {
        this.logger.warn({
          at: "Disputer#WalletBalanceAlarm",
          message: `Disputer bot wallet balance is ${currentCollateralBalance.toString()} which is below the target USDC wallet balance threshold of ${targetUsdcWalletBalance.toString()}. Replenish disputer bot wallet balance immediately`,
          numOfOpenPositions: `${this.numOfOpenPositions}`,
          totalCollateralAmount: `${this.totalCollateralAmount}`,
          disputeBondPercentage: `${this.disputerBondPercentage}`,
          currentCollateralBalance: `${currentCollateralBalance}`,
          targetUsdcWalletBalance: `${targetUsdcWalletBalance}`,
        });
      }

      // this.logger.info({
      //   at: "Disputer#WalletBalanceAlarm",
      //   message: `Current disputer bot wallet balance of ${currentCollateralBalance.toString()} meets the target USDC wallet balance threshold of ${targetUsdcWalletBalance.toString()}. Disputer bot wallet USDC balance is within the healthy range.`,
      //   numOfOpenPositions: `${this.numOfOpenPositions}`,
      //   totalCollateralAmount: `${this.totalCollateralAmount}`,
      //   disputeBondPercentage: `${this.disputerBondPercentage / 1e18}`,
      //   currentCollateralBalance: `${currentCollateralBalance}`,
      //   targetWalletBalance: `${targetUsdcWalletBalance}`,
      // });
    } catch (error) {
      this.logger.error({
        at: "Disputer#WalletBalanceAlarm",
        message: "An error occurred during the calculation of the disputer bot wallet balance",
        error: error,
        stack: error.stack,
      });

      throw error;
    }
  }

  async calculateUsdcTargetBalance() {
    this.totalCollateralAmount = await this.financialContract.methods.totalPositionCollateral().call();
    console.log("calculateUsdcTargetBalance called...");
    console.log(`Total Collateral Amount: ${this.totalCollateralAmount}`);

    const ooReward = await this.financialContract.methods.ooReward().call();
    console.log(`OO Reward: ${ooReward}`);

    console.log(`Number of Open Positions: ${this.numOfOpenPositions}`);

    this.disputerBondPercentage = await this.financialContract.methods.disputeBondPercentage().call();
    console.log(`Dispute Bond Percentage: ${this.disputerBondPercentage / 1e18}`);

    const usdcTargetBalance =
      this.totalCollateralAmount * (this.disputerBondPercentage / 1e18) +
      this.numOfOpenPositions * this.bufferPercentage * ooReward;
    console.log(`USDC Target Balance: ${usdcTargetBalance}`);

    return usdcTargetBalance;
  }
}

module.exports = { DisputerBalanceAlarm };
