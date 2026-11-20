/**
 * x402.ts — Buyer, seller, and facilitator primitives for the x402 protocol
 * (`exact` / EIP-3009 over EVM) across both v1 (`X-PAYMENT` / `X-PAYMENT-RESPONSE`)
 * and v2 (`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`).
 *
 * Portable across Node 18+, browsers, and Cloudflare Workers (WebCrypto +
 * `TextEncoder`/`TextDecoder` + `btoa`/`atob`, zero Node-only APIs).
 */
import type { Hex } from "viem";
import type { FetchFn, Stamper } from "./client.js";

const DEFAULT_API_BASE_URL = "https://api.kryard.com";
const DEFAULT_TTL_SECONDS = 300;
const CLOCK_SKEW_LEEWAY_SECONDS = 60;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_UINT_RE = /^\d+$/;

/** Standard x402 protocol versions supported by Kryard. */
export type X402Version = 1 | 2;

export interface X402PaymentRequirements {
  scheme: string;
  network: string;
  /** Required amount in token base units (x402 v1 standard; also accepted by Kryard v2). */
  maxAmountRequired?: string;
  /** Required amount in token base units (x402 v2 spec alias). */
  amount?: string;
  asset: string;
  payTo: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  outputSchema?: unknown;
  extra?: { name?: string; version?: string; [key: string]: unknown };
}

export interface X402ExactAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface X402PaymentPayload {
  x402Version: X402Version | number;
  scheme: string;
  network: string;
  /** Present on x402 v2 payloads to bind the chosen requirement. */
  accepted?: X402PaymentRequirements;
  payload: {
    signature: string;
    authorization: X402ExactAuthorization;
  };
}

export interface X402SupportedKind {
  x402Version: X402Version | number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

export interface X402SupportedResponse {
  kinds: X402SupportedKind[];
  signers?: Record<string, string[]>;
  extensions?: string[];
}

export interface X402VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer: string;
}

export interface X402SettleResponse {
  success: boolean;
  errorReason?: string;
  transaction: string;
  network: string;
  payer: string;
}

export interface X402ChallengePayload {
  x402Version: X402Version | number;
  accepts: X402PaymentRequirements[];
  error?: string;
}

export interface X402PayerSigner {
  readonly address?: string;
  signPayment(
    requirements: X402PaymentRequirements,
    opts?: { x402Version?: X402Version },
  ): Promise<X402PaymentPayload>;
}

export interface KryardX402FacilitatorClientOpts {
  /** Kryard API base URL (defaults to `https://api.kryard.com`). */
  baseUrl?: string;
  /** Facilitator wire version (`/x402/v1` or `/x402/v2`, defaults to `1`). */
  version?: X402Version;
  /** Injected fetch implementation (defaults to `globalThis.fetch`). */
  fetch?: FetchFn;
  /** Optional extra headers included on facilitator requests. */
  headers?: Record<string, string>;
}

export interface X402PaywallFacilitator {
  verify(
    paymentPayload: X402PaymentPayload,
    paymentRequirements: X402PaymentRequirements,
  ): Promise<X402VerifyResponse>;
  settle(
    paymentPayload: X402PaymentPayload,
    paymentRequirements: X402PaymentRequirements,
  ): Promise<X402SettleResponse>;
}

export interface X402PaywallOptions {
  /** Payment options the resource accepts. Must contain at least one entry. */
  accepts: X402PaymentRequirements[];
  /** Facilitator client (or custom verify/settle adapter). */
  facilitator?: X402PaywallFacilitator;
  /** Convenience facilitator base URL used when `facilitator` is omitted. */
  facilitatorUrl?: string;
  /** Injected fetch used when constructing a default facilitator client. */
  fetch?: FetchFn;
  /** Pin the paywall to a single x402 version (`1` or `2`). Defaults to dual-stack v1+v2 (`2` challenge). */
  x402Version?: X402Version;
  /** Explicit list of accepted versions (overrides `x402Version` matching behavior). */
  supportedVersions?: readonly X402Version[];
}

export interface X402SettledResult {
  settle: X402SettleResponse;
  applyHeaders(res: Response): Response;
}

export type X402PaywallCheckResult =
  | {
      ok: true;
      payer: string;
      requirements: X402PaymentRequirements;
      paymentPayload: X402PaymentPayload;
      versionUsed: X402Version;
      settle(): Promise<X402SettledResult>;
    }
  | {
      ok: false;
      response: Response;
    };

export interface X402Paywall {
  (request: Request): Promise<X402PaywallCheckResult>;
  check(request: Request): Promise<X402PaywallCheckResult>;
  challenge(error?: string): Response;
}

export interface X402MiddlewareContext {
  request: Request;
  payer: string;
  requirements: X402PaymentRequirements;
  paymentPayload: X402PaymentPayload;
  versionUsed: X402Version;
}

export type X402MiddlewareHandler = (ctx: X402MiddlewareContext) => Response | Promise<Response>;

export type X402Middleware = (request: Request, handler: X402MiddlewareHandler) => Promise<Response>;

export interface X402HonoContext {
  req: { raw: Request };
  res?: Response;
  header(name: string, value: string): void;
}

export type X402HonoMiddleware = (
  c: X402HonoContext,
  next: () => Promise<void>,
) => Promise<Response | void>;

export type X402HttpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface X402PaymentSettledInfo {
  response: Response;
  requirements: X402PaymentRequirements;
  paymentPayload: X402PaymentPayload;
  versionUsed: X402Version;
}

export interface X402FetchOptions {
  signer: X402PayerSigner;
  fetch?: X402HttpFetch;
  /** Maximum token amount in base units allowed per paid call (inclusive). */
  maxAmountPerCall?: bigint | string | number;
  /** Allowlisted networks (labels, decimal chain IDs, or CAIP-2 `eip155:*`). */
  allowedNetworks?: readonly string[];
  /** Allowlisted ERC-20 token addresses (case-insensitive). */
  allowedAssets?: readonly string[];
  /** Allowlisted recipient `payTo` addresses (case-insensitive). */
  allowedPayTo?: readonly string[];
  /** Preferred protocol version when the server supports multiple versions. */
  preferredVersion?: X402Version;
  /** Invoked when the retried response carries `PAYMENT-RESPONSE` or `X-PAYMENT-RESPONSE`. */
  onPaymentSettled?: (
    settle: X402SettleResponse,
    info: X402PaymentSettledInfo,
  ) => void | Promise<void>;
}

