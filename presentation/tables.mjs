// The result table under every whole-query slide. Each example is RUN on the
// project's mongod (:27018, scratch db) over a small fixture, and the documents
// that come back are written to examples/tables.json — so a table on a slide is
// the query's real output, never typed in. Re-run after changing an example.
import { MongoClient, ObjectId } from "mongodb";
import { readFileSync, writeFileSync } from "node:fs";
import { SCRATCH_URI } from "../test/fixtures/config.ts";
import { jsmql } from "../src/index.ts";
import "../src/globals.ts";

const S = process.argv[2] ?? "presentation/examples";
const read = (f) => readFileSync(`${S}/${f}`, "utf8").replace(/\s+$/, "");
const c = new MongoClient(SCRATCH_URI);
await c.connect();
const db = c.db("jsmql_probe");
const reset = async (docs) => {
  for (const [name, rows] of Object.entries(docs)) {
    await db.collection(name).deleteMany({});
    if (rows.length) await db.collection(name).insertMany(rows);
  }
};
const plain = (v) =>
  v instanceof ObjectId
    ? { $oid: v.toHexString() }
    : v instanceof Date
      ? v.toISOString().slice(0, 10)
      : Array.isArray(v)
        ? v.map(plain)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
          : v;
const run = async (coll, pipeline) => (await db.collection(coll).aggregate(pipeline).toArray()).map(plain);
const tables = {};

// addr — the .filter(Boolean).join(" ") expression, four addresses with blanks
await reset({
  addresses: [
    {
      _id: 1,
      building: "Level 3",
      streetNo: "42",
      street: "George St",
      suburb: "Sydney",
      state: "NSW",
      country: "AU",
      postcode: "2000",
    },
    {
      _id: 2,
      building: null,
      streetNo: "7",
      street: "Elm Ave",
      suburb: "Perth",
      state: "WA",
      country: "AU",
      postcode: "6000",
    },
    {
      _id: 3,
      building: "",
      streetNo: "10",
      street: "Main St",
      suburb: null,
      state: "QLD",
      country: "AU",
      postcode: "",
    },
    {
      _id: 4,
      building: "Unit 2",
      streetNo: "",
      street: "",
      suburb: "Cairns",
      state: null,
      country: "AU",
      postcode: "4870",
    },
  ],
});
tables.addr = await run("addresses", [{ $project: { _id: 0, fullAddress: jsmql.expr(read("addr.jsmql")) } }]);

// wow — recommended products: one user, five orders, six products
const uid = new ObjectId("507f1f77bcf86cd799439011");
const P = Array.from({ length: 6 }, (_, i) => new ObjectId(`6000000000000000000000${String(i).padStart(2, "0")}`));
await reset({
  users: [{ _id: uid, name: "me" }],
  products: P.map((id, i) => ({ _id: id, name: ["Widget", "Gadget", "Doohickey", "Gizmo", "Sprocket", "Flange"][i] })),
  orders: [
    { userId: uid, createdAt: new Date("2026-08-01"), productIds: [P[0], P[1]] },
    { userId: "u2", createdAt: new Date("2026-08-02"), productIds: [P[1], P[2]] },
    { userId: "u3", createdAt: new Date("2026-08-03"), productIds: [P[0], P[3], P[4]] },
    { userId: "u5", createdAt: new Date("2026-08-04"), productIds: [P[0], P[3]] },
    { userId: "u4", createdAt: new Date("2026-08-05"), productIds: [P[5]] },
  ],
});
tables.wow = await run("users", jsmql(read("wow.jsmql")));

// q1 / q2 - the two whole-query SQL comparisons. Both run over ONE orders
// collection, so each order carries the fields both queries read. The data is
// random but SEEDED, so every build produces exactly the same table.
const rnd = (() => {
  let x = 20260916;
  return () => (x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32;
})();
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const PRODUCTS = [
  ["p01", "Widget", 300],
  ["p02", "Gadget", 500],
  ["p03", "Doohickey", 20],
  ["p04", "Gizmo", 150],
  ["p05", "Sprocket", 80],
  ["p06", "Flange", 45],
  ["p07", "Grommet", 12],
  ["p08", "Cog", 220],
  ["p09", "Bracket", 65],
  ["p10", "Spindle", 190],
  ["p11", "Washer", 8],
  ["p12", "Bearing", 110],
];
const CUSTOMERS = [
  ["c01", "Ann Petrova"],
  ["c02", "Bob Ngo"],
  ["c03", "Cy Alvarez"],
  ["c04", "Dana Fischer"],
  ["c05", "Eli Okafor"],
  ["c06", "Farah Haddad"],
  ["c07", "Gus Lindqvist"],
  ["c08", "Hana Sato"],
  ["c09", "Ivan Toth"],
  ["c10", "Jo Mbeki"],
  ["c11", "Kai Brennan"],
  ["c12", "Lia Rossi"],
  ["c13", "Moe Darwish"],
];
const day = (n) => new Date(Date.UTC(2026, 0, 1 + n));
const shopOrders = [];
// ten customers clear the 1000 threshold q2 filters on; three stay under it
const CHEAP = PRODUCTS.filter(([, , price]) => price <= 20);
CUSTOMERS.forEach(([cid], i) => {
  // The first ten clear q2's 1000 threshold; the last three must stay UNDER it,
  // so they buy only cheap parts and stop well short of the line.
  const big = i < 10;
  const target = big ? 1400 + rnd() * 6000 : 300 + rnd() * 300;
  let spent = 0;
  while (spent < target) {
    const [pid, , price] = pick(big ? PRODUCTS : CHEAP);
    const qty = 1 + Math.floor(rnd() * (big ? 5 : 2));
    shopOrders.push({
      customerId: cid,
      productId: pid,
      qty,
      price,
      total: qty * price,
      status: "paid",
      createdAt: day(Math.floor(rnd() * 250)),
    });
    spent += qty * price;
  }
});
// Rows the filters must drop. q1 drops both (unpaid, or not this year); q2 reads
// only `status`, so these go to customers ALREADY past its threshold — a dropped
// row must not be what lifts a customer over the line.
const bigSpender = () => CUSTOMERS[Math.floor(rnd() * 10)][0];
for (let i = 0; i < 6; i++) {
  const [pid, , price] = pick(PRODUCTS);
  shopOrders.push({
    customerId: bigSpender(),
    productId: pid,
    qty: 9,
    price,
    total: 9 * price,
    status: i % 2 ? "pending" : "paid",
    createdAt: i % 2 ? day(60) : new Date(Date.UTC(2025, 5, 1)),
  });
}
await reset({
  products: PRODUCTS.map(([_id, name]) => ({ _id, name })),
  customers: CUSTOMERS.map(([_id, name]) => ({ _id, name })),
  orders: shopOrders,
});
tables.q1 = await run("orders", jsmql(read("q1.jsmql")));
tables.q2 = await run("orders", jsmql(read("q2.jsmql")));

// lodashAfter — the body of the compile() on the overfetch slide, bound to its `since`
tables.lodashAfter = await run(
  "orders",
  jsmql(`$$.filter(o => o.status === "paid" && o.createdAt >= new Date("2026-07-10"))
  .groupBy({ _id: $.customerId, revenue: $sum($.total) })
  .orderBy({ revenue: -1 })
  .take(10);`),
);

writeFileSync(`${S}/tables.json`, JSON.stringify(tables, null, 1));
for (const [k, v] of Object.entries(tables)) console.log(`${k.padEnd(12)} ${v.length} rows  ${JSON.stringify(v[0])}`);
await c.close();
