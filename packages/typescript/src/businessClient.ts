/**
 * businessClient.ts — Session-JWT client for Kryard's Business Wallet control
 * plane (`/dashboard/v1/business/*`, `/dashboard/v1/tokens*`,
 * `/dashboard/v1/policies/token-rule*`, `/dashboard/v1/actor-spend-limits*`,
 * `/dashboard/v1/actor-token-spend-limits*`, and `/dashboard/v1/webhooks*`).
 *
 * Distinct from `KryardRelayClient` (X-Stamp machine API keys on `/public/v1/*`)
 * and `KryardProjectClient` (`x-kryard-project` browser client on `/client/v1/*`):
 * Business Wallet management is human-role (`owner` / `admin` / `member`) and
 * per-request `scope` (`read_write` / `read_only`) gated via a user session JWT.
 *
 * `fetchFn` is injected for testability (same shape as `client.ts`).
 */
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import type { FetchFn, RelayTx } from "./client.js";

/** Org membership role ladder. Invitations can grant `member` or `admin` only. */
export type OrgRole = "owner" | "admin" | "member";

/** Per-request write gate stored on the membership row (never cached in the JWT). */
export type MemberScope = "read_write" | "read_only";

/** Static session JWT or async provider returning the current Bearer token. */
export type TokenSource = string | (() => string | Promise<string>);

export interface KryardBusinessClientOpts {
  /** Kryard API base URL, e.g. `https://api.kryard.com`. */
  baseUrl: string;
  /** Session JWT string or async token getter. */
  token: TokenSource;
  /** Active parent organization UUID (`X-Organization-Id`). Optional for single-org users or `claimInvitation`. */
  organizationId?: string;
  /** Injected fetch (defaults to global fetch). */
  fetchFn?: FetchFn;
}

export interface BusinessRequestOpts {
  /** Override the default `X-Organization-Id` for a single call. */
  organizationId?: string;
}

export interface PaymentWalletSummary {
  privateKeyId: string;
  address: string;
  name: string;
}

export interface SubOrgWallet {
  id: string;
  name: string;
  parentOrganizationId: string | null;
  status: string;
  plan: string;
  memberCount: number;
  /** Primary KMS-custodied secp256k1 EVM payment wallet, if provisioned. */
  paymentWallet: PaymentWalletSummary | null;
  createdAt: string;
}

export interface BusinessWalletNode extends SubOrgWallet {
  /** 0 = the business root, 1 = a direct child, 2 = a grandchild, … */
  depth: number;
}

export interface BusinessOverview {
  organization: {
    id: string;
    name: string;
    plan: string;
    status: string;
    role: string;
  };
  /** Whole transitive subtree, depth-first, root first (`depth === 0`). */
  wallets: BusinessWalletNode[];
  /** Descendant wallets only (`depth > 0`). */
  childWallets: BusinessWalletNode[];
  walletCount: number;
  canManage: boolean;
}

export interface BusinessSubOrgsResponse {
  wallets: BusinessWalletNode[];
  childWallets: BusinessWalletNode[];
}

export interface CreateSubOrgInput {
  name: string;
  /** Owner-only: bootstrap a child wallet with an immediate owner. */
  ownerUserId?: string;
  /** Mint and pin a primary KMS EVM payment wallet for the new child wallet. */
  provisionPaymentWallet?: boolean;
  /** Optional KMS wallet display name when `provisionPaymentWallet` is true. */
  walletName?: string;
}

export interface ProvisionPaymentWalletInput {
  walletName?: string;
  privateKeyId?: string;
  adoptExisting?: boolean;
}

export interface ProvisionPaymentWalletResult {
  organizationId: string;
  paymentWallet: PaymentWalletSummary;
  created: boolean;
  adopted: boolean;
}

export interface SupportedToken {
  id: string;
  scope: "global" | "org";
  organizationId: string | null;
  chainId: string;
  tokenAddress: string;
  symbol: string;
  name: string | null;
  decimals: number;
  status: string;
  createdAt: string;
}

export interface AddTokenInput {
  chainId: string;
  tokenAddress: string;
  symbol?: string;
  name?: string;
  decimals?: number;
}

export interface WalletTokenBalanceItem {
  chainId: string;
  tokenAddress: string;
  symbol: string;
  name: string | null;
  decimals: number;
  balanceRaw: string;
}

export interface BusinessWalletBalanceRow {
  organizationId: string;
  organizationName: string;
  walletAddress: string | null;
  privateKeyId: string | null;
  nativeBalances: Record<string, string>;
  tokens: WalletTokenBalanceItem[];
}

export interface BusinessTokenBalanceTotalItem {
  chainId: string;
  tokenAddress: string;
  symbol: string;
  name: string | null;
  decimals: number;
  totalRaw: string;
}

export interface BusinessTokenBalanceSurface {
  chains: string[];
  chainErrors: Record<string, string>;
  wallets: BusinessWalletBalanceRow[];
  totals: {
    walletCount: number;
    provisionedCount: number;
    nativeByChain: Record<string, string>;
    tokens: BusinessTokenBalanceTotalItem[];
  };
}

export interface ListPaymentsOpts extends BusinessRequestOpts {
  chainId?: string;
  status?: string;
  limit?: number;
}

