// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../common/implementation/FixedPoint.sol";
import "../common/implementation/AddressWhitelist.sol";
import "../common/implementation/Testable.sol";
import "../common/implementation/Lockable.sol";

import "../oracle/interfaces/FinderInterface.sol";
import "../oracle/interfaces/IdentifierWhitelistInterface.sol";
import "../oracle/interfaces/OptimisticOracleInterface.sol";
import "../oracle/implementation/ContractCreator.sol";

/**
 * @title Optimistic DEX
 * @notice This is the future.
 */
contract OptimisticDex is Testable, Lockable {
    using SafeMath for uint256;
    using FixedPoint for FixedPoint.Unsigned;
    using SafeERC20 for IERC20;

    // Represents a single caller's deposit box. All collateral is held by this contract.
    struct OptimisticDexData {
        address fillToken;
        uint256 fillRequestAmount;
        uint8 chainId;
        // Timestamp of the latest withdrawal request. A withdrawal request is pending if `withdrawalRequestTimestamp != 0`.
        uint256 withdrawalRequestTimestamp;
        // Collateral value.
        uint256 collateral;
    }

    // Maps addresses to their deposit boxes. Each address can have only one position.
    mapping(address => OptimisticDexData) private fillRequests;

    // Unique identifier for price feed ticker.
    bytes32 private priceIdentifier;

    // Finder for UMA contracts.
    FinderInterface finder;

    // The collateral currency used to back the positions in this contract.
    IERC20 public collateralCurrency;

    // Total collateral of all depositors.
    uint256 public totalOptimisticDexCollateral;

    /****************************************
     *                EVENTS                *
     ****************************************/

    event NewOptimisticDex(address indexed user);
    event EndedOptimisticDex(address indexed user);
    event Deposit(
        address indexed user,
        uint256 indexed collateralAmount,
        address indexed fillToken,
        uint256 fillAmount,
        uint8 chainId
    );
    event RequestWithdrawal(address indexed user, uint256 indexed collateralAmount, uint256 withdrawalRequestTimestamp);
    event RequestWithdrawalExecuted(
        address indexed user,
        uint256 indexed collateralAmount,
        uint256 exchangeRate,
        uint256 withdrawalRequestTimestamp
    );
    event RequestWithdrawalCanceled(
        address indexed user,
        uint256 indexed collateralAmount,
        uint256 withdrawalRequestTimestamp
    );

    /****************************************
     *               MODIFIERS              *
     ****************************************/

    modifier noPendingWithdrawal(address user) {
        _fillRequestHasNoPendingWithdrawal(user);
        _;
    }

    /****************************************
     *           PUBLIC FUNCTIONS           *
     ****************************************/

    /**
     * @notice Construct the OptimisticDex.
     * @param _collateralAddress ERC20 token to be deposited.
     * @param _finderAddress UMA protocol Finder used to discover other protocol contracts.
     * @param _priceIdentifier registered in the DVM, used to price the ERC20 deposited.
     * The price identifier consists of a "base" asset and a "quote" asset. The "base" asset corresponds
     * to the collateral ERC20 currency deposited into this account, and it is denominated in the "quote"
     * asset on withdrawals.
     * An example price identifier would be "ETH/USD" which will resolve and return the USD price of ETH.
     * @param _timerAddress contract that stores the current time in a testing environment.
     * Must be set to 0x0 for production environments that use live time.
     */
    constructor(
        address _collateralAddress,
        address _finderAddress,
        bytes32 _priceIdentifier,
        address _timerAddress
    ) nonReentrant() Testable(_timerAddress) {
        finder = FinderInterface(_finderAddress);
        require(_getIdentifierWhitelist().isIdentifierSupported(_priceIdentifier), "Unsupported price identifier");
        require(_getAddressWhitelist().isOnWhitelist(_collateralAddress), "Unsupported collateral type");
        collateralCurrency = IERC20(_collateralAddress);
        priceIdentifier = _priceIdentifier;
    }

    /**
     * @notice Transfers `collateralAmount` of `collateralCurrency` into caller's deposit box.
     * @dev This contract must be approved to spend at least `collateralAmount` of `collateralCurrency`.
     * @param collateralAmount total amount of collateral tokens to be sent to the sponsor's position.
     */
    function deposit(
        uint256 collateralAmount,
        address fillToken,
        uint256 fillRequestAmount,
        uint8 chainId
    ) public nonReentrant() {
        require(collateralAmount > 0, "Invalid collateral amount");
        OptimisticDexData storage fillRequestData = fillRequests[msg.sender];
        if (fillRequestData.collateral == 0) {
            emit NewOptimisticDex(msg.sender);
        }

        // Increase the individual deposit box and global collateral balance by collateral amount.
        fillRequestData.collateral = fillRequestData.collateral.add(collateralAmount);
        totalOptimisticDexCollateral = totalOptimisticDexCollateral.add(collateralAmount);

        // Set more fill request fields.
        fillRequestData.fillToken = fillToken;
        fillRequestData.fillRequestAmount = fillRequestAmount;
        fillRequestData.chainId = chainId;

        emit Deposit(msg.sender, collateralAmount, fillToken, fillRequestAmount, chainId);

        // Move collateral currency from sender to contract.
        collateralCurrency.safeTransferFrom(msg.sender, address(this), collateralAmount);
    }

    /**
     * @notice Starts a withdrawal request that allows the sponsor to withdraw `denominatedCollateralAmount`
     * from their position denominated in the quote asset of the price identifier, following a Optimistic
     * Oracle price resolution.
     * @dev The request will be pending for the duration of the liveness period and can be cancelled at any
     * time. Only one withdrawal request can exist for the user.
     * @param denominatedCollateralAmount the quote-asset denominated amount of collateral requested to
     * withdraw.
     */
    function requestWithdrawal(uint256 denominatedCollateralAmount)
        public
        noPendingWithdrawal(msg.sender)
        nonReentrant()
    {
        OptimisticDexData storage fillRequestData = fillRequests[msg.sender];
        require(denominatedCollateralAmount > 0, "Invalid collateral amount");

        // Update the position data for the user.
        fillRequestData.fillRequestAmount = denominatedCollateralAmount;
        fillRequestData.withdrawalRequestTimestamp = getCurrentTime();

        emit RequestWithdrawal(msg.sender, denominatedCollateralAmount, fillRequestData.withdrawalRequestTimestamp);

        // A price request is sent for the current timestamp.
        _requestOraclePrice(fillRequestData.withdrawalRequestTimestamp);
    }

    /**
     * @notice After a withdrawal request (i.e., by a call to `requestWithdrawal`) and optimistic oracle
     * price resolution, withdraws `fillRequestData.fillRequestAmount` of collateral currency
     * denominated in the quote asset.
     * @dev Might not withdraw the full requested amount in order to account for precision loss.
     * @return amountWithdrawn The actual amount of collateral withdrawn.
     */
    function executeWithdrawal() external nonReentrant() returns (uint256 amountWithdrawn) {
        OptimisticDexData storage fillRequestData = fillRequests[msg.sender];
        require(
            fillRequestData.withdrawalRequestTimestamp != 0 &&
                fillRequestData.withdrawalRequestTimestamp <= getCurrentTime(),
            "Invalid withdraw request"
        );

        // Get the resolved price or revert.
        // Note that in practice, you may have to do some additional math here to deal with scaling in the oracle price.
        uint256 exchangeRate = _getOraclePrice(fillRequestData.withdrawalRequestTimestamp);

        // Calculate denomated amount of collateral based on resolved exchange rate.
        // Example 1: User wants to withdraw $1000 of ETH, exchange rate is $2000/ETH, therefore user to receive 0.5 ETH.
        // Example 2: User wants to withdraw $2500 of ETH, exchange rate is $2000/ETH, therefore user to receive 1.25 ETH.
        uint256 denominatedAmountToWithdraw =
            FixedPoint.Unsigned(fillRequestData.fillRequestAmount).div(FixedPoint.Unsigned(exchangeRate)).rawValue;

        // If withdrawal request amount is > collateral, then withdraw the full collateral amount.
        if (denominatedAmountToWithdraw >= fillRequestData.collateral) {
            denominatedAmountToWithdraw = fillRequestData.collateral;
            emit EndedOptimisticDex(msg.sender);
        }

        // Decrease the individual deposit box and global collateral balance.
        fillRequestData.collateral = fillRequestData.collateral.sub(denominatedAmountToWithdraw);
        totalOptimisticDexCollateral = totalOptimisticDexCollateral.sub(denominatedAmountToWithdraw);

        emit RequestWithdrawalExecuted(
            msg.sender,
            denominatedAmountToWithdraw,
            exchangeRate,
            fillRequestData.withdrawalRequestTimestamp
        );

        // Reset withdrawal request by setting withdrawal request timestamp to 0.
        _resetWithdrawalRequest(fillRequestData);

        // Transfer approved withdrawal amount from the contract to the caller.
        collateralCurrency.safeTransfer(msg.sender, denominatedAmountToWithdraw);
        return denominatedAmountToWithdraw;
    }

    /**
     * @notice Cancels a pending withdrawal request.
     */
    function cancelWithdrawal() external nonReentrant() {
        OptimisticDexData storage fillRequestData = fillRequests[msg.sender];
        require(fillRequestData.withdrawalRequestTimestamp != 0, "No pending withdrawal");

        emit RequestWithdrawalCanceled(
            msg.sender,
            fillRequestData.fillRequestAmount,
            fillRequestData.withdrawalRequestTimestamp
        );

        // Reset withdrawal request by setting withdrawal request timestamp and withdrawal amount to 0.
        _resetWithdrawalRequest(fillRequestData);
    }

    /**
     * @notice Accessor method for a user's collateral.
     * @param user address whose collateral amount is retrieved.
     * @return the collateral amount in the deposit box (i.e. available for withdrawal).
     */
    function getCollateral(address user) external view nonReentrantView() returns (uint256) {
        return fillRequests[user].collateral;
    }

    /****************************************
     *          INTERNAL FUNCTIONS          *
     ****************************************/

    // Requests a price for `priceIdentifier` at `requestedTime` from the Optimistic Oracle.
    function _requestOraclePrice(uint256 requestedTime) internal {
        OptimisticOracleInterface oracle = _getOptimisticOracle();
        // For other use cases, you may need ancillary data or a reward. Here, they are both zero.
        oracle.requestPrice(priceIdentifier, requestedTime, "", IERC20(collateralCurrency), 0);
    }

    function _resetWithdrawalRequest(OptimisticDexData storage fillRequestData) internal {
        fillRequestData.fillRequestAmount = 0;
        fillRequestData.withdrawalRequestTimestamp = 0;
    }

    function _fillRequestHasNoPendingWithdrawal(address user) internal view {
        require(fillRequests[user].withdrawalRequestTimestamp == 0, "Pending withdrawal");
    }

    function _getOptimisticOracle() internal view returns (OptimisticOracleInterface) {
        return OptimisticOracleInterface(finder.getImplementationAddress(OracleInterfaces.OptimisticOracle));
    }

    function _getIdentifierWhitelist() internal view returns (IdentifierWhitelistInterface) {
        return IdentifierWhitelistInterface(finder.getImplementationAddress(OracleInterfaces.IdentifierWhitelist));
    }

    function _getAddressWhitelist() internal view returns (AddressWhitelist) {
        return AddressWhitelist(finder.getImplementationAddress(OracleInterfaces.CollateralWhitelist));
    }

    // Fetches a resolved oracle price from the Optimistic Oracle. Reverts if the oracle hasn't resolved for this request.
    function _getOraclePrice(uint256 withdrawalRequestTimestamp) internal returns (uint256) {
        OptimisticOracleInterface oracle = _getOptimisticOracle();
        require(
            oracle.hasPrice(address(this), priceIdentifier, withdrawalRequestTimestamp, ""),
            "Unresolved oracle price"
        );
        int256 oraclePrice = oracle.settleAndGetPrice(priceIdentifier, withdrawalRequestTimestamp, "");

        // For simplicity we don't want to deal with negative prices.
        if (oraclePrice < 0) {
            oraclePrice = 0;
        }
        return uint256(oraclePrice);
    }
}
