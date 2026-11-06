// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    HegotaSupport,
    Devnet,
    Scope,
    TxParam,
    FrameParam,
    FrameMode
} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Wots} from "./Wots.sol";

interface IVajraRecovery {
    function checkRecovery(uint256[8] calldata proof, bytes32 ticket) external view;
}

/// The second way out: a sender of its own, for one account.
///
/// Everything that can stop an escape from the account itself is attached to the account's address. A pending thief transaction
/// holds that sender on the canonical mempool, reputation is counted per address, and solvency is counted against that address's
/// balance. A thief with the daily key can spend all three. This contract is a different address with its own money, and the
/// only thing that can approve a transaction from it is a Winternitz signature, so the daily key has no way to touch any of them.
///
/// The hash key stays in validation, as on the account: `validateExit` verifies it in the VERIFY frame. The tree is its own, not
/// the master tree. On chain a leaf is single-use through its nonce key, and a nonce key belongs to a sender, so one tree shared
/// between two senders would lose that check.
///
/// The key reaches three functions on one account, `veto`, `freeze` and `escape`, each of which only stops or leaves. Holding it can
/// cancel a queued spend or send everything to the sealed harbor, and nothing else. A recovery can ride here too, and that needs a
/// proof and no key, because a recovery is for the day the keys are gone. See docs/FINDINGS.md section 12.
contract VajraExit is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    /// Levels in the key tree; 64 one-time keys. The master key replaces a spent tree with `setRoot`, so no leaf is reserved.
    uint256 public constant TREE_DEPTH = 6;
    uint256 private constant LAST_LEAF = 63;

    // `escape`, `veto` and `freeze` on the account, the only frames this sender may run.
    bytes4 private constant ESCAPE = bytes4(keccak256("escape(address,bytes32,address[])"));
    bytes4 private constant VETO = bytes4(keccak256("veto(uint256)"));
    bytes4 private constant FREEZE = bytes4(keccak256("freeze()"));

    uint256 public immutable LOG_W;
    uint256 public immutable LEN2;
    uint256 public immutable CHAINS;
    uint256 private immutable BLOB_LENGTH;
    /// Stake is keyed on the caller, so the exit has to stake for itself. Only a recovery needs it: see `validateRecovery`.
    address public immutable STAKING_REGISTRY;

    address public account;
    bytes32 public root;
    bytes32 public epochSalt;

    event RootSet(bytes32 root);

    error AlreadyInitialized();
    error RootRequired();
    error NotAuthorized();
    error TreeExhausted();
    error NonceKeyNotBoundToLeaf(uint256 leaf);
    error LeafAlreadySpent(uint256 leaf);
    error BadExitSignature();
    error FrameNotAllowed(uint256 frame);
    error StakeFailed();

    /// The implementation holds no key of its own. It is locked here, and clones initialize through the factory.
    constructor(uint256 logW, uint256 len2, address stakingRegistry) {
        STAKING_REGISTRY = stakingRegistry;
        LOG_W = logW;
        LEN2 = len2;
        CHAINS = 256 / logW + len2;
        BLOB_LENGTH = 1 + (256 / logW + len2) * 32 + TREE_DEPTH * 32;
        root = bytes32(uint256(1));
    }

    function initialize(address account_, bytes32 root_, bytes32 epochSalt_, uint128 stake, uint32 unstakeDelay) external payable {
        if (root != bytes32(0)) revert AlreadyInitialized();
        if (root_ == bytes32(0)) revert RootRequired();
        account = account_;
        root = root_;
        epochSalt = epochSalt_;
        if (stake != 0) {
            (bool staked,) = STAKING_REGISTRY.call{value: stake}(abi.encodeWithSignature("addStake(uint32)", unstakeDelay));
            if (!staked) revert StakeFailed();
        }
    }

    /// The reserve. Anyone may top it up, and only a transaction the hash key signed can spend it, on its own gas.
    receive() external payable {}

    /// The VERIFY frame. Fits the 100,000 cap at w=16, as `validateMaster` does, and needs no stake: it reads only its own storage.
    ///
    /// The signature hash commits to every frame and the fee, so a copy cannot change anything. The walk over the frames is not
    /// about copies, it is what holds this key to its three functions.
    function validateExit() external {
        if (address(uint160(txparam(TxParam.SENDER))) != address(this)) revert NotAuthorized();
        bytes memory blob = sigdatacopy(0, BLOB_LENGTH, 0);
        uint256 leaf;
        uint256 sig;
        assembly ("memory-safe") {
            leaf := byte(0, mload(add(blob, 32)))
            sig := add(blob, 33)
        }
        if (leaf > LAST_LEAF) revert TreeExhausted();

        bytes32 tree = root;
        uint256 nonceKey = txparam(TxParam.NONCE_KEY_0);
        if (txparam(TxParam.NONCE_KEY_COUNT) != 1 || nonceKey != uint256(keccak256(abi.encodePacked(tree, uint8(leaf))))) {
            revert NonceKeyNotBoundToLeaf(leaf);
        }
        if (txparam(TxParam.NONCE) != 0) revert LeafAlreadySpent(leaf);

        address target = account;
        uint256 frames = txparam(TxParam.FRAME_COUNT);
        for (uint256 i = txparam(TxParam.CURRENT_FRAME_INDEX) + 1; i < frames; ++i) {
            uint256 mode = frameparam(i, FrameParam.MODE);
            if (mode == uint256(FrameMode.VERIFY)) continue;
            bytes4 selector = bytes4(framedataload(0, i));
            // Every other mode is refused, not skipped. A frame this walk did not read could call `queueRecovery` as this sender.
            if (
                mode != uint256(FrameMode.SENDER) || address(uint160(frameparam(i, FrameParam.RESOLVED_TARGET))) != target
                    || frameparam(i, FrameParam.VALUE) != 0
                    || (selector != ESCAPE && selector != VETO && selector != FREEZE)
            ) {
                revert FrameNotAllowed(i);
            }
        }

        bytes32 digest = exitDigest(nonceKey, bytes32(txparam(TxParam.SIG_HASH)));
        bytes32 leafKey = Wots.recoverLeaf(digest, sig, LOG_W, LEN2);
        if (Wots.merkleRoot(leafKey, leaf, sig + CHAINS * 32, TREE_DEPTH) != tree) revert BadExitSignature();

        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// A recovery from this address, so that a thief who has spent the account's reputation cannot keep it off a node. The account
    /// checks everything it would check of a recovery of its own, including the shape of this transaction, and the exit pays.
    ///
    /// Unlike `validateExit` this needs a stake: the pairing is over the unstaked budget, and it reads the account's storage.
    ///
    /// The ticket here is the preimage of the account's ticket, and only the paper can make it. A recovery sent from the account
    /// shows its ticket, so without this a stranger could resend that proof from here and the reserve would pay.
    function validateRecovery(uint256[8] calldata proof, bytes32 exitTicket) external {
        if (address(uint160(txparam(TxParam.SENDER))) != address(this)) revert NotAuthorized();
        IVajraRecovery(account).checkRecovery(proof, keccak256(abi.encode(exitTicket)));
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// The same form as the master digest. This address is in it, so a signature here is no use on the account.
    function exitDigest(uint256 nonceKey, bytes32 sigHash) public view returns (bytes32) {
        return keccak256(abi.encodePacked(block.chainid, epochSalt, address(this), nonceKey, sigHash));
    }

    /// Installs a new tree. Only the account can ask, which means only its master key: the daily key cannot aim a frame anywhere
    /// but the account itself.
    function setRoot(bytes32 newRoot) external {
        if (msg.sender != account) revert NotAuthorized();
        if (newRoot == bytes32(0)) revert RootRequired();
        root = newRoot;
        emit RootSet(newRoot);
    }

    /// Whatever else the master key wants of this contract: taking back the reserve, or unlocking and withdrawing the stake, which
    /// is keyed on this address. `validateExit` holds the exit key to the account, so only this can reach the registry.
    function execute(address target, uint256 value, bytes calldata data) external {
        if (msg.sender != account) revert NotAuthorized();
        (bool ok, bytes memory returned) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(returned, 32), mload(returned))
            }
        }
    }
}

