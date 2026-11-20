import { describe, it, expect, vi } from "vitest";
import { createWalletClient, http, recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  KryardX402FacilitatorClient,
  X402Error,
  X402PaymentRefusedError,
  X402SigningError,
  EIP3009_TYPED_DATA_TYPES,
  encodeX402Header,
  decodeX402Header,
  parseX402ChainId,
  createX402Paywall,
  createX402Middleware,
  createX402HonoMiddleware,
  createKryardCustodiedX402Signer,
  createViemX402Signer,
  createX402Fetch,
  type FetchFn,
  type Stamper,
  type X402PaymentPayload,
  type X402PaymentRequirements,
  type X402SettleResponse,
  type X402VerifyResponse,
  type X402HonoContext,
  type X402HttpFetch,
} from "../src/index.js";

const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SELLER_ADDR = "0x1111111111111111111111111111111111111111";
const PAYER_ADDR = "0x2222222222222222222222222222222222222222";
const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const NONCE_HEX = `0x${"ab".repeat(32)}` as Hex;

const BASE_REQ: X402PaymentRequirements = {
  scheme: "exact",
  network: "base-sepolia",
  maxAmountRequired: "10000",
  asset: USDC_BASE_SEPOLIA,
  payTo: SELLER_ADDR,
  resource: "https://api.example.com/premium",
  maxTimeoutSeconds: 120,
  extra: { name: "USDC", version: "2" },
};

const SAMPLE_PAYLOAD_V1: X402PaymentPayload = {
  x402Version: 1,
  scheme: "exact",
  network: "base-sepolia",
  payload: {
    signature: `0x${"12".repeat(65)}`,
    authorization: {
      from: PAYER_ADDR,
      to: SELLER_ADDR,
      value: "10000",
      validAfter: "1700000000",
      validBefore: "1700000300",
      nonce: NONCE_HEX,
    },
  },
};

const SAMPLE_PAYLOAD_V2: X402PaymentPayload = {
  ...SAMPLE_PAYLOAD_V1,
  x402Version: 2,
  accepted: BASE_REQ,
};

const SAMPLE_SETTLE_OK: X402SettleResponse = {
  success: true,
  transaction: `0x${"de".repeat(32)}`,
  network: "base-sepolia",
  payer: PAYER_ADDR,
};

function makeFetchRecorder(
  handler: (url: string, init?: RequestInit) => { ok: boolean; status: number; body: unknown; rawText?: string },
) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; rawBody?: string; body?: unknown }> = [];
  const fetchFn: FetchFn = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      rawBody,
      body: rawBody ? JSON.parse(rawBody) : undefined,
    });
    const res = handler(url, init);
    return {
      ok: res.ok,
      status: res.status,
      json: async () => res.body,
      text: async () => res.rawText ?? JSON.stringify(res.body),
    };
  };
  return { fetchFn, calls };
}

describe("parseX402ChainId", () => {
  it("parses CAIP-2 eip155, decimal strings, and standard network labels", () => {
    expect(parseX402ChainId("eip155:84532")).toBe(84532);
    expect(parseX402ChainId("EIP155:1")).toBe(1);
    expect(parseX402ChainId("84532")).toBe(84532);
    expect(parseX402ChainId("1")).toBe(1);
    expect(parseX402ChainId("base")).toBe(8453);
    expect(parseX402ChainId("base-sepolia")).toBe(84532);
    expect(parseX402ChainId("ethereum")).toBe(1);
    expect(parseX402ChainId("sepolia")).toBe(11155111);
    expect(parseX402ChainId("ethereum-sepolia")).toBe(11155111);
    expect(parseX402ChainId("arbitrum")).toBe(42161);
    expect(parseX402ChainId("arbitrum-sepolia")).toBe(421614);
    expect(parseX402ChainId("optimism")).toBe(10);
    expect(parseX402ChainId("optimism-sepolia")).toBe(11155420);
    expect(parseX402ChainId("polygon")).toBe(137);
    expect(parseX402ChainId("polygon-amoy")).toBe(80002);
    expect(parseX402ChainId("  Base-Sepolia ")).toBe(84532);
  });

  it("rejects unknown, non-EVM, zero, or malformed chain inputs", () => {
    for (const bad of ["", "   ", "0", "-1", "eip155:0", "eip155:abc", "eip155:", "solana:mainnet", "unknown-chain"]) {
      expect(() => parseX402ChainId(bad)).toThrow(X402Error);
    }
  });
});

