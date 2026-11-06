// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport, Devnet, TxParam, FrameParam, FrameMode, SigParam} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";

/// What the two paymasters share: the shape of a sponsored transaction, and the arithmetic of its refund.
///
///     [only_verify, charge, pay, SENDER..., settle]
///
/// `pay` is a VERIFY frame, so it cannot write. `charge` is the `pre_verify` frame just before it, which can. It takes the
/// transaction's maximum cost before any sponsored code runs, and `pay` refuses unless that frame succeeded. A failed frame
/// does not fail a transaction on its own, so that check is the whole defence: there is no repayment after the fact for
/// the body to dodge, and no repay frame that can be starved into free gas.
///
/// `settle` runs last and gives back what the transaction provably did not use. Starving it costs the sender their refund and
/// the paymaster nothing, and `pay` refuses a settle limit that is too low.
///
/// A frame's status is not proof that its effects stand. An atomic batch that unrolls keeps the status of the frames it undid, so
/// `[self_verify, collect (batched), a frame that reverts, settle]` once took 30 USDC from the float: the collect was undone, and
/// settle refunded it anyway. So a charge frame insists the next frame is this contract's `pay`. A batch flag cannot be followed by a
/// VERIFY frame, so such a charge is not in a batch that can undo it, and only one `pay` in a transaction can approve, so a valid
/// transaction holds one charge at most. `settle` then checks that `pay` ran as well.
///
/// The order of the checks is forced by ethrex's prefix simulator, which is what a mempool sees. It stops at the first frame that
/// fails, so `pay` never runs after a failed `charge`, and `charge` has to name its own refusals. And it keeps no frame results, so
/// `FRAMEPARAM STATUS` halts there, with no data: anything `pay` wants to refuse by name has to come before that read. The read
/// still decides for real on chain, where every failed frame goes on to `pay`.
abstract contract FramePaymaster is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    /// The caller of every DEFAULT and VERIFY frame. A SENDER frame calls as the sender, so this keeps the body out.
    address internal constant ENTRY_POINT = address(0xaa);

    /// The settle frame's whole limit counts as used, which is what covers the bytes `_refundableGas` cannot see: 16 recent-root
    /// references are 1,235 bytes of RLP, which at the floor of 64 gas per byte is 79,040.
    uint256 public constant SETTLE_GAS = 100_000;

    /// EIP-7623 on this fork: 4 tokens a byte, 16 gas a token, zero or not.
    uint256 private constant FLOOR_PER_BYTE = 64;
    /// A signature entry's `signer` and `msg`, at their longest.
    uint256 private constant SIGNATURE_ENTRY_BYTES = 52;
    /// One nonce key in `rlp(nonce_keys)`, and room for the rest of that field and `rlp(nonce_seq)`.
    uint256 private constant NONCE_KEY_BYTES = 33;
    uint256 private constant NONCE_BYTES = 16;

    address public immutable OWNER;
    address public immutable STAKING_REGISTRY;
    /// The least gas a charge frame may carry. Below this it would fail, and `pay` could only say that it failed.
    uint256 public immutable CHARGE_GAS;
    uint256 public immutable CHARGE_STATE_GAS;

    /// The highest `max_fee_per_gas` this paymaster will sponsor. A tip above the base fee goes to the block producer, so
    /// this is what stops a producer and an account paying themselves out of the paymaster.
    uint256 public feeCap;

    event FeeCapSet(uint256 feeCap);

    error NotOwner();
    error NotEntryPoint();
    error ChargeFrameMissing();
    error PayFrameMissing();
    error ChargeFrameStarved(uint256 execution, uint256 state);
    error ChargeFrameFailed();
    error SettleFrameMissing();
    error SettleFrameStarved(uint256 execution);
    error SettleNotLast();
    error NothingToSettle();
    error FeeTooHigh(uint256 maxFee, uint256 cap);
    error BlobsNotSponsored();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != OWNER) revert NotOwner();
        _;
    }

    modifier onlyFrame() {
        if (msg.sender != ENTRY_POINT) revert NotEntryPoint();
        _;
    }

    constructor(address owner, address stakingRegistry, uint256 feeCap_, uint256 chargeGas, uint256 chargeStateGas) {
        OWNER = owner;
        STAKING_REGISTRY = stakingRegistry;
        feeCap = feeCap_;
        CHARGE_GAS = chargeGas;
        CHARGE_STATE_GAS = chargeStateGas;
    }

    receive() external payable {}

    function setFeeCap(uint256 feeCap_) external onlyOwner {
        feeCap = feeCap_;
        emit FeeCapSet(feeCap_);
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        (bool sent,) = to.call{value: amount}("");
        if (!sent) revert TransferFailed();
    }

    /// Stake is keyed on the caller, so the paymaster has to make these calls itself: `addStake`, `unlockStake`, `withdrawStake`.
    function callRegistry(bytes calldata data) external payable onlyOwner {
        (bool done, bytes memory reason) = STAKING_REGISTRY.call{value: msg.value}(data);
        if (!done) {
            assembly ("memory-safe") {
                revert(add(reason, 32), mload(reason))
            }
        }
    }

    /// The `pay` frame.
    function pay() external virtual;

    /// The last frame of a sponsored transaction.
    function settle(uint256 frame) external virtual;

    function _sender() internal view returns (address) {
        return address(uint160(txparam(TxParam.SENDER)));
    }

    function _maxCost() internal view returns (uint256) {
        return txparam(TxParam.MAX_COST);
    }

    /// `max_gas`. With no blobs, which `_requireSponsorable` holds to, the maximum cost is exactly this times the fee.
    function _maxGas() internal view returns (uint256) {
        return _maxCost() / txparam(TxParam.MAX_FEE);
    }

    function _isOwnFrame(uint256 index, FrameMode mode, bytes4 selector) private view returns (bool) {
        return frameparam(index, FrameParam.MODE) == uint256(mode) && address(uint160(frameparam(index, FrameParam.RESOLVED_TARGET))) == address(this)
            && bytes4(framedataload(0, index)) == selector;
    }

    function _isOwnDefaultFrame(uint256 index, bytes4 selector) private view returns (bool) {
        return _isOwnFrame(index, FrameMode.DEFAULT, selector);
    }

    /// The first thing a charge frame does. Too little to get this far is out of gas, which is a refusal without a name.
    function _requireChargeFrame() internal view {
        uint256 current = txparam(TxParam.CURRENT_FRAME_INDEX);
        uint256 execution = frameparam(current, FrameParam.EXECUTION_GAS_LIMIT);
        uint256 state = frameparam(current, FrameParam.STATE_GAS_LIMIT);
        if (execution < CHARGE_GAS || state < CHARGE_STATE_GAS) revert ChargeFrameStarved(execution, state);
        if (
            current + 1 >= txparam(TxParam.FRAME_COUNT) || frameparam(current, FrameParam.ATOMIC_BATCH) != 0
                || !_isOwnFrame(current + 1, FrameMode.VERIFY, this.pay.selector)
        ) revert PayFrameMissing();
    }

    /// Everything a pay frame insists on before it looks at its own policy. Returns the index of the charge frame.
    function _requireSponsorable(bytes4 chargeSelector) internal view returns (uint256 charge) {
        uint256 current = txparam(TxParam.CURRENT_FRAME_INDEX);
        uint256 last = txparam(TxParam.FRAME_COUNT) - 1;

        if (current == 0 || !_isOwnDefaultFrame(current - 1, chargeSelector)) revert ChargeFrameMissing();
        charge = current - 1;
        if (last <= current || !_isOwnDefaultFrame(last, this.settle.selector) || uint256(framedataload(4, last)) != charge) {
            revert SettleFrameMissing();
        }

        uint256 execution = frameparam(last, FrameParam.EXECUTION_GAS_LIMIT);
        if (execution < SETTLE_GAS) revert SettleFrameStarved(execution);

        uint256 fee = txparam(TxParam.MAX_FEE);
        if (fee > feeCap) revert FeeTooHigh(fee, feeCap);
        if (txparam(TxParam.BLOB_COUNT) != 0) revert BlobsNotSponsored();
    }

    /// Last in `pay`: see the top of this file.
    function _charged(uint256 charge) internal view returns (bool) {
        return frameparam(charge, FrameParam.STATUS) == 1;
    }

    /// Gas the sender was charged for and provably did not use. It may only ever be too low.
    ///
    /// Limits and gas used are summed apart: a frame that fails for want of state gas reports more than its limit, and that excess
    /// has to count against the unused gas of the others.
    ///
    /// What the payer really owes is `mandatory + max(data + E, floor) + S`, for execution gas E and state gas S. `max_gas` less
    /// the unused limits of every earlier frame covers everything but the floor, which is 64 gas for each byte carried. So those
    /// bytes come off the refund, whether or not the floor binds. Without that, a transaction stuffed with data would be
    /// refunded the floor it owes.
    ///
    /// It has to run last: a settle before the body would count the body's whole limit as unused.
    function _refundableGas(uint256 charge, bytes4 chargeSelector) internal view returns (uint256) {
        uint256 current = txparam(TxParam.CURRENT_FRAME_INDEX);
        if (current != txparam(TxParam.FRAME_COUNT) - 1) revert SettleNotLast();
        if (charge + 1 >= current || !_isOwnDefaultFrame(charge, chargeSelector) || !_charged(charge)) revert NothingToSettle();
        if (!_isOwnFrame(charge + 1, FrameMode.VERIFY, this.pay.selector) || !_charged(charge + 1)) revert NothingToSettle();

        uint256 limits;
        uint256 used;
        uint256 size = frameparam(current, FrameParam.DATA_LENGTH) + NONCE_BYTES + txparam(TxParam.NONCE_KEY_COUNT) * NONCE_KEY_BYTES;
        for (uint256 i; i < current; ++i) {
            // Only the three modes whose gas this arithmetic was worked out for.
            if (frameparam(i, FrameParam.MODE) > uint256(FrameMode.SENDER)) return 0;
            limits += frameparam(i, FrameParam.EXECUTION_GAS_LIMIT) + frameparam(i, FrameParam.STATE_GAS_LIMIT);
            used += frameparam(i, FrameParam.EXECUTION_GAS_USED) + frameparam(i, FrameParam.STATE_GAS_USED);
            size += frameparam(i, FrameParam.DATA_LENGTH);
        }
        uint256 signatures = txparam(TxParam.SIGNATURE_COUNT);
        for (uint256 i; i < signatures; ++i) {
            size += sigparam(i, SigParam.SIGNATURE_LENGTH) + SIGNATURE_ENTRY_BYTES;
        }
        return _less(limits, used + size * FLOOR_PER_BYTE);
    }

    function _less(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : 0;
    }
}
