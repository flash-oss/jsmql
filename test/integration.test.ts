import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, MongoClient } from "mongodb";
import { jsmql } from "../src/index.ts";
import { ID } from "./fixtures/dataset.ts";
import { assertIntegrity, connectReadOnly, fixtureReady } from "./fixtures/client.ts";

const ready = await fixtureReady();
if (!ready) {
  console.warn(
    "\n[integration] fixture instance not reachable — skipping integration tests." +
      '\n[integration] Run "npm run fixture:up" to start the dedicated :27018 mongod and seed it.\n',
  );
}

describe.skipIf(!ready)("integration: jsmql MQL against a live MongoDB", () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    ({ client, db } = await connectReadOnly());
    await assertIntegrity(db);
  });
  afterAll(async () => {
    await client?.close();
  });

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

  it("filter: in-stock products priced 50..400", async () => {
    const rows = await find("products", `$.inStock === true && $.price >= 50 && $.price <= 400`);
    expect(hexes(rows)).toEqual(ids(ID.product, [1, 3, 5, 7]));
  });

  it("filter: active users with a non-null email", async () => {
    const rows = await find("users", `$.email != null && $.status === "active"`);
    expect(hexes(rows)).toEqual(ids(ID.user, [1, 2, 3, 6, 8]));
  });

  it("filter: .endsWith() survives receivers shorter than the needle, plus null/missing", async () => {
    const rows = await find("users", `$.email.endsWith("@bletchley.uk")`);
    expect(hexes(rows)).toEqual(ids(ID.user, [7]));
  });

  it("filter: .endsWith() with a needle longer than every value matches nothing, and does not abort", async () => {
    const rows = await find("users", `$.email.endsWith("@flash-payments.com")`);
    expect(rows).toEqual([]);
  });

  it("expr: string methods on short / null / missing receivers match JS semantics", async () => {
    const rows = (await aggregate(
      "users",
      `$ = { name: $.name, tail: $.email.substr(-13), len: $.email.length() };`,
    )) as { name: string; tail: string; len: number }[];
    const byName = Object.fromEntries(rows.map((r) => [r.name, { tail: r.tail, len: r.len }]));
    expect(byName["Joan Clarke"]).toEqual({ tail: "@bletchley.uk", len: 17 });
    expect(byName["Katherine Johnson"]).toEqual({ tail: "kat@nasa.gov", len: 12 });
    expect(byName["Margaret Hamilton"]).toEqual({ tail: "", len: 0 });
    expect(byName["Karen Spärck Jones"]).toEqual({ tail: "", len: 0 });
  });

  it("expr: the date methods produce the values MongoDB actually computes", async () => {
    const [row] = (await aggregate(
      "users",
      `$$.filter({ name: "Ada Lovelace" });
       $ = { monthStart: $.expiresAt.startOf("month"),
             monthEnd: $.expiresAt.endOf("month"),
             label: $.expiresAt.startOf("month").format("%Y-%m"),
             daysLived: $.expiresAt.diff($.createdAt, "day"),
             quarter: $.expiresAt.quarter(),
             isoWeek: $.expiresAt.isoWeek(),
             sameYear: $.expiresAt.isSame($.lastSeen, "year"),
             sameMonth: $.expiresAt.isSame($.lastSeen, "month"),
             newYearsDay: $.expiresAt.set({ month: 1, day: 1 }) };`,
    )) as Record<string, unknown>[];
    expect(row).toEqual({
      monthStart: new Date("2026-12-01T00:00:00.000Z"),
      monthEnd: new Date("2026-12-31T23:59:59.999Z"),
      label: "2026-12",
      daysLived: 685,
      quarter: 4,
      isoWeek: 49,
      sameYear: true,
      sameMonth: false,
      newYearsDay: new Date("2026-01-01T00:00:00.000Z"),
    });
  });

  it("pipeline: padStart fills each element of an array to a constant width", async () => {
    const rows = (await aggregate(
      "orders",
      `$match($.status === "shipped");
$sort({ _id: 1 });
$ = { codes: $.items.map(s => s.qty.toString().padStart(3, "0")) };`,
    )) as { codes: string[] }[];
    expect(rows.slice(0, 4).map((r) => r.codes)).toEqual([["001", "002"], ["001"], ["010"], ["002", "001"]]);
  });

  it("expr: padStart, padEnd and pad fill to the target width", async () => {
    const rows = (await aggregate(
      "users",
      `$ = { name: $.name, s: $.tier.padStart(9, "<"), e: $.tier.padEnd(9, ">"), b: $.tier.pad(11, "*") };`,
    )) as { name: string; s: string; e: string; b: string }[];
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName["Ada Lovelace"]).toMatchObject({ s: "<platinum", e: "platinum>", b: "*platinum**" });
    expect(byName["Grace Hopper"]).toMatchObject({ s: "<<<<<gold", e: "gold>>>>>", b: "***gold****" });
    expect(byName["Karen Spärck Jones"]).toMatchObject({ s: "<<<bronze", e: "bronze>>>", b: "**bronze***" });
  });

  it("filter: fetch one document by its 0x ObjectId literal", async () => {
    const rows = await find("users", `$._id === 0x6500000000000000000000a1`);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Ada Lovelace");
  });

  it("filter: orders shipped on/after a date", async () => {
    const rows = await find("orders", `$.status === "shipped" && $.placedAt >= Date("2026-06-01")`);
    expect(hexes(rows)).toEqual(ids(ID.order, [8, 9, 13, 15, 18, 19]));
  });

  it("filter: verified reviews rated 4 or higher", async () => {
    const rows = await find("reviews", `$.verified === true && $.rating >= 4`);
    expect(hexes(rows)).toEqual(ids(ID.review, [1, 2, 3, 5, 7, 9, 12]));
  });

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

  it("expr: .pop() / .shift() run on empty & single-element arrays (no count-0 $slice rejection)", async () => {
    const tagsById = (rows: { _id: unknown; tags: string[] }[]) =>
      Object.fromEntries(rows.map((r) => [String(r._id), r.tags]));

    const popped = tagsById((await aggregate("users", "$.tags.pop();")) as { _id: unknown; tags: string[] }[]);
    expect(popped[ID.user(1).toHexString()]).toEqual(["vip"]);
    expect(popped[ID.user(3).toHexString()]).toEqual([]);
    expect(popped[ID.user(4).toHexString()]).toEqual([]);

    const shifted = tagsById((await aggregate("users", "$.tags.shift();")) as { _id: unknown; tags: string[] }[]);
    expect(shifted[ID.user(1).toHexString()]).toEqual(["beta"]);
    expect(shifted[ID.user(3).toHexString()]).toEqual([]);
    expect(shifted[ID.user(7).toHexString()]).toEqual([]);
  });

  it("pipeline: revenue by buyer department (lookup + unwind + group)", async () => {
    const rows = await aggregate(
      "orders",
      `$match($.status === "shipped" && $.placedAt >= Date("2026-01-01"));
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

  it("pipeline: 3 most expensive line items across shipped orders", async () => {
    const rows = await aggregate(
      "orders",
      `$$ = $$.filter(o => o.status === "shipped").flatMap(o => o.items).map(item => item);
$sort({ price: -1 });
$limit(3);`,
    );
    expect(rows.map((r) => r.price)).toEqual([800, 500, 400]);
  });

  it("pipeline: shipment count by carrier", async () => {
    const rows = await aggregate("shipments", `$group({ _id: $.carrier, n: $sum(1) });\n$sort({ _id: 1 });`);
    expect(rows.map((r) => ({ carrier: r._id, n: r.n }))).toEqual([
      { carrier: "DHL", n: 3 },
      { carrier: "FedEx", n: 5 },
      { carrier: "UPS", n: 5 },
      { carrier: "USPS", n: 2 },
    ]);
  });

  it("pipeline: an aggregate sub-pipeline unioned into the stream through $$.push", async () => {
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

  it("pipeline: user count by email domain (group by computed string expr)", async () => {
    const rows = await aggregate(
      "users",
      `$$ = $$.filter(u => u.email != null);
$group({ _id: $.email.split("@").at(1).toLower(), n: $sum(1) });
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

  it("expr: items.map(price).reduce(sum) equals every order total", async () => {
    const subtotal = jsmql.expr(`$.items.map(i => i.price).reduce((acc, p) => acc + p, 0)`);
    const violations = await db
      .collection("orders")
      .aggregate([{ $addFields: { __ok: { $eq: [subtotal, "$total"] } } }, { $match: { __ok: false } }])
      .toArray();
    expect(violations).toEqual([]);
  });

  it("expr: latest shipment event through map(getTime).reduce(max)", async () => {
    const latestExpr = jsmql.expr(`$.events.map(e => e.at.getTime()).reduce((max, t) => [max, t].max(), 0)`);
    const rows = await db
      .collection("shipments")
      .aggregate([{ $match: { _id: ID.shipment(1) } }, { $addFields: { latest: latestExpr } }])
      .toArray();
    expect(Number((rows[0] as { latest: unknown }).latest)).toBe(new Date("2026-01-15T00:00:00.000Z").getTime());
  });

  it("pipeline: nested $lookup — users → recent orders → each order's shipments", async () => {
    const rows = await aggregate(
      "users",
      `$match($.active === true);
$.recentOrders = $$$.orders.aggregate(o => {
  $match(o.userId === $._id);
  $sort({ placedAt: -1 });
  $limit(5);
  o.shipments = $$$.shipments.filter(s => s.orderId === o._id && s.userId === $._id);
});
$project({ name: 1, recentOrders: 1 });`,
    );
    expect(rows.map((r) => (r as { name: string }).name).sort()).toEqual([
      "Ada Lovelace",
      "Alan Turing",
      "Dorothy Vaughan",
      "Grace Hopper",
      "Hedy Lamarr",
      "Margaret Hamilton",
    ]);
    const orderShipments = (name: string) => {
      const u = rows.find((r) => (r as { name: string }).name === name) as {
        recentOrders: { _id: unknown; shipments: { _id: unknown }[] }[];
      };
      return u.recentOrders.map((o) => ({ order: String(o._id), shipments: o.shipments.map((s) => String(s._id)) }));
    };
    expect(orderShipments("Ada Lovelace")).toEqual([
      { order: ID.order(15).toHexString(), shipments: [ID.shipment(12).toHexString()] },
      { order: ID.order(2).toHexString(), shipments: [ID.shipment(2).toHexString()] },
      { order: ID.order(1).toHexString(), shipments: [ID.shipment(1).toHexString()] },
    ]);
    expect(orderShipments("Grace Hopper")).toEqual([
      { order: ID.order(18).toHexString(), shipments: [ID.shipment(14).toHexString()] },
      { order: ID.order(7).toHexString(), shipments: [] },
      { order: ID.order(6).toHexString(), shipments: [ID.shipment(5).toHexString()] },
      { order: ID.order(5).toHexString(), shipments: [ID.shipment(4).toHexString()] },
    ]);
  });

  it("pipeline: correlated $lookup on a hyphenated outer field (identifier-safe let var)", async () => {
    const rows = (await aggregate(
      "orders",
      `$.tracked = $$$.shipments.filter(s => s.orderId === $._id && $.meta["ext-id"] === "X-1");`,
    )) as { _id: unknown; tracked: { _id: unknown }[] }[];
    const withTracked = rows.filter((r) => r.tracked.length > 0);
    expect(withTracked.map((r) => String(r._id))).toEqual([ID.order(1).toHexString()]);
    expect(withTracked[0].tracked.map((s) => String(s._id))).toEqual([ID.shipment(1).toHexString()]);
  });

  it("pipeline: correlated $lookup on a top-level bracket-accessed field (no leading-dot field path)", async () => {
    const rows = (await aggregate(
      "orders",
      `$.tracked = $$$.shipments.filter(s => s.orderId === $._id && $["ext-code"] === "EC-1");`,
    )) as { _id: unknown; tracked: { _id: unknown }[] }[];
    const withTracked = rows.filter((r) => r.tracked.length > 0);
    expect(withTracked.map((r) => String(r._id))).toEqual([ID.order(1).toHexString()]);
    expect(withTracked[0].tracked.map((s) => String(s._id))).toEqual([ID.shipment(1).toHexString()]);
  });

  it("pipeline: assert that holds lets the aggregate run", async () => {
    const rows = await aggregate("orders", `assert($.total > 0, "order total must be positive");\n$.flagged = false;`);
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => (r as { flagged: boolean }).flagged === false)).toBe(true);
  });

  it("pipeline: a failing assert aborts the whole aggregate with its message", async () => {
    await expect(aggregate("orders", `assert($.total <= 100, "order total exceeds cap");`)).rejects.toThrow(
      "jsmql assertion failed: order total exceeds cap",
    );
  });

  it("pipeline: $$.size() reused across fields + assert guard", async () => {
    const rows = await aggregate(
      "products",
      `$match($.inStock === true);
$.totalInStock = $$.size();
$.sharePct = 100 / $$.size();
assert($$.size() <= 1000, "too many in-stock products to render");`,
    );
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => (r as { totalInStock: number }).totalInStock === 8)).toBe(true);
    expect(rows.every((r) => (r as { sharePct: number }).sharePct === 12.5)).toBe(true);
    expect(rows.every((r) => !("__jsmql" in (r as object)))).toBe(true);
  });

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

  it("pipeline: correlated query-document $match returns real matches", async () => {
    const src = (chain: string) =>
      `$match($.status === "active");\n$.orders = ${chain};\n$ = { user: $._id, n: $.orders.size() };`;
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
    expect(await counts("$$$.orders.aggregate(o => { $match({ userId: $._id }); })")).toEqual(expected);
    expect(await counts("$$$.orders.$match({ userId: $._id })")).toEqual(expected);
    expect(await counts("$$$.orders.filter({ userId: $._id })")).toEqual(expected);
  });

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

  it("pipeline: single-array-argument operators over a literal array match JS", async () => {
    const rows = await aggregate(
      "users",
      `$match($._id === 0x6500000000000000000000a1);
$ = { n: [10, 20, 30].size(), rev: [10, 20, 30].toReversed(), h: [10, 20, 30].head(),
      l: [10, 20, 30].last(), one: [7].size(), nested: [[1, 2], [3]].head().toReversed() };`,
    );
    expect(rows).toEqual([{ n: 3, rev: [30, 20, 10], h: 10, l: 30, one: 1, nested: [2, 1] }]);
  });

  it("pipeline: bracket index, .at(), .charAt() and .substr() match JavaScript on arrays, strings, and documents", async () => {
    const rows = await aggregate(
      "users",
      `$match($._id === 0x6500000000000000000000a1);
$ = { arrFirst: $.tags[0], arrLast: $.tags.at(-1),
      strFirst: $.name[0], strAt: $.name.charAt(4), strLast: $.name.substr(-1),
      docKey: $.profile["verified"],
      absent: $.nope.at(0) ?? "fallback", absentIdx: $.nope[0] ?? "fallback" };`,
    );
    expect(rows).toEqual([
      {
        arrFirst: "vip",
        arrLast: "beta",
        strFirst: "A",
        strAt: "L",
        strLast: "e",
        docKey: true,
        absent: "fallback",
        absentIdx: "fallback",
      },
    ]);
  });

  it("pipeline: a computed bracket key survives a missing key field and a numeric one", async () => {
    const rows = await aggregate(
      "users",
      `$match($._id === 0x6500000000000000000000a1);
const numKey = 0;
$ = { byLiteral: $.subscription["tier"], byMissing: $.subscription[$.keyField] ?? "no-key",
      byNumber: $.tags[numKey], digitKey: { 0: "zero", 1: "one" }[numKey] };`,
    );
    expect(rows).toEqual([{ byLiteral: "premium", byMissing: "no-key", byNumber: "vip", digitKey: "zero" }]);
  });

  it("pipeline: methods chained onto a materialised lookup slot return the right values", async () => {
    const rows = await aggregate(
      "users",
      `$match($._id === 0x6500000000000000000000a1);
const mine = $$$.orders.filter(o => o.userId === $._id);
$ = { n: mine.size(), firstStatus: mine.at(0).status, lastStatus: mine.at(-1).status,
      idxStatus: mine[0].status, tierCount: $$$.orders.filter(o => o.userId === $._id).countBy("status").keys().size() };`,
    );
    expect(rows).toEqual([{ n: 3, firstStatus: "shipped", lastStatus: "shipped", idxStatus: "shipped", tierCount: 1 }]);
  });

  it("pipeline: .flatMap then .aggregate sums across unwound lines", async () => {
    const rows = await aggregate(
      "users",
      `$match($._id === 0x6500000000000000000000a1);
const lines = $$$.orders.flatMap(o => o.items).aggregate((line) => { $group({ _id: null, qty: $sum(line.qty) }); });
$ = { lines };`,
    );
    expect(rows).toEqual([{ lines: [{ _id: null, qty: 55 }] }]);
  });

  it("pipeline: collaborative filtering — countBy keys cast back to ObjectId join the product docs", async () => {
    const rows = await aggregate(
      "users",
      `const userId = 0x6500000000000000000000a2;
$$.filter({ _id: userId });
assert($$.size() === 1, "User not found");

const myProductIds = $$$.orders
  .filter({ userId })
  .toSorted({ placedAt: -1 })
  .take(10)
  .map("items")
  .flatten()
  .map("productId")
  .uniq();

const candidateProductIdCounts = $$$.orders
  .filter(o => o.items.productId === myProductIds && o.placedAt > Date("2025-01-01"))
  .toSorted({ placedAt: -1 })
  .take(100)
  .map("items")
  .flatten()
  .map("productId")
  .filter(p => !myProductIds.has(p))
  .countBy();
const candidateProductIds = candidateProductIdCounts.keys().map(id => id.toObjectId());

const candidateProducts = $$$.products
  .filter({ _id: candidateProductIds })
  .take(500)
  .pick(["_id", "name"]); // load only the fields we use

$$ = candidateProductIds
  .map(id => ({
    productId: id,
    score: candidateProductIdCounts[id],
    name: candidateProducts.find({ _id: id }).name,
  }))
  .orderBy({ score: -1, name: 1 })
  .take(10);`,
    );
    expect(rows).toEqual([
      { productId: ID.product(1), score: 2, name: "Mechanical Keyboard" },
      { productId: ID.product(7), score: 1, name: "4K Monitor" },
      { productId: ID.product(5), score: 1, name: "Ergonomic Chair" },
      { productId: ID.product(2), score: 1, name: "USB-C Cable" },
    ]);
  });

  it("expr: a method on a missing array runs on the empty array through a chain; .size() counts 0", async () => {
    const rows = await aggregate(
      "users",
      `$match($._id === 0x6500000000000000000000a1);
$ = { s: $.noSuchField.map(x => x).size(),
      has: $.noSuchField.map(x => x).has(1), any: $.noSuchField.filter(x => x).some(x => x),
      keys: $.keys().size() > 3 };`,
    );
    expect(rows).toEqual([{ s: 0, has: false, any: false, keys: true }]);
  });

  it("pipeline: .differenceBy / .intersectionBy after .flatMap agree with the .filter spelling", async () => {
    const a1 = "0x6500000000000000000000a1";
    const p1 = `0x${ID.product(1).toHexString()}`;
    const shape = `$ = { p: $.items.productId, q: $.items.qty };`;
    const byKey = await aggregate(
      "orders",
      `$$.filter({ userId: ${a1} }).flatMap("items").differenceBy([{ productId: ${p1} }], "productId").sortBy("qty");\n${shape}`,
    );
    const byFilter = await aggregate(
      "orders",
      `$$.filter({ userId: ${a1} }).flatMap("items").filter(i => i.productId !== ${p1}).sortBy("qty");\n${shape}`,
    );
    expect(byKey).toEqual(byFilter);
    expect(byKey.map((r) => r.q)).toEqual([1, 1, 1, 2]);
    expect(byKey.some((r) => String(r.p) === ID.product(1).toHexString())).toBe(false);
    const kept = await aggregate(
      "orders",
      `$$.filter({ userId: ${a1} }).flatMap("items").intersectionBy([{ productId: ${p1} }], "productId");\n$ = { p: $.items.productId };`,
    );
    expect(kept.map((r) => String(r.p))).toEqual([ID.product(1).toHexString()]);
  });

  it("pipeline: .size() after .flatMap counts one joined document per line", async () => {
    const rows = await aggregate(
      "users",
      `$match($._id === 0x6500000000000000000000a1);
$.n = $$$.orders.filter({ userId: $._id }).flatMap("items").size();
$.m = $$$.orders.filter({ userId: $._id }).flatMap("items").map(i => i.qty).size();
$.lines = $$$.orders.filter({ userId: $._id }).map(o => o.items.size());
$ = { n: $.n, m: $.m, lines: $.lines };`,
    );
    expect(rows).toEqual([{ n: 6, m: 6, lines: [2, 1, 3] }]);
  });

  it("pipeline: collaborative filtering in the JavaScript-native spelling — .flatMap in the join, a destructured sort key, `in`", async () => {
    const rows = await aggregate(
      "users",
      `const userId = 0x6500000000000000000000a2;
$$.filter({ _id: userId });
assert($$.size() === 1, "User not found");

const myProductIds = $$$.orders
  .filter({ userId })
  .$sort({ placedAt: -1 })
  .take(10)
  .flatMap("items")
  .map("productId")
  .uniq();

const candidateProductIdCounts = $$$.orders
  .filter(o => o.items.some(i => myProductIds.has(i.productId)) && o.placedAt > Date("2025-01-01"))
  .toSorted({ placedAt: -1 })
  .take(100)
  .flatMap("items")
  .filter(i => !myProductIds.has(i.productId))
  .countBy("productId")
  .entries()
  .sortBy(([id, count]) => -count)
  .take(10) // top 10
  .fromEntries();
const candidateProductIds = candidateProductIdCounts.keys().map(id => id.toObjectId());

const candidateProducts = $$$.products
  .filter(pr => candidateProductIds.has(pr._id))
  .$limit(500);

$$ = candidateProductIds
  .map(id => ({
    productId: id,
    score: candidateProductIdCounts[id],
    name: candidateProducts.find({ _id: id }).name,
  }))
  .orderBy({ score: -1, name: 1 });`,
    );
    expect(rows).toEqual([
      { productId: ID.product(1), score: 2, name: "Mechanical Keyboard" },
      { productId: ID.product(7), score: 1, name: "4K Monitor" },
      { productId: ID.product(5), score: 1, name: "Ergonomic Chair" },
      { productId: ID.product(2), score: 1, name: "USB-C Cable" },
    ]);
  });
});