describe("encodeX402Header / decodeX402Header", () => {
  it("round-trips ASCII and multi-byte UTF-8 payloads cleanly without Buffer", () => {
    const data = { note: "café ☕ 日本語 🚀", amount: "10000", nested: [1, true, null] };
    const encoded = encodeX402Header(data);
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(decodeX402Header<typeof data>(encoded)).toEqual(data);
  });

  it("decodes unpadded base64url strings and rejects malformed headers", () => {
    const standard = encodeX402Header({ hello: "world!" });
    const urlSafe = standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(decodeX402Header<{ hello: string }>(urlSafe)).toEqual({ hello: "world!" });

    expect(() => decodeX402Header("")).toThrow(X402Error);
    expect(() => decodeX402Header("!!!not-base64!!!")).toThrow(X402Error);
    expect(() => decodeX402Header(btoa("not-json"))).toThrow(X402Error);
    expect(() => encodeX402Header(undefined)).toThrow(X402Error);
  });
});

describe("KryardX402FacilitatorClient", () => {
  it("defaults to https://api.kryard.com and version 1", async () => {
    const { fetchFn, calls } = makeFetchRecorder((url) => {
      if (url.endsWith("/supported")) {
        return {
          ok: true,
          status: 200,
          body: {
            kinds: [{ x402Version: 1, scheme: "exact", network: "base-sepolia" }],
            signers: { "eip155:*": [SELLER_ADDR] },
          },
        };
      }
      if (url.endsWith("/verify")) {
        return { ok: true, status: 200, body: { isValid: true, payer: PAYER_ADDR } };
      }
      return { ok: true, status: 200, body: SAMPLE_SETTLE_OK };
    });

    const client = new KryardX402FacilitatorClient({ fetch: fetchFn });
    const supported = await client.supported();
    expect(supported.kinds).toHaveLength(1);
    expect(supported.signers?.["eip155:*"]).toEqual([SELLER_ADDR]);

    const verified = await client.verify(SAMPLE_PAYLOAD_V1, BASE_REQ);
    expect(verified).toEqual({ isValid: true, payer: PAYER_ADDR });

    const settled = await client.settle(SAMPLE_PAYLOAD_V1, BASE_REQ);
    expect(settled).toEqual(SAMPLE_SETTLE_OK);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.kryard.com/x402/v1/supported",
      "POST https://api.kryard.com/x402/v1/verify",
      "POST https://api.kryard.com/x402/v1/settle",
    ]);
    expect(calls[1]!.body).toEqual({
      x402Version: 1,
      paymentPayload: SAMPLE_PAYLOAD_V1,
      paymentRequirements: BASE_REQ,
    });
    expect(calls[2]!.body).toEqual({
      x402Version: 1,
      paymentPayload: SAMPLE_PAYLOAD_V1,
      paymentRequirements: BASE_REQ,
    });
  });

  it("supports /x402/v2 endpoints and trims trailing baseUrl slashes", async () => {
    const { fetchFn, calls } = makeFetchRecorder((url) => {
      if (url.endsWith("/supported")) {
        return {
          ok: true,
          status: 200,
          body: { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }] },
        };
      }
      if (url.endsWith("/verify")) {
        return { ok: true, status: 200, body: { isValid: true, payer: PAYER_ADDR } };
      }
      return { ok: true, status: 200, body: SAMPLE_SETTLE_OK };
    });

    const client = new KryardX402FacilitatorClient({
      baseUrl: "https://sandbox.kryard.com///",
      version: 2,
      fetch: fetchFn,
    });
    await client.supported();
    await client.verify(SAMPLE_PAYLOAD_V2, BASE_REQ);
    await client.settle(SAMPLE_PAYLOAD_V2, BASE_REQ);

    expect(calls.map((c) => c.url)).toEqual([
      "https://sandbox.kryard.com/x402/v2/supported",
      "https://sandbox.kryard.com/x402/v2/verify",
      "https://sandbox.kryard.com/x402/v2/settle",
    ]);
    expect(calls[1]!.body).toMatchObject({ x402Version: 2 });
  });

  it("returns structured x402 verify/settle wire denials and throws X402Error on HTTP failures", async () => {
    const { fetchFn } = makeFetchRecorder((url) => {
      if (url.includes("/verify")) {
        return {
          ok: false,
          status: 429,
          body: { isValid: false, invalidReason: "x402_rate_limited", payer: "" },
        };
      }
      if (url.includes("/settle")) {
        return { ok: false, status: 502, body: {}, rawText: "Bad Gateway" };
      }
      return { ok: false, status: 500, body: { message: "db offline" } };
    });

    const client = new KryardX402FacilitatorClient({ fetch: fetchFn });
    const verifyRes = await client.verify(SAMPLE_PAYLOAD_V1, BASE_REQ);
    expect(verifyRes).toEqual({ isValid: false, invalidReason: "x402_rate_limited", payer: "" });

    await expect(client.settle(SAMPLE_PAYLOAD_V1, BASE_REQ)).rejects.toThrow(X402Error);
    await expect(client.supported()).rejects.toThrow(/500.*db offline/);
  });
});

