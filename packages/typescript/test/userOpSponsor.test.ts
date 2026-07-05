import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import {
  KryardPaymasterClient,
  SponsorshipDeniedError,
  buildPaymasterAndData,
  splitPaymasterAndData,
  applyPaymasterAndData,
  type UserOperationV07,
  type SponsorshipReasonCode,
} from "../src/userOpSponsor.js";
import type { FetchFn } from "../src/client.js";

const PAYMASTER = "0x011e7B4853Db8419E4dBBb7ed4BAbEE62B33f70A" as Hex;
const USER_OP: UserOperationV07 = {
  sender: "0x000000000000000000000000000000000000bEEF" as Hex,
  nonce: 7n,
  initCode: "0x",
  callData: "0xdeadbeef" as Hex,
  accountGasLimits: ("0x" + "00".repeat(16) + "0000000000000000000000000000c350") as Hex, // callGasLimit 50000
  preVerificationGas: 21000n,
  gasFees: ("0x" + "00".repeat(16) + "0000000000000000000000000000000a") as Hex, // maxFeePerGas 10
  paymasterVerificationGasLimit: 100_000n,
  paymasterPostOpGasLimit: 50_000n,
};

const stamper = {
  async stamp(p: string) {
    return { stampHeaderName: "X-Stamp", stampHeaderValue: `s(${p.length})` };
  },
};

/** Build a client whose fetch records the request and returns a canned response. */
function makeClient(
  respond: (init: RequestInit) => { ok: boolean; status: number; json: unknown; text: string },
  sink?: { url?: string; init?: RequestInit; body?: any },
): KryardPaymasterClient {
  const fetchFn: FetchFn = async (url, init) => {
    if (sink) {
      sink.url = url;
      sink.init = init;
      sink.body = JSON.parse(init!.body as string);
    }
    const r = respond(init!);
    return { ok: r.ok, status: r.status, async json() { return r.json; }, async text() { return r.text; } };
  };
  return new KryardPaymasterClient({
    baseUrl: "https://api.kryard.com/",
    organizationId: "org_1",
    stamper,
    fetchFn,
    nowMs: () => 1_700_000_000_000,
  });
}

describe("KryardPaymasterClient — constructor", () => {
  it("requires baseUrl, organizationId, and stamper", () => {
    expect(() => new KryardPaymasterClient({ baseUrl: "", organizationId: "o", stamper } as any)).toThrow(/baseUrl/);
    expect(() => new KryardPaymasterClient({ baseUrl: "u", organizationId: "", stamper } as any)).toThrow(/organizationId/);
    expect(() => new KryardPaymasterClient({ baseUrl: "u", organizationId: "o", stamper: undefined } as any)).toThrow(/stamper/);
  });
});

describe("KryardPaymasterClient.sponsorUserOperation — request shape", () => {
  it("posts to the sponsor endpoint with the X-Stamp header and a well-formed body", async () => {
    const sink: { url?: string; init?: RequestInit; body?: any } = {};
    const client = makeClient(
      () => ({ ok: true, status: 200, json: { paymasterAndData: "0xabcd", userOpHash: "0x01", validUntil: 100, validAfter: 5 }, text: "" }),
      sink,
    );

    await client.sponsorUserOperation(USER_OP, { chainId: 11155111, validUntilSec: 100, validAfterSec: 5 });

    expect(sink.url).toBe("https://api.kryard.com/public/v1/relay/sponsor_user_op");
    expect(sink.init!.method).toBe("POST");
    expect((sink.init!.headers as Record<string, string>)["X-Stamp"]).toMatch(/^s\(\d+\)$/);
    // Body: org + timestamp + top-level chainId + nested userOp with bigints as decimal strings.
    expect(sink.body.organizationId).toBe("org_1");
    expect(sink.body.timestampMs).toBe("1700000000000");
    expect(sink.body.chainId).toBe("11155111");
    expect(sink.body.validUntilSec).toBe(100);
    expect(sink.body.validAfterSec).toBe(5);
    expect(sink.body.userOp).toEqual({
      sender: USER_OP.sender,
      nonce: "7",
      initCode: "0x",
      callData: "0xdeadbeef",
      accountGasLimits: USER_OP.accountGasLimits,
      preVerificationGas: "21000",
      gasFees: USER_OP.gasFees,
      paymasterVerificationGasLimit: "100000",
      paymasterPostOpGasLimit: "50000",
    });
  });

  it("defaults initCode to 0x and omits the validity window when not supplied", async () => {
    const sink: { body?: any } = {};
    const client = makeClient(
      () => ({ ok: true, status: 200, json: { paymasterAndData: "0xabcd", userOpHash: "0x01", validUntil: 1, validAfter: 0 }, text: "" }),
      sink as any,
    );
    const { initCode, ...noInit } = USER_OP;
    await client.sponsorUserOperation(noInit as UserOperationV07, { chainId: "1" });
    expect(sink.body.userOp.initCode).toBe("0x");
    expect(sink.body.validUntilSec).toBeUndefined();
    expect(sink.body.validAfterSec).toBeUndefined();
  });
});

