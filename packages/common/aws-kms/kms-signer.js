const ClayToken = require('./abis/ClayToken.json');
const { KMS } = require('aws-sdk');
const { keccak256 } = require('js-sha3');
const asn1 = require('asn1.js');
const Web3 = require('web3');
const { Transaction } = require('ethereumjs-tx')
const BN = require('bn.js');
const ethutil = require('ethereumjs-util')
require("dotenv").config();


const REGION = "us-east-2";

const kms = new KMS({
  accessKeyId: process.env.KMS_ACCESS_KEY_ID, // credentials for your IAM user with KMS access
  secretAccessKey: process.env.KMS_ACCESS_SECRET_KEY, // credentials for your IAM user with KMS access
  region: REGION,
});

const keyId = process.env.KMS_SIGNER;

// Set up a Web3 instance to interact with the Ethereum network
const web3 = new Web3('https://eth-goerli.g.alchemy.com/v2/Y2CYSJ_YfMTwkJ7IAjnJWxF_DzHHrhiD');
const contractAddress = '0x33161EbeF6a9A1E8b3E5e68edD3420BD48D62641';
const contract = new web3.eth.Contract(ClayToken.abi, contractAddress);


const EcdsaPubKey = asn1.define('EcdsaPubKey', function () {
  // parsing this according to https://tools.ietf.org/html/rfc5480#section-2
  this.seq().obj(
    this.key('algo').seq().obj(
      this.key('a').objid(),
      this.key('b').objid(),
    ),
    this.key('pubKey').bitstr()
  );
});

async function getPublicKey(keyPairId) {
  return kms.getPublicKey({
    KeyId: keyPairId
  }).promise();
}

function getEthereumAddress(publicKey) {
  console.log("Encoded Pub Key: " + publicKey.toString('hex'));

  // The public key is ASN1 encoded in a format according to 
  // https://tools.ietf.org/html/rfc5480#section-2
  // I used https://lapo.it/asn1js to figure out how to parse this 
  // and defined the schema in the EcdsaPubKey object
  let res = EcdsaPubKey.decode(publicKey, 'der');
  let pubKeyBuffer = res.pubKey.data;

  // The public key starts with a 0x04 prefix that needs to be removed
  // more info: https://www.oreilly.com/library/view/mastering-ethereum/9781491971932/ch04.html
  pubKeyBuffer = pubKeyBuffer.slice(1, pubKeyBuffer.length);

  const address = keccak256(pubKeyBuffer) // keccak256 hash of publicKey  
  const buf2 = Buffer.from(address, 'hex');
  const EthAddr = "0x" + buf2.slice(-20).toString('hex'); // take last 20 bytes as ethereum adress
  console.log("Generated Ethreum address: " + EthAddr);
  return EthAddr;
}
const EcdsaSigAsnParse = asn1.define('EcdsaSig', function () {
  this.seq().obj(
    this.key('r').int(),
    this.key('s').int(),
  );
});

function recoverPubKeyFromSig(msg, r, s, v) {
  console.log("Recovering public key with msg " + msg.toString('hex') + " r: " + r.toString(16) + " s: " + s.toString(16));
  let rBuffer = r.toBuffer();
  let sBuffer = s.toBuffer();
  let pubKey = ethutil.ecrecover(msg, v, rBuffer, sBuffer);
  let addrBuf = ethutil.pubToAddress(pubKey);
  var RecoveredEthAddr = ethutil.bufferToHex(addrBuf);
  console.log("Recovered ethereum address: " + RecoveredEthAddr);
  return RecoveredEthAddr;
}

async function sign(msgHash, keyId) {
  const params = {
    KeyId: keyId,
    Message: msgHash,
    SigningAlgorithm: 'ECDSA_SHA_256',
    MessageType: 'DIGEST'
  };
  const res = await kms.sign(params).promise();
  return res;
}

async function findEthereumSig(plaintext) {
  let signature = await sign(plaintext, keyId);
  if (signature.Signature == undefined) {
    throw new Error('Signature is undefined.');
  }
  console.log("encoded sig: " + signature.Signature.toString('hex'));

  let decoded = EcdsaSigAsnParse.decode(signature.Signature, 'der');
  let r = decoded.r;
  let s = decoded.s;
  console.log("r: " + r.toString(10));
  console.log("s: " + s.toString(10));

  let tempsig = r.toString(16) + s.toString(16);

  let secp256k1N = new BN("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", 16); // max value on the curve
  let secp256k1halfN = secp256k1N.div(new BN(2)); // half of the curve

  if (s.gt(secp256k1halfN)) {
    console.log("s is on the wrong side of the curve... flipping - tempsig: " + tempsig + " length: " + tempsig.length);
    s = secp256k1N.sub(s);
    console.log("new s: " + s.toString(10));
    return { r, s }
  }
  return { r, s }
}

function findRightKey(msg, r, s, expectedEthAddr) {
  let v = 27;
  let pubKey = recoverPubKeyFromSig(msg, r, s, v);
  if (pubKey != expectedEthAddr) {
    v = 28;
    pubKey = recoverPubKeyFromSig(msg, r, s, v)
  }
  console.log("Found the right ETH Address: " + pubKey + " v: " + v);
  return { pubKey, v };
}


async function transferTokens() {
  let pubKey = await getPublicKey(keyId);
  let ethAddr = getEthereumAddress((pubKey.PublicKey));
  let ethAddrHash = ethutil.keccak(Buffer.from(ethAddr));
  let sig = await findEthereumSig(ethAddrHash);
  let recoveredPubAddr = findRightKey(ethAddrHash, sig.r, sig.s, ethAddr);

  const transferFunction = contract.methods.transfer("0xaC7Bba69a23B32D5F0Db30E24143bc8a660aA2dc", '11');
  const encodedFunctionCall = transferFunction.encodeABI();

  const txParams = {
    gasLimit: 50000,
    gasPrice: 432108056100,
    nonce: await web3.eth.getTransactionCount(ethAddr),
    chainId: '0x05',
    to: contractAddress,
    value: '0x00',
    data: encodedFunctionCall,
    r: sig.r.toBuffer(),
    s: sig.s.toBuffer(),
    v: recoveredPubAddr.v
  }
  console.log(txParams);

  const tx = new Transaction(txParams, {
    chain: 'goerli',
  });

  // signing the 2nd time
  // this time we're signing the hash of the actual transaction
  // tx.hash calculates the hash
  // false indicates that we do not want the hash function to take the signature into account

  let txHash = tx.hash(false);
  console.log('tx has: ', txHash)
  sig = await findEthereumSig(txHash);
  recoveredPubAddr = findRightKey(txHash, sig.r, sig.s, ethAddr);
  tx.r = sig.r.toBuffer();
  tx.s = sig.s.toBuffer();
  tx.v = new BN(recoveredPubAddr.v).toBuffer();
  console.log(tx.getSenderAddress().toString('hex'));


  // Send signed tx to ethereum network 
  const serializedTx = tx.serialize().toString('hex');
  console.log('sending transaction ....')
  await web3.eth.sendSignedTransaction('0x' + serializedTx)
    .on('confirmation', (confirmationNumber, receipt) => { })
    .on('receipt', (txReceipt) => {
      console.log("signAndSendTx txReceipt. Tx Address: " + txReceipt.transactionHash);
    })
    .on('error', error => console.log(error));
  console.log('transaction sent')
}
transferTokens()