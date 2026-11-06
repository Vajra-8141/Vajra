// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    HegotaSupport,
    Devnet,
    Scope,
    TxParam,
    FrameParam,
    FrameMode,
    SigParam
} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Wots} from "./Wots.sol";
import {PoolZeros} from "./PoolZeros.sol";

/// What snarkjs generates for the recovery circuit, in `verifiers/`.
interface IRecoveryVerifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[8] calldata input)
        external
        view
        returns (bool);
}

/// What snarkjs generates for the unshield circuit, in `verifiers/`.
interface IShieldVerifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[6] calldata input)
        external
        view
        returns (bool);
}

/// circomlibjs's generated Poseidon, the same function the circuit computes.
interface IPoseidon {
    function poseidon(uint256[2] calldata inputs) external pure returns (uint256);
}

/// VajraAccount, with recovery by proof and a shielded pool. It runs on the local mirror only.
///
/// `VajraAccount.sol` is the public devnet's contract, and it stays free of all this, so that what is recorded against it stays
/// true. This file starts from a copy, because recovery has to go through `executeQueued`, and that is
/// not virtual, and the pool's funds have to be kept out of `spend` and swept by `escape`, which are not virtual either. Every
/// difference from the original is marked `V2:`.
///
/// V2: a transaction authorized by a proof carries no signature, so nothing commits to its frames or its fee, and anyone
/// who sees it in a mempool can resend it changed. VERIFY therefore pins all of it: see `_requireProofShape`.
///
/// An EIP-8141 account with two keys of unequal rank.
///
/// The daily key is an ordinary secp256k1 key, verified by the protocol. It can do two things: spend under the
/// rulebook, and execute a queued spend that has matured. The master key is a Merkle tree of Winternitz one-time keys,
/// verified here in the VERIFY frame. It can do anything the account can do, and only it can change the rules.
///
/// Where each check lives is dictated by the frame rules, so it is worth stating once:
///
///   - VERIFY frames are static and may not read TIMESTAMP, in any mempool. So they decide who may act and what shape
///     the transaction has: which key signed, and which functions its SENDER frames reach. That is the priority rule,
///     and it is structural: a daily-signed transaction that reaches a master function never becomes valid at all.
///   - The rulebook needs the clock and has to write, so it runs in the SENDER frame, in `spend`.
///
/// `sender_approved` covers every SENDER frame in a transaction, not just the one VERIFY looked at. A daily key that
/// could append `token.transfer(thief, everything)` as a second SENDER frame would walk around the whole rulebook, so
/// `validateDaily` inspects every frame. A master signature needs no such walk: it commits to the signature hash, and
/// the signature hash commits to every frame.
contract VajraAccountV2 is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    // ------------------------------------------------------------------------------------------ constants ---------

    /// Levels in the key tree; 64 one-time keys.
    uint256 public constant TREE_DEPTH = 6;
    /// The last leaf can only install a new root, so a tree can always be replaced.
    uint256 public constant ROTATION_LEAF = 63;
    /// Spending is tracked in hourly buckets. 25 of them keep the window at or above a full 24 hours.
    uint256 private constant BUCKETS = 25;

    /// V2: what a stock wallet signs is EIP-712 typed data, so that it can show the asset, the recipient and the amount. A blind
    /// 32-byte personal_sign showed nothing, and a person cannot check nothing. See `_typedDigest`.
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant DOMAIN_NAME_HASH = keccak256("VAJRA");
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256("2");
    bytes32 private constant SPEND_TYPEHASH = keccak256(
        "DailySpend(address asset,address recipient,uint256 amount,uint256 nonce,uint256 maxFeePerGas,uint256 maxPriorityFeePerGas,uint256 executionGas,uint256 stateGas,uint256 verifyGas,uint256 maxCost)"
    );
    bytes32 private constant EXECUTE_TYPEHASH = keccak256(
        "DailyExecute(uint256 id,uint256 nonce,uint256 maxFeePerGas,uint256 maxPriorityFeePerGas,uint256 executionGas,uint256 stateGas,uint256 verifyGas,uint256 maxCost)"
    );
    /// Gas a single token gets during a sweep, enough for a proxied USDC transfer with room to spare.
    uint256 private constant SWEEP_GAS = 300_000;

    /// V2: domain of the nonce key a recovery runs on.
    bytes32 private constant RECOVERY_TAG = keccak256("vajra.recovery.v1");
    /// V2: domain of the nonce key an unshield runs on.
    bytes32 private constant UNSHIELD_TAG = keccak256("vajra.unshield.v1");
    /// V2: the BN254 scalar field. A leaf at or above it could never be proven.
    uint256 private constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    /// V2: levels in the pool's Poseidon tree, about a million notes.
    uint256 public constant POOL_DEPTH = 20;
    /// V2: how many recent roots an unshield may prove against. A proof takes time to reach a block and the tree moves under
    /// it, and validity that hangs on fast-changing state costs the sender reputation with the mempool.
    uint256 public constant ROOT_HISTORY = 32;
    /// V2: the SENDER frame's gas, exactly. `zk.ts` sends these, and VERIFY refuses anything else. A copy with less gas would
    /// pass the proof, spend the nonce, and fail in the SENDER frame: a mined failure that kills the recovery or note for good.
    uint256 private constant RECOVERY_EXECUTION_GAS = 200_000;
    uint256 private constant RECOVERY_STATE_GAS = 800_000;
    uint256 private constant UNSHIELD_EXECUTION_GAS = 500_000;
    uint256 private constant UNSHIELD_STATE_GAS = 600_000;
    /// V2: a 256-bit value goes into a proof as two limbs, because it does not fit in the BN254 scalar field.
    uint256 private constant LIMB = 1 << 128;

    /// keccak256(abi.encode(uint256(keccak256("vajra.account.v1")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_SLOT = 0xf2fd160257ae1f0e7d62d7d1c68f72a3ef6f2001f3b743b1c3e7df809af00f00;

    /// Winternitz parameters, fixed per implementation: bits per digit, and checksum digits.
    uint256 public immutable LOG_W;
    uint256 public immutable LEN2;
    /// Signature words, and the length of the blob a master transaction carries.
    uint256 public immutable CHAINS;
    uint256 private immutable BLOB_LENGTH;
    /// ERC-8421's IStakingRegistry. Stake is keyed on the caller, so the account has to stake for itself.
    address public immutable STAKING_REGISTRY;
    /// V2: the Groth16 verifier for the recovery circuit.
    IRecoveryVerifier public immutable RECOVERY_VERIFIER;
    /// V2: the Groth16 verifier for the unshield circuit, and the hash the pool's tree uses.
    IShieldVerifier public immutable SHIELD_VERIFIER;
    IPoseidon public immutable POSEIDON;
    /// V2: the one size of note. Every note being the same size is what stops an amount linking a withdrawal to a deposit.
    uint256 public immutable DENOMINATION;
    /// V2: the most a transaction authorized by a proof may cost the account. See `_requireProofShape`. An unshield pays this
    /// out of the note, so a note always carries its own fee and nobody can use the pool to burn the owner's free balance.
    uint256 public immutable MAX_PROOF_TX_COST;
    /// V2: leading zero bits an unshield's hash must have. A proof has no signature, so nothing else makes a fake one cost its
    /// sender anything before a node runs the pairing. It slows a CPU far more than a GPU, so this is a toll and not a wall.
    uint256 public immutable PROOF_WORK_BITS;

    // -------------------------------------------------------------------------------------------- storage ---------

    enum ItemState {
        None,
        Pending,
        Executed,
        Vetoed
    }

    /// Why a spend went to the queue instead of leaving at once.
    enum QueueReason {
        DailyLimitExceeded,
        NewPayeeCoolingActive,
        /// V2: not a spend. The item's `amount` holds the new root, and `isRecovery` marks it.
        Recovery
    }

    struct QueuedItem {
        address recipient;
        address asset;
        uint256 amount;
        uint64 executeAfter;
        ItemState state;
    }

    struct AssetRule {
        bool configured;
        uint128 dailyLimit;
        uint128 coolingAllowance;
        uint128 spentInWindow;
        uint64 lastHour;
        uint128[BUCKETS] hourly;
    }

    /// Everything the account needs at creation. `address(0)` as an asset means ETH.
    struct Config {
        address dailyKey;
        bytes32 wotsRoot;
        bytes32 epochSalt;
        bytes32 harborCommitment;
        uint64 queueDelay;
        uint64 coolingPeriod;
        uint128 maxDailyTxCost;
        address[] assets;
        uint128[] dailyLimits;
        uint128[] coolingAllowances;
        /// Set on a stealth account only: a second key that must co-sign every master transaction.
        address coSigner;
        /// Staked at creation, and sent to the registry out of the value the account is created with.
        uint128 stake;
        uint32 unstakeDelay;
    }

    /// @custom:storage-location erc7201:vajra.account.v1
    struct Layout {
        address dailyKey;
        bool frozen;
        bytes32 wotsRoot;
        bytes32 epochSalt;
        bytes32 harborCommitment;
        uint64 queueDelay;
        uint64 coolingPeriod;
        uint128 maxDailyTxCost;
        uint256 nextItem;
        address coSigner;
        address[] assets;
        mapping(address asset => AssetRule) rules;
        mapping(uint256 id => QueuedItem) queue;
        mapping(address payee => uint64) firstSeen;
        mapping(address asset => mapping(address payee => uint128)) coolingSpent;
        // V2, from here down.
        uint256 recoveryCommitment;
        uint64 recoveryDelay;
        /// V2: keccak of a ticket only the paper can make. A proof without it dies for a hash, before the pairing.
        bytes32 recoveryGate;
        mapping(uint256 nullifier => bool) recoverySpent;
        mapping(uint256 id => bool) isRecovery;
        /// What the notes in the pool are owed. Inside the account's balance, and out of reach of everything but `unshield`
        /// and `escape`.
        uint256 poolHeld;
        uint32 nextNote;
        uint32 rootCursor;
        bool poolClosed;
        mapping(uint256 level => uint256) filled;
        uint256[ROOT_HISTORY] roots;
        mapping(uint256 nullifierHash => bool) noteSpent;
        /// A commitment or gate a recovery has already used. Both are public from then on, so neither may be set again.
        mapping(bytes32 value => bool) recoveryUsed;
        /// The second route's sender: see `VajraExit`.
        address exit;
        /// Paymasters the master key named. Only these may take the frames around a sponsored daily transaction.
        mapping(address paymaster => bool) sponsors;
    }

    // ------------------------------------------------------------------------------------- events and errors ------

    event Spent(address indexed asset, address indexed recipient, uint256 amount);
    event Queued(
        uint256 indexed id,
        address indexed asset,
        address indexed recipient,
        uint256 amount,
        uint64 executeAfter,
        QueueReason reason
    );
    event QueueExecuted(uint256 indexed id);
    event Vetoed(uint256 indexed id);
    event FrozenSet(bool frozen);
    event Escaped(address indexed harbor);
    event SweepFailed(address indexed asset);
    event RootRotated(bytes32 oldRoot, bytes32 newRoot);
    event DailyKeyChanged(address oldKey, address newKey);
    event RuleChanged(address indexed asset, uint128 dailyLimit, uint128 coolingAllowance);
    event HarborChanged(bytes32 commitment);
    event RecoverySet(uint256 commitment, uint64 delay);
    event RecoveryInstalled(uint256 indexed id, bytes32 newRoot);
    event Shielded(uint256 indexed commitment, uint256 leaf, uint256 root);
    event Unshielded(uint256 indexed nullifierHash, address indexed recipient);
    event PoolDrained(address indexed harbor, uint256 amount);
    event ExitChanged(address exit);
    event SponsorSet(address indexed paymaster, bool allowed);
    event UnshieldUnpaid(uint256 indexed nullifierHash, address indexed recipient);

    // The refusal registry, spec §3.
    error AccountFrozen();
    error QueuedPendingTimelock(uint64 executeAfter);
    error VetoedByEscapeKey(uint256 id);
    error HarborImmutable();
    error EscapeKeyOutranks(bytes4 selector);
    error LeafAlreadySpent(uint256 leaf);
    error TreeExhausted();
    error MandateUnresolvable(address asset);

    error NotAuthorized();
    error NotDailyKey();
    error SignatureNotBoundToTransaction();
    error BadMasterSignature();
    error NonceKeyNotBoundToLeaf(uint256 leaf);
    error DailyTxCostExceeded(uint256 cost);
    error FrameNotAllowed(uint256 frame);
    error ItemNotPending(uint256 id);
    error HarborMismatch();
    error TransferFailed(address asset);
    error AlreadyInitialized();
    error RuleArraysMismatch();
    error RootRequired();
    error StakeFailed();
    error CoSignerRequired();

    // V2: the refusals for proofs, spec 04 sections 9 and 10.
    error RecoveryProofInvalid();
    error RecoveryVetoed(uint256 id);
    error RecoveryNotSet();
    error NullifierSpent(uint256 nullifier);
    error ProofTxShapeInvalid();
    error RecoveryGateInvalid();
    error RecoveryAlreadyUsed();
    error ProofWorkMissing();
    error ProofTxCostExceeded(uint256 cost);
    error DailyNonceKeyInvalid();
    error RecoveryDelayRequired();
    error ShieldProofInvalid();
    error RootUnknown(uint256 root);
    error ValueNotConserved();
    error CommitmentInvalid();
    error PoolFull();
    error PoolClosed();

    // ---------------------------------------------------------------------------------------- construction --------

    /// The implementation holds no account of its own. It is locked here, and clones initialize through the factory.
    constructor(
        uint256 logW,
        uint256 len2,
        address stakingRegistry,
        address recoveryVerifier,
        address shieldVerifier,
        address poseidon,
        uint256 denomination,
        uint256 maxProofTxCost,
        uint256 proofWorkBits
    ) {
        STAKING_REGISTRY = stakingRegistry;
        RECOVERY_VERIFIER = IRecoveryVerifier(recoveryVerifier);
        SHIELD_VERIFIER = IShieldVerifier(shieldVerifier);
        POSEIDON = IPoseidon(poseidon);
        DENOMINATION = denomination;
        require(maxProofTxCost < denomination || denomination == 0, "a note has to cover its own fee");
        MAX_PROOF_TX_COST = maxProofTxCost;
        PROOF_WORK_BITS = proofWorkBits;
        LOG_W = logW;
        LEN2 = len2;
        CHAINS = 256 / logW + len2;
        BLOB_LENGTH = 1 + (256 / logW + len2) * 32 + TREE_DEPTH * 32;
        _layout().wotsRoot = bytes32(uint256(1));
    }

    function initialize(Config calldata config) external payable {
        Layout storage s = _layout();
        if (s.wotsRoot != bytes32(0)) revert AlreadyInitialized();
        if (config.wotsRoot == bytes32(0)) revert RootRequired();
        if (config.assets.length != config.dailyLimits.length || config.assets.length != config.coolingAllowances.length)
        {
            revert RuleArraysMismatch();
        }
        s.dailyKey = config.dailyKey;
        s.wotsRoot = config.wotsRoot;
        s.epochSalt = config.epochSalt;
        s.harborCommitment = config.harborCommitment;
        s.queueDelay = config.queueDelay;
        s.coolingPeriod = config.coolingPeriod;
        s.maxDailyTxCost = config.maxDailyTxCost;
        s.coSigner = config.coSigner;
        for (uint256 i; i < config.assets.length; ++i) {
            _setRule(config.assets[i], config.dailyLimits[i], config.coolingAllowances[i]);
        }
        if (config.stake != 0) {
            (bool staked,) = STAKING_REGISTRY.call{value: config.stake}(
                abi.encodeWithSignature("addStake(uint32)", config.unstakeDelay)
            );
            if (!staked) revert StakeFailed();
        }
    }

    receive() external payable {}

    // ------------------------------------------------------------------------------------------ validation --------

    /// VERIFY frame for the daily key. Cheap enough for any mempool.
    ///
    /// @param scope The approval to grant: EXECUTION_AND_PAYMENT, or EXECUTION when a paymaster pays.
    function validateDaily(Scope scope) external {
        Layout storage s = _layout();
        if (s.frozen) revert AccountFrozen();
        // V2: otherwise a daily signature could make this account the paymaster for a thief's own transaction.
        if (address(uint160(txparam(TxParam.SENDER))) != address(this)) revert NotAuthorized();
        _requireDailySignature(s.dailyKey);

        // V2: the daily key stays on the linear nonce. Approving a transaction spends whatever nonce keys it names, and the master
        // key's are public: keccak(root, leaf). Left open, a thief spends all 64 of them and the master key can never sign again.
        if (txparam(TxParam.NONCE_KEY_COUNT) != 1 || txparam(TxParam.NONCE_KEY_0) != 0) revert DailyNonceKeyInvalid();

        // Fees are paid before the rulebook runs, so they are the one way value can leave without passing it.
        //
        // V2: at every scope. A sponsored transaction can still cost the account, in the token a paymaster takes for gas.
        uint256 cost = txparam(TxParam.MAX_COST);
        if (cost > s.maxDailyTxCost) revert DailyTxCostExceeded(cost);
        // V2: fees are paid from the same balance the pool sits in. Without this a thief could burn the notes as gas. Only
        // a staked sender may read its balance in validation, so an account with a pool has to be staked. The scope is the
        // signer's to choose, and payment can be approved in a frame of its own, so this holds whenever payment is included.
        if (scope != Scope.EXECUTION) {
            uint256 held = s.poolHeld;
            if (held != 0 && address(this).balance < held + cost) revert ValueNotConserved();
        }

        uint256 current = txparam(TxParam.CURRENT_FRAME_INDEX);
        uint256 frames = txparam(TxParam.FRAME_COUNT);
        for (uint256 i = current + 1; i < frames; ++i) {
            uint256 mode = frameparam(i, FrameParam.MODE);
            if (mode == uint256(FrameMode.VERIFY)) continue;
            address target = address(uint160(frameparam(i, FrameParam.RESOLVED_TARGET)));
            // V2: `[daily, charge, pay, SENDER..., settle]`, and no other place for a DEFAULT frame. One runs as the entry point with no
            // value, so it has no authority here, but a paymaster reads the sender from it and can take what the account approved.
            // So only a paymaster the master key named, and an account that names none refuses them all.
            if (mode == uint256(FrameMode.DEFAULT)) {
                if (scope != Scope.EXECUTION || current != 0 || (i != 1 && i != frames - 1) || !s.sponsors[target]) revert FrameNotAllowed(i);
                continue;
            }
            // V2: refused, not skipped. No other mode is known to be harmless here, and a daily key has no use for one.
            if (mode != uint256(FrameMode.SENDER)) revert FrameNotAllowed(i);
            if (target != address(this)) revert FrameNotAllowed(i);
            if (frameparam(i, FrameParam.VALUE) != 0) revert FrameNotAllowed(i);
            bytes4 selector = bytes4(framedataload(0, i));
            if (selector != this.spend.selector && selector != this.executeQueued.selector) {
                if (selector == this.setHarbor.selector) revert HarborImmutable();
                revert EscapeKeyOutranks(selector);
            }
        }

        approve(scope);
    }

    /// A daily signature has to commit to the whole transaction. The protocol has already checked the ECDSA signature
    /// against the entry's `msg`, so what matters here is what `msg` is.
    ///
    /// Empty means the signature hash, which commits to every frame. That is the form a client holding the key uses.
    ///
    /// Anything else has to be proven, because the protocol verifies a signature against whatever `msg` holds: left
    /// unchecked, any signature this key ever produced, for any message on any site, would pass here. A stock wallet
    /// cannot produce the empty form, since it cannot sign a frame transaction, and `msg` cannot commit to the signature
    /// hash either, since an entry with a `msg` keeps its own bytes inside that hash. So for a wallet the digest is
    /// rebuilt here from the transaction's fields.
    function _requireDailySignature(address key) private view {
        if (key == address(0) || address(uint160(sigparam(0, SigParam.RESOLVED_SIGNER))) != key) revert NotDailyKey();
        uint256 signed = sigparam(0, SigParam.MSG);
        if (signed != 0 && bytes32(signed) != _typedDigest()) revert SignatureNotBoundToTransaction();
    }

    /// V2: the EIP-712 digest of what the wallet showed. The shape is pinned to `[VERIFY, SENDER]` so that no frame can sit outside
    /// it, and the body frame's target and value are held to the account and zero by `validateDaily`.
    ///
    /// The arguments are hashed as the raw words in the frame, not as decoded values. A copy with dirty high bits in an address
    /// word would pass a decoded check here and revert in the SENDER frame, spending the nonce and fee and paying nobody. As raw
    /// words it no longer matches what was signed. The exact length holds for the same reason: trailing bytes are in no field.
    ///
    /// `verifyGas` and `maxCost` are what the rest of the transaction comes to. APPROVE takes the maximum cost and gives the rest back
    /// only at the end, so a copy that raises it can make a spend that fits fail in the SENDER frame. Every byte of frame 0, of a
    /// signature entry, of a recent-root reference and every blob is in `maxCost`. The fee and the other limits are signed, so with
    /// frame 0's limit signed as well, no copy can trade one against another. The cost of `msg` and of the signature depends on their
    /// zero bytes, which cannot be known before signing, so `maxCost` assumes none, and `withTypedSignature` makes up the difference.
    function _typedDigest() private view returns (bytes32) {
        // The frame walk skips anything that is not SENDER, so a copy could otherwise turn the body into a no-op under the same signature.
        if (
            txparam(TxParam.CURRENT_FRAME_INDEX) != 0 || txparam(TxParam.FRAME_COUNT) != 2
                || frameparam(1, FrameParam.MODE) != uint256(FrameMode.SENDER)
        ) {
            revert SignatureNotBoundToTransaction();
        }
        bytes4 selector = bytes4(framedataload(0, 1));
        uint256 length = frameparam(1, FrameParam.DATA_LENGTH);
        bytes32 structHash;
        if (selector == this.spend.selector && length == 100) {
            structHash = keccak256(
                abi.encode(
                    SPEND_TYPEHASH,
                    framedataload(4, 1),
                    framedataload(36, 1),
                    framedataload(68, 1),
                    txparam(TxParam.NONCE),
                    txparam(TxParam.MAX_FEE),
                    txparam(TxParam.MAX_PRIORITY_FEE_PER_GAS),
                    frameparam(1, FrameParam.EXECUTION_GAS_LIMIT),
                    frameparam(1, FrameParam.STATE_GAS_LIMIT),
                    frameparam(0, FrameParam.EXECUTION_GAS_LIMIT),
                    txparam(TxParam.MAX_COST)
                )
            );
        } else if (selector == this.executeQueued.selector && length == 36) {
            structHash = keccak256(
                abi.encode(
                    EXECUTE_TYPEHASH,
                    framedataload(4, 1),
                    txparam(TxParam.NONCE),
                    txparam(TxParam.MAX_FEE),
                    txparam(TxParam.MAX_PRIORITY_FEE_PER_GAS),
                    frameparam(1, FrameParam.EXECUTION_GAS_LIMIT),
                    frameparam(1, FrameParam.STATE_GAS_LIMIT),
                    frameparam(0, FrameParam.EXECUTION_GAS_LIMIT),
                    txparam(TxParam.MAX_COST)
                )
            );
        } else {
            revert SignatureNotBoundToTransaction();
        }
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, DOMAIN_NAME_HASH, DOMAIN_VERSION_HASH, block.chainid, address(this)));
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    /// VERIFY frame for the master key. The signature rides in an ARBITRARY entry so that the signature hash, which
    /// elides those bytes, can commit to everything else: `leaf (1 byte) ‖ WOTS signature ‖ Merkle path`.
    ///
    /// @param scope The approval to grant: EXECUTION_AND_PAYMENT, or EXECUTION when a paymaster pays.
    function validateMaster(Scope scope) external {
        Layout storage s = _layout();
        bytes memory blob = sigdatacopy(0, BLOB_LENGTH, 0);
        uint256 leaf;
        uint256 sig;
        assembly ("memory-safe") {
            leaf := byte(0, mload(add(blob, 32)))
            sig := add(blob, 33)
        }
        if (leaf > ROTATION_LEAF) revert TreeExhausted();

        bytes32 root = s.wotsRoot;
        uint256 nonceKey = txparam(TxParam.NONCE_KEY_0);
        if (nonceKey == 0) {
            _requireStealthSpend(s.coSigner, leaf);
        } else {
            // A stealth account's hash key is known to whoever paid it, so the co-signature is the only thing that makes it the
            // recipient's. It has to hold on every path, and the linear nonce above is the only one that checks it.
            if (s.coSigner != address(0)) revert CoSignerRequired();
            // One leaf, one key, one use: the nonce key is derived from the root and the leaf, so the protocol itself
            // refuses a second transaction on this leaf, including after a rotation back to an old root.
            if (txparam(TxParam.NONCE_KEY_COUNT) != 1 || nonceKey != uint256(keccak256(abi.encodePacked(root, uint8(leaf))))) {
                revert NonceKeyNotBoundToLeaf(leaf);
            }
            if (txparam(TxParam.NONCE) != 0) revert LeafAlreadySpent(leaf);
        }

        bytes32 digest = masterDigest(nonceKey, bytes32(txparam(TxParam.SIG_HASH)));
        bytes32 leafKey = Wots.recoverLeaf(digest, sig, LOG_W, LEN2);
        if (Wots.merkleRoot(leafKey, leaf, sig + CHAINS * 32, TREE_DEPTH) != root) revert BadMasterSignature();

        if (leaf == ROTATION_LEAF) {
            uint256 next = txparam(TxParam.CURRENT_FRAME_INDEX) + 1;
            if (bytes4(framedataload(0, next)) != this.rotateRoot.selector) revert TreeExhausted();
        }

        approve(scope);
    }

    /// V2: VERIFY frame for a recovery. No key signs this: the proof is the authority, because the master key is the
    /// thing that was lost, and a daily key must never be able to do this.
    ///
    /// It is routable only with a stake, on a mempool that honours BUDGET-010 and CALLING-040: the pairing check costs
    /// more than the flat 100,000 cap, and uses precompiles the deployed sidecar refuses.
    ///
    /// @param proof Groth16 `a`, `b` and `c`, flattened. The statement's public values come from storage, the chain, and
    /// the SENDER frame this transaction is pinned to.
    function validateRecovery(uint256[8] calldata proof, bytes32 ticket) external {
        _checkRecovery(proof, ticket, true);
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// V2: the same check, for a recovery the exit carries, which is what a node that has banned this address still lets through.
    /// The exit is the sender and pays, so what the notes are owed is not at stake. `_requireProofShape` reads the transaction, not
    /// the caller, so it holds this frame to everything it holds a recovery from the account to.
    function checkRecovery(uint256[8] calldata proof, bytes32 ticket) external view {
        if (!_isExit()) revert NotAuthorized();
        _checkRecovery(proof, ticket, false);
    }

    function _checkRecovery(uint256[8] calldata proof, bytes32 ticket, bool paysItself) private view {
        Layout storage s = _layout();
        uint256 commitment = s.recoveryCommitment;
        if (commitment == 0) revert RecoveryNotSet();

        uint256 newRoot = uint256(framedataload(4, 1));
        uint256 nullifier = uint256(framedataload(36, 1));
        if (s.recoverySpent[nullifier]) revert NullifierSpent(nullifier);
        if (keccak256(abi.encode(ticket)) != s.recoveryGate) revert RecoveryGateInvalid();
        if (newRoot == 0) revert RootRequired();
        _requireProofShape(
            this.queueRecovery.selector,
            68,
            keccak256(abi.encodePacked(RECOVERY_TAG, nullifier, newRoot)),
            RECOVERY_EXECUTION_GAS,
            RECOVERY_STATE_GAS
        );
        // The fee must not come out of what the notes are owed. Anyone can top an account up if it is short.
        if (paysItself) {
            uint256 held = s.poolHeld;
            if (held != 0 && address(this).balance < held + txparam(TxParam.MAX_COST)) revert ValueNotConserved();
        }

        uint256 salt = uint256(s.epochSalt);
        uint256[8] memory input = [
            commitment,
            newRoot / LIMB,
            newRoot % LIMB,
            uint256(uint160(address(this))),
            salt / LIMB,
            salt % LIMB,
            block.chainid,
            nullifier
        ];
        if (!_verifyRecovery(proof, input)) revert RecoveryProofInvalid();
    }

    function _verifyRecovery(uint256[8] calldata p, uint256[8] memory input) private view returns (bool) {
        return RECOVERY_VERIFIER.verifyProof([p[0], p[1]], [[p[2], p[3]], [p[4], p[5]]], [p[6], p[7]], input);
    }

    /// V2: VERIFY frame for an unshield. The proof is the authority here too: whoever holds a note can spend it, with no key,
    /// so that no signature ties the withdrawal to anyone. A freeze stops it here, before it can reach a mempool.
    function validateUnshield(uint256[8] calldata proof, uint256 work) external {
        Layout storage s = _layout();
        if (s.frozen) revert AccountFrozen();

        uint256 root = uint256(framedataload(4, 1));
        uint256 nullifierHash = uint256(framedataload(36, 1));
        uint256 recipient = uint256(framedataload(68, 1));
        if (s.noteSpent[nullifierHash]) revert NullifierSpent(nullifierHash);
        // The circuit takes any field element. High bits would pass the proof and revert in `unshield`'s decoder, after the fee.
        if (recipient >> 160 != 0) revert ProofTxShapeInvalid();
        // V2: the nullifier alone. With the recipient in the key, one note had a nonce key per recipient, so its holder could keep
        // many valid transactions pending at once. Now a note has one slot, and one mined attempt. See `unshield`.
        bytes32 nonceKey = keccak256(abi.encodePacked(UNSHIELD_TAG, nullifierHash));
        _requireProofShape(this.unshield.selector, 100, nonceKey, UNSHIELD_EXECUTION_GAS, UNSHIELD_STATE_GAS);
        // Everything the pairing is asked about is in here, so that one solved `work` buys one pairing and not one per root or recipient.
        if (uint256(keccak256(abi.encode(address(this), proof, nonceKey, root, nullifierHash, recipient, work))) >> (256 - PROOF_WORK_BITS) != 0) {
            revert ProofWorkMissing();
        }
        if (!_isKnownRoot(s, root)) revert RootUnknown(root);

        // The note pays its own fee, so what the balance has to cover is the notes, and no more.
        uint256 held = s.poolHeld;
        if (held < DENOMINATION || address(this).balance < held) revert ValueNotConserved();

        uint256[6] memory input = [root, nullifierHash, recipient, DENOMINATION, uint256(uint160(address(this))), block.chainid];
        if (!_verifyShield(proof, input)) revert ShieldProofInvalid();

        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    function _verifyShield(uint256[8] calldata p, uint256[6] memory input) private view returns (bool) {
        return SHIELD_VERIFIER.verifyProof([p[0], p[1]], [[p[2], p[3]], [p[4], p[5]]], [p[6], p[7]], input);
    }

    function _isKnownRoot(Layout storage s, uint256 root) private view returns (bool) {
        if (root == 0) return false;
        for (uint256 i; i < ROOT_HISTORY; ++i) {
            if (s.roots[i] == root) return true;
        }
        return false;
    }

    /// V2: what stands in for a signature on a transaction authorized by a proof.
    ///
    /// `sender_approved` covers every SENDER frame, and nothing signed this one, so without these checks anyone who saw
    /// the proof could add a frame paying themselves and resend it. So the transaction must be exactly `[VERIFY, SENDER]`,
    /// and the SENDER frame must be this account calling `selector` with no value, exactly the arguments the proof is checked
    /// against, and exactly the gas it needs. The fee is capped for the same reason: a copy with a higher fee would still carry
    /// a valid proof.
    ///
    /// The nonce key comes from the nullifier, so a retry is the same bytes, and a thief's pending daily transaction cannot hold
    /// it up on a mempool that keeps the two nonce domains apart. That is the same reason an escape uses one.
    function _requireProofShape(bytes4 selector, uint256 dataLength, bytes32 nonceKey, uint256 executionGas, uint256 stateGas)
        private
        view
    {
        if (
            txparam(TxParam.CURRENT_FRAME_INDEX) != 0 || txparam(TxParam.FRAME_COUNT) != 2
                || frameparam(1, FrameParam.MODE) != uint256(FrameMode.SENDER)
                || address(uint160(frameparam(1, FrameParam.RESOLVED_TARGET))) != address(this)
                || frameparam(1, FrameParam.VALUE) != 0 || frameparam(1, FrameParam.DATA_LENGTH) != dataLength
                || frameparam(1, FrameParam.EXECUTION_GAS_LIMIT) != executionGas
                || frameparam(1, FrameParam.STATE_GAS_LIMIT) != stateGas
                || bytes4(framedataload(0, 1)) != selector || txparam(TxParam.NONCE_KEY_COUNT) != 1
                || txparam(TxParam.NONCE_KEY_0) != uint256(nonceKey) || txparam(TxParam.NONCE) != 0
        ) {
            revert ProofTxShapeInvalid();
        }
        uint256 cost = txparam(TxParam.MAX_COST);
        if (cost > MAX_PROOF_TX_COST) revert ProofTxCostExceeded(cost);
    }

    /// A stealth account's master key is derived from a secret the sender also holds, so on its own it proves nothing:
    /// see docs/STEALTH.md. It takes a second signature, from ERC-8441's stealth key, which the sender cannot compute.
    ///
    /// With no daily key to race, a stealth account runs on its linear nonce, which saves the 20,000 gas a keyed nonce
    /// charges on first use. Clones start at nonce 1, so leaf N is nonce N + 1, and the protocol still refuses a repeat.
    function _requireStealthSpend(address coSigner, uint256 leaf) private view {
        if (coSigner == address(0)) revert NonceKeyNotBoundToLeaf(leaf);
        if (txparam(TxParam.NONCE) != leaf + 1) revert LeafAlreadySpent(leaf);
        if (address(uint160(sigparam(1, SigParam.RESOLVED_SIGNER))) != coSigner || sigparam(1, SigParam.MSG) != 0) {
            revert CoSignerRequired();
        }
    }

    /// Spec §5. The chain id, account and nonce key are already inside the signature hash; the epoch salt is not, and
    /// it is what stops a signature from surviving a devnet reset.
    function masterDigest(uint256 nonceKey, bytes32 sigHash) public view returns (bytes32) {
        return keccak256(abi.encodePacked(block.chainid, _layout().epochSalt, address(this), nonceKey, sigHash));
    }

    // -------------------------------------------------------------------------------------------- rulebook --------

    /// Reachable only from this account's own SENDER frames, which VERIFY has already restricted.
    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotAuthorized();
        _;
    }

    /// The daily key's one way to move value. A spend that breaks a rule is not refused: it is queued, in public, and
    /// the master key has until it matures to cancel it.
    function spend(address asset, address recipient, uint256 amount) external onlySelf {
        Layout storage s = _layout();
        if (s.frozen) revert AccountFrozen();
        AssetRule storage rule = s.rules[asset];
        if (!rule.configured) revert MandateUnresolvable(asset);

        _rollWindow(rule);

        uint64 seen = s.firstSeen[recipient];
        if (seen == 0) {
            seen = uint64(block.timestamp);
            s.firstSeen[recipient] = seen;
        }
        bool cooling = block.timestamp < uint256(seen) + s.coolingPeriod;
        if (cooling && uint256(s.coolingSpent[asset][recipient]) + amount > rule.coolingAllowance) {
            _enqueue(s, asset, recipient, amount, QueueReason.NewPayeeCoolingActive);
            return;
        }
        if (uint256(rule.spentInWindow) + amount > rule.dailyLimit) {
            _enqueue(s, asset, recipient, amount, QueueReason.DailyLimitExceeded);
            return;
        }

        if (cooling) s.coolingSpent[asset][recipient] += uint128(amount);
        rule.spentInWindow += uint128(amount);
        rule.hourly[rule.lastHour % BUCKETS] += uint128(amount);
        _transfer(asset, recipient, amount);
        emit Spent(asset, recipient, amount);
    }

    /// Anyone may trigger a matured item: by then it has been public for the whole delay and the master key let it stand.
    ///
    /// V2: a matured recovery goes through here too, and a freeze does not stop it. Freeze stops spending, and the owner who
    /// lost the master key cannot unfreeze, so a frozen account has to stay recoverable.
    function executeQueued(uint256 id) external {
        Layout storage s = _layout();
        bool recovery = s.isRecovery[id];
        if (s.frozen && !recovery) revert AccountFrozen();
        QueuedItem storage item = s.queue[id];
        if (item.state == ItemState.Vetoed) {
            if (recovery) revert RecoveryVetoed(id);
            revert VetoedByEscapeKey(id);
        }
        if (item.state != ItemState.Pending) revert ItemNotPending(id);
        if (block.timestamp < item.executeAfter) revert QueuedPendingTimelock(item.executeAfter);
        item.state = ItemState.Executed;
        if (recovery) {
            bytes32 newRoot = bytes32(item.amount);
            emit RootRotated(s.wotsRoot, newRoot);
            emit RecoveryInstalled(id, newRoot);
            s.wotsRoot = newRoot;
        } else {
            _transfer(item.asset, item.recipient, item.amount);
        }
        emit QueueExecuted(id);
    }

    function _enqueue(Layout storage s, address asset, address recipient, uint256 amount, QueueReason reason) private {
        uint256 id = s.nextItem++;
        uint64 executeAfter = uint64(block.timestamp) + s.queueDelay;
        s.queue[id] = QueuedItem(recipient, asset, amount, executeAfter, ItemState.Pending);
        emit Queued(id, asset, recipient, amount, executeAfter, reason);
    }

    /// Clears the buckets that have left the window. At most `BUCKETS` steps, however long the account was idle.
    function _rollWindow(AssetRule storage rule) private {
        uint256 nowHour = block.timestamp / 1 hours;
        uint256 last = rule.lastHour;
        if (nowHour == last) return;
        uint256 steps = nowHour - last;
        if (steps > BUCKETS) steps = BUCKETS;
        uint128 spent = rule.spentInWindow;
        for (uint256 i = 1; i <= steps; ++i) {
            uint256 slot = (last + i) % BUCKETS;
            spent -= rule.hourly[slot];
            rule.hourly[slot] = 0;
        }
        rule.spentInWindow = spent;
        rule.lastHour = uint64(nowHour);
    }

    // ---------------------------------------------------------------------------------- master-key operations -----

    /// V2: what the second route may do. `veto`, `freeze` and `escape` only stop or leave. `queueRecovery` is here too, but the exit
    /// can reach it only with a proof: `VajraExit.validateExit` refuses the selector, and `validateRecovery` there asks `checkRecovery`.
    modifier onlySelfOrExit() {
        if (msg.sender != address(this) && !_isExit()) revert NotAuthorized();
        _;
    }

    /// Unset is zero, and zero must not match a caller.
    function _isExit() private view returns (bool) {
        address exit_ = _layout().exit;
        return exit_ != address(0) && msg.sender == exit_;
    }

    /// Cancels a queued spend.
    ///
    /// V2: the exit may not cancel a recovery. That is for an owner who still holds the master key, and a stolen exit key must not be
    /// able to kill the one way back of an owner who lost it: a paper gets one attempt.
    function veto(uint256 id) external onlySelfOrExit {
        if (msg.sender != address(this) && _layout().isRecovery[id]) revert NotAuthorized();
        QueuedItem storage item = _layout().queue[id];
        if (item.state != ItemState.Pending) revert ItemNotPending(id);
        item.state = ItemState.Vetoed;
        emit Vetoed(id);
    }

    /// Stops the world: every daily-key transaction is refused in VERIFY until the master key says otherwise.
    function freeze() external onlySelfOrExit {
        _layout().frozen = true;
        emit FrozenSet(true);
    }

    function unfreeze() external onlySelf {
        _layout().frozen = false;
        emit FrozenSet(false);
    }

    /// Reveals the sealed harbor and sends everything there. Leaves the account frozen, because the daily key that
    /// made this necessary is still valid.
    ///
    /// A token that refuses to transfer must not be able to block the exit, so failures are reported and skipped.
    ///
    /// @param harbor The harbor address the commitment seals.
    /// @param salt The salt the commitment was made with.
    /// @param extraAssets Tokens to sweep beyond the configured list.
    function escape(address payable harbor, bytes32 salt, address[] calldata extraAssets) external onlySelfOrExit {
        Layout storage s = _layout();
        if (keccak256(abi.encodePacked(harbor, salt)) != s.harborCommitment) revert HarborMismatch();
        s.frozen = true;
        emit FrozenSet(true);

        address[] storage configured = s.assets;
        for (uint256 i; i < configured.length; ++i) {
            if (configured[i] != address(0)) _sweep(configured[i], harbor);
        }
        for (uint256 i; i < extraAssets.length; ++i) {
            _sweep(extraAssets[i], harbor);
        }
        (bool sent,) = harbor.call{value: address(this).balance}("");
        if (!sent) emit SweepFailed(address(0));
        // V2: `balance` included the pool, so the notes have been paid to the harbor. A note must not be able to claim anything
        // that arrives later, so the pool closes for good. If the harbor refused, the money is still here and so are the notes.
        if (sent) {
            emit PoolDrained(harbor, s.poolHeld);
            s.poolHeld = 0;
            s.poolClosed = true;
        }
        emit Escaped(harbor);
    }

    /// Installs a new key tree. The reserved leaf can do this and nothing else.
    function rotateRoot(bytes32 newRoot) external onlySelf {
        Layout storage s = _layout();
        emit RootRotated(s.wotsRoot, newRoot);
        s.wotsRoot = newRoot;
    }

    /// V2: records the commitment to a recovery secret. Only the master key can reach this, since `validateDaily` does not
    /// allow the selector and a proof transaction is pinned to `queueRecovery`.
    ///
    /// @param commitment Poseidon(s). Zero turns recovery off.
    /// @param delay How long the master key has to veto. Spec 04 section 9.2 says 48 hours.
    function setRecovery(uint256 commitment, uint64 delay, bytes32 gate) external onlySelf {
        if (commitment >= FIELD) revert CommitmentInvalid();
        if (commitment != 0 && delay == 0) revert RecoveryDelayRequired();
        if (commitment != 0 && gate == bytes32(0)) revert RecoveryGateInvalid();
        Layout storage s = _layout();
        // A used paper's nullifier is spent and its ticket public, so setting it again would arm a recovery that can never work.
        if (commitment != 0 && (s.recoveryUsed[bytes32(commitment)] || s.recoveryUsed[gate])) revert RecoveryAlreadyUsed();
        s.recoveryCommitment = commitment;
        s.recoveryDelay = delay;
        s.recoveryGate = gate;
        emit RecoverySet(commitment, delay);
    }

    /// V2: the SENDER half of a recovery. Its arguments are what VERIFY checked the proof against. The new root goes into the
    /// same queue as a spend, so the same `veto` cancels it and `executeQueued` installs it, and anyone can trigger that.
    ///
    /// A nullifier is spent here even if the item is later vetoed, so a stolen secret gets one attempt. After a veto
    /// the owner, who still holds the master key, sets a new commitment.
    ///
    /// The ticket went public with this transaction, so the gate closes here: without that, anyone could copy the ticket and make
    /// every node run a pairing on a junk proof, for nothing. Only this closes it. A rotation of the key tree leaves the paper as
    /// it was, and an unused paper still works after one. The next paper comes from `setRecovery`, which the new tree can sign.
    function queueRecovery(bytes32 newRoot, uint256 nullifier) external onlySelfOrExit {
        Layout storage s = _layout();
        if (s.recoverySpent[nullifier]) revert NullifierSpent(nullifier);
        if (newRoot == bytes32(0)) revert RootRequired();
        s.recoverySpent[nullifier] = true;
        s.recoveryUsed[bytes32(s.recoveryCommitment)] = true;
        s.recoveryUsed[s.recoveryGate] = true;
        s.recoveryGate = bytes32(0);
        uint256 id = s.nextItem++;
        uint64 executeAfter = uint64(block.timestamp) + s.recoveryDelay;
        s.isRecovery[id] = true;
        s.queue[id] = QueuedItem(address(0), address(0), uint256(newRoot), executeAfter, ItemState.Pending);
        emit Queued(id, address(0), address(0), uint256(newRoot), executeAfter, QueueReason.Recovery);
    }

    /// V2: puts one note in the pool. The master key opens the pool with the first note. After that anyone may pay in, and the more
    /// who do, the larger the set a withdrawal hides among, but the pool belongs to this account: its master key can sweep every
    /// note to the harbor. A daily key cannot reach this, since `validateDaily` allows neither the selector nor a value.
    ///
    /// Only the owner opens it, because a pool makes the daily path read the balance in validation, and only a staked account may.
    /// An outsider's deposit must not be able to switch that on for an account that is not staked.
    ///
    /// @param commitment Poseidon(secret, nullifierSeed).
    function shield(uint256 commitment) external payable {
        Layout storage s = _layout();
        if (s.frozen) revert AccountFrozen();
        if (s.poolClosed) revert PoolClosed();
        if (s.nextNote == 0 && msg.sender != address(this)) revert PoolClosed();
        if (msg.value != DENOMINATION) revert ValueNotConserved();
        if (commitment == 0 || commitment >= FIELD) revert CommitmentInvalid();
        uint256 leaf = s.nextNote;
        if (leaf == 1 << POOL_DEPTH) revert PoolFull();

        uint256 node = commitment;
        uint256 index = leaf;
        for (uint256 level; level < POOL_DEPTH; ++level) {
            uint256 left;
            uint256 right;
            if (index & 1 == 0) {
                s.filled[level] = node;
                left = node;
                right = PoolZeros.at(level);
            } else {
                left = s.filled[level];
                right = node;
            }
            node = POSEIDON.poseidon([left, right]);
            index >>= 1;
        }

        uint32 cursor = s.rootCursor;
        s.roots[cursor] = node;
        s.rootCursor = uint32((cursor + 1) % ROOT_HISTORY);
        s.nextNote = uint32(leaf + 1);
        s.poolHeld += msg.value;
        // A master key paying in from this account must have the money to back it.
        if (address(this).balance < s.poolHeld) revert ValueNotConserved();
        emit Shielded(commitment, leaf, node);
    }

    /// V2: the SENDER half of an unshield. Its arguments are what VERIFY checked the proof against.
    ///
    /// This must not revert once VERIFY has passed. A reverted frame still pays its fee, out of the account and not the note, and
    /// the note would live on: a contract that refuses money would let a note's holder burn the owner's balance for as long as
    /// they cared to. So the note is spent whatever the recipient does. If it refuses, the money stays with the account, and the
    /// holder has lost the note. `vajra unshield` simulates first for that reason.
    function unshield(uint256 root, uint256 nullifierHash, address recipient) external onlySelf {
        Layout storage s = _layout();
        if (s.frozen) revert AccountFrozen();
        if (s.noteSpent[nullifierHash]) revert NullifierSpent(nullifierHash);
        if (!_isKnownRoot(s, root)) revert RootUnknown(root);
        if (s.poolHeld < DENOMINATION) revert ValueNotConserved();
        s.noteSpent[nullifierHash] = true;
        s.poolHeld -= DENOMINATION;
        // In assembly so that nothing is copied back: a recipient returning a huge blob would otherwise run this frame out of gas.
        uint256 amount = DENOMINATION - MAX_PROOF_TX_COST;
        bool paid;
        assembly ("memory-safe") {
            paid := call(gas(), recipient, amount, 0, 0, 0, 0)
        }
        if (paid) emit Unshielded(nullifierHash, recipient);
        else emit UnshieldUnpaid(nullifierHash, recipient);
    }

    /// Replaces a daily key known to be stolen.
    function setDailyKey(address newKey) external onlySelf {
        Layout storage s = _layout();
        emit DailyKeyChanged(s.dailyKey, newKey);
        s.dailyKey = newKey;
    }

    /// V2: names the second route's sender. Only the master key can reach this: `validateDaily` does not allow the selector, and a
    /// proof transaction is pinned to its own. Zero turns the route off.
    function setExit(address exit_) external onlySelf {
        _layout().exit = exit_;
        emit ExitChanged(exit_);
    }

    /// V2: names a paymaster a daily transaction may use. Only the master key can reach this. Whatever the account approved to that
    /// paymaster, the daily key can then spend on gas, up to `maxDailyTxCost` a transaction.
    function setSponsor(address paymaster, bool allowed) external onlySelf {
        _layout().sponsors[paymaster] = allowed;
        emit SponsorSet(paymaster, allowed);
    }

    function setRule(address asset, uint128 dailyLimit, uint128 coolingAllowance) external onlySelf {
        _setRule(asset, dailyLimit, coolingAllowance);
    }

    function setHarbor(bytes32 commitment) external onlySelf {
        _layout().harborCommitment = commitment;
        emit HarborChanged(commitment);
    }

    function _setRule(address asset, uint128 dailyLimit, uint128 coolingAllowance) private {
        Layout storage s = _layout();
        AssetRule storage rule = s.rules[asset];
        if (!rule.configured) {
            rule.configured = true;
            rule.lastHour = uint64(block.timestamp / 1 hours);
            s.assets.push(asset);
        }
        rule.dailyLimit = dailyLimit;
        rule.coolingAllowance = coolingAllowance;
        emit RuleChanged(asset, dailyLimit, coolingAllowance);
    }

    // -------------------------------------------------------------------------------------------- transfers -------

    function _transfer(address asset, address recipient, uint256 amount) private {
        bool ok;
        if (asset == address(0)) {
            // V2: what the notes are owed is not this account's to spend, whichever rule let the spend through.
            if (address(this).balance < amount + _layout().poolHeld) revert ValueNotConserved();
            (ok,) = recipient.call{value: amount}("");
        } else {
            ok = _tokenTransfer(asset, recipient, amount);
        }
        if (!ok) revert TransferFailed(asset);
    }

    /// A daily spend reverts on failure, so a plain call is fine here. Tolerates tokens that return nothing, like USDT.
    function _tokenTransfer(address token, address recipient, uint256 amount) private returns (bool ok) {
        bytes memory data = abi.encodeWithSelector(0xa9059cbb, recipient, amount);
        return _boundedCall(token, data, gasleft());
    }

    /// The exit has to work whatever a token does, so a sweep bounds both the gas a token can burn and the return data
    /// it can force the account to copy. Nothing a token returns can make this revert.
    function _sweep(address token, address harbor) private {
        uint256 held;
        bool read;
        bytes memory query = abi.encodeWithSelector(0x70a08231, address(this));
        assembly ("memory-safe") {
            read := staticcall(SWEEP_GAS, token, add(query, 32), mload(query), 0, 32)
            read := and(read, gt(returndatasize(), 31))
            held := mload(0)
        }
        if (!read) {
            emit SweepFailed(token);
            return;
        }
        if (held == 0) return;
        bytes memory data = abi.encodeWithSelector(0xa9059cbb, harbor, held);
        if (!_boundedCall(token, data, SWEEP_GAS)) emit SweepFailed(token);
    }

    /// True when the call succeeded and either returned nothing from real code, or returned a non-zero first word.
    function _boundedCall(address token, bytes memory data, uint256 gasLimit) private returns (bool ok) {
        assembly ("memory-safe") {
            ok := call(gasLimit, token, 0, add(data, 32), mload(data), 0, 32)
            switch returndatasize()
            case 0 { ok := and(ok, gt(extcodesize(token), 0)) }
            default { ok := and(ok, and(gt(returndatasize(), 31), iszero(iszero(mload(0))))) }
        }
    }

    // ---------------------------------------------------------------------------------------------- views ---------

    function dailyKey() external view returns (address) {
        return _layout().dailyKey;
    }

    function wotsRoot() external view returns (bytes32) {
        return _layout().wotsRoot;
    }

    function epochSalt() external view returns (bytes32) {
        return _layout().epochSalt;
    }

    function harborCommitment() external view returns (bytes32) {
        return _layout().harborCommitment;
    }

    function frozen() external view returns (bool) {
        return _layout().frozen;
    }

    function queueDelay() external view returns (uint64) {
        return _layout().queueDelay;
    }

    function coolingPeriod() external view returns (uint64) {
        return _layout().coolingPeriod;
    }

    function coSigner() external view returns (address) {
        return _layout().coSigner;
    }

    function nextItem() external view returns (uint256) {
        return _layout().nextItem;
    }

    function recoveryCommitment() external view returns (uint256) {
        return _layout().recoveryCommitment;
    }

    function recoveryDelay() external view returns (uint64) {
        return _layout().recoveryDelay;
    }

    function recoverySpent(uint256 nullifier) external view returns (bool) {
        return _layout().recoverySpent[nullifier];
    }

    function recoveryGate() external view returns (bytes32) {
        return _layout().recoveryGate;
    }

    function exit() external view returns (address) {
        return _layout().exit;
    }

    function sponsors(address paymaster) external view returns (bool) {
        return _layout().sponsors[paymaster];
    }

    /// ERC-5267. A client also reads this to learn that the account takes typed data: a V1 account has no such function.
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        )
    {
        return (hex"0f", "VAJRA", "2", block.chainid, address(this), bytes32(0), new uint256[](0));
    }

    function poolHeld() external view returns (uint256) {
        return _layout().poolHeld;
    }

    function poolClosed() external view returns (bool) {
        return _layout().poolClosed;
    }

    function noteCount() external view returns (uint256) {
        return _layout().nextNote;
    }

    function noteSpent(uint256 nullifierHash) external view returns (bool) {
        return _layout().noteSpent[nullifierHash];
    }

    function isKnownRoot(uint256 root) external view returns (bool) {
        return _isKnownRoot(_layout(), root);
    }

    /// The newest root, or the empty tree's if nothing has been shielded.
    function poolRoot() external view returns (uint256) {
        Layout storage s = _layout();
        if (s.nextNote == 0) return PoolZeros.at(POOL_DEPTH);
        return s.roots[(s.rootCursor + ROOT_HISTORY - 1) % ROOT_HISTORY];
    }

    function isRecovery(uint256 id) external view returns (bool) {
        return _layout().isRecovery[id];
    }

    function queuedItem(uint256 id) external view returns (QueuedItem memory) {
        return _layout().queue[id];
    }

    function assets() external view returns (address[] memory) {
        return _layout().assets;
    }

    function firstSeen(address payee) external view returns (uint64) {
        return _layout().firstSeen[payee];
    }

    /// The limit, what the window has used, and what a spend could use right now, as of the current block.
    function rule(address asset)
        external
        view
        returns (bool configured, uint128 dailyLimit, uint128 coolingAllowance, uint128 spent)
    {
        AssetRule storage r = _layout().rules[asset];
        configured = r.configured;
        dailyLimit = r.dailyLimit;
        coolingAllowance = r.coolingAllowance;
        spent = r.spentInWindow;
        uint256 nowHour = block.timestamp / 1 hours;
        uint256 steps = nowHour - r.lastHour;
        if (steps > BUCKETS) steps = BUCKETS;
        for (uint256 i = 1; i <= steps; ++i) {
            spent -= r.hourly[(r.lastHour + i) % BUCKETS];
        }
    }

    function _layout() private pure returns (Layout storage s) {
        bytes32 slot = STORAGE_SLOT;
        assembly ("memory-safe") {
            s.slot := slot
        }
    }
}
