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
    expect(rows[0].name).toBe("Ada Lovelace");
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

  // Value-mode array `.slice` is JS-faithful: start/end are INDICES (end
  // exclusive) and negatives count from the end — NOT MQL `$slice`'s
  // position+count semantics. Slices a 3-element array projected from an order's
  // items. The old count-based lowering got `.slice(1)` / `.slice(1, -1)` wrong
  // (and emitted a negative count mongod rejects); this asserts the fix runs on
  // a real server. Expected values derived from a live run (HR3).
  it("expr: array .slice matches Array.prototype.slice (indices, end-exclusive)", async () => {
    const id = ID.order(15).toHexString();
    const [row] = await aggregate(
      "orders",
      `$match($._id === 0x${id});
$ = {
  tail: $.items.map(i => i.name).slice(1),
  middle: $.items.map(i => i.name).slice(1, -1),
  butLast: $.items.map(i => i.name).slice(0, -1),
  lastTwo: $.items.map(i => i.name).slice(-2),
  firstTwo: $.items.map(i => i.name).slice(0, 2),
  emptyRange: $.items.map(i => i.name).slice(2, 1),
};`,
    );
    expect(row).toEqual({
      tail: ["4K Monitor", "Noise-cancelling Headphones"],
      middle: ["4K Monitor"],
      butLast: ["Mechanical Keyboard", "4K Monitor"],
      lastTwo: ["4K Monitor", "Noise-cancelling Headphones"],
      firstTwo: ["Mechanical Keyboard", "4K Monitor"],
      emptyRange: [],
    });
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

  // ── the quirkiest shapes: nested $lookup, assert(), $$.length ──────────────

  // Nested $lookup in a block-body predicate: users → their recent orders →
  // each order's shipments. The inner predicate correlates on TWO levels —
  // `s.orderId === o._id` (the order) and `s.userId === $._id` (the outer
  // user) — which only works because jsmql depth-stamps the `$lookup.let`
  // names ($$v1_id vs $$v0_id) so they don't collide. (realistic.test.ts
  // "user → recent orders → each order's shipments".) This is the deepest
  // pipeline jsmql emits; running it proves the two-level correlation resolves
  // to the right documents on a real server.
  it("pipeline: nested $lookup — users → recent orders → each order's shipments", async () => {
    const rows = await aggregate(
      "users",
      `$match($.active === true);
$.recentOrders = $$$.orders.filter(o => {
  $match(o.userId === $._id);
  $sort({ placedAt: -1 });
  $limit(5);
  $.shipments = $$$.shipments.filter(s => s.orderId === o._id && s.userId === $._id);
});
$project({ name: 1, recentOrders: 1 });`,
    );
    // 6 active users (u4/u7 are inactive). Order of the outer stream isn't
    // sorted, so compare names as a set.
    expect(rows.map((r) => (r as { name: string }).name).sort()).toEqual([
      "Ada Lovelace",
      "Alan Turing",
      "Dorothy Vaughan",
      "Grace Hopper",
      "Hedy Lamarr",
      "Margaret Hamilton",
    ]);
    // recentOrders ARE deterministically ordered (the inner $sort placedAt desc).
    const orderShipments = (name: string) => {
      const u = rows.find((r) => (r as { name: string }).name === name) as {
        recentOrders: { _id: unknown; shipments: { _id: unknown }[] }[];
      };
      return u.recentOrders.map((o) => ({ order: String(o._id), shipments: o.shipments.map((s) => String(s._id)) }));
    };
    // Ada's 3 orders, newest first, each carrying its single shipment.
    expect(orderShipments("Ada Lovelace")).toEqual([
      { order: ID.order(15).toHexString(), shipments: [ID.shipment(12).toHexString()] },
      { order: ID.order(2).toHexString(), shipments: [ID.shipment(2).toHexString()] },
      { order: ID.order(1).toHexString(), shipments: [ID.shipment(1).toHexString()] },
    ]);
    // Grace's set includes her CANCELLED order (o7), which has no shipment —
    // the nested lookup correctly yields an empty array there, not a wrong match.
    expect(orderShipments("Grace Hopper")).toEqual([
      { order: ID.order(18).toHexString(), shipments: [ID.shipment(14).toHexString()] },
      { order: ID.order(7).toHexString(), shipments: [] },
      { order: ID.order(6).toHexString(), shipments: [ID.shipment(5).toHexString()] },
      { order: ID.order(5).toHexString(), shipments: [ID.shipment(4).toHexString()] },
    ]);
  });

  // Correlated $lookup whose outer field has a HYPHENATED path segment
  // (`$.meta["ext-id"]`). The hyphen is legal in a field name but illegal in a
  // MongoDB `$$` variable name, so the emitted `$lookup.let` var is derived from
  // the sanitized segment (`jsmql_f0_ext_id`) — feeding the raw `ext-id` through
  // makes mongod reject the whole pipeline with FailedToParse. Running it proves
  // the server accepts the sanitized name AND the correlation still filters
  // correctly. Only order 1 carries ext-id "X-1", so only its row gets its
  // shipment; every other order's `tracked` is empty.
  it("pipeline: correlated $lookup on a hyphenated outer field (identifier-safe let var)", async () => {
    const rows = (await aggregate(
      "orders",
      `$.tracked = $$$.shipments.filter(s => s.orderId === $._id && $.meta["ext-id"] === "X-1");`,
    )) as { _id: unknown; tracked: { _id: unknown }[] }[];
    const withTracked = rows.filter((r) => r.tracked.length > 0);
    expect(withTracked.map((r) => String(r._id))).toEqual([ID.order(1).toHexString()]);
    expect(withTracked[0].tracked.map((s) => String(s._id))).toEqual([ID.shipment(1).toHexString()]);
  });

  // assert(cond, msg) that HOLDS for every document: the aggregate runs to
  // completion and the following stage computes normally. (realistic.test.ts
  // "guard against corrupt data before aggregating".)
  it("pipeline: assert that holds lets the aggregate run", async () => {
    const rows = await aggregate("orders", `assert($.total > 0, "order total must be positive");\n$.flagged = false;`);
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => (r as { flagged: boolean }).flagged === false)).toBe(true);
  });

  // assert(cond, msg) that FAILS for some document: it lowers to a $match whose
  // $convert names the message as a bson type, so MongoDB aborts the WHOLE
  // aggregate with `Unknown type name: jsmql assertion failed: <msg>`. This is
  // the load-bearing behaviour — proving the server really rejects, not that we
  // emit a plausible-looking shape.
  it("pipeline: a failing assert aborts the whole aggregate with its message", async () => {
    await expect(aggregate("orders", `assert($.total <= 100, "order total exceeds cap");`)).rejects.toThrow(
      "jsmql assertion failed: order total exceeds cap",
    );
  });

  // $$.length — the current stream's document count as a value — materialised
  // once via $setWindowFields and reused across two $set fields AND an assert,
  // with the scratch field $unset at the end. (realistic.test.ts "tag each
  // in-stock product with the category total + size guard".)
  it("pipeline: $$.length reused across fields + assert guard", async () => {
    const rows = await aggregate(
      "products",
      `$match($.inStock === true);
$.totalInStock = $$.length;
$.sharePct = 100 / $$.length;
assert($$.length <= 1000, "too many in-stock products to render");`,
    );
    expect(rows).toHaveLength(8); // 8 of 10 products are in stock
    expect(rows.every((r) => (r as { totalInStock: number }).totalInStock === 8)).toBe(true);
    expect(rows.every((r) => (r as { sharePct: number }).sharePct === 12.5)).toBe(true);
    expect(rows.every((r) => !("__jsmql" in (r as object)))).toBe(true); // scratch namespace cleaned up
  });
});
