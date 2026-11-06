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
    bytes32 constant TICKET = keccak256("the ticket on the paper");
    bytes32 constant GATE = keccak256(abi.encode(TICKET));
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
    uint256 constant TX_SENDER = 2;
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
    uint256[8] claimProof;
    address claimRecipient;

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
        claimRecipient = json.readAddress(".claimRecipient");
        uint256[] memory r = json.readUintArray(".recoveryProof");
        uint256[] memory u = json.readUintArray(".unshieldProof");
        uint256[] memory c = json.readUintArray(".claimProof");
        for (uint256 i; i < 8; ++i) {
            recoveryProof[i] = r[i];
            unshieldProof[i] = u[i];
            claimProof[i] = c[i];
        }

        bytes memory poseidonCode = json.readBytes(".poseidon");
        address poseidon;
        assembly ("memory-safe") {
            poseidon := create(0, add(poseidonCode, 32), mload(poseidonCode))
        }

        implementation = new VajraAccountV2(
            4, 3, address(new StakeSink()), address(new RecoveryVerifier()), address(new ShieldVerifier()), poseidon, DENOM, MAX_PROOF_COST, 0
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
        uint256 key = uint256(keccak256(abi.encodePacked(keccak256("vajra.unshield.v1"), nullifierHash)));
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
        account.setRecovery(commitment, DELAY, GATE);
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
        account.validateRecovery(recoveryProof, TICKET);
    }

    function test_recovery_aWrongTicketDiesBeforeThePairing() public {
        setRecovery();
        recoveryFrame();
        uint256 before = gasleft();
        vm.expectRevert(VajraAccountV2.RecoveryGateInvalid.selector);
        account.validateRecovery(recoveryProof, keccak256("a guess"));
        assertLt(before - gasleft(), 30_000, "a fake must cost a hash, not a pairing");
    }

    function test_setRecovery_refusesACommitmentWithNoGate() public {
        asSelf();
        vm.expectRevert(VajraAccountV2.RecoveryGateInvalid.selector);
        account.setRecovery(commitment, DELAY, bytes32(0));
    }

    function workHash(bytes32 key, uint256 work) private view returns (uint256) {
        return uint256(keccak256(abi.encode(address(account), unshieldProof, key, poolRoot, nullifierHash, uint256(uint160(recipient)), work)));
    }

    function test_unshield_needsItsWork() public {
        shieldBoth();
        address poseidon = address(account.POSEIDON());
        VajraAccountV2 tolled = new VajraAccountV2(
            4, 3, account.STAKING_REGISTRY(), address(account.RECOVERY_VERIFIER()), address(account.SHIELD_VERIFIER()), poseidon, DENOM, MAX_PROOF_COST, 8
        );
        implementation = tolled;
        vm.etch(helper(APPROVE), type(ApproveDouble).runtimeCode);
        vm.etch(address(account), abi.encodePacked(hex"363d3d373d3d3d363d73", address(tolled), hex"5af43d82803e903d91602b57fd5bf3"));
        unshieldFrame();
        bytes32 key = keccak256(abi.encodePacked(keccak256("vajra.unshield.v1"), nullifierHash));
        uint256 work;
        while (workHash(key, work) >> 248 != 0) work++;
        uint256 wrong = work + 1;
        while (workHash(key, wrong) >> 248 == 0) wrong++;
        uint256 before = gasleft();
        vm.expectRevert(VajraAccountV2.ProofWorkMissing.selector);
        account.validateUnshield(unshieldProof, wrong);
        assertLt(before - gasleft(), 60_000, "no work must cost a hash, not a pairing");
        expectApproved();
        account.validateUnshield(unshieldProof, work);
    }

    function test_recovery_refusedBeforeACommitmentExists() public {
        recoveryFrame();
        vm.expectRevert(VajraAccountV2.RecoveryNotSet.selector);
        account.validateRecovery(recoveryProof, TICKET);
    }

    function test_recovery_refusesACorruptedProof() public {
        setRecovery();
        recoveryFrame();
        uint256[8] memory bent = recoveryProof;
        bent[0] += 1;
        vm.expectRevert(VajraAccountV2.RecoveryProofInvalid.selector);
        account.validateRecovery{gas: PROOF_FRAME_GAS}(bent, TICKET);
    }

    function test_recovery_everyWordOfTheProofMatters() public {
        setRecovery();
        recoveryFrame();
        for (uint256 i; i < 8; ++i) {
            uint256[8] memory bent = recoveryProof;
            bent[i] ^= 1;
            vm.expectRevert(VajraAccountV2.RecoveryProofInvalid.selector);
            // A point off the curve makes the precompile burn all it is given, so each try gets a frame's worth, as on chain.
            account.validateRecovery{gas: PROOF_FRAME_GAS}(bent, TICKET);
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
        account.validateRecovery(recoveryProof, TICKET);
    }

    function test_recovery_proofIsBoundToTheCommitment() public {
        asSelf();
        account.setRecovery(commitment + 1, DELAY, GATE);
        recoveryFrame();
        vm.expectRevert(VajraAccountV2.RecoveryProofInvalid.selector);
        account.validateRecovery(recoveryProof, TICKET);
    }

    function test_recovery_proofIsBoundToTheChain() public {
        setRecovery();
        recoveryFrame();
        vm.chainId(1);
        vm.expectRevert(VajraAccountV2.RecoveryProofInvalid.selector);
        account.validateRecovery(recoveryProof, TICKET);
    }

    function test_recovery_proofIsBoundToTheNullifier() public {
        setRecovery();
        uint256 other = nullifier + 1;
        recoveryFrame();
        setWord(36, bytes32(other));
        setTx(NONCE_KEY_0, uint256(keccak256(abi.encodePacked(keccak256("vajra.recovery.v1"), other, NEW_ROOT))));
        vm.expectRevert(VajraAccountV2.RecoveryProofInvalid.selector);
        account.validateRecovery(recoveryProof, TICKET);
    }

    function test_recovery_refusesASpentNullifier() public {
        setRecovery();
        queue();
        recoveryFrame();
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.NullifierSpent.selector, nullifier));
        account.validateRecovery(recoveryProof, TICKET);
    }

    function test_recovery_worksWhileFrozen() public {
        setRecovery();
        asSelf();
        account.freeze();
        recoveryFrame();
        expectApproved();
        account.validateRecovery(recoveryProof, TICKET);
    }

    // The shape a signature would have pinned. One test each, because any one left open is a way to drain the account.

    function shapeRefused() private {
        vm.expectRevert(VajraAccountV2.ProofTxShapeInvalid.selector);
        account.validateRecovery(recoveryProof, TICKET);
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
        account.validateUnshield(unshieldProof, 0);
        unshieldFrame();
        setFrame(STATE_GAS_LIMIT, 0);
        vm.expectRevert(VajraAccountV2.ProofTxShapeInvalid.selector);
        account.validateUnshield(unshieldProof, 0);
    }

    function test_recovery_refusesAnEmptyRootInVerify() public {
        setRecovery();
        recoveryFrame();
        setWord(4, bytes32(0));
        vm.expectRevert(VajraAccountV2.RootRequired.selector);
        account.validateRecovery(recoveryProof, TICKET);
    }

    function test_recovery_feeCannotEatTheNotes() public {
        setRecovery();
        shieldBoth();
        drainTo(0.001 ether);
        recoveryFrame();
        setTx(MAX_COST, 0.001 ether + 1);
        vm.expectRevert(VajraAccountV2.ValueNotConserved.selector);
        account.validateRecovery(recoveryProof, TICKET);
    }

    // ------------------------------------------------- the daily key stays on the linear nonce ----

    function dailyFrame(uint256 count, uint256 key) private {
        vm.mockCall(helper(SIG_PARAM), abi.encode(uint256(0), uint256(0)), abi.encode(uint256(uint160(daily))));
        vm.mockCall(helper(SIG_PARAM), abi.encode(uint256(0), uint256(2)), abi.encode(uint256(0)));
        setTx(TX_SENDER, uint256(uint160(address(account))));
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

    function test_daily_cannotPayForSomeoneElsesTransaction() public {
        dailyFrame(1, 0);
        setTx(TX_SENDER, uint256(uint160(thief)));
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.validateDaily(VajraScope.PAYMENT);
    }

    function test_daily_aWalletSignatureCannotSurviveAChangedFrameMode() public {
        dailyFrame(1, 0);
        vm.mockCall(helper(SIG_PARAM), abi.encode(uint256(0), uint256(2)), abi.encode(uint256(1)));
        setTx(FRAME_COUNT, 2);
        setFrame(MODE, 0);
        vm.expectRevert(VajraAccountV2.SignatureNotBoundToTransaction.selector);
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
        account.validateRecovery(recoveryProof, TICKET);
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
        account.setRecovery(type(uint256).max, DELAY, GATE);
    }

    function test_setRecovery_refusesNoVetoWindow() public {
        asSelf();
        vm.expectRevert(VajraAccountV2.RecoveryDelayRequired.selector);
        account.setRecovery(commitment, 0, GATE);
    }

    function test_setRecovery_zeroTurnsItOff() public {
        setRecovery();
        asSelf();
        account.setRecovery(0, 0, bytes32(0));
        assertEq(account.recoveryCommitment(), 0);
    }

    function test_setRecovery_refusesOutsiders() public {
        vm.prank(thief);
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.setRecovery(1, 0, GATE);
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
        account.validateUnshield(unshieldProof, 0);
    }

    function test_unshield_refusedWhileFrozen() public {
        shieldBoth();
        unshieldFrame();
        asSelf();
        account.freeze();
        vm.expectRevert(VajraAccountV2.AccountFrozen.selector);
        account.validateUnshield(unshieldProof, 0);
    }

    function test_unshield_refusesAnUnknownRoot() public {
        openPool(firstNote);
        unshieldFrame();
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.RootUnknown.selector, poolRoot));
        account.validateUnshield(unshieldProof, 0);
    }

    function test_unshield_refusesARootThatLeftTheRing() public {
        shieldBoth();
        for (uint256 i; i < 32; ++i) {
            account.shield{value: DENOM}(firstNote + 1 + i);
        }
        unshieldFrame();
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.RootUnknown.selector, poolRoot));
        account.validateUnshield(unshieldProof, 0);
    }

    function test_unshield_acceptsARootDeepInTheRing() public {
        shieldBoth();
        for (uint256 i; i < 31; ++i) {
            account.shield{value: DENOM}(firstNote + 1 + i);
        }
        unshieldFrame();
        expectApproved();
        account.validateUnshield(unshieldProof, 0);
    }

    function test_unshield_everyWordOfTheProofMatters() public {
        shieldBoth();
        unshieldFrame();
        for (uint256 i; i < 8; ++i) {
            uint256[8] memory bent = unshieldProof;
            bent[i] ^= 1;
            vm.expectRevert(VajraAccountV2.ShieldProofInvalid.selector);
            account.validateUnshield{gas: PROOF_FRAME_GAS}(bent, 0);
        }
    }

    function test_unshield_proofIsBoundToTheRecipient() public {
        shieldBoth();
        unshieldFrame();
        setWord(68, bytes32(uint256(uint160(thief))));
        vm.expectRevert(VajraAccountV2.ShieldProofInvalid.selector);
        account.validateUnshield(unshieldProof, 0);
    }

    function test_unshield_aNoteHasOneNonceKeyWhoeverItPays() public {
        shieldBoth();
        unshieldFrame();
        setTx(NONCE_KEY_0, uint256(keccak256(abi.encodePacked(keccak256("vajra.unshield.v1"), nullifierHash, uint256(uint160(recipient))))));
        vm.expectRevert(VajraAccountV2.ProofTxShapeInvalid.selector);
        account.validateUnshield(unshieldProof, 0);
    }

    function test_unshield_aRecipientThatRefusesCostsTheFeeAndNotTheOwner() public {
        shieldBoth();
        RefusingHarbor refusing = new RefusingHarbor();
        uint256 before = address(account).balance;
        asSelf();
        account.unshield(poolRoot, nullifierHash, address(refusing));
        assertTrue(account.noteSpent(nullifierHash));
        assertEq(account.poolHeld(), 2 * DENOM - MAX_PROOF_COST);
        assertEq(address(account).balance, before);
    }

    function test_unshield_aReturnBombCannotStopTheNoteBeingSpent() public {
        shieldBoth();
        ReturnBomb bomb = new ReturnBomb();
        asSelf();
        account.unshield{gas: 500_000}(poolRoot, nullifierHash, address(bomb));
        assertTrue(account.noteSpent(nullifierHash));
    }

    function test_unshield_refusesHighBitsInTheRecipient() public {
        shieldBoth();
        unshieldFrame();
        setWord(68, bytes32((uint256(1) << 160) | uint256(uint160(recipient))));
        vm.expectRevert(VajraAccountV2.ProofTxShapeInvalid.selector);
        account.validateUnshield(unshieldProof, 0);
    }

    function test_unshield_aRecipientThatBurnsItsGasCannotStopTheNoteBeingSpent() public {
        shieldBoth();
        GasBurner burner = new GasBurner();
        asSelf();
        account.unshield{gas: 500_000}(poolRoot, nullifierHash, address(burner));
        assertTrue(account.noteSpent(nullifierHash));
    }

    function test_unshield_proofIsBoundToTheChain() public {
        shieldBoth();
        unshieldFrame();
        vm.chainId(1);
        vm.expectRevert(VajraAccountV2.ShieldProofInvalid.selector);
        account.validateUnshield(unshieldProof, 0);
    }

    function test_unshield_refusesASpentNote() public {
        shieldBoth();
        asSelf();
        account.unshield(poolRoot, nullifierHash, recipient);
        unshieldFrame();
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.NullifierSpent.selector, nullifierHash));
        account.validateUnshield(unshieldProof, 0);
    }

    function test_unshield_refusesAnAddedFrame() public {
        shieldBoth();
        unshieldFrame();
        setTx(FRAME_COUNT, 3);
        vm.expectRevert(VajraAccountV2.ProofTxShapeInvalid.selector);
        account.validateUnshield(unshieldProof, 0);
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

    // --------------------------------------------- a failed payment, and the claim it leaves ----

    function owed() private view returns (bool) {
        return account.noteState(nullifierHash) == 2 && !account.poolClosed();
    }

    /// `unshieldProof` is bound to the vector's recipient, so that address has to be the one that refuses for the proof to stay real.
    function refusePayment() private {
        shieldBoth();
        vm.etch(recipient, hex"fe");
        asSelf();
        account.unshield{gas: 500_000}(poolRoot, nullifierHash, recipient);
        vm.etch(recipient, "");
    }

    function test_claim_whatARefusedPaymentWouldHavePaidStaysHeld() public {
        // The owner's own first note moves nothing, because the account pays itself. The outsider's adds one.
        uint256 before = address(account).balance + DENOM;
        refusePayment();
        assertTrue(account.noteSpent(nullifierHash));
        assertTrue(owed());
        assertEq(account.poolHeld(), 2 * DENOM - MAX_PROOF_COST, "one note, and one note less its fee");
        assertEq(address(account).balance, before, "nothing left the account");
    }

    function test_claim_paysTheNoteOnce() public {
        refusePayment();
        uint256 before = address(account).balance;
        vm.prank(thief);
        account.claim(unshieldProof, poolRoot, nullifierHash, recipient);
        assertEq(recipient.balance, DENOM - MAX_PROOF_COST);
        assertEq(address(account).balance, before - (DENOM - MAX_PROOF_COST));
        assertEq(account.poolHeld(), DENOM, "only the other note is left");
        assertFalse(owed());
        assertTrue(account.noteSpent(nullifierHash));
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.NothingOwed.selector, nullifierHash));
        account.claim(unshieldProof, poolRoot, nullifierHash, recipient);
    }

    function test_claim_aHolderCanPaySomeoneElseWithANewProof() public {
        refusePayment();
        account.claim(claimProof, poolRoot, nullifierHash, claimRecipient);
        assertEq(claimRecipient.balance, DENOM - MAX_PROOF_COST);
        assertEq(recipient.balance, 0);
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.NothingOwed.selector, nullifierHash));
        account.claim(unshieldProof, poolRoot, nullifierHash, recipient);
    }

    function test_claim_aSeenProofCannotBeMovedToAThief() public {
        refusePayment();
        vm.expectRevert(VajraAccountV2.ShieldProofInvalid.selector);
        account.claim(unshieldProof, poolRoot, nullifierHash, thief);
        vm.expectRevert(VajraAccountV2.ShieldProofInvalid.selector);
        account.claim(claimProof, poolRoot, nullifierHash, recipient);
    }

    function test_claim_everyWordOfTheProofMatters() public {
        refusePayment();
        for (uint256 i; i < 8; ++i) {
            uint256[8] memory bad = unshieldProof;
            bad[i] += 1;
            // A point off the curve burns what a precompile is given, so this is bounded, as a real transaction would be.
            vm.expectRevert(VajraAccountV2.ShieldProofInvalid.selector);
            account.claim{gas: 3_000_000}(bad, poolRoot, nullifierHash, recipient);
        }
        assertTrue(owed());
    }

    function test_claim_refusesANoteThatWasNeverSpent() public {
        shieldBoth();
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.NothingOwed.selector, nullifierHash));
        account.claim(unshieldProof, poolRoot, nullifierHash, recipient);
        assertEq(account.poolHeld(), 2 * DENOM);
    }

    function test_claim_refusesANoteThatWasPaid() public {
        shieldBoth();
        asSelf();
        account.unshield(poolRoot, nullifierHash, recipient);
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.NothingOwed.selector, nullifierHash));
        account.claim(claimProof, poolRoot, nullifierHash, claimRecipient);
    }

    function test_claim_refusesAnUnknownRoot() public {
        refusePayment();
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.RootUnknown.selector, uint256(1)));
        account.claim(unshieldProof, 1, nullifierHash, recipient);
    }

    function test_claim_aFreezeStopsIt() public {
        refusePayment();
        asSelf();
        account.freeze();
        vm.expectRevert(VajraAccountV2.AccountFrozen.selector);
        account.claim(unshieldProof, poolRoot, nullifierHash, recipient);
        asSelf();
        account.unfreeze();
        account.claim(unshieldProof, poolRoot, nullifierHash, recipient);
        assertEq(recipient.balance, DENOM - MAX_PROOF_COST);
    }

    function test_claim_aRecipientThatStillRefusesLeavesTheClaim() public {
        refusePayment();
        vm.etch(recipient, hex"fe");
        uint256 before = address(account).balance;
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.TransferFailed.selector, address(0)));
        account.claim(unshieldProof, poolRoot, nullifierHash, recipient);
        assertTrue(owed());
        assertEq(address(account).balance, before, "a failed claim costs the sender, and the account nothing");
        assertEq(account.poolHeld(), 2 * DENOM - MAX_PROOF_COST);
    }

    function test_claim_aRecipientCannotReenterForASecondPayment() public {
        refusePayment();
        ClaimAgain again = new ClaimAgain();
        vm.etch(recipient, address(again).code);
        ClaimAgain(payable(recipient)).aim(abi.encodeCall(account.claim, (unshieldProof, poolRoot, nullifierHash, recipient)));
        uint256 before = address(account).balance;
        account.claim(unshieldProof, poolRoot, nullifierHash, recipient);
        assertEq(address(account).balance, before - (DENOM - MAX_PROOF_COST), "paid once");
        assertEq(bytes4(ClaimAgain(payable(recipient)).answer()), VajraAccountV2.NothingOwed.selector);
    }

    function test_claim_theDailyKeyCannotReachIt() public {
        refusePayment();
        dailyFrame(1, 0);
        setTx(FRAME_COUNT, 2);
        setFrame(MODE, 2);
        setFrame(RESOLVED_TARGET, uint256(uint160(address(account))));
        setFrame(VALUE, 0);
        setWord(0, bytes32(account.claim.selector));
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.EscapeKeyOutranks.selector, account.claim.selector));
        account.validateDaily(VajraScope.EXECUTION_AND_PAYMENT);
    }

    function test_claim_aSpendCannotReachIt() public {
        refusePayment();
        drainTo(0.1 ether);
        asSelf();
        vm.expectRevert(VajraAccountV2.ValueNotConserved.selector);
        account.spend(address(0), thief, 0.1 ether + 1);
        asSelf();
        account.spend(address(0), thief, 0.1 ether);
        assertEq(address(account).balance, account.poolHeld());
    }

    function test_claim_aQueuedSpendCannotReachIt() public {
        asSelf();
        account.spend(address(0), thief, 2 ether);
        uint256 id = account.nextItem() - 1;
        refusePayment();
        drainTo(1 ether);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(VajraAccountV2.ValueNotConserved.selector);
        account.executeQueued(id);
    }

    function test_claim_dailyFeesCannotEatIt() public {
        refusePayment();
        drainTo(0.001 ether - 1);
        dailyFrame(1, 0);
        vm.expectRevert(VajraAccountV2.ValueNotConserved.selector);
        account.validateDaily(VajraScope.EXECUTION_AND_PAYMENT);
    }

    function test_claim_aRecoverysFeeCannotEatIt() public {
        refusePayment();
        setRecovery();
        drainTo(0);
        recoveryFrame();
        vm.expectRevert(VajraAccountV2.ValueNotConserved.selector);
        account.validateRecovery(recoveryProof, TICKET);
    }

    function test_claim_anEscapeSweepsItToTheHarborAndEndsIt() public {
        refusePayment();
        uint256 everything = address(account).balance;
        asSelf();
        account.escape(harbor, HARBOR_SALT, new address[](0));
        assertEq(harbor.balance, everything, "the claim's money is in the harbor");
        assertEq(account.poolHeld(), 0);
        assertFalse(owed(), "nothing is owed once the harbor has it");
        vm.expectRevert(VajraAccountV2.AccountFrozen.selector);
        account.claim(unshieldProof, poolRoot, nullifierHash, recipient);
        // Unfrozen, with new money in the account, it is still over.
        asSelf();
        account.unfreeze();
        vm.deal(address(account), 1 ether);
        vm.expectRevert(VajraAccountV2.PoolClosed.selector);
        account.claim(unshieldProof, poolRoot, nullifierHash, recipient);
        assertEq(recipient.balance, 0);
    }

    function test_claim_theExitEscapesWithAClaimOutstanding() public {
        address theExit = address(new NamedExit(address(account)));
        asSelf();
        account.setExit(theExit);
        refusePayment();
        uint256 everything = address(account).balance;
        vm.prank(theExit);
        account.escape(harbor, HARBOR_SALT, new address[](0));
        assertEq(harbor.balance, everything);
        assertFalse(owed());
    }

    function test_claim_aHarborThatRefusesLeavesTheClaim() public {
        RefusingHarbor refusing = new RefusingHarbor();
        bytes32 salt = keccak256("another");
        asSelf();
        account.setHarbor(keccak256(abi.encodePacked(address(refusing), salt)));
        refusePayment();
        asSelf();
        account.escape(payable(address(refusing)), salt, new address[](0));
        assertTrue(owed(), "the money is still here, so it is still owed");
        asSelf();
        account.unfreeze();
        account.claim(unshieldProof, poolRoot, nullifierHash, recipient);
        assertEq(recipient.balance, DENOM - MAX_PROOF_COST);
    }

    function test_claim_aNoteOwedCannotBeSpentAgain() public {
        refusePayment();
        unshieldFrame();
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.NullifierSpent.selector, nullifierHash));
        account.validateUnshield(unshieldProof, 0);
        asSelf();
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.NullifierSpent.selector, nullifierHash));
        account.unshield(poolRoot, nullifierHash, recipient);
    }

    function test_claim_theOtherNoteIsNotTouched() public {
        refusePayment();
        account.claim(unshieldProof, poolRoot, nullifierHash, recipient);
        assertEq(account.poolHeld(), DENOM);
        assertEq(address(account).balance, 5 ether + DENOM - (DENOM - MAX_PROOF_COST));
    }

    function test_unshield_aRecipientBurningAllItsGasStillLeavesAClaim_withTheOldestRootInTheRing() public {
        openPool(firstNote);
        account.shield{value: DENOM}(secondNote);
        // Every later deposit moves the proof's root deeper, so the walk over the ring is as long as it gets. This is the frame's worst case.
        for (uint256 i; i < 30; ++i) {
            account.shield{value: DENOM}(1000 + i);
        }
        assertTrue(account.isKnownRoot(poolRoot));
        vm.etch(recipient, hex"fe");
        asSelf();
        account.unshield{gas: 500_000}(poolRoot, nullifierHash, recipient);
        assertTrue(owed());
    }

    function test_unshield_keepsItsGasBackFromARecipientThatTakesAllOfIt() public {
        shieldBoth();
        vm.etch(recipient, hex"fe");
        asSelf();
        // Just enough to reach the call: without gas kept back, only a sixty-fourth of what is left would come home to write the claim.
        account.unshield{gas: 80_000}(poolRoot, nullifierHash, recipient);
        assertTrue(owed());
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
        account.validateUnshield(unshieldProof, 0);
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
        account.validateUnshield(unshieldProof, 0);
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
        account.validateUnshield(unshieldProof, 0);
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

    // ------------------------------------------------------------- a ticket after use ----

    function queueTheRecovery() private {
        setRecovery();
        asSelf();
        account.queueRecovery(NEW_ROOT, nullifier);
    }

    function test_ticket_closesWhenTheRecoveryIsQueued() public {
        queueTheRecovery();
        assertEq(account.recoveryGate(), bytes32(0));
    }

    function test_ticket_aUsedOneDiesBeforeThePairing() public {
        queueTheRecovery();
        uint256 fresh = nullifier + 1;
        uint256 key = uint256(keccak256(abi.encodePacked(keccak256("vajra.recovery.v1"), fresh, NEW_ROOT)));
        frameFor(account.queueRecovery.selector, 68, key, 200_000, 800_000);
        setWord(4, NEW_ROOT);
        setWord(36, bytes32(fresh));
        vm.expectRevert(VajraAccountV2.RecoveryGateInvalid.selector);
        account.validateRecovery(recoveryProof, TICKET);
    }

    function test_ticket_zeroCannotOpenAClosedGate() public {
        queueTheRecovery();
        uint256 fresh = nullifier + 1;
        uint256 key = uint256(keccak256(abi.encodePacked(keccak256("vajra.recovery.v1"), fresh, NEW_ROOT)));
        frameFor(account.queueRecovery.selector, 68, key, 200_000, 800_000);
        setWord(4, NEW_ROOT);
        setWord(36, bytes32(fresh));
        vm.expectRevert(VajraAccountV2.RecoveryGateInvalid.selector);
        account.validateRecovery(recoveryProof, bytes32(0));
    }

    function test_ticket_aUsedPaperCannotBeSetAgain() public {
        queueTheRecovery();
        asSelf();
        vm.expectRevert(VajraAccountV2.RecoveryAlreadyUsed.selector);
        account.setRecovery(commitment, DELAY, keccak256("a new gate"));
    }

    function test_ticket_aUsedGateCannotBeSetAgain() public {
        queueTheRecovery();
        asSelf();
        vm.expectRevert(VajraAccountV2.RecoveryAlreadyUsed.selector);
        account.setRecovery(commitment + 1, DELAY, GATE);
    }

    function test_ticket_aNewPaperWorksAfterTheOldOneIsUsed() public {
        queueTheRecovery();
        asSelf();
        account.setRecovery(commitment + 1, DELAY, keccak256("a new gate"));
        assertEq(account.recoveryGate(), keccak256("a new gate"));
    }

    function test_ticket_recoveryCanStillBeTurnedOffAfterUse() public {
        queueTheRecovery();
        asSelf();
        account.setRecovery(0, 0, bytes32(0));
        assertEq(account.recoveryCommitment(), 0);
    }

    function test_ticket_survivesARotation() public {
        setRecovery();
        asSelf();
        account.rotateRoot(keccak256("next tree"));
        assertEq(account.recoveryGate(), GATE);
        recoveryFrame();
        expectApproved();
        account.validateRecovery(recoveryProof, TICKET);
    }

    // ------------------------------------------------------------------ the second route ----

    /// A contract that says it is this account's. What it does with that is up to the test.
    function nameExit() private returns (address exit) {
        exit = makeAddr("exit");
        vm.etch(exit, hex"00");
        vm.mockCall(exit, abi.encodeWithSignature("account()"), abi.encode(address(account)));
        asSelf();
        account.setExit(exit);
    }

    function test_exit_canVetoFreezeAndEscape() public {
        address exit = nameExit();
        asSelf();
        account.spend(address(0), thief, 2 ether);
        uint256 id = account.nextItem() - 1;
        vm.prank(exit);
        account.veto(id);
        assertEq(uint8(account.queuedItem(id).state), 3);
        vm.prank(exit);
        account.freeze();
        assertTrue(account.frozen());
        uint256 held = address(account).balance;
        vm.prank(exit);
        account.escape(harbor, HARBOR_SALT, new address[](0));
        assertEq(harbor.balance, held);
    }

    function test_exit_cannotCancelARecovery() public {
        address exit = nameExit();
        setRecovery();
        asSelf();
        account.queueRecovery(NEW_ROOT, nullifier);
        uint256 id = account.nextItem() - 1;
        vm.prank(exit);
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.veto(id);
        asSelf();
        account.veto(id);
    }

    function test_exit_canDoNothingElse() public {
        address exit = nameExit();
        vm.startPrank(exit);
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.unfreeze();
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.spend(address(0), thief, 1);
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.setDailyKey(thief);
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.setHarbor(keccak256("thief"));
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.rotateRoot(keccak256("thief"));
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.setExit(thief);
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.setRecovery(1, DELAY, GATE);
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.setRule(address(0), 1 ether, 1 ether);
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.unshield(poolRoot, nullifierHash, thief);
        vm.stopPrank();
    }

    function test_exit_nobodyElseGetsIn() public {
        nameExit();
        vm.startPrank(thief);
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.freeze();
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.escape(harbor, HARBOR_SALT, new address[](0));
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.queueRecovery(NEW_ROOT, nullifier);
        vm.stopPrank();
    }

    function test_exit_noneByDefault() public {
        assertEq(account.exit(), address(0));
        vm.prank(address(0));
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.freeze();
    }

    function test_exit_anEscapeStillNeedsTheHarbor() public {
        address exit = nameExit();
        vm.prank(exit);
        vm.expectRevert(VajraAccountV2.HarborMismatch.selector);
        account.escape(payable(thief), HARBOR_SALT, new address[](0));
    }

    function test_setExit_refusesAContractThatSaysItIsAnotherAccounts() public {
        address other = makeAddr("another account's exit");
        vm.etch(other, hex"00");
        vm.mockCall(other, abi.encodeWithSignature("account()"), abi.encode(thief));
        asSelf();
        vm.expectRevert(VajraAccountV2.ExitNotForThisAccount.selector);
        account.setExit(other);
        assertEq(account.exit(), address(0));
    }

    function test_setExit_refusesAContractThatSaysItIsNobodys() public {
        address noAccount = makeAddr("a sender with no walk");
        vm.etch(noAccount, hex"00");
        vm.mockCall(noAccount, abi.encodeWithSignature("account()"), abi.encode(address(0)));
        asSelf();
        vm.expectRevert(VajraAccountV2.ExitNotForThisAccount.selector);
        account.setExit(noAccount);
    }

    function test_setExit_refusesAnAddressWithNoCode() public {
        asSelf();
        vm.expectRevert();
        account.setExit(thief);
        assertEq(account.exit(), address(0));
    }

    function test_queueRecovery_withNothingSet_isRefusedEvenFromANamedExit() public {
        address exit = nameExit();
        vm.prank(exit);
        vm.expectRevert(VajraAccountV2.RecoveryNotSet.selector);
        account.queueRecovery(NEW_ROOT, nullifier);
        assertEq(account.nextItem(), 0);
        assertEq(account.wotsRoot(), ROOT);
    }

    function test_queueRecovery_withNothingSet_isRefusedFromTheAccountToo() public {
        asSelf();
        vm.expectRevert(VajraAccountV2.RecoveryNotSet.selector);
        account.queueRecovery(NEW_ROOT, nullifier);
    }

    /// The limit, kept in a test so that nobody reads the fix as more than it is. A contract written to lie can still spend a paper that
    /// is set. The root waits out the delay, and the master key can cancel it. Only a contract the master key named can do this.
    function test_aLyingExit_canStillSpendAPaperThatIsSet_andTheRootHasToWait() public {
        address exit = nameExit();
        setRecovery();
        vm.prank(exit);
        account.queueRecovery(NEW_ROOT, nullifier);
        uint256 id = account.nextItem() - 1;
        assertEq(account.recoveryGate(), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.QueuedPendingTimelock.selector, uint64(block.timestamp) + DELAY));
        account.executeQueued(id);
        assertEq(account.wotsRoot(), ROOT);
        asSelf();
        account.veto(id);
    }

    function test_exit_turnsOff() public {
        address exit = nameExit();
        asSelf();
        account.setExit(address(0));
        vm.prank(exit);
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.freeze();
    }

    function test_exit_checksARecoveryOnlyForTheExit() public {
        address exit = nameExit();
        setRecovery();
        recoveryFrame();
        vm.expectRevert(VajraAccountV2.NotAuthorized.selector);
        account.checkRecovery(recoveryProof, TICKET);
        vm.prank(exit);
        account.checkRecovery(recoveryProof, TICKET);
    }

    function test_exit_aRecoveryItCarriesNeedsARealProof() public {
        address exit = nameExit();
        setRecovery();
        recoveryFrame();
        uint256[8] memory bent = recoveryProof;
        bent[0] ^= 1;
        vm.prank(exit);
        vm.expectRevert(VajraAccountV2.RecoveryProofInvalid.selector);
        account.checkRecovery{gas: PROOF_FRAME_GAS}(bent, TICKET);
    }

    function test_exit_aRecoveryItCarriesKeepsItsShape() public {
        address exit = nameExit();
        setRecovery();
        recoveryFrame();
        setFrame(EXECUTION_GAS_LIMIT, 1000);
        vm.prank(exit);
        vm.expectRevert(VajraAccountV2.ProofTxShapeInvalid.selector);
        account.checkRecovery(recoveryProof, TICKET);
    }

    function test_exit_aRecoveryItCarriesDoesNotAskTheBalance() public {
        address exit = nameExit();
        setRecovery();
        shieldBoth();
        drainTo(0.001 ether);
        recoveryFrame();
        setTx(MAX_COST, 0.001 ether + 1);
        vm.prank(exit);
        account.checkRecovery(recoveryProof, TICKET);
    }

    // ------------------------------------------------------- what a wallet signs: EIP-712 ----

    bytes32 constant SPEND_TYPE = keccak256(
        "DailySpend(address asset,address recipient,uint256 amount,uint256 nonce,uint256 maxFeePerGas,uint256 maxPriorityFeePerGas,uint256 executionGas,uint256 stateGas,uint256 verifyGas,uint256 maxCost)"
    );
    bytes32 constant EXECUTE_TYPE =
        keccak256("DailyExecute(uint256 id,uint256 nonce,uint256 maxFeePerGas,uint256 maxPriorityFeePerGas,uint256 executionGas,uint256 stateGas,uint256 verifyGas,uint256 maxCost)");
    uint256 constant TX_MAX_FEE = 4;
    uint256 constant TX_MAX_PRIORITY = 3;
    uint256 constant VERIFY_GAS = 60_000;
    uint256 constant SIGNED_COST = 0.001 ether;

    function domainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("VAJRA"),
                keccak256("2"),
                CHAIN,
                address(account)
            )
        );
    }

    function typedDigest(address asset, address to, uint256 amount) private view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(SPEND_TYPE, asset, to, amount, uint256(5), uint256(9), uint256(3), uint256(500_000), uint256(700_000), VERIFY_GAS, SIGNED_COST));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// An honest wallet-signed `spend` of one ether to the recipient, with `signed` as the entry's `msg`.
    function walletFrame(bytes32 signed) private {
        dailyFrame(1, 0);
        vm.mockCall(helper(SIG_PARAM), abi.encode(uint256(0), uint256(2)), abi.encode(signed));
        setTx(FRAME_COUNT, 2);
        setTx(NONCE, 5);
        setTx(TX_MAX_FEE, 9);
        setTx(TX_MAX_PRIORITY, 3);
        vm.mockCall(helper(FRAME_PARAM), abi.encode(uint256(0), EXECUTION_GAS_LIMIT), abi.encode(VERIFY_GAS));
        setFrame(MODE, 2);
        setFrame(RESOLVED_TARGET, uint256(uint160(address(account))));
        setFrame(VALUE, 0);
        setFrame(DATA_LENGTH, 100);
        setFrame(EXECUTION_GAS_LIMIT, 500_000);
        setFrame(STATE_GAS_LIMIT, 700_000);
        setWord(0, bytes32(account.spend.selector));
        setWord(4, bytes32(0));
        setWord(36, bytes32(uint256(uint160(recipient))));
        setWord(68, bytes32(uint256(1 ether)));
    }

    function test_typed_isApproved() public {
        walletFrame(typedDigest(address(0), recipient, 1 ether));
        expectApproved();
        account.validateDaily(VajraScope.EXECUTION_AND_PAYMENT);
    }

    function test_typed_executeIsApproved() public {
        bytes32 structHash = keccak256(abi.encode(EXECUTE_TYPE, uint256(7), uint256(5), uint256(9), uint256(3), uint256(400_000), uint256(300_000), VERIFY_GAS, SIGNED_COST));
        walletFrame(keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash)));
        setFrame(DATA_LENGTH, 36);
        setFrame(EXECUTION_GAS_LIMIT, 400_000);
        setFrame(STATE_GAS_LIMIT, 300_000);
        setWord(0, bytes32(account.executeQueued.selector));
        setWord(4, bytes32(uint256(7)));
        expectApproved();
        account.validateDaily(VajraScope.EXECUTION_AND_PAYMENT);
    }

    function refusesTyped() private {
        vm.expectRevert(VajraAccountV2.SignatureNotBoundToTransaction.selector);
        account.validateDaily(VajraScope.EXECUTION_AND_PAYMENT);
    }

    function test_typed_isBoundToTheRecipient() public {
        walletFrame(typedDigest(address(0), thief, 1 ether));
        refusesTyped();
    }

    function test_typed_isBoundToTheAmount() public {
        walletFrame(typedDigest(address(0), recipient, 2 ether));
        refusesTyped();
    }

    function test_typed_isBoundToTheAsset() public {
        walletFrame(typedDigest(thief, recipient, 1 ether));
        refusesTyped();
    }

    function test_typed_isBoundToTheFee() public {
        walletFrame(typedDigest(address(0), recipient, 1 ether));
        setTx(TX_MAX_FEE, 10);
        refusesTyped();
    }

    function test_typed_isBoundToTheNonce() public {
        walletFrame(typedDigest(address(0), recipient, 1 ether));
        setTx(NONCE, 6);
        refusesTyped();
    }

    function test_typed_isBoundToTheGas() public {
        walletFrame(typedDigest(address(0), recipient, 1 ether));
        setFrame(EXECUTION_GAS_LIMIT, 1000);
        refusesTyped();
    }

    function test_typed_isBoundToTheChain() public {
        walletFrame(typedDigest(address(0), recipient, 1 ether));
        vm.chainId(1);
        refusesTyped();
    }

    function test_typed_refusesDirtyHighBits() public {
        walletFrame(typedDigest(address(0), recipient, 1 ether));
        setWord(36, bytes32(uint256(uint160(recipient)) | (uint256(1) << 200)));
        refusesTyped();
    }

    function test_typed_refusesTrailingBytes() public {
        walletFrame(typedDigest(address(0), recipient, 1 ether));
        setFrame(DATA_LENGTH, 101);
        refusesTyped();
    }

    function test_typed_refusesAnyOtherFunction() public {
        walletFrame(typedDigest(address(0), recipient, 1 ether));
        setWord(0, bytes32(account.escape.selector));
        refusesTyped();
    }

    function test_typed_refusesTheOldBlindDigest() public {
        bytes32 blind = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256("what a personal_sign would have been")));
        walletFrame(blind);
        refusesTyped();
    }

    function test_typed_anEmptyMsgStillMeansTheSignatureHash() public {
        walletFrame(bytes32(0));
        setWord(0, bytes32(account.spend.selector));
        expectApproved();
        account.validateDaily(VajraScope.EXECUTION_AND_PAYMENT);
    }

    function test_typed_reportsItsDomain() public view {
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = account.eip712Domain();
        assertEq(name, "VAJRA");
        assertEq(version, "2");
        assertEq(chainId, CHAIN);
        assertEq(verifying, address(account));
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

contract ReturnBomb {
    receive() external payable {
        assembly {
            return(0, 450000)
        }
    }
}

contract GasBurner {
    receive() external payable {
        assembly {
            invalid()
        }
    }
}

/// Takes the money, and tries to be paid again from inside the payment.
contract ClaimAgain {
    bytes public call_;
    bytes public answer;

    function aim(bytes calldata call__) external {
        call_ = call__;
    }

    receive() external payable {
        (, answer) = msg.sender.call(call_);
    }
}

/// Answers `setExit`, and no more: the walk over a real exit's frames is not what this is about.
contract NamedExit {
    address public account;

    constructor(address account_) {
        account = account_;
    }
}

contract RefusingHarbor {
    receive() external payable {
        revert("no");
    }
}
