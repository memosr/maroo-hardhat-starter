import { encodeAbiParameters, encodePacked, isAddressEqual, keccak256, parseEventLogs, type Abi, type Address, type Hex, type Log } from "viem";

/** Schema registered with KycResolver. Must match KycResolver.SCHEMA. */
export const KYC_SCHEMA = "bool kycPassed";

/**
 * EAS schema UID, computed exactly like SchemaRegistry._getUID:
 * keccak256(abi.encodePacked(schema, resolver, revocable)).
 */
export function kycSchemaUid(resolver: Address, revocable = true): Hex {
  return keccak256(encodePacked(["string", "address", "bool"], [KYC_SCHEMA, resolver, revocable]));
}

/** ABI-encode the attestation payload for `bool kycPassed`. */
export function encodeKycData(kycPassed: boolean): Hex {
  return encodeAbiParameters([{ type: "bool" }], [kycPassed]);
}

/**
 * Read the attestation UID from an attest() receipt. Only trusts `Attested`
 * events emitted by the EAS contract itself.
 */
export function attestedUid(logs: Log[], easAbi: Abi, easAddress: Address): Hex {
  const events = parseEventLogs({
    abi: easAbi,
    logs: logs.filter((log) => isAddressEqual(log.address, easAddress)),
    eventName: "Attested",
    strict: true,
  }) as unknown as { args: { uid: Hex } }[];
  if (events.length !== 1) throw new Error(`Expected one Attested event from EAS, found ${events.length}.`);
  return events[0].args.uid;
}
