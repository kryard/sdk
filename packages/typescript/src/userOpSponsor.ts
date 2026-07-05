/**
 * userOpSponsor.ts — client for Kryard's ERC-4337 UserOperation gas sponsorship
 * (the verifying-paymaster tier). Distinct from `sponsor.ts`, which is the
 * EIP-7702 relay path: 4337 sponsorship does NOT submit a transaction — a bundler
 * does that — Kryard only vouches for gas by signing the UserOp for its paymaster.
 *
 * Flow: hand the client an (unsigned-by-paymaster) v0.7 UserOperation; it checks the
 * sponsorship policy server-side and, on approval, returns the `paymasterAndData` you
 * splice onto the UserOp before the bundler sends it. On a policy denial the API
 * answers 403 with a reason code, surfaced here as a typed `SponsorshipDeniedError`.
 *
 * Auth is X-Stamp, exactly like `KryardRelayClient` (this endpoint lives under
 * `/public/v1/relay/*`): each request body is signed with the relayer org's API key
 * via an injected `Stamper`, then POSTed with the shared `stampAndPost` primitive.
 * Both stamper and fetch are injected for testability.
 */
import { concat, pad, toHex, encodeAbiParameters, type Hex } from "viem";
import type { Stamper, FetchFn } from "./client.js";
import { stampAndPost } from "./http.js";

/** The sponsorship-policy denial reason codes the API may return. Mirrors the
 *  server's `SponsorshipReasonCode` minus the ALLOW outcome. */
export type SponsorshipReasonCode =
  | "SPONSOR_DISABLED"
  | "SPONSOR_CONTRACT_NOT_ALLOWED"
  | "SPONSOR_SELECTOR_NOT_ALLOWED"
  | "SPONSOR_OP_LIMIT"
  | "SPONSOR_DAILY_CAP"
  | "SPONSOR_MONTHLY_CAP"
  | "SPONSOR_UNDECODABLE_CALLDATA";

/**
 * A v0.7 UserOperation, in the shape the sponsor endpoint needs to reproduce the
 * paymaster's `getHash`. `accountGasLimits` and `gasFees` are the packed bytes32
 * (high 128 | low 128) and are passed through as-is; numeric fields are `bigint`.
 */
export interface UserOperationV07 {
  sender: Hex;
  nonce: bigint;
  /** "0x" when the account is already deployed. */
  initCode?: Hex;
  callData: Hex;
  /** bytes32: verificationGasLimit (high 128) | callGasLimit (low 128). */
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  /** bytes32: maxPriorityFeePerGas (high 128) | maxFeePerGas (low 128). */
  gasFees: Hex;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
}

export interface SponsorUserOpOptions {
  /** Target chain id (decimal). Selects the paymaster server-side. */
  chainId: number | string;
  /** Optional sponsorship-signature validity window (unix seconds). */
  validUntilSec?: number;
  validAfterSec?: number;
}

/** The approved sponsorship: the `paymasterAndData` to put on the UserOp, plus the
 *  signed `userOpHash` and the validity window the signature covers. */
export interface SponsorshipResult {
  paymasterAndData: Hex;
  userOpHash: Hex;
  validUntil: number;
  validAfter: number;
}

/** Thrown when the API denies sponsorship (HTTP 403), carrying the policy reason. */
export class SponsorshipDeniedError extends Error {
  readonly reasonCode: SponsorshipReasonCode | string;
  readonly status: number;
  constructor(reasonCode: SponsorshipReasonCode | string, status: number, message?: string) {
    super(message ?? `sponsorship denied: ${reasonCode}`);
    this.name = "SponsorshipDeniedError";
    this.reasonCode = reasonCode;
    this.status = status;
  }
}

export interface KryardPaymasterClientOpts {
  baseUrl: string;
  organizationId: string;
  stamper: Stamper;
  fetchFn?: FetchFn;
  nowMs?: () => number;
}

// The message the API's 403 body carries, e.g. "sponsorship denied: SPONSOR_DAILY_CAP".
const DENIED_RE = /sponsorship denied:\s*([A-Z_]+)/;

/** Serialize a v0.7 UserOp to the JSON wire shape (bigints → decimal strings). */
function toWireUserOp(u: UserOperationV07): Record<string, string> {
  return {
    sender: u.sender,
    nonce: u.nonce.toString(),
    initCode: u.initCode ?? "0x",
    callData: u.callData,
    accountGasLimits: u.accountGasLimits,
    preVerificationGas: u.preVerificationGas.toString(),
    gasFees: u.gasFees,
    paymasterVerificationGasLimit: u.paymasterVerificationGasLimit.toString(),
    paymasterPostOpGasLimit: u.paymasterPostOpGasLimit.toString(),
  };
}

export class KryardPaymasterClient {
  private readonly baseUrl: string;
  private readonly organizationId: string;
  private readonly stamper: Stamper;
  private readonly fetchFn: FetchFn;
  private readonly nowMs: () => number;

