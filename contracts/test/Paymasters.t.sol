// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FramePaymaster} from "../src/paymasters/FramePaymaster.sol";
import {QuotaPaymaster} from "../src/paymasters/QuotaPaymaster.sol";
import {IToken, UsdcPaymaster} from "../src/paymasters/UsdcPaymaster.sol";
import {StandInToken} from "../src/mirror/StandInToken.sol";

/// Stands in for the APPROVE helper. A real one ends the frame; this leaves a mark the test can see.
contract ApproveDouble {
    event Approved(uint256 scope);

    fallback() external {
        emit Approved(abi.decode(msg.data, (uint256)));
    }
}

contract Registry {
    mapping(address => uint256) public staked;

    function addStake(uint32) external payable {
        staked[msg.sender] += msg.value;
    }
}

/// The frame opcodes, faked at the addresses the paymaster's own CREATE nonces fix. The same paths run against the real client
/// in `vajra paymaster-e2e`, which is the test that counts: these pin the logic and the arithmetic.
abstract contract FrameDouble is Test {
    uint256 constant APPROVE = 1;
    uint256 constant TX_PARAM = 2;
    uint256 constant FRAME_DATA_LOAD = 3;
    uint256 constant FRAME_PARAM = 5;
    uint256 constant SIG_PARAM = 6;

    // TXPARAM
    uint256 constant SENDER = 2;
    uint256 constant MAX_FEE = 4;
    uint256 constant MAX_COST = 6;
    uint256 constant BLOB_COUNT = 7;
    uint256 constant FRAME_COUNT = 9;
    uint256 constant CURRENT_FRAME = 10;
    uint256 constant SIGNATURE_COUNT = 11;
    uint256 constant NONCE_KEY_COUNT = 14;
    // FRAMEPARAM
    uint256 constant TARGET = 0;
    uint256 constant LIMIT = 1;
    uint256 constant MODE = 2;
    uint256 constant LENGTH = 4;
    uint256 constant ATOMIC_BATCH = 7;
    uint256 constant STATUS = 5;
    uint256 constant STATE_LIMIT = 9;
    uint256 constant USED = 10;
    uint256 constant STATE_USED = 11;

    uint256 constant DEFAULT_MODE = 0;
    uint256 constant VERIFY_MODE = 1;
    uint256 constant SENDER_MODE = 2;
    uint256 constant FEE = 2 gwei;
    uint256 constant CAP = 3 gwei;
    address constant ENTRY_POINT = address(0xaa);

    event Approved(uint256 scope);

    address account = makeAddr("account");
    address payable pm;

    struct Frame {
        uint256 mode;
        address target;
        uint256 limit;
        uint256 stateLimit;
        uint256 used;
        uint256 stateUsed;
        uint256 length;
        bytes4 selector;
        uint256 argument;
        uint256 status;
    }

    function helper(uint256 nonce) internal view returns (address) {
        return vm.computeCreateAddress(pm, nonce);
    }

    function setTx(uint256 param, uint256 value) internal {
        vm.mockCall(helper(TX_PARAM), abi.encode(param), abi.encode(value));
    }

    function setFrame(uint256 index, uint256 param, uint256 value) internal {
        vm.mockCall(helper(FRAME_PARAM), abi.encode(index, param), abi.encode(value));
    }

    function chargeSelector() internal pure virtual returns (bytes4);

    function chargeLimit() internal pure virtual returns (uint256 execution, uint256 state);

    /// `[only_verify, charge, pay, SENDER, settle]`, with the given frame current.
    function honest() internal view returns (Frame[] memory frames) {
        (uint256 execution, uint256 state) = chargeLimit();
        frames = new Frame[](5);
        frames[0] = Frame(VERIFY_MODE, account, 60_000, 0, 33_000, 0, 36, 0x0, 0, 1);
        frames[1] = Frame(DEFAULT_MODE, pm, execution, state, execution / 2, 0, 36, chargeSelector(), 0, 1);
        frames[2] = Frame(VERIFY_MODE, pm, 40_000, 0, 25_000, 0, 4, FramePaymaster.pay.selector, 0, 1);
        frames[3] = Frame(SENDER_MODE, account, 500_000, 700_000, 60_000, 380_000, 100, 0x0, 0, 1);
        frames[4] = Frame(DEFAULT_MODE, pm, 100_000, 0, 0, 0, 36, FramePaymaster.settle.selector, 1, 1);
    }

    function install(Frame[] memory frames, uint256 current) internal {
        setTx(SENDER, uint256(uint160(account)));
        setTx(MAX_FEE, FEE);
        setTx(BLOB_COUNT, 0);
        setTx(FRAME_COUNT, frames.length);
        setTx(CURRENT_FRAME, current);
        setTx(NONCE_KEY_COUNT, 1);
        setTx(SIGNATURE_COUNT, 1);
        vm.mockCall(helper(SIG_PARAM), abi.encode(uint256(0), uint256(3)), abi.encode(uint256(65)));
        uint256 total = 20_000;
        for (uint256 i; i < frames.length; ++i) {
            Frame memory f = frames[i];
            total += f.limit + f.stateLimit;
            setFrame(i, MODE, f.mode);
            setFrame(i, TARGET, uint256(uint160(f.target)));
            setFrame(i, LIMIT, f.limit);
            setFrame(i, STATE_LIMIT, f.stateLimit);
            setFrame(i, LENGTH, f.length);
            setFrame(i, ATOMIC_BATCH, 0);
            setFrame(i, STATUS, f.status);
            setFrame(i, USED, f.used);
            setFrame(i, STATE_USED, f.stateUsed);
            vm.mockCall(helper(FRAME_DATA_LOAD), abi.encode(uint256(0), i), abi.encode(bytes32(f.selector)));
            vm.mockCall(helper(FRAME_DATA_LOAD), abi.encode(uint256(4), i), abi.encode(f.argument));
        }
        setTx(MAX_COST, total * FEE);
    }

    function maxGas(Frame[] memory frames) internal pure returns (uint256 total) {
        total = 20_000;
        for (uint256 i; i < frames.length; ++i) {
            total += frames[i].limit + frames[i].stateLimit;
        }
    }

    /// What `_refundableGas` must give for `frames`, by hand: the unused limits of every frame before settle, less 64 gas a byte.
    function expectedBack(Frame[] memory frames) internal pure returns (uint256) {
        uint256 unused;
        uint256 size = frames[frames.length - 1].length + 16 + 33 + 65 + 52;
        for (uint256 i; i + 1 < frames.length; ++i) {
            unused += frames[i].limit - frames[i].used + frames[i].stateLimit - frames[i].stateUsed;
            size += frames[i].length;
        }
        return unused > size * 64 ? unused - size * 64 : 0;
    }
}

