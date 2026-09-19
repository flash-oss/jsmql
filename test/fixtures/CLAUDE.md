# test/fixtures/ — the live-MongoDB integration dataset

This directory holds a small, deterministic e-commerce dataset, and the code that
serves it to [`test/integration.test.ts`](../integration.test.ts) from a real
MongoDB. The integration suite runs jsmql's emitted MQL against this data, and
asserts on the documents that come back. This is the only way to *prove* that a
query which looks valid actually runs, and returns what the user meant (HR3; see
[docs/LANG_RULES.md](../../docs/LANG_RULES.md)).

## The instance — the only one this project connects to

**HARD RULE: every MongoDB connection from this project goes to port `27018`.**
MongoDB's default port carries the developer's own instance and their real work.
This project never touches that port: not to read from it, not to probe it, not
to measure it. [`test/no-default-port.test.ts`](../no-default-port.test.ts) fails
the build when a file names that port, so this rule cannot rot back into the code.

This is why the project runs its own instance, and does not use the developer's
instance. `--auth` applies to a whole instance, and the server-enforced read-only
role for the integration dataset needs it. Turning `--auth` on for the
developer's own `mongod` would force credentials onto every other service on
their machine.

- The instance listens on **port `27018`**, with its dbpath outside the repository.
- The instance runs with **`--auth` enabled**. It creates three users on the first start:
  - `jsmql_admin` (root) — the seeder in [instance.ts](instance.ts) is the
    **only** user of this account.
  - `jsmql_ro` (`read` on `jsmql_fixture`) — `integration.test.ts` uses this
    account. The server rejects any write attempt from it, so a test run
    **cannot** change the dataset.
  - `jsmql_scratch` (`readWrite` on the `SCRATCH_DBS` list in [config.ts](config.ts),
    and on nothing else) — `test/probe` and every suite that seeds its own
    documents use this account. Each such suite owns one database in that list,
    because two suites name a collection `orders`, and vitest runs suites in
    parallel. The list itself is the grant, so a new live suite adds its
    database name to the list and re-runs `npm run fixture:up`. The guard test
    above reports it when a suite forgets this step.
- The dbpath is **`~/.jsmql-fixture/`**, outside the repository and outside the
  worktree. This way, it survives worktree cleanup, and branches share it. It is
  throwaway data, and safe to delete.

The credentials are hard-coded in [config.ts](config.ts), and they are
deliberately **not secret**. This is a local, disposable fixture, and its only
job is to enforce the read-only role. Do not reuse this pattern for anything real.

## Lifecycle (npm scripts → instance.ts)

```sh
npm run fixture:up      # start the :27018 instance if it is down, then create the users and seed the data
npm run fixture:seed    # seed again only — idempotent; it skips the write when the hash matches
npm run fixture:status  # is it listening? are the users set up? which dataset version is seeded?
npm run fixture:down    # shut the instance down (the data stays on disk)
npm run fixture:reset   # shut down, wipe ~/.jsmql-fixture, start fresh, then seed
```

On macOS, `mongod` rejects `--fork`. So [instance.ts](instance.ts) launches it
detached and `unref`'d, and polls it until it accepts a connection. On a fresh
dbpath, this instance creates the admin user through MongoDB's **localhost
exception**. That exception is active only until the first user exists.

## The dataset (dataset.ts)

The dataset has five collections: `users`, `products`, `orders`, `shipments` and
`reviews` (`EXPECTED_COUNTS` in `dataset.ts` gives the live count of each). The
collections carry realistic cross-references: `orders.userId` points to `users`;
`orders.items[].productId` points to `products`; `shipments.orderId` points to
`orders`; `shipments.userId` points to `users` too, denormalised from the owning
order's user, so that a nested lookup can trace a shipment back to the outer
user; and `reviews` points to both `users` and `products`.

Three invariants make exact assertions possible:

