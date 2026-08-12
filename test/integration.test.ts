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

  // The reported `.endsWith()` bug, end-to-end. `$substrCP` aborts the executor
  // on a negative start, and `$strLenCP` aborts on a missing/null input, so
  // before the fix this query returned NO rows — it killed the whole command.
  // The dataset hits every hazard at once: u4's "kat@nasa.gov" (12) is SHORTER
  // than the 13-char needle (→ negative index), u5's email is null, and u9 has
  // no email field at all. A `toEqual` on emitted MQL can't catch this class;
  // only a real run can.
  it("filter: .endsWith() survives receivers shorter than the needle, plus null/missing", async () => {
    const rows = await find("users", `$.email.endsWith("@bletchley.uk")`);
    expect(hexes(rows)).toEqual(ids(ID.user, [7])); // Joan Clarke, the only match
  });

  // The user-reported predicate verbatim: every email is shorter than the
  // 19-char needle, so EVERY document takes the negative-index path. Matching
  // nothing is the correct answer; aborting is what it used to do.
  it("filter: .endsWith() with a needle longer than every value matches nothing, without aborting", async () => {
    const rows = await find("users", `$.email.endsWith("@flash-payments.com")`);
    expect(rows).toEqual([]);
  });

  // The same hazards through the value-mode string methods, asserting the
  // returned values rather than just "it ran". Missing and null both read as "".
  it("expr: string methods on short / null / missing receivers match JS semantics", async () => {
    const rows = (await aggregate("users", `$ = { name: $.name, tail: $.email.slice(-13), len: $.email.length };`)) as {
      name: string;
      tail: string;
      len: number;
    }[];
    const byName = Object.fromEntries(rows.map((r) => [r.name, { tail: r.tail, len: r.len }]));
    expect(byName["Joan Clarke"]).toEqual({ tail: "@bletchley.uk", len: 17 }); // longer than 13
    expect(byName["Katherine Johnson"]).toEqual({ tail: "kat@nasa.gov", len: 12 }); // SHORTER → clamped, whole string
    expect(byName["Margaret Hamilton"]).toEqual({ tail: "", len: 0 }); // email: null
    expect(byName["Karen Spärck Jones"]).toEqual({ tail: "", len: 0 }); // email absent
  });

  // Variable capture: a lowering that `$let`-binds its receiver and then splices
  // a user argument into the body used to shadow that argument's lambda param —
  // here `s.qty`, the padStart target, which resolved against the padded string
  // instead of the element. It produced WRONG VALUES rather than errors, so a
  // `toEqual` on emitted MQL is no protection; only running it is.
  it("pipeline: an argument referencing the lambda param is not captured by the internal $let", async () => {
    const rows = (await aggregate(
      "orders",
      `$match($.status === "shipped");
$sort({ _id: 1 });
$ = { codes: $.items.map(s => String(s.qty).padStart(s.qty, "0")) };`,
    )) as { codes: string[] }[];
    // Each line's qty is BOTH the padded value and the target width, so a capture
    // shows up immediately. Expected values match real String.prototype.padStart.
    expect(rows.slice(0, 4).map((r) => r.codes)).toEqual([["1", "02"], ["1"], ["0000000010"], ["02", "1"]]);
  });

  // A multi-character pad must fill to exactly `targetLength`, cutting the pad
  // mid-string as JS does — repeating it whole over-fills. Values checked against
  // real String.prototype.padStart/padEnd.
  it("expr: padStart/padEnd fill to the target width with a multi-character pad", async () => {
    const rows = (await aggregate(
      "users",
      `$ = { name: $.name, s: $.tier.padStart(9, "<>"), e: $.tier.padEnd(9, "<>") };`,
    )) as { name: string; s: string; e: string }[];
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    // "platinum" (8) → 1 pad char: the pad is cut mid-string, not repeated whole.
    expect(byName["Ada Lovelace"]).toMatchObject({ s: "<platinum", e: "platinum<" });
    // "gold" (4) → 5 pad chars = "<><><", NOT five whole "<>" units.
    expect(byName["Grace Hopper"]).toMatchObject({ s: "<><><gold", e: "gold<><><" });
    expect(byName["Karen Spärck Jones"]).toMatchObject({ s: "<><bronze", e: "bronze<><" });
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

  // Statement-position `.pop()` / `.shift()` lower to a `$slice` whose count can
  // be 0 for an empty or single-element array — which mongod rejects in the
  // 3-arg form even at runtime. Run the lowering over every user's `tags` (the
  // dataset mixes empty `[]`, single `["vip"]`, and two-element arrays): it must
  // neither error nor drop the wrong element. Expected values from a live run (HR3).
  it("expr: .pop() / .shift() run on empty & single-element arrays (no count-0 $slice rejection)", async () => {
    const tagsById = (rows: { _id: unknown; tags: string[] }[]) =>
      Object.fromEntries(rows.map((r) => [String(r._id), r.tags]));

    const popped = tagsById((await aggregate("users", "$.tags.pop();")) as { _id: unknown; tags: string[] }[]);
    expect(popped[ID.user(1).toHexString()]).toEqual(["vip"]); // ["vip","beta"] → drop last
    expect(popped[ID.user(3).toHexString()]).toEqual([]); //     single ["vip"]  → []
    expect(popped[ID.user(4).toHexString()]).toEqual([]); //     empty []        → [] (no rejection)

    const shifted = tagsById((await aggregate("users", "$.tags.shift();")) as { _id: unknown; tags: string[] }[]);
    expect(shifted[ID.user(1).toHexString()]).toEqual(["beta"]); // ["vip","beta"] → drop first
    expect(shifted[ID.user(3).toHexString()]).toEqual([]); //       single ["vip"]  → []
    expect(shifted[ID.user(7).toHexString()]).toEqual([]); //       empty []        → [] (no rejection)
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

  // `$$.push(...$$$.<coll>.aggregate(...))` — an uncorrelated foreign sub-pipeline
  // unioned into the stream. The shipment counts per carrier are appended after the
  // one summary row the outer pipeline produces, proving `$unionWith.pipeline` really
  // ran the grouped aggregate (not merely that jsmql emitted it).
  it("pipeline: an aggregate sub-pipeline unioned into the stream via $$.push", async () => {
    const rows = await aggregate(
      "shipments",
      `$group({ _id: null, total: $sum(1) });
$$.push(...$$$.shipments.aggregate(s => { $group({ _id: s.carrier, n: $sum(1) }); $sort({ _id: 1 }); }));`,
    );
    expect(rows).toEqual([
      { _id: null, total: 15 },
      { _id: "DHL", n: 3 },
      { _id: "FedEx", n: 5 },
      { _id: "UPS", n: 5 },
      { _id: "USPS", n: 2 },
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
$.recentOrders = $$$.orders.aggregate(o => {
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

  // Correlated $lookup gating on a TOP-LEVEL bracket-accessed outer field
  // (`$["ext-code"]`). The bare root `$` must contribute no path segment, or the
  // emitted field path is `.ext-code` (leading dot) and mongod rejects the whole
  // pipeline (Location15998). Distinct code path from the nested `meta["ext-id"]`
  // case above. Only order 1 has ext-code "EC-1", so only its row keeps its
  // shipment; every other order's `tracked` is empty.
  it("pipeline: correlated $lookup on a top-level bracket-accessed field (no leading-dot field path)", async () => {
    const rows = (await aggregate(
      "orders",
      `$.tracked = $$$.shipments.filter(s => s.orderId === $._id && $["ext-code"] === "EC-1");`,
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

  // ── chained stage calls (`.$stage(...)`) ──────────────────────────────────

  // Stage links on the current stream, and the guarantee that they are the same
  // pipeline as the `;`-separated statement spelling — asserted on the SERVER's
  // output, not just the emitted MQL.
  it("pipeline: stage links on $$ run identically to the statement spelling", async () => {
    const chained = await aggregate(
      "orders",
      `$$.$match({ status: "shipped" }).$group({ _id: "$region", revenue: $sum("$total"), n: $sum(1) }).$sort({ revenue: -1 }).$limit(3);`,
    );
    const statements = await aggregate(
      "orders",
      `$match({ status: "shipped" }); $group({ _id: "$region", revenue: $sum("$total"), n: $sum(1) }); $sort({ revenue: -1 }); $limit(3);`,
    );
    expect(chained).toEqual([
      { _id: "AU", revenue: 2804, n: 9 },
      { _id: "US", revenue: 1990, n: 4 },
    ]);
    expect(chained).toEqual(statements);
  });

  // A grouped foreign sub-pipeline assembled entirely from chained stage calls,
  // then mapped value-mode over the lookup result. `$group`/`$sort`/`$limit`
  // have no JavaScript spelling, so before stage links this chain was
  // unreachable without an `.aggregate((o) => { … })` block.
  it("pipeline: chained stage calls build a $lookup sub-pipeline", async () => {
    const rows = await aggregate(
      "users",
      `$match($._id === 0x6500000000000000000000a1);
const byRegion = $$$.orders.$match({ status: "shipped" })
  .$group({ _id: "$region", revenue: $sum("$total") })
  .$sort({ revenue: -1 }).$limit(2)
  .map(g => ({ region: g._id, revenue: g.revenue }));
$ = { byRegion };`,
    );
    expect(rows).toEqual([
      {
        byRegion: [
          { region: "AU", revenue: 2804 },
          { region: "US", revenue: 1990 },
        ],
      },
    ]);
  });

  // A correlated query-document `$match` — `{ userId: $._id }` reads the OUTER
  // document. MongoDB doesn't evaluate `$$` vars in the query language, so the
  // raw form would silently return nothing; jsmql re-expresses it as a
  // predicate. This asserts real matched counts, which is the only way to catch
  // that class of bug (the emitted MQL looked fine).
  it("pipeline: correlated query-document $match returns real matches", async () => {
    const src = (chain: string) =>
      `$match($.status === "active");\n$.orders = ${chain};\n$ = { user: $._id, n: $.orders.length };`;
    const counts = async (chain: string) =>
      (await aggregate("users", src(chain)))
        .map((r) => ({ user: String((r as { user: unknown }).user), n: (r as { n: number }).n }))
        .sort((a, b) => (a.user < b.user ? -1 : 1));

    const expected = [
      { user: ID.user(1).toHexString(), n: 3 },
      { user: ID.user(2).toHexString(), n: 3 },
      { user: ID.user(3).toHexString(), n: 4 },
      { user: ID.user(5).toHexString(), n: 2 },
      { user: ID.user(6).toHexString(), n: 3 },
      { user: ID.user(8).toHexString(), n: 3 },
    ];
    // All three spellings must agree, and none may return zero matches.
    expect(await counts("$$$.orders.aggregate(o => { $match({ userId: $._id }); })")).toEqual(expected);
    expect(await counts("$$$.orders.$match({ userId: $._id })")).toEqual(expected);
    expect(await counts("$$$.orders.filter({ userId: $._id })")).toEqual(expected);
  });

  // A lodash stream chain that feeds `.aggregate((o) => { … })` — bound the
  // foreign scan with `.sort().take()`, group inside the block, then rank the
  // groups with more lodash. Every link lands in the one `$lookup.pipeline`, so
  // the server does the whole job; nothing materialises into an array first.
  it("pipeline: lodash chain then .aggregate ranks groups server-side", async () => {
    const rows = await aggregate(
      "users",
      `$match($._id === 0x6500000000000000000000a1);
const byRegion = $$$.orders.sort({ total: -1 }).take(20)
  .aggregate((o) => { $group({ _id: o.region, revenue: $sum(o.total) }); })
  .sort({ revenue: -1 }).take(3);
$ = { byRegion };`,
    );
    expect(rows).toEqual([
      {
        byRegion: [
          { _id: "AU", revenue: 3204 },
          { _id: "US", revenue: 3070 },
        ],
      },
    ]);
  });

  // The correlated form: `.filter` pins the foreign set to the outer user (via
  // `$lookup.let`), `.sort().take(2)` keeps only their two newest orders, and the
  // `.aggregate` block groups those. Per-user counts are what prove the `let`
  // correlation survives the lodash links — a broken one returns every order.
  it("pipeline: correlated lodash chain into .aggregate keeps the let binding", async () => {
    const rows = await aggregate(
      "users",
      `$match($.status === "active");
$.recent = $$$.orders.filter(o => o.userId === $._id).sort({ placedAt: -1 }).take(2)
  .aggregate((o) => { $group({ _id: o.status, n: $sum(1) }); }).sort({ _id: 1 });
$ = { user: $._id, recent: $.recent };`,
    );
    expect(
      (rows as { user: unknown; recent: unknown }[])
        .map((r) => ({ user: String(r.user), recent: r.recent }))
        .sort((a, b) => (a.user < b.user ? -1 : 1)),
    ).toEqual([
      { user: ID.user(1).toHexString(), recent: [{ _id: "shipped", n: 2 }] },
      {
        user: ID.user(2).toHexString(),
        recent: [
          { _id: "pending", n: 1 },
          { _id: "shipped", n: 1 },
        ],
      },
      {
        user: ID.user(3).toHexString(),
        recent: [
          { _id: "cancelled", n: 1 },
          { _id: "shipped", n: 1 },
        ],
      },
      { user: ID.user(5).toHexString(), recent: [{ _id: "shipped", n: 2 }] },
      {
        user: ID.user(6).toHexString(),
        recent: [
          { _id: "pending", n: 1 },
          { _id: "shipped", n: 1 },
        ],
      },
      { user: ID.user(8).toHexString(), recent: [{ _id: "shipped", n: 2 }] },
    ]);
  });

  // `.aggregate` at the HEAD with a lodash tail. `.pick` is the case a green
  // `toEqual` could never have caught: while the head form fell back to value
  // mode it read `$getField` off the result ARRAY and every row came back `{}`,
  // and the `.omit` sibling made mongod refuse the pipeline outright.
  it("pipeline: .aggregate head with a lodash tail projects real documents", async () => {
    const rows = await aggregate(
      "users",
      `$match($._id === 0x6500000000000000000000a1);
const shops = $$$.orders.aggregate((o) => { $group({ _id: o.shopId, n: $sum(1) }); })
  .sort({ n: -1 }).pick(["_id", "n"]);
$ = { shops };`,
    );
    expect(rows).toEqual([
      {
        shops: [
          { _id: "shop_au", n: 12 },
          { _id: "shop_us", n: 8 },
        ],
      },
    ]);
  });

  // A positional single-array-argument operator (`$size`/`$first`/`$last`/
  // `$reverseArray`) SPLICES a bare array operand into an argument list, so every
  // one of these emitted MQL the server refused outright — `[10,20,30].length` was
  // "$size takes exactly 1 arguments. 2 were passed in", and the one-element
  // `[7].length` was "must be an array, but was of type: int". Nothing but a real
  // run catches this: the emitted document looks perfectly reasonable.
  it("pipeline: single-array-argument operators over a literal array match JS", async () => {
    const rows = await aggregate(
      "users",
      `$match($._id === 0x6500000000000000000000a1);
$ = { n: [10, 20, 30].length, rev: [10, 20, 30].toReversed(), h: [10, 20, 30].head(),
      l: [10, 20, 30].last(), one: [7].length, nested: [[1, 2], [3]].head().toReversed() };`,
    );
    // Values are exactly what JavaScript returns for the same expressions.
    expect(rows).toEqual([{ n: 3, rev: [30, 20, 10], h: 10, l: 30, one: 1, nested: [2, 1] }]);
  });

  // A `toEqual` can't tell an index dispatch that *runs* from one the server
  // refuses, and this family has three receiver types and two spellings. So run
  // each one and compare against what JavaScript returns for the same expression.
  // `tags` is `["vip", "beta"]`, `name` is the string "Ada Lovelace", `profile` is
  // a document, and `nope` is absent.
  it("pipeline: bracket index and .at() match JavaScript on arrays, strings, and documents", async () => {
    const rows = await aggregate(
      "users",
      `$match($._id === 0x6500000000000000000000a1);
$ = { arrFirst: $.tags[0], arrLast: $.tags.at(-1),
      strFirst: $.name[0], strAt: $.name.at(4), strLast: $.name.at(-1),
      docKey: $.profile["verified"],
      absent: $.nope.at(0) ?? "fallback", absentIdx: $.nope[0] ?? "fallback" };`,
    );
    expect(rows).toEqual([
      {
        arrFirst: "vip", // ["vip","beta"][0]
        arrLast: "beta", // .at(-1)
        strFirst: "A", // "Ada Lovelace"[0]  — was a server error before
        strAt: "L", // .at(4) — A-d-a-space-L
        strLast: "e", // .at(-1) on a string
        docKey: true,
        // A missing receiver stays MISSING through both spellings, so `??` fires.
        absent: "fallback",
        absentIdx: "fallback",
      },
    ]);
  });

  // `$getField.field` must evaluate to a String or mongod aborts the WHOLE command
  // — and a missing key field reaches it as null, which is ordinary data, not an
  // exotic case. So a computed key is coerced. `subscription` is a document with a
  // `tier` field; `keyField` doesn't exist on any user, and `numKey` is a number.
  it("pipeline: a computed bracket key survives a missing key field and a numeric one", async () => {
    const rows = await aggregate(
      "users",
      `$match($._id === 0x6500000000000000000000a1);
const numKey = 0;
$ = { byLiteral: $.subscription["tier"], byMissing: $.subscription[$.keyField] ?? "no-key",
      byNumber: $.tags[numKey], digitKey: { 0: "zero", 1: "one" }[numKey] };`,
    );
    expect(rows).toEqual([
      {
        byLiteral: "premium",
        // Before the coercion this aborted with "$getField requires 'field' to
        // evaluate to type String, but got null".
        byMissing: "no-key",
        byNumber: "vip", // tags[0] — the array branch
        // A numeric object KEY builds the field "0", as JavaScript does.
        digitKey: "zero",
      },
    ]);
  });

  // A method chained onto a lookup reads jsmql's OWN materialised slot, which it
  // knows holds the `$lookup.as` array — so the emitted MQL has no runtime type
  // guard. Running it proves the compile-time shortcut picked the right branch.
  it("pipeline: methods chained onto a materialised lookup slot return the right values", async () => {
    const rows = await aggregate(
      "users",
      `$match($._id === 0x6500000000000000000000a1);
const mine = $$$.orders.filter(o => o.userId === $._id);
$ = { n: mine.length, firstStatus: mine.at(0).status, lastStatus: mine.at(-1).status,
      idxStatus: mine[0].status, tierCount: $$$.orders.filter(o => o.userId === $._id).countBy("status").size() };`,
    );
    expect(rows).toEqual([
      // Ada has 3 orders and they all share one status, so countBy has 1 key.
      { n: 3, firstStatus: "shipped", lastStatus: "shipped", idxStatus: "shipped", tierCount: 1 },
    ]);
  });

  // `.flatMap` lowers to `$unwind`, so the `.aggregate` block that follows sees
  // one document per order line — the sum proves the unwind ran before the group.
  it("pipeline: .flatMap then .aggregate sums across unwound lines", async () => {
    const rows = await aggregate(
      "users",
      `$match($._id === 0x6500000000000000000000a1);
const lines = $$$.orders.flatMap(o => o.items).aggregate((o) => { $group({ _id: null, qty: $sum(o.items.qty) }); });
$ = { lines };`,
    );
    expect(rows).toEqual([{ lines: [{ _id: null, qty: 55 }] }]);
  });
});
