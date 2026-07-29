// test/fixtures/dataset.ts — the deterministic e-commerce dataset the integration
// suite runs real queries against.
//
// HARD INVARIANT: this data is DETERMINISTIC. Fixed ObjectIds, fixed dates, fixed
// numbers — no Math.random(), no Date.now(). Integration tests assert exact
// returned documents, so the data must be byte-identical on every machine and
// every run. `DATASET_HASH` fingerprints the content; the seeder re-injects only
// when the hash changes (see test/fixtures/instance.ts).
//
// Order line-item prices and order totals are COMPUTED from the product catalogue
// (see `buildOrders`), not hand-typed, so they can never drift out of sync. A
// `validateDataset()` cross-check runs at seed time as a final guard.
//
// EXPAND THIS FREELY. The dataset is meant to grow as new queries need realistic
// data. After any edit you MUST re-insert it into mongod (`npm run fixture:seed`)
// — the tests query the server, not this file. See test/fixtures/CLAUDE.md
// § "Expanding / changing the data".

import { ObjectId } from "mongodb";
import { createHash } from "node:crypto";

// ── Deterministic ObjectIds ────────────────────────────────────────────────
// 24-hex id with a fixed, PLAUSIBLE timestamp prefix (0x65000000 = 2023-09-12)
// followed by a collection tag (a=users b=products c=orders d=shipments
// e=reviews) and the index, e.g. id("a", 1) -> 650000000000000000000a1. The
// plausible prefix matters: jsmql's `0x…` ObjectId literal rejects ids whose
// embedded timestamp predates 2009 (MongoDB's first release), so an all-zero
// prefix would make "find by _id via the 0x literal" un-queryable. Readable in
// output and stable forever.
const TS_PREFIX = "65000000";
const id = (tag: string, n: number) => new ObjectId(TS_PREFIX + (tag + n).padStart(16, "0"));
export const ID = {
  user: (n: number) => id("a", n),
  product: (n: number) => id("b", n),
  order: (n: number) => id("c", n),
  shipment: (n: number) => id("d", n),
  review: (n: number) => id("e", n),
};

const D = (iso: string) => new Date(iso + "T00:00:00.000Z");

// ── users ───────────────────────────────────────────────────────────────────
// active/inactive, four loyalty tiers, three countries, nested subscription +
// profile, one deliberately-null email (u5), one with no orders (u7).
export const users = [
  {
    _id: ID.user(1),
    name: "Ada Lovelace",
    email: "ada@example.com",
    active: true,
    status: "active",
    tier: "platinum",
    country: "AU",
    department: "engineering",
    createdAt: D("2025-01-15"),
    lastSeen: D("2026-06-10"),
    expiresAt: D("2026-12-01"),
    subscription: { tier: "premium", renews: true },
    profile: { bio: "Countess of computing", verified: true },
    tags: ["vip", "beta"],
    visits: 142,
  },
  {
    _id: ID.user(2),
    name: "Alan Turing",
    email: "alan@turing.org",
    active: true,
    status: "active",
    tier: "gold",
    country: "AU",
    department: "engineering",
    createdAt: D("2025-02-20"),
    lastSeen: D("2026-06-15"),
    expiresAt: D("2026-07-01"),
    subscription: { tier: "premium", renews: true },
    profile: { bio: "Father of computer science", verified: true },
    tags: ["beta"],
    visits: 88,
  },
  {
    _id: ID.user(3),
    name: "Grace Hopper",
    email: "grace@navy.mil",
    active: true,
    status: "active",
    tier: "gold",
    country: "US",
    department: "sales",
    createdAt: D("2025-03-10"),
    lastSeen: D("2026-05-30"),
    expiresAt: D("2026-09-01"),
    subscription: { tier: "basic", renews: false },
    profile: { bio: "Compiler pioneer", verified: true },
    tags: ["vip"],
    visits: 64,
  },
  {
    _id: ID.user(4),
    name: "Katherine Johnson",
    email: "kat@nasa.gov",
    active: false,
    status: "expired",
    tier: "silver",
    country: "US",
    department: "sales",
    createdAt: D("2024-11-05"),
    lastSeen: D("2024-12-20"),
    expiresAt: D("2025-04-01"),
    subscription: { tier: "premium", renews: false },
    profile: { bio: "Orbital mechanics", verified: false },
    tags: [],
    visits: 12,
  },
  {
    _id: ID.user(5),
    name: "Margaret Hamilton",
    email: null,
    active: true,
    status: "active",
    tier: "silver",
    country: "NZ",
    department: "engineering",
    createdAt: D("2025-06-01"),
    lastSeen: D("2026-06-18"),
    expiresAt: D("2027-01-01"),
    subscription: { tier: "basic", renews: true },
    profile: { bio: "Apollo flight software", verified: true },
    tags: ["beta"],
    visits: 200,
  },
  {
    _id: ID.user(6),
    name: "Dorothy Vaughan",
    email: "dorothy@example.com",
    active: true,
    status: "active",
    tier: "premium",
    country: "US",
    department: "support",
    createdAt: D("2025-04-12"),
    lastSeen: D("2026-06-01"),
    expiresAt: D("2026-06-15"),
    subscription: { tier: "premium", renews: true },
    profile: { bio: "FORTRAN expert", verified: true },
    tags: ["vip"],
    visits: 31,
  },
  {
    _id: ID.user(7),
    name: "Joan Clarke",
    email: "joan@bletchley.uk",
    active: false,
    status: "pending",
    tier: "gold",
    country: "AU",
    department: "support",
    createdAt: D("2026-05-20"),
    lastSeen: D("2026-05-25"),
    expiresAt: D("2026-08-01"),
    subscription: { tier: "basic", renews: false },
    profile: { bio: "Bletchley Park cryptanalyst", verified: false },
    tags: [],
    visits: 3,
  },
  {
    _id: ID.user(8),
    name: "Hedy Lamarr",
    email: "hedy@example.com",
    active: true,
    status: "active",
    tier: "platinum",
    country: "AU",
    department: "engineering",
    createdAt: D("2025-09-09"),
    lastSeen: D("2026-06-17"),
    expiresAt: D("2026-11-11"),
    subscription: { tier: "premium", renews: true },
    profile: { bio: "Frequency-hopping inventor", verified: true },
    tags: ["vip", "beta"],
    visits: 77,
  },
];

