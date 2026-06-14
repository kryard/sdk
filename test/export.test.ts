import { describe, it, expect } from "vitest";
import {
  exportSuite,
  generateRecipientKeyPair,
  decryptExportBundle,
  EXPORT_INFO_LABEL,
  type ExportBundle,
} from "../src/export.js";
import { KryardClient } from "../src/wallet.js";
import type { FetchFn, Stamper } from "../src/client.js";

/** Portable bytes → base64 (mirrors the signer's base64.StdEncoding output). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Act as the Go CIRCL signer: HPKE-seal `plaintext` to `targetPublicKeyHex` under
 * the same suite/info/aad and return a bundle in the on-wire shape.
 */
async function serverSeal(
  targetPublicKeyHex: string,
  plaintext: Uint8Array,
  privateKeyId: string,
): Promise<ExportBundle> {
  const suite = exportSuite();
  const pubBytes = hexToBytes(targetPublicKeyHex);
  const recipientPublicKey = await suite.kem.deserializePublicKey(pubBytes);
  const sender = await suite.createSenderContext({
    recipientPublicKey,
    info: new TextEncoder().encode(EXPORT_INFO_LABEL),
  });
  const ct = await sender.seal(plaintext, new TextEncoder().encode(privateKeyId));
  return {
    encappedPublic: bytesToBase64(new Uint8Array(sender.enc)),
    ciphertext: bytesToBase64(new Uint8Array(ct)),
    info: EXPORT_INFO_LABEL,
    kemKdfAead: "P256_HKDF_SHA256/HKDF_SHA256/AES256GCM",
  };
}

describe("HPKE export round-trip", () => {
  it("seals to an SDK-generated recipient public key, then decryptExportBundle recovers it", async () => {
    const recipient = await generateRecipientKeyPair();
    // The recipient public key is SEC1 uncompressed (0x04 + 64 bytes) = 65 bytes = 130 hex chars.
    expect(recipient.publicKeyHex).toMatch(/^04[0-9a-f]{128}$/);

    const privateKeyId = "pk_abc123";
    const secret = hexToBytes("0123456789abcdef".repeat(4)); // a 32-byte "private key"
    const bundle = await serverSeal(recipient.publicKeyHex, secret, privateKeyId);

    const recovered = await decryptExportBundle(bundle, recipient.privateKey, privateKeyId);
    expect(Array.from(recovered)).toEqual(Array.from(secret));
  });

  it("fails to open when the aad (privateKeyId) does not match", async () => {
    const recipient = await generateRecipientKeyPair();
    const secret = new Uint8Array([1, 2, 3, 4]);
    const bundle = await serverSeal(recipient.publicKeyHex, secret, "pk_right");
    await expect(decryptExportBundle(bundle, recipient.privateKey, "pk_wrong")).rejects.toBeTruthy();
  });
});

describe("KryardClient.exportPrivateKey (full convenience flow)", () => {
  it("generates a recipient, the server seals to it, and the key is recovered as hex", async () => {
    const secret = hexToBytes("ff".repeat(32));
    const privateKeyId = "pk_resolved_999";

    const stamper: Stamper = {
      async stamp(p) {
        return { stampHeaderName: "X-Stamp", stampHeaderValue: `s(${p.length})` };
      },
    };

    // The mock server reads the targetPublicKey out of the stamped body, seals the
    // secret to it, and returns the export activity envelope.
    const fetchFn: FetchFn = async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      const targetPublicKey: string = body.parameters.targetPublicKey;
      const bundle = await serverSeal(targetPublicKey, secret, privateKeyId);
      const envelope = {
        activity: {
          id: "act_exp",
          status: "ACTIVITY_STATUS_COMPLETED",
          type: "ACTIVITY_TYPE_EXPORT_PRIVATE_KEY",
          result: { exportPrivateKeyResult: { privateKeyId, exportBundle: bundle } },
          failure: null,
        },
      };
      return {
        ok: true,
        status: 200,
        async json() {
          return envelope;
        },
        async text() {
          return JSON.stringify(envelope);
        },
      };
    };

    const client = new KryardClient({
      baseUrl: "https://api.kryard.com",
      organizationId: "org_1",
      stamper,
      fetchFn,
      nowMs: () => 1,
    });

    const out = await client.exportPrivateKey({ signWith: "0xWalletAddress" });
    expect(out.privateKey).toBe("ff".repeat(32));
  });
});
