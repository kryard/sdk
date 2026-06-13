/**
 * sponsor.ts — assemble + submit a sponsored 7702 execution through Kryard.
 *
 * `buildSponsoredExecute` is pure assembly (encode calldata + the relay body) from
 * already-signed pieces. `sponsorExecute` runs the full flow against an injected
 * `UserSigner` (adapt a viem account/walletClient — see the README) + a relay client.
 */
import type { Hex } from "viem";
import { delegateDigest, encodeExecute, encodeExecuteWithGasReimbursement, type Call } from "./digest.js";
import type { KryardRelayClient, RelayAuthorization, RelaySubmitInput, RelayTx } from "./client.js";

export interface SponsoredExecuteParams {
  /** The user's EOA (delegates to KryardDelegate; the relay `to`). */
  account: Hex;
  chainId: number;
  /** The Kryard relayer key id/address that signs + fronts native gas. */
  signWith: string;
  /** The deployed KryardDelegate (the EOA's delegation target). */
  delegateAddress: Hex;
  calls: Call[];
  /** Per-account delegate replay nonce (single-use). */
  nonce: bigint;
  /** The user's personal_sign over `delegateDigest(...)`. */
  signature: Hex;
  /** The user's signed EIP-7702 authorization (wire shape). */
  authorization: RelayAuthorization;
  /** ERC-20 gas payment (all three required together). */
  gasToken?: Hex;
  gasTokenAmount?: bigint;
  relayer?: Hex;
  idempotencyKey?: string;
  speed?: "slow" | "average" | "fast";
}

// ---------------------------------------------------------------------------
// Generic (delegate-agnostic) path — for ANY 7702 delegate, incl. custom ones
// like sweepster's SweepDelegate. The caller pre-builds `data` (the call the
// relayer sends to the delegated EOA, including any inner delegate signature) and
// the signed 7702 `authorization`; the SDK just assembles + submits.
// ---------------------------------------------------------------------------

export interface SponsoredCallParams {
  /** The user's EOA (delegated; the relay `to`). */
  account: Hex;
  chainId: number;
  /** The Kryard relayer key id/address that signs + fronts native gas. */
  signWith: string;
  /** Pre-built calldata the relayer sends to the EOA (delegate-specific; caller-built). */
  data: Hex;
  /** The user's signed EIP-7702 authorization (wire shape). */
  authorization: RelayAuthorization;
  /**
   * OPTIONAL ERC-20 paymaster accounting: the token + amount the call reimburses
   * the relayer on-chain (recorded by Kryard for token_usage). The on-chain
   * transfer is whatever the caller's `data` does — this is the accounting hint.
   */
  gasToken?: Hex;
  gasTokenAmount?: bigint;
  idempotencyKey?: string;
  speed?: "slow" | "average" | "fast";
}

/** Pure: assemble a relay submit input from pre-built calldata + a signed authorization. */
export function buildSponsoredCall(p: SponsoredCallParams): RelaySubmitInput {
  const useToken = p.gasToken !== undefined && p.gasTokenAmount !== undefined;
  return {
    signWith: p.signWith,
    chainId: String(p.chainId),
    to: p.account, // 7702: the relayer calls the user's OWN delegated EOA
    data: p.data,
    value: "0",
    speed: p.speed,
    idempotencyKey: p.idempotencyKey,
    authorizationList: [p.authorization],
    ...(useToken ? { gasToken: p.gasToken, gasTokenAmount: String(p.gasTokenAmount) } : {}),
  };
}

export interface SponsorCallOptions {
  client: KryardRelayClient;
  signer: Pick<UserSigner, "address" | "signAuthorization">;
  chainId: number;
  signWith: string;
  /** The 7702 delegation target the user authorizes (e.g. a SweepDelegate). */
  delegateAddress: Hex;
  /** Pre-built calldata (delegate-specific; the caller builds + inner-signs it). */
  data: Hex;
  gasToken?: Hex;
  gasTokenAmount?: bigint;
  idempotencyKey?: string;
  speed?: "slow" | "average" | "fast";
}