export interface BusinessTokenPayment {
  id: string;
  organizationId: string;
  organizationName: string;
  privateKeyId: string;
  walletAddress: string;
  chainId: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  txHash: string;
  logIndex: number;
  blockNumber: string;
  sender: string;
  amountRaw: string;
  status: string;
  confirmedAt: string | null;
  createdAt: string;
}

export interface SendBusinessTokenInput {
  chainId: string;
  /** ERC-20 contract address; omit or pass `"native"` to send native gas currency. */
  tokenAddress?: string;
  to: string;
  amountRaw: string;
  delegateAddress?: string;
  relayerSignWith?: string;
  relayerOrgId?: string;
  idempotencyKey?: string;
}

export interface SendBusinessTokenResult {
  activityId: string;
  paymentWalletAddress: string;
  privateKeyId: string;
  relayerOrganizationId: string;
  relayerKeyId: string;
  relayerTransaction: RelayTx;
}

export interface SetTokenPolicyRuleInput {
  organizationId?: string;
  privateKeyId: string;
  chainId: string;
  tokenAddress: string;
  maxTxAmount: string;
  allowApprove?: boolean;
  allowOpenEip3009Recipients?: boolean;
}

export interface TokenPolicyRule {
  id: string;
  privateKeyId: string;
  chainId: string;
  tokenAddress: string;
  maxTxAmount: string;
  allowApprove: boolean;
  allowOpenEip3009Recipients?: boolean;
  createdAt: string;
}

export interface ActorTokenSpendLimitView {
  id: string;
  actorId: string;
  privateKeyId: string;
  chainId: string;
  tokenAddress: string;
  maxTxAmount: string;
  dailyLimitAmount: string;
  spentTodayAmount: string;
  createdAt: string;
  updatedAt?: string;
}

export interface SetActorTokenSpendLimitInput {
  organizationId?: string;
  actorId: string;
  privateKeyId: string;
  chainId: string;
  tokenAddress: string;
  maxTxAmount?: string;
  dailyLimitAmount?: string;
}

export interface WebhookEndpoint {
  id: string;
  organizationId: string;
  url: string;
  description: string | null;
  secretPrefix: string;
  events: string[];
  includeSuborgs: boolean;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventType: string;
  idempotencyKey: string;
  payload: unknown;
  status: string;
  attempts: number;
  nextAttemptAt: string;
  lastHttpStatus: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface ListWebhooksResponse {
  endpoints: WebhookEndpoint[];
  recentDeliveries: WebhookDelivery[];
}

export interface CreateWebhookInput {
  url: string;
  description?: string;
  events?: string[];
  includeSuborgs?: boolean;
}

export interface CreateWebhookResult {
  endpoint: WebhookEndpoint;
  secret: string;
}

export interface BusinessWalletDepositRow {
  organizationId: string;
  organizationName: string;
  depositAddresses: Record<string, string>;
  creditedWei: string;
  pendingWei: string;
  pendingCount: number;
  depositedWei: string;
  availableWei: string;
}

export interface BusinessDepositTotals {
  walletCount: number;
  creditedWei: string;
  pendingWei: string;
  pendingCount: number;
  depositedWei: string;
  availableWei: string;
}

export interface BusinessDepositSurface {
  chains: Record<string, string>;
  wallets: BusinessWalletDepositRow[];
  totals: BusinessDepositTotals;
}

export interface SubOrgDepositSurface {
  chains: Record<string, string>;
  organizationId: string;
  depositAddresses: Record<string, string>;
  creditedWei: string;
  pendingWei: string;
  pendingCount: number;
}

export interface BusinessMember {
  id: string;
  organizationId?: string;
  userId: string;
  actorId: string;
  role: string;
  scope: string;
  status: string;
  createdAt: string;
}

export interface BusinessInvitation {
  id: string;
  organizationId?: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  claimedAt: string | null;
  createdAt: string;
}

export interface InviteMemberInput {
  email: string;
  /** Cannot grant `owner` on invitation; promote after claim instead. */
  role?: "member" | "admin";
  ttlHours?: number;
}

export interface ClaimInvitationResult {
  organizationId: string;
  role: string;
}

export interface ActorSpendLimit {
  id: string;
  actorId: string;
  privateKeyId: string;
  chainId: string;
  maxTxValueWei: string;
  dailyLimitWei: string;
  spentTodayWei: string;
  createdAt: string;
  updatedAt?: string;
}

export interface SetActorSpendLimitInput {
  actorId: string;
  privateKeyId: string;
  chainId: string;
  maxTxValueWei?: string;
  dailyLimitWei?: string;
}

/** HTTP error returned by Kryard control-plane endpoints. */
export class KryardApiError extends Error {
  readonly status: number;
  readonly code: number | undefined;

