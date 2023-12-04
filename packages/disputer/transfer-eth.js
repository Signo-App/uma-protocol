//yarn workspace @uma/financial-templates-lib build && node packages/disputer/transfer-eth.js --network goerli_mnemonic --recipientAddress 0x... --amount 
// Note:
// 1) the script will use the address of KMS Signer
// 2) if you provide max for amount then the script will take all tokens. If you provide a specific number, it is assumed
// to be a string. No internal scaling is done on the number. 1 eth should be therefore represented as 1000000000000000000

const { sendEthWithKMS } = require("@uma/common");
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
  string: ["recipientAddress", "amount"],
});

async function transferEth() {
  try {
    await gasEstimator.update();
    const account = process.env.KMS_SIGNER_ADDRESS;

    assert(
       argv.amount && argv.recipientAddress,
      "Provide `recipientAddress`, and `amount`. Amount can be `max` to pull all tokens."
    );
    assert(web3.utils.isAddress(argv.recipientAddress), "`recipientAddress` needs to be a valid address");
    console.log("Running ETH transfer script 💰");

    // Figure out how many tokens to withdraw. If max, then query the full balance of the unlocked account. Else, use specified.
    const amountToWithdraw = (argv.amount == "max" ? await web3.eth.getBalance(account) : argv.amount).toString();
    const recipient = argv.recipientAddress;
    const { receipt, transactionConfig } = await sendEthWithKMS(web3,amountToWithdraw, {
      ...gasEstimator.getCurrentFastPrice(),
      from: account,
      to: recipient,
    });
    


    Logger.info({
      at: "transfer-eth",
      message: "ETH transferred by KMS 🤑",
      from: account,
      recipient: recipient,
      amount: amountToWithdraw,
      transactionConfig,
    });
    return receipt;
  } catch (error) {
    console.log("KMS transfer error: ", error);
    Logger.error({
      at: "transfer-eth",
      message: "ETH transfer failed!",
      error: error
    })
    return error;
  }
}

(async () => {
  await transferEth();
  process.exit();
})();

