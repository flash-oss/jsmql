// test/integration.test.ts — run jsmql's emitted MQL against a REAL MongoDB and
// assert on the documents that come back.
//
// Why this exists: a passing `toEqual(<MQL>)` in codegen/realistic only proves
// what jsmql *emits* — not that MongoDB *accepts and runs* it correctly. These
// tests close that gap. Each case compiles a jsmql source, runs it against the
// read-only fixture (test/fixtures/), and checks the returned data matches what
// the dataset implies. The expected values were derived from a live run, not
// guessed (see HR3 in docs/LANG_RULES.md and test/fixtures/CLAUDE.md).
//
// The suite skips itself unless the fixture instance is up and seeded with the
// current dataset, so `npm test` stays green for contributors who haven't run
// `npm run fixture:up`. To run it: `npm run fixture:up && npm test`.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, MongoClient } from "mongodb";
import { jsmql } from "../src/index.ts";
import { ID } from "./fixtures/dataset.ts";
import { assertIntegrity, connectReadOnly, fixtureReady } from "./fixtures/client.ts";

const ready = await fixtureReady();
if (!ready) {
  console.warn(
    "\n[integration] fixture instance not reachable/seeded — skipping integration tests." +
      '\n[integration] Run "npm run fixture:up" to start the dedicated :27018 mongod and seed it.\n',
  );
}

