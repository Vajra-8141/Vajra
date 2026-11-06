// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, stdJson} from "forge-std/Test.sol";
import {VajraAccountV2} from "../src/VajraAccountV2.sol";
import {VajraExit, VajraExitFactory} from "../src/VajraExit.sol";
import {RecoveryVerifier} from "../src/verifiers/RecoveryVerifier.sol";
import {ShieldVerifier} from "../src/verifiers/ShieldVerifier.sol";
import {Scope as VajraScope} from "@forshtat/hegota-support/contracts/Params.sol";

contract ReviewStakeSink {
    function addStake(uint32) external payable {}
}

contract ReviewApproveDouble {
    event Approved(uint256 scope);

    fallback() external {
        emit Approved(abi.decode(msg.data, (uint256)));
    }
}

/// Independent review. Each attack here once worked, and each test now holds that it is refused.
/// The account, verifiers and proofs are real. The frame opcodes are answered by mocks, as in VajraAccountV2.t.sol.
contract AdversarialReviewTest is Test {
    using stdJson for string;

    uint256 constant DENOM = 0.1 ether;
    uint256 constant MAX_PROOF_COST = 0.005 ether;
    uint256 constant DAILY_CAP = 0.05 ether;
    uint256 constant CHAIN = 13370;
    uint256 constant WORK_BITS = 10; // packages/cli/src/deploy.ts on the mirror
    bytes32 constant SALT = 0xabababababababababababababababababababababababababababababababab;
    bytes32 constant NEW_ROOT = 0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd;
    bytes32 constant EXIT_TICKET = keccak256("the exit's ticket on the paper");
    bytes32 constant TICKET = keccak256(abi.encode(EXIT_TICKET));
    bytes32 constant GATE = keccak256(abi.encode(TICKET));
    uint256 constant VERIFY_GAS = 60_000;
    bytes32 constant SPEND_TYPE = keccak256(
        "DailySpend(address asset,address recipient,uint256 amount,uint256 nonce,uint256 maxFeePerGas,uint256 maxPriorityFeePerGas,uint256 executionGas,uint256 stateGas,uint256 verifyGas,uint256 maxCost)"
    );

    uint256 constant APPROVE = 1;
    uint256 constant TX_PARAM = 2;
    uint256 constant FRAME_DATA_LOAD = 3;
    uint256 constant FRAME_PARAM = 5;
    uint256 constant SIG_PARAM = 6;

    uint256 constant NONCE = 1;
    uint256 constant TX_SENDER = 2;
    uint256 constant MAX_PRIORITY = 3;
    uint256 constant MAX_FEE = 4;
    uint256 constant MAX_COST = 6;
    uint256 constant FRAME_COUNT = 9;
    uint256 constant CURRENT_FRAME = 10;
    uint256 constant NONCE_KEY_COUNT = 14;
    uint256 constant NONCE_KEY_0 = 16;
    uint256 constant RESOLVED_TARGET = 0;
    uint256 constant EXECUTION_GAS_LIMIT = 1;
    uint256 constant MODE = 2;
    uint256 constant DATA_LENGTH = 4;
    uint256 constant VALUE = 8;
    uint256 constant STATE_GAS_LIMIT = 9;

    event Approved(uint256 scope);

    VajraAccountV2 implementation;
    VajraAccountV2 account;
    address daily = makeAddr("daily");
    address payable harbor = payable(makeAddr("harbor"));

    uint256 commitment;
    uint256 nullifier;
    uint256[8] recoveryProof;
    uint256 firstNote;
    uint256 secondNote;
    uint256 nullifierHash;
    uint256[8] unshieldProof;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.chainId(CHAIN);
        string memory json = vm.readFile("test/vectors/zk.json");
        commitment = json.readUint(".commitment");
        nullifier = json.readUint(".nullifier");
        firstNote = json.readUint(".firstNote");
        secondNote = json.readUint(".secondNote");
        nullifierHash = json.readUint(".nullifierHash");
        uint256[] memory r = json.readUintArray(".recoveryProof");
        uint256[] memory u = json.readUintArray(".unshieldProof");
        for (uint256 i; i < 8; ++i) {
            recoveryProof[i] = r[i];
            unshieldProof[i] = u[i];
        }
        bytes memory poseidonCode = json.readBytes(".poseidon");
        address poseidon;
        assembly ("memory-safe") {
            poseidon := create(0, add(poseidonCode, 32), mload(poseidonCode))
        }
        implementation = new VajraAccountV2(
            4, 3, address(new ReviewStakeSink()), address(new RecoveryVerifier()), address(new ShieldVerifier()), poseidon, DENOM, MAX_PROOF_COST, WORK_BITS
        );
        vm.etch(helper(APPROVE), type(ReviewApproveDouble).runtimeCode);
        address at = json.readAddress(".account");
        vm.etch(at, abi.encodePacked(hex"363d3d373d3d3d363d73", address(implementation), hex"5af43d82803e903d91602b57fd5bf3"));
        account = VajraAccountV2(payable(at));

        address[] memory assets = new address[](1);
        uint128[] memory limits = new uint128[](1);
        limits[0] = 10 ether;
        uint128[] memory cooling = new uint128[](1);
        cooling[0] = 10 ether;
        account.initialize{value: 5 ether}(
            VajraAccountV2.Config({
                dailyKey: daily,
                wotsRoot: keccak256("first tree"),
                epochSalt: SALT,
                harborCommitment: keccak256(abi.encodePacked(address(harbor), keccak256("harbor salt"))),
                queueDelay: 1 days,
                coolingPeriod: 0,
                maxDailyTxCost: uint128(DAILY_CAP),
                assets: assets,
                dailyLimits: limits,
                coolingAllowances: cooling,
                coSigner: address(0),
                stake: 0,
                unstakeDelay: 0
            })
        );
    }

    function helper(uint256 nonce) private view returns (address) {
        return vm.computeCreateAddress(address(implementation), nonce);
    }

    function setTx(uint256 param, uint256 value) private {
        vm.mockCall(helper(TX_PARAM), abi.encode(param), abi.encode(value));
    }

    function setFrameAt(uint256 index, uint256 param, uint256 value) private {
        vm.mockCall(helper(FRAME_PARAM), abi.encode(index, param), abi.encode(value));
    }

    function setFrame(uint256 param, uint256 value) private {
        setFrameAt(1, param, value);
    }

    function setWord(uint256 offset, bytes32 word) private {
        vm.mockCall(helper(FRAME_DATA_LOAD), abi.encode(offset, uint256(1)), abi.encode(word));
    }

    function proofFrame(bytes4 selector, uint256 length, uint256 nonceKey, uint256 executionGas, uint256 stateGas) private {
        setFrame(EXECUTION_GAS_LIMIT, executionGas);
        setFrame(STATE_GAS_LIMIT, stateGas);
        setTx(CURRENT_FRAME, 0);
        setTx(FRAME_COUNT, 2);
        setTx(NONCE_KEY_COUNT, 1);
        setTx(NONCE_KEY_0, nonceKey);
        setTx(NONCE, 0);
        setTx(MAX_COST, 0.003 ether);
        setFrame(MODE, 2);
        setFrame(RESOLVED_TARGET, uint256(uint160(address(account))));
        setFrame(VALUE, 0);
        setFrame(DATA_LENGTH, length);
        setWord(0, bytes32(selector));
    }

    // ---------------------------------------------------------------- 1. proof of work --------------

    function workHash(uint256 root, uint256 recipient, bytes32 key, uint256 work) private view returns (uint256) {
        return uint256(keccak256(abi.encode(address(account), unshieldProof, key, root, nullifierHash, recipient, work)));
    }

    /// One solved `work` opens the pairing for the root, the nullifier and the recipient it was solved for. A variant has to solve its own.
    function test_oneWorkBuysOnePairing() public {
        vm.prank(address(account));
        account.shield{value: DENOM}(firstNote);
        uint256 olderRoot = account.poolRoot();
        account.shield{value: DENOM}(secondNote);
        uint256 newerRoot = account.poolRoot();

        bytes32 key = keccak256(abi.encodePacked(keccak256("vajra.unshield.v1"), nullifierHash));
        uint256 work;
        while (workHash(newerRoot, 1, key, work) >> (256 - WORK_BITS) != 0) work++;

        proofFrame(account.unshield.selector, 100, uint256(key), 500_000, 600_000);
        setWord(36, bytes32(nullifierHash));
        uint256 reached;
        uint256 lucky;
        for (uint256 i = 1; i <= 40; ++i) {
            uint256 root = i % 2 == 0 ? olderRoot : newerRoot;
            setWord(4, bytes32(root));
            setWord(68, bytes32(i));
            // About one variant in 1,024 solves by chance. That is the toll working, not a bypass.
            bool solved = workHash(root, i, key, work) >> (256 - WORK_BITS) == 0;
            if (solved) lucky++;
            uint256 before = gasleft();
            vm.expectRevert(solved ? VajraAccountV2.ShieldProofInvalid.selector : VajraAccountV2.ProofWorkMissing.selector);
            account.validateUnshield(unshieldProof, work);
            if (before - gasleft() > 100_000) reached++;
        }
        assertEq(reached, lucky, "only a solved variant reaches the pairing");
        assertEq(lucky, 1, "the one it was solved for");
    }

    /// The nullifier is in the hash on its own, and not only through the nonce key.
    function test_workDoesNotMoveToAnotherNullifier() public {
        vm.prank(address(account));
        account.shield{value: DENOM}(firstNote);
        uint256 root = account.poolRoot();
        uint256 other = nullifierHash + 1;
        bytes32 key = keccak256(abi.encodePacked(keccak256("vajra.unshield.v1"), other));
        uint256 work;
        while (workHash(root, 1, keccak256(abi.encodePacked(keccak256("vajra.unshield.v1"), nullifierHash)), work) >> (256 - WORK_BITS) != 0) work++;
        proofFrame(account.unshield.selector, 100, uint256(key), 500_000, 600_000);
        setWord(4, bytes32(root));
        setWord(36, bytes32(other));
        setWord(68, bytes32(uint256(1)));
        vm.expectRevert(VajraAccountV2.ProofWorkMissing.selector);
        account.validateUnshield(unshieldProof, work);
    }

    // ---------------------------------------------------------------- 2. what typed data leaves out ---

    function typedDigest(address to, uint256 amount, uint256 maxCost) private view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("VAJRA"),
                keccak256("2"),
                CHAIN,
                address(account)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                SPEND_TYPE, address(0), to, amount, uint256(5), uint256(2 gwei), uint256(1 gwei), uint256(500_000), uint256(700_000), VERIFY_GAS, maxCost
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function walletFrame(bytes32 signed, address to, uint256 amount, uint256 maxCost) private {
        vm.mockCall(helper(SIG_PARAM), abi.encode(uint256(0), uint256(0)), abi.encode(uint256(uint160(daily))));
        vm.mockCall(helper(SIG_PARAM), abi.encode(uint256(0), uint256(2)), abi.encode(signed));
        setTx(TX_SENDER, uint256(uint160(address(account))));
        setTx(NONCE_KEY_COUNT, 1);
        setTx(NONCE_KEY_0, 0);
        setTx(MAX_COST, maxCost);
        setTx(CURRENT_FRAME, 0);
        setTx(FRAME_COUNT, 2);
        setTx(NONCE, 5);
        setTx(MAX_FEE, 2 gwei);
        setTx(MAX_PRIORITY, 1 gwei);
        setFrameAt(0, EXECUTION_GAS_LIMIT, VERIFY_GAS);
        setFrame(MODE, 2);
        setFrame(RESOLVED_TARGET, uint256(uint160(address(account))));
        setFrame(VALUE, 0);
        setFrame(DATA_LENGTH, 100);
        setFrame(EXECUTION_GAS_LIMIT, 500_000);
        setFrame(STATE_GAS_LIMIT, 700_000);
        setWord(0, bytes32(account.spend.selector));
        setWord(4, bytes32(0));
        setWord(36, bytes32(uint256(uint160(to))));
        setWord(68, bytes32(amount));
    }

    /// Padding frame 0, or adding a signature entry, raises the maximum cost. The digest now holds that cost, so the copy dies in VERIFY.
    function test_typedCopyCannotRaiseTheCost() public {
        address to = makeAddr("payee");
        uint256 honestCost = (20_000 + 60_000 + 500_000 + 700_000) * uint256(2 gwei);
        bytes32 signed = typedDigest(to, 1 ether, honestCost);

        walletFrame(signed, to, 1 ether, honestCost);
        vm.expectEmit(address(account));
        emit Approved(3);
        account.validateDaily(VajraScope.EXECUTION_AND_PAYMENT);

        // The stranger's copy: nothing re-signed.
        setTx(MAX_COST, DAILY_CAP);
        vm.expectRevert(VajraAccountV2.SignatureNotBoundToTransaction.selector);
        account.validateDaily(VajraScope.EXECUTION_AND_PAYMENT);

        // One wei is enough. A copy cannot raise the cost by anything.
        setTx(MAX_COST, honestCost + 1);
        vm.expectRevert(VajraAccountV2.SignatureNotBoundToTransaction.selector);
        account.validateDaily(VajraScope.EXECUTION_AND_PAYMENT);
    }

    /// The trade that keeps MAX_COST: padding paid for by cutting frame 0's limit. It would turn unused VERIFY gas into gas burned, inside
    /// the signed cost, and nothing in MAX_COST would show it. So frame 0's limit is signed too.
    function test_typedCopyCannotTradeVerifyGasForPadding() public {
        address to = makeAddr("payee");
        uint256 cost = 0.003 ether;
        walletFrame(typedDigest(to, 1 ether, cost), to, 1 ether, cost);
        setFrameAt(0, EXECUTION_GAS_LIMIT, VERIFY_GAS - 30_000);
        vm.expectRevert(VajraAccountV2.SignatureNotBoundToTransaction.selector);
        account.validateDaily(VajraScope.EXECUTION_AND_PAYMENT);
    }

    /// APPROVE takes MAX_COST from the balance and refunds only at the end of the transaction. A near-full-balance spend that fits under
    /// the signed cost cannot now be made to revert, because a copy under a higher cost never gets past VERIFY.
    function test_typedCopyCannotMakeTheSenderFrameFail() public {
        address to = makeAddr("payee");
        uint256 honestCost = 0.003 ether;
        uint256 amount = 4.99 ether;
        bytes32 signed = typedDigest(to, amount, honestCost);

        // The copy: same signature, higher cost. It is what used to pass here and revert in the SENDER frame.
        walletFrame(signed, to, amount, DAILY_CAP);
        vm.expectRevert(VajraAccountV2.SignatureNotBoundToTransaction.selector);
        account.validateDaily(VajraScope.EXECUTION_AND_PAYMENT);

        // Honest: VERIFY passes, the balance is debited the signed cost, and the spend goes through.
        walletFrame(signed, to, amount, honestCost);
        account.validateDaily(VajraScope.EXECUTION_AND_PAYMENT);
        vm.deal(address(account), 5 ether - honestCost);
        vm.prank(address(account));
        account.spend(address(0), to, amount);
        assertEq(to.balance, amount);
    }

    // ---------------------------------------------------------------- 3. the exit's reserve ---------

    function exitWithRecovery() private returns (VajraExit exit) {
        VajraExit exitImplementation = new VajraExit(4, 3, account.STAKING_REGISTRY());
        VajraExitFactory factory = new VajraExitFactory(address(exitImplementation));
        exit = VajraExit(payable(factory.create{value: 0.006 ether}(address(account), keccak256("exit tree"), SALT, 0, 0)));
        vm.etch(vm.computeCreateAddress(address(exitImplementation), APPROVE), type(ReviewApproveDouble).runtimeCode);
        vm.mockCall(
            vm.computeCreateAddress(address(exitImplementation), TX_PARAM), abi.encode(TX_SENDER), abi.encode(uint256(uint160(address(exit))))
        );

        vm.startPrank(address(account));
        account.setExit(address(exit));
        account.setRecovery(commitment, 2 days, GATE);
        vm.stopPrank();

        uint256 key = uint256(keccak256(abi.encodePacked(keccak256("vajra.recovery.v1"), nullifier, NEW_ROOT)));
        proofFrame(account.queueRecovery.selector, 68, key, 200_000, 800_000);
        setWord(4, NEW_ROOT);
        setWord(36, bytes32(nullifier));
        setTx(MAX_COST, MAX_PROOF_COST);
    }

    /// A recovery sent from the account shows its proof and ticket. That ticket is the hash of the exit's, so a stranger who resends the
    /// proof from the exit has nothing to put there, and the reserve pays nothing.
    function test_strangerCannotRerouteARecoveryOntoTheReserve() public {
        VajraExit exit = exitWithRecovery();
        vm.expectRevert(VajraAccountV2.RecoveryGateInvalid.selector);
        exit.validateRecovery(recoveryProof, TICKET);
    }

    /// The paper can still use the exit, which is what an owner banned from the account's route needs.
    function test_thePaperStillRecoversFromTheExit() public {
        VajraExit exit = exitWithRecovery();
        vm.expectEmit(address(exit));
        emit Approved(3);
        exit.validateRecovery(recoveryProof, EXIT_TICKET);
    }

    // ---------------------------------------------------------------- 4. sponsorship on V2 ---------

    address paymaster = makeAddr("named paymaster");

    function sponsoredFrames() private {
        walletFrame(bytes32(0), address(0), 0, 0.003 ether);
        setTx(FRAME_COUNT, 5);
        setFrameAt(1, MODE, 0);
        setFrameAt(1, RESOLVED_TARGET, uint256(uint160(paymaster)));
        setFrameAt(2, MODE, 1);
        setFrameAt(3, MODE, 2);
        setFrameAt(3, RESOLVED_TARGET, uint256(uint160(address(account))));
        setFrameAt(3, VALUE, 0);
        vm.mockCall(helper(FRAME_DATA_LOAD), abi.encode(uint256(0), uint256(3)), abi.encode(bytes32(account.spend.selector)));
        setFrameAt(4, MODE, 0);
        setFrameAt(4, RESOLVED_TARGET, uint256(uint160(paymaster)));
    }

    function name(address sponsor) private {
        vm.prank(address(account));
        account.setSponsor(sponsor, true);
    }

    function refusesFrame(uint256 frame) private {
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.FrameNotAllowed.selector, frame));
        account.validateDaily(VajraScope.EXECUTION);
    }

    /// `[only_verify, charge, pay, SENDER, settle]`, to a paymaster the master key named.
    function test_sponsored_namedPaymasterIsApproved() public {
        name(paymaster);
        sponsoredFrames();
        vm.expectEmit(address(account));
        emit Approved(2);
        account.validateDaily(VajraScope.EXECUTION);
    }

    /// With nothing named, a daily signature approves exactly what it did before.
    function test_sponsored_refusedUntilTheMasterKeyNamesAPaymaster() public {
        sponsoredFrames();
        refusesFrame(1);
    }

    function test_sponsored_onlyTheMasterKeyCanNameOne() public {
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.setSponsor(paymaster, true);
    }

    function test_sponsored_aNamedPaymasterCanBeRemoved() public {
        name(paymaster);
        vm.prank(address(account));
        account.setSponsor(paymaster, false);
        assertFalse(account.sponsors(paymaster));
        sponsoredFrames();
        refusesFrame(1);
    }

    function test_sponsored_settleOnAnUnnamedContractIsRefused() public {
        name(paymaster);
        sponsoredFrames();
        setFrameAt(4, RESOLVED_TARGET, uint256(uint160(makeAddr("somewhere else"))));
        refusesFrame(4);
    }

    /// A stolen key adding collect frames in the body, to burn the approval.
    function test_sponsored_noDefaultFrameInTheBody() public {
        name(paymaster);
        sponsoredFrames();
        setFrameAt(3, MODE, 0);
        setFrameAt(3, RESOLVED_TARGET, uint256(uint160(paymaster)));
        refusesFrame(3);
    }

    /// The body is still walked: a sponsored transaction reaches nothing a paid one cannot.
    function test_sponsored_theBodyStaysOnTheRulebook() public {
        name(paymaster);
        sponsoredFrames();
        vm.mockCall(helper(FRAME_DATA_LOAD), abi.encode(uint256(0), uint256(3)), abi.encode(bytes32(account.setDailyKey.selector)));
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.EscapeKeyOutranks.selector, account.setDailyKey.selector));
        account.validateDaily(VajraScope.EXECUTION);
    }

    function test_sponsored_aBodyFrameCannotTargetThePaymaster() public {
        name(paymaster);
        sponsoredFrames();
        setFrameAt(3, RESOLVED_TARGET, uint256(uint160(paymaster)));
        refusesFrame(3);
    }

    /// An account that pays for itself has no use for a DEFAULT frame.
    function test_sponsored_notWhenTheAccountPays() public {
        name(paymaster);
        sponsoredFrames();
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.FrameNotAllowed.selector, uint256(1)));
        account.validateDaily(VajraScope.EXECUTION_AND_PAYMENT);
    }

    function test_sponsored_onlyWithTheDailyFrameFirst() public {
        name(paymaster);
        sponsoredFrames();
        setTx(CURRENT_FRAME, 1);
        setFrameAt(2, MODE, 0);
        setFrameAt(2, RESOLVED_TARGET, uint256(uint160(paymaster)));
        refusesFrame(2);
    }

    /// What a paymaster takes for gas is held to the same cap as what the account pays itself.
    function test_sponsored_costCapHolds() public {
        name(paymaster);
        sponsoredFrames();
        setTx(MAX_COST, DAILY_CAP + 1);
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.DailyTxCostExceeded.selector, DAILY_CAP + 1));
        account.validateDaily(VajraScope.EXECUTION);
    }

    /// A wallet's signature is pinned to `[VERIFY, SENDER]`, so a stranger cannot wrap it in a sponsored shape.
    function test_sponsored_aWalletSignatureCannotBeWrapped() public {
        name(paymaster);
        sponsoredFrames();
        vm.mockCall(helper(SIG_PARAM), abi.encode(uint256(0), uint256(2)), abi.encode(typedDigest(address(0), 0, 0.003 ether)));
        vm.expectRevert(VajraAccountV2.SignatureNotBoundToTransaction.selector);
        account.validateDaily(VajraScope.EXECUTION);
    }
}