/// Deploys exits as EIP-1167 clones of one implementation, the way `VajraFactory` deploys accounts.
contract VajraExitFactory {
    address public immutable implementation;

    event ExitCreated(address indexed exit, address indexed account);

    constructor(address implementation_) {
        implementation = implementation_;
    }

    function addressOf(address account, bytes32 root, bytes32 epochSalt) public view returns (address) {
        bytes32 hash = keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(account, root, epochSalt), keccak256(_initCode())));
        return address(uint160(uint256(hash)));
    }

    /// Clones and initializes in one step, so nobody can initialize a clone first. Value becomes the reserve.
    function create(address account, bytes32 root, bytes32 epochSalt, uint128 stake, uint32 unstakeDelay) external payable returns (address exit) {
        bytes memory code = _initCode();
        bytes32 salt = _salt(account, root, epochSalt);
        assembly ("memory-safe") {
            exit := create2(0, add(code, 32), mload(code), salt)
        }
        require(exit != address(0), "clone failed");
        VajraExit(payable(exit)).initialize{value: msg.value}(account, root, epochSalt, stake, unstakeDelay);
        emit ExitCreated(exit, account);
    }

    function _salt(address account, bytes32 root, bytes32 epochSalt) private pure returns (bytes32) {
        return keccak256(abi.encode(account, root, epochSalt));
    }

    function _initCode() private view returns (bytes memory) {
        return abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3"
        );
    }
}
