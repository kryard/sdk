/**
 * wallet.ts — KryardClient: the wallets / signing / export surface over Kryard's
 * Turnkey-compatible activity API.
 *
 * Reuses the same X-Stamp `Stamper` and `FetchFn` as `KryardRelayClient`; every
 * method stamps the exact activity body and POSTs it through `submitActivity`,
 * which parses the single-nested envelope and throws `ActivityError` on FAILED.
 *
 * Activity types + result keys are wire-frozen (see l3-kryard ADR-002 +
 * services/api/src/enums.ts / submit.ts).
 */
import type { FetchFn, Stamper } from "./client.js";
import { submitActivity, ActivityError } from "./activity.js";
import {
  decryptExportBundle,
  exportBytesToHex,
  generateRecipientKeyPair,
  zeroizeRecipient,
  type ExportBundle,
} from "./export.js";

export interface KryardClientOpts {
  baseUrl: string;
  organizationId: string;
  stamper: Stamper;
  fetchFn?: FetchFn;
  nowMs?: () => number;
}

// --- Activity type enums (wire-frozen) ------------------------------------
const ACTIVITY_TYPE = {
  CREATE_PRIVATE_KEYS: "ACTIVITY_TYPE_CREATE_PRIVATE_KEYS_V2",
  SIGN_RAW_PAYLOAD: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
  SIGN_TRANSACTION: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
  EXPORT_PRIVATE_KEY: "ACTIVITY_TYPE_EXPORT_PRIVATE_KEY",
} as const;

// --- Method input / output types ------------------------------------------

export interface CreatePrivateKeyInput {
  name: string;
  /** Default CURVE_SECP256K1 (EVM). */
  curve?: string;
  /** Default derived from the curve (e.g. ADDRESS_FORMAT_ETHEREUM). */
  addressFormats?: string[];
  /** Optional guarded import: a raw private key, hex. Import must be enabled server-side. */
  importPrivateKeyHex?: string;
}

export interface AddressEntry {
  addressFormat: string;
  address: string;
}

export interface CreatePrivateKeyResult {
  activityId: string;
  privateKeyId: string;
  addresses: AddressEntry[];
}

export interface SignRawPayloadInput {
  /** A private-key id or an address owned by the org. */
  signWith: string;
  /** The payload to sign, hex (or per `encoding`). */
  payload: string;
  /** Curve-specific hash function (e.g. HASH_FUNCTION_KECCAK256, HASH_FUNCTION_NO_OP). */
  hashFunction: string;
  /** Default PAYLOAD_ENCODING_HEXADECIMAL. */
  encoding?: string;
}

export interface SignRawPayloadResult {
  r: string;
  s: string;
  v: string;
}

export interface SignTransactionInput {
  signWith: string;
  /** The unsigned transaction, hex. */
  unsignedTransaction: string;
  /** Default TRANSACTION_TYPE_ETHEREUM. */
  type?: string;
}

export interface SignTransactionResult {
  signedTransaction: string;
}

export interface ExportPrivateKeyBundleInput {
  signWith: string;
  /** Recipient P-256 public key, hex (SEC1 uncompressed 0x04, or compressed). */
  targetPublicKey: string;
}

export interface ExportPrivateKeyInput {
  signWith: string;
}

export interface ExportedPrivateKey {
  /** The recovered private key, hex (no 0x). */
  privateKey: string;
}

// --- The client -----------------------------------------------------------

export class KryardClient {
  private readonly baseUrl: string;
  private readonly organizationId: string;
  private readonly stamper: Stamper;
  private readonly fetchFn: FetchFn;
  private readonly nowMs: () => number;

  constructor(opts: KryardClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.organizationId = opts.organizationId;
    this.stamper = opts.stamper;
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch.bind(globalThis) as FetchFn);
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  /** Submit an activity to /public/v1/submit/<name>, parse the typed result. */
  private submit<R>(name: string, type: string, parameters: Record<string, unknown>, resultKey: string) {
    return submitActivity<R>({
      baseUrl: this.baseUrl,
      organizationId: this.organizationId,
      stamper: this.stamper,
      fetchFn: this.fetchFn,
      nowMs: this.nowMs,
      name,
      type,
      parameters,
      resultKey,
    });
  }

