import { BN } from "../types";
import { parseFixed } from "@uma/common";
import moment from "moment";
import type { Logger } from "winston";
import { NetworkerInterface } from "./Networker";
import { PriceFeedInterface } from "./PriceFeedInterface";
import Web3 from "web3";

export class HmLandRegistryPriceFeed extends PriceFeedInterface {
  private readonly uuid: string;
  private readonly convertPriceFeedDecimals: (number: number | string | BN) => BN;
  private priceHistory: { date: number; value: BN }[];
  private currentPrice: BN | null = null;
  private lastUpdateTime: number | null = null;

  /**
   * @notice Constructs the HmLandRegistryPriceFeed.
   * @param {Object} logger Winston module used to send logs.
   * @param {String} index String used to identify the synth data that is being fetched from Hm Land Registry API i.e. "UKHPI"
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
    private readonly lookback: number, // lookback must be at least 120 days for UKHPI
    private readonly networker: NetworkerInterface,
    private readonly getTime: () => Promise<number>,
    private readonly priceFeedDecimals = 18,
    private readonly minTimeBetweenUpdates = 900 // 15 mins is a reasonable default since this API uses an interval of 15min
  ) {
    super();

    this.uuid = `HmLandRegistry-${index}`;

    this.priceHistory = [];

    this.convertPriceFeedDecimals = (number) => {
      return Web3.utils.toBN(
        parseFixed(number.toString().substring(0, priceFeedDecimals), priceFeedDecimals).toString());
    };
  }
  public async update(): Promise<void> {
    const currentTime = await this.getTime();

    // Return early if the last call was too recent.
    if (this.lastUpdateTime !== null && this.lastUpdateTime + this.minTimeBetweenUpdates > currentTime) {
      this.logger.debug({
        at: "HmLandRegistryPriceFeed",
        message: "Update skipped because the last one was too recent",
        currentTime: currentTime,
        lastUpdateTimestamp: this.lastUpdateTime,
        timeRemainingUntilUpdate: this.lastUpdateTime + this.minTimeBetweenUpdates - currentTime,
      });
      return;
    }

    const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const endDateTime = currentTime;
    const startLookbackWindow = endDateTime - this.lookback;

    const endDateTimeString = this._secondToDate(currentTime);
    const startDateTimeString = this._secondToDate(startLookbackWindow);
    console.log("endDateTimeString", endDateTimeString);

    this.logger.debug({
      at: "HmLandRegistryPriceFeed",
      message: "Updating HmLandRegistryPriceFeed",
      currentTime: currentTime,
      lastUpdateTimestamp: this.lastUpdateTime,
      timezone: TIMEZONE,
    });

    // 1. Construct URL & SPARQL query.
    
    const url = "http://landregistry.data.gov.uk/landregistry/query";
    
    const sparqlQuery = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX sr: <http://data.ordnancesurvey.co.uk/ontology/spatialrelations/>
PREFIX ukhpi: <http://landregistry.data.gov.uk/def/ukhpi/>
PREFIX lrppi: <http://landregistry.data.gov.uk/def/ppi/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>

# House price index for a specific region within a given date range
SELECT ?region ?date ?hpi
{
  ?obs ukhpi:refRegion ?region ;
       ukhpi:refPeriodStart ?date ;
       ukhpi:housePriceIndex ?hpi .

  FILTER (
    ?date > "${startDateTimeString}"^^xsd:date &&
    ?date <= "${endDateTimeString}"^^xsd:date
  )

  FILTER (?region = <http://landregistry.data.gov.uk/id/region/united-kingdom>)
}
ORDER BY ASC(?date)
`;

    const params = `query=${encodeURIComponent(sparqlQuery)}&output=json`;

    // 2. Send request.
    const historyResponse = await this.networker.getJson(`${url}?${params}`);
    console.log("historyResponse", historyResponse);
    // Sample Response
    // {
    //    "head": {
    //      "vars": [ "region" , "date" , "hpi" ]
    //     } ,
    //      "results": {
    //        "bindings": [
    //          {
    //            "region": { "type": "uri" , "value": "http://landregistry.data.gov.uk/id/region/united-kingdom" } ,
    //            "date": { "type": "literal" , "datatype": "http://www.w3.org/2001/XMLSchema#date" , "value": "2023-02-01" } ,
    //            "hpi": { "type": "literal" , "datatype": "http://www.w3.org/2001/XMLSchema#decimal" , "value": "150.79" }
    //          }
    //        ]
    //      }
    //    }


    // 3. Check responses.
    if (!historyResponse?.results.bindings || historyResponse.results.bindings.length === 0) {
      throw new Error(`🚨Could not parse price result from url ${url}: ${JSON.stringify(historyResponse)}`);
    }

    // 4. Parse results.
    // historyResponse.results
    const newHistoricalPricePeriods =
      historyResponse.results.bindings
        .map((dailyData: any) => {
          return {
            date: this._dateTimeToSecond(dailyData.date.value),
            value: this.convertPriceFeedDecimals(dailyData.hpi.value),
          }
        });

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
    console.log("first price:", firstPrice);

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

    returnPrice = match.value;
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

  private _secondToDate(inputSecond: number) {
    return moment.unix(inputSecond).format("YYYY-MM-DD");
  }
  private _dateTimeToSecond(inputDateTime: string, endOfDay = false) {
    if (endOfDay) {
      return moment(inputDateTime, "YYYY-MM-DD HH:mm:ss").endOf("day").unix();
    } else {
      return moment(inputDateTime, "YYYY-MM-DD HH:mm:ss").unix();
    }
  }
}