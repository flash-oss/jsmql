// The documents for the test "payment analytics" in test/human/human.test.ts.
//
// The first group has the full schema with correct values. The second group breaks the
// schema, one fault per document. Each fault is a missing field, a null, a wrong type, a
// wrong case, or a value outside the date range. A comment on each document names what
// it breaks.

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

type Side = "creditor" | "debtor";
type Svc = "google" | "tm" | "knownName";

/** The recommendations of one payment: `alerts` names the services that alert, and on which side. */
const recs = (all: string, alerts: [Side, Svc, string][] = []) => {
  const side = () => ({ google: "accept", tm: "accept", knownName: "accept" }) as Record<Svc, string>;
  const r = { all, creditor: side(), debtor: side() };
  for (const [s, svc, rec] of alerts) r[s][svc] = rec;
  return r;
};

/** A clean payment: no alert, confirmed, paid out. */
const paid = (at: string) => ok({ createdAt: new Date(at) });

/** An alert that a person reviewed and then cleared. */
const clearedAfterReview = (at: string, alerts: [Side, Svc, string][], query = false) =>
  ok({
    createdAt: new Date(at),
    recommendations: recs("review", alerts),
    txData: {
      status: { value: "CONFIRMED", history: [{ value: "CREATED" }, { value: "REVIEWING" }, { value: "CONFIRMED" }] },
      aml: { reviewedAt: new Date(new Date(at).getTime() + 3_600_000) },
      queries: query ? [{ askedAt: new Date(at), text: "Purpose of payment?" }] : null,
    },
  });

/** An alert that a person reviewed and then declined. */
const declinedAfterReview = (at: string, alerts: [Side, Svc, string][], query = false) =>
  ok({
    createdAt: new Date(at),
    payoutStatus: "DECLINED",
    recommendations: recs("reject", alerts),
    txData: {
      status: { value: "CANCELLED", history: [{ value: "CREATED" }, { value: "REVIEWING" }, { value: "CANCELLED" }] },
      aml: { reviewedAt: new Date(new Date(at).getTime() + 7_200_000) },
      queries: query ? [{ askedAt: new Date(at), text: "Source of funds?" }] : null,
    },
  });

/** A payment that the customer cancelled before any review. */
const cancelledByCustomer = (at: string) =>
  ok({
    createdAt: new Date(at),
    payoutStatus: "CANCELLED",
    txData: {
      status: { value: "CANCELLED", history: [{ value: "CREATED" }, { value: "CANCELLED" }] },
      aml: {},
      queries: null,
    },
  });

