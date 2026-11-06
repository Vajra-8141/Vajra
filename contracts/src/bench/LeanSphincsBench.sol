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

interface ILeanSphincsS {
    function verify(bytes32 pkSeed, bytes32 pkRoot, bytes32 message, bytes calldata sig) external pure returns (bool);
}

/// For `vajra sphincs-bench`, on the mirror. Nothing else deploys this, and it is not for real money.
///
/// A sender whose one key is a leanSphincs-S key, so that the benchmark can send real signatures through a real VERIFY frame. It is
/// cloned by `VajraExitFactory`, and keeps its key in storage, so that it pays what a clone of `VajraExit` or `VajraAccountV2` pays.
///
/// `account` picks the shape it measures:
///
///   - Set: `VajraExit`'s shape. It holds the key to `veto`, `freeze` and `escape` on that account, and needs no change to the account:
///     `setExit` takes any address.
///   - Zero: `validateMaster`'s shape, with no walk over the frames. The key can do anything this sender can. `setExit` refuses this shape,
///     and bytes from before docs/FINDINGS.md section 21 did not.
///
/// Either way it is not a whole exit. It cannot take its reserve back, replace its key, or carry a recovery.
///
/// The key is stateless, so unlike `VajraExit` this does not tie a nonce key to anything. The signature hash commits to the nonce keys
/// and the sequence, nothing but this key can sign for this sender, and the protocol refuses a repeat.
contract LeanSphincsBench is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    uint256 private constant SIGNATURE_BYTES = 4164;
    bytes32 private constant HIGH_HALF = bytes32(uint256(type(uint128).max) << 128);

    bytes4 private constant ESCAPE = bytes4(keccak256("escape(address,bytes32,address[])"));
    bytes4 private constant VETO = bytes4(keccak256("veto(uint256)"));
    bytes4 private constant FREEZE = bytes4(keccak256("freeze()"));

    ILeanSphincsS public immutable VERIFIER;

    address public account;
    /// `root ‖ P`, the scheme's whole public key.
    bytes32 public root;
    bytes32 public epochSalt;

    error AlreadyInitialized();
    error RootRequired();
    error NotAuthorized();
    error FrameNotAllowed(uint256 frame);
    error SignatureLengthInvalid(uint256 length);
    error BadSignature();

    constructor(address verifier) {
        VERIFIER = ILeanSphincsS(verifier);
        root = bytes32(uint256(1));
    }

    /// The form `VajraExitFactory` calls. There is no stake: this reads only its own storage, and the verifier reads none.
    function initialize(address account_, bytes32 root_, bytes32 epochSalt_, uint128, uint32) external payable {
        if (root != bytes32(0)) revert AlreadyInitialized();
        if (root_ == bytes32(0)) revert RootRequired();
        account = account_;
        root = root_;
        epochSalt = epochSalt_;
    }

    receive() external payable {}

    /// The VERIFY frame. Named as `VajraExit`'s is, so that `exitTx` builds it.
    function validateExit() external {
        if (address(uint160(txparam(TxParam.SENDER))) != address(this)) revert NotAuthorized();

        address target = account;
        if (target != address(0)) {
            uint256 frames = txparam(TxParam.FRAME_COUNT);
            for (uint256 i = txparam(TxParam.CURRENT_FRAME_INDEX) + 1; i < frames; ++i) {
                uint256 mode = frameparam(i, FrameParam.MODE);
                if (mode == uint256(FrameMode.VERIFY)) continue;
                bytes4 selector = bytes4(framedataload(0, i));
                if (
                    mode != uint256(FrameMode.SENDER) || address(uint160(frameparam(i, FrameParam.RESOLVED_TARGET))) != target
                        || frameparam(i, FrameParam.VALUE) != 0
                        || (selector != ESCAPE && selector != VETO && selector != FREEZE)
                ) {
                    revert FrameNotAllowed(i);
                }
            }
        }

        // The signature's bytes sit outside the signature hash and are charged by the byte, so without this anyone could pad a copy and
        // burn the payer's money. `VajraAccountV2` and `VajraExit` cannot afford this check: see docs/FINDINGS.md section 15.
        uint256 length = sigparam(0, SigParam.SIGNATURE_LENGTH);
        if (length != SIGNATURE_BYTES) revert SignatureLengthInvalid(length);

        bytes32 key = root;
        bytes32 digest = keccak256(
            abi.encodePacked(block.chainid, epochSalt, address(this), txparam(TxParam.NONCE_KEY_0), txparam(TxParam.SIG_HASH))
        );
        if (!VERIFIER.verify(key << 128, key & HIGH_HALF, digest, sigdatacopy(0, SIGNATURE_BYTES, 0))) revert BadSignature();

        approve(Scope.EXECUTION_AND_PAYMENT);
    }
}