// ── products ──────────────────────────────────────────────────────────────────
export const products = [
  {
    _id: ID.product(1),
    name: "Mechanical Keyboard",
    price: 120,
    inStock: true,
    category: "electronics",
    tags: ["input", "rgb"],
    stock: 40,
    rating: 4.6,
  },
  {
    _id: ID.product(2),
    name: "USB-C Cable",
    price: 15,
    inStock: true,
    category: "electronics",
    tags: ["cable"],
    stock: 500,
    rating: 4.1,
  },
  {
    _id: ID.product(3),
    name: "Noise-cancelling Headphones",
    price: 250,
    inStock: true,
    category: "electronics",
    tags: ["audio", "wireless"],
    stock: 12,
    rating: 4.8,
  },
  {
    _id: ID.product(4),
    name: "Standing Desk",
    price: 600,
    inStock: false,
    category: "furniture",
    tags: ["office"],
    stock: 0,
    rating: 4.4,
  },
  {
    _id: ID.product(5),
    name: "Ergonomic Chair",
    price: 350,
    inStock: true,
    category: "furniture",
    tags: ["office", "ergonomic"],
    stock: 8,
    rating: 4.5,
  },
  {
    _id: ID.product(6),
    name: "Laptop Stand",
    price: 45,
    inStock: true,
    category: "accessories",
    tags: ["office"],
    stock: 120,
    rating: 4.0,
  },
  {
    _id: ID.product(7),
    name: "4K Monitor",
    price: 400,
    inStock: true,
    category: "electronics",
    tags: ["display"],
    stock: 25,
    rating: 4.7,
  },
  {
    _id: ID.product(8),
    name: "Webcam",
    price: 90,
    inStock: false,
    category: "electronics",
    tags: ["video"],
    stock: 0,
    rating: 3.9,
  },
  {
    _id: ID.product(9),
    name: "Desk Lamp",
    price: 35,
    inStock: true,
    category: "accessories",
    tags: ["lighting"],
    stock: 60,
    rating: 4.2,
  },
  {
    _id: ID.product(10),
    name: "Notebook",
    price: 8,
    inStock: true,
    category: "stationery",
    tags: ["paper"],
    stock: 1000,
    rating: 4.3,
  },
];

const PRICE = new Map(products.map((p) => [p._id.toHexString(), p.price]));
const PNAME = new Map(products.map((p) => [p._id.toHexString(), p.name]));

