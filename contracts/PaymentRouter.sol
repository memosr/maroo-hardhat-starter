// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title PaymentRouter
/// @notice Example contract designed to run behind a Maroo PCL proxy.
/// @dev Deploy flow on Maroo:
///      1. Deploy this contract as the implementation (initializers disabled).
///      2. Call the PCL precompile `deployPclProxy` with `initialize(...)` data.
///      3. Attach PCL policies (denylist, volume, EAS) to the `pay` selector.
///      The chain enforces those policies BEFORE `pay` executes, so compliance
///      rules live in PCL, while business rules (like `maxPayment`) live here.
///      Uses transient storage (TSTORE/TLOAD), supported on Maroo (Cancun).
contract PaymentRouter is Initializable, OwnableUpgradeable, ReentrancyGuardTransient {
    /// @notice Upper bound for a single payment, in wei of the native token (tOKRW).
    uint256 public maxPayment;

    /// @notice Number of successful payments routed through this contract.
    uint256 public paymentCount;

    event Paid(address indexed payer, address indexed recipient, uint256 amount);
    event MaxPaymentUpdated(uint256 previous, uint256 current);

    error ZeroAmount();
    error ZeroRecipient();
    error ZeroMaxPayment();
    error AmountAboveMax(uint256 amount, uint256 maxPayment);
    error TransferFailed();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // Lock the implementation so it can only be used through a proxy.
        _disableInitializers();
    }

    /// @notice Called once by the proxy at deployment (via `deployPclProxy` init data).
    function initialize(address initialOwner, uint256 initialMaxPayment) external initializer {
        __Ownable_init(initialOwner);
        _setMaxPayment(initialMaxPayment);
    }

    /// @notice Forward native tOKRW to `recipient`.
    /// @dev PCL policies attached to this selector run before this body.
    function pay(address payable recipient) external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroRecipient();
        if (msg.value > maxPayment) revert AmountAboveMax(msg.value, maxPayment);

        // Effects before interaction.
        ++paymentCount;

        (bool ok,) = recipient.call{value: msg.value}("");
        if (!ok) revert TransferFailed();

        emit Paid(msg.sender, recipient, msg.value);
    }

    /// @notice Owner-only business limit, independent of PCL compliance policies.
    function setMaxPayment(uint256 newMaxPayment) external onlyOwner {
        _setMaxPayment(newMaxPayment);
    }

    function _setMaxPayment(uint256 newMaxPayment) private {
        if (newMaxPayment == 0) revert ZeroMaxPayment();
        emit MaxPaymentUpdated(maxPayment, newMaxPayment);
        maxPayment = newMaxPayment;
    }
}
