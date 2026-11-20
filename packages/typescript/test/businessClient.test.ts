import { describe, it, expect, vi, afterEach } from "vitest";
import {
  KryardApiError,
  KryardBusinessClient,
  KryardProjectClient,
  verifyWebhookSignature,
  type FetchFn,
} from "../src/index.js";

const SUB_1 = "11111111-1111-4111-8111-111111111111";
const SUB_2 = "22222222-2222-4222-8222-222222222222";
const INV_1 = "33333333-3333-4333-8333-333333333333";
const MEM_1 = "44444444-4444-4444-8444-444444444444";
const LIM_1 = "55555555-5555-4555-8555-555555555555";
const TOK_CUSTOM = "66666666-6666-4666-8666-666666666666";
const TRULE_1 = "77777777-7777-4777-8777-777777777777";
const TLIM_1 = "88888888-8888-4888-8888-888888888888";
const WH_1 = "99999999-9999-4999-8999-999999999999";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(
  responder: (req: RecordedRequest) => { ok: boolean; status: number; body: unknown; rawText?: string },
): {
  fetchFn: FetchFn;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const req: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: rawBody ? JSON.parse(rawBody) : undefined,
    };
    requests.push(req);
    const res = responder(req);
    return {
      ok: res.ok,
      status: res.status,
      json: async () => res.body,
      text: async () => res.rawText ?? JSON.stringify(res.body),
    };
  };
  return { fetchFn, requests };
}

