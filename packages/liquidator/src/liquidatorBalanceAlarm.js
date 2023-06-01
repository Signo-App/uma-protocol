class LiquidatorBalanceAlarm {
  constructor({ logger, financialContractClient, financialContract, minSponsorTokens }) {
    this.logger = logger;
    this.financialContractClient = financialContractClient;
    this.financialContract = financialContract;
    this.minSponsorTokens = minSponsorTokens;
    this.numOfOpenPositions = 0;
  }

  async updateNumOfOpenPositions() {
    this.numOfOpenPositions = await this.financialContractClient.getAllPositions().length;
  }

  async checkLiquidatorBotBalanceAgainstStrategy(currentSyntheticBalance, currentCollateralBalance) {
    await this.updateNumOfOpenPositions();
    try {
      // Bot wallet balance should be >= targetWalletBalance
      const targetWalletSynthBalance = await this.calculateTargetLiquidatorSynthBalance();
      const targetWalletCollateralBalance = await this.calculateTargetLiquidatorCollateralBalance();

      console.log("checkBotBalanceAgainstStrategy called...");
      console.log("Current Synthetic Balance: ", currentSyntheticBalance);
      console.log("Target Synth Wallet Balance: ", targetWalletSynthBalance);
      console.log("Current Collateral Balance: ", currentCollateralBalance);
      console.log("Target Collateral Wallet Balance: ", targetWalletCollateralBalance);

      if (currentSyntheticBalance < targetWalletSynthBalance) {
        this.logger.warn({
          at: "Liquidator#WalletBalanceAlarm",
          message: `Bot wallet balance is ${currentSyntheticBalance.toString()} synth which is below the target wallet balance threshold of ${targetWalletSynthBalance.toString()} synth. Replenish bot wallet synth balance immediately`,
          numOfOpenPositions: `${this.numOfOpenPositions}`,
          minSponsorTokens: `${this.minSponsorTokens}`,
          currentSyntheticBalance: `${currentSyntheticBalance}`,
          targetWalletSynthBalance: `${targetWalletSynthBalance}`,
        });
        return true;
      } else if (currentCollateralBalance < targetWalletCollateralBalance) {
        this.logger.warn({
          at: "Liquidator#WalletBalanceAlarm",
          message: `Bot wallet balance is ${currentCollateralBalance.toString()} USDC which is below the target wallet balance threshold of ${targetWalletCollateralBalance.toString()} USDC. Replenish bot wallet USDC balance immediately`,
          numOfOpenPositions: `${this.numOfOpenPositions}`,
          ooReward: `${this.ooReward}`,
          currentCollateralBalance: `${currentCollateralBalance}`,
          targetWalletCollateralBalance: `${targetWalletCollateralBalance}`,
        });
        return true;
      } else {
        this.logger.info({
          at: "Liquidator#WalletBalanceAlarm",
          message: `Current bot wallet balance of ${currentSyntheticBalance.toString()} synth & ${currentCollateralBalance.toString()} USDC meets the target wallet balance threshold of ${targetWalletSynthBalance.toString()} synth and ${targetWalletCollateralBalance.toString()} USDC. Bot wallet balance is within the healthy range.`,
          numOfOpenPositions: `${this.numOfOpenPositions}`,
          minSponsorTokens: `${this.minSponsorTokens}`,
          ooReward: `${this.ooReward}`,
          currentSyntheticBalance: `${currentSyntheticBalance}`,
          targetWalletSynthBalance: `${targetWalletSynthBalance}`,
          currentCollateralBalance: `${currentCollateralBalance}`,
          targetWalletCollateralBalance: `${targetWalletCollateralBalance}`,
        });
        return false;
      }
    } catch (error) {
      this.logger.error({
        at: "Liquidator#WalletBalanceAlarm",
        message: "An error occurred during the calculation of the bot wallet balance",
        error: error,
      });

      throw error;
    }
  }

  async calculateTargetLiquidatorSynthBalance() {
    return this.minSponsorTokens * this.numOfOpenPositions;
  }

  async calculateTargetLiquidatorCollateralBalance() {
    const ooReward = await this.financialContract.methods.ooReward().call();
    return this.numOfOpenPositions * ooReward;
  }
}

module.exports = { LiquidatorBalanceAlarm };
