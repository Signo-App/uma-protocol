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
  private priceHistory: { date: number; value: BN }[];
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
      return Web3.utils.toBN(parseFixed(number.toString().substring(0, priceFeedDecimals), priceFeedDecimals).toString());
    };
  }

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

    // start date is 60 days in the past, this is done to ensure we get a value for CPI
    const startLookbackWindow = currentTime - this.lookback;
    const startDateString = this._secondToDate(startLookbackWindow);

    this.logger.debug({
      at: "StLouisFedGovPriceFeed",
      message: "Updating StLouisFedGovPriceFeed",
      currentTime: currentTime,
      lastUpdateTimestamp: this.lastUpdateTime
    });

    // 1. Construct URL.
    // See https://fred.stlouisfed.org/docs/api/fred/
    // https://api.stlouisfed.org/fred/series/observations?series_id=CPIAUCSL&api_key=API_KEY&file_type=json&observation_start=START_DATE
    const url = `https://api.stlouisfed.org/fred/series/observations?` +
      `&file_type=json` +
      `&api_key=${this.apiKey}` +
      `&series_id=${this.symbolString}` +
      `&observation_start=${startDateString}`;

    // 2. Send request.
    const historyResponse = await this.networker.getJson(url);

    // Sample Response
    // {
    //   "realtime_start": "2023-02-23",
    //   "realtime_end": "2023-02-23",
    //   "observation_start": "2022-10-24",
    //   "observation_end": "9999-12-31",
    //   "units": "lin",
    //   "output_type": 1,
    //   "file_type": "json",
    //   "order_by": "observation_date",
    //   "sort_order": "asc",
    //   "count": 4,
    //   "offset": 0,
    //   "limit": 100000,
    //   "observations": [
    //   {
    //   "realtime_start": "2023-02-23",
    //   "realtime_end": "2023-02-23",
    //   "date": "2022-10-01",
    //   "value": "297.987"
    //   },
    // ...
    //   {
    //   "realtime_start": "2023-02-23",
    //   "realtime_end": "2023-02-23",
    //   "date": "2023-01-01",
    //   "value": "300.536"
    //   }
    //   ]
    //   }

    // 3. Check responses.
    if (!historyResponse?.observations || historyResponse.observations.length === 0) {
      throw new Error(`🚨Could not parse price result from url ${url}: ${JSON.stringify(historyResponse)}`);
    }

    // 4. Parse results.
    // historyResponse.observations
    const newHistoricalPricePeriods =
      historyResponse.observations
        .map((dailyData: any) => {
          return {
            date: this._dateToSecond(dailyData.date),
            value: this.convertPriceFeedDecimals(dailyData.value),
          }
        })

    console.log("DEBUG: USCPI: newHistoricalPricePeriods", newHistoricalPricePeriods);

    // 5. Store results.
    this.currentPrice = newHistoricalPricePeriods[newHistoricalPricePeriods.length - 1].value;
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
    // This finds the first index in pricePeriod whose time is before the provided time.
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
        console.group(`\n(${this.symbolString}) No price available @ ${time}`);
        console.log(
          `- ✅ Time is later than earliest historical time, fetching current price: ${Web3.utils.fromWei(
            returnPrice.toString()
          )}`
        );
        console.groupEnd();
      }
      return returnPrice;
    }

    returnPrice = match.value;
    if (verbose) {
      console.group(`\n(${this.symbolString}) Historical price @ ${match.date}`);
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

  private _secondToDate(inputSecond: number) {
    return moment.unix(inputSecond).format("YYYY-MM-DD");
  }
  private _dateToSecond(inputDateTime: string, endOfDay = false) {
    if (endOfDay) {
      return moment(inputDateTime, "YYYY-MM-DD").endOf("day").unix();
    } else {
      return moment(inputDateTime, "YYYY-MM-DD").unix();
    }
  }
}