1. **Determinism is a HARD rule.** Use a fixed ObjectId, a fixed date, and a
   fixed number. **Never use `Math.random()` or `Date.now()`.** A test asserts
   an exact returned document, so the data must be byte-identical everywhere.
2. **Each ObjectId carries a plausible timestamp prefix** (`0x65000000…`, from
   2023). An all-zero prefix decodes to 1970, and jsmql's `0x…` literal guard
   (`assertPlausibleObjectId`) would reject it. That would make "find by `_id`
   through the `0x` literal" impossible to query. A tag nibble (`a` for `users`,
   up to `e` for `reviews`) plus an index keeps each id readable in output.
3. **A derived field is computed, never typed by hand.** `buildOrders()` fills
   each line's `unitPrice` and `price` from the product catalogue, and sums the
   order `total`. This way, the values can never drift apart. `validateDataset()`
   checks each total, each line's math, and each reference at seed time, and it
   throws on any mismatch.

`DATASET_HASH` is a content fingerprint: a canonical serialization run through
sha1. The seeder stores this fingerprint in `__fixture_meta`, and re-injects the
data **only** when the fingerprint changes. `fixtureReady()` and
`assertIntegrity()` in `client.ts` use the fingerprint to skip a stale run, and
to fail loudly when the data has drifted.

## Growing and changing the data

**This dataset is meant to grow.** It is not frozen. Expand it freely whenever a
new query, operator, stage, or edge case needs realistic data to run against: add
a document, a field, a new collection, or a deliberately null or boundary value.
A richer fixture means that more of jsmql's surface gets *executed*, not just
*emitted*. When you add a feature whose realistic test would benefit from live
data, extend this dataset instead of inventing a one-off dataset.

**After any change to the data, re-insert it into `mongod`.** The integration
tests query the *server*, not `dataset.ts`, so a source edit has no effect until
you re-seed the data:

```sh
npm run fixture:seed     # re-inject the data if it changed (the content hash makes this idempotent)
# or, for a clean rebuild:
npm run fixture:reset    # wipe the instance's dbpath, then seed from scratch
```

Follow these rules when you edit [dataset.ts](dataset.ts):

- Edit the `*Specs` arrays, or the document arrays. `DATASET_HASH` then changes,
  so the next `fixture:seed` re-injects the data on its own. When the hash does
  not change, `fixture:seed` writes nothing. Keep `COLLECTIONS` in
  [config.ts](config.ts) in sync when you add or remove a collection.
- Keep the data **deterministic** (HARD rule): a fixed id, date and number, and
  never `Math.random` or `Date.now`. Use the `ID` helper for a new id, so that
  it keeps a plausible timestamp prefix.
- `validateDataset()` runs at seed time. It rejects a mismatched order total, a
  broken reference, or a duplicate id, before any of these can corrupt a run.
- Any integration assertion that depended on the old data now fails.
  **Re-derive each expected value from a real run. Never guess a value by hand
  (HR3).** The fastest way is a throwaway probe script under `tmp/` that imports
  `jsmql` and `connectReadOnly()`, runs the query, and prints the result; delete
  the script when you finish. After you re-seed, run
  `npm run fixture:up && npm test`, and update each affected expectation to
  match what the server actually returns.

## Files

| File | Owns |
|---|---|
| [config.ts](config.ts) | Connection and process constants: port, dbpath, credentials, URIs, collection names. |
| [dataset.ts](dataset.ts) | The deterministic documents, `DATASET_HASH`, `EXPECTED_COUNTS`, `validateDataset()`, and the `ID` helpers. |
| [instance.ts](instance.ts) | The lifecycle CLI: up, seed, status, down, reset. It starts `mongod`, bootstraps the users, and seeds the data idempotently. This is the **only** writer. |
| [client.ts](client.ts) | Read-only access for tests: `connectReadOnly()`, `fixtureReady()`, `assertIntegrity()`. |
