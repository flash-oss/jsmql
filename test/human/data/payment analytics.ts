// The documents for the test "payment analytics" in test/human/human.test.ts.
//
// The first group has the full schema with correct values. The second group breaks the
// schema in one way per document: a missing field, a null, a wrong type, a wrong case,
// a value outside the date range. A comment on each document names what it breaks.

import { Decimal128, Long, ObjectId } from "bson";

const ok = (over: Record<string, unknown> = {}) => ({
  createdAt: new Date("2026-01-15T10:00:00Z"),
  payoutStatus: "PAID",
  recommendations: {
    all: "accept",
    creditor: { google: "accept", tm: "accept", knownName: "accept" },
    debtor: { google: "accept", tm: "accept", knownName: "accept" },
  },
  txData: {
    status: { value: "CONFIRMED", history: [{ value: "CREATED" }, { value: "CONFIRMED" }] },
    aml: { reviewedAt: null },
    queries: null,
  },
  ...over,
});

/** `ok()` with one field removed, so the field is missing, not undefined. */
const without = (field: string, over: Record<string, unknown> = {}) => {
  const doc: Record<string, unknown> = ok(over);
  delete doc[field];
  return doc;
};

export default [
  // ── the full schema, correct values ──────────────────────────────────────────

  // A clean payment: cleared, no alert.
  ok(),
  // Alerted overall, reviewed, then cleared.
  ok({
    createdAt: new Date("2026-01-20T08:30:00Z"),
    recommendations: {
      all: "review",
      creditor: { google: "review", tm: "accept", knownName: "accept" },
      debtor: { google: "accept", tm: "accept", knownName: "accept" },
    },
    txData: {
      status: { value: "CONFIRMED", history: [{ value: "CREATED" }, { value: "REVIEWING" }, { value: "CONFIRMED" }] },
      aml: { reviewedAt: new Date("2026-01-20T09:00:00Z") },
      queries: null,
    },
  }),
  // Rejected after a review, with a query to the customer.
  ok({
    createdAt: new Date("2026-02-03T12:00:00Z"),
    payoutStatus: "DECLINED",
    recommendations: {
      all: "reject",
      creditor: { google: "accept", tm: "reject", knownName: "accept" },
      debtor: { google: "accept", tm: "accept", knownName: "review" },
    },
    txData: {
      status: { value: "CANCELLED", history: [{ value: "CREATED" }, { value: "REVIEWING" }, { value: "CANCELLED" }] },
      aml: { reviewedAt: new Date("2026-02-03T13:00:00Z") },
      queries: [{ askedAt: new Date("2026-02-03T12:30:00Z"), text: "Source of funds?" }],
    },
  }),
  // Cancelled with no review step in the history: not an automatic rejection.
  ok({
    createdAt: new Date("2026-02-10T00:00:00Z"),
    payoutStatus: "CANCELLED",
    txData: {
      status: { value: "CANCELLED", history: [{ value: "CREATED" }, { value: "CANCELLED" }] },
      aml: { reviewedAt: null },
      queries: null,
    },
  }),
  // Every service alerts on both sides, on the last millisecond of March.
  ok({
    createdAt: new Date("2026-03-31T23:59:59.999Z"),
    recommendations: {
      all: "reject",
      creditor: { google: "reject", tm: "reject", knownName: "reject" },
      debtor: { google: "review", tm: "review", knownName: "review" },
    },
  }),
  // Exactly on the start date: the filter `>=` keeps it.
  ok({ createdAt: new Date("2026-01-01T00:00:00Z") }),
  // One millisecond before the start date: the filter drops it.
  ok({ createdAt: new Date("2025-12-31T23:59:59.999Z"), payoutStatus: "DECLINED" }),
  // Far in the future.
  ok({ createdAt: new Date("2099-12-31T00:00:00Z") }),

  // ── a broken schema, one fault per document ──────────────────────────────────

  // An empty document.
  {},
  // No `createdAt`.
  without("createdAt"),
  // `createdAt` is null.
  ok({ createdAt: null }),
  // `createdAt` is an ISO string, not a date.
  ok({ createdAt: "2026-02-01T00:00:00Z" }),
  // `createdAt` is a number of milliseconds, not a date.
  ok({ createdAt: 1767225600000 }),
  // `createdAt` is a Long of milliseconds.
  ok({ createdAt: Long.fromNumber(1767225600000) }),
  // `createdAt` is an ObjectId.
  ok({ createdAt: new ObjectId("665d919f1ca8443d56e6989f") }),
  // `createdAt` is an array of dates.
  ok({ createdAt: [new Date("2026-01-02T00:00:00Z"), new Date("2026-01-03T00:00:00Z")] }),
  // No `recommendations`.
  without("recommendations", { createdAt: new Date("2026-01-05T00:00:00Z") }),
  // `recommendations` is null.
  ok({ createdAt: new Date("2026-01-06T00:00:00Z"), recommendations: null }),
  // `recommendations.all` is upper case: "REVIEW" is not "review".
  ok({ createdAt: new Date("2026-01-07T00:00:00Z"), recommendations: { all: "REVIEW", creditor: {}, debtor: {} } }),
  // `recommendations.all` is an array of recommendations, not one.
  ok({
    createdAt: new Date("2026-01-08T00:00:00Z"),
    recommendations: { all: ["review", "reject"], creditor: {}, debtor: {} },
  }),
  // `recommendations.creditor` is a string, not an object.
  ok({
    createdAt: new Date("2026-01-09T00:00:00Z"),
    recommendations: { all: "accept", creditor: "review", debtor: { google: "accept" } },
  }),
  // `recommendations.debtor` is an array of objects.
  ok({
    createdAt: new Date("2026-01-10T00:00:00Z"),
    recommendations: { all: "accept", creditor: { google: "accept" }, debtor: [{ google: "review" }] },
  }),
  // The service recommendations are a number, an object, a null, a boolean, an empty
  // string and a string with a trailing space.
  ok({
    createdAt: new Date("2026-01-11T00:00:00Z"),
    recommendations: {
      all: 1,
      creditor: { google: 1, tm: { value: "review" }, knownName: null },
      debtor: { google: true, tm: "", knownName: "reject " },
    },
  }),
  // No `txData`.
  without("txData", { createdAt: new Date("2026-02-11T00:00:00Z") }),
  // `txData` is null.
  ok({ createdAt: new Date("2026-02-12T00:00:00Z"), txData: null }),
  // `txData.status` is a string, not an object.
  ok({ createdAt: new Date("2026-02-13T00:00:00Z"), txData: { status: "CONFIRMED", aml: {}, queries: null } }),
  // `txData.status.value` is lower case.
  ok({
    createdAt: new Date("2026-02-14T00:00:00Z"),
    txData: { status: { value: "confirmed", history: [] }, aml: {}, queries: null },
  }),
  // A cancelled payment with no `txData.status.history`.
  ok({
    createdAt: new Date("2026-02-15T00:00:00Z"),
    txData: { status: { value: "CANCELLED" }, aml: {}, queries: null },
  }),
  // A cancelled payment with a null `txData.status.history`.
  ok({
    createdAt: new Date("2026-02-16T00:00:00Z"),
    txData: { status: { value: "CANCELLED", history: null }, aml: {}, queries: null },
  }),
  // `txData.status.history` is a string, not an array.
  ok({
    createdAt: new Date("2026-02-17T00:00:00Z"),
    txData: { status: { value: "CANCELLED", history: "REVIEWING" }, aml: {}, queries: null },
  }),
  // `txData.status.history` holds a string, a null and an empty object, not `{ value }` objects.
  ok({
    createdAt: new Date("2026-02-18T00:00:00Z"),
    txData: { status: { value: "CANCELLED", history: ["REVIEWING", null, {}] }, aml: {}, queries: null },
  }),
  // No `txData.aml`, so no `reviewedAt`.
  ok({
    createdAt: new Date("2026-03-01T00:00:00Z"),
    txData: { status: { value: "CONFIRMED", history: [] }, queries: null },
  }),
  // `txData.aml.reviewedAt` is a string, and `txData.queries` is an empty array.
  ok({
    createdAt: new Date("2026-03-02T00:00:00Z"),
    txData: { status: { value: "CONFIRMED", history: [] }, aml: { reviewedAt: "yes" }, queries: [] },
  }),
  // `txData.aml.reviewedAt` is false, and `txData.queries` is 0.
  ok({
    createdAt: new Date("2026-03-03T00:00:00Z"),
    txData: { status: { value: "CONFIRMED", history: [] }, aml: { reviewedAt: false }, queries: 0 },
  }),
  // `payoutStatus` is lower case, with a trailing space.
  ok({ createdAt: new Date("2026-03-04T00:00:00Z"), payoutStatus: "declined " }),
  // `payoutStatus` is a number, and an extra field holds a Decimal128.
  ok({ createdAt: new Date("2026-03-05T00:00:00Z"), payoutStatus: 3, amount: Decimal128.fromString("12.50") }),
];
