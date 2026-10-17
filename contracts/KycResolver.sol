// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SchemaResolver} from "./vendor/eas/resolver/SchemaResolver.sol";
import {IEAS, Attestation} from "./vendor/eas/IEAS.sol";

/// @title KycResolver
/// @notice EAS schema resolver that turns Maroo's EAS_POLICY into a real KYC gate.
/// @dev Maroo's PCL EAS_POLICY passes a sender who holds ANY valid, indexed,
///      non-revoked, non-expired attestation of the schema. It does not check
///      who issued it or what it says. Registering the schema with this
///      resolver closes both gaps at the source: EAS calls `onAttest` and
///      reverts the attestation unless it is
///        - issued by `issuer`,
///        - for a non-zero recipient,
///        - with an expiration time (KYC must be renewed), and
///        - encoding `kycPassed == true` for the schema `bool kycPassed`.
///      The schema UID includes this resolver's address, so attestations that
///      bypass these checks cannot exist under that UID.
contract KycResolver is SchemaResolver {
    /// @notice The schema this resolver is meant to be registered with.
    string public constant SCHEMA = "bool kycPassed";

    /// @notice The only account allowed to issue KYC attestations.
    address public immutable issuer;

    error ZeroIssuer();

    constructor(IEAS eas, address issuer_) SchemaResolver(eas) {
        if (issuer_ == address(0)) revert ZeroIssuer();
        issuer = issuer_;
    }

    function onAttest(Attestation calldata attestation, uint256 /* value */) internal view override returns (bool) {
        if (attestation.attester != issuer) return false;
        if (attestation.recipient == address(0)) return false;
        if (attestation.expirationTime == 0) return false;
        // `bool kycPassed` encodes to exactly one 32-byte word equal to 1.
        if (attestation.data.length != 32) return false;
        return abi.decode(attestation.data, (uint256)) == 1;
    }

    function onRevoke(Attestation calldata /* attestation */, uint256 /* value */) internal pure override returns (bool) {
        // EAS itself only lets the original attester (the issuer) revoke.
        return true;
    }
}
