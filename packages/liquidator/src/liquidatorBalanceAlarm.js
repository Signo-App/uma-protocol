class LiquidatorBalanceAlarm {
  constructor({
    logger,
    financialContractClient,
    financialContract,
    minSponsorTokens,
    pollingDelay,
    bufferPercentage,
  }) {
    this.logger = logger;
    this.financialContractClient = financialContractClient;
    this.financialContract = financialContract;
    this.minSponsorTokens = minSponsorTokens;
    this.pollingDelay = pollingDelay;
    this.bufferPercentage = bufferPercentage;
    this.numOfOpenPositions = 0;
    this.lastInfoUpdate = 0;
  }

  async updateNumOfOpenPositions() {
    this.numOfOpenPositions = await this.financialContractClient.getAllPositions().length;
  }

  async checkLiquidatorBotBalanceAgainstStrategy(currentSyntheticBalance, currentCollateralBalance) {
    let warningTriggered = false;

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
        warningTriggered = true;
        this.logger.warn({
          at: "Liquidator#WalletBalanceAlarm",
          message: `Bot wallet balance is ${currentSyntheticBalance.toString()} synth which is below the 
          target wallet balance threshold of ${targetWalletSynthBalance.toString()} synth. 
          Replenish bot wallet synth balance immediately🤚`,
          numOfOpenPositions: `${this.numOfOpenPositions}`,
          bufferPercentage: `${this.bufferPercentage}`,
          minSponsorTokens: `${this.minSponsorTokens}`,
          currentSyntheticBalance: `${currentSyntheticBalance}`,
          targetWalletSynthBalance: `${targetWalletSynthBalance}`,
        });
      }

      if (currentCollateralBalance < targetWalletCollateralBalance) {
        warningTriggered = true;
        this.logger.warn({
          at: "Liquidator#WalletBalanceAlarm",
          message: `Bot wallet balance is ${currentCollateralBalance.toString()} USDC which is below the 
          target wallet balance threshold of ${targetWalletCollateralBalance.toString()} USDC.
          Replenish bot wallet USDC balance immediately🤚`,
          numOfOpenPositions: `${this.numOfOpenPositions}`,
          ooReward: `${this.ooReward}`,
          bufferPercentage: `${this.bufferPercentage}`,
          currentCollateralBalance: `${currentCollateralBalance}`,
          targetWalletCollateralBalance: `${targetWalletCollateralBalance}`,
        });
      }

      // sends a info log every 24 hours
      if (!warningTriggered && this.lastInfoUpdate >= 86400) {
        this.lastInfoUpdate = 0;
        this.logger.info({
          at: "Liquidator#WalletBalanceAlarm",
          message: `Current bot wallet balance of ${currentSyntheticBalance.toString()} synth
          & ${currentCollateralBalance.toString()} USDC meets the target wallet balance threshold
          of ${targetWalletSynthBalance.toString()} synth and ${targetWalletCollateralBalance.toString()} USDC. 
          Bot wallet balance is within the healthy range.👍`,
          numOfOpenPositions: `${this.numOfOpenPositions}`,
          minSponsorTokens: `${this.minSponsorTokens}`,
          ooReward: `${this.ooReward}`,
          bufferPercentage: `${this.bufferPercentage}`,
          currentSyntheticBalance: `${currentSyntheticBalance}`,
          targetWalletSynthBalance: `${targetWalletSynthBalance}`,
          currentCollateralBalance: `${currentCollateralBalance}`,
          targetWalletCollateralBalance: `${targetWalletCollateralBalance}`,
        });
      }

      this.lastInfoUpdate += this.pollingDelay;
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
    return this.minSponsorTokens * Math.ceil(this.numOfOpenPositions * this.bufferPercentage);
  }

  async calculateTargetLiquidatorCollateralBalance() {
    this.ooReward = await this.financialContract.methods.ooReward().call();
    return this.ooReward * Math.ceil(this.numOfOpenPositions * this.bufferPercentage);
  }
}

module.exports = { LiquidatorBalanceAlarm };
