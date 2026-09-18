// Differential check for the deck's operator rows: each JSMQL row runs on the
// project's mongod (:27018, scratch db) and its PostgreSQL row runs on an
// in-process PostgreSQL 17 (PGlite), over the same dataset. Results must agree.
// MySQL / SQL Server dialect lines cannot be executed here; they are checked
// against their vendors' documentation and printed for eyeballing.
import { MongoClient } from "mongodb";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { SCRATCH_URI } from "../test/fixtures/config.ts";
import { jsmql } from "../src/index.ts";
import "../src/globals.ts";

// PGlite is not a project dependency: point PGLITE_DIR at any directory where
// `npm i @electric-sql/pglite` has been run (it is a WASM PostgreSQL, no daemon).
const PG_DIR = process.env.PGLITE_DIR;
if (!PG_DIR) {
  console.error("set PGLITE_DIR to a directory holding node_modules/@electric-sql/pglite");
  process.exit(2);
}
const { PGlite } = await import(createRequire(PG_DIR + "/package.json").resolve("@electric-sql/pglite"));
const pg = new PGlite();

const EX = JSON.parse(readFileSync(new URL("./examples.json", import.meta.url), "utf8"));
const rows = [...EX.ops.a.rows, ...EX.ops.b.rows];
const byIdea = Object.fromEntries(rows.map((r) => [r.idea, r]));

// ---- dataset ---------------------------------------------------------------
const D = (s) => new Date(s);
const orders = [
  {
    _id: 1,
    n: 1,
    total: 1500,
    customerId: "c1",
    status: "paid",
    createdAt: D("2026-03-05T10:00:00Z"),
    shippedAt: D("2026-03-09T08:00:00Z"),
    email: "ann@example.com",
    tags: ["gift", "express"],
    productIds: ["p1", "p2"],
    items: [
      { qty: 2, price: 500, tags: ["gift"] },
      { qty: 1, price: 500, tags: [] },
    ],
  },
  {
    _id: 2,
    n: 2,
    total: 250,
    customerId: "c1",
    status: "paid",
    createdAt: D("2026-03-20T10:00:00Z"),
    shippedAt: D("2026-03-20T18:00:00Z"),
    email: "ann@example.org",
    tags: ["gift"],
    productIds: ["p1"],
    items: [{ qty: 5, price: 50, tags: ["bulk"] }],
  },
  {
    _id: 3,
    n: 3,
    total: 40,
    customerId: "c2",
    status: "pending",
    createdAt: D("2026-04-01T00:30:00Z"),
    shippedAt: D("2026-04-11T00:00:00Z"),
    email: "bob@example.com",
    tags: [],
    productIds: ["p3"],
    items: [{ qty: 1, price: 40, tags: [] }],
  },
  {
    _id: 4,
    n: 4,
    total: 900,
    customerId: "c2",
    status: "paid",
    createdAt: D("2026-04-15T12:00:00Z"),
    shippedAt: D("2026-05-01T12:00:00Z"),
    email: "bob@test.com",
    tags: ["b2b", "invoice", "net30"],
    productIds: ["p3", "p4"],
    items: [{ qty: 3, price: 300, tags: ["b2b", "gift"] }],
  },
  {
    _id: 5,
    n: 5,
    total: 120,
    customerId: "c3",
    status: "paid",
    createdAt: D("2026-05-02T23:59:00Z"),
    shippedAt: D("2026-05-03T00:01:00Z"),
    email: "cy@example.com",
    tags: ["express"],
    productIds: ["p2"],
    items: [
      { qty: 1, price: 100, tags: ["express"] },
      { qty: 2, price: 10, tags: [] },
    ],
  },
  {
    _id: 6,
    n: 6,
    total: 60,
    customerId: "c1",
    status: "paid",
    createdAt: D("2026-06-01T09:00:00Z"),
    shippedAt: D("2026-06-02T09:00:00Z"),
    email: "ann@example.com",
    tags: [],
    productIds: ["p2", "p4"],
    items: [{ qty: 2, price: 30, tags: [] }],
  },
  {
    _id: 7,
    n: 7,
    total: 75,
    customerId: "c1",
    status: "paid",
    createdAt: D("2026-06-10T09:00:00Z"),
    shippedAt: D("2026-06-11T09:00:00Z"),
    email: "ann@example.com",
    tags: [],
    productIds: ["p1"],
    items: [{ qty: 3, price: 25, tags: [] }],
  },
];

