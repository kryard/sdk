import { describe, it, expect } from "vitest";
import { KryardClient } from "../src/wallet.js";
import { ActivityError } from "../src/activity.js";
import type { FetchFn, Stamper } from "../src/client.js";

const ORG = "org_test";

/** A stamper that records the exact body it stamped. */
function recordingStamper(seen: { body?: string }): Stamper {
  return {
    async stamp(payload: string) {
      seen.body = payload;
      return { stampHeaderName: "X-Stamp", stampHeaderValue: `s(${payload.length})` };
    },
  };
}

/** A fetch that records the request and returns a fixed activity envelope. */
function envelopeFetch(
  seen: { url?: string; body?: string; stamp?: string },
  envelope: unknown,
  status = 200,
): FetchFn {
  return async (url, init) => {
    seen.url = url;
    seen.body = init?.body as string;
    seen.stamp = (init?.headers as Record<string, string>)?.["X-Stamp"];
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return envelope;
      },
      async text() {
        return JSON.stringify(envelope);
      },
    };
  };
}

describe("KryardClient.createPrivateKey", () => {
  it("stamps the exact wire-frozen body and parses the result", async () => {
    const stamped: { body?: string } = {};
    const sent: { url?: string; body?: string; stamp?: string } = {};
    const envelope = {
      activity: {
        id: "act_1",
        status: "ACTIVITY_STATUS_COMPLETED",
        type: "ACTIVITY_TYPE_CREATE_PRIVATE_KEYS_V2",
        result: {
          createPrivateKeysResult: {
            privateKeyIds: ["pk_1"],
            addresses: [{ format: "ADDRESS_FORMAT_ETHEREUM", address: "0xabc" }],
          },
        },
        failure: null,
      },
    };
    const client = new KryardClient({
      baseUrl: "https://api.kryard.com/",
      organizationId: ORG,
      stamper: recordingStamper(stamped),
      fetchFn: envelopeFetch(sent, envelope),
      nowMs: () => 1700000000000,
    });

    const out = await client.createPrivateKey({
      name: "wallet-1",
      curve: "CURVE_SECP256K1",
      addressFormats: ["ADDRESS_FORMAT_ETHEREUM"],
    });

    // The POST hits the right submit path (trailing slash on baseUrl normalized).
    expect(sent.url).toBe("https://api.kryard.com/public/v1/submit/create_private_keys");
    // The stamped body equals the sent body, byte-for-byte (never re-serialized).
    expect(stamped.body).toBe(sent.body);
    // And it is the exact wire-frozen shape, in order.
    expect(stamped.body).toBe(
      JSON.stringify({
        type: "ACTIVITY_TYPE_CREATE_PRIVATE_KEYS_V2",
        timestampMs: "1700000000000",
        organizationId: ORG,
        parameters: {
          name: "wallet-1",
          curve: "CURVE_SECP256K1",
          addressFormats: ["ADDRESS_FORMAT_ETHEREUM"],
        },
      }),
    );
    // The stamp header was sent.
    expect(sent.stamp).toBeDefined();

    // The result is parsed off the single-nested envelope.
    expect(out.activityId).toBe("act_1");
    expect(out.privateKeyId).toBe("pk_1");
    expect(out.addresses).toEqual([{ addressFormat: "ADDRESS_FORMAT_ETHEREUM", address: "0xabc" }]);
  });

  it("omits optional params when not provided", async () => {
    const stamped: { body?: string } = {};
    const sent: { url?: string; body?: string } = {};
    const envelope = {
      activity: {
        id: "act_2",
        status: "ACTIVITY_STATUS_COMPLETED",
        result: { createPrivateKeysResult: { privateKeyIds: ["pk_2"], addresses: [] } },
        failure: null,
      },
    };
    const client = new KryardClient({
      baseUrl: "https://api.kryard.com",
      organizationId: ORG,
      stamper: recordingStamper(stamped),
      fetchFn: envelopeFetch(sent, envelope),
      nowMs: () => 1,
    });
    await client.createPrivateKey({ name: "bare" });
    expect(stamped.body).toBe(
      JSON.stringify({
        type: "ACTIVITY_TYPE_CREATE_PRIVATE_KEYS_V2",
        timestampMs: "1",
        organizationId: ORG,
        parameters: { name: "bare" },
      }),
    );
  });

  it("throws ActivityError carrying the failure code + message on FAILED", async () => {
    const envelope = {
      activity: {
        id: "act_3",
        status: "ACTIVITY_STATUS_FAILED",
        result: {},
        failure: { code: "INVALID_CURVE", message: "unsupported curve: CURVE_BOGUS" },
      },
    };
    const client = new KryardClient({
      baseUrl: "https://api.kryard.com",
      organizationId: ORG,
      stamper: recordingStamper({}),
      fetchFn: envelopeFetch({}, envelope),
      nowMs: () => 1,
    });
    await expect(client.createPrivateKey({ name: "x", curve: "CURVE_BOGUS" })).rejects.toMatchObject({
      name: "ActivityError",
      code: "INVALID_CURVE",
      status: "ACTIVITY_STATUS_FAILED",
      activityId: "act_3",
    });
  });

  it("surfaces a non-2xx Turnkey error envelope as ActivityError", async () => {
    const client = new KryardClient({
      baseUrl: "https://api.kryard.com",
      organizationId: ORG,
      stamper: recordingStamper({}),
      fetchFn: envelopeFetch({}, { message: "stamp expired" }, 401),
      nowMs: () => 1,
    });
    const err = await client.createPrivateKey({ name: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ActivityError);
    expect((err as ActivityError).message).toBe("stamp expired");
    expect((err as ActivityError).status).toBe("HTTP_401");
  });
});

describe("KryardClient.signRawPayload / signTransaction", () => {
  it("parses signRawPayloadResult r/s/v", async () => {
    const stamped: { body?: string } = {};
    const sent: { body?: string } = {};
    const envelope = {
      activity: {
        id: "act_sr",
        status: "ACTIVITY_STATUS_COMPLETED",
        result: { signRawPayloadResult: { r: "aa", s: "bb", v: "01", signerReceipt: { keyId: "pk" } } },
        failure: null,
      },
    };
    const client = new KryardClient({
      baseUrl: "https://api.kryard.com",
      organizationId: ORG,
      stamper: recordingStamper(stamped),
      fetchFn: envelopeFetch(sent, envelope),
      nowMs: () => 42,
    });
    const out = await client.signRawPayload({
      signWith: "pk_1",
      payload: "0xdeadbeef",
      hashFunction: "HASH_FUNCTION_KECCAK256",
    });
    expect(out).toEqual({ r: "aa", s: "bb", v: "01" });
    // encoding defaults to hex.
    expect(stamped.body).toBe(
      JSON.stringify({
        type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
        timestampMs: "42",
        organizationId: ORG,
        parameters: {
          signWith: "pk_1",
          payload: "0xdeadbeef",
          encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
          hashFunction: "HASH_FUNCTION_KECCAK256",
        },
      }),
    );
  });

  it("parses signTransactionResult.signedTransaction and defaults the tx type", async () => {
    const stamped: { body?: string } = {};
    const envelope = {
      activity: {
        id: "act_st",
        status: "ACTIVITY_STATUS_COMPLETED",
        result: { signTransactionResult: { signedTransaction: "02f8...beef" } },
        failure: null,
      },
    };
    const client = new KryardClient({
      baseUrl: "https://api.kryard.com",
      organizationId: ORG,
      stamper: recordingStamper(stamped),
      fetchFn: envelopeFetch({}, envelope),
      nowMs: () => 7,
    });
    const out = await client.signTransaction({ signWith: "pk_1", unsignedTransaction: "02ef..." });
    expect(out).toEqual({ signedTransaction: "02f8...beef" });
    expect(JSON.parse(stamped.body!).parameters.type).toBe("TRANSACTION_TYPE_ETHEREUM");
  });
});
