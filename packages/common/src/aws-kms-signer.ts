import { ethers, UnsignedTransaction } from "ethers";
import type { ContractSendMethod } from "web3-eth-contract";
import type Web3 from "web3";
import { _signDigest, AwsKmsSignerCredentials } from "./aws-kms-utils";
import { AugmentedSendOptions } from "./TransactionUtils";
import type { TransactionReceipt, PromiEvent } from "web3-core";

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
  transactionConfig: AugmentedSendOptions
) {
  const web3 = _web3;
  const encodedFunctionCall = transaction.encodeABI();

  // EIP-1559 TX Type or Legacy depending on maxFeePerGas, maxPriorityFeePerGas and gasPrice
  const txParams: UnsignedTransaction = {
    gasLimit: transactionConfig.gas,
    // double the maxFeePerGas to ensure the transaction is included
    maxFeePerGas: transactionConfig.maxFeePerGas,
    maxPriorityFeePerGas: transactionConfig.maxPriorityFeePerGas,
    gasPrice: transactionConfig.gasPrice,
    nonce: transactionConfig.nonce,
    to: transactionConfig.to,
    value: transactionConfig.value || "0x00",
    data: encodedFunctionCall,
    type: Number(transactionConfig.type),
    chainId: Number(transactionConfig.chainId),
  };
  console.log("TX Params: ", txParams);

  const serializedUnsignedTx = ethers.utils.serializeTransaction(<UnsignedTransaction>txParams);
  const transactionSignature = await _signDigest(ethers.utils.keccak256(serializedUnsignedTx), kmsCredentials);
  const serializedTx = ethers.utils.serializeTransaction(<UnsignedTransaction>txParams, transactionSignature);

  console.log("sending transaction ....");

  // Promi event => promise resolved on event receipt
  return web3.eth.sendSignedTransaction(serializedTx);
}
