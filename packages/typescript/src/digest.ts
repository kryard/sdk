/**
 * digest.ts — the off-chain mirror of KryardDelegate's v2.1 auth digest + calldata.
 *
 * v2.1 CUTOVER (breaking): the auth digest is now EIP-712 typed data, NOT
 * personal_sign. The user signs the RAW 32-byte `delegateDigest(...)` with plain
 * ECDSA (viem: `account.sign({ hash: digest })`) — NO `toEthSignedMessageHash` /
 * personal_sign prefixing — because the contract verifies it directly as
 * `ECDSA.recover(digest, signature) == EOA` (see KryardDelegate._authorize).
 *
 * MUST match KryardDelegate v2.1 byte-for-byte (pinned by `test/parity.test.ts`
 * against Foundry golden vectors):
 *
 *   digest         = keccak256(0x1901 ‖ domainSeparator ‖ structHash)            (EIP-712)
 *   domainSeparator= keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("KryardDelegate"),
 *                                         keccak256("1"), chainId, account))      (account == the EOA)
 *   callsHash      = keccak256( ‖_i keccak256(abi.encode(CALL_TYPEHASH, to, value, keccak256(data))) )
 *   structHash     = keccak256(abi.encode(EXECUTE_TYPEHASH, callsHash, nonce, deadline))       — execute
 *                  = keccak256(abi.encode(EXECUTE_REIMBURSE_TYPEHASH, callsHash, nonce,
 *                              deadline, gasToken, gasTokenAmount, relayer))       — reimburse
 *
 * Changes vs the v1/v2 scheme (personal_sign) the integrator MUST know:
 *   - digest scheme: personal_sign  → raw EIP-712 (0x1901). Sign raw, not prefixed.
 *   - callsHash: `keccak256(abi.encode(calls))` → full nested EIP-712 `Call[]` hashing.
 *   - a new `deadline` field is bound into every digest AND both entry points.
 *   - requires the deployed v2.1 delegate at 0xF715155b24A5A0664f9FcF4B2Cbb8a30A2eF9049.
 */
import { concat, encodeAbiParameters, encodeFunctionData, keccak256, toHex, type Hex } from "viem";
import { KRYARD_DELEGATE_ABI } from "./abi.js";

export interface Call {
  to: Hex;
  value: bigint;
  data: Hex;
}

const ZERO = "0x0000000000000000000000000000000000000000" as const;

// --- EIP-712 typehashes — mirror KryardDelegate v2.1 verbatim. ---
const DOMAIN_TYPEHASH = keccak256(
  toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);
const NAME_HASH = keccak256(toHex("KryardDelegate"));
const VERSION_HASH = keccak256(toHex("1"));
const CALL_TYPEHASH = keccak256(toHex("Call(address to,uint256 value,bytes data)"));
// FULL nested EIP-712 typehashes — the referenced `Call(...)` struct is appended
// (alphabetical, per EIP-712 §"Definition of encodeType"). Keep byte-identical to
// the contract's constants or the digest will diverge.
const EXECUTE_TYPEHASH = keccak256(
  toHex("Execute(Call[] calls,uint256 nonce,uint256 deadline)Call(address to,uint256 value,bytes data)"),
);
const EXECUTE_REIMBURSE_TYPEHASH = keccak256(
  toHex(
    "ExecuteWithGasReimbursement(Call[] calls,uint256 nonce,uint256 deadline,address gasToken,uint256 gasTokenAmount,address relayer)Call(address to,uint256 value,bytes data)",
  ),
);

/**
 * EIP-712 domain separator with the EOA as `verifyingContract` (uncacheable under
 * 7702). Mirrors `KryardDelegate.domainSeparator()`.
 */
export function domainSeparator(account: Hex, chainId: number | bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, BigInt(chainId), account],
    ),
  );
}

/**
 * EIP-712 array hash of a `Call[]`: keccak256 of the tightly-packed per-element
 * `hashStruct(Call)`. Mirrors `KryardDelegate._hashCalls`. (Empty batch → the
 * keccak256 of the empty byte string, matching Solidity `abi.encodePacked()`.)
 */
export function callsHash(calls: Call[]): Hex {
  const hashes = calls.map((c) =>
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
        [CALL_TYPEHASH, c.to, c.value, keccak256(c.data)],
      ),
    ),
  );
  return keccak256(concat(hashes));
}

/** EIP-712 `toTypedDataHash`: keccak256(0x1901 ‖ domainSeparator ‖ structHash). */
function toTypedDataHash(separator: Hex, structHash: Hex): Hex {
  return keccak256(concat(["0x1901", separator, structHash]));
}

export interface DelegateDigestInput {
  /** The delegated EOA (== address(this) on-chain, the EIP-712 verifyingContract). */
  account: Hex;
  chainId: number;
  calls: Call[];
  /** Per-account single-use replay nonce. */
  nonce: bigint;
  /** Unix-seconds expiry; the contract rejects `block.timestamp > deadline`. */
  deadline: bigint;
  /** ERC-20 gas-reimbursement terms (omit for plain execute). */
  gasToken?: Hex;
  gasTokenAmount?: bigint;
  relayer?: Hex;
}

/**
 * The raw 32-byte EIP-712 digest the EOA must sign (with plain ECDSA, NOT
 * personal_sign) to authorize the batch. When the gas-reimbursement terms are
 * present, the `ExecuteWithGasReimbursement` typed struct is used; otherwise the
 * plain `Execute` struct.
 */
export function delegateDigest(input: DelegateDigestInput): Hex {
  const separator = domainSeparator(input.account, input.chainId);
  const ch = callsHash(input.calls);
  const useToken =
    input.gasToken !== undefined && input.gasTokenAmount !== undefined && input.relayer !== undefined;
  const structHash = useToken
    ? keccak256(
        encodeAbiParameters(
          [
            { type: "bytes32" }, // EXECUTE_REIMBURSE_TYPEHASH
            { type: "bytes32" }, // callsHash
            { type: "uint256" }, // nonce
            { type: "uint256" }, // deadline
            { type: "address" }, // gasToken
            { type: "uint256" }, // gasTokenAmount
            { type: "address" }, // relayer
          ],
          [
            EXECUTE_REIMBURSE_TYPEHASH,
            ch,
            input.nonce,
            input.deadline,
            input.gasToken ?? ZERO,
            input.gasTokenAmount ?? 0n,
            input.relayer ?? ZERO,
          ],
        ),
      )
    : keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
          [EXECUTE_TYPEHASH, ch, input.nonce, input.deadline],
        ),
      );
  return toTypedDataHash(separator, structHash);
}

/** Encode `execute(calls, nonce, deadline, signature)` calldata. */
export function encodeExecute(calls: Call[], nonce: bigint, deadline: bigint, signature: Hex): Hex {
  return encodeFunctionData({
    abi: KRYARD_DELEGATE_ABI,
    functionName: "execute",
    args: [calls, nonce, deadline, signature],
  });
}

/** Encode `executeWithGasReimbursement(...)` calldata (ERC-20 gas payment). */
export function encodeExecuteWithGasReimbursement(
  calls: Call[],
  nonce: bigint,
  deadline: bigint,
  signature: Hex,
  gasToken: Hex,
  gasTokenAmount: bigint,
  relayer: Hex,
): Hex {
  return encodeFunctionData({
    abi: KRYARD_DELEGATE_ABI,
    functionName: "executeWithGasReimbursement",
    args: [calls, nonce, deadline, signature, gasToken, gasTokenAmount, relayer],
  });
}
