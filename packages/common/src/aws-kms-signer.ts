import { ethers, UnsignedTransaction } from "ethers";
import type { ContractSendMethod } from "web3-eth-contract";
import type Web3 from "web3";
import BN from "bn.js";
import { _signDigest, AwsKmsSignerCredentials, getEthereumAddress, getPublicKey } from "./aws-kms-utils";
import type { TransactionReceipt } from "web3-core";
import { accountHasPendingTransactions, getPendingTransactionCount } from "./TransactionUtils";
const GAS_LIMIT_BUFFER = 1.25;

const kmsCredentials: AwsKmsSignerCredentials = {
  accessKeyId: process.env.KMS_ACCESS_KEY_ID, // credentials for your IAM user with KMS access
  secretAccessKey: process.env.KMS_ACCESS_SECRET_KEY, // credentials for your IAM user with KMS access
  region: "us-east-2",
  keyId: process.env.KMS_SIGNER!,
};

(async () => {
  if (kmsCredentials && kmsCredentials.keyId) {
    console.log("🤖 is using KMS!");
    const pubKey = await getPublicKey(kmsCredentials);
    const kmsPublicKey = getEthereumAddress(pubKey.PublicKey as Buffer);
    console.log("KMS PUBLIC KEY: ", kmsPublicKey);
  }
})();

// this function is used to send a web3 transaction and sign it with AWS KMS
export async function sendTxWithKMS(_web3: Web3, transaction: ContractSendMethod, transactionConfig: any) {
  const web3 = _web3;
  const encodedFunctionCall = transaction.encodeABI();

  // Compute the selected account nonce. If the account has a pending transaction then use the subsequent index after the
  // pending transactions to ensure this new transaction does not collide with any existing transactions in the mempool.
  if (await accountHasPendingTransactions(web3, transactionConfig.from)) {
    transactionConfig.nonce = await getPendingTransactionCount(web3, transactionConfig.from);
  }
  // Else, there is no pending transaction and we use the current account transaction count as the nonce.
  else {
    transactionConfig.nonce = await web3.eth.getTransactionCount(transactionConfig.from);
  }

  let returnValue, estimatedGas;
  try {
    [returnValue, estimatedGas] = await Promise.all([
      transaction.call({ from: transactionConfig.from }),
      transaction.estimateGas({ from: transactionConfig.from }),
    ]);
  } catch (error) {
    const castedError = error as Error & { type?: string };
    castedError.type = "call";
    throw castedError;
  }
  let txParams: UnsignedTransaction;
  // EIP-1559 TX Type or Legacy depending on maxFeePerGas, maxPriorityFeePerGas and gasPrice

  if (transactionConfig.maxFeePerGas && transactionConfig.maxPriorityFeePerGas) {
    // EIP-1559 TX Type
    txParams = {
      gasLimit: Math.floor(estimatedGas * GAS_LIMIT_BUFFER),
      // double the maxFeePerGas to ensure the transaction is included
      maxFeePerGas: parseInt(transactionConfig.maxFeePerGas.toString()) * 2,
      maxPriorityFeePerGas: transactionConfig.maxPriorityFeePerGas,
      nonce: transactionConfig.nonce,
      to: transactionConfig.to,
      value: transactionConfig.value || "0x00",
      data: encodedFunctionCall,
      type: 2,
      chainId: await web3.eth.getChainId(),
    };
  } else if (transactionConfig.gasPrice) {
    // Legacy TX Type
    txParams = {
      gasLimit: Math.floor(estimatedGas * GAS_LIMIT_BUFFER),
      gasPrice: transactionConfig.gasPrice,
      nonce: transactionConfig.nonce,
      to: transactionConfig.to,
      value: transactionConfig.value || "0x00",
      data: encodedFunctionCall,
      type: 0,
      chainId: await web3.eth.getChainId(),
    };
  } else {
    throw new Error("No gas information provided");
  }

  const serializedUnsignedTx = ethers.utils.serializeTransaction(<UnsignedTransaction>txParams);
  const transactionSignature = await _signDigest(ethers.utils.keccak256(serializedUnsignedTx), kmsCredentials);
  const serializedTx = ethers.utils.serializeTransaction(<UnsignedTransaction>txParams, transactionSignature);

  // Promi event => promise resolved on event receipt
  const receipt = ((await web3.eth.sendSignedTransaction(serializedTx)) as unknown) as TransactionReceipt;
  const transactionHash = receipt.transactionHash;

  return { receipt, transactionHash, returnValue, transactionConfig };
}

