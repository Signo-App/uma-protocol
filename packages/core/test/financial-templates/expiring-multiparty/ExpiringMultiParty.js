const hre = require("hardhat");
const { runDefaultFixture } = require("@uma/common");
const { getContract } = hre;
const { ZERO_ADDRESS } = require("@uma/common");
const { toWei, padRight, utf8ToHex } = web3.utils;

// Tested Contract
const ExpiringMultiParty = getContract("ExpiringMultiParty");

// Helper Contracts
const Finder = getContract("Finder");
const IdentifierWhitelist = getContract("IdentifierWhitelist");
const Token = getContract("ExpandedERC20");

describe("ExpiringMultiParty", function () {
  let finder;
  let accounts;

  before(async () => {
    // Accounts.
    accounts = await web3.eth.getAccounts();
    await runDefaultFixture(hre);
    finder = await Finder.deployed();
  });

  it("Can deploy", async function () {
    const collateralToken = await Token.new("Wrapped Ether", "WETH", 18).send({ from: accounts[0] });
    const syntheticToken = await Token.new("Test Synthetic Token", "SYNTH", 18).send({ from: accounts[0] });
    const currentTime = Number((await hre.ethers.provider.getBlock("latest")).timestamp);

    const constructorParams = {
      expirationTimestamp: (currentTime + 1000).toString(),
      withdrawalLiveness: "1000",
      collateralAddress: collateralToken.options.address,
      tokenAddress: syntheticToken.options.address,
      finderAddress: finder.options.address,
      priceFeedIdentifier: padRight(utf8ToHex("TEST_IDENTIFIER"), 64),
      liquidationLiveness: "1000",
      collateralRequirement: { rawValue: toWei("1.5") },
      disputeBondPercentage: { rawValue: toWei("0.1") },
      sponsorDisputeRewardPercentage: { rawValue: toWei("0.1") },
      disputerDisputeRewardPercentage: { rawValue: toWei("0.1") },
      minSponsorTokens: { rawValue: toWei("1") },
      owner: accounts[0],
      financialProductLibraryAddress: ZERO_ADDRESS,
      ooReward: { rawValue: hre.ethers.utils.parseUnits("100", "6") },
      ancillaryData: "0x73796e746849443a20226e6c687069222c20713a20436f6e766572742070726963652072657175657374",
    };

    const identifierWhitelist = await IdentifierWhitelist.deployed();
    await identifierWhitelist.methods
      .addSupportedIdentifier(constructorParams.priceFeedIdentifier)
      .send({ from: accounts[0] });

    await ExpiringMultiParty.new(constructorParams).send({ from: accounts[0] });
  });
});
