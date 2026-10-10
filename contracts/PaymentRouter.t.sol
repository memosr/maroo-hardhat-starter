// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

import {PaymentRouter} from "./PaymentRouter.sol";

/// Recipient that tries to re-enter `pay` when it receives funds.
contract ReentrantRecipient {
    PaymentRouter internal immutable router;

    constructor(PaymentRouter router_) {
        router = router_;
    }

    receive() external payable {
        router.pay{value: msg.value}(payable(address(this)));
    }
}

contract PaymentRouterTest is Test {
    uint256 internal constant MAX = 10 ether;
    PaymentRouter internal router;
    address internal owner = makeAddr("owner");
    address internal payer = makeAddr("payer");

    function setUp() public {
        PaymentRouter implementation = new PaymentRouter();
        bytes memory init = abi.encodeCall(PaymentRouter.initialize, (owner, MAX));
        router = PaymentRouter(address(new TransparentUpgradeableProxy(address(implementation), owner, init)));
        vm.deal(payer, 100 ether);
    }

    function testFuzz_PayForwardsExactAmount(address recipient, uint256 amount) public {
        // Only plain EOAs: skip precompiles, cheatcodes, this test and the proxy.
        vm.assume(recipient.code.length == 0 && uint160(recipient) > 0x10000);
        vm.assume(recipient != payer);
        amount = bound(amount, 1, MAX);

        uint256 before = recipient.balance;
        vm.prank(payer);
        router.pay{value: amount}(payable(recipient));

        assertEq(recipient.balance - before, amount);
        assertEq(address(router).balance, 0);
        assertEq(router.paymentCount(), 1);
    }

    function test_ReentrancyIsBlocked() public {
        ReentrantRecipient attacker = new ReentrantRecipient(router);
        // The nested pay() reverts on the guard, so the outer transfer fails.
        vm.prank(payer);
        vm.expectRevert(PaymentRouter.TransferFailed.selector);
        router.pay{value: 1 ether}(payable(address(attacker)));
        assertEq(router.paymentCount(), 0);
    }
}