// ── orders ────────────────────────────────────────────────────────────────────
// Each spec lists [productId, qty] lines; buildOrders fills in unitPrice (from
// the catalogue), per-line price (qty*unitPrice) and the order total (sum of
// line prices). status ∈ shipped|pending|complete|cancelled.
type OrderSpec = {
  n: number;
  user: number;
  shop: string;
  region: string;
  status: string;
  score: number;
  placedAt: string;
  shippedAt: string | null;
  lines: [ObjectId, number][];
};

const orderSpecs: OrderSpec[] = [
  {
    n: 1,
    user: 1,
    shop: "shop_au",
    region: "AU",
    status: "shipped",
    score: 80,
    placedAt: "2026-01-10",
    shippedAt: "2026-01-12",
    lines: [
      [ID.product(1), 1],
      [ID.product(2), 2],
    ],
  },
  {
    n: 2,
    user: 1,
    shop: "shop_au",
    region: "AU",
    status: "shipped",
    score: 95,
    placedAt: "2026-02-15",
    shippedAt: "2026-02-17",
    lines: [[ID.product(7), 1]],
  },
  {
    n: 3,
    user: 2,
    shop: "shop_au",
    region: "AU",
    status: "pending",
    score: 60,
    placedAt: "2026-06-01",
    shippedAt: null,
    lines: [
      [ID.product(3), 1],
      [ID.product(6), 1],
    ],
  },
  {
    n: 4,
    user: 2,
    shop: "shop_au",
    region: "AU",
    status: "shipped",
    score: 40,
    placedAt: "2026-03-20",
    shippedAt: "2026-03-22",
    lines: [[ID.product(10), 10]],
  },
  {
    n: 5,
    user: 3,
    shop: "shop_us",
    region: "US",
    status: "complete",
    score: 88,
    placedAt: "2026-04-05",
    shippedAt: "2026-04-06",
    lines: [[ID.product(5), 1]],
  },
  {
    n: 6,
    user: 3,
    shop: "shop_us",
    region: "US",
    status: "shipped",
    score: 70,
    placedAt: "2026-05-10",
    shippedAt: "2026-05-12",
    lines: [
      [ID.product(1), 2],
      [ID.product(9), 1],
    ],
  },
  {
    n: 7,
    user: 3,
    shop: "shop_us",
    region: "US",
    status: "cancelled",
    score: 0,
    placedAt: "2026-05-20",
    shippedAt: null,
    lines: [[ID.product(4), 1]],
  },
  {
    n: 8,
    user: 5,
    shop: "shop_au",
    region: "AU",
    status: "shipped",
    score: 92,
    placedAt: "2026-06-02",
    shippedAt: "2026-06-04",
    lines: [[ID.product(3), 2]],
  },
  {
    n: 9,
    user: 5,
    shop: "shop_au",
    region: "AU",
    status: "shipped",
    score: 55,
    placedAt: "2026-06-10",
    shippedAt: "2026-06-11",
    lines: [
      [ID.product(2), 5],
      [ID.product(10), 3],
    ],
  },
  {
    n: 10,
    user: 6,
    shop: "shop_us",
    region: "US",
    status: "shipped",
    score: 90,
    placedAt: "2026-05-28",
    shippedAt: "2026-05-30",
    lines: [
      [ID.product(7), 1],
      [ID.product(1), 1],
    ],
  },
  {
    n: 11,
    user: 6,
    shop: "shop_us",
    region: "US",
    status: "pending",
    score: 30,
    placedAt: "2026-06-15",
    shippedAt: null,
    lines: [[ID.product(8), 1]],
  },
  {
    n: 12,
    user: 8,
    shop: "shop_au",
    region: "AU",
    status: "shipped",
    score: 85,
    placedAt: "2026-04-22",
    shippedAt: "2026-04-24",
    lines: [
      [ID.product(5), 1],
      [ID.product(1), 1],
      [ID.product(2), 1],
    ],
  },
  {
    n: 13,
    user: 8,
    shop: "shop_au",
    region: "AU",
    status: "shipped",
    score: 78,
    placedAt: "2026-06-12",
    shippedAt: "2026-06-14",
    lines: [[ID.product(3), 1]],
  },
  {
    n: 14,
    user: 8,
    shop: "shop_au",
    region: "AU",
    status: "complete",
    score: 50,
    placedAt: "2026-02-02",
    shippedAt: "2026-02-03",
    lines: [[ID.product(6), 2]],
  },
  {
    n: 15,
    user: 1,
    shop: "shop_au",
    region: "AU",
    status: "shipped",
    score: 99,
    placedAt: "2026-06-16",
    shippedAt: "2026-06-18",
    lines: [
      [ID.product(1), 1],
      [ID.product(7), 1],
      [ID.product(3), 1],
    ],
  },
  {
    n: 16,
    user: 4,
    shop: "shop_us",
    region: "US",
    status: "complete",
    score: 20,
    placedAt: "2024-12-01",
    shippedAt: "2024-12-03",
    lines: [[ID.product(10), 5]],
  },
  {
    n: 17,
    user: 2,
    shop: "shop_au",
    region: "AU",
    status: "shipped",
    score: 65,
    placedAt: "2026-05-05",
    shippedAt: "2026-05-07",
    lines: [[ID.product(9), 2]],
  },
  {
    n: 18,
    user: 3,
    shop: "shop_us",
    region: "US",
    status: "shipped",
    score: 82,
    placedAt: "2026-06-09",
    shippedAt: "2026-06-10",
    lines: [
      [ID.product(5), 1],
      [ID.product(6), 1],
    ],
  },
  {
    n: 19,
    user: 6,
    shop: "shop_us",
    region: "US",
    status: "shipped",
    score: 96,
    placedAt: "2026-06-18",
    shippedAt: "2026-06-18",
    lines: [[ID.product(7), 2]],
  },
  {
    n: 20,
    user: 7,
    shop: "shop_au",
    region: "AU",
    status: "pending",
    score: 10,
    placedAt: "2026-06-17",
    shippedAt: null,
    lines: [[ID.product(2), 1]],
  },
];

