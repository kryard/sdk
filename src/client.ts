/**
 * client.ts — HTTP client for Kryard's managed relay route.
 *
 * Auth is X-Stamp: each request body is signed with the relayer org's API key via
 * an injected `Stamper`. Use the SDK's dependency-free `createApiKeyStamper` (MIT),
 * or inject any compatible stamper — Kryard speaks the Turnkey protocol, so
 * `@turnkey/api-key-stamper`'s ApiKeyStamper also works. The stamp covers the EXACT
 * raw body, so we stamp the precise JSON string we send. Both stamper and fetch
 * are injected for testability.
 */
import type { Hex } from "viem";
import { stampAndPost } from "./http.js";

export interface Stamper {
  stamp(payload: string): Promise<{ stampHeaderName: string; stampHeaderValue: string }>;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** A user-signed EIP-7702 authorization in the relay wire shape. */
export interface RelayAuthorization {
  address: Hex;
  chainId: number;
  nonce: number;
  r: Hex;
  s: Hex;
  yParity: number;
}

export interface RelaySubmitInput {
  signWith: string;
  chainId: string;
  to: Hex;
  data: Hex;
  value?: string;
  speed?: "slow" | "average" | "fast";
  idempotencyKey?: string;
  authorizationList?: RelayAuthorization[];
  /** ERC-20 paymaster: the token + agreed fee the user reimburses on-chain. */
  gasToken?: Hex;
  gasTokenAmount?: string;
}

export interface RelayTx {
  id: string;
  status: string;
  nonce: string | null;
  txHash: string | null;
  failure: string | null;
  confirmations?: number | null;
}

export interface KryardRelayClientOpts {
  baseUrl: string;
  organizationId: string;
  stamper: Stamper;
  fetchFn?: FetchFn;
  nowMs?: () => number;
}

export class KryardRelayClient {
  private readonly baseUrl: string;
  private readonly organizationId: string;
  private readonly stamper: Stamper;
  private readonly fetchFn: FetchFn;
  private readonly nowMs: () => number;

  constructor(opts: KryardRelayClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.organizationId = opts.organizationId;
    this.stamper = opts.stamper;
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch.bind(globalThis) as FetchFn);
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  async submit(input: RelaySubmitInput): Promise<RelayTx> {
    const body: Record<string, unknown> = {
      organizationId: this.organizationId,
      timestampMs: String(this.nowMs()),
      signWith: input.signWith,
      chainId: input.chainId,
      to: input.to,
      data: input.data,
      value: input.value ?? "0",
    };
    if (input.speed) body.speed = input.speed;
    if (input.idempotencyKey) body.idempotencyKey = input.idempotencyKey;
    if (input.authorizationList) body.authorizationList = input.authorizationList;
    if (input.gasToken) body.gasToken = input.gasToken;
    if (input.gasTokenAmount) body.gasTokenAmount = input.gasTokenAmount;
    return this.post("/public/v1/relay/submit_transaction", body, "relay submit");
  }

  async get(transactionId: string): Promise<RelayTx> {
    return this.post(
      "/public/v1/relay/get_transaction",
      { organizationId: this.organizationId, timestampMs: String(this.nowMs()), transactionId },
      "relay get",
    );
  }

  private async post(path: string, body: Record<string, unknown>, label: string): Promise<RelayTx> {
    const payload = JSON.stringify(body);
    const res = await stampAndPost(this.fetchFn, this.stamper, `${this.baseUrl}${path}`, payload);
    if (!res.ok) {
      const text = await res.text().catch(() => "(unreadable)");
      throw new Error(`${label} failed with ${res.status}: ${text}`);
    }
    const json = (await res.json()) as { transaction?: RelayTx };
    if (!json?.transaction) throw new Error(`${label}: response missing transaction`);
    return json.transaction;
  }
}
