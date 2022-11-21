import { BN } from "../types";
import { parseFixed } from "@uma/common";
import moment from "moment";
import type { Logger } from "winston";
import { NetworkerInterface } from "./Networker";
import { PriceFeedInterface } from "./PriceFeedInterface";
import Web3 from "web3";

export class CommoditiesApiPriceFeed extends PriceFeedInterface {
  private readonly uuid: string;
  private readonly convertPriceFeedDecimals: (number: number | string | BN) => BN;
  private priceHistory: any;
  private currentPrice: BN | null = null;
  private lastUpdateTime: number | null = null;

  /**
   * @notice Constructs the CommoditiesApiPriceFeed.
   * @param {Object} logger Winston module used to send logs.
   * @param {String} baseCurrency currency to show price in i.e. "USD"
   * @param {String} commodity commodity symbol i.e. "XAU"
   * @param {String} apiKey apiKey for Commodities api
   * @param {Integer} lookback How far in the past the historical prices will be available using getHistoricalPrice.
   * @param {Object} networker Used to send the API requests.
   * @param {Function} getTime Returns the current time.
   * @param {Number} priceFeedDecimals Number of priceFeedDecimals to use to convert price to wei.
   * @param {Integer} minTimeBetweenUpdates Min number of seconds between updates. If update() is called again before
   *      this number of seconds has passed, it will be a no-op.
   */
  constructor(
    private readonly logger: Logger,
    private readonly baseCurrency: String,
    private readonly commodity: String,
    private readonly apiKey: string,
    private readonly lookback: number,
    private readonly networker: NetworkerInterface,
    private readonly getTime: () => Promise<number>,
    private readonly priceFeedDecimals = 18,
    private readonly minTimeBetweenUpdates = 43200 // 12 hours is a reasonable default since this pricefeed returns daily granularity at best.
  ) {
    super();

    this.uuid = `CommoditiesApi-${commodity}${baseCurrency}`;

    this.priceHistory = {};

    this.convertPriceFeedDecimals = (number) => {
      // Converts price result to wei
      // returns price conversion to correct decimals as a big number.
      // Note: Must ensure that `number` has no more decimal places than `priceFeedDecimals`.
      return Web3.utils.toBN(parseFixed(number.toString().substring(0, priceFeedDecimals), priceFeedDecimals).toString());
    };
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
        at: "CommoditiesApiPriceFeed",
        message: "Update skipped because the last one was too recent",
        currentTime: currentTime,
        lastUpdateTimestamp: this.lastUpdateTime,
        timeRemainingUntilUpdate: this.lastUpdateTime + this.minTimeBetweenUpdates - currentTime,
      });
      return;
    }

    this.logger.debug({
      at: "CommoditiesApiPriceFeed",
      message: "Updating CommoditiesApiPriceFeed",
      currentTime: currentTime,
      lastUpdateTimestamp: this.lastUpdateTime,
    });

    // Find the closest day that completed before the beginning of the lookback window, and use
    // it as the start date.
    const startLookbackWindow = currentTime - this.lookback;
    const startDateString = this._secondToDateTime(startLookbackWindow);
    const endDateString = this._secondToDateTime(currentTime);

    // 1. Construct URL.
    // See https://commodities-api.com/documentation
    const url =
      "https://commodities-api.com/api/timeseries" +
      `?access_key=${this.apiKey}` +
      `&start_date=${startDateString}` +
      `&end_date=${endDateString}` +
      `&base=${this.baseCurrency}` +
      `&symbols=${this.commodity}`;

    console.log("DEBUG-comm: ", url);

    // 2. Send request.
    const historyResponse = await this.networker.getJson(url);

    console.log("DEBUG-comm: ", historyResponse);

    // 3. Check responses.
    if (
      !(historyResponse?.data) ||
      historyResponse.data.length === 0
    ) {
      throw new Error(`🚨Could not parse price result from url ${url}: ${JSON.stringify(historyResponse)}`);
    }

    // 4. Parse results.
    // historyResponse.data.rates -> {{"YYYY-MM-DD":{"commodity": value, "baseCurrency": value}}, ..}
    // @ts-ignore
    const newHistoricalPricePeriods = Object.entries(historyResponse.data.rates).map((e) => (Object.assign(e[1],
      { "date": this._dateTimeToSecond(e[0]) }
    )));
    // newHistoricalPricePeriods -> [{"commodity": value, "baseCurrency": value, date: "YYYY-MM-DD"}, ..]

    // 5. Store results.
    this.currentPrice = this.getHistoricalPrice(currentTime);
    this.priceHistory = newHistoricalPricePeriods;
    this.lastUpdateTime = currentTime;
  }

  /**
   * 
   * @param rate {"YYYY-MM-DD":{"commodity": number, "baseCurrency": number}
   * @returns number
   */
  private _getPriceFromObject(rate) {
    return rate[this.baseCurrency.toUpperCase()] / rate[this.commodity.toUpperCase()];
  }

  public getCurrentPrice(): BN | null {
    return this.currentPrice;
  }

  public async getHistoricalPrice(time: number, ancillaryData?: string, verbose?: boolean): Promise<BN | null> {
    if (this.lastUpdateTime === undefined) {
      throw new Error(`${this.uuid}: undefined lastUpdateTime`);
    }

    // Set first price period in `historicalPricePeriods` to first non-null price.
    let firstPrice;
    for (const p in this.priceHistory) {
      if (this.priceHistory[p] && this.priceHistory[p][this.baseCurrency.toUpperCase()] && this.priceHistory[p][this.commodity.toUpperCase()]) {
        firstPrice = this._getPriceFromObject(this.priceHistory[p]);
        break;
      }
    }

    // If there are no valid price periods, return null.
    if (!firstPrice) {
      throw new Error(`${this.uuid}: no valid price periods`);
    }

    // If the time is before the first piece of data in the set, return null because
    // the price is before the lookback window.
    if (time < firstPrice.date) {
      throw new Error(`${this.uuid}: time ${time} is before firstPricePeriod.openTime`);
    }

    // historicalPricePeriods are ordered from oldest to newest.
    // This finds the first pricePeriod whose closeTime is after the provided time.
    const match = this.priceHistory.find((pricePeriod) => {
      return time < pricePeriod.date;
    });

    // If there is no match, that means that the time was past the last data point.
    // In this case, the best match for this price is the current price.
    let returnPrice;
    if (match === undefined) {
      if (this.currentPrice === null) throw new Error(`${this.uuid}: currentPrice is null`);
      returnPrice = this.currentPrice;
      if (verbose) {
        console.group(`\n(${this.commodity}${this.baseCurrency}) No price available @ ${time}`);
        console.log(
          `- ✅ Time is later than earliest historical time, fetching current price: ${Web3.utils.fromWei(
            returnPrice.toString()
          )}`
        );
        console.groupEnd();
      }
      return returnPrice;
    }

    returnPrice = match.openPrice;
    if (verbose) {
      console.group(`\n(${this.commodity}${this.baseCurrency}) Historical price @ ${match.date}`);
      console.log(`- ✅ Open Price:${Web3.utils.fromWei(returnPrice.toString())}`);
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
