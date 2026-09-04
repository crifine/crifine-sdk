/**
 * Typed client for the Crifine API.
 *
 * Payment is injected, not bundled: pass any `fetch` — including one wrapped by
 * `@crifine/x402` — and this stays a thin, dependency-free layer over HTTP.
 * Bundling a payment library into the core would force a wallet dependency on
 * callers who only ever read the free verification endpoints.
 */

import type {
  DepthHistory,
  Evidence,
  ExitEstimate,
  FragilityRow,
  Ladder,
  Pool,
} from "./types.js";

export type ClientOptions = {
  /** Defaults to the public API. */
  baseUrl?: string;
  /** Defaults to the free, keyless verification host. */
  evidenceBaseUrl?: string;
  /** Inject a paying or instrumented fetch. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Abort a call that outlives its usefulness. Defaults to 5000 ms. */
  timeoutMs?: number;
  /**
   * Retries for transient failures (429 and 5xx). Defaults to 2.
   *
   * Only idempotent GETs are issued by this client, so a retry cannot
   * double-charge or double-act. A 402 is never retried here — payment belongs
   * to the injected fetch, and retrying it blind is how an unattended agent
   * pays twice.
   */
  retries?: number;
};

export class CrifineError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CrifineError";
  }
}

const DEFAULT_BASE = "https://api.crifine.app/v1";
const DEFAULT_EVIDENCE_BASE = "https://crifine.app/api/v1";

export class CrifineClient {
  readonly #baseUrl: string;
  readonly #evidenceBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #retries: number;

  constructor(options: ClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this.#evidenceBaseUrl = (options.evidenceBaseUrl ?? DEFAULT_EVIDENCE_BASE).replace(/\/$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#retries = options.retries ?? 2;
  }

  /** Honour `Retry-After` when the server states one; back off otherwise. */
  static #delayFor(response: Response, attempt: number): number {
    const header = response.headers.get("retry-after");
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
    }
    return Math.min(250 * 2 ** attempt, 4000);
  }

  async #get<T>(base: string, path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let response!: Response;

    for (let attempt = 0; ; attempt++) {
      response = await this.#fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });

      const transient = response.status === 429 || response.status >= 500;
      if (!transient || attempt >= this.#retries) break;

      await new Promise((resolve) =>
        setTimeout(resolve, CrifineClient.#delayFor(response, attempt)),
      );
    }

    if (!response.ok) {
      let code: string | undefined;
      let message = `${response.status} ${response.statusText}`;
      try {
        const body = (await response.json()) as { error?: { code?: string; message?: string } };
        code = body.error?.code;
        if (body.error?.message) message = body.error.message;
      } catch {
        // A non-JSON error body is still an error; the status carries it.
      }
      throw new CrifineError(message, response.status, code);
    }

    return (await response.json()) as T;
  }

  /**
   * What a stated size actually clears at.
   *
   * `sizeUsd` is required and has no default — there is no such thing as *the*
   * fill price, only a fill price for a size.
   */
  async exit(
    pool: string,
    sizeUsd: number,
    options: { window?: string; side?: "buy" | "sell" } = {},
  ): Promise<ExitEstimate> {
    // `async` on purpose: a method typed as returning a Promise must never
    // throw synchronously, or `client.exit(...).catch(handle)` misses the
    // error entirely — the handler is attached after the throw has escaped.
    if (!(sizeUsd > 0)) {
      throw new RangeError("sizeUsd is required and must be greater than zero");
    }
    return this.#get<ExitEstimate>(this.#baseUrl, `/exit/${encodeURIComponent(pool)}`, {
      size_usd: sizeUsd,
      window: options.window,
      side: options.side,
    });
  }

  ladder(pool: string): Promise<Ladder> {
    return this.#get<Ladder>(this.#baseUrl, `/ladder/${encodeURIComponent(pool)}`);
  }

  pools(filter: { chain?: string; venue?: string; kind?: string } = {}): Promise<{ data: Pool[]; next_cursor: string | null }> {
    return this.#get(this.#baseUrl, "/pools", filter);
  }

  history(pool: string, options: { from?: string; to?: string; sizeUsd?: number; resolution?: string } = {}): Promise<DepthHistory> {
    return this.#get<DepthHistory>(this.#baseUrl, `/history/${encodeURIComponent(pool)}`, {
      from: options.from,
      to: options.to,
      size_usd: options.sizeUsd,
      resolution: options.resolution,
    });
  }

  /**
   * Every pool, following the cursor.
   *
   * An async iterator rather than a method that returns everything: a caller
   * looking for one venue should not pay for pages it will discard, and on a
   * priced API "fetch all of it" is a decision worth making explicitly.
   */
  async *allPools(filter: { chain?: string; venue?: string; kind?: string } = {}): AsyncGenerator<Pool> {
    let cursor: string | undefined;
    const seen = new Set<string>();

    do {
      const page: { data: Pool[]; next_cursor: string | null } = await this.#get(
        this.#baseUrl,
        "/pools",
        { ...filter, cursor },
      );

      for (const pool of page.data) yield pool;

      // A server that returns its own cursor back would loop forever; stop
      // rather than paginate in place until someone notices the bill.
      const next = page.next_cursor ?? undefined;
      if (next !== undefined && seen.has(next)) {
        throw new CrifineError("pagination cursor repeated — refusing to loop", 500);
      }
      if (next !== undefined) seen.add(next);
      cursor = next;
    } while (cursor !== undefined);
  }

  /** Free and keyless — no payment wrapper needed. */
  fragility(): Promise<{ as_of: string; method_version: string; rows: FragilityRow[] }> {
    return this.#get(this.#evidenceBaseUrl, "/fragility");
  }

  /** Free and keyless. Feed the result to `verify()` to check it yourself. */
  evidence(pool: string): Promise<Evidence> {
    return this.#get<Evidence>(this.#evidenceBaseUrl, `/exit/${encodeURIComponent(pool)}`);
  }
}
