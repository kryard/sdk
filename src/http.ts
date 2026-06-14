/**
 * http.ts — the shared X-Stamp + POST primitive used by every Kryard client.
 *
 * Both `KryardRelayClient` (relay) and `KryardClient` (wallets/signing) stamp the
 * EXACT raw JSON body and POST it. This module factors that one operation out so
 * the two clients share identical auth + transport behaviour. The stamp covers the
 * precise string we send — we never re-serialize after stamping.
 */
import type { FetchFn, Stamper } from "./client.js";

/** Stamp `rawBody` and POST it to `url`. Returns the raw `Response`-like object.
 *  Callers own status handling + body parsing (the relay + activity envelopes
 *  differ), so this stays a thin transport. */
export async function stampAndPost(
  fetchFn: FetchFn,
  stamper: Stamper,
  url: string,
  rawBody: string,
): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }> {
  const { stampHeaderName, stampHeaderValue } = await stamper.stamp(rawBody);
  return fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", [stampHeaderName]: stampHeaderValue },
    body: rawBody,
  });
}
