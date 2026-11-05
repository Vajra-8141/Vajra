// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VajraAccount} from "../src/VajraAccount.sol";
import {VajraFactory} from "../src/VajraFactory.sol";

contract MockToken {
    mapping(address => uint256) public balanceOf;
    bool public broken;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setBroken(bool value) external {
        broken = value;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(!broken, "broken");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// A token shaped like USDT: `transfer` returns nothing.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}

/// `transfer` answers with one byte, which would make a strict ABI decoder revert.
contract ShortReturnToken {
    function balanceOf(address) external pure returns (uint256) {
        return 1;
    }

    fallback() external {
        assembly {
            mstore(0, 0)
            return(0, 1)
        }
    }
}

/// `transfer` answers with far more data than any caller should copy.
contract ReturnBombToken {
    function balanceOf(address) external pure returns (uint256) {
        return 1;
    }

    fallback() external {
        assembly {
            return(0, 1000000)
        }
    }
}

/// `transfer` burns every unit of gas it is given.
contract GasBurnerToken {
    function balanceOf(address) external pure returns (uint256) {
        return 1;
    }

    fallback() external {
        while (true) {}
    }
}

/// The rulebook, which runs in SENDER frames. A SENDER frame calls the account as the account, so `vm.prank(account)`
/// is exactly that frame. VERIFY needs the frame opcodes and is tested against the real client: see packages/cli.
contract VajraAccountTest is Test {
    uint128 constant LIMIT = 1_000e6;
    uint128 constant COOLING = 100e6;
    uint64 constant DELAY = 1 days;
    uint64 constant COOLING_PERIOD = 1 days;
    bytes32 constant ROOT = keccak256("root");
    bytes32 constant SALT = keccak256("harbor salt");

    address payable harbor = payable(makeAddr("harbor"));
    address daily = makeAddr("daily");
    address payee = makeAddr("payee");
    address thief = makeAddr("thief");

    MockToken usdc;
    VajraFactory factory;
    VajraAccount account;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockToken();
        factory = new VajraFactory(address(new VajraAccount(4, 3)));
        address[] memory assets = new address[](2);
        assets[0] = address(usdc);
        assets[1] = address(0);
        uint128[] memory limits = new uint128[](2);
        limits[0] = LIMIT;
        limits[1] = 1 ether;
        uint128[] memory cooling = new uint128[](2);
        cooling[0] = COOLING;
        cooling[1] = 0.1 ether;
        VajraAccount.Config memory config = VajraAccount.Config({
            dailyKey: daily,
            wotsRoot: ROOT,
            epochSalt: keccak256("epoch"),
            harborCommitment: keccak256(abi.encodePacked(address(harbor), SALT)),
            queueDelay: DELAY,
            coolingPeriod: COOLING_PERIOD,
            maxDailyTxCost: 0.05 ether,
            assets: assets,
            dailyLimits: limits,
            coolingAllowances: cooling
        });
        account = VajraAccount(payable(factory.create{value: 10 ether}(config)));
        usdc.mint(address(account), 1_000_000e6);
        seasonPayee(payee);
    }

    /// Moves a payee past the cooling period, so a test can look at the daily limit alone.
    function seasonPayee(address who) private {
        as_self();
        account.spend(address(usdc), who, 0);
        vm.warp(block.timestamp + COOLING_PERIOD);
    }

    function as_self() private {
        vm.prank(address(account));
    }

    // -------------------------------------------------------------- factory ----

    function test_factory_predictsTheAddress() public {
        VajraAccount.Config memory config;
        config.wotsRoot = keccak256("another root");
        address predicted = factory.addressOf(config);
        assertEq(predicted.code.length, 0);
        assertEq(factory.create(config), predicted);
        assertGt(predicted.code.length, 0);
    }

    function test_factory_initializesAndFunds() public view {
        assertEq(account.dailyKey(), daily);
        assertEq(account.wotsRoot(), ROOT);
        assertEq(address(account).balance, 10 ether);
    }

    function test_initialize_refusesAnEmptyRoot() public {
        VajraAccount.Config memory config;
        vm.expectRevert(VajraAccount.RootRequired.selector);
        factory.create(config);
    }

    function test_clone_cannotBeInitializedTwice() public {
        VajraAccount.Config memory config;
        config.wotsRoot = keccak256("attacker");
        vm.expectRevert(VajraAccount.AlreadyInitialized.selector);
        account.initialize(config);
    }

    function test_implementation_isLocked() public {
        VajraAccount.Config memory config;
        config.wotsRoot = keccak256("attacker");
        VajraAccount implementation = VajraAccount(payable(factory.implementation()));
        vm.expectRevert(VajraAccount.AlreadyInitialized.selector);
        implementation.initialize(config);
    }

    // --------------------------------------------------------- access control ----

    function test_everyPrivilegedFunction_rejectsOutsiders() public {
        bytes[] memory calls = new bytes[](9);
        calls[0] = abi.encodeCall(account.spend, (address(usdc), thief, 1));
        calls[1] = abi.encodeCall(account.veto, (0));
        calls[2] = abi.encodeCall(account.freeze, ());
        calls[3] = abi.encodeCall(account.unfreeze, ());
        calls[4] = abi.encodeCall(account.escape, (payable(thief), SALT, new address[](0)));
        calls[5] = abi.encodeCall(account.rotateRoot, (keccak256("x")));
        calls[6] = abi.encodeCall(account.setDailyKey, (thief));
        calls[7] = abi.encodeCall(account.setRule, (address(usdc), type(uint128).max, type(uint128).max));
        calls[8] = abi.encodeCall(account.setHarbor, (keccak256("x")));
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(thief);
            (bool ok, bytes memory ret) = address(account).call(calls[i]);
            assertFalse(ok);
            assertEq(bytes4(ret), VajraAccount.NotAuthorized.selector);
        }
    }

    // ------------------------------------------------------------ daily limit ----

    function test_spend_underTheLimitLeavesAtOnce() public {
        as_self();
        account.spend(address(usdc), payee, 400e6);
        assertEq(usdc.balanceOf(payee), 400e6);
    }

    function test_spend_overTheLimitIsQueuedNotRefused() public {
        as_self();
        vm.expectEmit(true, true, true, true);
        emit VajraAccount.Queued(
            0, address(usdc), payee, LIMIT + 1, uint64(block.timestamp) + DELAY, VajraAccount.QueueReason.DailyLimitExceeded
        );
        account.spend(address(usdc), payee, LIMIT + 1);
        assertEq(usdc.balanceOf(payee), 0);
        assertEq(uint8(account.queuedItem(0).state), uint8(VajraAccount.ItemState.Pending));
    }

    function test_limit_isCumulativeInsideTheWindow() public {
        as_self();
        account.spend(address(usdc), payee, 600e6);
        as_self();
        account.spend(address(usdc), payee, 600e6);
        assertEq(usdc.balanceOf(payee), 600e6);
        assertEq(account.nextItem(), 1);
    }

    function test_limit_refillsAfterTheWindow() public {
        as_self();
        account.spend(address(usdc), payee, LIMIT);
        vm.warp(block.timestamp + 25 hours);
        as_self();
        account.spend(address(usdc), payee, LIMIT);
        assertEq(usdc.balanceOf(payee), 2 * LIMIT);
    }

    /// The reason for a rolling window. A calendar-day limit lets a thief take twice the limit around midnight.
    function test_limit_cannotBeDoubledAcrossAnyBoundary() public {
        vm.warp((block.timestamp / 1 days + 1) * 1 days - 30 minutes);
        as_self();
        account.spend(address(usdc), payee, LIMIT);
        vm.warp(block.timestamp + 1 hours);
        as_self();
        account.spend(address(usdc), payee, LIMIT);
        assertEq(usdc.balanceOf(payee), LIMIT);
    }

    /// The window never drops a spend before 24 hours have passed, wherever in its hour the spend landed.
    function testFuzz_limit_holdsForAFullDay(uint32 offset, uint32 elapsed) public {
        vm.warp(block.timestamp + bound(offset, 0, 1 hours));
        as_self();
        account.spend(address(usdc), payee, LIMIT);
        vm.warp(block.timestamp + bound(elapsed, 0, 24 hours - 1));
        as_self();
        account.spend(address(usdc), payee, 1);
        assertEq(usdc.balanceOf(payee), LIMIT);
    }

    function test_rollWindow_survivesLongIdleness() public {
        as_self();
        account.spend(address(usdc), payee, 500e6);
        vm.warp(block.timestamp + 400 days);
        as_self();
        account.spend(address(usdc), payee, LIMIT);
        (,,, uint128 spent) = account.rule(address(usdc));
        assertEq(spent, LIMIT);
    }

    function test_rule_viewMatchesWhatASpendWouldSee() public {
        as_self();
        account.spend(address(usdc), payee, 300e6);
        (,,, uint128 spent) = account.rule(address(usdc));
        assertEq(spent, 300e6);
        vm.warp(block.timestamp + 26 hours);
        (,,, spent) = account.rule(address(usdc));
        assertEq(spent, 0);
    }

    function test_spend_ofAnUnconfiguredAssetIsUnresolvable() public {
        address other = makeAddr("other token");
        as_self();
        vm.expectRevert(abi.encodeWithSelector(VajraAccount.MandateUnresolvable.selector, other));
        account.spend(other, payee, 1);
    }

    function test_spend_movesEth() public {
        as_self();
        account.spend(address(0), payee, 0.5 ether);
        assertEq(payee.balance, 0.5 ether);
    }

    function test_spend_handlesATokenThatReturnsNothing() public {
        NoReturnToken usdt = new NoReturnToken();
        usdt.mint(address(account), 100);
        as_self();
        account.setRule(address(usdt), 100, 100);
        as_self();
        account.spend(address(usdt), payee, 100);
        assertEq(usdt.balanceOf(payee), 100);
    }

    // -------------------------------------------------------- new-payee cooling ----

    function test_cooling_capsAFreshAddressBelowTheDailyLimit() public {
        as_self();
        account.spend(address(usdc), thief, COOLING + 1);
        assertEq(usdc.balanceOf(thief), 0);
        assertEq(account.nextItem(), 1);
    }

    function test_cooling_allowsUpToTheAllowance() public {
        as_self();
        account.spend(address(usdc), thief, COOLING);
        assertEq(usdc.balanceOf(thief), COOLING);
    }

    function test_cooling_isCumulativePerPayee() public {
        for (uint256 i; i < 5; ++i) {
            as_self();
            account.spend(address(usdc), thief, COOLING / 2);
        }
        assertEq(usdc.balanceOf(thief), COOLING);
        assertEq(account.nextItem(), 3);
    }

    /// `firstSeen` has to survive the queueing path, or a payee that is only ever queued could never warm up.
    function test_cooling_firstSeenIsRecordedEvenWhenTheSpendIsQueued() public {
        as_self();
        account.spend(address(usdc), thief, COOLING + 1);
        assertEq(account.firstSeen(thief), block.timestamp);
    }

    function test_cooling_endsAfterThePeriod() public {
        as_self();
        account.spend(address(usdc), thief, 1);
        vm.warp(block.timestamp + COOLING_PERIOD);
        as_self();
        account.spend(address(usdc), thief, LIMIT - 1);
        assertEq(usdc.balanceOf(thief), LIMIT);
    }

    // ------------------------------------------------------------ queue and veto ----

    function queueBigSpend() private returns (uint256 id) {
        id = account.nextItem();
        as_self();
        account.spend(address(usdc), payee, 50_000e6);
    }

    function test_queue_refusesBeforeItMatures() public {
        uint256 id = queueBigSpend();
        uint64 executeAfter = account.queuedItem(id).executeAfter;
        vm.expectRevert(abi.encodeWithSelector(VajraAccount.QueuedPendingTimelock.selector, executeAfter));
        account.executeQueued(id);
    }

    function test_queue_executesOnceItMatures() public {
        uint256 id = queueBigSpend();
        vm.warp(block.timestamp + DELAY);
        vm.prank(thief);
        account.executeQueued(id);
        assertEq(usdc.balanceOf(payee), 50_000e6);
    }

    function test_queue_cannotExecuteTwice() public {
        uint256 id = queueBigSpend();
        vm.warp(block.timestamp + DELAY);
        account.executeQueued(id);
        vm.expectRevert(abi.encodeWithSelector(VajraAccount.ItemNotPending.selector, id));
        account.executeQueued(id);
    }

    function test_veto_cancelsForGood() public {
        uint256 id = queueBigSpend();
        as_self();
        account.veto(id);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(VajraAccount.VetoedByEscapeKey.selector, id));
        account.executeQueued(id);
        assertEq(usdc.balanceOf(payee), 0);
    }

    function test_veto_ofAnUnknownItemReverts() public {
        as_self();
        vm.expectRevert(abi.encodeWithSelector(VajraAccount.ItemNotPending.selector, 99));
        account.veto(99);
    }

    // -------------------------------------------------------------------- freeze ----

    function test_freeze_stopsSpendsAndMaturedItems() public {
        uint256 id = queueBigSpend();
        as_self();
        account.freeze();
        vm.warp(block.timestamp + DELAY);
        as_self();
        vm.expectRevert(VajraAccount.AccountFrozen.selector);
        account.spend(address(usdc), payee, 1);
        vm.expectRevert(VajraAccount.AccountFrozen.selector);
        account.executeQueued(id);
    }

    function test_unfreeze_restoresTheDailyPath() public {
        as_self();
        account.freeze();
        as_self();
        account.unfreeze();
        as_self();
        account.spend(address(usdc), payee, 1);
        assertEq(usdc.balanceOf(payee), 1);
    }

    // -------------------------------------------------------------------- escape ----

    function test_escape_sweepsEverythingToTheHarbor() public {
        as_self();
        account.escape(harbor, SALT, new address[](0));
        assertEq(usdc.balanceOf(harbor), 1_000_000e6);
        assertEq(harbor.balance, 10 ether);
        assertEq(address(account).balance, 0);
    }

    function test_escape_refusesAnyOtherHarbor() public {
        as_self();
        vm.expectRevert(VajraAccount.HarborMismatch.selector);
        account.escape(payable(thief), SALT, new address[](0));
    }

    function test_escape_refusesTheWrongSalt() public {
        as_self();
        vm.expectRevert(VajraAccount.HarborMismatch.selector);
        account.escape(harbor, keccak256("wrong"), new address[](0));
    }

    function test_escape_leavesTheAccountFrozen() public {
        as_self();
        account.escape(harbor, SALT, new address[](0));
        assertTrue(account.frozen());
    }

    function test_escape_killsAQueuedTheft() public {
        uint256 id = queueBigSpend();
        as_self();
        account.escape(harbor, SALT, new address[](0));
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(VajraAccount.AccountFrozen.selector);
        account.executeQueued(id);
    }

    /// A hostile token in the list must not be able to block the exit.
    function test_escape_survivesABrokenToken() public {
        MockToken bad = new MockToken();
        bad.mint(address(account), 5);
        bad.setBroken(true);
        address[] memory extra = new address[](1);
        extra[0] = address(bad);
        as_self();
        vm.expectEmit(true, false, false, false);
        emit VajraAccount.SweepFailed(address(bad));
        account.escape(harbor, SALT, extra);
        assertEq(usdc.balanceOf(harbor), 1_000_000e6);
        assertEq(harbor.balance, 10 ether);
    }

    function escapeSurvives(address hostile) private {
        address[] memory extra = new address[](1);
        extra[0] = hostile;
        as_self();
        vm.expectEmit(true, false, false, false);
        emit VajraAccount.SweepFailed(hostile);
        account.escape(harbor, SALT, extra);
        assertEq(usdc.balanceOf(harbor), 1_000_000e6);
        assertEq(harbor.balance, 10 ether);
    }

    function test_escape_survivesATokenWithAMalformedReturn() public {
        escapeSurvives(address(new ShortReturnToken()));
    }

    function test_escape_survivesAReturnBomb() public {
        ReturnBombToken bomb = new ReturnBombToken();
        address[] memory extra = new address[](1);
        extra[0] = address(bomb);
        as_self();
        account.escape{gas: 2_000_000}(harbor, SALT, extra);
        assertEq(usdc.balanceOf(harbor), 1_000_000e6);
        assertEq(harbor.balance, 10 ether);
    }

    function test_escape_survivesATokenThatBurnsAllItsGas() public {
        GasBurnerToken burner = new GasBurnerToken();
        address[] memory extra = new address[](1);
        extra[0] = address(burner);
        as_self();
        account.escape{gas: 2_000_000}(harbor, SALT, extra);
        assertEq(usdc.balanceOf(harbor), 1_000_000e6);
        assertEq(harbor.balance, 10 ether);
    }

    function test_escape_sweepsExtraTokens() public {
        MockToken other = new MockToken();
        other.mint(address(account), 7);
        address[] memory extra = new address[](1);
        extra[0] = address(other);
        as_self();
        account.escape(harbor, SALT, extra);
        assertEq(other.balanceOf(harbor), 7);
    }

    // ------------------------------------------------------------- master-key ops ----

    function test_rotateRoot_replacesTheTree() public {
        as_self();
        account.rotateRoot(keccak256("next tree"));
        assertEq(account.wotsRoot(), keccak256("next tree"));
    }

    function test_setDailyKey_replacesAStolenKey() public {
        as_self();
        account.setDailyKey(makeAddr("new key"));
        assertEq(account.dailyKey(), makeAddr("new key"));
    }

    function test_setRule_changesTheLimit() public {
        as_self();
        account.setRule(address(usdc), 5, 5);
        (, uint128 limit,,) = account.rule(address(usdc));
        assertEq(limit, 5);
    }

    function test_setHarbor_changesTheCommitment() public {
        as_self();
        account.setHarbor(keccak256("new"));
        assertEq(account.harborCommitment(), keccak256("new"));
    }

    function test_masterDigest_bindsTheEpochAndTheAccount() public view {
        bytes32 expected = keccak256(
            abi.encodePacked(block.chainid, keccak256("epoch"), address(account), uint256(5), keccak256("sig hash"))
        );
        assertEq(account.masterDigest(5, keccak256("sig hash")), expected);
    }

    function test_storageSlot_matchesErc7201() public pure {
        bytes32 slot = keccak256(abi.encode(uint256(keccak256("vajra.account.v1")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(slot, 0xf2fd160257ae1f0e7d62d7d1c68f72a3ef6f2001f3b743b1c3e7df809af00f00);
    }
}