  /** Create (or guarded-import) a private key. Returns the id + derived addresses. */
  async createPrivateKey(input: CreatePrivateKeyInput): Promise<CreatePrivateKeyResult> {
    const parameters: Record<string, unknown> = { name: input.name };
    if (input.curve !== undefined) parameters.curve = input.curve;
    if (input.addressFormats !== undefined) parameters.addressFormats = input.addressFormats;
    if (input.importPrivateKeyHex !== undefined) parameters.importPrivateKeyHex = input.importPrivateKeyHex;

    const out = await this.submit<{
      privateKeyIds?: string[];
      addresses?: { format?: string; address?: string }[];
    }>("create_private_keys", ACTIVITY_TYPE.CREATE_PRIVATE_KEYS, parameters, "createPrivateKeysResult");

    const privateKeyId = out.result.privateKeyIds?.[0] ?? "";
    const addresses = (out.result.addresses ?? []).map((e) => ({
      addressFormat: e.format ?? "",
      address: e.address ?? "",
    }));
    return { activityId: out.activityId, privateKeyId, addresses };
  }

  /** Sign a raw payload. Returns the r/s/v components. */
  async signRawPayload(input: SignRawPayloadInput): Promise<SignRawPayloadResult> {
    const parameters: Record<string, unknown> = {
      signWith: input.signWith,
      payload: input.payload,
      encoding: input.encoding ?? "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: input.hashFunction,
    };
    const out = await this.submit<SignRawPayloadResult>(
      "sign_raw_payload",
      ACTIVITY_TYPE.SIGN_RAW_PAYLOAD,
      parameters,
      "signRawPayloadResult",
    );
    return { r: out.result.r, s: out.result.s, v: out.result.v };
  }

  /** Sign an EVM transaction. Returns the signed transaction (hex, no 0x). */
  async signTransaction(input: SignTransactionInput): Promise<SignTransactionResult> {
    const parameters: Record<string, unknown> = {
      signWith: input.signWith,
      unsignedTransaction: input.unsignedTransaction,
      type: input.type ?? "TRANSACTION_TYPE_ETHEREUM",
    };
    const out = await this.submit<SignTransactionResult>(
      "sign_transaction",
      ACTIVITY_TYPE.SIGN_TRANSACTION,
      parameters,
      "signTransactionResult",
    );
    return { signedTransaction: out.result.signedTransaction };
  }

  /**
   * Request an HPKE-sealed export for `signWith`, sealed to `targetPublicKey`.
   * Returns the raw bundle plus the server-resolved `privateKeyId` (which the
   * signer used as the AEAD aad — needed to open the bundle). The caller owns the
   * recipient private key and the decryption. For an all-in-one path that also
   * generates the keypair and decrypts, use `exportPrivateKey`.
   */
  async exportPrivateKeyBundle(
    input: ExportPrivateKeyBundleInput,
  ): Promise<{ privateKeyId: string; exportBundle: ExportBundle }> {
    const parameters: Record<string, unknown> = {
      signWith: input.signWith,
      targetPublicKey: input.targetPublicKey,
    };
    const out = await this.submit<{ privateKeyId?: string; exportBundle?: ExportBundle }>(
      "export_private_key",
      ACTIVITY_TYPE.EXPORT_PRIVATE_KEY,
      parameters,
      "exportPrivateKeyResult",
    );
    if (!out.result.exportBundle) {
      throw new Error("export_private_key: response missing exportBundle");
    }
    return {
      privateKeyId: out.result.privateKeyId ?? input.signWith,
      exportBundle: out.result.exportBundle,
    };
  }

  /**
   * Convenience full export: generate an ephemeral P-256 recipient keypair, ask
   * the signer to seal the key to it, then HPKE-open the bundle locally and return
   * the recovered private key (hex). The recipient private-key bytes are zeroized
   * before returning.
   *
   * The signer seals with aad = the RESOLVED privateKeyId (not the caller's
   * `signWith`, which may be an address); we read that id back from the export
   * result and use it as the AEAD aad when opening.
   *
   * SECURITY: the recovered plaintext key is returned to the caller — handle it
   * with the same care as any raw private key (do not log, persist, or transmit).
   */
  async exportPrivateKey(input: ExportPrivateKeyInput): Promise<ExportedPrivateKey> {
    const recipient = await generateRecipientKeyPair();
    try {
      const { privateKeyId, exportBundle } = await this.exportPrivateKeyBundle({
        signWith: input.signWith,
        targetPublicKey: recipient.publicKeyHex,
      });
      const keyBytes = await decryptExportBundle(exportBundle, recipient.privateKey, privateKeyId);
      const hex = exportBytesToHex(keyBytes);
      keyBytes.fill(0);
      return { privateKey: hex };
    } finally {
      zeroizeRecipient(recipient);
    }
  }

  /** Re-export the bundle decryptor so callers can decrypt with a held key. */
  static decryptExportBundle = decryptExportBundle;
}

export { ActivityError };