describe("KryardBusinessClient", () => {
  it("validates constructor options and trims trailing slashes", () => {
    expect(() => new KryardBusinessClient({ baseUrl: "", token: "jwt" })).toThrow(/baseUrl/);
    expect(() => new KryardBusinessClient({ baseUrl: "https://api.kryard.com", token: "" })).toThrow(/token/);
    expect(
      () => new KryardBusinessClient({ baseUrl: "https://api.kryard.com", token: "   " }),
    ).toThrow(/token/);
  });

  it("supports static or async token providers and scopes requests via X-Organization-Id", async () => {
    let calls = 0;
    const { fetchFn, requests } = stubFetch(() => ({
      ok: true,
      status: 200,
      body: {
        organization: { id: "org-root", name: "Acme", plan: "free", status: "active", role: "owner" },
        wallets: [],
        childWallets: [],
        walletCount: 1,
        canManage: true,
      },
    }));

    const client = new KryardBusinessClient({
      baseUrl: "https://api.kryard.com///",
      token: async () => `jwt-${++calls}`,
      organizationId: "org-root",
      fetchFn,
    });

    await client.getOverview();
    await client.withOrganization("org-child").getOverview();
    await client.getOverview({ organizationId: "org-override" });

    expect(requests.map((r) => r.url)).toEqual([
      "https://api.kryard.com/dashboard/v1/business",
      "https://api.kryard.com/dashboard/v1/business",
      "https://api.kryard.com/dashboard/v1/business",
    ]);
    expect(requests[0]!.headers["authorization"]).toBe("Bearer jwt-1");
    expect(requests[0]!.headers["x-organization-id"]).toBe("org-root");
    expect(requests[1]!.headers["x-organization-id"]).toBe("org-child");
    expect(requests[2]!.headers["x-organization-id"]).toBe("org-override");
  });

  it("omits X-Organization-Id on pre-membership claimInvitation even when client has an organizationId", async () => {
    const { fetchFn, requests } = stubFetch(() => ({
      ok: true,
      status: 200,
      body: { organizationId: "org-sub", role: "admin" },
    }));
    const client = new KryardBusinessClient({
      baseUrl: "https://api.kryard.com",
      token: "jwt-abc",
      organizationId: "org-root",
      fetchFn,
    });

    const claimed = await client.claimInvitation("  tok_secret_123  ");
    expect(claimed).toEqual({ organizationId: "org-sub", role: "admin" });
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe("https://api.kryard.com/dashboard/v1/business/invitations/claim");
    expect(requests[0]!.headers["authorization"]).toBe("Bearer jwt-abc");
    expect(requests[0]!.headers["x-organization-id"]).toBeUndefined();
    expect(requests[0]!.body).toEqual({ token: "tok_secret_123" });
  });

  it("supports sub-org CRUD and deposit addresses routes", async () => {
    const { fetchFn, requests } = stubFetch((req) => {
      if (req.url.endsWith("/dashboard/v1/business/suborgs") && req.method === "GET") {
        return { ok: true, status: 200, body: { wallets: [{ id: "root", depth: 0 }], childWallets: [] } };
      }
      if (req.url.endsWith("/dashboard/v1/business/suborgs") && req.method === "POST") {
        return {
          ok: true,
          status: 201,
          body: {
            childWallet: {
              id: SUB_1,
              name: "EU Desk",
              parentOrganizationId: "org-root",
              status: "active",
              plan: "free",
              memberCount: 1,
              createdAt: "2026-11-16T00:00:00.000Z",
            },
          },
        };
      }
      if (req.url.endsWith(`/dashboard/v1/business/suborgs/${SUB_1}`) && req.method === "GET") {
        return {
          ok: true,
          status: 200,
          body: { childWallet: { id: SUB_1, name: "EU Desk", depth: 1 } },
        };
      }
      if (req.url.endsWith(`/dashboard/v1/business/suborgs/${SUB_1}/rename`) && req.method === "POST") {
        return { ok: true, status: 200, body: { id: SUB_1, name: "EMEA Desk" } };
      }
      if (req.url.endsWith("/dashboard/v1/business/deposit-addresses")) {
        return {
          ok: true,
          status: 200,
          body: {
            chains: { "11155111": "0xFactory" },
            wallets: [],
            totals: {
              walletCount: 2,
              creditedWei: "100",
              pendingWei: "0",
              pendingCount: 0,
              depositedWei: "100",
              availableWei: "80",
            },
          },
        };
      }
      return {
        ok: true,
        status: 200,
        body: {
          chains: { "11155111": "0xFactory" },
          organizationId: SUB_1,
          depositAddresses: { "11155111": "0xDeposit" },
          creditedWei: "50",
          pendingWei: "0",
          pendingCount: 0,
        },
      };
    });

    const client = new KryardBusinessClient({
      baseUrl: "https://api.kryard.com",
      token: "jwt-1",
      organizationId: "org-root",
      fetchFn,
    });

    const list = await client.listSubOrgs();
    expect(list.wallets[0]!.depth).toBe(0);

    const created = await client.createSubOrg({ name: "  EU Desk ", ownerUserId: "user-1" });
    expect(created.id).toBe(SUB_1);
    expect(created.depth).toBe(1);
    expect(requests[1]!.body).toEqual({ name: "EU Desk", ownerUserId: "user-1" });

    const fetched = await client.getSubOrg(SUB_1);
    expect(fetched.name).toBe("EU Desk");

    const renamed = await client.renameSubOrg(SUB_1, " EMEA Desk ");
    expect(renamed).toEqual({ id: SUB_1, name: "EMEA Desk" });
    expect(requests[3]!.body).toEqual({ name: "EMEA Desk" });

    const surface = await client.getDepositAddresses();
    expect(surface.totals.availableWei).toBe("80");

    const subSurface = await client.getSubOrgDepositAddresses(SUB_1);
    expect(subSurface.depositAddresses["11155111"]).toBe("0xDeposit");
  });

  it("supports member management, invitations, and scope toggles", async () => {
    const { fetchFn, requests } = stubFetch((req) => {
      if (req.url.endsWith("/members") && req.method === "GET") {
        return { ok: true, status: 200, body: { members: [{ id: MEM_1, role: "member", scope: "read_write" }], invitations: [] } };
      }
      if (req.url.endsWith("/invitations") && req.method === "POST") {
        return {
          ok: true,
          status: 201,
          body: {
            invitation: {
              id: INV_1,
              email: "alice@example.com",
              role: "admin",
              status: "pending",
              expiresAt: "2026-11-20T00:00:00Z",
              claimedAt: null,
              createdAt: "2026-11-16T00:00:00Z",
            },
            token: "one-time-tok",
          },
        };
      }
      if (req.url.endsWith(`/invitations/${INV_1}/revoke`)) {
        return { ok: true, status: 200, body: { ok: true } };
      }
      if (req.url.endsWith(`/members/${MEM_1}/role`)) {
        return { ok: true, status: 200, body: { member: { id: MEM_1, role: "admin", scope: "read_only" } } };
      }
      if (req.url.endsWith(`/members/${MEM_1}`) && req.method === "DELETE") {
        return { ok: true, status: 200, body: { ok: true } };
      }
      return { ok: false, status: 404, body: { code: 5, message: "not found" } };
    });

    const client = new KryardBusinessClient({
      baseUrl: "https://api.kryard.com",
      token: "jwt-1",
      organizationId: "org-root",
      fetchFn,
    });

    const membersRes = await client.listMembers(SUB_1);
    expect(membersRes.members).toHaveLength(1);

    const invRes = await client.inviteMember(SUB_1, { email: "alice@example.com", role: "admin", ttlHours: 24 });
    expect(invRes.token).toBe("one-time-tok");
    expect(requests[1]!.body).toEqual({ email: "alice@example.com", role: "admin", ttlHours: 24 });

    expect(await client.revokeInvitation(SUB_1, INV_1)).toEqual({ ok: true });

    const roleUpdated = await client.setMemberRole(SUB_1, MEM_1, "admin");
    expect(roleUpdated.role).toBe("admin");
    expect(requests[3]!.body).toEqual({ role: "admin" });

    const scopeUpdated = await client.setMemberScope(SUB_1, MEM_1, "read_only");
    expect(scopeUpdated.scope).toBe("read_only");
    expect(requests[4]!.body).toEqual({ scope: "read_only" });

    expect(await client.removeMember(SUB_1, MEM_1)).toEqual({ ok: true });
    expect(requests[5]!.method).toBe("DELETE");
  });

  it("supports per-actor spend limits CRUD", async () => {
    const { fetchFn, requests } = stubFetch((req) => {
      if (req.url.endsWith("/dashboard/v1/actor-spend-limits") && req.method === "GET") {
        return {
          ok: true,
          status: 200,
          body: {
            limits: [
              {
                id: LIM_1,
                actorId: "act-1",
                privateKeyId: "pk-1",
                chainId: "84532",
                maxTxValueWei: "1000",
                dailyLimitWei: "5000",
                spentTodayWei: "200",
                createdAt: "2026-11-16T00:00:00Z",
              },
            ],
          },
        };
      }
      if (req.url.endsWith("/dashboard/v1/actor-spend-limits") && req.method === "POST") {
        return {
          ok: true,
          status: 201,
          body: {
            id: LIM_1,
            actorId: "act-1",
            privateKeyId: "pk-1",
            chainId: "84532",
            maxTxValueWei: "1000",
            dailyLimitWei: "5000",
            spentTodayWei: "200",
            createdAt: "2026-11-16T00:00:00Z",
          },
        };
      }
      return { ok: true, status: 200, body: { ok: true } };
    });

    const client = new KryardBusinessClient({
      baseUrl: "https://api.kryard.com",
      token: "jwt-1",
      organizationId: "org-sub",
      fetchFn,
    });

    const limits = await client.listActorSpendLimits();
    expect(limits).toHaveLength(1);
    expect(limits[0]!.spentTodayWei).toBe("200");

    const setRes = await client.setActorSpendLimit({
      actorId: "act-1",
      privateKeyId: "pk-1",
      chainId: "84532",
      maxTxValueWei: "1000",
      dailyLimitWei: "5000",
    });
    expect(setRes.dailyLimitWei).toBe("5000");
    expect(requests[1]!.body).toEqual({
      actorId: "act-1",
      privateKeyId: "pk-1",
      chainId: "84532",
      maxTxValueWei: "1000",
      dailyLimitWei: "5000",
    });

    expect(await client.deleteActorSpendLimit(LIM_1)).toEqual({ ok: true });
    expect(requests[2]!.url).toBe(`https://api.kryard.com/dashboard/v1/actor-spend-limits/${LIM_1}`);
    expect(requests[2]!.method).toBe("DELETE");
  });

  it("rejects invalid arguments locally and surfaces structured KryardApiError from server errors", async () => {
    const { fetchFn } = stubFetch(() => ({
      ok: false,
      status: 403,
      body: { code: 7, message: "this membership is read-only" },
    }));

    const client = new KryardBusinessClient({
      baseUrl: "https://api.kryard.com",
      token: "jwt-1",
      organizationId: "org-root",
      fetchFn,
    });

    await expect(client.getSubOrg("")).rejects.toThrow(/subOrgId/);
    await expect(client.updateMemberAccess(SUB_1, MEM_1, {})).rejects.toThrow(/role or scope/);
    await expect(client.claimInvitation("  ")).rejects.toThrow(/token/);

    let err: unknown;
    try {
      await client.createSubOrg({ name: "Forbidden" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KryardApiError);
    expect((err as KryardApiError).status).toBe(403);
    expect((err as KryardApiError).code).toBe(7);
    expect((err as KryardApiError).message).toContain("this membership is read-only");
  });

  it("provisions payment wallets on new sub-orgs, root orgs, and existing sub-orgs", async () => {
    const { fetchFn, requests } = stubFetch((req) => {
      if (req.url.endsWith("/dashboard/v1/business/suborgs") && req.method === "POST") {
        return {
          ok: true,
          status: 201,
          body: {
            childWallet: {
              id: SUB_2,
              name: "Storefront A",
              parentOrganizationId: "org-root",
              status: "active",
              plan: "free",
              memberCount: 0,
              paymentWallet: {
                privateKeyId: "pk-sub-2",
                address: "0x1111111111111111111111111111111111111111",
                name: "Storefront Wallet",
              },
              createdAt: "2026-11-16T00:00:00Z",
            },
          },
        };
      }
      if (req.url.endsWith("/dashboard/v1/business/payment-wallet") && req.method === "POST") {
        return {
          ok: true,
          status: 201,
          body: {
            organizationId: "org-root",
            paymentWallet: {
              privateKeyId: "pk-root",
              address: "0x2222222222222222222222222222222222222222",
              name: "Treasury Primary",
            },
            created: true,
            adopted: false,
          },
        };
      }
      if (req.url.endsWith(`/dashboard/v1/business/suborgs/${SUB_2}/payment-wallet`) && req.method === "POST") {
        return {
          ok: true,
          status: 200,
          body: {
            organizationId: SUB_2,
            paymentWallet: {
              privateKeyId: "pk-existing",
              address: "0x3333333333333333333333333333333333333333",
              name: "Existing Key",
            },
            created: false,
            adopted: true,
          },
        };
      }
      return { ok: false, status: 404, body: { message: "not found" } };
    });

    const client = new KryardBusinessClient({
      baseUrl: "https://api.kryard.com",
      token: "jwt-1",
      organizationId: "org-root",
      fetchFn,
    });

    const created = await client.createSubOrg({
      name: "Storefront A",
      provisionPaymentWallet: true,
      walletName: "  Storefront Wallet ",
    });
    expect(created.paymentWallet).toEqual({
      privateKeyId: "pk-sub-2",
      address: "0x1111111111111111111111111111111111111111",
      name: "Storefront Wallet",
    });
    expect(requests[0]!.body).toEqual({
      name: "Storefront A",
      provisionPaymentWallet: true,
      walletName: "Storefront Wallet",
    });

    const rootProv = await client.provisionPaymentWallet({
      walletName: "Treasury Primary",
      adoptExisting: false,
    });
    expect(rootProv.created).toBe(true);
    expect(rootProv.adopted).toBe(false);
    expect(rootProv.paymentWallet.privateKeyId).toBe("pk-root");
    expect(requests[1]!.body).toEqual({ walletName: "Treasury Primary", adoptExisting: false });

    const subProv = await client.provisionSubOrgPaymentWallet(SUB_2, {
      privateKeyId: "pk-existing",
    });
    expect(subProv.adopted).toBe(true);
    expect(subProv.organizationId).toBe(SUB_2);
    expect(requests[2]!.body).toEqual({ privateKeyId: "pk-existing" });
  });

  it("supports supported tokens registry, multi-chain balances, payments, and gasless token sends", async () => {
    const { fetchFn, requests } = stubFetch((req) => {
      if (req.url.startsWith("https://api.kryard.com/dashboard/v1/tokens") && req.method === "GET") {
        return {
          ok: true,
          status: 200,
          body: {
            tokens: [
              {
                id: "tok-1",
                scope: "global",
                organizationId: null,
                chainId: "84532",
                tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
                symbol: "USDC",
                name: "USD Coin",
                decimals: 6,
                status: "active",
                createdAt: "2026-11-16T00:00:00Z",
              },
            ],
          },
        };
      }
      if (req.url === "https://api.kryard.com/dashboard/v1/tokens" && req.method === "POST") {
        return {
          ok: true,
          status: 201,
          body: {
            token: {
              id: TOK_CUSTOM,
              scope: "org",
              organizationId: "org-root",
              chainId: "84532",
              tokenAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              symbol: "ACME",
              name: "Acme USD",
              decimals: 6,
              status: "active",
              createdAt: "2026-11-16T00:00:00Z",
            },
          },
        };
      }
      if (req.url === `https://api.kryard.com/dashboard/v1/tokens/${TOK_CUSTOM}` && req.method === "DELETE") {
        return { ok: true, status: 200, body: { ok: true } };
      }
      if (req.url.includes("/balances")) {
        return {
          ok: true,
          status: 200,
          body: {
            chains: ["84532", "11155111"],
            chainErrors: {},
            wallets: [
              {
                organizationId: "org-root",
                organizationName: "Acme",
                walletAddress: "0x2222222222222222222222222222222222222222",
                privateKeyId: "pk-root",
                nativeBalances: { "84532": "1000000" },
                tokens: [],
              },
            ],
            totals: {
              walletCount: 1,
              provisionedCount: 1,
              nativeByChain: { "84532": "1000000" },
              tokens: [],
            },
          },
        };
      }
      if (req.url.includes("/payments")) {
        return {
          ok: true,
          status: 200,
          body: {
            payments: [
              {
                id: "pay-1",
                organizationId: SUB_2,
                organizationName: "Storefront A",
                privateKeyId: "pk-sub-2",
                walletAddress: "0x1111111111111111111111111111111111111111",
                chainId: "84532",
                tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
                tokenSymbol: "USDC",
                tokenDecimals: 6,
                txHash: "0xdeadbeef",
                logIndex: 0,
                blockNumber: "100",
                sender: "0x4444444444444444444444444444444444444444",
                amountRaw: "2500000",
                status: "confirmed",
                confirmedAt: "2026-11-16T00:01:00Z",
                createdAt: "2026-11-16T00:00:00Z",
              },
            ],
          },
        };
      }
      if (req.url.endsWith("/send-token") && req.method === "POST") {
        return {
          ok: true,
          status: 201,
          body: {
            activityId: "act-send-1",
            paymentWalletAddress: "0x2222222222222222222222222222222222222222",
            privateKeyId: "pk-root",
            relayerOrganizationId: "org-root",
            relayerKeyId: "pk-relayer",
            relayerTransaction: {
              id: "rtx-1",
              status: "broadcasted",
              nonce: "1",
              txHash: "0xbeef",
              failure: null,
            },
          },
        };
      }
      return { ok: false, status: 404, body: { message: "not found" } };
    });

    const client = new KryardBusinessClient({
      baseUrl: "https://api.kryard.com",
      token: "jwt-1",
      organizationId: "org-root",
      fetchFn,
    });

    const allTokens = await client.listTokens();
    expect(allTokens).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.kryard.com/dashboard/v1/tokens");

    await client.listTokens("84532");
    expect(requests[1]!.url).toBe("https://api.kryard.com/dashboard/v1/tokens?chainId=84532");

    const custom = await client.addToken({
      chainId: "84532",
      tokenAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      symbol: "ACME",
      name: "Acme USD",
      decimals: 6,
    });
    expect(custom.id).toBe(TOK_CUSTOM);
    expect(requests[2]!.body).toEqual({
      chainId: "84532",
      tokenAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      symbol: "ACME",
      name: "Acme USD",
      decimals: 6,
    });

    expect(await client.removeToken(TOK_CUSTOM)).toEqual({ ok: true });
    expect(requests[3]!.method).toBe("DELETE");

    const balances = await client.getBalances(["84532", "11155111"]);
    expect(balances.totals.provisionedCount).toBe(1);
    expect(requests[4]!.url).toBe("https://api.kryard.com/dashboard/v1/business/balances?chainId=84532,11155111");

    const subBalances = await client.getSubOrgBalances(SUB_2);
    expect(subBalances.chains).toEqual(["84532", "11155111"]);
    expect(requests[5]!.url).toBe(`https://api.kryard.com/dashboard/v1/business/suborgs/${SUB_2}/balances`);

    const payments = await client.listPayments({ chainId: "84532", status: "confirmed", limit: 10 });
    expect(payments).toHaveLength(1);
    expect(payments[0]!.tokenSymbol).toBe("USDC");
    expect(requests[6]!.url).toBe(
      "https://api.kryard.com/dashboard/v1/business/payments?chainId=84532&status=confirmed&limit=10",
    );

    const subPayments = await client.listSubOrgPayments(SUB_2, { status: "pending" });
    expect(subPayments).toHaveLength(1);
    expect(requests[7]!.url).toBe(
      `https://api.kryard.com/dashboard/v1/business/suborgs/${SUB_2}/payments?status=pending`,
    );

    const sendRes = await client.sendToken({
      chainId: "84532",
      tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      to: "0x9999999999999999999999999999999999999999",
      amountRaw: "1000000",
      idempotencyKey: "idem-1",
    });
    expect(sendRes.relayerTransaction.txHash).toBe("0xbeef");
    expect(requests[8]!.url).toBe("https://api.kryard.com/dashboard/v1/business/send-token");
    expect(requests[8]!.body).toEqual({
      chainId: "84532",
      tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      to: "0x9999999999999999999999999999999999999999",
      amountRaw: "1000000",
      idempotencyKey: "idem-1",
    });

    const subSendRes = await client.sendSubOrgToken(SUB_2, {
      chainId: "84532",
      to: "0x9999999999999999999999999999999999999999",
      amountRaw: "500000000000000",
      relayerOrgId: "org-root",
      relayerSignWith: "pk-relayer",
      delegateAddress: "0xdF2A038dE47D34998aB705fc471A65d84B09Ee9D",
    });
    expect(subSendRes.activityId).toBe("act-send-1");
    expect(requests[9]!.url).toBe(`https://api.kryard.com/dashboard/v1/business/suborgs/${SUB_2}/send-token`);
    expect(requests[9]!.body).toEqual({
      chainId: "84532",
      to: "0x9999999999999999999999999999999999999999",
      amountRaw: "500000000000000",
      relayerOrgId: "org-root",
      relayerSignWith: "pk-relayer",
      delegateAddress: "0xdF2A038dE47D34998aB705fc471A65d84B09Ee9D",
    });
  });

  it("supports token policy rules and per-actor token spend limits CRUD", async () => {
    const { fetchFn, requests } = stubFetch((req) => {
      if (req.url === "https://api.kryard.com/dashboard/v1/policies/token-rule" && req.method === "POST") {
        return {
          ok: true,
          status: 201,
          body: {
            tokenRule: {
              id: TRULE_1,
              privateKeyId: "pk-sub",
              chainId: "84532",
              tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
              maxTxAmount: "5000000",
              allowApprove: true,
              allowOpenEip3009Recipients: true,
              createdAt: "2026-11-16T00:00:00Z",
            },
          },
        };
      }
      if (req.url.startsWith("https://api.kryard.com/dashboard/v1/actor-token-spend-limits") && req.method === "GET") {
        return {
          ok: true,
          status: 200,
          body: {
            limits: [
              {
                id: TLIM_1,
                actorId: "act-1",
                privateKeyId: "pk-sub",
                chainId: "84532",
                tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
                maxTxAmount: "1000000",
                dailyLimitAmount: "3000000",
                spentTodayAmount: "250000",
                createdAt: "2026-11-16T00:00:00Z",
              },
            ],
          },
        };
      }
      if (req.url === "https://api.kryard.com/dashboard/v1/actor-token-spend-limits" && req.method === "POST") {
        return {
          ok: true,
          status: 201,
          body: {
            id: TLIM_1,
            actorId: "act-1",
            privateKeyId: "pk-sub",
            chainId: "84532",
            tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
            maxTxAmount: "1000000",
            dailyLimitAmount: "3000000",
            spentTodayAmount: "0",
            createdAt: "2026-11-16T00:00:00Z",
          },
        };
      }
      return { ok: true, status: 200, body: { ok: true } };
    });

    const client = new KryardBusinessClient({
      baseUrl: "https://api.kryard.com",
      token: "jwt-1",
      organizationId: "org-root",
      fetchFn,
    });

    const rule = await client.setTokenPolicyRule({
      organizationId: SUB_2,
      privateKeyId: "pk-sub",
      chainId: "84532",
      tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      maxTxAmount: "5000000",
      allowApprove: true,
      allowOpenEip3009Recipients: true,
    });
    expect(rule.id).toBe(TRULE_1);
    expect(rule.allowApprove).toBe(true);
    expect(rule.allowOpenEip3009Recipients).toBe(true);
    expect(requests[0]!.headers["x-organization-id"]).toBe("org-root");
    expect(requests[0]!.body).toEqual({
      organizationId: SUB_2,
      privateKeyId: "pk-sub",
      chainId: "84532",
      tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      maxTxAmount: "5000000",
      allowApprove: true,
      allowOpenEip3009Recipients: true,
    });

    expect(await client.deleteTokenPolicyRule(TRULE_1, SUB_2)).toEqual({ ok: true });
    expect(requests[1]!.url).toBe(
      `https://api.kryard.com/dashboard/v1/policies/token-rule/${TRULE_1}?organizationId=${SUB_2}`,
    );
    expect(requests[1]!.method).toBe("DELETE");

    const listed = await client.listTokenSpendLimits(SUB_2);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.spentTodayAmount).toBe("250000");
    expect(requests[2]!.url).toBe(
      `https://api.kryard.com/dashboard/v1/actor-token-spend-limits?organizationId=${SUB_2}`,
    );

    const setLimit = await client.setTokenSpendLimit({
      organizationId: SUB_2,
      actorId: "act-1",
      privateKeyId: "pk-sub",
      chainId: "84532",
      tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      maxTxAmount: "1000000",
      dailyLimitAmount: "3000000",
    });
    expect(setLimit.dailyLimitAmount).toBe("3000000");
    expect(requests[3]!.body).toEqual({
      organizationId: SUB_2,
      actorId: "act-1",
      privateKeyId: "pk-sub",
      chainId: "84532",
      tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      maxTxAmount: "1000000",
      dailyLimitAmount: "3000000",
    });

    expect(await client.deleteTokenSpendLimit(TLIM_1)).toEqual({ ok: true });
    expect(requests[4]!.url).toBe(`https://api.kryard.com/dashboard/v1/actor-token-spend-limits/${TLIM_1}`);
  });

  it("supports webhook endpoints CRUD and secret rotation", async () => {
    const { fetchFn, requests } = stubFetch((req) => {
      if (req.url === "https://api.kryard.com/dashboard/v1/webhooks" && req.method === "GET") {
        return {
          ok: true,
          status: 200,
          body: {
            endpoints: [
              {
                id: WH_1,
                organizationId: "org-root",
                url: "https://hooks.example.com/kryard",
                description: "Billing hook",
                secretPrefix: "whsec_abcdef",
                events: ["payment.erc20.confirmed"],
                includeSuborgs: true,
                status: "active",
                createdAt: "2026-11-16T00:00:00Z",
                updatedAt: "2026-11-16T00:00:00Z",
              },
            ],
            recentDeliveries: [],
          },
        };
      }
      if (req.url === "https://api.kryard.com/dashboard/v1/webhooks" && req.method === "POST") {
        return {
          ok: true,
          status: 201,
          body: {
            endpoint: {
              id: WH_1,
              organizationId: "org-root",
              url: "https://hooks.example.com/kryard",
              description: "Billing hook",
              secretPrefix: "whsec_abcdef",
              events: ["payment.erc20.confirmed"],
              includeSuborgs: true,
              status: "active",
              createdAt: "2026-11-16T00:00:00Z",
              updatedAt: "2026-11-16T00:00:00Z",
            },
            secret: "whsec_initial_secret",
          },
        };
      }
      if (req.url === `https://api.kryard.com/dashboard/v1/webhooks/${WH_1}/rotate` && req.method === "POST") {
        return {
          ok: true,
          status: 200,
          body: {
            endpoint: {
              id: WH_1,
              organizationId: "org-root",
              url: "https://hooks.example.com/kryard",
              description: "Billing hook",
              secretPrefix: "whsec_123456",
              events: ["payment.erc20.confirmed"],
              includeSuborgs: true,
              status: "active",
              createdAt: "2026-11-16T00:00:00Z",
              updatedAt: "2026-11-16T00:05:00Z",
            },
            secret: "whsec_rotated_secret",
          },
        };
      }
      return { ok: true, status: 200, body: { ok: true } };
    });

    const client = new KryardBusinessClient({
      baseUrl: "https://api.kryard.com",
      token: "jwt-1",
      organizationId: "org-root",
      fetchFn,
    });

    const created = await client.createWebhook({
      url: "https://hooks.example.com/kryard",
      description: "Billing hook",
      events: ["payment.erc20.confirmed"],
      includeSuborgs: true,
    });
    expect(created.secret).toBe("whsec_initial_secret");
    expect(requests[0]!.body).toEqual({
      url: "https://hooks.example.com/kryard",
      description: "Billing hook",
      events: ["payment.erc20.confirmed"],
      includeSuborgs: true,
    });

    const listed = await client.listWebhooks();
    expect(listed.endpoints).toHaveLength(1);
    expect(listed.recentDeliveries).toEqual([]);

    const rotated = await client.rotateWebhookSecret(WH_1);
    expect(rotated.secret).toBe("whsec_rotated_secret");

    expect(await client.deleteWebhook(WH_1)).toEqual({ ok: true });
    expect(requests[3]!.method).toBe("DELETE");
  });

  it("validates required arguments locally for token, payment, policy, and webhook methods", async () => {
    const { fetchFn, requests } = stubFetch(() => ({ ok: true, status: 200, body: {} }));
    const client = new KryardBusinessClient({
      baseUrl: "https://api.kryard.com",
      token: "jwt-1",
      organizationId: "org-root",
      fetchFn,
    });

    await expect(client.provisionPaymentWallet({ privateKeyId: "   " })).rejects.toThrow(/privateKeyId/);
    await expect(client.provisionSubOrgPaymentWallet("", {})).rejects.toThrow(/subOrgId/);
    await expect(client.addToken({ chainId: "", tokenAddress: "0x1" })).rejects.toThrow(/chainId/);
    await expect(
      client.addToken({ chainId: "84532", tokenAddress: "0x1", decimals: -1 }),
    ).rejects.toThrow(/decimals/);
    await expect(client.removeToken(" ")).rejects.toThrow(/tokenId/);
    await expect(client.listPayments({ limit: 0 })).rejects.toThrow(/limit/);
    await expect(client.sendToken({ chainId: "84532", to: "", amountRaw: "1" })).rejects.toThrow(/to/);
    await expect(
      client.setTokenPolicyRule({
        privateKeyId: "pk-1",
        chainId: "84532",
        tokenAddress: "0x1",
        maxTxAmount: "",
      }),
    ).rejects.toThrow(/maxTxAmount/);
    await expect(client.deleteTokenPolicyRule("")).rejects.toThrow(/ruleId/);
    await expect(
      client.setTokenSpendLimit({ actorId: "", privateKeyId: "pk", chainId: "84532", tokenAddress: "0x1" }),
    ).rejects.toThrow(/actorId/);
    await expect(client.deleteTokenSpendLimit("")).rejects.toThrow(/limitId/);
    await expect(client.createWebhook({ url: " " })).rejects.toThrow(/url/);
    await expect(client.createWebhook({ url: "https://a.com", events: [] })).rejects.toThrow(/events/);
    await expect(client.rotateWebhookSecret("")).rejects.toThrow(/webhookId/);
    await expect(client.deleteWebhook("")).rejects.toThrow(/webhookId/);

    for (const bad of ["..", ".", "a/b", "%2e%2e", "a\\b", "sub 1", "sub-1"]) {
      await expect(client.getSubOrg(bad)).rejects.toThrow(/subOrgId must be a valid UUID/);
      await expect(client.revokeInvitation(SUB_1, bad)).rejects.toThrow(/invitationId must be a valid UUID/);
      await expect(client.deleteTokenPolicyRule(bad)).rejects.toThrow(/ruleId must be a valid UUID/);
      await expect(client.deleteWebhook(bad)).rejects.toThrow(/webhookId must be a valid UUID/);
    }
    expect(requests).toHaveLength(0);
  });

  it("exports KryardProjectClient as the canonical project client", async () => {
    const { fetchFn, requests } = stubFetch(() => ({
      ok: true,
      status: 200,
      body: { projectId: "p-1", organizationId: SUB_1 },
    }));
    const projectClient = new KryardProjectClient({
      projectId: "proj_abc",
      baseUrl: "https://api.kryard.com/",
      fetchFn,
    });
    expect(await projectClient.getConfig()).toEqual({ projectId: "p-1", organizationId: SUB_1 });
    expect(requests[0]!.url).toBe("https://api.kryard.com/client/v1/config");
  });
});

describe("verifyWebhookSignature", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function hmacHex(secret: string, tsSec: number, rawBody: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${tsSec}.${rawBody}`));
    return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function signHeader(secret: string, tsSec: number, rawBody: string): Promise<string> {
    return `t=${tsSec},v1=${await hmacHex(secret, tsSec, rawBody)}`;
  }

  it("accepts a valid HMAC-SHA256 webhook signature within the timestamp tolerance", async () => {
    vi.useFakeTimers();
    const nowSec = 1_800_000_000;
    vi.setSystemTime(nowSec * 1000);

    const secret = "whsec_test_secret_123456";
    const body = JSON.stringify({ event: "payment.erc20.confirmed", data: { amountRaw: "1000000" } });
    const header = await signHeader(secret, nowSec - 60, body);

    expect(await verifyWebhookSignature(secret, header, body)).toBe(true);
  });

  it("supports multiple v1 signatures during secret rotation and uppercase hex", async () => {
    vi.useFakeTimers();
    const nowSec = 1_800_000_000;
    vi.setSystemTime(nowSec * 1000);

    const secret = "whsec_new_secret";
    const body = '{"ok":true}';
    const validHex = (await hmacHex(secret, nowSec, body)).toUpperCase();
    const header = `t=${nowSec},v1=${"0".repeat(64)},v1=${validHex}`;

    expect(await verifyWebhookSignature(secret, header, body)).toBe(true);
  });

  it("rejects wrong secret, tampered body, expired/future timestamps, and malformed headers", async () => {
    vi.useFakeTimers();
    const nowSec = 1_800_000_000;
    vi.setSystemTime(nowSec * 1000);

    const secret = "whsec_real";
    const body = '{"amount":"100"}';
    const header = await signHeader(secret, nowSec, body);

    expect(await verifyWebhookSignature("whsec_wrong", header, body)).toBe(false);
    expect(await verifyWebhookSignature(secret, header, '{"amount":"200"}')).toBe(false);
    expect(await verifyWebhookSignature(secret, await signHeader(secret, nowSec - 301, body), body, 300)).toBe(false);
    expect(await verifyWebhookSignature(secret, await signHeader(secret, nowSec + 301, body), body, 300)).toBe(false);
    expect(await verifyWebhookSignature(secret, await signHeader(secret, nowSec - 10_000, body), body, 0)).toBe(true);

    expect(await verifyWebhookSignature("", header, body)).toBe(false);
    expect(await verifyWebhookSignature(secret, "", body)).toBe(false);
    expect(await verifyWebhookSignature(secret, `v1=${"a".repeat(64)}`, body)).toBe(false);
    expect(await verifyWebhookSignature(secret, `t=,v1=${"a".repeat(64)}`, body, 0)).toBe(false);
    expect(await verifyWebhookSignature(secret, `t=${nowSec},v1=deadbeef`, body)).toBe(false);
    expect(await verifyWebhookSignature(secret, `t=notanumber,v1=${"a".repeat(64)}`, body)).toBe(false);
    expect(await verifyWebhookSignature(secret, header, body, -1)).toBe(false);
    expect(await verifyWebhookSignature(secret, header, body, Number.NaN)).toBe(false);
    expect(await verifyWebhookSignature(secret, header, body, Number.POSITIVE_INFINITY)).toBe(false);
  });
});
