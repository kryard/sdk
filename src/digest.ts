/**
 * digest.ts — the off-chain mirror of KryardDelegate's auth digest + calldata.
 *
 * The user signs `delegateDigest(...)` (via personal_sign / signMessage({raw})),
 * which the contract verifies as `recover(toEthSignedMessageHash(digest)) == EOA`.
 * MUST match KryardDelegate._digest byte-for-byte:
 *   keccak256(abi.encode(chainId, account, keccak256(abi.encode(calls)), nonce,
 *                        gasToken, gasTokenAmount, relayer))
 */
import { encodeAbiParameters, encodeFunctionData, keccak256, type Hex } from "viem";
import { KRYARD_DELEGATE_ABI } from "./abi.js";

export interface Call {
  to: Hex;
  value: bigint;
  data: Hex;
}

const ZERO = "0x0000000000000000000000000000000000000000" as const;

const CALLS_TUPLE = [
  {
    type: "tuple[]",
    components: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
  },
] as const;

/** keccak256(abi.encode(calls)) — the batch hash the digest commits to. */
export function callsHash(calls: Call[]): Hex {
  return keccak256(encodeAbiParameters(CALLS_TUPLE, [calls]));
}

export interface DelegateDigestInput {
  /** The delegated EOA (== address(this) on-chain). */
  account: Hex;
  chainId: number;
  calls: Call[];
  /** Per-account single-use replay nonce. */
  nonce: bigint;
  /** ERC-20 gas-reimbursement terms (omit for plain execute). */
  gasToken?: Hex;
  gasTokenAmount?: bigint;
  relayer?: Hex;
}

/** The 32-byte digest the EOA must personal-sign to authorize the batch. */
export function delegateDigest(input: DelegateDigestInput): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" }, // chainId
        { type: "address" }, // account (address(this))
        { type: "bytes32" }, // keccak256(abi.encode(calls))
        { type: "uint256" }, // nonce
        { type: "address" }, // gasToken
        { type: "uint256" }, // gasTokenAmount
        { type: "address" }, // relayer
      ],
      [
        BigInt(input.chainId),
        input.account,
        callsHash(input.calls),
        input.nonce,
        input.gasToken ?? ZERO,
        input.gasTokenAmount ?? 0n,
        input.relayer ?? ZERO,
      ],
    ),
  );
}

/** Encode `execute(calls, nonce, signature)` calldata. */
export function encodeExecute(calls: Call[], nonce: bigint, signature: Hex): Hex {
  return encodeFunctionData({ abi: KRYARD_DELEGATE_ABI, functionName: "execute", args: [calls, nonce, signature] });
}

/** Encode `executeWithGasReimbursement(...)` calldata (ERC-20 gas payment). */
export function encodeExecuteWithGasReimbursement(
  calls: Call[],
  nonce: bigint,
  signature: Hex,
  gasToken: Hex,
  gasTokenAmount: bigint,
  relayer: Hex,
): Hex {
  return encodeFunctionData({
    abi: KRYARD_DELEGATE_ABI,
    functionName: "executeWithGasReimbursement",
    args: [calls, nonce, signature, gasToken, gasTokenAmount, relayer],
  });
}
