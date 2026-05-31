// Tests for the scope-encoding diagnostic / system source-stage sugar:
//   $$.indexStats()                    → { $indexStats: {} }            (collection)
//   $$$.currentOp({ allUsers: true })  → { $currentOp: { ... } }        (database)
//   $$$$.shardedDataDistribution()     → { $shardedDataDistribution:{} }(cluster)
// See docs/specs/system-stages.md for the design and error catalog.

import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

describe("system stages — collection-scoped ($$)", () => {
  it("$$.indexStats() lowers to a no-option $indexStats source stage", () => {
    expect(jsmql("$$.indexStats()")).toEqual([{ $indexStats: {} }]);
  });

  it("$$.planCacheStats() lowers to a no-option $planCacheStats source stage", () => {
    expect(jsmql("$$.planCacheStats()")).toEqual([{ $planCacheStats: {} }]);
  });

  it("$$.collStats(options) passes the options object through", () => {
    expect(jsmql("$$.collStats({ storageStats: {}, latencyStats: { histograms: true } })")).toEqual([
      { $collStats: { storageStats: {}, latencyStats: { histograms: true } } },
    ]);
  });

  it("$$.collStats() with no options lowers to an empty body", () => {
    expect(jsmql("$$.collStats()")).toEqual([{ $collStats: {} }]);
  });

  it("$$.listSearchIndexes(options) passes the options through", () => {
    expect(jsmql('$$.listSearchIndexes({ name: "default" })')).toEqual([{ $listSearchIndexes: { name: "default" } }]);
  });
});

describe("system stages — server/cluster-scoped ($$$$)", () => {
  // $currentOp / $listSessions / $listLocalSessions / $listSampledQueries all
  // run against the admin (or config) database, not the current one, so they
  // live on $$$$ (cluster/server), not $$$ (current database).
  it("$$$$.currentOp(options) lowers to a $currentOp source stage", () => {
    expect(jsmql("$$$$.currentOp({ allUsers: true, idleConnections: false })")).toEqual([
      { $currentOp: { allUsers: true, idleConnections: false } },
    ]);
  });

  it("$$$$.currentOp() with no options lowers to an empty body", () => {
    expect(jsmql("$$$$.currentOp()")).toEqual([{ $currentOp: {} }]);
  });

  it("$$$$.listSessions(options) and $$$$.listLocalSessions(options) lower to their stages", () => {
    expect(jsmql("$$$$.listSessions({ allUsers: true })")).toEqual([{ $listSessions: { allUsers: true } }]);
    expect(jsmql('$$$$.listLocalSessions({ users: [{ user: "r", db: "test" }] })')).toEqual([
      { $listLocalSessions: { users: [{ user: "r", db: "test" }] } },
    ]);
  });

  it("$$$$.listSampledQueries(options) passes the namespace through", () => {
    expect(jsmql('$$$$.listSampledQueries({ namespace: "db.coll" })')).toEqual([
      { $listSampledQueries: { namespace: "db.coll" } },
    ]);
  });

  it("$$$$.shardedDataDistribution() lowers to a no-option source stage", () => {
    expect(jsmql("$$$$.shardedDataDistribution()")).toEqual([{ $shardedDataDistribution: {} }]);
  });
});

describe("system stages — pipeline composition", () => {
  it("works as the first element of a bracketed pipeline", () => {
    expect(jsmql("[$$.indexStats(), $sort({ accesses: -1 })]")).toEqual([
      { $indexStats: {} },
      { $sort: { accesses: -1 } },
    ]);
  });

  it("works as the first statement of a ;-separated pipeline", () => {
    expect(jsmql("$$.collStats({ storageStats: {} }); $match($.shard === 'a')")).toEqual([
      { $collStats: { storageStats: {} } },
      { $match: { shard: "a" } },
    ]);
  });

  it("a bare single statement (no `;`, no brackets) auto-wraps into Pipeline mode", () => {
    expect(jsmql("$$$$.currentOp()")).toEqual([{ $currentOp: {} }]);
    expect(jsmql("$$$$.shardedDataDistribution()")).toEqual([{ $shardedDataDistribution: {} }]);
  });

  it("jsmql.pipeline() accepts a diagnostic source stage", () => {
    expect(jsmql.pipeline("$$.indexStats()")).toEqual([{ $indexStats: {} }]);
  });
});

describe("system stages — first-stage-only enforcement", () => {
  it("rejects a diagnostic stage that is not the first stage", () => {
    expect(() => jsmql("$match($.x > 1); $$.indexStats()")).toThrow(/must be the first stage/);
  });

  it("the error carries the call-site position (non-zero past the leading stage)", () => {
    const r = jsmql.validate("$match($.x > 1); $$.indexStats()");
    expect(r.valid).toBe(false);
    expect(r.errors[0].pos).toBeGreaterThan(0);
  });
});

describe("system stages — error messages", () => {
  it("wrong scope: a server stage on $$ points at the $$$$ prefix", () => {
    expect(() => jsmql("$$.currentOp()")).toThrow(
      /'currentOp' is a cluster-scoped system stage — write '\$\$\$\$\.currentOp\(\.\.\.\)'/,
    );
  });

  it("wrong scope: a server stage on $$$ (database) points at the $$$$ prefix", () => {
    expect(() => jsmql("$$$.currentOp()")).toThrow(
      /'currentOp' is a cluster-scoped system stage — write '\$\$\$\$\.currentOp\(\.\.\.\)'/,
    );
  });

  it("wrong scope: a collection stage on $$$$ points at the $$ prefix", () => {
    expect(() => jsmql("$$$$.indexStats()")).toThrow(
      /'indexStats' is a collection-scoped system stage — write '\$\$\.indexStats\(\.\.\.\)'/,
    );
  });

  it("wrong scope: a cluster stage on $$ points at the $$$$ prefix", () => {
    expect(() => jsmql("$$.shardedDataDistribution()")).toThrow(
      /'shardedDataDistribution' is a cluster-scoped system stage — write '\$\$\$\$\.shardedDataDistribution\(\.\.\.\)'/,
    );
  });

  it("$$$ (database) has no diagnostics of its own — unknown method points elsewhere", () => {
    expect(() => jsmql("$$$.fooBar()")).toThrow(/'\$\$\$' \(database reference\) has no diagnostic source stages/);
  });

  it("unknown method suggests the nearest diagnostic with its correct prefix", () => {
    expect(() => jsmql("$$.indexStat()")).toThrow(/Did you mean '\$\$\.indexStats\(\.\.\.\)'\?/);
  });

  it("no-option stage given an argument is rejected", () => {
    expect(() => jsmql("$$.indexStats({})")).toThrow(/takes no options/);
  });

  it("option-bearing stage given a non-object argument is rejected", () => {
    expect(() => jsmql("$$.collStats(true)")).toThrow(/expects an options object literal/);
  });

  it("more than one argument is rejected", () => {
    expect(() => jsmql("$$.collStats({}, {})")).toThrow(/got 2 arguments/);
  });
});

describe("system stages — no regression in adjacent ref sugars", () => {
  it("$$$.<coll>.find(...) still lowers to a $lookup (not mistaken for a diagnostic)", () => {
    expect(jsmql("$.o = $$$.orders.find(o => o.uid === $.id)")).toEqual([
      { $lookup: { from: "orders", localField: "id", foreignField: "uid", as: "o" } },
      { $set: { o: { $first: "$o" } } },
    ]);
  });

  it("$$.push(...) still lowers to a $unionWith (reserved method, not a diagnostic)", () => {
    expect(jsmql("$$.push(...$$$.archive)")).toEqual([{ $unionWith: "archive" }]);
  });
});
