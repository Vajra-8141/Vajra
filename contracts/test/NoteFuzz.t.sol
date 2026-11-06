// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VajraAccountV2} from "../src/VajraAccountV2.sol";

contract AcceptAll {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[6] calldata) external pure returns (bool) {
        return true;
    }
}

contract FakePoseidon {
    function poseidon(uint256[2] calldata x) external pure returns (uint256) {
        return uint256(keccak256(abi.encode(x))) >> 8;
    }
}

contract Sink {
    receive() external payable {}
}

contract Refuser {
    receive() external payable {
        revert("no");
    }
}

contract Burner {
    receive() external payable {
        assembly ("memory-safe") {
            invalid()
        }
    }
}

/// Takes the money and reaches for everything it can from inside the payment.
contract Reenter {
    VajraAccountV2 public a;
    uint256[6] public ns;
    uint256 public received;
    uint256 public root;
    bool public revertAfter;

    function arm(VajraAccountV2 a_, uint256[6] memory ns_) external {
        a = a_;
        ns = ns_;
    }

    function set(uint256 root_, bool r) external {
        root = root_;
        revertAfter = r;
    }

    receive() external payable {
        if (msg.sender != address(a)) return;
        received += msg.value;
        uint256[8] memory p;
        for (uint256 i; i < 6; ++i) {
            try a.claim(p, root, ns[i], address(this)) {} catch {}
        }
        if (revertAfter) revert("after all");
    }
}

/// Every path a note can take, in any order: shield, unshield to a good recipient and to ones that refuse, burn or re-enter, claim, a spend, a matured
/// item, freeze, unfreeze and escape. After each step: `poolHeld` is exact, the balance covers it, and each note was paid once. The verifier is a stub
/// that accepts everything, so this holds the accounting and says nothing about the proofs. Written by the review of docs/FINDINGS.md section 26.
contract NoteFuzzTest is Test {
    uint256 constant D = 0.1 ether;
    uint256 constant FEE = 0.005 ether;
    uint256 constant AMOUNT = D - FEE;
    uint256 constant F0 = 5 ether;
    bytes32 constant HSALT = keccak256("salt");

    VajraAccountV2 account;
    Sink noteSink;
    Sink spendSink;
    Refuser refuser;
    Burner burner;
    Reenter reenter;
    address payable harbor = payable(makeAddr("harbor4"));
    uint256[6] ns;
    uint256 deposits;
    uint256 nextCommit = 1;
    uint256 latestRoot;
    uint256[] queued;

    function setUp() public {
        vm.warp(1_800_000_000);
        VajraAccountV2 impl = new VajraAccountV2(4, 3, address(new Sink()), address(new Sink()), address(new AcceptAll()), address(new FakePoseidon()), D, FEE, 0);
        address at = address(0xC10E);
        vm.etch(at, abi.encodePacked(hex"363d3d373d3d3d363d73", address(impl), hex"5af43d82803e903d91602b57fd5bf3"));
        account = VajraAccountV2(payable(at));
        address[] memory assets = new address[](1);
        uint128[] memory limits = new uint128[](1);
        limits[0] = 1 ether;
        uint128[] memory cooling = new uint128[](1);
        cooling[0] = 1 ether;
        account.initialize{value: F0}(
            VajraAccountV2.Config({
                dailyKey: address(0xDA),
                wotsRoot: bytes32(uint256(7)),
                epochSalt: bytes32(uint256(8)),
                harborCommitment: keccak256(abi.encodePacked(address(harbor), HSALT)),
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
        noteSink = new Sink();
        spendSink = new Sink();
        refuser = new Refuser();
        burner = new Burner();
        reenter = new Reenter();
        for (uint256 i; i < 6; ++i) ns[i] = 1000 + i;
        reenter.arm(account, ns);
        vm.prank(at);
        account.shield{value: D}(nextCommit++);
        deposits = 1;
        latestRoot = account.poolRoot();
    }

    /// A real unshield needs a real leaf. Without one a proof cannot exist, so the harness does not send one: only a master frame could.
    function live() private view returns (uint256 left) {
        uint256 used;
        for (uint256 i; i < 6; ++i) if (account.noteState(ns[i]) != 0) used++;
        return deposits - used;
    }

    function _unshield(uint256 n, address to) private {
        if (live() == 0) return;
        vm.prank(address(account));
        try account.unshield{gas: 500_000}(latestRoot, n, to) {} catch {}
    }

    function _claim(uint256 n, address to) private {
        uint256[8] memory p;
        try account.claim(p, latestRoot, n, to) {} catch {}
    }

    function step(uint256 r) private {
        uint256 op = r % 14;
        uint256 n = ns[(r >> 8) % 6];
        reenter.set(latestRoot, (r >> 20) & 1 == 1);
        if (op == 0 || op == 1) {
            vm.deal(address(this), 1 ether); // the test contract is the outsider
            try account.shield{value: D}(nextCommit) {
                nextCommit++;
                deposits++;
                latestRoot = account.poolRoot();
            } catch {}
        } else if (op == 2) {
            _unshield(n, address(noteSink));
        } else if (op == 3) {
            _unshield(n, address(refuser));
        } else if (op == 4) {
            _unshield(n, address(burner));
        } else if (op == 5) {
            _unshield(n, address(reenter));
        } else if (op == 6) {
            _claim(n, address(noteSink));
        } else if (op == 7) {
            _claim(n, address(refuser));
        } else if (op == 8) {
            _claim(n, address(reenter));
        } else if (op == 9) {
            vm.prank(address(account));
            try account.spend(address(0), address(spendSink), (r >> 24) % (2 ether)) {} catch {}
            if (account.nextItem() > queued.length) queued.push(account.nextItem() - 1);
        } else if (op == 10) {
            if (queued.length != 0) {
                vm.warp(block.timestamp + 2 days);
                try account.executeQueued(queued[(r >> 30) % queued.length]) {} catch {}
            }
        } else if (op == 11) {
            vm.prank(address(account));
            account.freeze();
        } else if (op == 12) {
            vm.prank(address(account));
            account.unfreeze();
        } else if ((r >> 40) % 16 == 0) {
            vm.prank(address(account));
            account.escape(harbor, HSALT, new address[](0));
        }
    }

    function check() private view {
        uint256 owed;
        uint256 spent;
        for (uint256 i; i < 6; ++i) {
            uint256 st = account.noteState(ns[i]);
            if (st == 2) owed++;
            if (st == 1) spent++;
            assertLt(st, 3);
        }
        if (account.poolClosed()) assertEq(account.poolHeld(), 0);
        else assertEq(account.poolHeld(), (deposits - owed - spent) * D + owed * AMOUNT, "poolHeld");
        assertGe(address(account).balance, account.poolHeld(), "balance covers the pool");
        assertEq(address(noteSink).balance + address(reenter).balance, spent * AMOUNT, "each note paid once");
        assertEq(F0 + (deposits - 1) * D, address(account).balance + address(noteSink).balance + address(reenter).balance + address(spendSink).balance + harbor.balance, "conservation");
    }

    function test_fuzz_noteMachine(uint256 seed) public {
        for (uint256 i; i < 120; ++i) {
            step(uint256(keccak256(abi.encode(seed, i))));
            check();
        }
    }

    receive() external payable {}
}