function buildOrders() {
  return orderSpecs.map((o) => {
    const items = o.lines.map(([pid, qty]) => {
      const hex = pid.toHexString();
      const unitPrice = PRICE.get(hex)!;
      return { productId: pid, name: PNAME.get(hex)!, qty, unitPrice, price: qty * unitPrice };
    });
    const total = items.reduce((s, it) => s + it.price, 0);
    return {
      _id: ID.order(o.n),
      userId: ID.user(o.user),
      shopId: o.shop,
      region: o.region,
      status: o.status,
      score: o.score,
      placedAt: D(o.placedAt),
      shippedAt: o.shippedAt === null ? null : D(o.shippedAt),
      items,
      total,
      // Nested field with a HYPHENATED key — an external-system reference id.
      // Correlating on `$.meta["ext-id"]` inside a `$$$.<coll>.filter(...)` forces
      // the `$lookup.let` var name to be derived from the segment `ext-id`, whose
      // hyphen is illegal in a MongoDB variable name — the regression this exercises
      // end-to-end on a real server. See integration test "hyphenated correlated let".
      meta: { "ext-id": `X-${o.n}` },
      // TOP-LEVEL bracket-accessed field. `$["ext-code"]` in a correlated filter
      // exercises a DIFFERENT code path than the nested `meta["ext-id"]`: the bare
      // root `$` must contribute no path segment, else the field path comes out as
      // `.ext-code` (leading dot) which mongod rejects. See integration test
      // "top-level bracket-accessed correlated field".
      "ext-code": `EC-${o.n}`,
    };
  });
}

export const orders = buildOrders();

// ── shipments ─────────────────────────────────────────────────────────────────
// One per shipped/complete order (subset). carrier ∈ UPS|FedEx|DHL|USPS,
// status ∈ delivered|in_transit|returned, with an ordered `events` array.
type ShipSpec = {
  n: number;
  order: number;
  carrier: string;
  status: string;
  weight: number;
  events: [string, string][]; // [type, dateISO]
};

