const { task, types } = require("hardhat/config");

const _whitelistIdentifier = async (web3, identifierUtf8, identifierWhitelist, deployer) => {
  const { padRight, utf8ToHex } = web3.utils;
  const identifierBytes = padRight(utf8ToHex(identifierUtf8), 64);
  if (!(await identifierWhitelist.methods.isIdentifierSupported(identifierBytes).call())) {
    const txn = await identifierWhitelist.methods.addSupportedIdentifier(identifierBytes).send({ from: deployer });
    console.log(`Whitelisted new identifier: ${identifierUtf8}, tx: ${txn.transactionHash}`);
  } else {
    console.log(`${identifierUtf8} is already approved.`);
  }
};

task("whitelist-identifiers", "Whitelist identifiers from JSON file")
  .addParam("id", "Custom identifier to whitelist", "Test Identifier", types.string)
  .setAction(async function (taskArguments, hre) {
    const { deployments, getNamedAccounts, web3 } = hre;
    const { deployer } = await getNamedAccounts();
    const { id } = taskArguments;

    const IdentifierWhitelist = await deployments.get("IdentifierWhitelist");
    const identifierWhitelist = new web3.eth.Contract(IdentifierWhitelist.abi, IdentifierWhitelist.address);
    console.log(`Using IdentifierWhitelist @ ${identifierWhitelist.options.address}`);

    await _whitelistIdentifier(web3, id, identifierWhitelist, deployer);
  });

task("migrate-identifiers", "Adds all whitelisted identifiers on one IdentifierWhitelist to another")
  .addParam("from", "The contract from which to query a whitelist of identifiers.", "", types.string)
  .addOptionalParam("to", "The contract on which to whitelist new identifiers.", "", types.string)
  .setAction(async function (taskArguments, hre) {
    const { deployments, getNamedAccounts, web3 } = hre;
    const { deployer } = await getNamedAccounts();
    const { from, to } = taskArguments;

    const IdentifierWhitelist = await deployments.get("IdentifierWhitelist");
    const oldWhitelist = new web3.eth.Contract(IdentifierWhitelist.abi, from);

    const identifiersToWhitelist = []
    const addedIdentifierEvents = await oldWhitelist.getPastEvents("SupportedIdentifierAdded", { fromBlock: 0 });
    
    // Filter out identifiers that are not currently whitelisted.
    let isIdentifierSupportedPromises = []
    addedIdentifierEvents.forEach(_event => {
      isIdentifierSupportedPromises.push(
        oldWhitelist.methods.isIdentifierSupported(_event.returnValues.identifier).call()
      )
    })
    let isIdentifierSupportedResults = await Promise.all(isIdentifierSupportedPromises)
    isIdentifierSupportedResults.forEach((supported, i) => {
      if (supported) {
        identifiersToWhitelist.push(addedIdentifierEvents[i].returnValues.identifier)
      }
    })

    // Create table with results to display to user:
    let resultsTable = identifiersToWhitelist.map(id => {
      return {
        identifierToWhitelist: id, 
        utf8: web3.utils.hexToUtf8(id)
      }
    })
    
    if (to) {
      const newWhitelist = new web3.eth.Contract(IdentifierWhitelist.abi, to);
      isIdentifierSupportedPromises = []
      addedIdentifierEvents.forEach(_event => {
        isIdentifierSupportedPromises.push(
          newWhitelist.methods.isIdentifierSupported(_event.returnValues.identifier).call()
        )
      })
      isIdentifierSupportedResults = await Promise.all(isIdentifierSupportedPromises)
      const addSupportedIdentifierReceipts = []
      
      // Send transactions sequentially to avoid nonce collisions. Note that this might fail due to timeout if there
      // are a lot of transactions to send or the gas price to send with is too low.
      for (let i = 0; i < isIdentifierSupportedResults.length; i++) {
        if (!isIdentifierSupportedResults[i]) {
          const receipt = await newWhitelist.methods.addSupportedIdentifier(addedIdentifierEvents[i].returnValues.identifier).send({
            from: deployer
          })
          addSupportedIdentifierReceipts.push(receipt)
        }
      }
      addSupportedIdentifierReceipts.forEach((receipt, i) => {
        resultsTable[i] = { ...resultsTable[i], txn: receipt.transactionHash}
      })
    }

    console.group("Identifiers to Whitelist")
    console.table(resultsTable)
    console.groupEnd();
  })