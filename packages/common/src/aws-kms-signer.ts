import { ethers, UnsignedTransaction } from "ethers";
import type { ContractSendMethod } from "web3-eth-contract";
import type Web3 from "web3";
import { _signDigest, AwsKmsSignerCredentials } from "./aws-kms-utils";
import type { TransactionReceipt } from "web3-core";
import { accountHasPendingTransactions, getPendingTransactionCount } from "./TransactionUtils";
const GAS_LIMIT_BUFFER = 1.25;


const kmsCredentials: AwsKmsSignerCredentials = {
  accessKeyId: process.env.KMS_ACCESS_KEY_ID, // credentials for your IAM user with KMS access
  secretAccessKey: process.env.KMS_ACCESS_SECRET_KEY, // credentials for your IAM user with KMS access
  region: "us-east-2",
  keyId: process.env.KMS_SIGNER!,
};

// this function is used to send a web3 transaction and sign it with AWS KMS
export async function sendTxWithKMS(
  _web3: Web3,
  transaction: ContractSendMethod,
  transactionConfig: any
) {
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


  // EIP-1559 TX Type or Legacy depending on maxFeePerGas, maxPriorityFeePerGas and gasPrice
  const txParams: UnsignedTransaction = {
    gasLimit: Math.floor(estimatedGas * GAS_LIMIT_BUFFER),
    // double the maxFeePerGas to ensure the transaction is included
    maxFeePerGas: parseInt(transactionConfig.maxFeePerGas.toString()) * 2,
    maxPriorityFeePerGas: transactionConfig.maxPriorityFeePerGas,
    gasPrice: transactionConfig.gasPrice,
    nonce: transactionConfig.nonce,
    to: transactionConfig.to,
    value: transactionConfig.value || "0x00",
    data: encodedFunctionCall,
    type: 2,
    chainId: 5,
  };

  const serializedUnsignedTx = ethers.utils.serializeTransaction(<UnsignedTransaction>txParams);
  const transactionSignature = await _signDigest(ethers.utils.keccak256(serializedUnsignedTx), kmsCredentials);
  const serializedTx = ethers.utils.serializeTransaction(<UnsignedTransaction>txParams, transactionSignature);

  // Promi event => promise resolved on event receipt
  const receipt = (await web3.eth.sendSignedTransaction(serializedTx) as unknown) as TransactionReceipt;
  const transactionHash = receipt.transactionHash;

  return { receipt, transactionHash, returnValue, transactionConfig };
}