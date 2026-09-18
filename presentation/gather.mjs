// Gathers every code example for the deck. The JSMQL sources are the input of
// record; their MQL is COMPILED here with the real library and printed with
// jsmql.stringify — the one printer the playground and the site also use — so a
// slide and the live playground show byte-identical output and cannot drift apart.
import { readFileSync, writeFileSync } from "node:fs";
import { jsmql } from "../src/index.ts";
import "../src/globals.ts";

const S = process.argv[2];
const OUT = process.argv[3];
const read = (f) => readFileSync(`${S}/${f}`, "utf8").replace(/\s+$/, "");
const lines = (s) => s.split("\n").length;
// Non-whitespace characters: the honest "how much did you actually type" measure —
// LOC rewards line breaks, this doesn't.
const chars = (s) => s.replace(/\s+/g, "").length;

const pair = (name, srcFile, extra = {}) => {
  const src = read(srcFile);
  const compiled = name === "addr" ? jsmql.expr(src) : jsmql(src);
  const mql = jsmql.stringify(compiled); // the library's one printer — same text as the playground
  return {
    [name]: {
      src,
      mql,
      srcLines: lines(src),
      srcChars: chars(src),
      sqlLines: extra.sql ? lines(extra.sql) : 0,
      sqlChars: extra.sql ? chars(extra.sql) : 0,
      mqlLines: lines(mql),
      mqlChars: mql.length, // raw length incl. whitespace — the wall's KB size reads this
      mqlCharsTyped: chars(mql), // non-whitespace — "how much would you have typed"
      stages: Array.isArray(compiled) ? compiled.map((st) => Object.keys(st)[0]) : null,
      ...extra,
    },
  };
};

const SQL = {
  q1: `WITH top_products AS (
  SELECT oi.product_id,
         SUM(oi.qty * oi.price) AS revenue
  FROM order_items oi
  WHERE oi.created_at >= DATE_TRUNC('year', NOW())
    AND oi.status = 'paid'
  GROUP BY oi.product_id
  ORDER BY revenue DESC
  LIMIT 10
)
SELECT t.product_id, t.revenue, p.name
FROM top_products t
JOIN products p ON p.id = t.product_id
ORDER BY t.revenue DESC;`,
  q2: `WITH by_customer AS (
  SELECT o.customer_id, SUM(o.total) AS revenue
  FROM orders o
  WHERE o.status = 'paid'
  GROUP BY o.customer_id
  HAVING SUM(o.total) > 1000
)
SELECT b.customer_id, b.revenue, c.name
FROM by_customer b
JOIN customers c ON c.id = b.customer_id
ORDER BY b.revenue DESC;`,
  addr: `SELECT array_to_string(
  array_remove(ARRAY[
    CASE WHEN building IS NOT NULL
         AND building <> '' THEN building || ','
    END,
    NULLIF(street_no, ''),
    NULLIF(street, ''),
    NULLIF(suburb, ''),
    NULLIF(state, ''),
    NULLIF(country, ''),
    NULLIF(postcode, '')
  ], NULL),
  ' '
) AS full_address
FROM addresses;`,
  wow: `WITH myProductIds AS (
  SELECT DISTINCT opi.productId
  FROM (
    SELECT o._id FROM orders o
    WHERE o.userId = '507f1f77bcf86cd799439011'
    ORDER BY o.createdAt DESC
    LIMIT 10
  ) recent
  JOIN orderProductIds opi ON opi.orderId = recent._id
),

coPurchases AS (
  SELECT o._id
  FROM orders o
  WHERE EXISTS (
    SELECT 1 FROM orderProductIds opi
    WHERE opi.orderId = o._id
      AND opi.productId IN (SELECT productId FROM myProductIds)
  )
  ORDER BY o.createdAt DESC
  LIMIT 100
),

candidateProductIdCounts AS (
  SELECT opi.productId, COUNT(*) AS score
  FROM orderProductIds opi
  WHERE opi.orderId IN (SELECT _id FROM coPurchases)
    AND opi.productId NOT IN (SELECT productId FROM myProductIds)
  GROUP BY opi.productId
  ORDER BY score DESC
  LIMIT 10
)

SELECT c.productId, c.score, p.name
FROM candidateProductIdCounts c
JOIN products p ON p._id = c.productId
ORDER BY c.score DESC
LIMIT 10;`,
};