  constructor(label: string, status: number, message: string, code?: number) {
    super(`${label} failed with ${status}: ${message}`);
    this.name = "KryardApiError";
    this.status = status;
    this.code = code;
  }
}

function reqStr(value: unknown, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new Error(`KryardBusinessClient: ${field} is required`);
  return trimmed;
}

function optStr(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function seg(value: string, field: string): string {
  const trimmed = reqStr(value, field);
  if (!UUID_RE.test(trimmed)) {
    throw new Error(`KryardBusinessClient: ${field} must be a valid UUID`);
  }
  return trimmed;
}

function orgQuery(organizationId?: string): string {
  const org = optStr(organizationId);
  return org ? `?organizationId=${encodeURIComponent(org)}` : "";
}

function buildChainQuery(chainIds?: string[] | string): string {
  if (chainIds === undefined) return "";
  const items = (Array.isArray(chainIds) ? chainIds : chainIds.split(","))
    .map((x) => x.trim())
    .filter(Boolean);
  return items.length > 0 ? `?chainId=${items.map(encodeURIComponent).join(",")}` : "";
}

function buildPaymentsQuery(opts?: ListPaymentsOpts): string {
  if (!opts) return "";
  const params = new URLSearchParams();
  const chainId = optStr(opts.chainId);
  if (chainId) params.set("chainId", chainId);
  const status = optStr(opts.status);
  if (status) params.set("status", status);
  if (opts.limit !== undefined) {
    if (!Number.isInteger(opts.limit) || opts.limit <= 0) {
      throw new Error("KryardBusinessClient: limit must be a positive integer");
    }
    params.set("limit", String(opts.limit));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function buildProvisionWalletBody(input?: ProvisionPaymentWalletInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (!input) return body;
  const walletName = optStr(input.walletName);
  if (walletName) body.walletName = walletName;
  if (input.privateKeyId !== undefined) {
    const pkId = optStr(input.privateKeyId);
    if (!pkId) throw new Error("KryardBusinessClient: privateKeyId cannot be empty");
    body.privateKeyId = pkId;
  }
  if (input.adoptExisting !== undefined) body.adoptExisting = input.adoptExisting;
  return body;
}

function buildSendTokenBody(input: SendBusinessTokenInput): Record<string, unknown> {
  const chainId = reqStr(input?.chainId, "chainId");
  const to = reqStr(input?.to, "to");
  const amountRaw = reqStr(input?.amountRaw, "amountRaw");
  const body: Record<string, unknown> = { chainId, to, amountRaw };
  const tokenAddress = optStr(input.tokenAddress);
  if (tokenAddress) body.tokenAddress = tokenAddress;
  const delegateAddress = optStr(input.delegateAddress);
  if (delegateAddress) body.delegateAddress = delegateAddress;
  const relayerSignWith = optStr(input.relayerSignWith);
  if (relayerSignWith) body.relayerSignWith = relayerSignWith;
  const relayerOrgId = optStr(input.relayerOrgId);
  if (relayerOrgId) body.relayerOrgId = relayerOrgId;
  const idempotencyKey = optStr(input.idempotencyKey);
  if (idempotencyKey) body.idempotencyKey = idempotencyKey;
  return body;
}

function mergeRequestOpts(
  opts?: BusinessRequestOpts,
  reqOpts?: BusinessRequestOpts,
): BusinessRequestOpts | undefined {
  const orgId = reqOpts?.organizationId ?? opts?.organizationId;
  return orgId !== undefined ? { organizationId: orgId } : undefined;
}

function hexToBytes32(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/**
 * Verify an incoming Kryard webhook `X-Kryard-Signature` header
 * (`t=<unixSec>,v1=<hex_hmac_sha256(secret, "${unixSec}.${rawBody}")>`)
 * using constant-time byte comparison and optional replay-window tolerance.
 */
export async function verifyWebhookSignature(
  secret: string,
  signatureHeader: string,
  rawBody: string,
  toleranceSec = 300,
): Promise<boolean> {
  if (
    typeof secret !== "string" ||
    !secret ||
    typeof signatureHeader !== "string" ||
    !signatureHeader ||
    typeof rawBody !== "string" ||
    !Number.isFinite(toleranceSec) ||
    toleranceSec < 0
  ) {
    return false;
  }

  const parts = signatureHeader.split(",").map((p) => p.trim());
  const tPart = parts.find((p) => p.startsWith("t="));
  const vParts = parts.filter((p) => p.startsWith("v1="));
  if (!tPart || vParts.length === 0) return false;

  const rawTs = tPart.slice(2).trim();
  if (!/^\d+$/.test(rawTs)) return false;
  const ts = Number(rawTs);
  if (!Number.isSafeInteger(ts)) return false;

  if (toleranceSec > 0 && Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSec) {
    return false;
  }

  const enc = new TextEncoder();
  const expected = hmac(sha256, enc.encode(secret), enc.encode(`${ts}.${rawBody}`));

  let matched = false;
  for (const vp of vParts) {
    const candidate = hexToBytes32(vp.slice(3).trim());
    if (candidate && constantTimeEqualBytes(candidate, expected)) {
      matched = true;
    }
  }
  return matched;
}

export class KryardBusinessClient {
  private readonly baseUrl: string;
  private readonly token: TokenSource;
  private readonly organizationId: string | undefined;
  private readonly fetchFn: FetchFn;

  constructor(opts: KryardBusinessClientOpts) {
    if (!opts.baseUrl || !opts.baseUrl.trim()) {
      throw new Error("KryardBusinessClient: baseUrl is required");
    }
    if (typeof opts.token === "string") {
      if (!opts.token.trim()) throw new Error("KryardBusinessClient: token is required");
    } else if (typeof opts.token !== "function") {
      throw new Error("KryardBusinessClient: token must be a string or function");
    }
    this.baseUrl = opts.baseUrl.trim().replace(/\/+$/, "");
    this.token = opts.token;
    const orgId = opts.organizationId?.trim();
    this.organizationId = orgId ? orgId : undefined;
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch.bind(globalThis) as FetchFn);
  }

  /** Return a client pinned to a specific parent or child organization ID. */
  withOrganization(organizationId: string): KryardBusinessClient {
    const trimmed = typeof organizationId === "string" ? organizationId.trim() : "";
    if (!trimmed) throw new Error("KryardBusinessClient: organizationId is required");
    return new KryardBusinessClient({
      baseUrl: this.baseUrl,
      token: this.token,
      organizationId: trimmed,
      fetchFn: this.fetchFn,
    });
  }

  /** Business root metadata + whole descendant subtree (`GET /dashboard/v1/business`). */
  async getOverview(opts?: BusinessRequestOpts): Promise<BusinessOverview> {
    return this.request<BusinessOverview>("GET", "/dashboard/v1/business", "business overview", opts);
  }

  /** Transitive subtree wallet listing (`GET /dashboard/v1/business/suborgs`). */
  async listSubOrgs(opts?: BusinessRequestOpts): Promise<BusinessSubOrgsResponse> {
    return this.request<BusinessSubOrgsResponse>("GET", "/dashboard/v1/business/suborgs", "list suborgs", opts);
  }

  /** Create a child wallet under the active business (`POST /dashboard/v1/business/suborgs`). */
  async createSubOrg(input: CreateSubOrgInput, opts?: BusinessRequestOpts): Promise<BusinessWalletNode> {
    const name = reqStr(input?.name, "name");
    const ownerUserId = optStr(input.ownerUserId);
    const walletName = optStr(input.walletName);
    const body: Record<string, unknown> = { name };
    if (ownerUserId) body.ownerUserId = ownerUserId;
    if (input.provisionPaymentWallet !== undefined) {
      body.provisionPaymentWallet = input.provisionPaymentWallet;
    }
    if (walletName) body.walletName = walletName;
    const res = await this.request<{
      childWallet: Omit<BusinessWalletNode, "depth" | "paymentWallet"> & {
        depth?: number;
        paymentWallet?: PaymentWalletSummary | null;
      };
    }>("POST", "/dashboard/v1/business/suborgs", "create suborg", {
      ...opts,
      body,
    });
    return {
      ...res.childWallet,
      paymentWallet: res.childWallet.paymentWallet ?? null,
      depth: res.childWallet.depth ?? 1,
    };
  }

  /** Fetch one descendant wallet by ID (`GET /dashboard/v1/business/suborgs/:id`). */
  async getSubOrg(subOrgId: string, opts?: BusinessRequestOpts): Promise<BusinessWalletNode> {
    const id = seg(subOrgId, "subOrgId");
    const res = await this.request<{ childWallet: BusinessWalletNode }>(
      "GET",
      `/dashboard/v1/business/suborgs/${id}`,
      "get suborg",
      opts,
    );
    return {
      ...res.childWallet,
      paymentWallet: res.childWallet.paymentWallet ?? null,
    };
  }

  /** 1-click KMS payment wallet provisioning for the active root org (`POST /dashboard/v1/business/payment-wallet`). */
  async provisionPaymentWallet(
    input?: ProvisionPaymentWalletInput,
    opts?: BusinessRequestOpts,
  ): Promise<ProvisionPaymentWalletResult> {
    return this.request<ProvisionPaymentWalletResult>(
      "POST",
      "/dashboard/v1/business/payment-wallet",
      "provision payment wallet",
      { ...opts, body: buildProvisionWalletBody(input) },
    );
  }

  /** 1-click KMS payment wallet provisioning for a descendant sub-org (`POST /dashboard/v1/business/suborgs/:id/payment-wallet`). */
  async provisionSubOrgPaymentWallet(
    subOrgId: string,
    input?: ProvisionPaymentWalletInput,
    opts?: BusinessRequestOpts,
  ): Promise<ProvisionPaymentWalletResult> {
    const id = seg(subOrgId, "subOrgId");
    return this.request<ProvisionPaymentWalletResult>(
      "POST",
      `/dashboard/v1/business/suborgs/${id}/payment-wallet`,
      "provision suborg payment wallet",
      { ...opts, body: buildProvisionWalletBody(input) },
    );
  }

  /** Rename a descendant wallet (`POST /dashboard/v1/business/suborgs/:id/rename`). */
  async renameSubOrg(
    subOrgId: string,
    name: string,
    opts?: BusinessRequestOpts,
  ): Promise<{ id: string; name: string }> {
    const id = seg(subOrgId, "subOrgId");
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed) throw new Error("KryardBusinessClient: name is required");
    return this.request<{ id: string; name: string }>(
      "POST",
      `/dashboard/v1/business/suborgs/${id}/rename`,
      "rename suborg",
      { ...opts, body: { name: trimmed } },
    );
  }

  /**
   * Whole-business derived CREATE2 deposit addresses, indexer totals, and
   * gas-tank balances (`GET /dashboard/v1/business/deposit-addresses`).
   */
  async getDepositAddresses(opts?: BusinessRequestOpts): Promise<BusinessDepositSurface> {
    return this.request<BusinessDepositSurface>(
      "GET",
      "/dashboard/v1/business/deposit-addresses",
      "business deposit addresses",
      opts,
    );
  }

  /** One descendant wallet's derived deposit addresses (`GET /dashboard/v1/business/suborgs/:id/deposit-addresses`). */
  async getSubOrgDepositAddresses(subOrgId: string, opts?: BusinessRequestOpts): Promise<SubOrgDepositSurface> {
    const id = seg(subOrgId, "subOrgId");
    return this.request<SubOrgDepositSurface>(
      "GET",
      `/dashboard/v1/business/suborgs/${id}/deposit-addresses`,
      "suborg deposit addresses",
      opts,
    );
  }

  /** List a descendant wallet's members and invitations (`GET /dashboard/v1/business/suborgs/:id/members`). */
  async listMembers(
    subOrgId: string,
    opts?: BusinessRequestOpts,
  ): Promise<{ members: BusinessMember[]; invitations: BusinessInvitation[] }> {
    const id = seg(subOrgId, "subOrgId");
    return this.request<{ members: BusinessMember[]; invitations: BusinessInvitation[] }>(
      "GET",
      `/dashboard/v1/business/suborgs/${id}/members`,
      "list suborg members",
      opts,
    );
  }

  /**
   * Create a single-use invitation for a descendant wallet. Returns the claim
   * token once; only its SHA-256 hash is persisted server-side.
   */
  async inviteMember(
    subOrgId: string,
    input: InviteMemberInput,
    opts?: BusinessRequestOpts,
  ): Promise<{ invitation: BusinessInvitation; token: string }> {
    const id = seg(subOrgId, "subOrgId");
    const email = typeof input?.email === "string" ? input.email.trim() : "";
    if (!email) throw new Error("KryardBusinessClient: email is required");
    const body: Record<string, unknown> = { email };
    if (input.role !== undefined) body.role = input.role;
    if (input.ttlHours !== undefined) body.ttlHours = input.ttlHours;
    return this.request<{ invitation: BusinessInvitation; token: string }>(
      "POST",
      `/dashboard/v1/business/suborgs/${id}/invitations`,
      "invite member",
      { ...opts, body },
    );
  }

  /** Revoke a pending invitation (`POST /dashboard/v1/business/suborgs/:id/invitations/:invitationId/revoke`). */
  async revokeInvitation(
    subOrgId: string,
    invitationId: string,
    opts?: BusinessRequestOpts,
  ): Promise<{ ok: true }> {
    const id = seg(subOrgId, "subOrgId");
    const invId = seg(invitationId, "invitationId");
    return this.request<{ ok: true }>(
      "POST",
      `/dashboard/v1/business/suborgs/${id}/invitations/${invId}/revoke`,
      "revoke invitation",
      opts,
    );
  }

  /**
   * Redeem an invitation claim token for the signed-in user. Runs pre-membership
   * without `X-Organization-Id` so zero-membership and multi-org callers can claim.
   */
  async claimInvitation(token: string): Promise<ClaimInvitationResult> {
    const trimmed = typeof token === "string" ? token.trim() : "";
    if (!trimmed) throw new Error("KryardBusinessClient: token is required");
    return this.request<ClaimInvitationResult>(
      "POST",
      "/dashboard/v1/business/invitations/claim",
      "claim invitation",
      { body: { token: trimmed }, withOrg: false },
    );
  }

  /** Update a member's `role` and/or `scope` in one request (`POST /dashboard/v1/business/suborgs/:id/members/:memberId/role`). */
  async updateMemberAccess(
    subOrgId: string,
    memberId: string,
    patch: { role?: OrgRole; scope?: MemberScope },
    opts?: BusinessRequestOpts,
  ): Promise<BusinessMember> {
    const id = seg(subOrgId, "subOrgId");
    const memId = seg(memberId, "memberId");
    if (patch?.role === undefined && patch?.scope === undefined) {
      throw new Error("KryardBusinessClient: role or scope is required");
    }
    const body: Record<string, string> = {};
    if (patch.role !== undefined) body.role = patch.role;
    if (patch.scope !== undefined) body.scope = patch.scope;
    const res = await this.request<{ member: BusinessMember }>(
      "POST",
      `/dashboard/v1/business/suborgs/${id}/members/${memId}/role`,
      "update member access",
      { ...opts, body },
    );
    return res.member;
  }

  /** Convenience wrapper to change only a member's role. */
  async setMemberRole(
    subOrgId: string,
    memberId: string,
    role: OrgRole,
    opts?: BusinessRequestOpts,
  ): Promise<BusinessMember> {
    return this.updateMemberAccess(subOrgId, memberId, { role }, opts);
  }

  /** Convenience wrapper to change only a member's `read_write` / `read_only` scope. */
  async setMemberScope(
    subOrgId: string,
    memberId: string,
    scope: MemberScope,
    opts?: BusinessRequestOpts,
  ): Promise<BusinessMember> {
    return this.updateMemberAccess(subOrgId, memberId, { scope }, opts);
  }

  /** Remove a member from a descendant wallet (`DELETE /dashboard/v1/business/suborgs/:id/members/:memberId`). */
  async removeMember(subOrgId: string, memberId: string, opts?: BusinessRequestOpts): Promise<{ ok: true }> {
    const id = seg(subOrgId, "subOrgId");
    const memId = seg(memberId, "memberId");
    return this.request<{ ok: true }>(
      "DELETE",
      `/dashboard/v1/business/suborgs/${id}/members/${memId}`,
      "remove member",
      opts,
    );
  }

  /** List per-actor spend limits for the active org (`GET /dashboard/v1/actor-spend-limits`). */
  async listActorSpendLimits(opts?: BusinessRequestOpts): Promise<ActorSpendLimit[]> {
    const res = await this.request<{ limits: ActorSpendLimit[] }>(
      "GET",
      "/dashboard/v1/actor-spend-limits",
      "list actor spend limits",
      opts,
    );
    return res.limits;
  }

  /** Set or replace a per-(actor, key, chain) spend cap (`POST /dashboard/v1/actor-spend-limits`). */
  async setActorSpendLimit(input: SetActorSpendLimitInput, opts?: BusinessRequestOpts): Promise<ActorSpendLimit> {
    const actorId = reqStr(input?.actorId, "actorId");
    const privateKeyId = reqStr(input?.privateKeyId, "privateKeyId");
    const chainId = reqStr(input?.chainId, "chainId");
    const body: Record<string, string> = { actorId, privateKeyId, chainId };
    if (input.maxTxValueWei !== undefined) body.maxTxValueWei = input.maxTxValueWei;
    if (input.dailyLimitWei !== undefined) body.dailyLimitWei = input.dailyLimitWei;
    return this.request<ActorSpendLimit>("POST", "/dashboard/v1/actor-spend-limits", "set actor spend limit", {
      ...opts,
      body,
    });
  }

  /** Delete a per-actor spend limit by ID (`DELETE /dashboard/v1/actor-spend-limits/:id`). */
  async deleteActorSpendLimit(limitId: string, opts?: BusinessRequestOpts): Promise<{ ok: true }> {
    const id = seg(limitId, "limitId");
    return this.request<{ ok: true }>(
      "DELETE",
      `/dashboard/v1/actor-spend-limits/${id}`,
      "delete actor spend limit",
      opts,
    );
  }

  /** List supported ERC-20 tokens (global defaults + org custom tokens, `GET /dashboard/v1/tokens`). */
  async listTokens(chainId?: string, opts?: BusinessRequestOpts): Promise<SupportedToken[]> {
    const chain = optStr(chainId);
    const qs = chain ? `?chainId=${encodeURIComponent(chain)}` : "";
    const res = await this.request<{ tokens: SupportedToken[] }>(
      "GET",
      `/dashboard/v1/tokens${qs}`,
      "list tokens",
      opts,
    );
    return res.tokens;
  }

  /** Register a custom ERC-20 token for the active organization (`POST /dashboard/v1/tokens`). */
  async addToken(input: AddTokenInput, opts?: BusinessRequestOpts): Promise<SupportedToken> {
    const chainId = reqStr(input?.chainId, "chainId");
    const tokenAddress = reqStr(input?.tokenAddress, "tokenAddress");
    const body: Record<string, unknown> = { chainId, tokenAddress };
    const symbol = optStr(input.symbol);
    if (symbol) body.symbol = symbol;
    const name = optStr(input.name);
    if (name) body.name = name;
    if (input.decimals !== undefined) {
      if (!Number.isInteger(input.decimals) || input.decimals < 0) {
        throw new Error("KryardBusinessClient: decimals must be a non-negative integer");
      }
      body.decimals = input.decimals;
    }
    const res = await this.request<{ token: SupportedToken }>("POST", "/dashboard/v1/tokens", "add token", {
      ...opts,
      body,
    });
    return res.token;
  }

  /** Remove an org-scoped custom token (`DELETE /dashboard/v1/tokens/:id`). */
  async removeToken(tokenId: string, opts?: BusinessRequestOpts): Promise<{ ok: true }> {
    const id = seg(tokenId, "tokenId");
    return this.request<{ ok: true }>("DELETE", `/dashboard/v1/tokens/${id}`, "remove token", opts);
  }

  /** Live multi-chain native + ERC-20 balances across the business subtree (`GET /dashboard/v1/business/balances`). */
  async getBalances(chainIds?: string[] | string, opts?: BusinessRequestOpts): Promise<BusinessTokenBalanceSurface> {
    const qs = buildChainQuery(chainIds);
    return this.request<BusinessTokenBalanceSurface>(
      "GET",
      `/dashboard/v1/business/balances${qs}`,
      "business balances",
      opts,
    );
  }

  /** Live multi-chain native + ERC-20 balances for a descendant sub-org (`GET /dashboard/v1/business/suborgs/:id/balances`). */
  async getSubOrgBalances(
    subOrgId: string,
    chainIds?: string[] | string,
    opts?: BusinessRequestOpts,
  ): Promise<BusinessTokenBalanceSurface> {
    const id = seg(subOrgId, "subOrgId");
    const qs = buildChainQuery(chainIds);
    return this.request<BusinessTokenBalanceSurface>(
      "GET",
      `/dashboard/v1/business/suborgs/${id}/balances${qs}`,
      "suborg balances",
      opts,
    );
  }

  /** List indexed incoming ERC-20 payments across the business subtree (`GET /dashboard/v1/business/payments`). */
  async listPayments(opts?: ListPaymentsOpts, reqOpts?: BusinessRequestOpts): Promise<BusinessTokenPayment[]> {
    const qs = buildPaymentsQuery(opts);
    const res = await this.request<{ payments: BusinessTokenPayment[] }>(
      "GET",
      `/dashboard/v1/business/payments${qs}`,
      "list payments",
      mergeRequestOpts(opts, reqOpts),
    );
    return res.payments;
  }

  /** List indexed incoming ERC-20 payments for one descendant sub-org (`GET /dashboard/v1/business/suborgs/:id/payments`). */
  async listSubOrgPayments(
    subOrgId: string,
    opts?: ListPaymentsOpts,
    reqOpts?: BusinessRequestOpts,
  ): Promise<BusinessTokenPayment[]> {
    const id = seg(subOrgId, "subOrgId");
    const qs = buildPaymentsQuery(opts);
    const res = await this.request<{ payments: BusinessTokenPayment[] }>(
      "GET",
      `/dashboard/v1/business/suborgs/${id}/payments${qs}`,
      "list suborg payments",
      mergeRequestOpts(opts, reqOpts),
    );
    return res.payments;
  }

  /** Gasless ERC-20 or native send from the root org's KMS payment wallet via EIP-7702 (`POST /dashboard/v1/business/send-token`). */
  async sendToken(input: SendBusinessTokenInput, opts?: BusinessRequestOpts): Promise<SendBusinessTokenResult> {
    return this.request<SendBusinessTokenResult>(
      "POST",
      "/dashboard/v1/business/send-token",
      "send token",
      { ...opts, body: buildSendTokenBody(input) },
    );
  }

  /** Gasless ERC-20 or native send from a descendant sub-org's KMS payment wallet via EIP-7702 (`POST /dashboard/v1/business/suborgs/:id/send-token`). */
  async sendSubOrgToken(
    subOrgId: string,
    input: SendBusinessTokenInput,
    opts?: BusinessRequestOpts,
  ): Promise<SendBusinessTokenResult> {
    const id = seg(subOrgId, "subOrgId");
    return this.request<SendBusinessTokenResult>(
      "POST",
      `/dashboard/v1/business/suborgs/${id}/send-token`,
      "send suborg token",
      { ...opts, body: buildSendTokenBody(input) },
    );
  }

  /** Set or replace a per-(key, chain, token) policy cap (`POST /dashboard/v1/policies/token-rule`). */
  async setTokenPolicyRule(input: SetTokenPolicyRuleInput, opts?: BusinessRequestOpts): Promise<TokenPolicyRule> {
    const privateKeyId = reqStr(input?.privateKeyId, "privateKeyId");
    const chainId = reqStr(input?.chainId, "chainId");
    const tokenAddress = reqStr(input?.tokenAddress, "tokenAddress");
    const maxTxAmount = reqStr(input?.maxTxAmount, "maxTxAmount");
    const body: Record<string, unknown> = { privateKeyId, chainId, tokenAddress, maxTxAmount };
    const orgId = optStr(input.organizationId);
    if (orgId) body.organizationId = orgId;
    if (input.allowApprove !== undefined) body.allowApprove = input.allowApprove;
    if (input.allowOpenEip3009Recipients !== undefined) {
      body.allowOpenEip3009Recipients = input.allowOpenEip3009Recipients;
    }
    const res = await this.request<{ tokenRule: TokenPolicyRule }>(
      "POST",
      "/dashboard/v1/policies/token-rule",
      "set token policy rule",
      { ...opts, body },
    );
    return res.tokenRule;
  }

  /** Delete a per-token policy rule by ID (`DELETE /dashboard/v1/policies/token-rule/:id`). */
  async deleteTokenPolicyRule(
    ruleId: string,
    organizationId?: string,
    opts?: BusinessRequestOpts,
  ): Promise<{ ok: true }> {
    const id = seg(ruleId, "ruleId");
    return this.request<{ ok: true }>(
      "DELETE",
      `/dashboard/v1/policies/token-rule/${id}${orgQuery(organizationId)}`,
      "delete token policy rule",
      opts,
    );
  }

  /** List per-actor ERC-20 token spend limits (`GET /dashboard/v1/actor-token-spend-limits`). */
  async listTokenSpendLimits(
    organizationId?: string,
    opts?: BusinessRequestOpts,
  ): Promise<ActorTokenSpendLimitView[]> {
    const res = await this.request<{ limits: ActorTokenSpendLimitView[] }>(
      "GET",
      `/dashboard/v1/actor-token-spend-limits${orgQuery(organizationId)}`,
      "list actor token spend limits",
      opts,
    );
    return res.limits;
  }

  /** Set or replace a per-(actor, key, chain, token) spend limit (`POST /dashboard/v1/actor-token-spend-limits`). */
  async setTokenSpendLimit(
    input: SetActorTokenSpendLimitInput,
    opts?: BusinessRequestOpts,
  ): Promise<ActorTokenSpendLimitView> {
    const actorId = reqStr(input?.actorId, "actorId");
    const privateKeyId = reqStr(input?.privateKeyId, "privateKeyId");
    const chainId = reqStr(input?.chainId, "chainId");
    const tokenAddress = reqStr(input?.tokenAddress, "tokenAddress");
    const body: Record<string, string> = { actorId, privateKeyId, chainId, tokenAddress };
    const orgId = optStr(input.organizationId);
    if (orgId) body.organizationId = orgId;
    if (input.maxTxAmount !== undefined) body.maxTxAmount = reqStr(input.maxTxAmount, "maxTxAmount");
    if (input.dailyLimitAmount !== undefined) {
      body.dailyLimitAmount = reqStr(input.dailyLimitAmount, "dailyLimitAmount");
    }
    return this.request<ActorTokenSpendLimitView>(
      "POST",
      "/dashboard/v1/actor-token-spend-limits",
      "set actor token spend limit",
      { ...opts, body },
    );
  }

  /** Delete a per-actor ERC-20 token spend limit by ID (`DELETE /dashboard/v1/actor-token-spend-limits/:id`). */
  async deleteTokenSpendLimit(
    limitId: string,
    organizationId?: string,
    opts?: BusinessRequestOpts,
  ): Promise<{ ok: true }> {
    const id = seg(limitId, "limitId");
    return this.request<{ ok: true }>(
      "DELETE",
      `/dashboard/v1/actor-token-spend-limits/${id}${orgQuery(organizationId)}`,
      "delete actor token spend limit",
      opts,
    );
  }

  /** List configured webhook endpoints and recent delivery attempts (`GET /dashboard/v1/webhooks`). */
  async listWebhooks(opts?: BusinessRequestOpts): Promise<ListWebhooksResponse> {
    return this.request<ListWebhooksResponse>("GET", "/dashboard/v1/webhooks", "list webhooks", opts);
  }

  /** Create a webhook endpoint; returns the `whsec_...` signing secret once (`POST /dashboard/v1/webhooks`). */
  async createWebhook(input: CreateWebhookInput, opts?: BusinessRequestOpts): Promise<CreateWebhookResult> {
    const url = reqStr(input?.url, "url");
    const body: Record<string, unknown> = { url };
    const description = optStr(input.description);
    if (description) body.description = description;
    if (input.events !== undefined) {
      if (!Array.isArray(input.events) || input.events.length === 0) {
        throw new Error("KryardBusinessClient: events must be a non-empty array");
      }
      body.events = input.events;
    }
    if (input.includeSuborgs !== undefined) body.includeSuborgs = input.includeSuborgs;
    return this.request<CreateWebhookResult>("POST", "/dashboard/v1/webhooks", "create webhook", {
      ...opts,
      body,
    });
  }

  /** Rotate a webhook endpoint's signing secret (`POST /dashboard/v1/webhooks/:id/rotate`). */
  async rotateWebhookSecret(webhookId: string, opts?: BusinessRequestOpts): Promise<CreateWebhookResult> {
    const id = seg(webhookId, "webhookId");
    return this.request<CreateWebhookResult>(
      "POST",
      `/dashboard/v1/webhooks/${id}/rotate`,
      "rotate webhook secret",
      opts,
    );
  }

  /** Delete a webhook endpoint (`DELETE /dashboard/v1/webhooks/:id`). */
  async deleteWebhook(webhookId: string, opts?: BusinessRequestOpts): Promise<{ ok: true }> {
    const id = seg(webhookId, "webhookId");
    return this.request<{ ok: true }>("DELETE", `/dashboard/v1/webhooks/${id}`, "delete webhook", opts);
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    label: string,
    opts?: { body?: unknown; withOrg?: boolean; organizationId?: string },
  ): Promise<T> {
    const rawToken = typeof this.token === "function" ? await this.token() : this.token;
    const bearer = typeof rawToken === "string" ? rawToken.trim() : "";
    if (!bearer) throw new Error("KryardBusinessClient: token resolved to empty string");

    const headers: Record<string, string> = {
      authorization: `Bearer ${bearer}`,
    };
    if (opts?.withOrg !== false) {
      const orgId = (opts?.organizationId ?? this.organizationId)?.trim();
      if (orgId) headers["x-organization-id"] = orgId;
    }

    const init: RequestInit = { method, headers };
    if (opts?.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    const res = await this.fetchFn(`${this.baseUrl}${path}`, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "(unreadable)");
      let message = text;
      let code: number | undefined;
      try {
        const parsed = JSON.parse(text) as { message?: unknown; code?: unknown };
        if (typeof parsed.message === "string" && parsed.message) message = parsed.message;
        if (typeof parsed.code === "number") code = parsed.code;
      } catch {
        // Non-JSON error body; keep raw text.
      }
      throw new KryardApiError(label, res.status, message, code);
    }
    return (await res.json()) as T;
  }
}
