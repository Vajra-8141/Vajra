// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FramePaymaster} from "./FramePaymaster.sol";
import {Scope} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";

/// Pays gas for enrolled accounts, up to a daily quota for each, in gas.
///
/// The quota lives in this contract's storage and is read during validation, so the canonical mempool refuses every
/// transaction this sponsors. The alt mempool admits them because this contract is staked.
///
/// `charge` adds the transaction's whole `max_gas` to the day's total before `pay` reads it, so two transactions in one block
/// cannot both pass on the same remaining quota, and what a transaction really costs cannot exceed what was counted.
/// `settle` gives back what went unused. The most an account can cost this contract in a day is its quota at `feeCap`.
///
/// `TIMESTAMP` is banned in validation, so `day` is kept in storage and moved by `settle`, or by anyone calling `roll`. If
/// nobody has, an account sees yesterday's total: it gets less than its quota for a while, never more. The windows are fixed,
/// so across a boundary an account can use a quota on each side of it.
contract QuotaPaymaster is FramePaymaster {
    struct Allowance {
        uint64 quota;
        uint64 day;
        uint128 used;
    }

    /// Seconds in a day, here. Set short only to watch a reset happen.
    uint256 public immutable WINDOW;

    uint64 public day;
    mapping(address => Allowance) public allowanceOf;

    event Enrolled(address indexed account, uint64 dailyGas);
    event Charged(address indexed account, uint64 indexed day, uint256 gas);
    event Settled(address indexed account, uint256 gasReturned);

    error NotEnrolled(address account);
    error OverQuota(address account, uint256 used, uint256 quota);

    /// The charge frame touches one slot, which `enroll` has already created, so it needs no state gas.
    constructor(address owner, address stakingRegistry, uint256 feeCap_, uint256 window)
        FramePaymaster(owner, stakingRegistry, feeCap_, 36_000, 0)
    {
        WINDOW = window;
        day = uint64(block.timestamp / window);
    }

    /// A quota of zero removes the account.
    function enroll(address account, uint64 dailyGas) external onlyOwner {
        allowanceOf[account].quota = dailyGas;
        emit Enrolled(account, dailyGas);
    }

    /// Anyone may call this. It can only ever move `day` to the real one.
    function roll() public {
        uint64 today = uint64(block.timestamp / WINDOW);
        if (today > day) day = today;
    }

    /// The `pre_verify` frame. It adds to the total without judging it: `pay` reads the result, and if `pay` reverts, this is
    /// undone with the rest of the transaction.
    function charge() external onlyFrame {
        _requireChargeGas();
        address account = _sender();
        Allowance storage allowance = allowanceOf[account];
        if (allowance.quota == 0) revert NotEnrolled(account);
        uint64 today = day;
        if (allowance.day != today) {
            allowance.day = today;
            allowance.used = 0;
        }
        uint256 gas = _maxGas();
        allowance.used += uint128(gas);
        emit Charged(account, today, gas);
    }

    /// The `pay` frame.
    function pay() external {
        uint256 frame = _requireSponsorable(this.charge.selector);
        address account = _sender();
        Allowance memory allowance = allowanceOf[account];
        if (allowance.used > allowance.quota) revert OverQuota(account, allowance.used, allowance.quota);
        if (!_charged(frame)) revert ChargeFrameFailed();
        approve(Scope.PAYMENT);
    }

    /// The last frame. A transaction has one last frame and runs once, so nothing can be settled twice.
    function settle(uint256 frame) external override onlyFrame {
        uint256 back = _refundableGas(frame, this.charge.selector);
        address account = _sender();
        Allowance storage allowance = allowanceOf[account];
        if (allowance.day == day) {
            uint128 used = allowance.used;
            allowance.used = back < used ? used - uint128(back) : 0;
            emit Settled(account, back);
        }
        roll();
    }

    /// What is left of today's quota, as far as this contract knows what today is.
    function remaining(address account) external view returns (uint256) {
        Allowance memory allowance = allowanceOf[account];
        uint256 used = allowance.day == day ? allowance.used : 0;
        return used < allowance.quota ? allowance.quota - used : 0;
    }
}
