# @crifine/sdk

Types, the published measurement method, and an **independent verifier** for
Crifine execution estimates.

```bash
npm install @crifine/sdk
```

Zero runtime dependencies. Node 20+, Workers, Deno, browser.

---

## Why this package exists

Crifine's central claim is that its numbers can be checked. An `evidence_url`
alone does not deliver that — it hands you snapshots without a way to recompute
from them, so you still have to trust that the published figure actually came
from the data beside it.

This package closes that gap. `walkLadder` is the measurement method in full,
and `verify` recomputes any published estimate from its own evidence and tells
you whether it holds up.

**A verifier that can only confirm proves nothing**, so this one is built and
tested to say no: the suite includes payloads with flattering prices, padded
ladders, mislabelled sizes and hidden closed markets, and asserts that each is
rejected.

## Verify a published number

```ts
import { verifyUrl } from "@crifine/sdk";

const verdict = await verifyUrl(
  "https://crifine.app/api/v1/exit/aave-v3-weth",
);

if (!verdict.matches) {
  console.error("published figure does not follow from its evidence:", verdict.problems);
}
console.log(verdict.computed, verdict.published, verdict.deltaBps);
```

No account, no key. The evidence endpoints are free and permanent.

## Run the method yourself

```ts
import { walkLadder } from "@crifine/sdk/ladder";

const result = walkLadder(
  [
    { bps: 5,   usd: 612_000 },
    { bps: 10,  usd: 548_000 },
    { bps: 25,  usd: 471_000 },
  ],
  4820,        // oracle price
  1_000_000,   // the size you actually want to move
);

result.exitGapPct;   // what it costs you to act on that price
result.exceedsBook;  // true = past the edge of the data, not a price
```

Pure function: no network, no clock, no hidden configuration. Same inputs,
same number, anywhere.

### How much can I actually move?

```ts
import { maxSizeFor } from "@crifine/sdk/ladder";

maxSizeFor(levels, 4820, -2);  // largest size that clears within 2%
```

The inverse of the walk, and usually the question that comes first. It never
returns a size past the observed book — an answer that needs unmeasured depth
is not an answer.

### Check a ladder before trusting it

```ts
import { validateLadder, fromCumulative } from "@crifine/sdk/ladder";

validateLadder(levels);  // [] when the ladder is usable
```

The failure this catches is the quiet one: cumulative figures passed in as
incremental. Nothing throws, every number looks plausible, and the book appears
several times deeper than it is — an error in the exact direction that gets
someone hurt.

### Two things the method insists on

- **Size is required.** There is no such thing as *the* fill price, only a fill
  price for a size. `walkLadder` throws on a size of zero.
- **Past the book is flagged, not extrapolated.** When a size exceeds the whole
  observed book, `exceedsBook` is `true` and the remainder is charged at a
  penalty rate. Treat that result as *"we do not know"*, not as a price.

## Decide what to do about it

```ts
import { decide, blocks } from "@crifine/sdk/policy";

const decision = decide(estimate, { maxGapPct: -2, minDaysObserved: 30 });
decision.action;  // "proceed" | "resize" | "hold" | "defer" | "refuse"
```

Every agent writes this branch. Writing it once means the **ordering** is
settled once — and the ordering is the part people get wrong. A size past the
edge of the book refuses before the gap is even considered: unmeasured is not a
kind of expensive.

## Derivations, also in the open

The behaviours the docs describe are implemented here too, so you can reproduce
them from a history payload instead of taking the server's word for it:

```ts
import { stressWindow, depthDecay, rankRoutes, gapSeries } from "@crifine/sdk/derive";

stressWindow(history.series, 7);   // worst point in the window, not the average
depthDecay(history.series);        // how fast the book thinned after a move
rankRoutes(estimates);             // best venue at one size — refuses mixed sizes
gapSeries(history.series, ladder, 5_000_000);  // the record, at *your* size
```

`rankRoutes` throws if the estimates were computed at different sizes: books
differ in shape, not just level, so ranking across sizes compares things that
were never measured against each other.

## Call the API

```ts
import { CrifineClient } from "@crifine/sdk";

const crifine = new CrifineClient();

const estimate = await crifine.exit("aave-v3-weth", 5_000_000);
const evidence = await crifine.evidence("aave-v3-weth"); // free, keyless

// Paging is an explicit choice: on a priced API, "fetch all of it" is a
// decision, not a convenience.
for await (const pool of crifine.allPools({ chain: "ethereum" })) {
  console.log(pool.pool);
}
```

Payment is **injected, not bundled** — pass any `fetch`, including one wrapped
by [`@crifine/x402`](https://github.com/crifine/crifine-x402), and this package
stays dependency-free for callers who only read the free endpoints.

```ts
import { x402Fetch } from "@crifine/x402";

const crifine = new CrifineClient({
  fetch: x402Fetch({ account, maxPerCall: 0.01, network: "base" }),
});
```

## What is live

| Surface | Status |
|---|---|
| `walkLadder`, `slippageCurve`, `fromCumulative` | **Live** — pure, no API needed |
| `verify`, `verifyUrl` | **Live** against any evidence payload |
| `CrifineClient` evidence + fragility | Free and keyless once the API ships |
| `CrifineClient` exit / ladder / history | **Not serving yet** — the contract is published so you can build against it |

The API is pre-GA. Field *additions* can land without notice; renames and
removals get 90 days. See the [changelog](https://crifine-docs.crifine.workers.dev/changelog)
for what actually shipped — if it is not there, it is not live.

## Related

| Package | Purpose |
|---|---|
| [`@crifine/x402`](https://github.com/crifine/crifine-x402) | Pay per request in USDC, no account |
| [`@crifine/cli`](https://github.com/crifine/crifine-cli) | Terminal and CI, with meaningful exit codes |
| [`@crifine/mcp-server`](https://github.com/crifine/crifine-mcp-server) | Expose all of this to AI agents over MCP |

## Development

```bash
pnpm install
pnpm test        # 75 tests, including the ones that must fail to pass
pnpm typecheck
pnpm build
```

MIT.
