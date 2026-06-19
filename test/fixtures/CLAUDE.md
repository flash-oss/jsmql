# test/fixtures/ — the live-MongoDB integration dataset

This directory holds a small, deterministic e-commerce dataset and the machinery
that serves it to [`test/integration.test.ts`](../integration.test.ts) from a real
MongoDB. The integration suite runs jsmql's emitted MQL against this data and
asserts on the documents that come back — the only way to *prove* a query that
looks valid actually runs and returns what the user meant (HR3, see
[docs/LANG_RULES.md](../../docs/LANG_RULES.md)).

## The dedicated instance (why it's separate from the probe)

[`test/probe`](../probe) runs ad-hoc MQL against the developer's **primary**
mongod (`mongodb://127.0.0.1:27017`) with throwaway docs. The integration suite
is different: it needs a **stable, never-mutated** dataset and a **server-enforced
read-only** guarantee. A real read-only role requires `authorization: enabled`,
which is instance-wide — turning it on for the primary mongod would force
credentials onto every other local service. So instead we run a **second,
dedicated mongod**:

- **Port `27018`** (primary stays on `27017`, untouched and auth-free).
- **`--auth` enabled**, with two users created on first start:
  - `jsmql_admin` (root) — used **only** by the seeder in [instance.ts](instance.ts).
  - `jsmql_ro` (`read` on `jsmql_fixture`) — used by the tests. The server
    rejects any write it attempts, so a test run **cannot** mutate the dataset.
- **dbpath `~/.jsmql-fixture/`** — outside the repo/worktree, so it survives
  worktree cleanup and is shared across branches. Throwaway; safe to delete.

Credentials are hard-coded in [config.ts](config.ts) and deliberately **not
secret** — this is a local, disposable fixture whose only job is to enforce the
read-only role. Don't reuse the pattern for anything real.

## Lifecycle (npm scripts → instance.ts)

```sh
npm run fixture:up      # start the :27018 instance (if down), bootstrap users, seed
npm run fixture:seed    # (re)seed only — idempotent, skips when the hash matches
npm run fixture:status  # listening? auth bootstrapped? which dataset version is seeded?
npm run fixture:down    # shut the instance down (data persists on disk)
npm run fixture:reset   # down + wipe ~/.jsmql-fixture + fresh up + seed
```

`mongod` on macOS rejects `--fork`, so [instance.ts](instance.ts) launches it
detached + `unref`'d and polls until it accepts connections. On a fresh dbpath the
admin user is created through MongoDB's **localhost exception** (active only until
the first user exists).

## The dataset (dataset.ts)

Five collections — `users` (8), `products` (10), `orders` (20), `shipments` (15),
`reviews` (12) — with realistic cross-references (`orders.userId`→users,
`orders.items[].productId`→products, `shipments.orderId`→orders, reviews→both).

Three invariants make exact assertions possible:

1. **Determinism is a HARD rule.** Fixed ObjectIds, fixed dates, fixed numbers —
   **no `Math.random()`, no `Date.now()`**. Tests assert exact returned documents,
   so the data must be byte-identical everywhere.
2. **ObjectIds carry a plausible timestamp prefix** (`0x65000000…`, 2023). An
   all-zero prefix decodes to 1970 and jsmql's `0x…` literal guard
   (`assertPlausibleObjectId`) would reject it — making "find by `_id` via the `0x`
   literal" un-queryable. The tag nibble (`a`=users … `e`=reviews) + index keeps
   ids readable in output.
3. **Derived fields are computed, not typed.** `buildOrders()` fills each line's
   `unitPrice`/`price` from the product catalogue and sums the order `total`, so
   they can never drift. `validateDataset()` re-checks totals, line math, and
   reference integrity at seed time and throws on any mismatch.

`DATASET_HASH` is a content fingerprint (canonical serialization → sha1). The
seeder stores it in `__fixture_meta` and re-injects **only** when it changes;
`client.ts`'s `fixtureReady()`/`assertIntegrity()` use it to skip stale runs and
fail loudly on drift.

## Expanding / changing the data

**This dataset is meant to grow.** It is not frozen — expand it freely whenever a
new query, operator, stage, or edge case needs realistic data to run against (add
documents, fields, a new collection, a deliberately-null or boundary value, …).
A richer fixture means more of jsmql's surface gets *executed*, not just
*emitted*. When adding a feature whose realistic test would benefit from live
data, prefer extending this dataset over inventing a one-off.

**After ANY change to the data you MUST re-insert it into mongod** — the
integration tests query the *server*, not `dataset.ts`, so a source edit has no
effect until you re-seed:

```sh
npm run fixture:seed     # re-inject if changed (the content hash makes it idempotent)
# or, for a guaranteed-clean rebuild:
npm run fixture:reset    # wipe the instance's dbpath and seed from scratch
```

Mechanics and rules when you edit [dataset.ts](dataset.ts):

- Edit the `*Specs` arrays (or the doc arrays). `DATASET_HASH` changes, so the
  next `fixture:seed` re-injects automatically; if it didn't change, nothing is
  written. Keep `COLLECTIONS` in [config.ts](config.ts) in sync if you add or
  remove a collection.
- Keep it **deterministic** (HARD rule): fixed ids/dates/numbers, no
  `Math.random`/`Date.now`. Use the `ID` helper for new ids so the plausible
  timestamp prefix is preserved.
- `validateDataset()` runs at seed time — it will reject mismatched order
  totals, broken references, or duplicate ids before they corrupt a run.
- Any integration assertion that depended on the old data will now fail.
  **Re-derive expected values from a real run — never hand-guess them (HR3).**
  The fastest way is a throwaway probe script under `tmp/` that imports `jsmql`
  and `connectReadOnly()`, runs the query, and prints the result (delete it when
  done). After re-seeding, run `npm run fixture:up && npm test` and update the
  affected expectations to match what the server actually returns.

## Files

| File | Owns |
|---|---|
| [config.ts](config.ts) | Connection + process constants (port, dbpath, creds, URIs, collection names). |
| [dataset.ts](dataset.ts) | The deterministic docs, `DATASET_HASH`, `EXPECTED_COUNTS`, `validateDataset()`, `ID` helpers. |
| [instance.ts](instance.ts) | Lifecycle CLI (up/seed/status/down/reset) — starts mongod, bootstraps users, idempotent seed. The **only** writer. |
| [client.ts](client.ts) | Read-only access for tests: `connectReadOnly()`, `fixtureReady()`, `assertIntegrity()`. |