// this function is used to withdraw ETH from AWS KMS signer
export async function sendEthWithKMS(_web3: Web3, amount: any, transactionConfig: any) {
  if (!amount || !transactionConfig.maxPriorityFeePerGas || !transactionConfig.maxFeePerGas) {
    throw new Error("One or more required values are undefined or incorrect");
  }

  const web3 = _web3;
  const amountToWithdraw = new BN(amount);

  // Compute the selected account nonce. If the account has a pending transaction then use the subsequent index after the
  // pending transactions to ensure this new transaction does not collide with any existing transactions in the mempool.
  if (await accountHasPendingTransactions(web3, transactionConfig.from)) {
    transactionConfig.nonce = await getPendingTransactionCount(web3, transactionConfig.from);
  }
  // Else, there is no pending transaction and we use the current account transaction count as the nonce.
  else {
    transactionConfig.nonce = await web3.eth.getTransactionCount(transactionConfig.from);
  }
  const sampleTX = {
    from: transactionConfig.from,
    to: transactionConfig.to,
    value: amountToWithdraw.toString(),
  };
  let estimatedGas;

  try {
    estimatedGas = await web3.eth.estimateGas(sampleTX);
  } catch (error) {
    // Handle the error here
    console.error("Error estimating gas:", error);
    throw error;
  }

  let txParams: UnsignedTransaction;
  // EIP-1559 TX Type or Legacy depending on maxFeePerGas, maxPriorityFeePerGas and gasPrice

  if (transactionConfig.maxFeePerGas && transactionConfig.maxPriorityFeePerGas) {
    const gasLimitBN = new BN(estimatedGas).mul(new BN(GAS_LIMIT_BUFFER));
    const maxPriorityFeePerGasBN = new BN(web3.utils.toWei(transactionConfig.maxPriorityFeePerGas.toString(), "gwei"));
    // double the maxFeePerGas to ensure the transaction is included
    const maxFeePerGasBN = new BN(web3.utils.toWei(transactionConfig.maxFeePerGas.toString(), "gwei")).mul(new BN(2));

    // Calculate the max total fee (maxFeePerGas * gasLimit)
    const maxTotalFee = maxFeePerGasBN.add(maxPriorityFeePerGasBN).mul(gasLimitBN);

    // Calculate the value to send by subtracting the fee
    const valueToSend = new BN(amountToWithdraw).sub(maxTotalFee);

    // Check if balance is sufficient
    if (amountToWithdraw.lt(maxTotalFee)) {
      throw new Error("Insufficient funds to cover gas fee");
    }

    // EIP-1559 TX Type
    txParams = {
      gasLimit: gasLimitBN.toString(),
      // double the maxFeePerGas to ensure the transaction is included
      maxFeePerGas: maxFeePerGasBN.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGasBN.toString(),
      nonce: transactionConfig.nonce,
      to: transactionConfig.to,
      value: valueToSend.toString(),
      type: 2,
      chainId: await web3.eth.getChainId(),
    };
  } else {
    throw new Error("No gas information provided");
  }

  const serializedUnsignedTx = ethers.utils.serializeTransaction(<UnsignedTransaction>txParams);
  const transactionSignature = await _signDigest(ethers.utils.keccak256(serializedUnsignedTx), kmsCredentials);
  const serializedTx = ethers.utils.serializeTransaction(<UnsignedTransaction>txParams, transactionSignature);

  console.log("estimatedGas: ", estimatedGas);
  console.log("amount to withdraw: ", amountToWithdraw);
  console.log("txParams: ", txParams);
  console.log("serializedTx: ", serializedTx);

  return;
  /*   // Promi event => promise resolved on event receipt
  const receipt = ((await web3.eth.sendSignedTransaction(serializedTx)) as unknown) as TransactionReceipt;
  const transactionHash = receipt.transactionHash;

  return { receipt, transactionHash, transactionConfig }; */
}
