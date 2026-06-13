/**
 * stamper.ts — a dependency-free X-Stamp signer.
 *
 * Produces a stamp byte-identical to the Turnkey-protocol ApiKeyStamper (a DER
 * P-256 signature over sha256(body), base64url-wrapped {publicKey, scheme,
 * signature}) using only `@noble` (MIT). Kryard speaks the Turnkey protocol, so
 * you MAY instead inject any compatible `Stamper` (e.g. `@turnkey/api-key-stamper`
 * — Apache-2.0); this is the zero-dependency default and what the SDK recommends.
 */
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import type { Stamper } from "./client.js";

/** Portable base64url via `btoa` (global in Node 16+, Workers, and browsers). */
function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface ApiKeyStamperOptions {
  /** API key public component (compressed P-256 public key, hex). */
  apiPublicKey: string;
  /** API key private component (P-256 private key, hex). Secret. */
  apiPrivateKey: string;
}

/**
 * Build an X-Stamp signer from a Kryard API key — no external SDK required.
 * The result satisfies the injected `Stamper` interface consumed by
 * `KryardRelayClient`.
 */
export function createApiKeyStamper(opts: ApiKeyStamperOptions): Stamper {
  return {
    async stamp(payload: string) {
      const digest = sha256(new TextEncoder().encode(payload));
      const signature = p256.sign(digest, opts.apiPrivateKey).toDERHex();
      const envelope = JSON.stringify({
        publicKey: opts.apiPublicKey,
        scheme: "SIGNATURE_SCHEME_TK_API_P256",
        signature,
      });
      return {
        stampHeaderName: "X-Stamp",
        stampHeaderValue: base64url(new TextEncoder().encode(envelope)),
      };
    },
  };
}
