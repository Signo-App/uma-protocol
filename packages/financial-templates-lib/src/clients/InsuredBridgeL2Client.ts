// A thick client for getting information about insured bridge L1 & L2 information. Simply acts to fetch information
// from the respective chains and return it to client implementors.

import { getAbi } from "@uma/contracts-node";
import type { BridgeDepositBoxWeb3 } from "@uma/contracts-node";
import Web3 from "web3";
const { toChecksumAddress, soliditySha3 } = Web3.utils;
import type { Logger } from "winston";

export interface Deposit {
  chainId: number;
  depositId: number;
  depositHash: string;
  l1Recipient: string;
  l2Sender: string;
  l1Token: string;
  amount: string;
  slowRelayFeePct: string;
  instantRelayFeePct: string;
  quoteTimestamp: number;
  depositContract: string;
}

export class InsuredBridgeL2Client {
  public bridgeDepositBoxes: BridgeDepositBoxWeb3[];

  private deposits: { [key: string]: Deposit } = {}; // DepositHash=>Deposit
  private whitelistedTokens: { [key: string]: string } = {}; // L1Token=>L2Token

  private firstBlockToSearch: number;

  constructor(
    private readonly logger: Logger,
    readonly l2Web3s: Web3[],
    readonly bridgeDepositAddress: string,
    readonly chainId: number = 0,
    readonly startingBlockNumber: number = 0,
    readonly endingBlockNumber: number | null = null
  ) {
    // For each L2 web3 provider, store a contract instance. We do this for l2 web3 provider redundancy because l2
    // providers are expected to be flaky (compared to L1 providers) and we will compare state from all l2 providers
    // for extra safety.
    this.bridgeDepositBoxes = [];

    l2Web3s.forEach((_l2Web3) => {
      this.bridgeDepositBoxes.push(
        (new _l2Web3.eth.Contract(getAbi("BridgeDepositBox"), bridgeDepositAddress) as unknown) as BridgeDepositBoxWeb3
      );
    });

    this.firstBlockToSearch = startingBlockNumber;
  }

  getAllDeposits() {
    return Object.keys(this.deposits).map((depositHash: string) => this.deposits[depositHash]);
  }

  getAllDepositsForL1Token(l1TokenAddress: string) {
    return this.getAllDeposits().filter((deposit: Deposit) => deposit.l1Token === l1TokenAddress);
  }

  isWhitelistedToken(l1TokenAddress: string) {
    return this.whitelistedTokens[toChecksumAddress(l1TokenAddress)] !== undefined;
  }

  getDepositByHash(depositHash: string) {
    return this.deposits[depositHash];
  }

  // TODO: consider adding a method that limits how far back the deposits will be returned from. In this implementation
  // we might hit some performance issues when returning a lot of bridging actions

  async update(): Promise<void> {
    // Define a config to bound the queries by.
    const blockSearchConfig = {
      fromBlock: this.firstBlockToSearch,
      toBlock: this.endingBlockNumber || (await this.l2Web3s[0].eth.getBlockNumber()),
    };
    if (blockSearchConfig.fromBlock > blockSearchConfig.toBlock) {
      this.logger.debug({
        at: "InsuredBridgeL2Client",
        message: "All blocks are searched, returning early",
        toBlock: blockSearchConfig.toBlock,
      });
      return;
    }

    // TODO: update this state retrieval to include looking for L2 liquidity in the deposit box that can be sent over
    // the bridge. This should consider the minimumBridgingDelay and the lastBridgeTime for a respective L2Token.
    const [fundsDepositedEvents, whitelistedTokenEvents] = await Promise.all([
      this.bridgeDepositBoxes[0].getPastEvents("FundsDeposited", blockSearchConfig),
      this.bridgeDepositBoxes[0].getPastEvents("WhitelistToken", blockSearchConfig),
    ]);

    // Compare the events found on other providers with the first provider, if they do not match then throw an error.
    const fundsDepositedTransactionHashes = fundsDepositedEvents.map((event) => event.transactionHash);
    const whitelistedTokenTransactionHashes = whitelistedTokenEvents.map((event) => event.transactionHash);
    for (let i = 1; i < this.bridgeDepositBoxes.length; i++) {
      const [_fundsDepositedEvents, _whitelistedTokenEvents] = await Promise.all([
        this.bridgeDepositBoxes[i].getPastEvents("FundsDeposited", blockSearchConfig),
        this.bridgeDepositBoxes[i].getPastEvents("WhitelistToken", blockSearchConfig),
      ]);
      _fundsDepositedEvents.forEach((event) => {
        if (!fundsDepositedTransactionHashes.includes(event.transactionHash)) {
          throw new Error(
            `Could not find FundsDeposited transaction hash ${event.transactionHash} in first l2 web3 provider`
          );
        }
      });
      _whitelistedTokenEvents.forEach((event) => {
        if (!whitelistedTokenTransactionHashes.includes(event.transactionHash)) {
          throw new Error(
            `Could not find WhitelistToken transaction hash ${event.transactionHash} in first l2 web3 provider`
          );
        }
      });
    }

    // We assume that whitelisted token events are searched from oldest to newest so we'll just store the most recently
    // whitelisted token mappings.
    for (const whitelistedTokenEvent of whitelistedTokenEvents) {
      this.whitelistedTokens[toChecksumAddress(whitelistedTokenEvent.returnValues.l1Token)] = toChecksumAddress(
        whitelistedTokenEvent.returnValues.l2Token
      );
    }

    for (const fundsDepositedEvent of fundsDepositedEvents) {
      const depositData = {
        chainId: Number(fundsDepositedEvent.returnValues.chainId),
        depositId: Number(fundsDepositedEvent.returnValues.depositId),
        depositHash: "", // Filled in after initialization of the remaining variables.
        l1Recipient: fundsDepositedEvent.returnValues.l1Recipient,
        l2Sender: fundsDepositedEvent.returnValues.l2Sender,
        l1Token: fundsDepositedEvent.returnValues.l1Token,
        amount: fundsDepositedEvent.returnValues.amount,
        slowRelayFeePct: fundsDepositedEvent.returnValues.slowRelayFeePct,
        instantRelayFeePct: fundsDepositedEvent.returnValues.instantRelayFeePct,
        quoteTimestamp: Number(fundsDepositedEvent.returnValues.quoteTimestamp),
        depositContract: fundsDepositedEvent.address,
      };
      depositData.depositHash = this.generateDepositHash(depositData);
      this.deposits[depositData.depositHash] = depositData;
    }

    this.firstBlockToSearch = blockSearchConfig.toBlock + 1;

    this.logger.debug({
      at: "InsuredBridgeL2Client",
      message: "Insured bridge l2 client updated",
      chainId: this.chainId,
    });
  }

  generateDepositHash = (depositData: Deposit): string => {
    const depositDataAbiEncoded = this.l2Web3s[0].eth.abi.encodeParameters(
      ["uint256", "uint64", "address", "address", "uint256", "uint64", "uint64", "uint32", "address"],
      [
        depositData.chainId,
        depositData.depositId,
        depositData.l1Recipient,
        depositData.l2Sender,
        depositData.amount,
        depositData.slowRelayFeePct,
        depositData.instantRelayFeePct,
        depositData.quoteTimestamp,
        depositData.l1Token,
      ]
    );
    const depositHash = soliditySha3(depositDataAbiEncoded);
    if (depositHash == "" || depositHash == null) throw new Error("Bad deposit hash");
    return depositHash;
  };
}
