class WalletBalanceAlarm {
  constructor({ logger, financialContractClient, financialContract, minSponsorTokens, bufferPercentage }) {
    this.logger = logger;
    this.financialContractClient = financialContractClient;
    this.financialContract = financialContract;
    this.minSponsorTokens = minSponsorTokens;
    this.bufferPercentage = bufferPercentage;
    this.disputerBondPercentage = this.financialContract.methods.disputeBondPercentage().call();
    this.numOfOpenPositions = 0;
    console.log(
      "constructor params",
      logger,
      financialContractClient,
      financialContract,
      minSponsorTokens,
      bufferPercentage
    );
  }

  async checkLiquidatorBotBalanceAgainstStrategy(currentSyntheticBalance, currentCollateralBalance) {
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
    this.numOfOpenPositions = await this.financialContractClient.getAllPositions().length;
    return this.minSponsorTokens * this.numOfOpenPositions;
  }

  async calculateTargetLiquidatorCollateralBalance() {
    const ooReward = await this.financialContract.methods.ooReward().call();
    this.numOfOpenPositions = await this.financialContractClient.getAllPositions().length;
    return this.numOfOpenPositions * ooReward;
  }

  async checkDisputerBotBalanceAgainstStrategy(currentCollateralBalance) {
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
        return true;
      } else {
        this.logger.info({
          at: "Disputer#WalletBalanceAlarm",
          message: `Current disputer bot wallet balance of ${currentCollateralBalance.toString()} meets the target USDC wallet balance threshold of ${targetUsdcWalletBalance.toString()}. Disputer bot wallet USDC balance is within the healthy range.`,
          numOfOpenPositions: `${this.numOfOpenPositions}`,
          totalCollateralAmount: `${this.totalCollateralAmount}`,
          disputeBondPercentage: `${this.disputerBondPercentage / 1e18}`,
          currentCollateralBalance: `${currentCollateralBalance}`,
          targetWalletBalance: `${targetUsdcWalletBalance}`,
        });
        return false;
      }
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
    const allPositions = await this.financialContractClient.getAllPositions();
    this.totalCollateralAmount = await allPositions.reduce((total, position) => {
      return total + parseFloat(position.collateral.toString());
    }, 0);
    console.log("calculateUsdcTargetBalance called...");
    console.log(`Total Collateral Amount: ${this.totalCollateralAmount}`);

    const ooReward = await this.financialContract.methods.ooReward().call();
    console.log(`OO Reward: ${ooReward}`);

    this.numOfOpenPositions = await this.financialContractClient.getAllPositions().length;
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

module.exports = { WalletBalanceAlarm };
