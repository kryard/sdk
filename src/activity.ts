/**
 * activity.ts — the Turnkey-compatible activity submit primitive.
 *
 * Every sensitive Kryard operation (create key, sign, export) is an `activity`.
 * The wire shape is single-nested Turnkey style:
 *
 *   POST /public/v1/submit/<name>
 *   body = { type, timestampMs, organizationId, parameters: {...} }   (X-Stamped)
 *   → { activity: { id, status, type, result: { <typeResult>: {...} }, failure, ... } }
 *
 * `submitActivity` stamps the EXACT body string, POSTs it, parses the envelope,
 * throws on a FAILED status (carrying the server's failure code + message), and
 * returns the typed `<type>Result` object.
 */
import type { FetchFn, Stamper } from "./client.js";
import { stampAndPost } from "./http.js";

const STATUS_COMPLETED = "ACTIVITY_STATUS_COMPLETED";
const STATUS_FAILED = "ACTIVITY_STATUS_FAILED";

/** Failure payload surfaced by a FAILED (or unexpected non-completed) activity. */
export interface ActivityFailure {
  code: string;
  message: string;
}

/** Thrown when an activity does not reach ACTIVITY_STATUS_COMPLETED. */
export class ActivityError extends Error {
  /** The typed failure code (e.g. "PRIVATE_KEY_NOT_FOUND", "POLICY_DENIED"). */
  readonly code: string;
  /** The activity status the server reported (FAILED, PENDING, …). */
  readonly status: string;
  /** The activity id, when the envelope carried one. */
  readonly activityId?: string;
  /** The full raw response body, for debugging. */
  readonly raw: unknown;

  constructor(opts: { code: string; message: string; status: string; activityId?: string; raw: unknown }) {
    super(opts.message);
    this.name = "ActivityError";
    this.code = opts.code;
    this.status = opts.status;
    this.activityId = opts.activityId;
    this.raw = opts.raw;
  }
}

/** The minimal Turnkey activity envelope we parse. */
export interface ActivityEnvelope {
  activity?: {
    id?: string;
    status?: string;
    type?: string;
    result?: Record<string, unknown>;
    failure?: { code?: unknown; message?: unknown } | null;
  };
}

/** The parsed, successful result of an activity. */
export interface ActivityOutcome<R> {
  activityId: string;
  status: string;
  /** The typed `<type>Result` object (e.g. signTransactionResult). */
  result: R;
}

export interface SubmitActivityOptions {
  baseUrl: string;
  organizationId: string;
  stamper: Stamper;
  fetchFn: FetchFn;
  nowMs: () => number;
  /** The submit path segment, e.g. "sign_transaction". */
  name: string;
  /** The activity type enum, e.g. "ACTIVITY_TYPE_SIGN_TRANSACTION_V2". */
  type: string;
  /** The activity parameters object. */
  parameters: Record<string, unknown>;
  /**
   * The key under `activity.result` that carries this activity's typed result,
   * e.g. "signTransactionResult". When omitted, the whole `result` object is
   * returned as the typed result.
   */
  resultKey?: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Stamp + POST an activity, parse the single-nested envelope, throw on FAILED,
 * and return the typed `<resultKey>` result.
 *
 * @typeParam R — the shape of the `<type>Result` object.
 */
export async function submitActivity<R>(opts: SubmitActivityOptions): Promise<ActivityOutcome<R>> {
  // Build the EXACT body string we stamp + send. Field order matches the
  // dashboard's wire-frozen shape (type, timestampMs, organizationId, parameters).
  const rawBody = JSON.stringify({
    type: opts.type,
    timestampMs: String(opts.nowMs()),
    organizationId: opts.organizationId,
    parameters: opts.parameters,
  });

  const url = `${opts.baseUrl}/public/v1/submit/${opts.name}`;
  const res = await stampAndPost(opts.fetchFn, opts.stamper, url, rawBody);

  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }

  // Transport-level (non-2xx) error: surface the Turnkey error envelope message.
  if (!res.ok) {
    const rec = asRecord(json);
    const message = str(rec.message) ?? (typeof json === "string" && json ? json : `HTTP ${res.status}`);
    throw new ActivityError({
      code: str(rec.code) ?? `HTTP_${res.status}`,
      message,
      status: `HTTP_${res.status}`,
      raw: json,
    });
  }

  const activity = asRecord((json as ActivityEnvelope).activity);
  const status = str(activity.status) ?? "UNKNOWN";
  const activityId = str(activity.id);

  if (status !== STATUS_COMPLETED) {
    const failure = asRecord(activity.failure);
    const code = str(failure.code) ?? (status === STATUS_FAILED ? "ACTIVITY_FAILED" : status);
    const message =
      str(failure.message) ?? `activity ${opts.name} did not complete (status: ${status})`;
    throw new ActivityError({ code, message, status, activityId, raw: json });
  }

  const result = asRecord(activity.result);
  const typed = (opts.resultKey ? result[opts.resultKey] : result) as R;

  return { activityId: activityId ?? "", status, result: typed };
}