/**
 * Generic high-level flow: the user signs the 7702 authorization to `delegateAddress`,
 * then Kryard relays the caller-built `data`. Works with ANY delegate — the SDK does
 * not assume KryardDelegate. (For the general KryardDelegate batch UX, use
 * `sponsorExecute`, which builds `data` for you.)
 */
export async function sponsorCall(o: SponsorCallOptions): Promise<RelayTx> {
  const authorization = await o.signer.signAuthorization({ contractAddress: o.delegateAddress, chainId: o.chainId });
  return o.client.submit(
    buildSponsoredCall({
      account: o.signer.address,
      chainId: o.chainId,
      signWith: o.signWith,
      data: o.data,
      authorization,
      gasToken: o.gasToken,
      gasTokenAmount: o.gasTokenAmount,
      idempotencyKey: o.idempotencyKey,
      speed: o.speed,
    }),
  );
}

// ---------------------------------------------------------------------------
// KryardDelegate convenience — builds the execute calldata for you, on top of
// the generic path above.
// ---------------------------------------------------------------------------

/** Pure: assemble the relay submit input from the KryardDelegate-signed pieces. */
export function buildSponsoredExecute(p: SponsoredExecuteParams): RelaySubmitInput {
  const useToken = p.gasToken !== undefined && p.gasTokenAmount !== undefined && p.relayer !== undefined;
  const data = useToken
    ? encodeExecuteWithGasReimbursement(p.calls, p.nonce, p.signature, p.gasToken!, p.gasTokenAmount!, p.relayer!)
    : encodeExecute(p.calls, p.nonce, p.signature);
  return buildSponsoredCall({
    account: p.account,
    chainId: p.chainId,
    signWith: p.signWith,
    data,
    authorization: p.authorization,
    gasToken: p.gasToken,
    gasTokenAmount: p.gasTokenAmount,
    idempotencyKey: p.idempotencyKey,
    speed: p.speed,
  });
}

export interface UserSigner {
  address: Hex;
  /** personal_sign of a raw 32-byte digest — viem: account.signMessage({ message: { raw: digest } }). */
  signDigest(digest: Hex): Promise<Hex>;
  /** Sign an EIP-7702 authorization — viem: walletClient.signAuthorization(...); return the wire shape. */
  signAuthorization(args: { contractAddress: Hex; chainId: number }): Promise<RelayAuthorization>;
}

export interface SponsorExecuteOptions {
  client: KryardRelayClient;
  signer: UserSigner;
  chainId: number;
  signWith: string;
  delegateAddress: Hex;
  calls: Call[];
  nonce: bigint;
  gasToken?: Hex;
  gasTokenAmount?: bigint;
  relayer?: Hex;
  idempotencyKey?: string;
  speed?: "slow" | "average" | "fast";
}

/**
 * Full KryardDelegate flow: user signs the batch digest (→ execute calldata) AND
 * the 7702 authorization, then submit. Built on the generic `sponsorCall`.
 */
export async function sponsorExecute(o: SponsorExecuteOptions): Promise<RelayTx> {
  const digest = delegateDigest({
    account: o.signer.address,
    chainId: o.chainId,
    calls: o.calls,
    nonce: o.nonce,
    gasToken: o.gasToken,
    gasTokenAmount: o.gasTokenAmount,
    relayer: o.relayer,
  });
  const signature = await o.signer.signDigest(digest);
  const useToken = o.gasToken !== undefined && o.gasTokenAmount !== undefined && o.relayer !== undefined;
  const data = useToken
    ? encodeExecuteWithGasReimbursement(o.calls, o.nonce, signature, o.gasToken!, o.gasTokenAmount!, o.relayer!)
    : encodeExecute(o.calls, o.nonce, signature);
  return sponsorCall({
    client: o.client,
    signer: o.signer,
    chainId: o.chainId,
    signWith: o.signWith,
    delegateAddress: o.delegateAddress,
    data,
    gasToken: o.gasToken,
    gasTokenAmount: o.gasTokenAmount,
    idempotencyKey: o.idempotencyKey,
    speed: o.speed,
  });
}
