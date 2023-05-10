import { KMS } from 'aws-sdk';
import { keccak_256 } from 'js-sha3';
import * as ethutil from 'ethereumjs-util';
import Web3 from 'web3';
import { default as BN } from 'bn.js';
import { TransactionReceipt } from 'web3-core/types';
import { ethers, UnsignedTransaction } from "ethers";
import type { ContractSendMethod, SendOptions } from "web3-eth-contract";

const asn1 = require('asn1.js');

const REGION = "us-east-2";

const kms = new KMS({
  accessKeyId: process.env.KMS_ACCESS_KEY_ID, // credentials for your IAM user with KMS access
  secretAccessKey: process.env.KMS_ACCESS_SECRET_KEY, // credentials for your IAM user with KMS access
  region: REGION,
});

const keyId = process.env.KMS_SIGNER;

// Set up a Web3 instance to interact with the Ethereum network
const web3 = new Web3('https://eth-goerli.g.alchemy.com/v2/Y2CYSJ_YfMTwkJ7IAjnJWxF_DzHHrhiD');


const EcdsaPubKey = asn1.define('EcdsaPubKey', function (this: any) {
  // parsing this according to https://tools.ietf.org/html/rfc5480#section-2
  this.seq().obj(
    this.key('algo').seq().obj(
      this.key('a').objid(),
      this.key('b').objid(),
    ),
    this.key('pubKey').bitstr()
  );
});

async function getPublicKey(keyPairId: string) {
  return kms.getPublicKey({
    KeyId: keyPairId
  }).promise();
}

function getEthereumAddress(publicKey: Buffer) {
  //console.log("Encoded Pub Key: " + publicKey.toString('hex'));

  // The public key is ASN1 encoded in a format according to 
  // https://tools.ietf.org/html/rfc5480#section-2
  // I used https://lapo.it/asn1js to figure out how to parse this 
  // and defined the schema in the EcdsaPubKey object
  let res = EcdsaPubKey.decode(publicKey, 'der');
  let pubKeyBuffer = res.pubKey.data;

  // The public key starts with a 0x04 prefix that needs to be removed
  // more info: https://www.oreilly.com/library/view/mastering-ethereum/9781491971932/ch04.html
  pubKeyBuffer = pubKeyBuffer.slice(1, pubKeyBuffer.length);

  const address = keccak_256(pubKeyBuffer) // keccak256 hash of publicKey  
  const buf2 = Buffer.from(address, 'hex');
  const EthAddr = "0x" + buf2.slice(-20).toString('hex'); // take last 20 bytes as ethereum adress
  //console.log("Generated Ethreum address: " + EthAddr);
  return EthAddr;
}
const EcdsaSigAsnParse = asn1.define('EcdsaSig', function (this: any) {
  this.seq().obj(
    this.key('r').int(),
    this.key('s').int(),
  );
});

function recoverPubKeyFromSig(msg: Buffer, r: BN, s: BN, v: number) {
  //console.log("Recovering public key with msg " + msg.toString('hex') + " r: " + r.toString(16) + " s: " + s.toString(16));
  let rBuffer = r.toBuffer();
  let sBuffer = s.toBuffer();
  let pubKey = ethutil.ecrecover(msg, v, rBuffer, sBuffer);
  let addrBuf = ethutil.pubToAddress(pubKey);
  var RecoveredEthAddr = ethutil.bufferToHex(addrBuf);
  //console.log("Recovered ethereum address: " + RecoveredEthAddr);
  return RecoveredEthAddr;
}

async function sign(msgHash: any, keyId: any) {
  const params = {
    KeyId: keyId,
    Message: msgHash,
    SigningAlgorithm: 'ECDSA_SHA_256',
    MessageType: 'DIGEST'
  };
  const res = await kms.sign(params).promise();
  return res;
}

async function findEthereumSig(plaintext: any) {
  let signature = await sign(plaintext, keyId);
  if (signature.Signature == undefined) {
    throw new Error('Signature is undefined.');
  }
  //console.log("encoded sig: " + signature.Signature.toString('hex'));

  let decoded = EcdsaSigAsnParse.decode(signature.Signature, 'der');
  let r = decoded.r;
  let s = decoded.s;
  //console.log("r: " + r.toString(10));
  //console.log("s: " + s.toString(10));

  let tempsig = r.toString(16) + s.toString(16);

  let secp256k1N = new BN("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", 16); // max value on the curve
  let secp256k1halfN = secp256k1N.div(new BN(2)); // half of the curve

  if (s.gt(secp256k1halfN)) {
    //console.log("s is on the wrong side of the curve... flipping - tempsig: " + tempsig + " length: " + tempsig.length);
    s = secp256k1N.sub(s);
    //console.log("new s: " + s.toString(10));
    return { r, s }
  }
  return { r, s }
}

function findRightKey(msg: Buffer, r: any, s: any, expectedEthAddr: string) {
  let v = 27;
  let pubKey = recoverPubKeyFromSig(msg, r, s, v);
  if (pubKey != expectedEthAddr) {
    v = 28;
    pubKey = recoverPubKeyFromSig(msg, r, s, v)
  }
  //console.log("Found the right ETH Address: " + pubKey + " v: " + v);
  return { pubKey, v };
}

async function _signDigest(digestString: string): Promise<string> {
  let pubKey = await getPublicKey(keyId!);
  let ethAddr = getEthereumAddress((pubKey.PublicKey as Buffer));

  const digestBuffer = Buffer.from(ethers.utils.arrayify(digestString));
  const sig = await findEthereumSig(digestBuffer);
  const { v } = findRightKey(digestBuffer, sig.r, sig.s, ethAddr);
  return ethers.utils.joinSignature({
    v,
    r: `0x${sig.r.toString("hex")}`,
    s: `0x${sig.s.toString("hex")}`,
  });
}

export async function signFunctionWithKMS(transaction: ContractSendMethod, transactionConfig: any): Promise<TransactionReceipt> {

  //const transferFunction = contract.methods.transfer("0xaC7Bba69a23B32D5F0Db30E24143bc8a660aA2dc", '11');
  const encodedFunctionCall = transaction.encodeABI();

  // EIP-1559 TX Type
  const txParams: UnsignedTransaction = {
    gasLimit:350000,
    //double the maxFeePerGas to ensure the transaction is included
    maxFeePerGas: parseInt(transactionConfig.maxFeePerGas.toString()) * 2,
    maxPriorityFeePerGas: transactionConfig.maxPriorityFeePerGas,
    nonce: transactionConfig.nonce,
    to: transactionConfig.to,
    value: transactionConfig.value || '0x00',
    data: encodedFunctionCall,
    type: 2,
    chainId: 5
  }
  console.log('TX Params: ',txParams);

  const serializedUnsignedTx = ethers.utils.serializeTransaction(<UnsignedTransaction>txParams);
  const transactionSignature = await _signDigest(ethers.utils.keccak256(serializedUnsignedTx));
  const serializedTx = ethers.utils.serializeTransaction(<UnsignedTransaction>txParams, transactionSignature);

  console.log('sending transaction ....')

  return new Promise<TransactionReceipt>((resolve, reject) => {
    web3.eth.sendSignedTransaction(serializedTx)
      .on('receipt', (receipt) => {
        console.log('transaction sent')
        resolve(receipt);
      })
      .on('error', (error) => {
        reject(error);
      });
  });

}
