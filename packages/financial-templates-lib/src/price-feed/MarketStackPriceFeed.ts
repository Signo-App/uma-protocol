import { BN } from "../types";
import { parseFixed } from "@uma/common";
import moment from "moment";
import type { Logger } from "winston";
import { NetworkerInterface } from "./Networker";
import { PriceFeedInterface } from "./PriceFeedInterface";
import Web3 from "web3";

export class MarketStackPriceFeed extends PriceFeedInterface {
  private readonly uuid: string;
  private readonly convertPriceFeedDecimals: (number: number | string | BN) => BN;
  private priceHistory: { date: number; openPrice: BN }[];
  private currentPrice: BN | null = null;
  private lastUpdateTime: number | null = null;

  /**
   * @notice Constructs the MarketStackPriceFeed.
   * @param {Object} logger Winston module used to send logs.
   * @param {String} symbolString String used in query to fetch data, i.e. "DXY.INDX"
   * @param {String} apiKey apiKey for MarketStack api
   * @param {Integer} lookback How far in the past the historical prices will be available using getHistoricalPrice.
   * @param {Object} networker Used to send the API requests.
   * @param {Function} getTime Returns the current time.
   * @param {Number} priceFeedDecimals Number of priceFeedDecimals to use to convert price to wei.
   * @param {Integer} minTimeBetweenUpdates Min number of seconds between updates. If update() is called again before
   *      this number of seconds has passed, it will be a no-op.
   */
   constructor(
    private readonly logger: Logger,
    private readonly symbolString: String,
    private readonly apiKey: string,
    private readonly lookback: number,
    private readonly networker: NetworkerInterface,
    private readonly getTime: () => Promise<number>,
    private readonly priceFeedDecimals = 18,
    private readonly minTimeBetweenUpdates = 43200 // 12 hours is a reasonable default since this pricefeed returns daily granularity at best.
  ) {
    super();
    console.log('constructing');

    this.uuid = `MarketStack-${symbolString}`;

    this.priceHistory = [];

    this.convertPriceFeedDecimals = (number) => {
      // Converts price result to wei
      // returns price conversion to correct decimals as a big number.
      // Note: Must ensure that `number` has no more decimal places than `priceFeedDecimals`.
      return Web3.utils.toBN(parseFixed(number.toString().substring(0, priceFeedDecimals), priceFeedDecimals).toString());
    };

    throw "too scared to go further :3";
  }
  // Updates the internal state of the price feed. Should pull in any async data so the get*Price methods can be called.
  // Will use the optional ancillary data parameter to customize what kind of data get*Price returns.
  // Note: derived classes *must* override this method.
  // Note: Eventually `update` will be removed in favor of folding its logic into `getCurrentPrice`.
  public async update(ancillaryData?: string): Promise<void> {
    const currentTime = await this.getTime();

    // Return early if the last call was too recent.
    if (this.lastUpdateTime !== null && this.lastUpdateTime + this.minTimeBetweenUpdates > currentTime) {
      this.logger.debug({
        at: "MarketStackPriceFeed",
        message: "Update skipped because the last one was too recent",
        currentTime: currentTime,
        lastUpdateTimestamp: this.lastUpdateTime,
        timeRemainingUntilUpdate: this.lastUpdateTime + this.minTimeBetweenUpdates - currentTime,
      });
      return;
    }

    this.logger.debug({
      at: "MarketStackPriceFeed",
      message: "Updating MarketStackPriceFeed",
      currentTime: currentTime,
      lastUpdateTimestamp: this.lastUpdateTime,
    });

    // Find the closest day that completed before the beginning of the lookback window, and use
    // it as the start date.
    const startLookbackWindow = currentTime - this.lookback;
    const startDateString = this._secondToDateTime(startLookbackWindow);
    const endDateString = this._secondToDateTime(currentTime);

    // 1. Construct URL.
    // See https://marketstack.com/documentation.
    const url =
      "https://api.marketstack.com/v1/eod?" +
      `symbols=${this.symbolString}&access_key=${this.apiKey}` +
      `date_from=${startDateString}&date_to=${endDateString}` ;
    
    // 2. Send request.
    const historyResponse = await this.networker.getJson(url);

    // 3. Check responses.
    if (
      !historyResponse?.data ||
      historyResponse.data.length === 0
    ) {
      throw new Error(`🚨Could not parse price result from url ${url}: ${JSON.stringify(historyResponse)}`);
    }

    // 4. Parse results.
    const newHistoricalPricePeriods = historyResponse.dataset_data.data
      .map((dailyData: any) => ({
        date: this._dateTimeToSecond(dailyData.date),
        openPrice: this.convertPriceFeedDecimals(dailyData.open)
      }))
      .sort((a: any, b: any) => {
        // Sorts the data such that the oldest elements come first.
        return a.date - b.date;
      });
    
    // 5. Store results.
    this.currentPrice = newHistoricalPricePeriods[newHistoricalPricePeriods.length - 1].openPrice;
    this.priceHistory = newHistoricalPricePeriods;
    this.lastUpdateTime = currentTime;
  }

  // Gets the current price (as a BN) for this feed synchronously from the in-memory state of this price feed object.
  // This price should be up-to-date as of the last time that `update(ancillaryData)` was called, using any parameters
  // specified in the ancillary data passed as input. If `update()` has never been called, this should return `null` or
  // `undefined`. If no price could be retrieved, it should return `null` or `undefined`.
  // Note: derived classes *must* override this method.
  public getCurrentPrice(): BN | null {
    return this.currentPrice;
  }

  // Gets the price (as a BN) for the time (+ ancillary data) specified. Similar to `getCurrentPrice()`, the price is
  // derived from the in-memory state of the price feed object, so this method is synchronous. This price should be
  // up-to-date as of the last time `update()` was called. If `update()` has never been called, this should throw. If
  // the time is before the pre-determined historical lookback window of this PriceFeed object, then this method should
  // throw. If the historical price could not be computed for any other reason, this method
  // should throw.
  // Note: derived classes *must* override this method.
  public async getHistoricalPrice(time: number, ancillaryData?: string, verbose?: boolean): Promise<BN | null> {
    return this.currentPrice;
  }

  public getLastUpdateTime(): number | null {
    return this.lastUpdateTime;
  }

  public getLookback(): number {
    return this.lookback;
  }

  public getPriceFeedDecimals(): number {
    return this.priceFeedDecimals;
  }

  private _secondToDateTime(inputSecond: number) {
    return moment.unix(inputSecond).format("YYYY-MM-DD");
  }
  private _dateTimeToSecond(inputDateTime: string, endOfDay = false) {
    if (endOfDay) {
      return moment(inputDateTime, "YYYY-MM-DD").endOf("day").unix();
    } else {
      return moment(inputDateTime, "YYYY-MM-DD").unix();
    }
  }
}
