// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VajraAccountV2} from "../src/VajraAccountV2.sol";

contract StakeSink {
    function addStake(uint32) external payable {}
}

/// Fights as hard as `SWEEP_GAS` allows: its balance read burns nearly all of 300,000 and still answers, then its transfer burns the rest.
contract Fighter {
    function balanceOf(address) external view returns (uint256) {
        while (gasleft() > 600) {}
        return 1;
    }

    function transfer(address, uint256) external pure returns (bool) {
        while (true) {}
        return true;
    }
}

/// Holds a balance, and notes what the harbor held at the moment it was swept.
contract Witness {
    address immutable harbor;
    uint256 public harborHeld;
    bool public poolClosedThen;
    bool public swept;

    constructor(address harbor_) {
        harbor = harbor_;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 1;
    }

    function transfer(address, uint256) external returns (bool) {
        harborHeld = harbor.balance;
        poolClosedThen = VajraAccountV2(payable(msg.sender)).poolClosed();
        swept = true;
        return true;
    }
}

/// A harbor that notes what the frame had left when the value reached it.
contract Meter {
    uint256 public seen;
    bool burns;

    function burnEverything() external {
        burns = true;
    }

    receive() external payable {
        while (burns) {}
        seen = gasleft();
    }
}

/// Says it is the account's exit, and is not: `setExit` asks, and cannot tell. See docs/FINDINGS.md section 21.
contract Liar {
    address immutable claimed;

    constructor(address account_) {
        claimed = account_;
    }

    function account() external view returns (address) {
        return claimed;
    }
}