const payments = [
  { _id: 1, orderId: 1, status: "failed" },
  { _id: 2, orderId: 1, status: "ok" },
  { _id: 3, orderId: 1, status: "failed" },
  { _id: 4, orderId: 2, status: "ok" },
  { _id: 5, orderId: 4, status: "failed" },
];

const client = new MongoClient(SCRATCH_URI);
await client.connect();
const db = client.db("jsmql_probe");
await db.collection("orders").deleteMany({});
await db.collection("orders").insertMany(orders);
await db.collection("payments").deleteMany({});
await db.collection("payments").insertMany(payments);

await pg.exec(`
  CREATE TABLE orders (id int, n int, total numeric, customer_id text, status text, created_at timestamptz, shipped_at timestamptz, email text);
  CREATE TABLE order_tags  (order_id int, pos int, tag text);
  CREATE TABLE order_items (id serial, order_id int, position int, qty int, price numeric);
  CREATE TABLE item_tags (item_id int, tag text);
  CREATE TABLE order_products (order_id int, product_id text);
  CREATE TABLE payments (id int, order_id int, status text);
`);
for (const o of orders) {
  await pg.query("INSERT INTO orders VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
    o._id,
    o.n,
    o.total,
    o.customerId,
    o.status,
    o.createdAt,
    o.shippedAt,
    o.email,
  ]);
  for (const [i, t] of o.tags.entries()) await pg.query("INSERT INTO order_tags VALUES ($1,$2,$3)", [o._id, i, t]);
  for (const [i, it] of o.items.entries()) {
    const { rows } = await pg.query(
      "INSERT INTO order_items (order_id, position, qty, price) VALUES ($1,$2,$3,$4) RETURNING id",
      [o._id, i, it.qty, it.price],
    );
    for (const t of it.tags) await pg.query("INSERT INTO item_tags VALUES ($1,$2)", [rows[0].id, t]);
  }
  for (const pid of o.productIds) await pg.query("INSERT INTO order_products VALUES ($1,$2)", [o._id, pid]);
}
for (const p of payments) await pg.query("INSERT INTO payments VALUES ($1,$2,$3)", [p._id, p.orderId, p.status]);

// ---- helpers ---------------------------------------------------------------
// A row may carry a trailing `-- comment` for the slide; strip it before the
// text is embedded in a larger SELECT, or the comment eats the FROM clause.
const pgSql = (row) =>
  (Array.isArray(row.sql) ? row.sql.find((d) => d.dialect === "PostgreSQL").q : row.sql).replace(/\s*--.*$/gm, "");
const norm = (v) => {
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === "object" && typeof v.getTimezoneOffset === "function") return v.toISOString();
  if (typeof v === "string" && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d/.test(v)) return new Date(v).toISOString();
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v && typeof v === "object" && "low" in v) return Number(v);
  return v;
};
const results = [];
const check = (idea, mongoVal, pgVal) => {
  const a = JSON.stringify(mongoVal),
    b = JSON.stringify(pgVal);
  results.push({ idea, ok: a === b, mongo: a, pg: b });
};