export interface CreateKryardCustodiedX402SignerOpts {
  baseUrl?: string;
  organizationId: string;
  signWith: string;
  stamper: Stamper;
  fetch?: FetchFn;
  ttlSeconds?: number;
  nowMs?: () => number;
  generateNonce?: () => Hex;
}

export const EIP3009_TYPED_DATA_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export type X402ViemAccount = Hex | { address: Hex };

export interface CreateViemX402SignerOpts<TAccount extends X402ViemAccount = X402ViemAccount> {
  account: TAccount;
  signTypedData: (parameters: {
    account: TAccount;
    domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: Hex;
    };
    types: typeof EIP3009_TYPED_DATA_TYPES;
    primaryType: "TransferWithAuthorization";
    message: {
      from: Hex;
      to: Hex;
      value: bigint;
      validAfter: bigint;
      validBefore: bigint;
      nonce: Hex;
    };
  }) => Promise<Hex>;
  ttlSeconds?: number;
  nowSeconds?: () => number;
  generateNonce?: () => Hex;
}

/** Base typed error for all x402 protocol, facilitator, and client errors. */
export class X402Error extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, opts?: { status?: number; code?: string; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "X402Error";
    this.status = opts?.status;
    this.code = opts?.code;
  }
}

/** Thrown when client-side spend caps or allowlists refuse a 402 challenge BEFORE signing. */
export class X402PaymentRefusedError extends X402Error {
  readonly reason: string;

  constructor(message: string, opts?: { reason?: string; code?: string; cause?: unknown }) {
    super(message, { code: opts?.code ?? opts?.reason ?? "payment_refused", cause: opts?.cause });
    this.name = "X402PaymentRefusedError";
    this.reason = opts?.reason ?? "payment_refused";
  }
}

/** Thrown when EIP-3009 signing fails (HTTP non-2xx, failed activity status, or invalid params). */
export class X402SigningError extends X402Error {
  readonly activityStatus?: string;
  readonly activityId?: string;

  constructor(
    message: string,
    opts?: {
      status?: number;
      code?: string;
      activityStatus?: string;
      activityId?: string;
      cause?: unknown;
    },
  ) {
    super(message, { status: opts?.status, code: opts?.code, cause: opts?.cause });
    this.name = "X402SigningError";
    this.activityStatus = opts?.activityStatus;
    this.activityId = opts?.activityId;
  }
}

const NETWORK_CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  mainnet: 1,
  sepolia: 11155111,
  "ethereum-sepolia": 11155111,
  base: 8453,
  "base-sepolia": 84532,
  arbitrum: 42161,
  "arbitrum-one": 42161,
  "arbitrum-sepolia": 421614,
  optimism: 10,
  "optimism-sepolia": 11155420,
  polygon: 137,
  "polygon-amoy": 80002,
};

/**
 * Parse a CAIP-2 (`eip155:84532`), numeric (`84532`), or standard network label
 * (`base`, `base-sepolia`, `ethereum`, `sepolia`, `ethereum-sepolia`, `arbitrum`,
 * `arbitrum-sepolia`, `optimism`, `optimism-sepolia`, `polygon`, `polygon-amoy`)
 * into a positive integer EVM chain ID.
 */
export function parseX402ChainId(networkOrChainId: string): number {
  if (typeof networkOrChainId !== "string") {
    throw new X402Error("Invalid x402 network: expected non-empty string");
  }
  const normalized = networkOrChainId.trim().toLowerCase();
  if (!normalized) {
    throw new X402Error("Invalid x402 network: empty string");
  }

  let decimalCandidate: string | undefined;
  if (normalized.startsWith("eip155:")) {
    decimalCandidate = normalized.slice("eip155:".length).trim();
  } else if (DECIMAL_UINT_RE.test(normalized)) {
    decimalCandidate = normalized;
  }

  if (decimalCandidate !== undefined) {
    if (!DECIMAL_UINT_RE.test(decimalCandidate)) {
      throw new X402Error(`Invalid EVM CAIP-2 chain id: "${networkOrChainId}"`);
    }
    const parsed = Number(decimalCandidate);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new X402Error(`Invalid EVM chain id: "${networkOrChainId}"`);
    }
    return parsed;
  }

  const mapped = NETWORK_CHAIN_IDS[normalized];
  if (mapped !== undefined) return mapped;

  throw new X402Error(`Unsupported x402 network: "${networkOrChainId}"`);
}

function tryParseX402ChainId(networkOrChainId: string): number | null {
  try {
    return parseX402ChainId(networkOrChainId);
  } catch {
    return null;
  }
}

function networksMatch(a: string, b: string): boolean {
  const normA = a.trim().toLowerCase();
  const normB = b.trim().toLowerCase();
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  const cidA = tryParseX402ChainId(normA);
  const cidB = tryParseX402ChainId(normB);
  return cidA !== null && cidB !== null && cidA === cidB;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin);
}

function base64ToBytes(encoded: string): Uint8Array {
  const clean = encoded.trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!clean) throw new X402Error("Empty x402 header");
  const rem = clean.length % 4;
  if (rem === 1) throw new X402Error("Malformed base64 x402 header");
  const padded = rem === 0 ? clean : clean + "=".repeat(4 - rem);
  let bin: string;
  try {
    bin = atob(padded);
  } catch (err) {
    throw new X402Error("Malformed base64 x402 header", { cause: err });
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

/** Encode any JSON-serializable x402 payload into UTF-8 safe base64 for HTTP headers. */
export function encodeX402Header(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new X402Error("Cannot encode undefined value into x402 header");
  }
  return bytesToBase64(new TextEncoder().encode(json));
}