  constructor(opts: KryardPaymasterClientOpts) {
    if (!opts.baseUrl) throw new Error("KryardPaymasterClient: baseUrl is required");
    if (!opts.organizationId) throw new Error("KryardPaymasterClient: organizationId is required");
    if (!opts.stamper) throw new Error("KryardPaymasterClient: stamper is required");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.organizationId = opts.organizationId;
    this.stamper = opts.stamper;
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch.bind(globalThis) as FetchFn);
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  /**
   * Request gas sponsorship for a v0.7 UserOperation. Resolves with the
   * `paymasterAndData` (and validity window) to splice onto the op; rejects with a
   * `SponsorshipDeniedError` (carrying the reason code) on a 403 policy denial, or a
   * plain `Error` on other transport/validation failures.
   */
  async sponsorUserOperation(userOp: UserOperationV07, opts: SponsorUserOpOptions): Promise<SponsorshipResult> {
    const body: Record<string, unknown> = {
      organizationId: this.organizationId,
      timestampMs: String(this.nowMs()),
      chainId: String(opts.chainId),
      userOp: toWireUserOp(userOp),
    };
    if (opts.validUntilSec !== undefined) body.validUntilSec = opts.validUntilSec;
    if (opts.validAfterSec !== undefined) body.validAfterSec = opts.validAfterSec;

    const payload = JSON.stringify(body);
    const res = await stampAndPost(
      this.fetchFn,
      this.stamper,
      `${this.baseUrl}/public/v1/relay/sponsor_user_op`,
      payload,
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const message = extractMessage(text) ?? text;
      const reason = message.match(DENIED_RE)?.[1];
      if (res.status === 403 && reason) throw new SponsorshipDeniedError(reason, res.status, message);
      throw new Error(`relay sponsor_user_op failed with ${res.status}: ${message || "(unreadable)"}`);
    }

    const json = (await res.json()) as Partial<SponsorshipResult>;
    if (!json?.paymasterAndData) throw new Error("relay sponsor_user_op: response missing paymasterAndData");
    return {
      paymasterAndData: json.paymasterAndData,
      userOpHash: json.userOpHash as Hex,
      validUntil: Number(json.validUntil),
      validAfter: Number(json.validAfter),
    };
  }
}

/** Pull the `message` field out of a Turnkey error envelope; fall back to null. */
function extractMessage(text: string): string | null {
  try {
    const j = JSON.parse(text) as { message?: unknown };
    return typeof j.message === "string" ? j.message : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure v0.7 paymasterAndData helpers — byte-parity with the on-chain
// KryardVerifyingPaymaster / the API's `buildPaymasterAndData`. Layout:
//   [0:20]   paymaster
//   [20:36]  paymasterVerificationGasLimit (uint128, big-endian)
//   [36:52]  paymasterPostOpGasLimit       (uint128, big-endian)
//   [52:116] abi.encode(uint48 validUntil, uint48 validAfter)
//   [116:]   signature (65 bytes)
// ---------------------------------------------------------------------------

/** Assemble the v0.7 `paymasterAndData` field from its components. */
export function buildPaymasterAndData(
  paymaster: Hex,
  verificationGas: bigint,
  postOpGas: bigint,
  validUntil: number,
  validAfter: number,
  signature: Hex,
): Hex {
  return concat([
    paymaster,
    pad(toHex(verificationGas), { size: 16 }),
    pad(toHex(postOpGas), { size: 16 }),
    encodeAbiParameters([{ type: "uint48" }, { type: "uint48" }], [validUntil, validAfter]),
    signature,
  ]);
}

/** The parsed components of a v0.7 `paymasterAndData` field. */
export interface PaymasterAndDataParts {
  paymaster: Hex;
  verificationGas: bigint;
  postOpGas: bigint;
  validUntil: number;
  validAfter: number;
  signature: Hex;
}

/** Split a v0.7 `paymasterAndData` field back into its components (inverse of
 *  `buildPaymasterAndData`). Throws if the field is too short to be well-formed. */
export function splitPaymasterAndData(pad_: Hex): PaymasterAndDataParts {
  const hex = pad_.startsWith("0x") ? pad_.slice(2) : pad_;
  if (hex.length < 116 * 2) throw new Error("splitPaymasterAndData: paymasterAndData too short");
  const at = (start: number, end?: number) => `0x${hex.slice(start * 2, end === undefined ? undefined : end * 2)}` as Hex;
  return {
    paymaster: at(0, 20),
    verificationGas: BigInt(at(20, 36)),
    postOpGas: BigInt(at(36, 52)),
    validUntil: Number(BigInt(at(52, 84))),
    validAfter: Number(BigInt(at(84, 116))),
    signature: at(116),
  };
}

/** Immutably attach a sponsorship result's `paymasterAndData` to a UserOp. */
export function applyPaymasterAndData<T extends object>(userOp: T, paymasterAndData: Hex): T & { paymasterAndData: Hex } {
  return { ...userOp, paymasterAndData };
}
