# Arkiv feedback

From building on `@arkiv-network/sdk` 1.0.1 against Rabdi, on Node 26.11 and in Chromium.

## What worked well

- **Schema types in queries.** A selection, a `where` on an unindexed column and a wrongly typed value all failed at compile time.
  Our whole registry typechecked on the first try.
- **`skipped` on a query page.** It assumes the right thing about a public store: anyone can write a row that does not fit. It saved
  us from writing that handling ourselves.
- **Expiry as a first-class idea.** Our lock needed no cleanup code at all.

## Bugs

### 1. A keyless query that runs out of budget hangs for 20 minutes with no error

**Expected:** the call fails promptly with the server's reason, or at least with a warning that it is waiting.

**Actual:** past its budget the public endpoint answers:

    HTTP 429
    ratelimit: limit=10000, remaining=0, reset=1229
    retry-after: 1229
    {"error":"ANON_COST_LIMITED","message":"unauthenticated query budget exhausted; get an API key at https://hub.arkiv.network for a monthly quota"}

viem's HTTP transport honours `Retry-After`, so the SDK's documented `http()` setup waits out all 1,229 seconds without saying
anything. A wallet checking a key before signing looks frozen.

**Reproduce:** with the public budget exhausted, run

    const client = createPublicClient({ chain: rabdi({ accessKey: "" }), transport: http() })
    await client.select({ $key: true }).where(eq("category", "docs")).limit(1).fetch()

**Workaround:** `http(undefined, { retryCount: 0 })`, which fails at once. **Suggestion:** document this next to the rate limit
warning, or have the SDK cap how long it will wait.

### 2. The keyless budget does not behave like one budget

**Expected:** a 429 until the window resets.

**Actual:** the same request, sent three times within two seconds from one machine, returned `429`, `429`, then `200` with
`ratelimit: limit=2000, remaining=1999, reset=10`. It also ran out after far fewer than the 1,000 queries that a cost of 10 against
a limit of 10,000 suggests, from our side at least. We cannot see whether others share it.

**Reproduce:** repeat any `arkiv_query` without a key while the budget is out, and log the `ratelimit` header of each response.

**Suggestion:** say whether the budget is per IP or shared, because that decides whether a judge's first query will work.

### 3. The SDK prints an experimental warning on every run under recent Node

**Expected:** no output from a library that was not asked to log.

**Actual:** `ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.`

**Why:** `src/utils/logger.ts` treats `"localStorage" in globalThis` as meaning "this is a browser", and recent Node defines it.

**Reproduce:** make any query under Node 26. **Suggestion:** check for `window` first.

## What to improve

- **Say what a query costs, and what the budget is, in the README.** The `Arkiv-Cost` and `Arkiv-Quota-Used-Percent` headers are
  useful, and we only found them by reading raw responses. The README says "heavily rate limited" and stops there.
- **Strict `Content-Type` blocks private routes.** Requests through the Nym route of `anon-rpc` arrive without a usable content type,
  and the RPC answers `Supplied content type is not allowed`. This may be the worker's fault more than Arkiv's, but the effect is
  that a privacy-minded wallet cannot read Arkiv over a mixnet, so our dashboard has to ask the user before reading directly.