describe("createX402Paywall / createX402Middleware / createX402HonoMiddleware", () => {
  function mockFacilitator(overrides?: {
    verify?: (p: X402PaymentPayload, r: X402PaymentRequirements) => Promise<X402VerifyResponse>;
    settle?: (p: X402PaymentPayload, r: X402PaymentRequirements) => Promise<X402SettleResponse>;
  }) {
    const verify = vi.fn(
      overrides?.verify ?? (async () => ({ isValid: true, payer: PAYER_ADDR })),
    );
    const settle = vi.fn(
      overrides?.settle ?? (async () => SAMPLE_SETTLE_OK),
    );
    return { verify, settle };
  }

  it("emits 402 JSON + PAYMENT-REQUIRED header when supporting v2, and omits PAYMENT-REQUIRED in v1-only mode", async () => {
    const fac = mockFacilitator();
    const dualPaywall = createX402Paywall({ accepts: [BASE_REQ], facilitator: fac });

    const missing = await dualPaywall(new Request("https://api.example.com/premium"));
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.response.status).toBe(402);
      const body = (await missing.response.json()) as { x402Version: number; accepts: X402PaymentRequirements[] };
      expect(body).toEqual({ x402Version: 2, accepts: [BASE_REQ] });
      const header = missing.response.headers.get("PAYMENT-REQUIRED");
      expect(header).toBeTruthy();
      expect(decodeX402Header(header!)).toEqual({ x402Version: 2, accepts: [BASE_REQ] });
    }

    const v1Paywall = createX402Paywall({ accepts: [BASE_REQ], facilitator: fac, x402Version: 1 });
    const v1Missing = await v1Paywall.check(new Request("https://api.example.com/premium"));
    expect(v1Missing.ok).toBe(false);
    if (!v1Missing.ok) {
      expect(v1Missing.response.status).toBe(402);
      expect(v1Missing.response.headers.get("PAYMENT-REQUIRED")).toBeNull();
      expect(await v1Missing.response.json()).toEqual({ x402Version: 1, accepts: [BASE_REQ] });
    }
    // v1-only paywall rejects v2 PAYMENT-SIGNATURE; v2-only paywall rejects v1 X-PAYMENT
    const v1RejectsV2 = await v1Paywall.check(
      new Request("https://api.example.com/premium", {
        headers: { "PAYMENT-SIGNATURE": encodeX402Header(SAMPLE_PAYLOAD_V2) },
      }),
    );
    expect(v1RejectsV2.ok).toBe(false);
    const v2Paywall = createX402Paywall({ accepts: [BASE_REQ], facilitator: fac, x402Version: 2 });
    const v2RejectsV1 = await v2Paywall.check(
      new Request("https://api.example.com/premium", {
        headers: { "X-PAYMENT": encodeX402Header(SAMPLE_PAYLOAD_V1) },
      }),
    );
    expect(v2RejectsV1.ok).toBe(false);
    expect(fac.verify).not.toHaveBeenCalled();
  });

  it("rejects tampered v2 accepted requirements before calling verify", async () => {
    const fac = mockFacilitator();
    const paywall = createX402Paywall({ accepts: [BASE_REQ], facilitator: fac });
    const tampered: X402PaymentPayload = {
      ...SAMPLE_PAYLOAD_V2,
      accepted: { ...BASE_REQ, maxAmountRequired: "1" },
    };

    const res = await paywall.check(
      new Request("https://api.example.com/premium", {
        headers: { "PAYMENT-SIGNATURE": encodeX402Header(tampered) },
      }),
    );
    expect(res.ok).toBe(false);
    expect(fac.verify).not.toHaveBeenCalled();
  });

  it("accepts v1 X-PAYMENT and v2 PAYMENT-SIGNATURE and applies appropriate response headers", async () => {
    const fac = mockFacilitator();
    const paywall = createX402Paywall({ accepts: [BASE_REQ], facilitator: fac });

    const v1Check = await paywall.check(
      new Request("https://api.example.com/premium", {
        headers: { "X-PAYMENT": encodeX402Header(SAMPLE_PAYLOAD_V1) },
      }),
    );
    expect(v1Check.ok).toBe(true);
    if (v1Check.ok) {
      expect(v1Check.versionUsed).toBe(1);
      expect(v1Check.payer).toBe(PAYER_ADDR);
      const settled = await v1Check.settle();
      const out = settled.applyHeaders(Response.json({ ok: true }));
      expect(out.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();
      expect(out.headers.get("PAYMENT-RESPONSE")).toBeNull();
      expect(decodeX402Header(out.headers.get("X-PAYMENT-RESPONSE")!)).toEqual(SAMPLE_SETTLE_OK);
    }

    const v2Check = await paywall.check(
      new Request("https://api.example.com/premium", {
        headers: { "PAYMENT-SIGNATURE": encodeX402Header(SAMPLE_PAYLOAD_V2) },
      }),
    );
    expect(v2Check.ok).toBe(true);
    if (v2Check.ok) {
      expect(v2Check.versionUsed).toBe(2);
      const settled = await v2Check.settle();
      const out = settled.applyHeaders(Response.json({ ok: true }));
      expect(out.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();
      expect(out.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
      expect(decodeX402Header(out.headers.get("PAYMENT-RESPONSE")!)).toEqual(SAMPLE_SETTLE_OK);
    }
  });

  it("createX402Middleware verifies before handler, NEVER settles on non-2xx, and settles on 2xx", async () => {
    const fac = mockFacilitator();
    const mw = createX402Middleware({ accepts: [BASE_REQ], facilitator: fac });
    const handlerCalls: string[] = [];

    // Missing header -> 402, handler NOT called
    const unauth = await mw(new Request("https://api.example.com/paid"), async () => {
      handlerCalls.push("should-not-run");
      return Response.json({ ok: true });
    });
    expect(unauth.status).toBe(402);
    expect(handlerCalls).toEqual([]);
    expect(fac.settle).not.toHaveBeenCalled();

    // Handler returns 500 -> verify called, settle NEVER called
    const errRes = await mw(
      new Request("https://api.example.com/paid", {
        headers: { "PAYMENT-SIGNATURE": encodeX402Header(SAMPLE_PAYLOAD_V2) },
      }),
      async (ctx) => {
        handlerCalls.push(ctx.payer);
        return new Response("upstream failure", { status: 500 });
      },
    );
    expect(errRes.status).toBe(500);
    expect(handlerCalls).toEqual([PAYER_ADDR]);
    expect(fac.verify).toHaveBeenCalledTimes(1);
    expect(fac.settle).not.toHaveBeenCalled();

    // Handler returns 200 -> settled + both response headers attached
    const okRes = await mw(
      new Request("https://api.example.com/paid", {
        headers: { "PAYMENT-SIGNATURE": encodeX402Header(SAMPLE_PAYLOAD_V2) },
      }),
      async () => Response.json({ data: 42 }),
    );
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ data: 42 });
    expect(fac.settle).toHaveBeenCalledTimes(1);
    expect(decodeX402Header(okRes.headers.get("X-PAYMENT-RESPONSE")!)).toEqual(SAMPLE_SETTLE_OK);
    expect(decodeX402Header(okRes.headers.get("PAYMENT-RESPONSE")!)).toEqual(SAMPLE_SETTLE_OK);
  });

  it("createX402Middleware returns 402 if settle returns success: false", async () => {
    const fac = mockFacilitator({
      settle: async () => ({
        success: false,
        errorReason: "x402_daily_gas_cap_exceeded",
        transaction: "",
        network: "base-sepolia",
        payer: PAYER_ADDR,
      }),
    });
    const mw = createX402Middleware({ accepts: [BASE_REQ], facilitator: fac });
    const res = await mw(
      new Request("https://api.example.com/paid", {
        headers: { "PAYMENT-SIGNATURE": encodeX402Header(SAMPLE_PAYLOAD_V2) },
      }),
      async () => Response.json({ ok: true }),
    );
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("x402_daily_gas_cap_exceeded");
  });

  it("createX402HonoMiddleware settles on 2xx via c.header, skips non-2xx, and returns 402 on settle failure", async () => {
    const fac = mockFacilitator();
    const honoMw = createX402HonoMiddleware({ accepts: [BASE_REQ], facilitator: fac });

    // Missing payment -> short-circuits without calling next()
    const nextMissing = vi.fn(async () => {});
    const headersMap1 = new Map<string, string>();
    const c1: X402HonoContext = {
      req: { raw: new Request("https://api.example.com/hono") },
      header: (k, v) => headersMap1.set(k, v),
    };
    const r1 = await honoMw(c1, nextMissing);
    expect(nextMissing).not.toHaveBeenCalled();
    expect(r1?.status).toBe(402);
    expect(c1.res?.status).toBe(402);

    // Handler sets 404 -> next() runs, settle NOT called
    const headersMap2 = new Map<string, string>();
    const c2: X402HonoContext = {
      req: {
        raw: new Request("https://api.example.com/hono", {
          headers: { "PAYMENT-SIGNATURE": encodeX402Header(SAMPLE_PAYLOAD_V2) },
        }),
      },
      header: (k, v) => headersMap2.set(k, v),
    };
    await honoMw(c2, async () => {
      c2.res = new Response("not found", { status: 404 });
    });
    expect(fac.settle).not.toHaveBeenCalled();
    expect(headersMap2.size).toBe(0);

    // Handler sets 201 -> settles + sets both X-PAYMENT-RESPONSE and PAYMENT-RESPONSE
    const headersMap3 = new Map<string, string>();
    const c3: X402HonoContext = {
      req: {
        raw: new Request("https://api.example.com/hono", {
          headers: { "PAYMENT-SIGNATURE": encodeX402Header(SAMPLE_PAYLOAD_V2) },
        }),
      },
      header: (k, v) => headersMap3.set(k, v),
    };
    await honoMw(c3, async () => {
      c3.res = Response.json({ created: true }, { status: 201 });
    });
    expect(fac.settle).toHaveBeenCalledTimes(1);
    expect(decodeX402Header(headersMap3.get("X-PAYMENT-RESPONSE")!)).toEqual(SAMPLE_SETTLE_OK);
    expect(decodeX402Header(headersMap3.get("PAYMENT-RESPONSE")!)).toEqual(SAMPLE_SETTLE_OK);

    // Settlement failure -> returns 402 and sets c.res to 402
    const failingFac = mockFacilitator({
      settle: async () => ({
        success: false,
        errorReason: "insufficient_balance",
        transaction: "",
        network: "base-sepolia",
        payer: PAYER_ADDR,
      }),
    });
    const failingMw = createX402HonoMiddleware({ accepts: [BASE_REQ], facilitator: failingFac });
    const c4: X402HonoContext = {
      req: {
        raw: new Request("https://api.example.com/hono", {
          headers: { "X-PAYMENT": encodeX402Header(SAMPLE_PAYLOAD_V1) },
        }),
      },
      header: () => {},
    };
    const r4 = await failingMw(c4, async () => {
      c4.res = Response.json({ ok: true }, { status: 200 });
    });
    expect(r4?.status).toBe(402);
    expect(c4.res?.status).toBe(402);
    expect((await r4!.json() as { error?: string }).error).toBe("insufficient_balance");
  });
});