/** Decode a UTF-8 safe base64 x402 HTTP header back into its JSON value. */
export function decodeX402Header<T = unknown>(header: string): T {
  if (typeof header !== "string" || !header.trim()) {
    throw new X402Error("x402 header must be a non-empty string");
  }
  const bytes = base64ToBytes(header);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (err) {
    throw new X402Error("Invalid UTF-8 in x402 header", { cause: err });
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new X402Error("Invalid JSON in x402 header", { cause: err });
  }
}

function defaultFetchFn(): FetchFn {
  if (typeof globalThis.fetch !== "function") {
    throw new X402Error("No fetch implementation available in this runtime");
  }
  return globalThis.fetch.bind(globalThis) as FetchFn;
}

function defaultHttpFetch(): X402HttpFetch {
  if (typeof globalThis.fetch !== "function") {
    throw new X402Error("No fetch implementation available in this runtime");
  }
  return globalThis.fetch.bind(globalThis);
}

function normalizeBaseUrl(rawBaseUrl?: string): string {
  if (rawBaseUrl === undefined) return DEFAULT_API_BASE_URL;
  const trimmed = rawBaseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new X402Error("baseUrl must be a non-empty URL");
  return trimmed;
}

function resolveRequiredAmount(req: X402PaymentRequirements): string {
  const raw = req.maxAmountRequired ?? req.amount;
  if (typeof raw !== "string" || !DECIMAL_UINT_RE.test(raw.trim())) {
    throw new X402Error("PaymentRequirements is missing a valid integer maxAmountRequired/amount");
  }
  return raw.trim();
}

function randomNonceHex(): Hex {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new X402Error("WebCrypto getRandomValues is unavailable to generate EIP-3009 nonce");
  }
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let hex = "0x";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex as Hex;
}

function extractErrorMessage(text: string): { message: string; code?: string } {
  if (!text) return { message: "(empty response)" };
  try {
    const parsed = JSON.parse(text) as {
      message?: unknown;
      error?: unknown;
      errorReason?: unknown;
      invalidReason?: unknown;
      code?: unknown;
    };
    const msg =
      (typeof parsed.message === "string" && parsed.message) ||
      (typeof parsed.errorReason === "string" && parsed.errorReason) ||
      (typeof parsed.invalidReason === "string" && parsed.invalidReason) ||
      (typeof parsed.error === "string" && parsed.error) ||
      text;
    const code =
      typeof parsed.code === "string" || typeof parsed.code === "number"
        ? String(parsed.code)
        : undefined;
    return { message: msg, code };
  } catch {
    return { message: text };
  }
}

/**
 * HTTP client for Kryard's public x402 facilitator (`/x402/v1` and `/x402/v2`).
 */
