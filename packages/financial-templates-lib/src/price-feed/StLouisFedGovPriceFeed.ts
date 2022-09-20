import { BN } from "../types";
import { parseFixed } from "@uma/common";
import moment from "moment";
import type { Logger } from "winston";
import { NetworkerInterface } from "./Networker";
import { PriceFeedInterface } from "./PriceFeedInterface";
import Web3 from "web3";

export class StLouisFedGovPriceFeed extends PriceFeedInterface {
  private readonly uuid: string;
  private readonly convertPriceFeedDecimals: (number: number | string | BN) => BN;
  private priceHistory: { date: number; openPrice: BN }[];
  private currentPrice: BN | null = null;
  private lastUpdateTime: number | null = null;

  /**
   * @notice Constructs the StLouisFedGovPriceFeed.
   * @param {Object} logger Winston module used to send logs.
   * @param {String} symbolString String used in query to fetch data, i.e. "CPIAUCSL"
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

    this.uuid = `StLouisFedGov-${symbolString}`;

    this.priceHistory = [];

    this.convertPriceFeedDecimals = (number) => {
      // Converts price result to wei
      // returns price conversion to correct decimals as a big number.
      // Note: Must ensure that `number` has no more decimal places than `priceFeedDecimals`.
      return Web3.utils.toBN(parseFixed(number.toString().substring(0, priceFeedDecimals), priceFeedDecimals).toString());
    };
  }
  private async _getHistoricalPrice(time: number) : Promise<BN | null> {
    const dataFetchStartTime = time - (60*60*24*60) // good guarantee to get at least 1 data point

    const dataFetchStartString = this._secondToDateTime(dataFetchStartTime);
    const realtimeEndString = this._secondToDateTime(time);

    const url =
      "https://api.stlouisfed.org/fred/series/observations?file_type=json" +
      `&series_id=${this.symbolString}&api_key=${this.apiKey}` +
      `&observation_start=${dataFetchStartString}&realtime_end=${realtimeEndString}`
    
    const fetchResponse = await this.networker.getJson(url);

    if (
      !(fetchResponse?.observations) ||
      fetchResponse.observations.length === 0
    ) {
      throw new Error(`🚨Could not parse price result from url ${url}: ${JSON.stringify(fetchResponse)}`);
    }

    const observations = fetchResponse.observations
      .map((observation: any) => ({
        date: this._dateTimeToSecond(observation.date),
        price: this.convertPriceFeedDecimals(observation.value)
      }))
      .sort((a: any, b: any) => {
        return a.date - b.date;
      });
    
    return observations[observations.length-1].price;
    // return this.convertPriceFeedDecimals(1000);
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
        at: "StLouisFedGovPriceFeed",
        message: "Update skipped because the last one was too recent",
        currentTime: currentTime,
        lastUpdateTimestamp: this.lastUpdateTime,
        timeRemainingUntilUpdate: this.lastUpdateTime + this.minTimeBetweenUpdates - currentTime,
      });
      return;
    }

    this.logger.debug({
      at: "StLouisFedGovPriceFeed",
      message: "Updating StLouisFedGovPriceFeed (only for current price)",
      currentTime: currentTime,
      lastUpdateTimestamp: this.lastUpdateTime,
    });
    
    this.currentPrice = await this._getHistoricalPrice(currentTime);
    this.lastUpdateTime = currentTime;
  }

  public getCurrentPrice(): BN | null {
    return this.currentPrice;
  }

  public async getHistoricalPrice(time: number, ancillaryData?: string, verbose?: boolean): Promise<BN | null> {
    const returnPrice = this._getHistoricalPrice(time);

    if (!returnPrice) {
      throw new Error(`${this.uuid}: can't get historical data for that time`);
    }

    if (verbose) {
      console.group(`\n(${this.symbolString}) Historical price @ ${time}`);
      console.log(`- ✅ Price:${Web3.utils.fromWei(returnPrice.toString())}`);
      console.groupEnd();
    }
    return returnPrice;
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