describe("createKryardCustodiedX402Signer", () => {
  const stamper: Stamper = {
    async stamp(payload: string) {
      return { stampHeaderName: "X-Stamp", stampHeaderValue: `sig:${payload.length}` };
    },
  };

  it("calls sign_eip3009_authorization with X-Stamp, parses activity result, and attaches accepted for v2", async () => {
    const { fetchFn, calls } = makeFetchRecorder(() => ({
      ok: true,
      status: 200,
      body: {
        activity: {
          id: "act_1",
          status: "ACTIVITY_STATUS_COMPLETED",
          result: {
            signEip3009AuthorizationResult: {
              walletAddress: PAYER_ADDR,
              chainId: "84532",
              tokenAddress: USDC_BASE_SEPOLIA,
              tokenName: "USDC",
              tokenVersion: "2",
              digest: `0x${"aa".repeat(32)}`,
              signature: `0x${"bb".repeat(65)}`,
              authorization: {
                from: PAYER_ADDR,
                to: SELLER_ADDR,
                value: "10000",
                validAfter: "1699999940",
                validBefore: "1700000120",
                nonce: NONCE_HEX,
              },
              paymentPayload: {
                x402Version: 1,
                scheme: "exact",
                network: "base-sepolia",
                payload: {
                  signature: `0x${"bb".repeat(65)}`,
                  authorization: {
                    from: PAYER_ADDR,
                    to: SELLER_ADDR,
                    value: "10000",
                    validAfter: "1699999940",
                    validBefore: "1700000120",
                    nonce: NONCE_HEX,
                  },
                },
              },
            },
          },
        },
      },
    }));

    const signer = createKryardCustodiedX402Signer({
      baseUrl: "https://api.kryard.com/",
      organizationId: "11111111-1111-4111-8111-111111111111",
      signWith: "pk_custodied_1",
      stamper,
      fetch: fetchFn,
      nowMs: () => 1_700_000_000_000,
      generateNonce: () => NONCE_HEX,
    });

    const v1Payload = await signer.signPayment(BASE_REQ, { x402Version: 1 });
    expect(v1Payload.x402Version).toBe(1);
    expect(v1Payload.accepted).toBeUndefined();
    expect(calls[0]!.url).toBe("https://api.kryard.com/public/v1/submit/sign_eip3009_authorization");
    expect(calls[0]!.headers["x-stamp"]).toBe(`sig:${calls[0]!.rawBody!.length}`);
    expect(calls[0]!.body).toEqual({
      type: "ACTIVITY_TYPE_SIGN_EIP3009_AUTHORIZATION",
      organizationId: "11111111-1111-4111-8111-111111111111",
      timestampMs: "1700000000000",
      parameters: {
        signWith: "pk_custodied_1",
        chainId: "84532",
        tokenAddress: USDC_BASE_SEPOLIA,
        tokenName: "USDC",
        tokenVersion: "2",
        to: SELLER_ADDR,
        value: "10000",
        validAfter: "1699999940",
        validBefore: "1700000120",
        nonce: NONCE_HEX,
        network: "base-sepolia",
        x402Version: 1,
      },
    });

    const v2Req: X402PaymentRequirements = {
      ...BASE_REQ,
      network: "eip155:84532",
      amount: "25000",
      maxAmountRequired: undefined,
    };
    const v2Payload = await signer.signPayment(v2Req, { x402Version: 2 });
    expect(v2Payload.x402Version).toBe(2);
    expect(v2Payload.accepted).toEqual(v2Req);
    expect((calls[1]!.body as { parameters: Record<string, unknown> }).parameters).toMatchObject({
      chainId: "84532",
      value: "25000",
      network: "eip155:84532",
      x402Version: 2,
    });
  });

  it("throws X402SigningError with code and activityStatus on HTTP failure or failed activity", async () => {
    const httpErrFetch = makeFetchRecorder(() => ({
      ok: false,
      status: 403,
      body: { code: 7, message: "policy denied recipient" },
    })).fetchFn;

    const signerHttpFail = createKryardCustodiedX402Signer({
      organizationId: "org-1",
      signWith: "pk-1",
      stamper,
      fetch: httpErrFetch,
    });

    const err1 = await signerHttpFail.signPayment(BASE_REQ).catch((e) => e);
    expect(err1).toBeInstanceOf(X402SigningError);
    expect((err1 as X402SigningError).status).toBe(403);
    expect((err1 as X402SigningError).code).toBe("7");

    const actErrFetch = makeFetchRecorder(() => ({
      ok: true,
      status: 200,
      body: {
        activity: {
          id: "act_fail",
          status: "ACTIVITY_STATUS_FAILED",
          failure: { code: "POLICY_REJECTED", message: "recipient not allowlisted" },
        },
      },
    })).fetchFn;

    const signerActFail = createKryardCustodiedX402Signer({
      organizationId: "org-1",
      signWith: "pk-1",
      stamper,
      fetch: actErrFetch,
    });

    const err2 = await signerActFail.signPayment(BASE_REQ).catch((e) => e);
    expect(err2).toBeInstanceOf(X402SigningError);
    expect((err2 as X402SigningError).activityStatus).toBe("ACTIVITY_STATUS_FAILED");
    expect((err2 as X402SigningError).code).toBe("POLICY_REJECTED");
    expect((err2 as X402SigningError).activityId).toBe("act_fail");
  });
});