/// What a nominee's rescue leaves behind, and what it has to get through. See docs/FINDINGS.md section 23.
contract EscapeAfterRescueTest is Test {
    /// A CALL carrying value to a fresh address needs this much execution gas left, on this fork, whether or not it spends it.
    uint256 constant FRESH_CALL_HEADROOM = 183_600;
    bytes32 constant HARBOR_SALT = keccak256("harbor salt");

    VajraAccountV2 account;
    Meter meter;
    address thief = makeAddr("thief");

    function setUp() public {
        vm.warp(1_800_000_000);
        StakeSink sink = new StakeSink();
        VajraAccountV2 implementation = new VajraAccountV2(4, 3, address(sink), address(1), address(2), address(3), 0.1 ether, 0.005 ether, 0);
        address at = address(0xA11CE);
        vm.etch(at, abi.encodePacked(hex"363d3d373d3d3d363d73", address(implementation), hex"5af43d82803e903d91602b57fd5bf3"));
        account = VajraAccountV2(payable(at));
        meter = new Meter();

        address[] memory assets = new address[](1);
        uint128[] memory limits = new uint128[](1);
        limits[0] = 1 ether;
        uint128[] memory cooling = new uint128[](1);
        cooling[0] = 1 ether;
        account.initialize{value: 5 ether}(
            VajraAccountV2.Config({
                dailyKey: makeAddr("daily"),
                wotsRoot: keccak256("first tree"),
                epochSalt: keccak256("epoch"),
                harborCommitment: keccak256(abi.encodePacked(address(meter), HARBOR_SALT)),
                queueDelay: 1 days,
                coolingPeriod: 0,
                maxDailyTxCost: 0.05 ether,
                assets: assets,
                dailyLimits: limits,
                coolingAllowances: cooling,
                coSigner: address(0),
                stake: 0,
                unstakeDelay: 0
            })
        );
    }

    /// An escape stops a queued payment only while the account stays frozen. It does not end it. So an owner who comes back has to veto what is
    /// waiting before unfreezing, or a theft that has already matured takes whatever they pay in next.
    function test_anEscapeLeavesTheQueueAsItWas() public {
        vm.prank(address(account));
        account.spend(address(0), thief, 1.5 ether);

        vm.prank(address(account));
        account.escape(payable(address(meter)), HARBOR_SALT, new address[](0));
        assertEq(uint8(account.queuedItem(0).state), 1, "still pending after the escape");

        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(VajraAccountV2.AccountFrozen.selector);
        account.executeQueued(0);

        vm.prank(address(account));
        account.unfreeze();
        vm.deal(address(account), 1.5 ether);
        account.executeQueued(0);
        assertEq(thief.balance, 1.5 ether, "the old theft takes the new money");
    }

    function test_aVetoBeforeUnfreezingEndsIt() public {
        vm.prank(address(account));
        account.spend(address(0), thief, 1.5 ether);
        vm.prank(address(account));
        account.escape(payable(address(meter)), HARBOR_SALT, new address[](0));

        vm.warp(block.timestamp + 2 days);
        vm.startPrank(address(account));
        account.veto(0);
        account.unfreeze();
        vm.stopPrank();
        vm.deal(address(account), 1.5 ether);
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.VetoedByEscapeKey.selector, 0));
        account.executeQueued(0);
    }

    /// The known limit of section 21, one step further. Using a paper closes its gate and leaves its commitment set, so an exit the master key
    /// named by mistake can go on queuing roots. Each one still waits out the delay, where the master key can veto it.
    function test_aLyingExitCanGoOnQueuingAfterThePaperIsUsed() public {
        address liar = address(new Liar(address(account)));
        vm.startPrank(address(account));
        account.setExit(liar);
        account.setRecovery(7, 1 days, keccak256("gate"));
        vm.stopPrank();

        vm.startPrank(liar);
        account.queueRecovery(keccak256("root 1"), 1);
        assertEq(account.recoveryGate(), bytes32(0), "the paper is used");
        account.queueRecovery(keccak256("root 2"), 2);
        vm.stopPrank();
        assertEq(account.nextItem(), 2);

        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.QueuedPendingTimelock.selector, uint64(block.timestamp) + 1 days));
        account.executeQueued(1);
    }

    /// The harbor is paid before any token is touched, so no token can spend what the harbor and the pool closing need. On the mirror, a token
    /// that really spends the frame's state gas is `vajra nominee-e2e` step 14: forge has no state gas.
    function test_theHarborIsPaidBeforeAnyTokenIsCalled() public {
        Witness token = new Witness(address(meter));
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        vm.prank(address(account));
        account.escape(payable(address(meter)), HARBOR_SALT, tokens);
        assertEq(token.harborHeld(), 5 ether, "the ETH was there when the token was called");
        assertTrue(token.poolClosedThen(), "and the pool had already closed");
    }

    /// The harbor is the owner's own, and paid first it would otherwise get nearly all the gas. Bounded, one that burns it all fails its own payment,
    /// and the frame still freezes the account and sweeps the tokens, as it did when tokens went first.
    function test_aHarborThatBurnsItsGasCannotStopTheRest() public {
        meter.burnEverything();
        Witness token = new Witness(address(meter));
        address[] memory tokens = new address[](2);
        tokens[0] = address(new Fighter());
        tokens[1] = address(token);
        vm.prank(address(account));
        account.escape{gas: 700_000 + 600_000 * 2}(payable(address(meter)), HARBOR_SALT, tokens);
        assertTrue(account.frozen(), "the frame ran to the end");
        assertTrue(token.swept(), "and the token after the fighter was swept");
        assertEq(address(account).balance, 5 ether, "the harbor took nothing, so the money is still here");
        assertFalse(account.poolClosed(), "and the pool stays open for it");
    }

    /// `rescueCall` signs 700,000 and 600,000 a token. Gas cannot be raised after signing, so a frame with tokens fighting as hard as they can must
    /// still finish, with the harbor paid. Forge prices this more harshly than the fork does, which errs the right way.
    function test_tokensThatFightCannotStopTheEscapeFinishing() public {
        uint256[5] memory counts = [uint256(1), 2, 5, 13, 30];
        for (uint256 i; i < counts.length; ++i) {
            uint256 snapshot = vm.snapshot();
            address[] memory tokens = new address[](counts[i]);
            for (uint256 t; t < counts[i]; ++t) {
                tokens[t] = address(new Fighter());
            }
            vm.prank(address(account));
            account.escape{gas: 700_000 + 600_000 * counts[i]}(payable(address(meter)), HARBOR_SALT, tokens);
            assertGt((meter.seen() * 64) / 63, FRESH_CALL_HEADROOM, "the harbor's CALL had its headroom");
            assertEq(address(meter).balance, 5 ether, "the harbor holds it");
            assertTrue(account.frozen(), "and the frame ran to the end");
            vm.revertTo(snapshot);
        }
    }
}