const LODASH_BEFORE = `// 200 000 documents over the wire, into Node's heap.
const since = new Date("2026-07-10");

const orders = await db.collection("orders")
  .find({ status: "paid", createdAt: { $gte: since } })
  .toArray();

const top = _(orders)
  .groupBy("customerId")
  .map((rows, id) => ({ id, revenue: _.sumBy(rows, "total") }))
  .orderBy("revenue", "desc")
  .take(10)
  .value();`;

const LODASH_AFTER = `// 10 documents over the wire. The database does the work.
const since = new Date("2026-07-10");

const topCustomers = jsmql.compile(({ since }, { $ }) => {
  $$.filter(o => o.status === "paid" && o.createdAt >= since)
    .groupBy({ _id: $.customerId, revenue: $sum($.total) })
    .orderBy({ revenue: -1 })
    .take(10);
});

const top = await db.collection("orders")
  .aggregate(topCustomers({ since }))
  .toArray();`;

/* ---------------------------------------------------------------------------
   Operator-level SQL vs JSMQL rows. The JSMQL is the input of record and is
   COMPILED here — a row that does not compile aborts the build. The compiled
   MQL is kept for the mongod verification only; the slides never show it.
   `sql` is either one standard-SQL string, or one string per dialect when the
   dialects disagree — that disagreement is the point of the row.
   ------------------------------------------------------------------------ */
const D = (dialect, q) => ({ dialect, q });
const OPS = {
  // Ten rows: the six where SQL needs a subquery, a window or a keyword JSMQL
  // does not (b), and four analytics shapes where JSMQL is a line or two and
  // SQL needs a junction table or a window function (a).
  a: {
    title: "Where SQL runs out of words",
    rows: [
      {
        idea: 'Any line item tagged "gift"',
        sql: `EXISTS (SELECT 1 FROM order_items i
          JOIN item_tags t ON t.item_id = i.id
         WHERE i.order_id = o.id AND t.tag = 'gift')`,
        js: `$.items.some(i => i.tags.includes("gift"))`,
        mode: "expr",
      },
      {
        idea: "Price of the first line item",
        sql: `(SELECT i.price FROM order_items i
  WHERE i.order_id = o.id
  ORDER BY i.position LIMIT 1)`,
        js: `$.items[0].price`,
        mode: "expr",
      },
      {
        idea: "Each customer's last 3 order totals",
        sql: `SELECT customer_id,
       ARRAY_AGG(total ORDER BY created_at DESC) AS last3
FROM (SELECT *, ROW_NUMBER() OVER
        (PARTITION BY customer_id ORDER BY created_at DESC) AS rn
      FROM orders) t
WHERE rn <= 3
GROUP BY customer_id`,
        js: `$$.sort({ createdAt: -1 })
  .groupBy({ _id: $.customerId, last3: $push($.total) });
$.last3 = $.last3.slice(0, 3);`,
        mode: "pipeline",
      },
      {
        idea: "Distinct products per customer",
        sql: `SELECT o.customer_id, COUNT(DISTINCT p.product_id) AS distinct_products
FROM orders o
JOIN order_products p ON p.order_id = o.id
GROUP BY o.customer_id`,
        js: `$$.groupBy({ _id: $.customerId, products: $addToSet($.productIds) });
$.distinctProducts = $.products.flat().uniq().length;`,
        mode: "pipeline",
      },
    ],
  },
  b: {
    title: "Where SQL runs out of words",
    rows: [
      {
        idea: "Join the tags into one string",
        sql: `COALESCE((SELECT string_agg(t.tag, ', ')
   FROM order_tags t WHERE t.order_id = o.id), '')`,
        js: `$.tags.join(", ")`,
        mode: "expr",
      },
      {
        idea: "Sum the line items",
        sql: `(SELECT SUM(i.qty * i.price)
   FROM order_items i WHERE i.order_id = o.id)`,
        js: `$.items.sumBy((i) => i.qty * i.price)`,
        mode: "expr",
      },
      {
        idea: "Count per status",
        sql: `SELECT status, COUNT(*) FROM orders GROUP BY status`,
        js: `$$.countBy("status");`,
        mode: "pipeline",
      },
      {
        idea: "Filter after the group",
        sql: `SELECT customer_id, SUM(total) AS spent FROM orders
GROUP BY customer_id HAVING SUM(total) > 1000`,
        js: `$$.$group({ _id: $.customerId, spent: $sum($.total) })
  .filter((c) => c.spent > 1000);`,
        mode: "pipeline",
      },
      {
        idea: "Latest order per customer",
        sql: `SELECT * FROM (
  SELECT *, ROW_NUMBER() OVER
    (PARTITION BY customer_id ORDER BY created_at DESC) AS rn
  FROM orders) t WHERE rn = 1`,
        js: `$$.sort({ createdAt: -1 }).uniqBy("customerId");`,
        mode: "pipeline",
      },
    ],
  },
};
for (const slide of Object.values(OPS)) {
  for (const row of slide.rows) {
    const compiled = row.mode === "expr" ? jsmql.expr(row.js) : jsmql(row.js); // throws → build aborts
    row.mql = jsmql.stringify(compiled);
  }
}

