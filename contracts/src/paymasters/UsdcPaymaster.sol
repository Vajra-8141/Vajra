// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FramePaymaster} from "./FramePaymaster.sol";
import {Scope} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";

interface IToken {
    function balanceOf(address owner) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// Pays gas in ETH and takes USDC for it, in the same transaction.
///
/// `collect` takes the transaction's maximum cost in USDC before `pay` agrees and before any sponsored code runs, so a body
/// that revokes the approval or empties the account changes nothing: the money has already moved. `settle` then returns the
/// USDC for gas that went unused, at the effective gas price.
///
/// The price is a number the owner sets. It is not an oracle and it does not follow the market, which is what `PRICE_LABEL`
/// says. The sender signs the exact price, in the collect frame's data, so the owner cannot raise it on a transaction already
/// signed. While the price is below the market, every sponsored gas unit is a discount taken from the owner, up to `feeCap`.
contract UsdcPaymaster is FramePaymaster {
    string public constant PRICE_LABEL = "Fixed by the paymaster's owner. Not a market price.";

    IToken public immutable USDC;

    /// USDC units, six decimals, for one ETH.
    uint256 public usdcPerEth;

    event PriceSet(uint256 usdcPerEth);
    event Collected(address indexed account, uint256 usdc, uint256 usdcPerEth);
    event Refunded(address indexed account, uint256 usdc);

    error PriceChanged(uint256 signed, uint256 current);
    error InsufficientUsdc(uint256 balance, uint256 needed);
    error InsufficientAllowance(uint256 allowance, uint256 needed);
    error BadPrice();

    /// The collect frame moves one token balance into a slot that may not exist yet.
    constructor(address owner, address stakingRegistry, uint256 feeCap_, IToken usdc, uint256 usdcPerEth_)
        FramePaymaster(owner, stakingRegistry, feeCap_, 100_000, 100_000)
    {
        USDC = usdc;
        if (usdcPerEth_ == 0) revert BadPrice();
        usdcPerEth = usdcPerEth_;
    }

    function setPrice(uint256 usdcPerEth_) external onlyOwner {
        if (usdcPerEth_ == 0) revert BadPrice();
        usdcPerEth = usdcPerEth_;
        emit PriceSet(usdcPerEth_);
    }

    function withdrawUsdc(address to, uint256 amount) external onlyOwner {
        if (!USDC.transfer(to, amount)) revert TransferFailed();
    }

    /// Rounded up, so the paymaster never sells a fraction of a unit short.
    function quote(uint256 weiAmount, uint256 price) public pure returns (uint256) {
        return (weiAmount * price + 1e18 - 1) / 1e18;
    }

    /// The `pre_verify` frame, carrying the price the sender signed. The two reads are there to say why, by name.
    function collect(uint256 signedPrice) external onlyFrame {
        _requireChargeFrame();
        if (signedPrice != usdcPerEth) revert PriceChanged(signedPrice, usdcPerEth);
        address account = _sender();
        uint256 amount = quote(_maxCost(), signedPrice);
        uint256 balance = USDC.balanceOf(account);
        if (balance < amount) revert InsufficientUsdc(balance, amount);
        uint256 allowed = USDC.allowance(account, address(this));
        if (allowed < amount) revert InsufficientAllowance(allowed, amount);
        if (!USDC.transferFrom(account, address(this), amount)) revert TransferFailed();
        emit Collected(account, amount, signedPrice);
    }

    /// The `pay` frame.
    function pay() external override {
        uint256 frame = _requireSponsorable(this.collect.selector);
        if (!_charged(frame)) revert ChargeFrameFailed();
        approve(Scope.PAYMENT);
    }

    /// The last frame: back goes what was collected less the gas owed, at the price the sender signed and the price gas really
    /// cost. Both figures are worked out from the transaction, so nothing had to be stored. `_refundableGas` is what makes the
    /// collected figure true: it holds only for a collect that stood, followed by a `pay` that ran.
    function settle(uint256 frame) external override onlyFrame {
        uint256 back = _refundableGas(frame, this.collect.selector);
        uint256 signedPrice = uint256(framedataload(4, frame));
        uint256 collected = quote(_maxCost(), signedPrice);
        uint256 owed = quote((_maxGas() - back) * tx.gasprice, signedPrice);
        if (owed >= collected) return;
        address account = _sender();
        if (!USDC.transfer(account, collected - owed)) revert TransferFailed();
        emit Refunded(account, collected - owed);
    }
}