// expr rows: compute per order, compare column-wise
async function exprRow(idea, pgSelectAlias = "v") {
  const row = byIdea[idea];
  const mql = row.mode === "expr" ? jsmql.expr(row.js) : null;
  const m = await db
    .collection("orders")
    .aggregate([{ $addFields: { __v: mql } }, { $sort: { _id: 1 } }, { $project: { _id: 1, __v: 1 } }])
    .toArray();
  const p = await pg.query(`SELECT o.id, ${pgSql(row)} AS ${pgSelectAlias} FROM orders o ORDER BY o.id`);
  check(
    idea,
    m.map((d) => norm(d.__v ?? null)),
    p.rows.map((r) => norm(r[pgSelectAlias] ?? null)),
  );
}

// ---- slide A (analytics) -----------------------------------------------------
await exprRow('Any line item tagged "gift"');
await exprRow("Price of the first line item");
{
  // Each customer's last 3 order totals — arrays, newest first
  const row = byIdea["Each customer's last 3 order totals"];
  const m = await db.collection("orders").aggregate(jsmql(row.js)).toArray();
  const p = await pg.query(row.sql);
  const byId = (xs, k, v) =>
    xs.map((d) => ({ _id: d[k], last3: d[v].map(Number) })).sort((a, b) => a._id.localeCompare(b._id));
  check(row.idea, byId(m, "_id", "last3"), byId(p.rows, "customer_id", "last3"));
}
{
  // Distinct products per customer
  const row = byIdea["Distinct products per customer"];
  const m = await db.collection("orders").aggregate(jsmql(row.js)).toArray();
  const p = await pg.query(row.sql);
  const byId = (xs, k, v) => xs.map((d) => ({ _id: d[k], n: Number(d[v]) })).sort((a, b) => a._id.localeCompare(b._id));
  check(row.idea, byId(m, "_id", "distinctProducts"), byId(p.rows, "customer_id", "distinct_products"));
}

// ---- slide B ---------------------------------------------------------------
await exprRow("Join the tags into one string");
await exprRow("Sum the line items");

{
  // Count per status — one object in JSMQL, rows in SQL; compare as a map
  const row = byIdea["Count per status"];
  const m = await db.collection("orders").aggregate(jsmql(row.js)).toArray();
  const p = await pg.query(row.sql);
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  check(
    row.idea,
    sorted(m[0]),
    Object.fromEntries(p.rows.sort((a, b) => a.status.localeCompare(b.status)).map((r) => [r.status, Number(r.count)])),
  );
}
{
  // Filter after the group
  const row = byIdea["Filter after the group"];
  const m = await db.collection("orders").aggregate(jsmql(row.js)).toArray();
  const p = await pg.query(row.sql);
  const sortId = (xs) => xs.sort((a, b) => a._id.localeCompare(b._id));
  check(
    row.idea,
    sortId(m.map((d) => ({ _id: d._id, spent: d.spent }))),
    sortId(p.rows.map((r) => ({ _id: r.customer_id, spent: Number(r.spent) }))),
  );
}
{
  // Latest order per customer
  const row = byIdea["Latest order per customer"];
  const m = await db.collection("orders").aggregate(jsmql(row.js)).toArray();
  const p = await pg.query(row.sql);
  const ids = (xs) => xs.map((d) => d._id ?? d.id).sort();
  check(row.idea, ids(m), ids(p.rows));
}

// ---- report ----------------------------------------------------------------
let bad = 0;
for (const r of results) {
  console.log(`${r.ok ? "✅" : "❌"} ${r.idea}`);
  if (!r.ok) {
    bad++;
    console.log("   mongo:", r.mongo);
    console.log("   pg:   ", r.pg);
  } else console.log("   ", r.mongo.slice(0, 110));
}
console.log(`\n${results.length - bad}/${results.length} rows agree (mongod :27018 vs PostgreSQL 17)`);
console.log("\nDialect lines not executed here (MySQL / SQL Server):");
for (const r of rows)
  if (Array.isArray(r.sql))
    for (const d of r.sql) if (d.dialect !== "PostgreSQL") console.log(`  [${d.dialect}] ${d.q}`);
await client.close();
process.exit(bad ? 1 : 0);
