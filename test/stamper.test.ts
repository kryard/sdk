import { describe, it, expect } from "vitest";
import { p256 } from "@noble/curves/p256";
import { bytesToHex } from "@noble/hashes/utils";
import { createApiKeyStamper } from "../src/stamper.js";

// A throwaway test P-256 keypair (NOT a real credential).
const PRIV = "0000000000000000000000000000000000000000000000000000000000000001";
const PUB = bytesToHex(p256.getPublicKey(PRIV, true)); // compressed hex

function decode(v: string): { publicKey: string; scheme: string; signature: string } {
  return JSON.parse(Buffer.from(v, "base64url").toString("utf8"));
}

describe("createApiKeyStamper", () => {
  it("emits an X-Stamp with the TK P256 scheme, deterministically (RFC6979)", async () => {
    const s = createApiKeyStamper({ apiPublicKey: PUB, apiPrivateKey: PRIV });
    const a = await s.stamp('{"organizationId":"o","timestampMs":"1"}');
    const b = await s.stamp('{"organizationId":"o","timestampMs":"1"}');
    expect(a.stampHeaderName).toBe("X-Stamp");
    expect(a.stampHeaderValue).toBe(b.stampHeaderValue); // deterministic for the same body

    const env = decode(a.stampHeaderValue);
    expect(env.scheme).toBe("SIGNATURE_SCHEME_TK_API_P256");
    expect(env.publicKey).toBe(PUB);
    expect(env.signature).toMatch(/^[0-9a-f]+$/); // DER hex
  });

  it("produces a signature that verifies against the public key over sha256(body)", async () => {
    const { sha256 } = await import("@noble/hashes/sha256");
    const s = createApiKeyStamper({ apiPublicKey: PUB, apiPrivateKey: PRIV });
    const payload = '{"hello":"kryard"}';
    const env = decode((await s.stamp(payload)).stampHeaderValue);
    const ok = p256.verify(env.signature, sha256(new TextEncoder().encode(payload)), PUB);
    expect(ok).toBe(true); // a real Kryard-side X-Stamp verification would pass
  });

  it("changes the stamp with the payload", async () => {
    const s = createApiKeyStamper({ apiPublicKey: PUB, apiPrivateKey: PRIV });
    expect((await s.stamp("a")).stampHeaderValue).not.toBe((await s.stamp("b")).stampHeaderValue);
  });
});
