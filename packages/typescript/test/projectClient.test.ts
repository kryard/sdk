import { describe, it, expect } from "vitest";
import { KryardProjectClient, type FetchFn } from "../src/index.js";

/** A fetch stub that records the last request and returns a canned response. */
function stubFetch(res: { ok: boolean; status: number; body: unknown }): {
  fetchFn: FetchFn;
  last: () => { url: string; init?: RequestInit };
} {
  let last: { url: string; init?: RequestInit } = { url: "" };
  const fetchFn: FetchFn = async (url, init) => {
    last = { url, init };
    return {
      ok: res.ok,
      status: res.status,
      json: async () => res.body,
      text: async () => JSON.stringify(res.body),
    };
  };
  return { fetchFn, last: () => last };
}

describe("KryardProjectClient", () => {
  it("requires a projectId and a baseUrl", () => {
    expect(() => new KryardProjectClient({ projectId: "", baseUrl: "https://api.kryard.com" })).toThrow(/projectId/);
    expect(() => new KryardProjectClient({ projectId: "proj_1", baseUrl: "" })).toThrow(/baseUrl/);
  });

  it("getConfig sends the public project id header and returns the config", async () => {
    const { fetchFn, last } = stubFetch({ ok: true, status: 200, body: { projectId: "p-uuid", organizationId: "org-uuid" } });
    const client = new KryardProjectClient({ projectId: "proj_abc", baseUrl: "https://api.kryard.com/", fetchFn });

    const cfg = await client.getConfig();
    expect(cfg).toEqual({ projectId: "p-uuid", organizationId: "org-uuid" });

    const { url, init } = last();
    expect(url).toBe("https://api.kryard.com/client/v1/config"); // trailing slash trimmed
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>)["x-kryard-project"]).toBe("proj_abc");
    // No Origin sent unless explicitly provided (browsers set it themselves).
    expect((init?.headers as Record<string, string>)["origin"]).toBeUndefined();
  });

  it("sends an explicit Origin when provided (server-side use)", async () => {
    const { fetchFn, last } = stubFetch({ ok: true, status: 200, body: { projectId: "p", organizationId: "o" } });
    const client = new KryardProjectClient({ projectId: "proj_abc", baseUrl: "https://api.kryard.com", fetchFn, origin: "https://app.example.com" });
    await client.getConfig();
    expect((last().init?.headers as Record<string, string>)["origin"]).toBe("https://app.example.com");
  });

  it("throws a labeled error on a non-ok response (e.g. 403 origin denied)", async () => {
    const { fetchFn } = stubFetch({ ok: false, status: 403, body: { message: "origin not allowed" } });
    const client = new KryardProjectClient({ projectId: "proj_abc", baseUrl: "https://api.kryard.com", fetchFn });
    await expect(client.getConfig()).rejects.toThrow(/project config failed with 403/);
  });
});
