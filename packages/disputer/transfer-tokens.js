//yarn workspace @uma/financial-templates-lib build && node packages/disputer/transfer-tokens.js --network goerli_mnemonic --tokenAddress 0x...  --recipientAddress 0x... --amount 
// Note:
// 1) the script will use the address of KMS Signer
// 2) if you provide max for amount then the script will take all tokens. If you provide a specific number, it is assumed
// to be a string. No internal scaling is done on the number. 1 eth should be therefore represented as 1000000000000000000

const { sendTxWithKMS, } = require("@uma/common");
const { getWeb3 } = require("@uma/common");
const { GasEstimator, Logger } = require("@uma/financial-templates-lib");
const { getAbi } = require("@uma/contracts-node");
const winston = require("winston");
const assert = require("assert");

const logger = winston.createLogger({
  level: "debug",
  transports: [new winston.transports.Console()],
});

const gasEstimator = new GasEstimator(logger);
const web3 = getWeb3();

const argv = require("minimist")(process.argv.slice(), {
  string: ["tokenAddress", "recipientAddress", "amount"],
});

async function transferTokens() {
  try {
    await gasEstimator.update();
    const tokenContract = new web3.eth.Contract(getAbi("ExpandedERC20"), argv.tokenAddress);
    const account = process.env.KMS_SIGNER_ADDRESS;

    assert(
      argv.tokenAddress && argv.amount && argv.recipientAddress,
      "Provide `tokenAddress`, `recipientAddress`, and `amount`. Amount can be `max` to pull all tokens."
    );
    assert(web3.utils.isAddress(argv.tokenAddress), "`tokenAddress` needs to be a valid address");
    assert(web3.utils.isAddress(argv.recipientAddress), "`recipientAddress` needs to be a valid address");
    console.log("Running Token transfer script 💰");

    // Figure out how many tokens to withdraw. If max, then query the full balance of the unlocked account. Else, use specified.
    const amountToWithdraw = (argv.amount == "max" ? await tokenContract.methods.balanceOf(account).call() : argv.amount).toString();
    const transfer = tokenContract.methods.transfer(argv.recipientAddress, amountToWithdraw);

    const { receipt, transactionConfig, returnValue } = await sendTxWithKMS(web3, transfer, {
      ...gasEstimator.getCurrentFastPrice(),
      from: account,
      to: tokenContract.options.address,
    });
    // Transfer(address from, address to, uint256 value)
    const TransferEvent = (
      await tokenContract.getPastEvents("Transfer", {
        fromBlock: receipt.blockNumber,
        filter: { from: account, to: argv.recipientAddress },
      })
    )[0];

    Logger.info({
      at: "transfer-tokens",
      message: "Tokens transferred by KMS 🤑",
      from: TransferEvent.from,
      recipient: TransferEvent.to,
      amount: TransferEvent.value,
      transactionConfig,
    });
    return returnValue;
  } catch (error) {
    console.log("KMS transfer error: ", error);
    Logger.error({
      at: "transfer-tokens",
      message: "Token transfer failed!",
      error: error
    })
    return error;
  }
}

(async () => {
  await transferTokens();
  process.exit();
})();

