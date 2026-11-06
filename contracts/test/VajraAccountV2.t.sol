// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, stdJson} from "forge-std/Test.sol";
import {VajraAccountV2} from "../src/VajraAccountV2.sol";
import {RecoveryVerifier} from "../src/verifiers/RecoveryVerifier.sol";
import {ShieldVerifier} from "../src/verifiers/ShieldVerifier.sol";
import {Scope as VajraScope} from "@forshtat/hegota-support/contracts/Params.sol";

contract StakeSink {
    function addStake(uint32) external payable {}
}

/// Stands in for the APPROVE helper. A real one ends the frame; this leaves a mark the test can see.
contract ApproveDouble {
    event Approved(uint256 scope);

    fallback() external {
        emit Approved(abi.decode(msg.data, (uint256)));
    }
}

/// Recovery and the pool, with real Groth16 proofs through the generated verifiers.
///
/// VERIFY needs the frame opcodes, which Foundry does not have. The account reaches them through helper contracts at
/// addresses fixed by its own CREATE nonces, so here each read is answered at that address. The verifiers, the proofs, and
/// every line of the account are real. The same paths run against the real client in `vajra recover` and `vajra shielded`.
contract VajraAccountV2Test is Test {
    using stdJson for string;

    uint256 constant DENOM = 0.1 ether;
    uint256 constant MAX_PROOF_COST = 0.005 ether;
    uint256 constant CHAIN = 13370;
    bytes32 constant SALT = 0xabababababababababababababababababababababababababababababababab;
    bytes32 constant NEW_ROOT = 0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd;
    bytes32 constant ROOT = keccak256("first tree");
    bytes32 constant HARBOR_SALT = keccak256("harbor salt");
    uint64 constant DELAY = 2 days;
    /// `PROOF_VERIFY_GAS` in packages/core/src/zk.ts.
    uint256 constant PROOF_FRAME_GAS = 500_000;

    // Helper order in HegotaSupport's constructor. TxTrace and EventDataCopy have no code on this devnet.
    uint256 constant APPROVE = 1;
    uint256 constant TX_PARAM = 2;
    uint256 constant FRAME_DATA_LOAD = 3;
    uint256 constant FRAME_PARAM = 5;
    uint256 constant SIG_PARAM = 6;

    // TxParam and FrameParam ids.
    uint256 constant NONCE = 1;
    uint256 constant MAX_COST = 6;
    uint256 constant FRAME_COUNT = 9;
    uint256 constant CURRENT_FRAME = 10;
    uint256 constant NONCE_KEY_COUNT = 14;
    uint256 constant NONCE_KEY_0 = 16;
    uint256 constant RESOLVED_TARGET = 0;
    uint256 constant EXECUTION_GAS_LIMIT = 1;
    uint256 constant STATE_GAS_LIMIT = 9;
    uint256 constant MODE = 2;
    uint256 constant DATA_LENGTH = 4;
    uint256 constant VALUE = 8;

    event Approved(uint256 scope);

    VajraAccountV2 implementation;
    VajraAccountV2 account;
    address payable harbor = payable(makeAddr("harbor"));
    address thief = makeAddr("thief");
    address daily = makeAddr("daily");

    uint256 commitment;
    uint256 nullifier;
    uint256[8] recoveryProof;
    uint256 firstNote;
    uint256 secondNote;
    uint256 poolRoot;
    uint256 nullifierHash;
    uint256[8] unshieldProof;
    address recipient;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.chainId(CHAIN);
        string memory json = vm.readFile("test/vectors/zk.json");
        commitment = json.readUint(".commitment");
        nullifier = json.readUint(".nullifier");
        firstNote = json.readUint(".firstNote");
        secondNote = json.readUint(".secondNote");
        poolRoot = json.readUint(".poolRoot");
        nullifierHash = json.readUint(".nullifierHash");
        recipient = json.readAddress(".recipient");
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
            4, 3, address(new StakeSink()), address(new RecoveryVerifier()), address(new ShieldVerifier()), poseidon, DENOM, MAX_PROOF_COST
        );
        vm.etch(helper(APPROVE), type(ApproveDouble).runtimeCode);

        // The proofs commit to a fixed address, so the clone goes there.
        address at = json.readAddress(".account");
        vm.etch(at, abi.encodePacked(hex"363d3d373d3d3d363d73", address(implementation), hex"5af43d82803e903d91602b57fd5bf3"));
        account = VajraAccountV2(payable(at));

        address[] memory assets = new address[](1);
        uint128[] memory limits = new uint128[](1);
        limits[0] = 1 ether;
        uint128[] memory cooling = new uint128[](1);
        cooling[0] = 1 ether;
        VajraAccountV2.Config memory config = VajraAccountV2.Config({
            dailyKey: daily,
            wotsRoot: ROOT,
            epochSalt: SALT,
            harborCommitment: keccak256(abi.encodePacked(address(harbor), HARBOR_SALT)),
            queueDelay: 1 days,
            coolingPeriod: 0,
            maxDailyTxCost: 0.05 ether,
            assets: assets,
            dailyLimits: limits,
            coolingAllowances: cooling,
            coSigner: address(0),
            stake: 0,
            unstakeDelay: 0
        });
        account.initialize{value: 5 ether}(config);
    }

    // ------------------------------------------------------------------ the frame, faked ----

    function helper(uint256 nonce) private view returns (address) {
        return vm.computeCreateAddress(address(implementation), nonce);
    }

    function setTx(uint256 param, uint256 value) private {
        vm.mockCall(helper(TX_PARAM), abi.encode(param), abi.encode(value));
    }

    function setFrame(uint256 param, uint256 value) private {
        vm.mockCall(helper(FRAME_PARAM), abi.encode(uint256(1), param), abi.encode(value));
    }

    function setWord(uint256 offset, bytes32 word) private {
        vm.mockCall(helper(FRAME_DATA_LOAD), abi.encode(offset, uint256(1)), abi.encode(word));
    }

    /// An honest `[VERIFY, SENDER]` proof transaction.
    function frameFor(bytes4 selector, uint256 length, uint256 nonceKey, uint256 executionGas, uint256 stateGas) private {
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

    function recoveryFrame() private {
        uint256 key = uint256(keccak256(abi.encodePacked(keccak256("vajra.recovery.v1"), nullifier, NEW_ROOT)));
        frameFor(account.queueRecovery.selector, 68, key, 200_000, 800_000);
        setWord(4, NEW_ROOT);
        setWord(36, bytes32(nullifier));
    }

    function unshieldFrame() private {
        uint256 key = uint256(keccak256(abi.encodePacked(keccak256("vajra.unshield.v1"), nullifierHash, uint256(uint160(recipient)))));
        frameFor(account.unshield.selector, 100, key, 500_000, 600_000);
        setWord(4, bytes32(poolRoot));
        setWord(36, bytes32(nullifierHash));
        setWord(68, bytes32(uint256(uint160(recipient))));
    }

    function asSelf() private {
        vm.prank(address(account));
    }

    function setRecovery() private {
        asSelf();
        account.setRecovery(commitment, DELAY);
    }

    /// The owner opens the pool, and an outsider pays in after.
    function openPool(uint256 note) private {
        vm.prank(address(account));
        account.shield{value: DENOM}(note);
    }

    function shieldBoth() private {
        openPool(firstNote);
        account.shield{value: DENOM}(secondNote);
    }

    function expectApproved() private {
        vm.expectEmit(address(account));
        emit Approved(3);
    }

    function queue() private returns (uint256 id) {
        id = account.nextItem();
        asSelf();
        account.queueRecovery(NEW_ROOT, nullifier);
    }

    // ----------------------------------------------------------------- recovery: VERIFY ----

    function test_recovery_aRealProofIsApproved() public {
        setRecovery();
        recoveryFrame();
        expectApproved();
        account.validateRecovery(recoveryProof);
    }

    function test_recovery_refusedBeforeACommitmentExists() public {
        recoveryFrame();
        vm.expectRevert(VajraAccountV2.RecoveryNotSet.selector);
        account.validateRecovery(recoveryProof);
    }

    function test_recovery_refusesACorruptedProof() public {
        setRecovery();
        recoveryFrame();
        uint256[8] memory bent = recoveryProof;
        bent[0] += 1;
        vm.expectRevert(VajraAccountV2.RecoveryProofInvalid.selector);
        account.validateRecovery{gas: PROOF_FRAME_GAS}(bent);
    }

    function test_recovery_everyWordOfTheProofMatters() public {
        setRecovery();
        recoveryFrame();
        for (uint256 i; i < 8; ++i) {
            uint256[8] memory bent = recoveryProof;
            bent[i] ^= 1;
            vm.expectRevert(VajraAccountV2.RecoveryProofInvalid.selector);
            // A point off the curve makes the precompile burn all it is given, so each try gets a frame's worth, as on chain.
            account.validateRecovery{gas: PROOF_FRAME_GAS}(bent);
        }
    }

    function test_recovery_proofIsBoundToTheRoot() public {
        setRecovery();
        recoveryFrame();
        bytes32 attacker = keccak256("attacker's tree");
        setWord(4, attacker);
        // With the nonce key to match, so that it is the proof that stops this.
        setTx(NONCE_KEY_0, uint256(keccak256(abi.encodePacked(keccak256("vajra.recovery.v1"), nullifier, attacker))));
        vm.expectRevert(VajraAccountV2.RecoveryProofInvalid.selector);
        account.validateRecovery(recoveryProof);
    }

    function test_recovery_proofIsBoundToTheCommitment() public {
        asSelf();
        account.setRecovery(commitment + 1, DELAY);
        recoveryFrame();
        vm.expectRevert(VajraAccountV2.RecoveryProofInvalid.selector);
        account.validateRecovery(recoveryProof);
    }

    function test_recovery_proofIsBoundToTheChain() public {
        setRecovery();
        recoveryFrame();
        vm.chainId(1);
        vm.expectRevert(VajraAccountV2.RecoveryProofInvalid.selector);
        account.validateRecovery(recoveryProof);
    }

    function test_recovery_proofIsBoundToTheNullifier() public {
        setRecovery();
        uint256 other = nullifier + 1;
        recoveryFrame();
        setWord(36, bytes32(other));
        setTx(NONCE_KEY_0, uint256(keccak256(abi.encodePacked(keccak256("vajra.recovery.v1"), other, NEW_ROOT))));
        vm.expectRevert(VajraAccountV2.RecoveryProofInvalid.selector);
        account.validateRecovery(recoveryProof);
    }

    function test_recovery_refusesASpentNullifier() public {
        setRecovery();
        queue();
        recoveryFrame();
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.NullifierSpent.selector, nullifier));
        account.validateRecovery(recoveryProof);
    }

    function test_recovery_worksWhileFrozen() public {
        setRecovery();
        asSelf();
        account.freeze();
        recoveryFrame();
        expectApproved();
        account.validateRecovery(recoveryProof);
    }

    // The shape a signature would have pinned. One test each, because any one left open is a way to drain the account.

    function shapeRefused() private {
        vm.expectRevert(VajraAccountV2.ProofTxShapeInvalid.selector);
        account.validateRecovery(recoveryProof);
    }

    function test_shape_refusesAnAddedFrame() public {
        setRecovery();
        recoveryFrame();
        setTx(FRAME_COUNT, 3);
        shapeRefused();
    }

    function test_shape_refusesAVerifyFrameThatIsNotFirst() public {
        setRecovery();
        recoveryFrame();
        setTx(CURRENT_FRAME, 1);
        shapeRefused();
    }

    function test_shape_refusesASecondFrameThatIsNotSender() public {
        setRecovery();
        recoveryFrame();
        setFrame(MODE, 1);
        shapeRefused();
    }

    function test_shape_refusesAnotherTarget() public {
        setRecovery();
        recoveryFrame();
        setFrame(RESOLVED_TARGET, uint256(uint160(thief)));
        shapeRefused();
    }

    function test_shape_refusesValueInTheFrame() public {
        setRecovery();
        recoveryFrame();
        setFrame(VALUE, 1);
        shapeRefused();
    }

    function test_shape_refusesExtraCalldata() public {
        setRecovery();
        recoveryFrame();
        setFrame(DATA_LENGTH, 100);
        shapeRefused();
    }

    function test_shape_refusesAnotherFunction() public {
        setRecovery();
        recoveryFrame();
        setWord(0, bytes32(account.escape.selector));
        shapeRefused();
    }

    function test_shape_refusesAnotherNonceKey() public {
        setRecovery();
        recoveryFrame();
        setTx(NONCE_KEY_0, 12345);
        shapeRefused();
    }

    function test_shape_refusesTwoNonceKeys() public {
        setRecovery();
        recoveryFrame();
        setTx(NONCE_KEY_COUNT, 2);
        shapeRefused();
    }

    function test_shape_refusesALaterNonce() public {
        setRecovery();
        recoveryFrame();
        setTx(NONCE, 1);
        shapeRefused();
    }

    // A copy with less gas passes the proof and spends the nonce, and its SENDER frame fails: mined, and dead for good.
    function test_shape_refusesLessExecutionGas() public {
        setRecovery();
        recoveryFrame();
        setFrame(EXECUTION_GAS_LIMIT, 1000);
        shapeRefused();
    }

    function test_shape_refusesLessStateGas() public {
        setRecovery();
        recoveryFrame();
        setFrame(STATE_GAS_LIMIT, 0);
        shapeRefused();
    }

    function test_shape_refusesMoreGas() public {
        setRecovery();
        recoveryFrame();
        setFrame(EXECUTION_GAS_LIMIT, 200_001);
        shapeRefused();
    }

    function test_shape_unshieldRefusesLessGas() public {
        shieldBoth();
        unshieldFrame();
        setFrame(EXECUTION_GAS_LIMIT, 1000);
        vm.expectRevert(VajraAccountV2.ProofTxShapeInvalid.selector);
        account.validateUnshield(unshieldProof);
        unshieldFrame();
        setFrame(STATE_GAS_LIMIT, 0);
        vm.expectRevert(VajraAccountV2.ProofTxShapeInvalid.selector);
        account.validateUnshield(unshieldProof);
    }

    function test_recovery_refusesAnEmptyRootInVerify() public {
        setRecovery();
        recoveryFrame();
        setWord(4, bytes32(0));
        vm.expectRevert(VajraAccountV2.RootRequired.selector);
        account.validateRecovery(recoveryProof);
    }

    function test_recovery_feeCannotEatTheNotes() public {
        setRecovery();
        shieldBoth();
        drainTo(0.001 ether);
        recoveryFrame();
        setTx(MAX_COST, 0.001 ether + 1);
        vm.expectRevert(VajraAccountV2.ValueNotConserved.selector);
        account.validateRecovery(recoveryProof);
    }

    // ------------------------------------------------- the daily key stays on the linear nonce ----

    function dailyFrame(uint256 count, uint256 key) private {
        vm.mockCall(helper(SIG_PARAM), abi.encode(uint256(0), uint256(0)), abi.encode(uint256(uint160(daily))));
        vm.mockCall(helper(SIG_PARAM), abi.encode(uint256(0), uint256(2)), abi.encode(uint256(0)));
        setTx(NONCE_KEY_COUNT, count);
        setTx(NONCE_KEY_0, key);
        setTx(MAX_COST, 0.001 ether);
        setTx(CURRENT_FRAME, 0);
        setTx(FRAME_COUNT, 1);
    }

    function test_daily_isApprovedOnTheLinearNonce() public {
        dailyFrame(1, 0);
        expectApproved();
        account.validateDaily(VajraScope.EXECUTION_AND_PAYMENT);
    }

    function test_daily_cannotBurnAMasterLeaf() public {
        dailyFrame(1, uint256(keccak256(abi.encodePacked(ROOT, uint8(0)))));
        vm.expectRevert(VajraAccountV2.DailyNonceKeyInvalid.selector);
        account.validateDaily(VajraScope.EXECUTION_AND_PAYMENT);
    }

    function test_daily_cannotBurnASecondKeyBehindTheLinearOne() public {
        dailyFrame(2, 0);
        vm.expectRevert(VajraAccountV2.DailyNonceKeyInvalid.selector);
        account.validateDaily(VajraScope.EXECUTION_AND_PAYMENT);
    }

    function test_shape_refusesAFeeOverTheCap() public {
        setRecovery();
        recoveryFrame();
        setTx(MAX_COST, MAX_PROOF_COST + 1);
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.ProofTxCostExceeded.selector, MAX_PROOF_COST + 1));
        account.validateRecovery(recoveryProof);
    }

    // ------------------------------------------------------------------- recovery: queue ----

    function test_queueRecovery_goesInTheSharedQueue() public {
        setRecovery();
        uint256 id = queue();
        VajraAccountV2.QueuedItem memory item = account.queuedItem(id);
        assertEq(item.amount, uint256(NEW_ROOT));
        assertEq(item.executeAfter, uint64(block.timestamp) + DELAY);
        assertTrue(account.isRecovery(id));
        assertTrue(account.recoverySpent(nullifier));
        assertEq(account.wotsRoot(), ROOT);
    }

    function test_queueRecovery_refusesOutsiders() public {
        vm.prank(thief);
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.queueRecovery(NEW_ROOT, nullifier);
    }

    function test_setRecovery_refusesACommitmentOutsideTheField() public {
        asSelf();
        vm.expectRevert(VajraAccountV2.CommitmentInvalid.selector);
        account.setRecovery(type(uint256).max, DELAY);
    }

    function test_setRecovery_refusesNoVetoWindow() public {
        asSelf();
        vm.expectRevert(VajraAccountV2.RecoveryDelayRequired.selector);
        account.setRecovery(commitment, 0);
    }

    function test_setRecovery_zeroTurnsItOff() public {
        setRecovery();
        asSelf();
        account.setRecovery(0, 0);
        assertEq(account.recoveryCommitment(), 0);
    }

    function test_setRecovery_refusesOutsiders() public {
        vm.prank(thief);
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.setRecovery(1, 0);
    }

    function test_queueRecovery_refusesAReplay() public {
        setRecovery();
        queue();
        asSelf();
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.NullifierSpent.selector, nullifier));
        account.queueRecovery(keccak256("again"), nullifier);
    }

    function test_queueRecovery_refusesAnEmptyRoot() public {
        setRecovery();
        asSelf();
        vm.expectRevert(VajraAccountV2.RootRequired.selector);
        account.queueRecovery(bytes32(0), nullifier);
    }

    function test_recovery_installsAfterTheDelay_byAnyone() public {
        setRecovery();
        uint256 id = queue();
        vm.warp(block.timestamp + DELAY);
        vm.prank(thief);
        account.executeQueued(id);
        assertEq(account.wotsRoot(), NEW_ROOT);
    }

    function test_recovery_doesNotInstallEarly() public {
        setRecovery();
        uint256 id = queue();
        vm.warp(block.timestamp + DELAY - 1);
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.QueuedPendingTimelock.selector, account.queuedItem(id).executeAfter));
        account.executeQueued(id);
    }

    function test_recovery_vetoIsFinal() public {
        setRecovery();
        uint256 id = queue();
        asSelf();
        account.veto(id);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.RecoveryVetoed.selector, id));
        account.executeQueued(id);
        assertEq(account.wotsRoot(), ROOT);
    }

    function test_recovery_installsWhileFrozen_butSpendsDoNot() public {
        setRecovery();
        uint256 id = queue();
        asSelf();
        account.spend(address(0), thief, 2 ether);
        uint256 spend = account.nextItem() - 1;
        asSelf();
        account.freeze();
        vm.warp(block.timestamp + DELAY);
        account.executeQueued(id);
        assertEq(account.wotsRoot(), NEW_ROOT);
        vm.expectRevert(VajraAccountV2.AccountFrozen.selector);
        account.executeQueued(spend);
    }

    function test_recovery_cannotBeExecutedTwice() public {
        setRecovery();
        uint256 id = queue();
        vm.warp(block.timestamp + DELAY);
        account.executeQueued(id);
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.ItemNotPending.selector, id));
        account.executeQueued(id);
    }

    function test_recovery_aSpendWithTheRootAsItsAmountStaysASpend() public {
        // A spend is never read as a root, whatever its amount: only `queueRecovery` marks an item.
        asSelf();
        account.spend(address(0), thief, 2 ether);
        uint256 id = account.nextItem() - 1;
        assertFalse(account.isRecovery(id));
    }

    // --------------------------------------------------------------------- pool: shield ----

    function test_shield_matchesTheCircuitsTree() public {
        shieldBoth();
        assertEq(account.poolRoot(), poolRoot);
        assertEq(account.poolHeld(), 2 * DENOM);
        assertEq(account.noteCount(), 2);
    }

    function test_shield_onlyTheOwnerOpensThePool() public {
        vm.expectRevert(VajraAccountV2.PoolClosed.selector);
        account.shield{value: DENOM}(firstNote);
    }

    function test_shield_refusesTheWrongValue() public {
        openPool(firstNote);
        vm.expectRevert(VajraAccountV2.ValueNotConserved.selector);
        account.shield{value: DENOM - 1}(secondNote);
        vm.expectRevert(VajraAccountV2.ValueNotConserved.selector);
        account.shield{value: DENOM + 1}(secondNote);
    }

    function test_shield_refusesABadCommitment() public {
        openPool(firstNote);
        vm.expectRevert(VajraAccountV2.CommitmentInvalid.selector);
        account.shield{value: DENOM}(0);
        vm.expectRevert(VajraAccountV2.CommitmentInvalid.selector);
        account.shield{value: DENOM}(type(uint256).max);
    }

    function test_shield_refusedWhileFrozen() public {
        asSelf();
        account.freeze();
        vm.expectRevert(VajraAccountV2.AccountFrozen.selector);
        account.shield{value: DENOM}(firstNote);
    }

    function test_rootRing_keepsThe32Newest() public {
        openPool(firstNote);
        uint256 oldest = account.poolRoot();
        for (uint256 i; i < 31; ++i) {
            account.shield{value: DENOM}(firstNote + 1 + i);
        }
        assertTrue(account.isKnownRoot(oldest));
        account.shield{value: DENOM}(firstNote + 100);
        assertFalse(account.isKnownRoot(oldest));
        assertFalse(account.isKnownRoot(0));
    }

    // ------------------------------------------------------------------- pool: unshield ----

    function test_unshield_aRealProofIsApproved() public {
        shieldBoth();
        unshieldFrame();
        expectApproved();
        account.validateUnshield(unshieldProof);
    }

    function test_unshield_refusedWhileFrozen() public {
        shieldBoth();
        unshieldFrame();
        asSelf();
        account.freeze();
        vm.expectRevert(VajraAccountV2.AccountFrozen.selector);
        account.validateUnshield(unshieldProof);
    }

    function test_unshield_refusesAnUnknownRoot() public {
        openPool(firstNote);
        unshieldFrame();
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.RootUnknown.selector, poolRoot));
        account.validateUnshield(unshieldProof);
    }

    function test_unshield_refusesARootThatLeftTheRing() public {
        shieldBoth();
        for (uint256 i; i < 32; ++i) {
            account.shield{value: DENOM}(firstNote + 1 + i);
        }
        unshieldFrame();
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.RootUnknown.selector, poolRoot));
        account.validateUnshield(unshieldProof);
    }

    function test_unshield_acceptsARootDeepInTheRing() public {
        shieldBoth();
        for (uint256 i; i < 31; ++i) {
            account.shield{value: DENOM}(firstNote + 1 + i);
        }
        unshieldFrame();
        expectApproved();
        account.validateUnshield(unshieldProof);
    }

    function test_unshield_everyWordOfTheProofMatters() public {
        shieldBoth();
        unshieldFrame();
        for (uint256 i; i < 8; ++i) {
            uint256[8] memory bent = unshieldProof;
            bent[i] ^= 1;
            vm.expectRevert(VajraAccountV2.ShieldProofInvalid.selector);
            account.validateUnshield{gas: PROOF_FRAME_GAS}(bent);
        }
    }

    function test_unshield_proofIsBoundToTheRecipient() public {
        shieldBoth();
        unshieldFrame();
        setWord(68, bytes32(uint256(uint160(thief))));
        setTx(NONCE_KEY_0, uint256(keccak256(abi.encodePacked(keccak256("vajra.unshield.v1"), nullifierHash, uint256(uint160(thief))))));
        vm.expectRevert(VajraAccountV2.ShieldProofInvalid.selector);
        account.validateUnshield(unshieldProof);
    }

    function test_unshield_proofIsBoundToTheChain() public {
        shieldBoth();
        unshieldFrame();
        vm.chainId(1);
        vm.expectRevert(VajraAccountV2.ShieldProofInvalid.selector);
        account.validateUnshield(unshieldProof);
    }

    function test_unshield_refusesASpentNote() public {
        shieldBoth();
        asSelf();
        account.unshield(poolRoot, nullifierHash, recipient);
        unshieldFrame();
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.NullifierSpent.selector, nullifierHash));
        account.validateUnshield(unshieldProof);
    }

    function test_unshield_refusesAnAddedFrame() public {
        shieldBoth();
        unshieldFrame();
        setTx(FRAME_COUNT, 3);
        vm.expectRevert(VajraAccountV2.ProofTxShapeInvalid.selector);
        account.validateUnshield(unshieldProof);
    }

    function test_unshield_paysOneNoteLessItsFee() public {
        shieldBoth();
        asSelf();
        account.unshield(poolRoot, nullifierHash, recipient);
        assertEq(recipient.balance, DENOM - MAX_PROOF_COST);
        assertEq(account.poolHeld(), DENOM);
        assertTrue(account.noteSpent(nullifierHash));
    }

    function test_unshield_refusesASecondSpendInTheSenderFrame() public {
        shieldBoth();
        asSelf();
        account.unshield(poolRoot, nullifierHash, recipient);
        asSelf();
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.NullifierSpent.selector, nullifierHash));
        account.unshield(poolRoot, nullifierHash, recipient);
    }

    function test_unshield_refusesOutsiders() public {
        shieldBoth();
        vm.prank(thief);
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.unshield(poolRoot, nullifierHash, thief);
    }

    function test_unshield_senderFrameAlsoStopsOnAFreeze() public {
        shieldBoth();
        asSelf();
        account.freeze();
        asSelf();
        vm.expectRevert(VajraAccountV2.AccountFrozen.selector);
        account.unshield(poolRoot, nullifierHash, recipient);
    }

    function test_unshield_senderFrameRefusesAnUnknownRoot() public {
        shieldBoth();
        asSelf();
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.RootUnknown.selector, uint256(1)));
        account.unshield(1, nullifierHash, recipient);
    }

    // ---------------------------------------------------- conservation, freeze and escape ----

    /// Leaves the account with `free` wei that are not owed to notes.
    function drainTo(uint256 free) private {
        uint256 excess = address(account).balance - account.poolHeld() - free;
        vm.deal(address(account), address(account).balance - excess);
    }

    function test_conservation_aSpendCannotTouchTheNotes() public {
        shieldBoth();
        drainTo(0.1 ether);
        asSelf();
        vm.expectRevert(VajraAccountV2.ValueNotConserved.selector);
        account.spend(address(0), thief, 0.1 ether + 1);
        asSelf();
        account.spend(address(0), thief, 0.1 ether);
        assertEq(address(account).balance, 2 * DENOM);
    }

    function test_conservation_aQueuedSpendCannotTouchTheNotes() public {
        asSelf();
        account.spend(address(0), thief, 2 ether);
        uint256 id = account.nextItem() - 1;
        shieldBoth();
        drainTo(1 ether);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(VajraAccountV2.ValueNotConserved.selector);
        account.executeQueued(id);
    }

    function test_conservation_aNoteCarriesItsOwnFee() public {
        // No free balance at all, and the note can still leave, and the rest of the pool stays whole.
        shieldBoth();
        drainTo(0);
        unshieldFrame();
        setTx(MAX_COST, MAX_PROOF_COST);
        expectApproved();
        account.validateUnshield(unshieldProof);
        vm.deal(address(account), address(account).balance - MAX_PROOF_COST);
        asSelf();
        account.unshield(poolRoot, nullifierHash, recipient);
        assertEq(address(account).balance, account.poolHeld());
    }

    function test_conservation_aShortBalanceStopsAnUnshield() public {
        shieldBoth();
        drainTo(0);
        vm.deal(address(account), address(account).balance - 1);
        unshieldFrame();
        vm.expectRevert(VajraAccountV2.ValueNotConserved.selector);
        account.validateUnshield(unshieldProof);
    }

    function test_conservation_dailyFeesCannotEatTheNotes() public {
        shieldBoth();
        drainTo(0.001 ether - 1);
        dailyFrame(1, 0);
        vm.expectRevert(VajraAccountV2.ValueNotConserved.selector);
        account.validateDaily(VajraScope.EXECUTION_AND_PAYMENT);
    }

    function test_conservation_unshieldRefusedWithNothingHeld() public {
        shieldBoth();
        asSelf();
        account.escape(harbor, HARBOR_SALT, new address[](0));
        asSelf();
        account.unfreeze();
        vm.deal(address(account), 1 ether);
        unshieldFrame();
        vm.expectRevert(VajraAccountV2.ValueNotConserved.selector);
        account.validateUnshield(unshieldProof);
    }

    function test_escape_drainsThePoolToTheHarbor() public {
        shieldBoth();
        uint256 everything = address(account).balance;
        asSelf();
        account.escape(harbor, HARBOR_SALT, new address[](0));
        assertEq(harbor.balance, everything);
        assertEq(account.poolHeld(), 0);
        assertTrue(account.poolClosed());
        assertTrue(account.frozen());
    }

    function test_escape_closesThePoolForGood() public {
        asSelf();
        account.escape(harbor, HARBOR_SALT, new address[](0));
        asSelf();
        account.unfreeze();
        vm.deal(address(account), DENOM);
        vm.prank(address(account));
        vm.expectRevert(VajraAccountV2.PoolClosed.selector);
        account.shield{value: DENOM}(firstNote);
    }

    function test_escape_toARefusingHarborKeepsTheNotes() public {
        RefusingHarbor refusing = new RefusingHarbor();
        asSelf();
        account.setHarbor(keccak256(abi.encodePacked(address(refusing), HARBOR_SALT)));
        shieldBoth();
        asSelf();
        account.escape(payable(address(refusing)), HARBOR_SALT, new address[](0));
        assertEq(account.poolHeld(), 2 * DENOM);
        assertFalse(account.poolClosed());
        assertTrue(account.frozen());
    }
}

contract RefusingHarbor {
    receive() external payable {
        revert("no");
    }
}