describe("createViemX402Signer", () => {
  it("produces a valid EIP-712 TransferWithAuthorization signature verifiable by recoverTypedDataAddress", async () => {
    const account = privateKeyToAccount(TEST_PK);
    const walletClient = createWalletClient({
      account,
      transport: http("http://localhost:8545"),
    });

    const signer = createViemX402Signer({
      account,
      signTypedData: walletClient.signTypedData,
      ttlSeconds: 180,
      nowSeconds: () => 1_700_000_000,
      generateNonce: () => NONCE_HEX,
    });

    expect(signer.address).toBe(account.address);

    const payloadV2 = await signer.signPayment(BASE_REQ, { x402Version: 2 });
    expect(payloadV2.x402Version).toBe(2);
    expect(payloadV2.accepted).toEqual(BASE_REQ);
    expect(payloadV2.payload.authorization).toEqual({
      from: account.address,
      to: SELLER_ADDR,
      value: "10000",
      validAfter: "1699999940",
      validBefore: "1700000180",
      nonce: NONCE_HEX,
    });

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: "USDC",
        version: "2",
        chainId: 84532,
        verifyingContract: USDC_BASE_SEPOLIA as Hex,
      },
      types: EIP3009_TYPED_DATA_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: account.address,
        to: SELLER_ADDR as Hex,
        value: 10000n,
        validAfter: 1699999940n,
        validBefore: 1700000180n,
        nonce: NONCE_HEX,
      },
      signature: payloadV2.payload.signature as Hex,
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("throws X402SigningError when EIP-712 domain extra metadata is missing", async () => {
    const account = privateKeyToAccount(TEST_PK);
    const unhoistedWalletClient = createWalletClient({
      transport: http("http://localhost:8545"),
    });
    const signerWithUnhoistedClient = createViemX402Signer({
      account,
      signTypedData: unhoistedWalletClient.signTypedData,
    });
    expect(signerWithUnhoistedClient.address).toBe(account.address);

    const signer = createViemX402Signer({
      account: account.address,
      signTypedData: async (params) => account.signTypedData(params),
    });
    await expect(
      signer.signPayment({ ...BASE_REQ, extra: undefined }),
    ).rejects.toThrow(X402SigningError);
  });
});