const shipSpecs: ShipSpec[] = [
  {
    n: 1,
    order: 1,
    carrier: "UPS",
    status: "delivered",
    weight: 1.2,
    events: [
      ["created", "2026-01-12"],
      ["in_transit", "2026-01-13"],
      ["delivered", "2026-01-15"],
    ],
  },
  {
    n: 2,
    order: 2,
    carrier: "FedEx",
    status: "delivered",
    weight: 3.5,
    events: [
      ["created", "2026-02-17"],
      ["delivered", "2026-02-20"],
    ],
  },
  {
    n: 3,
    order: 4,
    carrier: "USPS",
    status: "returned",
    weight: 0.5,
    events: [
      ["created", "2026-03-22"],
      ["in_transit", "2026-03-23"],
      ["returned", "2026-03-30"],
    ],
  },
  {
    n: 4,
    order: 5,
    carrier: "UPS",
    status: "delivered",
    weight: 5.0,
    events: [
      ["created", "2026-04-06"],
      ["delivered", "2026-04-09"],
    ],
  },
  {
    n: 5,
    order: 6,
    carrier: "FedEx",
    status: "in_transit",
    weight: 2.1,
    events: [
      ["created", "2026-05-12"],
      ["in_transit", "2026-05-13"],
    ],
  },
  {
    n: 6,
    order: 8,
    carrier: "DHL",
    status: "delivered",
    weight: 1.8,
    events: [
      ["created", "2026-06-04"],
      ["delivered", "2026-06-07"],
    ],
  },
  {
    n: 7,
    order: 9,
    carrier: "UPS",
    status: "in_transit",
    weight: 0.9,
    events: [
      ["created", "2026-06-11"],
      ["in_transit", "2026-06-12"],
    ],
  },
  {
    n: 8,
    order: 10,
    carrier: "FedEx",
    status: "delivered",
    weight: 4.2,
    events: [
      ["created", "2026-05-30"],
      ["delivered", "2026-06-02"],
    ],
  },
  {
    n: 9,
    order: 12,
    carrier: "UPS",
    status: "delivered",
    weight: 6.0,
    events: [
      ["created", "2026-04-24"],
      ["delivered", "2026-04-27"],
    ],
  },
  {
    n: 10,
    order: 13,
    carrier: "DHL",
    status: "in_transit",
    weight: 1.0,
    events: [
      ["created", "2026-06-14"],
      ["in_transit", "2026-06-15"],
    ],
  },
  {
    n: 11,
    order: 14,
    carrier: "USPS",
    status: "delivered",
    weight: 0.3,
    events: [
      ["created", "2026-02-03"],
      ["delivered", "2026-02-06"],
    ],
  },
  {
    n: 12,
    order: 15,
    carrier: "FedEx",
    status: "in_transit",
    weight: 7.5,
    events: [
      ["created", "2026-06-18"],
      ["in_transit", "2026-06-19"],
    ],
  },
  {
    n: 13,
    order: 17,
    carrier: "UPS",
    status: "delivered",
    weight: 0.4,
    events: [
      ["created", "2026-05-07"],
      ["delivered", "2026-05-10"],
    ],
  },
  {
    n: 14,
    order: 18,
    carrier: "DHL",
    status: "delivered",
    weight: 3.0,
    events: [
      ["created", "2026-06-10"],
      ["delivered", "2026-06-13"],
    ],
  },
  {
    n: 15,
    order: 19,
    carrier: "FedEx",
    status: "in_transit",
    weight: 9.0,
    events: [
      ["created", "2026-06-18"],
      ["in_transit", "2026-06-19"],
    ],
  },
];

// Each order's owning user, so a shipment can carry a denormalised `userId`
// (the customer who placed the shipped order). This is what lets a nested
// lookup correlate shipments back to the outer user: `s.userId === $._id`.
const ORDER_USER = new Map(orderSpecs.map((o) => [o.n, o.user]));

export const shipments = shipSpecs.map((s) => ({
  _id: ID.shipment(s.n),
  orderId: ID.order(s.order),
  userId: ID.user(ORDER_USER.get(s.order)!),
  carrier: s.carrier,
  status: s.status,
  weight: s.weight,
  events: s.events.map(([type, at]) => ({ type, at: D(at) })),
}));

