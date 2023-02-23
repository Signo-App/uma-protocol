import { BN } from "../types";
import { parseFixed } from "@uma/common";
import moment from "moment";
import type { Logger } from "winston";
import { NetworkerInterface } from "./Networker";
import { PriceFeedInterface } from "./PriceFeedInterface";
import Web3 from "web3";

export class TwelveDataApiPriceFeed extends PriceFeedInterface {
  private readonly uuid: string;
  private readonly convertPriceFeedDecimals: (number: number | string | BN) => BN;
  private priceHistory: { date: number; closePrice: BN }[];
  private currentPrice: BN | null = null;
  private lastUpdateTime: number | null = null;

  /**
   * @notice Constructs the TwelveDataApiPriceFeed.
   * @param {Object} logger Winston module used to send logs.
   * @param {String} index String used in query to fetch index data, i.e. "URTH"
   * @param {String} apiKey apiKey for TwelveData api
   * @param {Integer} lookback How far in the past the historical prices will be available using getHistoricalPrice.
   * @param {Object} networker Used to send the API requests.
   * @param {Function} getTime Returns the current time.
   * @param {Number} priceFeedDecimals Number of priceFeedDecimals to use to convert price to wei.
   * @param {Integer} minTimeBetweenUpdates Min number of seconds between updates. If update() is called again before
   *      this number of seconds has passed, it will be a no-op.
   */
  constructor(
    private readonly logger: Logger,
    private readonly index: string,
    private readonly apiQueryInterval: string,
    private readonly apiKey: string,
    private readonly lookback: number, // lookback should ideally be 4 days to account for NYSE weekends and holidays
    private readonly networker: NetworkerInterface,
    private readonly getTime: () => Promise<number>,
    private readonly priceFeedDecimals = 18,
    private readonly minTimeBetweenUpdates = 900 // 15 mins is a reasonable default since this API uses an interval of 15min
  ) {
    super();

    this.uuid = `TwelveData-${index}`;

    this.priceHistory = [];

    this.convertPriceFeedDecimals = (number) => {
      return Web3.utils.toBN(parseFixed(number.toString().substring(0, priceFeedDecimals), priceFeedDecimals).toString());
    };
  }
  public async update(ancillaryData?: string): Promise<void> {
    const currentTime = await this.getTime();

    // Return early if the last call was too recent.
    if (this.lastUpdateTime !== null && this.lastUpdateTime + this.minTimeBetweenUpdates > currentTime) {
      this.logger.debug({
        at: "TwelveDataApiPriceFeed",
        message: "Update skipped because the last one was too recent",
        currentTime: currentTime,
        lastUpdateTimestamp: this.lastUpdateTime,
        timeRemainingUntilUpdate: this.lastUpdateTime + this.minTimeBetweenUpdates - currentTime,
      });
      return;
    }

    const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const startLookbackWindow = currentTime - this.lookback;
    const startDateTimeString = this._secondToDateTime(startLookbackWindow);
    const endDateTimeString = this._secondToDateTime(currentTime);

    this.logger.debug({
      at: "TwelveDataApiPriceFeed",
      message: "Updating TwelveDataApiPriceFeed",
      currentTime: currentTime,
      lastUpdateTimestamp: this.lastUpdateTime,
      timezone: TIMEZONE,
    });

    // 1. Construct URL.
    // See https://twelvedata.com/docs#getting-started
    // We use current local bot timezone to query and get the result in that timezone.
    // https://api.twelvedata.com/time_series?apikey=API_KEY&interval=15min&timezone=TIMEZONE&order=ASC&symbol=SYMBOL&start_date=START_DATE&end_date=END_DATE;
    const url = `https://api.twelvedata.com/time_series?` +
      `apikey=${this.apiKey}` +
      `&interval=${this.apiQueryInterval}` +
      `&timezone=${TIMEZONE}` +
      `&order=ASC` +
      `&symbol=${this.index}` +
      `&start_date=${startDateTimeString}` +
      `&end_date=${endDateTimeString}`;

    // 2. Send request.
    const historyResponse = await this.networker.getJson(url);

    // Sample Response
    // {
    //   "meta": {
    //   "symbol": "URTH",
    //   "interval": "1h",
    //   "currency": "USD",
    //   "exchange_timezone": "America/New_York",
    //   "exchange": "NYSE",
    //   "mic_code": "ARCX",
    //   "type": "ETF"
    //   },
    //   "values": [
    //   {
    //   "datetime": "2023-02-10 15:30:00",
    //   "open": "116.67000",
    //   "high": "116.93000",
    //   "low": "116.67000",
    //   "close": "116.84000",
    //   "volume": "19274"
    //   },
    //   {
    //   "datetime": "2023-02-10 14:30:00",
    //   "open": "116.45500",
    //   "high": "116.78000",
    //   "low": "116.45000",
    //   "close": "116.64000",
    //   "volume": "145608"
    //   },
    //   .
    //   .
    //   ],
    //   "status": "ok"
    //   }

    // 3. Check responses.
    if (!historyResponse?.values || historyResponse.values.length === 0) {
      throw new Error(`🚨Could not parse price result from url ${url}: ${JSON.stringify(historyResponse)}`);
    }

    // 4. Parse results.
    // historyResponse.values
    const newHistoricalPricePeriods =
      historyResponse.values
        .map((dailyData: any) => {
          return {
            date: this._dateTimeToSecond(dailyData.datetime),
            closePrice: this.convertPriceFeedDecimals(dailyData.close),
          }
        })

    // 5. Store results.
    this.currentPrice = newHistoricalPricePeriods[newHistoricalPricePeriods.length - 1].closePrice;
    this.priceHistory = newHistoricalPricePeriods;
    this.lastUpdateTime = currentTime;

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
      if (this.priceHistory[p] && this.priceHistory[p].date) {
        firstPrice = this.priceHistory[p];
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
      throw new Error(`${this.uuid}: time ${time} is before firstPricePeriod.closeTime`);
    }

    // historicalPricePeriods are ordered from oldest to newest.
    // This finds the first index in pricePeriod whose time is after the provided time.
    const matchedIndex = this.priceHistory.findIndex((pricePeriod) => {
      return time < pricePeriod.date;
    });

    // Then we get the previous element to matchedIndex. Since that would be the last closing price for us.
    let match = undefined;
    if (matchedIndex > 0) {
      match = this.priceHistory[matchedIndex - 1];
    }

    // If there is no match, that means that the time was past the last data point.
    // In this case, the best match for this price is the current price.
    let returnPrice;
    if (match === undefined) {
      if (this.currentPrice === null) throw new Error(`${this.uuid}: currentPrice is null`);
      returnPrice = this.currentPrice;
      if (verbose) {
        console.group(`\n(${this.index}) No price available @ ${time}`);
        console.log(
          `- ✅ Time is later than earliest historical time, fetching current price: ${Web3.utils.fromWei(
            returnPrice.toString()
          )}`
        );
        console.groupEnd();
      }
      return returnPrice;
    }

    returnPrice = match.closePrice;
    if (verbose) {
      console.group(`\n(${this.index}) Historical price @ ${match.date}`);
      console.log(`- ✅ Close Price:${Web3.utils.fromWei(returnPrice.toString())}`);
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
    return moment.unix(inputSecond).format("YYYY-MM-DD HH:mm:ss");
  }
  private _dateTimeToSecond(inputDateTime: string, endOfDay = false) {
    if (endOfDay) {
      return moment(inputDateTime, "YYYY-MM-DD HH:mm:ss").endOf("day").unix();
    } else {
      return moment(inputDateTime, "YYYY-MM-DD HH:mm:ss").unix();
    }
  }
}
