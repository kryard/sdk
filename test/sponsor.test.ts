import { describe, it, expect } from "vitest";
import { decodeFunctionData, type Hex } from "viem";
import { buildSponsoredCall, sponsorCall, buildSponsoredExecute, sponsorExecute, type UserSigner } from "../src/sponsor.js";
import { KryardRelayClient, type RelayAuthorization, type RelaySubmitInput } from "../src/client.js";
import { KRYARD_DELEGATE_ABI } from "../src/abi.js";
import type { Call } from "../src/digest.js";

const ACCOUNT = "0x00000000000000000000000000000000000A11cE" as Hex;
const DELEGATE = "0x000000000000000000000000000000000000D31E" as Hex;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Hex;
const RELAYER = "0x000000000000000000000000000000000000bEEF" as Hex;
const calls: Call[] = [{ to: "0x000000000000000000000000000000000000dEaD" as Hex, value: 0n, data: "0xd0e30db0" as Hex }];
const AUTH: RelayAuthorization = { address: DELEGATE, chainId: 1, nonce: 0, r: "0x1" as Hex, s: "0x2" as Hex, yParity: 1 };

describe("buildSponsoredExecute", () => {
  it("targets the user EOA, attaches the authorization, encodes execute()", () => {
    const s: RelaySubmitInput = buildSponsoredExecute({
      account: ACCOUNT, chainId: 1, signWith: "key_1", delegateAddress: DELEGATE,
      calls, nonce: 5n, signature: "0xabcd" as Hex, authorization: AUTH,
    });
    expect(s.to).toBe(ACCOUNT);
    expect(s.value).toBe("0");
    expect(s.authorizationList).toEqual([AUTH]);
    expect(s.gasToken).toBeUndefined();
    const decoded = decodeFunctionData({ abi: KRYARD_DELEGATE_ABI, data: s.data });
    expect(decoded.functionName).toBe("execute");
  });

  it("encodes executeWithGasReimbursement + forwards token fields when gas is paid in ERC-20", () => {
    const s = buildSponsoredExecute({
      account: ACCOUNT, chainId: 1, signWith: "key_1", delegateAddress: DELEGATE,
      calls, nonce: 5n, signature: "0xabcd" as Hex, authorization: AUTH,
      gasToken: USDC, gasTokenAmount: 50_000n, relayer: RELAYER,
    });
    expect(s.gasToken).toBe(USDC);
    expect(s.gasTokenAmount).toBe("50000");
    const decoded = decodeFunctionData({ abi: KRYARD_DELEGATE_ABI, data: s.data });
    expect(decoded.functionName).toBe("executeWithGasReimbursement");
  });
});

describe("buildSponsoredCall (delegate-agnostic)", () => {
  it("passes the caller-built data through verbatim with the authorization", () => {
    const customData = "0x7fea8778c0ffee" as Hex; // e.g. a SweepDelegate sweep() call
    const s = buildSponsoredCall({
      account: ACCOUNT, chainId: 11155111, signWith: "key_1", data: customData, authorization: AUTH,
    });
    expect(s.to).toBe(ACCOUNT);
    expect(s.data).toBe(customData); // NOT re-encoded — the SDK is delegate-agnostic here
    expect(s.authorizationList).toEqual([AUTH]);
    expect(s.gasToken).toBeUndefined();
  });

  it("forwards the ERC-20 accounting fields when provided", () => {
    const s = buildSponsoredCall({
      account: ACCOUNT, chainId: 1, signWith: "k", data: "0xabcd" as Hex, authorization: AUTH,
      gasToken: USDC, gasTokenAmount: 9000n,
    });
    expect(s.gasToken).toBe(USDC);
    expect(s.gasTokenAmount).toBe("9000");
  });
});

describe("sponsorCall (delegate-agnostic high-level)", () => {
  it("signs only the 7702 authorization, then submits the caller's data", async () => {
    const calls: { authArgs?: unknown; digestSigned: boolean } = { digestSigned: false };
    const signer: UserSigner = {
      address: ACCOUNT,
      async signAuthorization(args) { calls.authArgs = args; return AUTH; },
      async signDigest() { calls.digestSigned = true; return "0x" as Hex; },
    };
    const sent: { to: Hex; data: Hex }[] = [];
    const client = new KryardRelayClient({
      baseUrl: "https://api.kryard.com", organizationId: "org_1",
      stamper: { async stamp(p) { return { stampHeaderName: "X-Stamp", stampHeaderValue: `s(${p.length})` }; } },
      fetchFn: async (_u, init) => { sent.push(JSON.parse(init!.body as string)); return { ok: true, status: 200, async json() { return { transaction: { id: "rl_9", status: "submitted", nonce: "0", txHash: "0xabc", failure: null } }; }, async text() { return ""; } }; },
    });

    const sweepData = "0x7fea8778abcdef" as Hex; // sweepster builds this itself
    const tx = await sponsorCall({
      client, signer, chainId: 11155111, signWith: "key_1", delegateAddress: DELEGATE, data: sweepData,
      gasToken: USDC, gasTokenAmount: 1234n, idempotencyKey: "idem-9",
    });

    expect(tx.id).toBe("rl_9");
    expect(calls.authArgs).toEqual({ contractAddress: DELEGATE, chainId: 11155111 });
    expect(calls.digestSigned).toBe(false); // generic path does NOT sign a KryardDelegate digest
    expect(sent[0].to).toBe(ACCOUNT);
    expect(sent[0].data).toBe(sweepData);
    expect((sent[0] as { gasToken?: string }).gasToken).toBe(USDC);
  });
});

describe("sponsorExecute", () => {
  it("signs the authorization + digest, then submits", async () => {
    const calledWith: { authArgs?: unknown; digest?: Hex } = {};
    const signer: UserSigner = {
      address: ACCOUNT,
      async signAuthorization(args) { calledWith.authArgs = args; return AUTH; },
      async signDigest(digest) { calledWith.digest = digest; return "0xdeadbeef" as Hex; },
    };

    const sent: RelaySubmitInput[] = [];
    const client = new KryardRelayClient({
      baseUrl: "https://api.kryard.com",
      organizationId: "org_1",
      stamper: { async stamp(p) { return { stampHeaderName: "X-Stamp", stampHeaderValue: `s(${p.length})` }; } },
      fetchFn: async (_url, init) => {
        sent.push(JSON.parse(init!.body as string));
        return { ok: true, status: 200, async json() { return { transaction: { id: "rl_1", status: "submitted", nonce: "0", txHash: "0xabc", failure: null } }; }, async text() { return ""; } };
      },
    });

    const tx = await sponsorExecute({
      client, signer, chainId: 1, signWith: "key_1", delegateAddress: DELEGATE, calls, nonce: 9n, idempotencyKey: "idem-1",
    });

    expect(tx.id).toBe("rl_1");
    expect(calledWith.authArgs).toEqual({ contractAddress: DELEGATE, chainId: 1 });
    expect(calledWith.digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(ACCOUNT);
    expect(sent[0].authorizationList).toEqual([AUTH]);
    expect(sent[0].idempotencyKey).toBe("idem-1");
  });
});