contract QuotaPaymasterTest is FrameDouble {
    QuotaPaymaster quota;
    address owner = makeAddr("owner");
    Registry registry;
    uint64 constant DAILY = 5_000_000;

    function chargeSelector() internal pure override returns (bytes4) {
        return QuotaPaymaster.charge.selector;
    }

    function chargeLimit() internal pure override returns (uint256, uint256) {
        return (40_000, 0);
    }

    function setUp() public {
        vm.warp(100 days);
        registry = new Registry();
        quota = new QuotaPaymaster(owner, address(registry), CAP, 1 days);
        pm = payable(address(quota));
        vm.etch(helper(APPROVE), type(ApproveDouble).runtimeCode);
        vm.prank(owner);
        quota.enroll(account, DAILY);
    }

    function charged() private {
        install(honest(), 1);
        vm.prank(ENTRY_POINT);
        quota.charge();
    }

    function used() private view returns (uint256 amount) {
        (,, amount) = quota.allowanceOf(account);
    }

    function test_charge_counts_the_whole_maximum() public {
        charged();
        assertEq(used(), maxGas(honest()));
    }

    function test_charge_only_from_a_frame() public {
        install(honest(), 1);
        vm.expectRevert(FramePaymaster.NotEntryPoint.selector);
        vm.prank(account);
        quota.charge();
    }

    function test_charge_names_a_stranger() public {
        install(honest(), 1);
        setTx(SENDER, uint256(uint160(makeAddr("stranger"))));
        vm.expectRevert(abi.encodeWithSelector(QuotaPaymaster.NotEnrolled.selector, makeAddr("stranger")));
        vm.prank(ENTRY_POINT);
        quota.charge();
    }

    function test_charge_names_its_own_starvation() public {
        Frame[] memory frames = honest();
        frames[1].limit = 39_999;
        install(frames, 1);
        vm.expectRevert(abi.encodeWithSelector(FramePaymaster.ChargeFrameStarved.selector, 39_999, 0));
        vm.prank(ENTRY_POINT);
        quota.charge();
    }

    function test_pay_approves_payment_and_nothing_else() public {
        charged();
        install(honest(), 2);
        vm.expectEmit(pm);
        emit Approved(1);
        vm.prank(ENTRY_POINT);
        quota.pay();
    }

    function test_two_transactions_cannot_share_the_same_room() public {
        uint256 one = maxGas(honest());
        vm.prank(owner);
        quota.enroll(account, uint64(one + 1000));
        charged();
        install(honest(), 2);
        vm.prank(ENTRY_POINT);
        quota.pay();
        // Before any settle, the next transaction of the same block.
        charged();
        install(honest(), 2);
        vm.expectRevert(abi.encodeWithSelector(QuotaPaymaster.OverQuota.selector, account, one * 2, one + 1000));
        vm.prank(ENTRY_POINT);
        quota.pay();
    }

    function test_pay_names_over_quota_before_reading_the_status() public {
        vm.prank(owner);
        quota.enroll(account, 1000);
        charged();
        install(honest(), 2);
        // The simulator cannot answer STATUS: this must not be reached first.
        vm.mockCallRevert(helper(FRAME_PARAM), abi.encode(uint256(1), STATUS), "");
        vm.expectRevert(abi.encodeWithSelector(QuotaPaymaster.OverQuota.selector, account, maxGas(honest()), 1000));
        vm.prank(ENTRY_POINT);
        quota.pay();
    }

    function test_pay_refuses_when_charge_failed_on_chain() public {
        Frame[] memory frames = honest();
        frames[1].status = 0;
        install(frames, 2);
        vm.expectRevert(FramePaymaster.ChargeFrameFailed.selector);
        vm.prank(ENTRY_POINT);
        quota.pay();
    }

    function test_pay_refuses_a_missing_charge() public {
        Frame[] memory frames = honest();
        install(frames, 0);
        vm.expectRevert(FramePaymaster.ChargeFrameMissing.selector);
        quota.pay();

        frames[1].selector = 0xdeadbeef;
        install(frames, 2);
        vm.expectRevert(FramePaymaster.ChargeFrameMissing.selector);
        quota.pay();

        frames = honest();
        frames[1].target = makeAddr("elsewhere");
        install(frames, 2);
        vm.expectRevert(FramePaymaster.ChargeFrameMissing.selector);
        quota.pay();

        frames = honest();
        frames[1].mode = SENDER_MODE;
        install(frames, 2);
        vm.expectRevert(FramePaymaster.ChargeFrameMissing.selector);
        quota.pay();
    }

    function test_pay_refuses_a_missing_or_wrong_settle() public {
        Frame[] memory frames = honest();
        frames[4].selector = 0xdeadbeef;
        install(frames, 2);
        vm.expectRevert(FramePaymaster.SettleFrameMissing.selector);
        quota.pay();

        frames = honest();
        frames[4].argument = 3;
        install(frames, 2);
        vm.expectRevert(FramePaymaster.SettleFrameMissing.selector);
        quota.pay();

        frames = honest();
        frames[4].target = makeAddr("elsewhere");
        install(frames, 2);
        vm.expectRevert(FramePaymaster.SettleFrameMissing.selector);
        quota.pay();

        // The pay frame last: no body, no settle.
        frames = honest();
        install(frames, 4);
        vm.expectRevert(FramePaymaster.ChargeFrameMissing.selector);
        quota.pay();
    }

    function test_pay_refuses_a_starved_settle() public {
        Frame[] memory frames = honest();
        frames[4].limit = 99_999;
        install(frames, 2);
        vm.expectRevert(abi.encodeWithSelector(FramePaymaster.SettleFrameStarved.selector, 99_999));
        quota.pay();
    }

    function test_pay_refuses_a_high_fee_and_blobs() public {
        install(honest(), 2);
        setTx(MAX_FEE, CAP + 1);
        vm.expectRevert(abi.encodeWithSelector(FramePaymaster.FeeTooHigh.selector, CAP + 1, CAP));
        quota.pay();

        install(honest(), 2);
        setTx(BLOB_COUNT, 1);
        vm.expectRevert(FramePaymaster.BlobsNotSponsored.selector);
        quota.pay();
    }

    function test_settle_gives_back_the_unused_gas_less_the_floor() public {
        charged();
        Frame[] memory frames = honest();
        install(frames, 4);
        vm.prank(ENTRY_POINT);
        quota.settle(1);
        uint256 back = expectedBack(frames);
        assertGt(back, 0);
        assertEq(used(), maxGas(frames) - back);
    }

    function test_settle_only_as_the_last_frame() public {
        charged();
        install(honest(), 3);
        vm.expectRevert(FramePaymaster.SettleNotLast.selector);
        vm.prank(ENTRY_POINT);
        quota.settle(1);
    }

    function test_settle_needs_a_charge_in_this_transaction() public {
        Frame[] memory frames = honest();
        frames[1].selector = 0xdeadbeef;
        install(frames, 4);
        vm.expectRevert(FramePaymaster.NothingToSettle.selector);
        vm.prank(ENTRY_POINT);
        quota.settle(1);

        frames = honest();
        frames[1].status = 0;
        install(frames, 4);
        vm.expectRevert(FramePaymaster.NothingToSettle.selector);
        vm.prank(ENTRY_POINT);
        quota.settle(1);

        install(honest(), 4);
        vm.expectRevert(FramePaymaster.NothingToSettle.selector);
        vm.prank(ENTRY_POINT);
        quota.settle(4);
    }

    function test_settle_gives_nothing_for_a_frame_it_does_not_understand() public {
        charged();
        Frame[] memory frames = honest();
        frames[3].mode = 5;
        install(frames, 4);
        vm.prank(ENTRY_POINT);
        quota.settle(1);
        assertEq(used(), maxGas(frames));
    }

    function test_a_charge_has_to_be_followed_by_its_own_pay() public {
        Frame[] memory frames = honest();
        frames[2].selector = 0xdeadbeef;
        install(frames, 1);
        vm.expectRevert(FramePaymaster.PayFrameMissing.selector);
        vm.prank(ENTRY_POINT);
        quota.charge();

        frames = honest();
        frames[2].mode = DEFAULT_MODE;
        install(frames, 1);
        vm.expectRevert(FramePaymaster.PayFrameMissing.selector);
        vm.prank(ENTRY_POINT);
        quota.charge();

        frames = honest();
        frames[2].target = makeAddr("elsewhere");
        install(frames, 1);
        vm.expectRevert(FramePaymaster.PayFrameMissing.selector);
        vm.prank(ENTRY_POINT);
        quota.charge();

        // A charge as the last frame.
        install(honest(), 4);
        vm.expectRevert(FramePaymaster.PayFrameMissing.selector);
        vm.prank(ENTRY_POINT);
        quota.charge();
    }

    function test_a_charge_cannot_sit_in_a_batch_that_can_undo_it() public {
        install(honest(), 1);
        setFrame(1, ATOMIC_BATCH, 1);
        vm.expectRevert(FramePaymaster.PayFrameMissing.selector);
        vm.prank(ENTRY_POINT);
        quota.charge();
    }

    /// The drain: an unrolled batch keeps frame statuses, so a status of 1 proves nothing without the pay frame beside it.
    function test_settle_refunds_nothing_unless_pay_ran() public {
        Frame[] memory frames = honest();
        frames[2].selector = 0xdeadbeef;
        install(frames, 4);
        vm.expectRevert(FramePaymaster.NothingToSettle.selector);
        vm.prank(ENTRY_POINT);
        quota.settle(1);

        frames = honest();
        frames[2].mode = DEFAULT_MODE;
        frames[2].selector = FramePaymaster.pay.selector;
        install(frames, 4);
        vm.expectRevert(FramePaymaster.NothingToSettle.selector);
        vm.prank(ENTRY_POINT);
        quota.settle(1);

        frames = honest();
        frames[2].status = 0;
        install(frames, 4);
        vm.expectRevert(FramePaymaster.NothingToSettle.selector);
        vm.prank(ENTRY_POINT);
        quota.settle(1);
    }

    /// A frame that fails for want of state gas reports its limit and the cold access on top. That has to count.
    function test_gas_over_a_frames_limit_comes_off_the_refund() public {
        charged();
        Frame[] memory frames = honest();
        uint256 clean = expectedBack(frames);
        frames[3].used = frames[3].limit + 3000;
        frames[3].stateUsed = 0;
        install(frames, 4);
        vm.prank(ENTRY_POINT);
        quota.settle(1);
        uint256 back = clean - (frames[3].limit - 60_000) - 3000 + (380_000 - 0);
        assertEq(used(), maxGas(frames) - back);
    }

    function test_a_stale_day_gives_one_quota_for_each_value_of_day() public {
        vm.prank(owner);
        quota.enroll(account, uint64(maxGas(honest())));
        charged();
        vm.warp(block.timestamp + 1 days);
        assertEq(quota.remaining(account), 0);
        charged();
        install(honest(), 2);
        vm.expectRevert();
        vm.prank(ENTRY_POINT);
        quota.pay();

        quota.roll();
        assertEq(quota.remaining(account), maxGas(honest()));
    }

    function test_roll_only_moves_to_today() public {
        uint64 today = quota.day();
        quota.roll();
        assertEq(quota.day(), today);
        vm.warp(block.timestamp + 3 days);
        quota.roll();
        assertEq(quota.day(), today + 3);
    }

    function test_a_settle_across_midnight_cannot_refund_yesterday_into_today() public {
        charged();
        vm.warp(block.timestamp + 1 days);
        quota.roll();
        install(honest(), 4);
        vm.prank(ENTRY_POINT);
        quota.settle(1);
        assertEq(quota.remaining(account), DAILY);
    }

    function test_only_the_owner() public {
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vm.expectRevert(FramePaymaster.NotOwner.selector);
        quota.enroll(stranger, 1);
        vm.expectRevert(FramePaymaster.NotOwner.selector);
        quota.setFeeCap(1);
        vm.expectRevert(FramePaymaster.NotOwner.selector);
        quota.withdraw(payable(stranger), 1);
        vm.expectRevert(FramePaymaster.NotOwner.selector);
        quota.callRegistry("");
        vm.stopPrank();
    }

    function test_it_stakes_for_itself() public {
        vm.deal(owner, 1 ether);
        vm.prank(owner);
        quota.callRegistry{value: 0.012 ether}(abi.encodeWithSignature("addStake(uint32)", 86_400));
        assertEq(registry.staked(pm), 0.012 ether);
    }

    /// The bound that matters, against ethrex's settlement: `mandatory + max(data + E, floor) + S`, with
    /// `max_gas = max(mandatory + data + L, mandatory + floor) + Ls`. Whatever the frames used and however many bytes they
    /// carried, what stays charged covers what the payer really paid. `hidden` is bytes settle cannot see: recent-root references.
    function testFuzz_what_stays_charged_covers_the_real_gas(uint32 body, uint32 bodyState, uint16 used0, uint32 usedBody, uint32 usedState, uint16 settleUsed, uint16 extra, uint16 hidden, bool zeroBytes)
        public
    {
        Frame[] memory frames = honest();
        frames[3].limit = bound(body, 1000, 3_000_000);
        frames[3].stateLimit = bound(bodyState, 0, 3_000_000);
        // A frame that fails for want of state gas reports more than its limit.
        frames[3].used = bound(usedBody, 0, frames[3].limit + 3000);
        frames[3].stateUsed = bound(usedState, 0, frames[3].stateLimit);
        frames[0].used = bound(used0, 0, frames[0].limit);
        frames[3].length = bound(extra, 0, 60_000);
        uint256 hiddenBytes = bound(hidden, 0, 1200);
        uint256 settleSpent = bound(settleUsed, 0, frames[4].limit);

        uint256 size = 16 + 33 + 65 + 52 + hiddenBytes;
        uint256 limits;
        uint256 stateLimits;
        uint256 execution = settleSpent;
        uint256 state;
        for (uint256 i; i < 5; ++i) {
            size += frames[i].length;
            limits += frames[i].limit;
            stateLimits += frames[i].stateLimit;
            if (i < 4) execution += frames[i].used;
            state += frames[i].stateUsed;
        }
        uint256 mandatory = 12_000 + 5 * 475 + 2800;
        uint256 data = size * (zeroBytes ? 4 : 16);
        uint256 floor = size * 64;
        uint256 maxTotal = max(mandatory + data + limits, mandatory + floor) + stateLimits;
        uint256 owed = mandatory + max(data + execution, floor) + state;

        vm.prank(owner);
        quota.enroll(account, uint64(maxTotal * 2));
        install(frames, 1);
        setTx(MAX_COST, maxTotal * FEE);
        vm.prank(ENTRY_POINT);
        quota.charge();
        install(frames, 4);
        setTx(MAX_COST, maxTotal * FEE);
        vm.prank(ENTRY_POINT);
        quota.settle(1);
        assertGe(used(), owed);
    }

    function max(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a : b;
    }
}

