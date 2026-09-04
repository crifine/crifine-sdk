import assert from "node:assert/strict";
import { test } from "node:test";
import { CrifineClient, CrifineError } from "../src/client.js";

const ok = (body: unknown) => async () => Response.json(body);

test("a size is required — the client refuses before the network", async () => {
  const client = new CrifineClient({ fetch: ok({}) });
  await assert.rejects(() => client.exit("aave-v3-weth", 0), RangeError);
});

test("size and window reach the query string", async () => {
  let seen: URL | undefined;
  const client = new CrifineClient({
    fetch: async (input) => {
      seen = new URL(String(input));
      return Response.json({ pool: "aave-v3 / WETH" });
    },
  });

  await client.exit("aave-v3-weth", 5_000_000, { window: "7d" });
  assert.equal(seen?.pathname, "/v1/exit/aave-v3-weth");
  assert.equal(seen?.searchParams.get("size_usd"), "5000000");
  assert.equal(seen?.searchParams.get("window"), "7d");
});

test("evidence and fragility use the free keyless host, not the paid one", async () => {
  const hosts: string[] = [];
  const client = new CrifineClient({
    fetch: async (input) => {
      hosts.push(new URL(String(input)).origin);
      return Response.json({});
    },
  });

  await client.evidence("aave-v3-weth");
  await client.fragility();
  assert.deepEqual(hosts, ["https://crifine.app", "https://crifine.app"]);
});

test("an API error becomes a typed error carrying the code", async () => {
  const client = new CrifineClient({
    fetch: async () =>
      Response.json(
        { error: { code: "size_required", message: "size_usd is required" } },
        { status: 400 },
      ),
  });

  await assert.rejects(
    () => client.exit("aave-v3-weth", 1000),
    (error: unknown) => {
      assert.ok(error instanceof CrifineError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "size_required");
      return true;
    },
  );
});

test("a non-JSON error body still surfaces the status", async () => {
  const client = new CrifineClient({
    fetch: async () => new Response("<html>502</html>", { status: 502, statusText: "Bad Gateway" }),
  });

  await assert.rejects(() => client.exit("aave-v3-weth", 1000), /502/);
});

test("a 503 is retried, then succeeds", async () => {
  let attempts = 0;
  const client = new CrifineClient({
    retries: 2,
    fetch: async () => {
      attempts += 1;
      return attempts < 3
        ? new Response("", { status: 503, headers: { "retry-after": "0" } })
        : Response.json({ pool: "aave-v3 / WETH" });
    },
  });

  await client.exit("aave-v3-weth", 1000);
  assert.equal(attempts, 3);
});

test("retries are bounded — a permanently broken server still errors", async () => {
  let attempts = 0;
  const client = new CrifineClient({
    retries: 1,
    fetch: async () => {
      attempts += 1;
      return new Response("", { status: 500, headers: { "retry-after": "0" } });
    },
  });

  await assert.rejects(() => client.exit("aave-v3-weth", 1000));
  assert.equal(attempts, 2, "one retry means two attempts, not endless ones");
});

test("a 4xx is not retried — the request is wrong, repeating it will not help", async () => {
  let attempts = 0;
  const client = new CrifineClient({
    retries: 3,
    fetch: async () => {
      attempts += 1;
      return Response.json({ error: { code: "pool_not_found" } }, { status: 404 });
    },
  });

  await assert.rejects(() => client.exit("nope", 1000));
  assert.equal(attempts, 1);
});

test("a 402 is never retried — payment belongs to the injected fetch", async () => {
  let attempts = 0;
  const client = new CrifineClient({
    retries: 3,
    fetch: async () => {
      attempts += 1;
      return new Response("", { status: 402 });
    },
  });

  await assert.rejects(() => client.exit("aave-v3-weth", 1000));
  assert.equal(attempts, 1, "retrying a 402 blind is how an agent pays twice");
});
