import { BN } from "../types";
import { parseFixed } from "@uma/common";
import moment from "moment";
import type { Logger } from "winston";
import { NetworkerInterface } from "./Networker";
import { PriceFeedInterface } from "./PriceFeedInterface";
import Web3 from "web3";

export class StatisticsNetherlandsPriceFeed extends PriceFeedInterface {
  private readonly uuid: string;
  private readonly convertPriceFeedDecimals: (number: number | string | BN) => BN;
  private priceHistory: { date: number; value: BN }[];
  private currentPrice: BN | null = null;
  private lastUpdateTime: number | null = null;

  /**
   * @notice Constructs the StatisticsNetherlandsPriceFeed.
   * @param {Object} logger Winston module used to send logs.
   * @param {String} symbolString String used in query to fetch data, i.e. "NLHPI"
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
    private readonly lookback: number,
    private readonly networker: NetworkerInterface,
    private readonly getTime: () => Promise<number>,
    private readonly priceFeedDecimals = 18,
    private readonly minTimeBetweenUpdates = 900 // Updated every 15 minutes
  ) {
    super();

    this.uuid = `StatisticsNetherlands-${symbolString}`;

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
        at: "StatisticsNetherlandsPriceFeed",
        message: "Update skipped because the last one was too recent",
        currentTime: currentTime,
        lastUpdateTimestamp: this.lastUpdateTime,
        timeRemainingUntilUpdate: this.lastUpdateTime + this.minTimeBetweenUpdates - currentTime,
      });
      return;
    }

    this.logger.debug({
      at: "StatisticsNetherlandsPriceFeed",
      message: "Updating StatisticsNetherlandsPriceFeed",
      currentTime: currentTime,
      lastUpdateTimestamp: this.lastUpdateTime
    });

    this.currentPrice = await this._getHistoricalPrice(currentTime);
    this.lastUpdateTime = currentTime;
  }

  public getCurrentPrice(): BN | null {
    return this.currentPrice;
  }

  private async fetchFormattedStartDate(startDate: Date): Promise<string> {
    const startYear = startDate.getFullYear().toString();
    const startMonth = ('0' + (startDate.getMonth() + 1)).slice(-2); // add leading zero if month is less than 10
    const formattedStartDateString = startYear + 'MM' + startMonth;
    return formattedStartDateString;
  }

  private async _getHistoricalPrice(time: number): Promise<BN | null> {
   try{ 
    const dataFetchStartTime = time - (60 * 60 * 24 * 60) // good guarantee to get at least 1 data point, assuming monthly data points

    // dataFetchStart gives an "early bound" to our data
    const dataFetchStartString = this._secondToDate(dataFetchStartTime);
    
    // dataFetchStart gives an "early bound" to our data
    const startDateString = await this.fetchFormattedStartDate(dataFetchStartString);
    console.log(startDateString);


    // 1. Construct URL.
    // https://opendata.cbs.nl/ODataApi/odata/83906ENG/UntypedDataSet?$filter=Periods%20eq%20%27YYYYmmMM%27
    const url = `https://opendata.cbs.nl/ODataApi/odata/83906ENG/UntypedDataSet?` + 
                `$filter=Periods%20ge%20%27${startDateString}%27`;
    console.log(url);

    // 2. Send request.
    const fetchResponse = await this.networker.getJson(url);

    // Sample Response
    // {
    //
    //   }

    // 3. Check responses.
    if (
      !(fetchResponse?.value) ||
      fetchResponse.value.length === 0
    ) {
      throw new Error(`🚨Could not parse price result from url ${url}: ${JSON.stringify(fetchResponse)}`);
    }

    // 4. Parse results.
    // historyResponse.values
    const values = fetchResponse.value
    .map((value: any) => ({
      date: value.Periods,
      price: this.convertPriceFeedDecimals(value.PriceIndexOfExistingOwnHomes_1)
    }))

      let mostRecentValue = null;
        for (const value of values) {
            if (mostRecentValue === null || value['ID'] > mostRecentValue['ID']) {
                mostRecentValue = value;
            }
        }

      return mostRecentValue.price;
    } catch (error) {
      console.error(error);
      return null;
    }
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
