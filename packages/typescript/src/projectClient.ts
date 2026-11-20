/**
 * projectClient.ts — the PUBLIC, project-id entry point to Kryard (ADR-013).
 *
 * A Kryard project id (`proj_<hex>`) is a public client credential — safe to ship
 * in a browser bundle — analogous to a Reown/WalletConnect project id. It gates the
 * client surface (`/client/v1/*`); the security control is the project's ORIGIN
 * allowlist (configured in the dashboard), not the id's secrecy. This is distinct
 * from `KryardRelayClient`, which authenticates server-side with a secret X-Stamp
 * API key.
 *
 * `fetchFn` is injected for testability (same shape as client.ts).
 */
import type { FetchFn } from "./client.js";

export interface KryardProjectClientOpts {
  /** The PUBLIC project id (e.g. `proj_1a2b…`). Required. */
  projectId: string;
  /** Kryard API base URL, e.g. `https://api.kryard.com`. */
  baseUrl: string;
  /** Injected fetch (defaults to global fetch). */
  fetchFn?: FetchFn;
  /**
   * Origin to send on requests. Browsers set the `Origin` header automatically;
   * supply this only in server/Node contexts where you need to match a project's
   * origin allowlist.
   */
  origin?: string;
}

/** The project's public config, as returned by `/client/v1/config`. */
export interface ProjectConfig {
  projectId: string;
  organizationId: string;
}

export class KryardProjectClient {
  private readonly projectId: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly origin: string | undefined;

  constructor(opts: KryardProjectClientOpts) {
    if (!opts.projectId) throw new Error("KryardProjectClient: projectId is required");
    if (!opts.baseUrl) throw new Error("KryardProjectClient: baseUrl is required");
    this.projectId = opts.projectId;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch.bind(globalThis) as FetchFn);
    this.origin = opts.origin;
  }

  /** Resolve the project's public config (validates the id + origin server-side). */
  async getConfig(): Promise<ProjectConfig> {
    return this.get<ProjectConfig>("/client/v1/config", "project config");
  }

  private async get<T>(path: string, label: string): Promise<T> {
    const headers: Record<string, string> = { "x-kryard-project": this.projectId };
    if (this.origin) headers["origin"] = this.origin;
    const res = await this.fetchFn(`${this.baseUrl}${path}`, { method: "GET", headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "(unreadable)");
      throw new Error(`${label} failed with ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }
}

/** @deprecated Use `KryardProjectClientOpts` instead. */
export type KryardClientOpts = KryardProjectClientOpts;

/** @deprecated Use `KryardProjectClient` instead. */
export const KryardClient = KryardProjectClient;