describe.skipIf(!ready)("integration: jsmql MQL against a live MongoDB", () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    ({ client, db } = await connectReadOnly());
    await assertIntegrity(db); // fail loudly if the on-disk dataset drifted
  });
  afterAll(async () => {
    await client?.close();
  });

  // ── helpers ─────────────────────────────────────────────────────────────
  // Route a compiled jsmql source to the matching driver call. find() is sorted
  // by _id so result order is deterministic regardless of natural order.
  const find = (coll: string, src: string) =>
    db
      .collection(coll)
      .find(jsmql(src) as Record<string, unknown>)
      .sort({ _id: 1 })
      .toArray();
  const aggregate = (coll: string, src: string) =>
    db
      .collection(coll)
      .aggregate(jsmql(src) as Record<string, unknown>[])
      .toArray();
  const hexes = (docs: { _id: unknown }[]) => docs.map((d) => String(d._id)).sort();
  const ids = (mk: (n: number) => { toHexString(): string }, ns: number[]) => ns.map((n) => mk(n).toHexString()).sort();

  // ── filters (db.coll.find) ────────────────────────────────────────────────

  // In-stock products in a price band. Indexable top-level filter, no $expr.
  it("filter: in-stock products priced 50..400", async () => {
    const rows = await find("products", `$.inStock === true && $.price >= 50 && $.price <= 400`);
    expect(hexes(rows)).toEqual(ids(ID.product, [1, 3, 5, 7]));
  });

  // `$.email != null` + equality — the null-vs-missing distinction matters here
  // (u5 has an explicit null email and must be excluded).
  it("filter: active users with a non-null email", async () => {
    const rows = await find("users", `$.email != null && $.status === "active"`);
    expect(hexes(rows)).toEqual(ids(ID.user, [1, 2, 3, 6, 8]));
  });

  // The `0x…` ObjectId literal, end-to-end: jsmql mints a live BSON ObjectId so
  // the query uses the _id index and returns the one document. (realistic.test.ts
  // "fetch a document by its ObjectId" only checks the *emitted* shape.)
  it("filter: fetch one document by its 0x ObjectId literal", async () => {
    const rows = await find("users", `$._id === 0x6500000000000000000000a1`);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { name: string }).name).toBe("Ada Lovelace");
  });

  // Date literal folded into the query doc (not trapped in $expr) + status match.
  it("filter: orders shipped on/after a date", async () => {
    const rows = await find("orders", `$.status === "shipped" && $.placedAt >= new Date("2026-06-01")`);
    expect(hexes(rows)).toEqual(ids(ID.order, [8, 9, 13, 15, 18, 19]));
  });

  it("filter: verified reviews rated 4 or higher", async () => {
    const rows = await find("reviews", `$.verified === true && $.rating >= 4`);
    expect(hexes(rows)).toEqual(ids(ID.review, [1, 2, 3, 5, 7, 9, 12]));
  });

  // ── pipelines (db.coll.aggregate) ─────────────────────────────────────────

  // Top-3 revenue leaderboard: $group then the `.toSorted(desc).slice(0,N)`
  // stream-chain idiom (→ $sort + $limit). Mirrors realistic.test.ts
  // "top-10 revenue leaderboard".
  it("pipeline: top-3 revenue leaderboard", async () => {
    const rows = await aggregate(
      "orders",
      `$group({ _id: $.userId, revenue: $sum($.total), orders: $sum(1) });
$$ = $$.toSorted((a, b) => b.revenue - a.revenue).slice(0, 3);`,
    );
    expect(rows.map((r) => ({ user: String(r._id), revenue: r.revenue, orders: r.orders }))).toEqual([
      { user: ID.user(3).toHexString(), revenue: 1620, orders: 4 },
      { user: ID.user(6).toHexString(), revenue: 1410, orders: 3 },
      { user: ID.user(1).toHexString(), revenue: 1320, orders: 3 },
    ]);
  });

  // Join orders→users, group revenue by the buyer's department. Exercises
  // $lookup + $unwind + $group + derived field, like realistic.test.ts
  // "top-orders report by department".
  it("pipeline: revenue by buyer department (lookup + unwind + group)", async () => {
    const rows = await aggregate(
      "orders",
      `$match($.status === "shipped" && $.placedAt >= new Date("2026-01-01"));
$lookup({ from: "users", localField: "userId", foreignField: "_id", as: "buyer" });
$unwind($.buyer);
$group({ _id: $.buyer.department, revenue: $sum($.total), orders: $sum(1) });
$set({ avgOrder: $round($.revenue / $.orders, 2) });
$sort({ revenue: -1 });
$limit(3);`,
    );
    expect(rows.map((r) => ({ dept: r._id, revenue: r.revenue, orders: r.orders, avgOrder: r.avgOrder }))).toEqual([
      { dept: "engineering", revenue: 2804, orders: 9, avgOrder: 311.56 },
      { dept: "support", revenue: 1320, orders: 2, avgOrder: 660 },
      { dept: "sales", revenue: 670, orders: 2, avgOrder: 335 },
    ]);
  });

  // Flatten line items across shipped orders, then the 3 most expensive lines.
  // `.flatMap(o => o.items).map(o => o.items)` → $unwind + $replaceWith. The 3rd
  // place is a 3-way tie at 400, so we assert the price sequence, not identity.
  it("pipeline: 3 most expensive line items across shipped orders", async () => {
    const rows = await aggregate(
      "orders",
      `$$ = $$.filter(o => o.status === "shipped").flatMap(o => o.items).map(o => o.items);
$sort({ price: -1 });
$limit(3);`,
    );
    expect(rows.map((r) => r.price)).toEqual([800, 500, 400]);
  });

  // Group a child collection by an enum field. $sort by _id keeps it deterministic.
  it("pipeline: shipment count by carrier", async () => {
    const rows = await aggregate("shipments", `$group({ _id: $.carrier, n: $sum(1) });\n$sort({ _id: 1 });`);
    expect(rows.map((r) => ({ carrier: r._id, n: r.n }))).toEqual([
      { carrier: "DHL", n: 3 },
      { carrier: "FedEx", n: 5 },
      { carrier: "UPS", n: 5 },
      { carrier: "USPS", n: 2 },
    ]);
  });

  // Group by a COMPUTED key: the email domain via `.split("@").at(1).toLowerCase()`
  // (the string-method chain from realistic.test.ts "email domain"), run as a
  // real $group _id expression.
  it("pipeline: user count by email domain (group by computed string expr)", async () => {
    const rows = await aggregate(
      "users",
      `$$ = $$.filter(u => u.email != null);
$group({ _id: $.email.split("@").at(1).toLowerCase(), n: $sum(1) });
$sort({ _id: 1 });`,
    );
    expect(rows.map((r) => ({ domain: r._id, n: r.n }))).toEqual([
      { domain: "bletchley.uk", n: 1 },
      { domain: "example.com", n: 3 },
      { domain: "nasa.gov", n: 1 },
      { domain: "navy.mil", n: 1 },
      { domain: "turing.org", n: 1 },
    ]);
  });

  // ── raw expression (jsmql.expr) ───────────────────────────────────────────

  // Invariant check across the whole collection: the `.map(i => i.price).reduce(...)`
  // subtotal (realistic.test.ts "cart subtotal") must equal each order's stored
  // `total`. We surface any violating order, expecting none.
  it("expr: items.map(price).reduce(sum) equals every order total", async () => {
    const subtotal = jsmql.expr(`$.items.map(i => i.price).reduce((acc, p) => acc + p, 0)`);
    const violations = await db
      .collection("orders")
      .aggregate([{ $addFields: { __ok: { $eq: [subtotal, "$total"] } } }, { $match: { __ok: false } }])
      .toArray();
    expect(violations).toEqual([]);
  });

  // `.events.map(e => e.at.getTime()).reduce(Math.max)` — the most-recent-event
  // reduction (realistic.test.ts "most-recent event timestamp") on real dated
  // sub-documents. Shipment #1's last event is its delivery on 2026-01-15.
  it("expr: latest shipment event via map(getTime).reduce(max)", async () => {
    const latestExpr = jsmql.expr(`$.events.map(e => e.at.getTime()).reduce((max, t) => Math.max(max, t), 0)`);
    const rows = await db
      .collection("shipments")
      .aggregate([{ $match: { _id: ID.shipment(1) } }, { $addFields: { latest: latestExpr } }])
      .toArray();
    expect(Number((rows[0] as { latest: unknown }).latest)).toBe(new Date("2026-01-15T00:00:00.000Z").getTime());
  });
});
