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
   * @param {Boolean} useStLouisLocalTime Uses St Louis local time to avoid timezone issues.

   */
  constructor(
    private readonly logger: Logger,
    private readonly symbolString: String,
    private readonly apiKey: string,
    private readonly lookback: number,
    private readonly networker: NetworkerInterface,
    private readonly getTime: () => Promise<number>,
    private readonly priceFeedDecimals = 18,
    private readonly minTimeBetweenUpdates = 43200, // 12 hours is a reasonable default since this pricefeed returns daily granularity at best.
    private readonly useStLouisLocalTime?: boolean
  ) {
    super();

    this.uuid = `StLouisFedGov-${symbolString}`;

    this.priceHistory = [];

    this.convertPriceFeedDecimals = (number) => {
      return Web3.utils.toBN(parseFixed(number.toString().substring(0, priceFeedDecimals), priceFeedDecimals).toString());
    };
  }
  public getTimestampInTimeZone = (timeZone: string) => {
    const date = new Date();
    const options = {
      timeZone: timeZone,
    };
    const timestamp = date.toLocaleString('en-US', options);
    return Math.round(new Date(timestamp).getTime() / 1000);
  };

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
      message: "Updating StLouisFedGovPriceFeed",
      currentTime: currentTime,
      lastUpdateTimestamp: this.lastUpdateTime
    });

    if (this.useStLouisLocalTime) {
      const stLouisTime = this.getTimestampInTimeZone('America/Chicago');  // St Louis uses America/Chicago timezone.
      this.currentPrice = await this._getHistoricalPrice(stLouisTime);     // use stLouis time to retrieve price.
    }
    else {
      this.currentPrice = await this._getHistoricalPrice(currentTime)
    }
    this.lastUpdateTime = currentTime;  // make sure that the last update time always reflects the bot time in any case.
  }
  public getCurrentPrice(): BN | null {
    return this.currentPrice;
  }

  private async _getHistoricalPrice(time: number): Promise<BN | null> {
    const dataFetchStartTime = time - (60 * 60 * 24 * 60) // good guarantee to get at least 1 data point, assuming monthly data points

    // dataFetchStart gives an "early bound" to our data
    const dataFetchStartString = this._secondToDate(dataFetchStartTime);

    // realtimeEndString is essentially specifying when in history to "look from", i.e. what did the data look like at a specific time?
    // This is because these data can change and be revised. We want to stay true to what operators/users knew at the time.
    // see https://fred.stlouisfed.org/docs/api/fred/realtime_period.html
    const realtimeEndString = this._secondToDate(time);

    // 1. Construct URL.
    // See https://fred.stlouisfed.org/docs/api/fred/
    // https://api.stlouisfed.org/fred/series/observations?series_id=CPIAUCSL&api_key=API_KEY&file_type=json&observation_start=START_DATE&realtime_end=REAL_END_DATE
    const url = `https://api.stlouisfed.org/fred/series/observations?` +
      `&file_type=json` +
      `&api_key=${this.apiKey}` +
      `&series_id=${this.symbolString}` +
      `&observation_start=${dataFetchStartString}` +
      `&realtime_end=${realtimeEndString}`

    // 2. Send request.
    const fetchResponse = await this.networker.getJson(url);

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
    if (
      !(fetchResponse?.observations) ||
      fetchResponse.observations.length === 0
    ) {
      throw new Error(`🚨Could not parse price result from url ${url}: ${JSON.stringify(fetchResponse)}`);
    }

    // 4. Parse results.
    // historyResponse.observations
    const observations = fetchResponse.observations
      .map((observation: any) => ({
        date: this._dateToSecond(observation.date),
        price: this.convertPriceFeedDecimals(observation.value)
      }))
      .sort((a: any, b: any) => {
        return a.date - b.date;
      });

    return observations[observations.length - 1].price;
  }

  public async getHistoricalPrice(time: number, ancillaryData?: string, verbose?: boolean): Promise<BN | null> {
    const returnPrice = this._getHistoricalPrice(time);

    if (!returnPrice) {
      throw new Error(`${this.uuid}: can't get historical data for that time`);
    }

    if (verbose) {
      console.group(`\n(${this.symbolString}) Historical price @ ${time}`);
      console.log(`- ✅ Price:${Web3.utils.fromWei(returnPrice.toString())}`);
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
