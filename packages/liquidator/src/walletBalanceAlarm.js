class WalletBalanceAlarm {
  constructor({
    logger,
    financialContractClient,
    minSponsorTokens,
  }) {
    this.logger = logger;
    this.financialContractClient = financialContractClient;
    this.minSponsorTokens = minSponsorTokens;
    this.numOfOpenPositions = this.financialContractClient.getAllPositions().length;
  }

  async checkBotBalanceAgainstStrategy(currentSyntheticBalance) {
    try {
      // Bot wallet balance should be >= targetWalletBalance
      const targetWalletBalance = this.calculateTargetBalance();

      if (currentSyntheticBalance < targetWalletBalance) {
        this.logger.warn({
          at: "Liquidator#WalletBalanceAlarm",
          message: `Bot wallet balance is ${currentSyntheticBalance.toString()} which is below the target wallet balance threshold of ${targetWalletBalance.toString()}. Replenish bot wallet balance immediately`,
          numOfOpenPositions: `${this.numOfOpenPositions}`,
          minSponsorTokens: `${this.minSponsorTokens}`,
          currentSyntheticBalance: `${currentSyntheticBalance}`,
          targetWalletBalance: `${targetWalletBalance}`,
        });
        return true;
      } else {
        this.logger.info({
          at: "Liquidator#WalletBalanceAlarm",
          message: `Current bot wallet balance of ${currentSyntheticBalance.toString()} meets the target wallet balance threshold of ${targetWalletBalance.toString()}. Bot wallet balance is within the healthy range.`,
          numOfOpenPositions: `${this.numOfOpenPositions}`,
          minSponsorTokens: `${this.minSponsorTokens}`,
          currentSyntheticBalance: `${currentSyntheticBalance}`,
          targetWalletBalance: `${targetWalletBalance}`,
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

  calculateTargetBalance = () => {
    return this.minSponsorTokens * this.numOfOpenPositions;
  }
}

module.exports = { WalletBalanceAlarm };