describe("createX402Fetch & end-to-end buyer/seller loop", () => {
  it("passes non-402 responses through untouched and selects the first allowed requirement from multi-accepts", async () => {
    const signPayment = vi.fn(async (req: X402PaymentRequirements) => ({
      ...SAMPLE_PAYLOAD_V2,
      network: req.network,
      accepted: req,
    }));
    const passFetch: X402HttpFetch = vi.fn(async () => Response.json({ ok: true }, { status: 200 }));
    const passClient = createX402Fetch({ signer: { signPayment }, fetch: passFetch });
    const passRes = await passClient("https://api.example.com/free");
    expect(passRes.status).toBe(200);
    expect(signPayment).not.toHaveBeenCalled();

    const expensiveMainnetReq: X402PaymentRequirements = {
      ...BASE_REQ,
      network: "base",
      maxAmountRequired: "999999",
    };
    let callCount = 0;
    const multiAcceptFetch: X402HttpFetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({ x402Version: 2, accepts: [expensiveMainnetReq, BASE_REQ] }),
          {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": encodeX402Header({
                x402Version: 2,
                accepts: [expensiveMainnetReq, BASE_REQ],
              }),
            },
          },
        );
      }
      return Response.json({ paid: true });
    };

    const pickyClient = createX402Fetch({
      signer: { signPayment },
      fetch: multiAcceptFetch,
      allowedNetworks: ["base-sepolia"],
      maxAmountPerCall: "20000",
    });
    const paidRes = await pickyClient("https://api.example.com/multi");
    expect(paidRes.status).toBe(200);
    expect(signPayment).toHaveBeenCalledWith(BASE_REQ, { x402Version: 2 });
  });
  it("enforces maxAmountPerCall, allowedNetworks, allowedAssets, and allowedPayTo BEFORE signing", async () => {
    const signPayment = vi.fn(async () => SAMPLE_PAYLOAD_V2);
    const challenge402 = () =>
      new Response(JSON.stringify({ x402Version: 2, accepts: [BASE_REQ] }), {
        status: 402,
        headers: {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": encodeX402Header({ x402Version: 2, accepts: [BASE_REQ] }),
        },
      });
    const baseFetch: X402HttpFetch = vi.fn(async () => challenge402());

    // Cap exceeded
    const cappedFetch = createX402Fetch({
      signer: { signPayment },
      fetch: baseFetch,
      maxAmountPerCall: "9999",
    });
    await expect(cappedFetch("https://api.example.com/paid")).rejects.toThrow(X402PaymentRefusedError);

    // Network not allowed
    const netFetch = createX402Fetch({
      signer: { signPayment },
      fetch: baseFetch,
      allowedNetworks: ["base"],
    });
    await expect(netFetch("https://api.example.com/paid")).rejects.toThrow(X402PaymentRefusedError);

    // Asset not allowed
    const assetFetch = createX402Fetch({
      signer: { signPayment },
      fetch: baseFetch,
      allowedAssets: ["0x9999999999999999999999999999999999999999"],
    });
    await expect(assetFetch("https://api.example.com/paid")).rejects.toThrow(X402PaymentRefusedError);

    // Recipient not allowed
    const payToFetch = createX402Fetch({
      signer: { signPayment },
      fetch: baseFetch,
      allowedPayTo: ["0x9999999999999999999999999999999999999999"],
    });
    await expect(payToFetch("https://api.example.com/paid")).rejects.toThrow(X402PaymentRefusedError);

    expect(signPayment).not.toHaveBeenCalled();
  });

  it("retries at most once, honors preferredVersion, preserves Request body, and fires onPaymentSettled", async () => {
    const signPayment = vi.fn(async (req, opts) => ({
      ...SAMPLE_PAYLOAD_V1,
      x402Version: opts?.x402Version ?? 1,
      network: req.network,
    }));

    // Always 402 -> retries at most ONCE (2 total fetch calls)
    const always402: X402HttpFetch = vi.fn(async () =>
      new Response(JSON.stringify({ x402Version: 1, accepts: [BASE_REQ] }), { status: 402 }),
    );
    const limitedFetch = createX402Fetch({
      signer: { signPayment },
      fetch: always402,
      allowedNetworks: ["eip155:84532"], // matches base-sepolia via chainId!
      allowedAssets: [USDC_BASE_SEPOLIA.toLowerCase()],
      allowedPayTo: [SELLER_ADDR],
      maxAmountPerCall: 10000n,
    });
    const final402 = await limitedFetch(
      new Request("https://api.example.com/post", { method: "POST", body: '{"q":1}' }),
    );
    expect(final402.status).toBe(402);
    expect(always402).toHaveBeenCalledTimes(2);
    expect(signPayment).toHaveBeenCalledTimes(1);

    // Dual-stack challenge + preferredVersion: 1 -> sends X-PAYMENT + triggers onPaymentSettled
    const seenHeaders: Array<{ sig: string | null; xPay: string | null; bodyText: string }> = [];
    const serverFetch: X402HttpFetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const sig = req.headers.get("PAYMENT-SIGNATURE");
      const xPay = req.headers.get("X-PAYMENT");
      const bodyText = await req.text();
      seenHeaders.push({ sig, xPay, bodyText });
      if (!xPay) {
        return new Response(JSON.stringify({ x402Version: 2, accepts: [BASE_REQ] }), {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": encodeX402Header({ x402Version: 2, accepts: [BASE_REQ] }),
          },
        });
      }
      return Response.json(
        { unlocked: true },
        { headers: { "X-PAYMENT-RESPONSE": encodeX402Header(SAMPLE_SETTLE_OK) } },
      );
    };

    const settledEvents: X402SettleResponse[] = [];
    const autoFetch = createX402Fetch({
      signer: { signPayment },
      fetch: serverFetch,
      preferredVersion: 1,
      onPaymentSettled: (settle) => {
        settledEvents.push(settle);
      },
    });
    const okRes = await autoFetch(
      new Request("https://api.example.com/post", { method: "POST", body: '{"q":1}' }),
    );
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ unlocked: true });
    expect(seenHeaders[1]!.xPay).toBeTruthy();
    expect(seenHeaders[1]!.sig).toBeNull();
    expect(seenHeaders[1]!.bodyText).toBe('{"q":1}');
    expect(settledEvents).toEqual([SAMPLE_SETTLE_OK]);
  });

  it("completes full end-to-end buyer (viem signer + x402Fetch) -> seller (x402Middleware) -> facilitator flow", async () => {
    const account = privateKeyToAccount(TEST_PK);

    // Facilitator verifies the real EIP-712 signature using viem!
    const facFetch = makeFetchRecorder(() => ({ ok: true, status: 200, body: {} }));
    const facilitator = new KryardX402FacilitatorClient({
      baseUrl: "https://api.kryard.com",
      version: 2,
      fetch: async (url, init) => {
        const body = JSON.parse(init!.body as string) as {
          paymentPayload: X402PaymentPayload;
          paymentRequirements: X402PaymentRequirements;
        };
        if (url.endsWith("/x402/v2/verify")) {
          const auth = body.paymentPayload.payload.authorization;
          const recovered = await recoverTypedDataAddress({
            domain: {
              name: body.paymentRequirements.extra!.name!,
              version: body.paymentRequirements.extra!.version!,
              chainId: parseX402ChainId(body.paymentRequirements.network),
              verifyingContract: body.paymentRequirements.asset as Hex,
            },
            types: EIP3009_TYPED_DATA_TYPES,
            primaryType: "TransferWithAuthorization",
            message: {
              from: auth.from as Hex,
              to: auth.to as Hex,
              value: BigInt(auth.value),
              validAfter: BigInt(auth.validAfter),
              validBefore: BigInt(auth.validBefore),
              nonce: auth.nonce as Hex,
            },
            signature: body.paymentPayload.payload.signature as Hex,
          });
          return {
            ok: true,
            status: 200,
            json: async () => ({ isValid: recovered.toLowerCase() === auth.from.toLowerCase(), payer: recovered }),
            text: async () => JSON.stringify({ isValid: true, payer: recovered }),
          };
        }
        return facFetch.fetchFn(url, init);
      },
    });
    // Override settle response on facilitator mock:
    const settleSpy = vi.spyOn(facilitator, "settle").mockResolvedValue({
      success: true,
      transaction: `0x${"ff".repeat(32)}`,
      network: "base-sepolia",
      payer: account.address,
    });

    const sellerMiddleware = createX402Middleware({
      accepts: [BASE_REQ],
      facilitator,
    });

    const sellerHttp: X402HttpFetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return sellerMiddleware(req, async (ctx) =>
        Response.json({ paidBy: ctx.payer, secret: "l3-kryard-x402" }),
      );
    };

    const buyerSigner = createViemX402Signer({
      account,
      signTypedData: (params) => account.signTypedData(params),
    });

    const receipts: Array<{ tx: string; versionUsed: number }> = [];
    const x402Fetch = createX402Fetch({
      signer: buyerSigner,
      fetch: sellerHttp,
      maxAmountPerCall: "50000",
      allowedNetworks: ["base-sepolia"],
      allowedAssets: [USDC_BASE_SEPOLIA],
      allowedPayTo: [SELLER_ADDR],
      onPaymentSettled: (settle, info) => {
        receipts.push({ tx: settle.transaction, versionUsed: info.versionUsed });
      },
    });

    const res = await x402Fetch("https://api.example.com/premium");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paidBy: account.address, secret: "l3-kryard-x402" });
    expect(settleSpy).toHaveBeenCalledTimes(1);
    expect(receipts).toEqual([{ tx: `0x${"ff".repeat(32)}`, versionUsed: 2 }]);
  });
});