contract UsdcPaymasterTest is FrameDouble {
    UsdcPaymaster paymaster;
    StandInToken usdc;
    address owner = makeAddr("owner");
    uint256 constant PRICE = 3000e6;

    function chargeSelector() internal pure override returns (bytes4) {
        return UsdcPaymaster.collect.selector;
    }

    function chargeLimit() internal pure override returns (uint256, uint256) {
        return (100_000, 100_000);
    }

    function setUp() public {
        usdc = new StandInToken();
        paymaster = new UsdcPaymaster(owner, address(new Registry()), CAP, IToken(address(usdc)), PRICE);
        pm = payable(address(paymaster));
        vm.etch(helper(APPROVE), type(ApproveDouble).runtimeCode);
        deal(address(usdc), account, 1000e6);
        vm.prank(account);
        usdc.approve(pm, type(uint256).max);
    }

    function signed() private view returns (Frame[] memory frames) {
        frames = honest();
        frames[1].argument = PRICE;
    }

    function needed(Frame[] memory frames) private view returns (uint256) {
        return paymaster.quote(maxGas(frames) * FEE, PRICE);
    }

    function test_collect_takes_the_maximum_before_anything_runs() public {
        Frame[] memory frames = signed();
        install(frames, 1);
        vm.prank(ENTRY_POINT);
        paymaster.collect(PRICE);
        assertEq(usdc.balanceOf(pm), needed(frames));
    }

    function test_collect_only_from_a_frame() public {
        install(signed(), 1);
        vm.expectRevert(FramePaymaster.NotEntryPoint.selector);
        vm.prank(account);
        paymaster.collect(PRICE);
    }

    function test_collect_names_every_refusal() public {
        Frame[] memory frames = signed();
        install(frames, 1);
        vm.startPrank(ENTRY_POINT);
        vm.expectRevert(abi.encodeWithSelector(UsdcPaymaster.PriceChanged.selector, 1, PRICE));
        paymaster.collect(1);
        vm.stopPrank();

        vm.prank(account);
        usdc.approve(pm, 1);
        vm.expectRevert(abi.encodeWithSelector(UsdcPaymaster.InsufficientAllowance.selector, 1, needed(frames)));
        vm.prank(ENTRY_POINT);
        paymaster.collect(PRICE);

        deal(address(usdc), account, 5);
        vm.expectRevert(abi.encodeWithSelector(UsdcPaymaster.InsufficientUsdc.selector, 5, needed(frames)));
        vm.prank(ENTRY_POINT);
        paymaster.collect(PRICE);

        frames[1].limit = 99_999;
        install(frames, 1);
        vm.expectRevert(abi.encodeWithSelector(FramePaymaster.ChargeFrameStarved.selector, 99_999, 100_000));
        vm.prank(ENTRY_POINT);
        paymaster.collect(PRICE);

        frames = signed();
        frames[1].stateLimit = 99_999;
        install(frames, 1);
        vm.expectRevert(abi.encodeWithSelector(FramePaymaster.ChargeFrameStarved.selector, 100_000, 99_999));
        vm.prank(ENTRY_POINT);
        paymaster.collect(PRICE);
    }

    function test_the_owner_cannot_raise_the_price_on_a_signed_transaction() public {
        vm.prank(owner);
        paymaster.setPrice(PRICE * 2);
        install(signed(), 1);
        vm.expectRevert(abi.encodeWithSelector(UsdcPaymaster.PriceChanged.selector, PRICE, PRICE * 2));
        vm.prank(ENTRY_POINT);
        paymaster.collect(PRICE);
    }

    function test_pay_will_not_pay_unless_collect_ran() public {
        Frame[] memory frames = signed();
        frames[1].status = 0;
        install(frames, 2);
        vm.expectRevert(FramePaymaster.ChargeFrameFailed.selector);
        paymaster.pay();

        install(signed(), 2);
        vm.expectEmit(pm);
        emit Approved(1);
        paymaster.pay();
    }

    function test_settle_returns_the_unused_gas_at_the_real_price() public {
        Frame[] memory frames = signed();
        install(frames, 1);
        vm.prank(ENTRY_POINT);
        paymaster.collect(PRICE);
        uint256 collected = usdc.balanceOf(pm);

        install(frames, 4);
        uint256 gasPrice = 1 gwei + 7;
        vm.txGasPrice(gasPrice);
        vm.prank(ENTRY_POINT);
        paymaster.settle(1);

        uint256 owed = paymaster.quote((maxGas(frames) - expectedBack(frames)) * gasPrice, PRICE);
        assertEq(usdc.balanceOf(pm), owed);
        assertLt(owed, collected);
        assertEq(usdc.balanceOf(account), 1000e6 - owed);
    }

    function test_settle_never_returns_more_than_was_taken() public {
        Frame[] memory frames = signed();
        for (uint256 i; i < 4; ++i) {
            frames[i].used = 0;
            frames[i].stateUsed = 0;
        }
        install(frames, 1);
        vm.prank(ENTRY_POINT);
        paymaster.collect(PRICE);
        install(frames, 4);
        vm.txGasPrice(1);
        vm.prank(ENTRY_POINT);
        paymaster.settle(1);
        assertLe(usdc.balanceOf(account), 1000e6);
    }

    function test_settle_at_the_full_fee_keeps_what_the_gas_cost() public {
        Frame[] memory frames = signed();
        install(frames, 1);
        vm.prank(ENTRY_POINT);
        paymaster.collect(PRICE);
        install(frames, 4);
        vm.txGasPrice(FEE);
        vm.prank(ENTRY_POINT);
        paymaster.settle(1);
        assertEq(usdc.balanceOf(pm), paymaster.quote((maxGas(frames) - expectedBack(frames)) * FEE, PRICE));
    }

    function test_collect_refuses_when_pay_is_not_next() public {
        Frame[] memory frames = signed();
        frames[2].selector = 0xdeadbeef;
        install(frames, 1);
        vm.expectRevert(FramePaymaster.PayFrameMissing.selector);
        vm.prank(ENTRY_POINT);
        paymaster.collect(PRICE);
        assertEq(usdc.balanceOf(pm), 0);
    }

    /// The drain, in the shape it took: a batch undid the collect, kept its status, and there was no pay.
    function test_settle_pays_nothing_out_of_the_float_for_an_undone_collect() public {
        deal(address(usdc), pm, 500e6);
        Frame[] memory frames = signed();
        frames[2].mode = DEFAULT_MODE;
        frames[2].selector = 0xdeadbeef;
        frames[2].status = 0;
        install(frames, 4);
        vm.txGasPrice(1);
        vm.expectRevert(FramePaymaster.NothingToSettle.selector);
        vm.prank(ENTRY_POINT);
        paymaster.settle(1);
        assertEq(usdc.balanceOf(pm), 500e6);
    }

    function test_settle_needs_a_collect_in_this_transaction() public {
        Frame[] memory frames = signed();
        frames[1].status = 0;
        install(frames, 4);
        vm.expectRevert(FramePaymaster.NothingToSettle.selector);
        vm.prank(ENTRY_POINT);
        paymaster.settle(1);
    }

    function test_quote_rounds_up() public view {
        assertEq(paymaster.quote(1, PRICE), 1);
        assertEq(paymaster.quote(1 ether, PRICE), PRICE);
    }

    function test_the_label_says_what_the_price_is() public view {
        assertEq(paymaster.PRICE_LABEL(), "Fixed by the paymaster's owner. Not a market price.");
    }

    function test_no_price_of_zero() public {
        vm.expectRevert(UsdcPaymaster.BadPrice.selector);
        vm.prank(owner);
        paymaster.setPrice(0);
    }

    function test_only_the_owner() public {
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vm.expectRevert(FramePaymaster.NotOwner.selector);
        paymaster.setPrice(1);
        vm.expectRevert(FramePaymaster.NotOwner.selector);
        paymaster.withdrawUsdc(stranger, 1);
        vm.stopPrank();
    }
}
