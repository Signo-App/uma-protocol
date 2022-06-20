const func = async function (hre) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;

  const { deployer } = await getNamedAccounts();

  const Finder = await deployments.get("Finder");

  const collateralAddress = "0xc778417E063141139Fce010982780140Aa0cD5Ab";
  const bondAmount = 0;
  const rules = "0x7B502C3A1F48C8609AE212CDFB639DEE39673F5E";
  const identifier = "0x5a4f444941430000000000000000000000000000000000000000000000000000";
  const liveness = 7200;

  await deploy("OptimisticGovernor", {
    from: deployer,
    args: [Finder.address, deployer, collateralAddress, bondAmount, rules, identifier, liveness],
    log: true,
    skipIfAlreadyDeployed: false,
  });
};
module.exports = func;
func.tags = ["OptimisticGovernor", "og"];
func.dependencies = ["Finder"];