// The alert-rate report, verbatim from production, and the table its run produced
// (the developer's own export — sorted by day here, as the query's .sortBy("_id") does).
const ALERT_CSV = `"alerted","total","UTC","unalerted","alertPcnt"
"244","10787","2026-09-11","10543",2.26
"339","5685","2026-09-01","5346",5.96
"315","6958","2026-09-02","6643",4.53
"288","6410","2026-09-03","6122",4.49
"350","7888","2026-09-04","7538",4.44
"415","8164","2026-09-05","7749",5.08
"227","6088","2026-09-06","5861",3.73
"314","6778","2026-09-07","6464",4.63
"297","9257","2026-09-08","8960",3.21
"276","9938","2026-09-09","9662",2.78
"310","10698","2026-09-10","10388",2.9
"182","9859","2026-09-12","9677",1.85
"112","7784","2026-09-13","7672",1.44
"195","7025","2026-09-14","6830",2.78
"87","3278","2026-09-15","3191",2.65`;
const ALERT_TABLE = ALERT_CSV.split("\n")
  .slice(1)
  .map((line) => {
    const [alerted, total, UTC, unalerted, alertPcnt] = line.split(",").map((x) => x.replace(/^"|"$/g, ""));
    return { UTC, total: +total, alerted: +alerted, unalerted: +unalerted, alertPcnt: +alertPcnt };
  })
  .sort((a, b) => a.UTC.localeCompare(b.UTC));

// Result tables: examples/tables.json is written by tables.mjs, which RUNS each
// example on mongod and records the documents that came back.
const TABLES = JSON.parse(readFileSync(`${S}/tables.json`, "utf8"));

const data = {
  ...pair("wow", "wow.jsmql", { sql: SQL.wow }),
  ...pair("addr", "addr.jsmql", { sql: SQL.addr }),
  ...pair("q1", "q1.jsmql", { sql: SQL.q1 }),
  ...pair("q2", "q2.jsmql", { sql: SQL.q2 }),
  ...pair("lodash", "lodash.jsmql"),
  ...pair("alert", "alert.jsmql", { table: ALERT_TABLE }),
  tables: TABLES,
  // The Friday query, VERBATIM as hand-written on 20 Dec 2024 — a historical
  // artefact, deliberately NOT compiler output. Never reformat it.
  friday: { mql: read("friday.mql"), mqlLines: lines(read("friday.mql")) },
  lodashBefore: LODASH_BEFORE,
  lodashAfter: LODASH_AFTER,
  ops: OPS,
};

writeFileSync(OUT, JSON.stringify(data, null, 1));
for (const [k, v] of Object.entries(data)) {
  if (v && v.srcLines)
    console.log(
      `${k.padEnd(8)} src ${String(v.srcLines).padStart(3)} lines → MQL ${String(v.mqlLines).padStart(4)} lines`,
    );
}
for (const [k, s] of Object.entries(OPS)) console.log(`ops.${k}     ${s.rows.length} rows compiled`);
