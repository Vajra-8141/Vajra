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
contract VajraAccount is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    // ------------------------------------------------------------------------------------------ constants ---------

    /// Levels in the key tree; 64 one-time keys.
    uint256 public constant TREE_DEPTH = 6;
    /// The last leaf can only install a new root, so a tree can always be replaced.
    uint256 public constant ROTATION_LEAF = 63;
    /// Spending is tracked in hourly buckets. 25 of them keep the window at or above a full 24 hours.
    uint256 private constant BUCKETS = 25;

    /// Domain of the digest a stock wallet signs.
    bytes32 private constant WALLET_TAG = keccak256("vajra.daily.v1");
    /// Gas a single token gets during a sweep, enough for a proxied USDC transfer with room to spare.
    uint256 private constant SWEEP_GAS = 300_000;

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
        NewPayeeCoolingActive
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

    // ---------------------------------------------------------------------------------------- construction --------

    /// The implementation holds no account of its own. It is locked here, and clones initialize through the factory.
    constructor(uint256 logW, uint256 len2, address stakingRegistry) {
        STAKING_REGISTRY = stakingRegistry;
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
        _requireDailySignature(s.dailyKey);

        // Fees are paid before the rulebook runs, so they are the one way value can leave without passing it. The scope
        // is the signer's to choose, and payment can be approved in a frame of its own, so this has to hold whenever
        // payment is included in it, not only for the combined scope.
        if (scope != Scope.EXECUTION) {
            uint256 cost = txparam(TxParam.MAX_COST);
            if (cost > s.maxDailyTxCost) revert DailyTxCostExceeded(cost);
        }

        uint256 frames = txparam(TxParam.FRAME_COUNT);
        for (uint256 i = txparam(TxParam.CURRENT_FRAME_INDEX) + 1; i < frames; ++i) {
            if (frameparam(i, FrameParam.MODE) != uint256(FrameMode.SENDER)) continue;
            if (address(uint160(frameparam(i, FrameParam.RESOLVED_TARGET))) != address(this)) revert FrameNotAllowed(i);
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
    /// rebuilt here from the transaction's fields, and personal_sign is applied to that.
    function _requireDailySignature(address key) private view {
        if (key == address(0) || address(uint160(sigparam(0, SigParam.RESOLVED_SIGNER))) != key) revert NotDailyKey();
        uint256 signed = sigparam(0, SigParam.MSG);
        if (signed != 0 && bytes32(signed) != _walletDigest()) revert SignatureNotBoundToTransaction();
    }

    /// Covers everything a wallet signature leaves open. The shape is pinned to `[VERIFY, SENDER]` so that no frame can
    /// sit outside the digest, and the body frame's target and value are held to the account and zero by `validateDaily`.
    function _walletDigest() private view returns (bytes32) {
        if (txparam(TxParam.CURRENT_FRAME_INDEX) != 0 || txparam(TxParam.FRAME_COUNT) != 2) {
            revert SignatureNotBoundToTransaction();
        }
        bytes32 message = keccak256(
            abi.encode(
                WALLET_TAG,
                block.chainid,
                address(this),
                txparam(TxParam.NONCE),
                txparam(TxParam.NONCE_KEYS_HASH),
                txparam(TxParam.MAX_FEE),
                txparam(TxParam.MAX_PRIORITY_FEE_PER_GAS),
                frameparam(1, FrameParam.EXECUTION_GAS_LIMIT),
                frameparam(1, FrameParam.STATE_GAS_LIMIT),
                keccak256(framedatacopy(0, frameparam(1, FrameParam.DATA_LENGTH), 1))
            )
        );
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", message));
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
    function executeQueued(uint256 id) external {
        Layout storage s = _layout();
        if (s.frozen) revert AccountFrozen();
        QueuedItem storage item = s.queue[id];
        if (item.state == ItemState.Vetoed) revert VetoedByEscapeKey(id);
        if (item.state != ItemState.Pending) revert ItemNotPending(id);
        if (block.timestamp < item.executeAfter) revert QueuedPendingTimelock(item.executeAfter);
        item.state = ItemState.Executed;
        _transfer(item.asset, item.recipient, item.amount);
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

    /// Cancels a queued spend.
    function veto(uint256 id) external onlySelf {
        QueuedItem storage item = _layout().queue[id];
        if (item.state != ItemState.Pending) revert ItemNotPending(id);
        item.state = ItemState.Vetoed;
        emit Vetoed(id);
    }

    /// Stops the world: every daily-key transaction is refused in VERIFY until the master key says otherwise.
    function freeze() external onlySelf {
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
    function escape(address payable harbor, bytes32 salt, address[] calldata extraAssets) external onlySelf {
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
        emit Escaped(harbor);
    }

    /// Installs a new key tree. The reserved leaf can do this and nothing else.
    function rotateRoot(bytes32 newRoot) external onlySelf {
        Layout storage s = _layout();
        emit RootRotated(s.wotsRoot, newRoot);
        s.wotsRoot = newRoot;
    }

    /// Replaces a daily key known to be stolen.
    function setDailyKey(address newKey) external onlySelf {
        Layout storage s = _layout();
        emit DailyKeyChanged(s.dailyKey, newKey);
        s.dailyKey = newKey;
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