// ── reviews ───────────────────────────────────────────────────────────────────
type ReviewSpec = { n: number; product: number; user: number; rating: number; verified: boolean; createdAt: string };
const reviewSpecs: ReviewSpec[] = [
  { n: 1, product: 1, user: 1, rating: 5, verified: true, createdAt: "2026-01-20" },
  { n: 2, product: 1, user: 3, rating: 4, verified: true, createdAt: "2026-05-15" },
  { n: 3, product: 3, user: 8, rating: 5, verified: true, createdAt: "2026-04-30" },
  { n: 4, product: 3, user: 5, rating: 5, verified: false, createdAt: "2026-06-12" },
  { n: 5, product: 5, user: 3, rating: 4, verified: true, createdAt: "2026-04-10" },
  { n: 6, product: 5, user: 8, rating: 3, verified: true, createdAt: "2026-04-26" },
  { n: 7, product: 7, user: 1, rating: 5, verified: true, createdAt: "2026-02-20" },
  { n: 8, product: 7, user: 6, rating: 4, verified: false, createdAt: "2026-05-31" },
  { n: 9, product: 2, user: 1, rating: 4, verified: true, createdAt: "2026-01-15" },
  { n: 10, product: 10, user: 4, rating: 3, verified: false, createdAt: "2024-12-05" },
  { n: 11, product: 4, user: 3, rating: 2, verified: true, createdAt: "2026-05-22" },
  { n: 12, product: 9, user: 8, rating: 5, verified: true, createdAt: "2026-06-13" },
];

export const reviews = reviewSpecs.map((r) => ({
  _id: ID.review(r.n),
  productId: ID.product(r.product),
  userId: ID.user(r.user),
  rating: r.rating,
  verified: r.verified,
  createdAt: D(r.createdAt),
}));

// ── the full dataset, by collection name ────────────────────────────────────
export const DATASET: Record<string, Record<string, unknown>[]> = { users, products, orders, shipments, reviews };

export const EXPECTED_COUNTS: Record<string, number> = {
  users: users.length,
  products: products.length,
  orders: orders.length,
  shipments: shipments.length,
  reviews: reviews.length,
};

// ── content hash (drives idempotent re-seeding) ──────────────────────────────
// Stable canonical serialization: ObjectId -> hex, Date -> ISO, keys sorted.
function canonical(v: unknown): unknown {
  if (v instanceof ObjectId) return { __oid: v.toHexString() };
  if (v instanceof Date) return { __date: v.toISOString() };
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = canonical((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export const DATASET_HASH = createHash("sha1")
  .update(JSON.stringify(canonical(DATASET)))
  .digest("hex")
  .slice(0, 12);

// ── self-check ────────────────────────────────────────────────────────────────
// Catches authoring mistakes (mismatched totals, dangling references, dup ids)
// before they can corrupt expected integration-test values. Runs at seed time.
export function validateDataset(): void {
  const errs: string[] = [];
  const userIds = new Set(users.map((u) => u._id.toHexString()));
  const productIds = new Set(products.map((p) => p._id.toHexString()));
  const orderIds = new Set(orders.map((o) => o._id.toHexString()));

  for (const [coll, docs] of Object.entries(DATASET)) {
    const seen = new Set<string>();
    for (const d of docs) {
      const hex = (d._id as ObjectId).toHexString();
      if (seen.has(hex)) errs.push(`${coll}: duplicate _id ${hex}`);
      seen.add(hex);
    }
  }
  for (const o of orders) {
    const sum = o.items.reduce((s, it) => s + it.price, 0);
    if (sum !== o.total) errs.push(`order ${o._id.toHexString()}: total ${o.total} != sum(items.price) ${sum}`);
    for (const it of o.items) {
      if (it.qty * it.unitPrice !== it.price) errs.push(`order ${o._id.toHexString()}: line price mismatch`);
    }
    if (!userIds.has((o.userId as ObjectId).toHexString())) errs.push(`order ${o._id.toHexString()}: dangling userId`);
  }
  const orderUserOf = new Map(
    orders.map((o) => [(o._id as ObjectId).toHexString(), (o.userId as ObjectId).toHexString()]),
  );
  for (const s of shipments) {
    const orderHex = (s.orderId as ObjectId).toHexString();
    if (!orderIds.has(orderHex)) errs.push(`shipment ${s._id.toHexString()}: dangling orderId`);
    // The denormalised userId must equal the owning order's user.
    if (orderUserOf.get(orderHex) !== (s.userId as ObjectId).toHexString())
      errs.push(`shipment ${s._id.toHexString()}: userId does not match its order's user`);
  }
  for (const r of reviews) {
    if (!productIds.has((r.productId as ObjectId).toHexString()))
      errs.push(`review ${r._id.toHexString()}: dangling productId`);
    if (!userIds.has((r.userId as ObjectId).toHexString())) errs.push(`review ${r._id.toHexString()}: dangling userId`);
  }
  if (errs.length) throw new Error("Fixture dataset is inconsistent:\n  " + errs.join("\n  "));
}