describe("KryardPaymasterClient.sponsorUserOperation — success parsing", () => {
  it("returns the paymasterAndData and validity window from the response", async () => {
    const client = makeClient(() => ({
      ok: true,
      status: 200,
      json: { paymasterAndData: "0xfeed", userOpHash: "0xdead", validUntil: 1700003600, validAfter: 1700000000 },
      text: "",
    }));
    const res = await client.sponsorUserOperation(USER_OP, { chainId: 1 });
    expect(res.paymasterAndData).toBe("0xfeed");
    expect(res.userOpHash).toBe("0xdead");
    expect(res.validUntil).toBe(1700003600);
    expect(res.validAfter).toBe(1700000000);
  });

  it("throws when a 200 response is missing paymasterAndData", async () => {
    const client = makeClient(() => ({ ok: true, status: 200, json: { userOpHash: "0x01" }, text: "" }));
    await expect(client.sponsorUserOperation(USER_OP, { chainId: 1 })).rejects.toThrow(/missing paymasterAndData/);
  });
});

describe("KryardPaymasterClient.sponsorUserOperation — typed denial errors", () => {
  const reasons: SponsorshipReasonCode[] = [
    "SPONSOR_DISABLED",
    "SPONSOR_CONTRACT_NOT_ALLOWED",
    "SPONSOR_SELECTOR_NOT_ALLOWED",
    "SPONSOR_OP_LIMIT",
    "SPONSOR_DAILY_CAP",
    "SPONSOR_MONTHLY_CAP",
    "SPONSOR_UNDECODABLE_CALLDATA",
  ];

  for (const reason of reasons) {
    it(`surfaces ${reason} as a SponsorshipDeniedError`, async () => {
      const client = makeClient(() => ({
        ok: false,
        status: 403,
        json: {},
        text: JSON.stringify({ code: 7, message: `sponsorship denied: ${reason}`, details: [], turnkeyErrorCode: "" }),
      }));
      const err = await client.sponsorUserOperation(USER_OP, { chainId: 1 }).catch((e) => e);
      expect(err).toBeInstanceOf(SponsorshipDeniedError);
      expect((err as SponsorshipDeniedError).reasonCode).toBe(reason);
      expect((err as SponsorshipDeniedError).status).toBe(403);
    });
  }

  it("throws a plain Error (not a denial) for non-403 transport failures", async () => {
    const client = makeClient(() => ({
      ok: false,
      status: 400,
      json: {},
      text: JSON.stringify({ code: 3, message: "no paymaster configured for chainId 999", details: [], turnkeyErrorCode: "" }),
    }));
    const err = await client.sponsorUserOperation(USER_OP, { chainId: 999 }).catch((e) => e);
    expect(err).not.toBeInstanceOf(SponsorshipDeniedError);
    expect((err as Error).message).toMatch(/failed with 400.*no paymaster/);
  });

  it("throws a plain Error for a 403 without a parseable reason code", async () => {
    const client = makeClient(() => ({ ok: false, status: 403, json: {}, text: "forbidden" }));
    const err = await client.sponsorUserOperation(USER_OP, { chainId: 1 }).catch((e) => e);
    expect(err).not.toBeInstanceOf(SponsorshipDeniedError);
    expect((err as Error).message).toMatch(/failed with 403/);
  });
});

describe("buildPaymasterAndData — v0.7 byte layout", () => {
  const sig = ("0x" + "ab".repeat(65)) as Hex;

  it("packs paymaster ‖ gas(16) ‖ gas(16) ‖ abi(validUntil,validAfter) ‖ signature to 181 bytes", () => {
    const p = buildPaymasterAndData(PAYMASTER, 100_000n, 50_000n, 1700003600, 1700000000, sig);
    const bytes = (p.length - 2) / 2;
    expect(bytes).toBe(20 + 16 + 16 + 64 + 65);
    expect(p.slice(0, 42).toLowerCase()).toBe(PAYMASTER.toLowerCase());
    expect(("0x" + p.slice(2 + 116 * 2)).toLowerCase()).toBe(sig.toLowerCase());
  });

  it("round-trips through splitPaymasterAndData", () => {
    const p = buildPaymasterAndData(PAYMASTER, 100_000n, 50_000n, 1700003600, 1700000000, sig);
    const parts = splitPaymasterAndData(p);
    expect(parts.paymaster.toLowerCase()).toBe(PAYMASTER.toLowerCase());
    expect(parts.verificationGas).toBe(100_000n);
    expect(parts.postOpGas).toBe(50_000n);
    expect(parts.validUntil).toBe(1700003600);
    expect(parts.validAfter).toBe(1700000000);
    expect(parts.signature.toLowerCase()).toBe(sig.toLowerCase());
  });

  it("rejects a too-short paymasterAndData", () => {
    expect(() => splitPaymasterAndData("0xdead" as Hex)).toThrow(/too short/);
  });
});

describe("applyPaymasterAndData", () => {
  it("attaches paymasterAndData immutably", () => {
    const op = { sender: "0x1" as Hex, callData: "0x2" as Hex };
    const out = applyPaymasterAndData(op, "0xfeed" as Hex);
    expect(out).toEqual({ sender: "0x1", callData: "0x2", paymasterAndData: "0xfeed" });
    expect(op).not.toHaveProperty("paymasterAndData"); // original untouched
  });
});
