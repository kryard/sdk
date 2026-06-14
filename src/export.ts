/**
 * export.ts — HPKE decryption of a Kryard private-key export bundle.
 *
 * The signer HPKE-seals the (decrypted-inside-the-signer) private key to a
 * caller-supplied P-256 recipient public key and returns an `exportBundle`. The
 * plaintext key NEVER leaves the signer except HPKE-encrypted. The caller (this
 * SDK) generates an ephemeral recipient keypair, asks for the bundle, then opens
 * it locally with the recipient private key.
 *
 * Suite (RFC 9180, must match the Go CIRCL signer in
 * services/signer/internal/api/export_handler.go):
 *   KEM:  DHKEM(P-256, HKDF-SHA256)
 *   KDF:  HKDF-SHA256
 *   AEAD: AES-256-GCM
 *   info: "kryard-export-v1"
 *   aad:  the privateKeyId UTF-8 bytes
 */
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";

/** HPKE info label — binds the bundle to the export protocol version. */
export const EXPORT_INFO_LABEL = "kryard-export-v1";

/** The HPKE-sealed export bundle returned by Kryard (signerClient SignerExportBundle). */
export interface ExportBundle {
  /** base64(enc) — the HPKE encapsulated key. */
  encappedPublic: string;
  /** base64(ct) — the sealed private key. */
  ciphertext: string;
  /** HPKE info label, expected to be "kryard-export-v1". */
  info: string;
  /** Suite identifier string, for diagnostics. */
  kemKdfAead: string;
}

/** An ephemeral P-256 recipient keypair for one export.
 *  `publicKeyHex` is the SEC1 uncompressed (0x04-prefixed) point, as the signer
 *  expects in `targetPublicKey`. Hold `privateKey` only as long as needed, then
 *  zero it via `zeroizeRecipient`. */
export interface RecipientKeyPair {
  /** WebCrypto P-256 private key (non-extractable-friendly; used to open). */
  privateKey: CryptoKey;
  /** SEC1 uncompressed public key, hex (no 0x). */
  publicKeyHex: string;
  /** Raw serialized private-key bytes, retained so callers can zeroize them. */
  privateKeyBytes: Uint8Array;
}

/** Build the export HPKE suite (identical params to the signer). */
export function exportSuite(): CipherSuite {
  return new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hex string has odd length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex byte");
    out[i] = byte;
  }
  return out;
}

/** Portable base64 → bytes (Node + Workers + browsers via atob). */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Generate an ephemeral P-256 recipient keypair using the HPKE suite's KEM, so
 * the public-key serialization (SEC1 uncompressed) lines up exactly with what the
 * signer parses. Returns the public key as hex for `targetPublicKey`.
 */
export async function generateRecipientKeyPair(suite: CipherSuite = exportSuite()): Promise<RecipientKeyPair> {
  const kp = await suite.kem.generateKeyPair();
  const pubBytes = new Uint8Array(await suite.kem.serializePublicKey(kp.publicKey));
  let privateKeyBytes: Uint8Array;
  try {
    privateKeyBytes = new Uint8Array(await suite.kem.serializePrivateKey(kp.privateKey));
  } catch {
    // Some runtimes mark the generated private key non-extractable; opening still
    // works via the CryptoKey, we just can't surface raw bytes to zeroize.
    privateKeyBytes = new Uint8Array(0);
  }
  return {
    privateKey: kp.privateKey,
    publicKeyHex: bytesToHex(pubBytes),
    privateKeyBytes,
  };
}

/** Best-effort zeroization of any raw recipient-key bytes we hold. */
export function zeroizeRecipient(kp: RecipientKeyPair): void {
  kp.privateKeyBytes.fill(0);
}

/**
 * Open (HPKE-decrypt) an export bundle with the recipient private key, returning
 * the recovered plaintext private-key bytes.
 *
 * @param bundle               the signer's exportBundle
 * @param recipientPrivateKey  the WebCrypto P-256 private key matching the
 *                             targetPublicKey supplied for the export
 * @param privateKeyId         the activity's privateKeyId — used as the AEAD aad
 *                             (the signer seals with aad = privateKeyId bytes), so
 *                             this MUST match or `open` fails authentication
 */
export async function decryptExportBundle(
  bundle: ExportBundle,
  recipientPrivateKey: CryptoKey,
  privateKeyId: string,
  suite: CipherSuite = exportSuite(),
): Promise<Uint8Array> {
  const enc = base64ToBytes(bundle.encappedPublic);
  const ciphertext = base64ToBytes(bundle.ciphertext);
  const info = new TextEncoder().encode(bundle.info || EXPORT_INFO_LABEL);
  const aad = new TextEncoder().encode(privateKeyId);

  const recipient = await suite.createRecipientContext({
    recipientKey: recipientPrivateKey,
    enc,
    info,
  });
  const plaintext = await recipient.open(ciphertext, aad);
  return new Uint8Array(plaintext);
}

/** Hex helpers re-exported for the recovered-key encoding. */
export { bytesToHex as exportBytesToHex, hexToBytes as exportHexToBytes };