export class KryardX402FacilitatorClient implements X402PaywallFacilitator {
  private readonly baseUrl: string;
  readonly version: X402Version;
  private readonly fetchFn: FetchFn;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts?: KryardX402FacilitatorClientOpts) {
    this.baseUrl = normalizeBaseUrl(opts?.baseUrl);
    const version = opts?.version ?? 1;
    if (version !== 1 && version !== 2) {
      throw new X402Error(`Unsupported x402 facilitator version: ${String(version)}`);
    }
    this.version = version;
    this.fetchFn = opts?.fetch ?? defaultFetchFn();
    this.extraHeaders = { ...(opts?.headers ?? {}) };
  }

  /** Fetch supported networks, schemes, and facilitator signer addresses. */
  async supported(): Promise<X402SupportedResponse> {
    const res = await this.fetchFn(`${this.baseUrl}/x402/v${this.version}/supported`, {
      method: "GET",
      headers: { ...this.extraHeaders },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "(unreadable)");
      const { message, code } = extractErrorMessage(text);
      throw new X402Error(`x402 supported failed with ${res.status}: ${message}`, {
        status: res.status,
        code,
      });
    }
    const json = (await res.json()) as Partial<X402SupportedResponse>;
    if (!json || !Array.isArray(json.kinds)) {
      throw new X402Error("x402 supported: response missing kinds array", { status: res.status });
    }
    return json as X402SupportedResponse;
  }

  /** Verify an exact/EIP-3009 payment payload against requirements without settling on-chain. */
  async verify(
    paymentPayload: X402PaymentPayload,
    paymentRequirements: X402PaymentRequirements,
  ): Promise<X402VerifyResponse> {
    return this.postWire<X402VerifyResponse>(
      "verify",
      {
        x402Version: this.version,
        paymentPayload,
        paymentRequirements,
      },
      (data) => typeof (data as Partial<X402VerifyResponse>)?.isValid === "boolean",
    );
  }

  /** Settle a verified exact/EIP-3009 payment payload on-chain via Kryard's facilitator relayer. */
  async settle(
    paymentPayload: X402PaymentPayload,
    paymentRequirements: X402PaymentRequirements,
  ): Promise<X402SettleResponse> {
    return this.postWire<X402SettleResponse>(
      "settle",
      {
        x402Version: this.version,
        paymentPayload,
        paymentRequirements,
      },
      (data) => typeof (data as Partial<X402SettleResponse>)?.success === "boolean",
    );
  }

  private async postWire<T>(
    endpoint: "verify" | "settle",
    body: Record<string, unknown>,
    isWireShape: (data: unknown) => boolean,
  ): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}/x402/v${this.version}/${endpoint}`, {
      method: "POST",
      headers: {
        ...this.extraHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await res.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    if (parsed !== undefined && isWireShape(parsed)) {
      return parsed as T;
    }
    if (!res.ok) {
      const { message, code } = extractErrorMessage(text);
      throw new X402Error(`x402 ${endpoint} failed with ${res.status}: ${message}`, {
        status: res.status,
        code,
      });
    }
    throw new X402Error(`x402 ${endpoint}: unexpected response shape`, { status: res.status });
  }
}

function isValidPaymentPayloadShape(value: unknown): value is X402PaymentPayload {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  if (typeof p.scheme !== "string" || !p.scheme.trim()) return false;
  if (typeof p.network !== "string" || !p.network.trim()) return false;
  const inner = p.payload;
  if (!inner || typeof inner !== "object") return false;
  const payloadObj = inner as Record<string, unknown>;
  if (typeof payloadObj.signature !== "string" || !payloadObj.signature.trim()) return false;
  const auth = payloadObj.authorization;
  if (!auth || typeof auth !== "object") return false;
  const authObj = auth as Record<string, unknown>;
  return (
    typeof authObj.from === "string" &&
    typeof authObj.to === "string" &&
    typeof authObj.value === "string" &&
    typeof authObj.validAfter === "string" &&
    typeof authObj.validBefore === "string" &&
    typeof authObj.nonce === "string"
  );
}

function matchRequirementCandidates(
  accepts: readonly X402PaymentRequirements[],
  paymentPayload: X402PaymentPayload,
  versionUsed: X402Version,
): X402PaymentRequirements[] {
  const payloadScheme = paymentPayload.scheme.trim().toLowerCase();
  const payloadNet = paymentPayload.network.trim();

  if (versionUsed === 2 && paymentPayload.accepted) {
    const accepted = paymentPayload.accepted;
    const accScheme = typeof accepted.scheme === "string" ? accepted.scheme.trim().toLowerCase() : "";
    const accNet = typeof accepted.network === "string" ? accepted.network.trim() : "";
    const accAsset = typeof accepted.asset === "string" ? accepted.asset.trim().toLowerCase() : "";
    const accPayTo = typeof accepted.payTo === "string" ? accepted.payTo.trim().toLowerCase() : "";
    const accAmount = accepted.maxAmountRequired ?? accepted.amount;

    return accepts.filter((req) => {
      if (req.scheme.trim().toLowerCase() !== payloadScheme) return false;
      if (accScheme && req.scheme.trim().toLowerCase() !== accScheme) return false;
      if (!networksMatch(req.network, payloadNet)) return false;
      if (accNet && !networksMatch(req.network, accNet)) return false;
      if (accAsset && req.asset.trim().toLowerCase() !== accAsset) return false;
      if (accPayTo && req.payTo.trim().toLowerCase() !== accPayTo) return false;
      if (typeof accAmount === "string") {
        try {
          if (resolveRequiredAmount(req) !== accAmount.trim()) return false;
        } catch {
          return false;
        }
      }
      return true;
    });
  }

  const bySchemeAndNet = accepts.filter(
    (req) =>
      req.scheme.trim().toLowerCase() === payloadScheme && networksMatch(req.network, payloadNet),
  );
  if (bySchemeAndNet.length <= 1) return bySchemeAndNet;

  const authTo = paymentPayload.payload.authorization.to.trim().toLowerCase();
  const byPayTo = bySchemeAndNet.filter((req) => req.payTo.trim().toLowerCase() === authTo);
  return byPayTo.length > 0 ? byPayTo : bySchemeAndNet;
}

function cloneResponseWithHeaders(res: Response, extraHeaders: Record<string, string>): Response {
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function resolvePaywallVersions(opts: X402PaywallOptions): {
  supportsV1: boolean;
  supportsV2: boolean;
  challengeVersion: X402Version;
} {
  if (opts.supportedVersions !== undefined) {
    if (opts.supportedVersions.length === 0) {
      throw new X402Error("createX402Paywall: supportedVersions cannot be empty");
    }
    for (const v of opts.supportedVersions) {
      if (v !== 1 && v !== 2) {
        throw new X402Error(`createX402Paywall: unsupported version ${String(v)}`);
      }
    }
    const supportsV1 = opts.supportedVersions.includes(1);
    const supportsV2 = opts.supportedVersions.includes(2);
    const challengeVersion = opts.x402Version ?? (supportsV2 ? 2 : 1);
    return { supportsV1, supportsV2, challengeVersion };
  }

  if (opts.x402Version === 1) {
    return { supportsV1: true, supportsV2: false, challengeVersion: 1 };
  }
  if (opts.x402Version === 2) {
    return { supportsV1: false, supportsV2: true, challengeVersion: 2 };
  }
  if (opts.x402Version !== undefined) {
    throw new X402Error(`createX402Paywall: unsupported x402Version ${String(opts.x402Version)}`);
  }
  return { supportsV1: true, supportsV2: true, challengeVersion: 2 };
}

/**
 * Create a seller-side x402 paywall verifier/challenger supporting both v2
 * (`PAYMENT-SIGNATURE` / `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE`) and v1
 * (`X-PAYMENT` / JSON 402 / `X-PAYMENT-RESPONSE`).
 */
export function createX402Paywall(opts: X402PaywallOptions): X402Paywall {
  if (!Array.isArray(opts?.accepts) || opts.accepts.length === 0) {
    throw new X402Error("createX402Paywall: accepts must be a non-empty array");
  }
  const accepts = opts.accepts.slice();
  const { supportsV1, supportsV2, challengeVersion } = resolvePaywallVersions(opts);
  const facilitator: X402PaywallFacilitator =
    opts.facilitator ??
    new KryardX402FacilitatorClient({
      baseUrl: opts.facilitatorUrl,
      version: challengeVersion,
      fetch: opts.fetch,
    });

  const challenge = (error?: string): Response => {
    const bodyPayload: X402ChallengePayload = {
      x402Version: challengeVersion,
      accepts,
      ...(error ? { error } : {}),
    };
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
    });
    if (supportsV2) {
      const v2HeaderPayload: X402ChallengePayload = {
        x402Version: 2,
        accepts,
        ...(error ? { error } : {}),
      };
      headers.set("PAYMENT-REQUIRED", encodeX402Header(v2HeaderPayload));
    }
    return new Response(JSON.stringify(bodyPayload), {
      status: 402,
      headers,
    });
  };

  const check = async (request: Request): Promise<X402PaywallCheckResult> => {
    const sigHeader = supportsV2 ? request.headers.get("payment-signature") : null;
    const xPayHeader = supportsV1 ? request.headers.get("x-payment") : null;

    let rawHeader: string | null = null;
    let versionUsed: X402Version | null = null;
    if (sigHeader && sigHeader.trim()) {
      rawHeader = sigHeader;
      versionUsed = 2;
    } else if (xPayHeader && xPayHeader.trim()) {
      rawHeader = xPayHeader;
      versionUsed = 1;
    }

    if (!rawHeader || versionUsed === null) {
      return { ok: false, response: challenge() };
    }

    let decoded: unknown;
    try {
      decoded = decodeX402Header<unknown>(rawHeader);
    } catch {
      return { ok: false, response: challenge("invalid_payment_header") };
    }

    if (!isValidPaymentPayloadShape(decoded)) {
      return { ok: false, response: challenge("invalid_payment_payload") };
    }

    if (decoded.x402Version !== undefined && decoded.x402Version !== versionUsed) {
      return { ok: false, response: challenge("invalid_x402_version") };
    }

    const candidates = matchRequirementCandidates(accepts, decoded, versionUsed);
    if (candidates.length === 0) {
      return { ok: false, response: challenge("no_matching_payment_requirements") };
    }

    let matchedRequirements: X402PaymentRequirements | undefined;
    let verifyResult: X402VerifyResponse | undefined;
    for (const candidate of candidates) {
      const res = await facilitator.verify(decoded, candidate);
      verifyResult = res;
      if (res.isValid) {
        matchedRequirements = candidate;
        break;
      }
    }

    if (!matchedRequirements || !verifyResult?.isValid) {
      return {
        ok: false,
        response: challenge(verifyResult?.invalidReason ?? "payment_verification_failed"),
      };
    }

    const payer = verifyResult.payer || decoded.payload.authorization.from;
    const selectedRequirements = matchedRequirements;
    const usedVersion = versionUsed;

    return {
      ok: true,
      payer,
      requirements: selectedRequirements,
      paymentPayload: decoded,
      versionUsed: usedVersion,
      async settle(): Promise<X402SettledResult> {
        const settleRes = await facilitator.settle(decoded, selectedRequirements);
        return {
          settle: settleRes,
          applyHeaders(res: Response): Response {
            const encoded = encodeX402Header(settleRes);
            const extra: Record<string, string> = {
              "X-PAYMENT-RESPONSE": encoded,
            };
            if (usedVersion === 2) {
              extra["PAYMENT-RESPONSE"] = encoded;
            }
            return cloneResponseWithHeaders(res, extra);
          },
        };
      },
    };
  };

  return Object.assign(check, { check, challenge });
}

/**
 * Web-Standard middleware: verifies payment BEFORE invoking `handler`,
 * skips settlement when `handler` returns non-2xx (`!res.ok`), and attaches
 * `X-PAYMENT-RESPONSE` (plus `PAYMENT-RESPONSE` when v2) on settled responses.
 */
export function createX402Middleware(opts: X402PaywallOptions): X402Middleware {
  const paywall = createX402Paywall(opts);

  return async (request: Request, handler: X402MiddlewareHandler): Promise<Response> => {
    const check = await paywall.check(request);
    if (!check.ok) return check.response;

    const res = await handler({
      request,
      payer: check.payer,
      requirements: check.requirements,
      paymentPayload: check.paymentPayload,
      versionUsed: check.versionUsed,
    });

    if (!res.ok) return res;

    const settled = await check.settle();
    if (!settled.settle.success) {
      return paywall.challenge(settled.settle.errorReason ?? "settlement_failed");
    }
    return settled.applyHeaders(res);
  };
}

/**
 * Zero-dependency Hono-compatible middleware adapter `(c, next)` using `c.req.raw`,
 * `c.header(...)`, `await next()`, settling on `c.res.status >= 200 && c.res.status < 300`,
 * and returning `402` on settlement failure.
 */
export function createX402HonoMiddleware(opts: X402PaywallOptions): X402HonoMiddleware {
  const paywall = createX402Paywall(opts);

  return async (c: X402HonoContext, next: () => Promise<void>): Promise<Response | void> => {
    const check = await paywall.check(c.req.raw);
    if (!check.ok) {
      c.res = check.response;
      return check.response;
    }

    await next();

    const status = c.res?.status;
    if (typeof status !== "number" || status < 200 || status >= 300) {
      return;
    }

    const settled = await check.settle();
    if (!settled.settle.success) {
      const failRes = paywall.challenge(settled.settle.errorReason ?? "settlement_failed");
      c.res = undefined;
      c.res = failRes;
      return failRes;
    }

    const encoded = encodeX402Header(settled.settle);
    c.header("X-PAYMENT-RESPONSE", encoded);
    if (check.versionUsed === 2) {
      c.header("PAYMENT-RESPONSE", encoded);
    }
  };
}

function resolveSigningParams(
  requirements: X402PaymentRequirements,
  ttlOverride: number | undefined,
  nowSec: number,
  generateNonce: () => Hex,
): {
  chainId: number;
  tokenName: string;
  tokenVersion: string;
  valueStr: string;
  validAfterStr: string;
  validBeforeStr: string;
  nonce: Hex;
} {
  if (requirements.scheme.trim().toLowerCase() !== "exact") {
    throw new X402SigningError(`Unsupported x402 payment scheme: "${requirements.scheme}"`, {
      code: "UNSUPPORTED_SCHEME",
    });
  }
  if (!ADDRESS_RE.test(requirements.asset.trim())) {
    throw new X402SigningError(`Invalid token asset address: "${requirements.asset}"`, {
      code: "INVALID_ASSET_ADDRESS",
    });
  }
  if (!ADDRESS_RE.test(requirements.payTo.trim())) {
    throw new X402SigningError(`Invalid recipient payTo address: "${requirements.payTo}"`, {
      code: "INVALID_PAY_TO_ADDRESS",
    });
  }
  const tokenName = requirements.extra?.name?.trim();
  const tokenVersion = requirements.extra?.version?.trim();
  if (!tokenName || !tokenVersion) {
    throw new X402SigningError(
      "PaymentRequirements.extra.name and extra.version are required for EIP-3009 signing",
      { code: "MISSING_EIP712_DOMAIN" },
    );
  }

  let chainId: number;
  try {
    chainId = parseX402ChainId(requirements.network);
  } catch (err) {
    throw new X402SigningError(
      err instanceof Error ? err.message : "Unsupported x402 network",
      { code: "UNSUPPORTED_NETWORK", cause: err },
    );
  }

  let valueStr: string;
  try {
    valueStr = resolveRequiredAmount(requirements);
  } catch (err) {
    throw new X402SigningError(
      err instanceof Error ? err.message : "Invalid required payment amount",
      { code: "INVALID_AMOUNT", cause: err },
    );
  }

  const rawTtl =
    ttlOverride !== undefined
      ? ttlOverride
      : requirements.maxTimeoutSeconds !== undefined && requirements.maxTimeoutSeconds > 0
        ? requirements.maxTimeoutSeconds
        : DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(rawTtl) || rawTtl <= 0) {
    throw new X402SigningError("ttlSeconds must be a positive number", { code: "INVALID_TTL" });
  }

  const validAfter = Math.max(0, Math.floor(nowSec) - CLOCK_SKEW_LEEWAY_SECONDS);
  const validBefore = Math.floor(nowSec) + Math.ceil(rawTtl);

  return {
    chainId,
    tokenName,
    tokenVersion,
    valueStr,
    validAfterStr: String(validAfter),
    validBeforeStr: String(validBefore),
    nonce: generateNonce(),
  };
}

interface SignEip3009ActivityEnvelope {
  activity?: {
    id?: string;
    status?: string;
    failure?: { code?: string; message?: string };
    result?: {
      signEip3009AuthorizationResult?: {
        walletAddress?: string;
        paymentPayload?: X402PaymentPayload;
      };
    };
  };
}

/**
 * Create a buyer `X402PayerSigner` backed by Kryard's KMS-custodied EIP-3009
 * signing endpoint (`POST /public/v1/submit/sign_eip3009_authorization`) with X-Stamp auth.
 */
export function createKryardCustodiedX402Signer(
  opts: CreateKryardCustodiedX402SignerOpts,
): X402PayerSigner {
  const organizationId = typeof opts?.organizationId === "string" ? opts.organizationId.trim() : "";
  if (!organizationId) {
    throw new X402Error("createKryardCustodiedX402Signer: organizationId is required");
  }
  const signWith = typeof opts?.signWith === "string" ? opts.signWith.trim() : "";
  if (!signWith) {
    throw new X402Error("createKryardCustodiedX402Signer: signWith is required");
  }
  if (!opts?.stamper || typeof opts.stamper.stamp !== "function") {
    throw new X402Error("createKryardCustodiedX402Signer: stamper is required");
  }

  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const fetchFn = opts.fetch ?? defaultFetchFn();
  const nowMs = opts.nowMs ?? (() => Date.now());
  const generateNonce = opts.generateNonce ?? randomNonceHex;

  return {
    address: ADDRESS_RE.test(signWith) ? signWith : undefined,

    async signPayment(
      requirements: X402PaymentRequirements,
      signOpts?: { x402Version?: X402Version },
    ): Promise<X402PaymentPayload> {
      const x402Version: X402Version = signOpts?.x402Version ?? 1;
      const ms = nowMs();
      const params = resolveSigningParams(
        requirements,
        opts.ttlSeconds,
        Math.floor(ms / 1000),
        generateNonce,
      );

      const requestBody = {
        type: "ACTIVITY_TYPE_SIGN_EIP3009_AUTHORIZATION",
        organizationId,
        timestampMs: String(ms),
        parameters: {
          signWith,
          chainId: String(params.chainId),
          tokenAddress: requirements.asset,
          tokenName: params.tokenName,
          tokenVersion: params.tokenVersion,
          to: requirements.payTo,
          value: params.valueStr,
          validAfter: params.validAfterStr,
          validBefore: params.validBeforeStr,
          nonce: params.nonce,
          network: requirements.network,
          x402Version,
        },
      };

      const rawBody = JSON.stringify(requestBody);
      const { stampHeaderName, stampHeaderValue } = await opts.stamper.stamp(rawBody);

      const res = await fetchFn(`${baseUrl}/public/v1/submit/sign_eip3009_authorization`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [stampHeaderName]: stampHeaderValue,
        },
        body: rawBody,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let message = text || `HTTP ${res.status}`;
        let code: string | undefined;
        let activityStatus: string | undefined;
        try {
          const parsed = JSON.parse(text) as {
            code?: unknown;
            message?: unknown;
            error?: unknown;
            activity?: {
              status?: unknown;
              failure?: { code?: unknown; message?: unknown };
            };
          };
          if (parsed.activity) {
            if (typeof parsed.activity.status === "string") activityStatus = parsed.activity.status;
            if (typeof parsed.activity.failure?.code === "string") {
              code = parsed.activity.failure.code;
            }
            if (typeof parsed.activity.failure?.message === "string" && parsed.activity.failure.message) {
              message = parsed.activity.failure.message;
            }
          }
          if (typeof parsed.message === "string" && parsed.message) message = parsed.message;
          else if (typeof parsed.error === "string" && parsed.error) message = parsed.error;
          if (code === undefined && (typeof parsed.code === "string" || typeof parsed.code === "number")) {
            code = String(parsed.code);
          }
        } catch {
          // Preserve raw response text.
        }
        throw new X402SigningError(`EIP-3009 signing failed with ${res.status}: ${message}`, {
          status: res.status,
          code,
          activityStatus,
        });
      }

      const envelope = (await res.json()) as SignEip3009ActivityEnvelope;
      const activity = envelope?.activity;
      if (!activity || typeof activity !== "object") {
        throw new X402SigningError("EIP-3009 signing response missing activity", {
          status: res.status,
        });
      }
      if (activity.status !== "ACTIVITY_STATUS_COMPLETED") {
        throw new X402SigningError(
          activity.failure?.message ??
            `EIP-3009 signing activity failed with status ${String(activity.status)}`,
          {
            status: res.status,
            code: activity.failure?.code,
            activityStatus: activity.status,
            activityId: activity.id,
          },
        );
      }

      const signedPayload = activity.result?.signEip3009AuthorizationResult?.paymentPayload;
      if (!signedPayload) {
        throw new X402SigningError("EIP-3009 signing response missing paymentPayload", {
          status: res.status,
          activityStatus: activity.status,
          activityId: activity.id,
        });
      }

      const result: X402PaymentPayload = {
        x402Version,
        scheme: signedPayload.scheme ?? requirements.scheme,
        network: signedPayload.network ?? requirements.network,
        payload: signedPayload.payload,
      };
      if (x402Version === 2) {
        result.accepted = requirements;
      }
      return result;
    },
  };
}

/**
 * Create a self-custodied buyer `X402PayerSigner` using a local or browser `viem`
 * account/wallet client `signTypedData` function to sign EIP-712 `TransferWithAuthorization`.
 */
export function createViemX402Signer<TAccount extends X402ViemAccount>(
  opts: CreateViemX402SignerOpts<TAccount>,
): X402PayerSigner {
  const address = typeof opts?.account === "string" ? opts.account : opts?.account?.address;
  if (typeof address !== "string" || !ADDRESS_RE.test(address)) {
    throw new X402Error("createViemX402Signer: account must be a 0x address or { address }");
  }
  if (typeof opts?.signTypedData !== "function") {
    throw new X402Error("createViemX402Signer: signTypedData function is required");
  }

  const nowSeconds = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const generateNonce = opts.generateNonce ?? randomNonceHex;

  return {
    address,

    async signPayment(
      requirements: X402PaymentRequirements,
      signOpts?: { x402Version?: X402Version },
    ): Promise<X402PaymentPayload> {
      const x402Version: X402Version = signOpts?.x402Version ?? 1;
      const params = resolveSigningParams(requirements, opts.ttlSeconds, nowSeconds(), generateNonce);

      let signature: Hex;
      try {
        signature = await opts.signTypedData({
          account: opts.account,
          domain: {
            name: params.tokenName,
            version: params.tokenVersion,
            chainId: params.chainId,
            verifyingContract: requirements.asset as Hex,
          },
          types: EIP3009_TYPED_DATA_TYPES,
          primaryType: "TransferWithAuthorization",
          message: {
            from: address as Hex,
            to: requirements.payTo as Hex,
            value: BigInt(params.valueStr),
            validAfter: BigInt(params.validAfterStr),
            validBefore: BigInt(params.validBeforeStr),
            nonce: params.nonce,
          },
        });
      } catch (err) {
        if (err instanceof X402SigningError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        const code =
          typeof (err as { code?: unknown })?.code === "string" ||
          typeof (err as { code?: unknown })?.code === "number"
            ? String((err as { code?: unknown }).code)
            : undefined;
        throw new X402SigningError(`viem EIP-3009 signing failed: ${msg}`, {
          code,
          cause: err,
        });
      }

      const result: X402PaymentPayload = {
        x402Version,
        scheme: requirements.scheme,
        network: requirements.network,
        payload: {
          signature,
          authorization: {
            from: address,
            to: requirements.payTo,
            value: params.valueStr,
            validAfter: params.validAfterStr,
            validBefore: params.validBeforeStr,
            nonce: params.nonce,
          },
        },
      };
      if (x402Version === 2) {
        result.accepted = requirements;
      }
      return result;
    },
  };
}

function parseMaxAmountCap(cap: bigint | string | number): bigint {
  if (typeof cap === "bigint") {
    if (cap < 0n) throw new X402Error("maxAmountPerCall must be non-negative");
    return cap;
  }
  if (typeof cap === "number") {
    if (!Number.isSafeInteger(cap) || cap < 0) {
      throw new X402Error("maxAmountPerCall number must be a non-negative safe integer");
    }
    return BigInt(cap);
  }
  if (typeof cap === "string") {
    const trimmed = cap.trim();
    if (!DECIMAL_UINT_RE.test(trimmed)) {
      throw new X402Error("maxAmountPerCall string must be a non-negative integer");
    }
    return BigInt(trimmed);
  }
  throw new X402Error("maxAmountPerCall must be a bigint, integer string, or safe integer");
}

function selectRequirementWithGuards(
  accepts: readonly X402PaymentRequirements[],
  guards: {
    maxCap?: bigint;
    allowedNetworks?: readonly string[];
    allowedAssets?: readonly string[];
    allowedPayTo?: readonly string[];
  },
): X402PaymentRequirements {
  if (accepts.length === 0) {
    throw new X402PaymentRefusedError("402 response offered no payment requirements", {
      reason: "no_matching_requirement",
    });
  }

  const normalizedAssets = guards.allowedAssets?.map((a) => a.trim().toLowerCase());
  const normalizedPayTo = guards.allowedPayTo?.map((p) => p.trim().toLowerCase());
  let lastRefusal: { reason: string; message: string } | undefined;

  for (const req of accepts) {
    if (typeof req?.scheme !== "string" || req.scheme.trim().toLowerCase() !== "exact") {
      lastRefusal = {
        reason: "unsupported_scheme",
        message: `Refusing unsupported x402 scheme: "${String(req?.scheme)}"`,
      };
      continue;
    }
    if (
      guards.allowedNetworks !== undefined &&
      !guards.allowedNetworks.some((allowed) => networksMatch(req.network, allowed))
    ) {
      lastRefusal = {
        reason: "network_not_allowed",
        message: `Refusing x402 payment on disallowed network "${req.network}"`,
      };
      continue;
    }
    if (
      normalizedAssets !== undefined &&
      !normalizedAssets.includes(req.asset.trim().toLowerCase())
    ) {
      lastRefusal = {
        reason: "asset_not_allowed",
        message: `Refusing x402 payment for disallowed asset "${req.asset}"`,
      };
      continue;
    }
    if (
      normalizedPayTo !== undefined &&
      !normalizedPayTo.includes(req.payTo.trim().toLowerCase())
    ) {
      lastRefusal = {
        reason: "pay_to_not_allowed",
        message: `Refusing x402 payment to disallowed recipient "${req.payTo}"`,
      };
      continue;
    }
    if (guards.maxCap !== undefined) {
      let requiredAmount: bigint;
      try {
        requiredAmount = BigInt(resolveRequiredAmount(req));
      } catch {
        lastRefusal = {
          reason: "invalid_amount",
          message: "Refusing x402 payment requirement with invalid amount",
        };
        continue;
      }
      if (requiredAmount > guards.maxCap) {
        lastRefusal = {
          reason: "amount_exceeds_max",
          message: `Refusing x402 payment of ${requiredAmount.toString()} exceeding maxAmountPerCall ${guards.maxCap.toString()}`,
        };
        continue;
      }
    }
    return req;
  }

  throw new X402PaymentRefusedError(
    lastRefusal?.message ?? "No x402 payment requirement satisfied client policy",
    { reason: lastRefusal?.reason ?? "no_matching_requirement" },
  );
}

async function extract402Challenge(res: Response): Promise<{
  accepts: X402PaymentRequirements[];
  supportsV2: boolean;
  serverVersion: X402Version | undefined;
}> {
  const headerRaw = res.headers.get("payment-required");
  let headerChallenge: X402ChallengePayload | undefined;
  if (headerRaw && headerRaw.trim()) {
    try {
      const decoded = decodeX402Header<X402ChallengePayload>(headerRaw);
      if (decoded && Array.isArray(decoded.accepts)) {
        headerChallenge = decoded;
      }
    } catch {
      // Fall back to JSON body if header wasn't valid.
    }
  }

  let bodyChallenge: X402ChallengePayload | undefined;
  try {
    const json = (await res.clone().json()) as Partial<X402ChallengePayload> | null;
    if (json && Array.isArray(json.accepts)) {
      bodyChallenge = json as X402ChallengePayload;
    }
  } catch {
    // Non-JSON 402 body.
  }

  const accepts =
    (headerChallenge?.accepts.length ? headerChallenge.accepts : undefined) ??
    bodyChallenge?.accepts ??
    headerChallenge?.accepts;

  if (!accepts) {
    throw new X402Error("402 response did not contain x402 payment requirements");
  }

  const supportsV2 = headerChallenge !== undefined || bodyChallenge?.x402Version === 2;
  const serverVersion: X402Version | undefined = supportsV2
    ? 2
    : bodyChallenge?.x402Version === 1
      ? 1
      : undefined;

  return {
    accepts,
    supportsV2,
    serverVersion,
  };
}

function buildRetryArgs(
  input: RequestInfo | URL,
  clonedRequest: Request | null,
  init: RequestInit | undefined,
  headerName: string,
  headerValue: string,
): [RequestInfo | URL, RequestInit] {
  const mergedHeaders = new Headers(
    init?.headers ?? (clonedRequest ? clonedRequest.headers : undefined),
  );
  mergedHeaders.set(headerName, headerValue);

  if (clonedRequest) {
    const retryReq = new Request(clonedRequest, {
      ...init,
      headers: mergedHeaders,
    });
    return [retryReq, {}];
  }
  return [
    input,
    {
      ...init,
      headers: mergedHeaders,
    },
  ];
}

/**
 * Wrap `fetch` to automatically handle HTTP `402 Payment Required` challenges:
 * enforces client-side `allowedNetworks`, `allowedAssets`, `allowedPayTo`, and
 * `maxAmountPerCall` BEFORE signing, signs via `signer`, retries at most once
 * with `PAYMENT-SIGNATURE` (v2) or `X-PAYMENT` (v1), and fires `onPaymentSettled`
 * when a settlement response header is returned.
 */
export function createX402Fetch(opts: X402FetchOptions): X402HttpFetch {
  if (!opts?.signer || typeof opts.signer.signPayment !== "function") {
    throw new X402Error("createX402Fetch: signer is required");
  }
  const baseFetch = opts.fetch ?? defaultHttpFetch();
  const maxCap =
    opts.maxAmountPerCall !== undefined ? parseMaxAmountCap(opts.maxAmountPerCall) : undefined;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const retryRequestTemplate: Request | null =
      typeof Request !== "undefined" && input instanceof Request ? (input.clone() as Request) : null;

    const cancelRetryClone = () => {
      if (retryRequestTemplate?.body && !retryRequestTemplate.bodyUsed) {
        void retryRequestTemplate.body.cancel().catch(() => {});
      }
    };

    const firstRes = await baseFetch(input, init);
    if (firstRes.status !== 402) {
      cancelRetryClone();
      return firstRes;
    }

    let selectedRequirements: X402PaymentRequirements;
    let versionUsed: X402Version;
    let paymentPayload: X402PaymentPayload;
    try {
      const { accepts, supportsV2, serverVersion } = await extract402Challenge(firstRes);
      versionUsed = supportsV2
        ? (opts.preferredVersion ?? 2)
        : serverVersion === 1
          ? 1
          : (opts.preferredVersion ?? 1);

      selectedRequirements = selectRequirementWithGuards(accepts, {
        maxCap,
        allowedNetworks: opts.allowedNetworks,
        allowedAssets: opts.allowedAssets,
        allowedPayTo: opts.allowedPayTo,
      });

      paymentPayload = await opts.signer.signPayment(selectedRequirements, {
        x402Version: versionUsed,
      });
    } catch (err) {
      cancelRetryClone();
      throw err;
    }

    const headerName = versionUsed === 2 ? "PAYMENT-SIGNATURE" : "X-PAYMENT";
    const encodedPayment = encodeX402Header(paymentPayload);
    const [retryInput, retryInit] = buildRetryArgs(
      input,
      retryRequestTemplate,
      init,
      headerName,
      encodedPayment,
    );

    const retryRes = await baseFetch(retryInput, retryInit);

    const settlementHeader =
      versionUsed === 2
        ? (retryRes.headers.get("payment-response") ?? retryRes.headers.get("x-payment-response"))
        : (retryRes.headers.get("x-payment-response") ?? retryRes.headers.get("payment-response"));

    if (settlementHeader && opts.onPaymentSettled) {
      const settle = decodeX402Header<X402SettleResponse>(settlementHeader);
      await opts.onPaymentSettled(settle, {
        response: retryRes,
        requirements: selectedRequirements,
        paymentPayload,
        versionUsed,
      });
    }

    return retryRes;
  };
}