/** A payment that waits for a review at the end of the data. */
const inReview = (at: string, alerts: [Side, Svc, string][]) =>
  ok({
    createdAt: new Date(at),
    payoutStatus: "PENDING",
    recommendations: recs("review", alerts),
    txData: {
      status: { value: "REVIEWING", history: [{ value: "CREATED" }, { value: "REVIEWING" }] },
      aml: {},
      queries: null,
    },
  });

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

  // ── the volume: ordinary payments over four months ───────────────────────────

  // January 2026
  paid("2026-01-02T09:14:00Z"),
  paid("2026-01-02T15:40:00Z"),
  paid("2026-01-03T11:05:00Z"),
  paid("2026-01-05T08:22:00Z"),
  paid("2026-01-06T13:47:00Z"),
  paid("2026-01-07T10:31:00Z"),
  paid("2026-01-08T16:58:00Z"),
  paid("2026-01-09T09:03:00Z"),
  paid("2026-01-12T12:19:00Z"),
  paid("2026-01-13T14:36:00Z"),
  paid("2026-01-14T07:50:00Z"),
  paid("2026-01-16T11:27:00Z"),
  paid("2026-01-19T15:12:00Z"),
  paid("2026-01-21T10:44:00Z"),
  paid("2026-01-22T09:39:00Z"),
  paid("2026-01-26T13:08:00Z"),
  paid("2026-01-28T17:21:00Z"),
  paid("2026-01-30T08:55:00Z"),
  clearedAfterReview("2026-01-12T10:00:00Z", [["creditor", "knownName", "review"]]),
  clearedAfterReview("2026-01-23T14:30:00Z", [["debtor", "tm", "review"]], true),
  declinedAfterReview("2026-01-27T11:15:00Z", [
    ["creditor", "google", "reject"],
    ["creditor", "knownName", "review"],
  ]),
  cancelledByCustomer("2026-01-29T16:02:00Z"),

  // February 2026
  paid("2026-02-02T09:21:00Z"),
  paid("2026-02-02T14:05:00Z"),
  paid("2026-02-04T10:48:00Z"),
  paid("2026-02-05T12:33:00Z"),
  paid("2026-02-06T08:17:00Z"),
  paid("2026-02-09T15:29:00Z"),
  paid("2026-02-11T11:42:00Z"),
  paid("2026-02-12T09:56:00Z"),
  paid("2026-02-16T13:10:00Z"),
  paid("2026-02-18T16:44:00Z"),
  paid("2026-02-19T10:07:00Z"),
  paid("2026-02-20T14:51:00Z"),
  paid("2026-02-23T09:35:00Z"),
  paid("2026-02-25T12:26:00Z"),
  paid("2026-02-27T15:58:00Z"),
  clearedAfterReview("2026-02-06T13:20:00Z", [["debtor", "knownName", "review"]]),
  clearedAfterReview(
    "2026-02-17T09:45:00Z",
    [
      ["creditor", "tm", "review"],
      ["debtor", "tm", "review"],
    ],
    true,
  ),
  clearedAfterReview("2026-02-24T11:10:00Z", [["creditor", "google", "review"]]),
  declinedAfterReview("2026-02-13T15:00:00Z", [["debtor", "google", "reject"]], true),

  // March 2026
  paid("2026-03-02T08:41:00Z"),
  paid("2026-03-02T13:18:00Z"),
  paid("2026-03-03T10:54:00Z"),
  paid("2026-03-04T15:37:00Z"),
  paid("2026-03-06T09:12:00Z"),
  paid("2026-03-09T11:49:00Z"),
  paid("2026-03-10T14:23:00Z"),
  paid("2026-03-11T08:06:00Z"),
  paid("2026-03-13T16:30:00Z"),
  paid("2026-03-16T10:15:00Z"),
  paid("2026-03-17T12:58:00Z"),
  paid("2026-03-18T09:27:00Z"),
  paid("2026-03-20T14:40:00Z"),
  paid("2026-03-23T11:03:00Z"),
  paid("2026-03-24T15:46:00Z"),
  paid("2026-03-26T08:34:00Z"),
  paid("2026-03-27T13:57:00Z"),
  paid("2026-03-30T10:20:00Z"),
  clearedAfterReview("2026-03-05T12:00:00Z", [["creditor", "knownName", "review"]]),
  clearedAfterReview("2026-03-19T10:30:00Z", [["debtor", "google", "review"]]),
  declinedAfterReview("2026-03-12T14:15:00Z", [["creditor", "tm", "reject"]], true),
  declinedAfterReview("2026-03-25T09:50:00Z", [
    ["debtor", "knownName", "reject"],
    ["debtor", "google", "review"],
  ]),
  cancelledByCustomer("2026-03-31T17:05:00Z"),

  // April 2026
  paid("2026-04-01T09:08:00Z"),
  paid("2026-04-01T14:52:00Z"),
  paid("2026-04-02T11:36:00Z"),
  paid("2026-04-03T08:19:00Z"),
  paid("2026-04-06T13:44:00Z"),
  paid("2026-04-07T10:02:00Z"),
  paid("2026-04-08T15:25:00Z"),
  paid("2026-04-09T09:48:00Z"),
  paid("2026-04-10T12:11:00Z"),
  paid("2026-04-13T16:37:00Z"),
  clearedAfterReview("2026-04-07T11:40:00Z", [
    ["creditor", "google", "review"],
    ["debtor", "knownName", "review"],
  ]),
  inReview("2026-04-14T09:30:00Z", [["debtor", "tm", "review"]]),

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
