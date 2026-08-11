// Aggregation pipeline stage registry.
//
// Stages live in stage position — the elements of a top-level pipeline array
// like `[ { $match: ... }, { $sort: ... } ]`. They are distinct from
// expression operators (src/operators.ts), which live in value position
// inside a stage spec. Both registries follow the same single-source-of-truth
// rule: do not hand-write `if (name === "$match")` in the parser or codegen
// or pipeline lowering — register the stage here and read it back.
//
// Descriptions are lifted from vendor/mql-specifications/definitions/stage/<name>.yaml
// at the pinned commit (see vendor/fetch-mql-specs.mjs).

export type StageDef = {
  description: string;
  /**
   * Body keys whose value is itself a sub-pipeline (an array of stage
   * objects). The sentinel `"*"` means every value of the body object is a
   * sub-pipeline (used for `$facet`).
   */
  subPipelineFields: readonly string[];
  /**
   * Set on the *diagnostic / system* source stages (`$indexStats`,
   * `$currentOp`, …). These don't transform an incoming stream — they produce
   * one — so they must be the pipeline's first stage, and they differ by
   * *where* they legally run. jsmql surfaces a scope-encoding sugar
   * (`$$.indexStats()` collection, `$$$$.currentOp()` / `$$$$.shardedDataDistribution()`
   * cluster/server) driven entirely off this field; see
   * src/system-stage-translation.ts. Two tiers are in use — collection (`$$`)
   * and cluster/server (`$$$$`); the `currentOp` family runs on the admin
   * database, not the current one, so it's cluster-scoped, not `database`.
   * `options: false` marks the stages that take no options object
   * (`{ $indexStats: {} }`).
   */
  diagnostic?: { scope: "collection" | "database" | "cluster"; options: boolean };
  /**
   * Absolute positional constraint, knowable purely from pipeline shape:
   *   "first" — must sit at index 0 of whatever pipeline it appears in. Set on
   *             *source* stages that produce (not transform) documents and so
   *             ignore any incoming stream. The 9 `diagnostic` stages are also
   *             must-be-first — `stageMustBeFirst` derives that from
   *             `diagnostic`, so they do NOT repeat `position` here.
   *   "last"  — must be the final stage (a write / terminal stage).
   * Enforced for the literal stage forms (`{ $merge: … }`) by pipeline.ts; the
   * sugar forms (`$out` / `$$.indexStats()` / …) keep their own dedicated,
   * sugar-aware messages. See docs/specs/pipeline-validation.md.
   */
  position?: "first" | "last";
  /**
   * Sub-pipeline containers this stage may not appear inside. The container
   * kind is the stage that owns the sub-pipeline: "facet" (`$facet.*`),
   * "lookup" (`$lookup.pipeline`), "unionWith" (`$unionWith.pipeline`).
   * `$out`/`$merge` are forbidden in all three; the `$facet` forbidden-stage
   * list (per the MongoDB `$facet` reference) bans source/search/write stages
   * inside a facet sub-pipeline.
   */
  forbiddenIn?: readonly ("facet" | "lookup" | "unionWith")[];
};

export const STAGES: Record<string, StageDef> = {
  $addFields: {
    description:
      "Adds new fields to documents. Outputs documents that contain all existing fields from the input documents and newly added fields.",
    subPipelineFields: [],
  },
  $bucket: {
    description:
      "Categorizes incoming documents into groups, called buckets, based on a specified expression and bucket boundaries.",
    subPipelineFields: [],
  },
  $bucketAuto: {
    description:
      "Categorizes incoming documents into a specific number of groups, called buckets, based on a specified expression. Bucket boundaries are automatically determined in an attempt to evenly distribute the documents into the specified number of buckets.",
    subPipelineFields: [],
  },
  $changeStream: {
    description:
      "Returns a Change Stream cursor for the collection or database. This stage can only occur once in an aggregation pipeline and it must occur as the first stage.",
    subPipelineFields: [],
    position: "first",
  },
  $changeStreamSplitLargeEvent: {
    description:
      "Splits large change stream events that exceed 16 MB into smaller fragments returned in a change stream cursor.",
    subPipelineFields: [],
    position: "last",
  },
  $collStats: {
    description: "Returns statistics regarding a collection or view.",
    subPipelineFields: [],
    diagnostic: { scope: "collection", options: true },
    forbiddenIn: ["facet"],
  },
  $count: {
    description: "Returns a count of the number of documents at this stage of the aggregation pipeline.",
    subPipelineFields: [],
  },
  $currentOp: {
    description: "Returns information on active and/or dormant operations for the MongoDB deployment.",
    subPipelineFields: [],
    // Server/deployment-level: must be run on the admin database
    // (`db.getSiblingDB("admin").aggregate(...)`), not the current database.
    diagnostic: { scope: "cluster", options: true },
  },
  $densify: {
    description: "Creates new documents in a sequence of documents where certain values in a field are missing.",
    subPipelineFields: [],
  },
  $documents: { description: "Returns literal documents from input values.", subPipelineFields: [], position: "first" },
  $facet: {
    description:
      "Processes multiple aggregation pipelines within a single stage on the same set of input documents. Enables multi-faceted aggregations characterizing data across multiple dimensions in a single stage.",
    // Every value in the body object is itself a sub-pipeline.
    subPipelineFields: ["*"],
    // $facet cannot be nested inside another $facet.
    forbiddenIn: ["facet"],
  },
  $fill: { description: "Populates null and missing field values within documents.", subPipelineFields: [] },
  $geoNear: {
    description:
      "Returns an ordered stream of documents based on the proximity to a geospatial point. Incorporates the functionality of $match, $sort, and $limit for geospatial data.",
    subPipelineFields: [],
    position: "first",
    // Allowed as the first stage of a $lookup/$unionWith sub-pipeline, so only facet is banned.
    forbiddenIn: ["facet"],
  },
  $graphLookup: {
    description:
      "Performs a recursive search on a collection. Adds a new array field to each output document that contains the traversal results of the recursive search.",
    subPipelineFields: [],
  },
  $group: {
    description:
      "Groups input documents by a specified identifier expression and applies the accumulator expression(s), if specified, to each group.",
    subPipelineFields: [],
  },
  $indexStats: {
    description: "Returns statistics regarding the use of each index for the collection.",
    subPipelineFields: [],
    diagnostic: { scope: "collection", options: false },
    forbiddenIn: ["facet"],
  },
  $limit: {
    description: "Passes the first n documents unmodified to the pipeline where n is the specified limit.",
    subPipelineFields: [],
  },
  $listLocalSessions: {
    description: "Lists all active sessions recently in use on the currently connected mongos or mongod instance.",
    subPipelineFields: [],
    // Server-level: run on the admin database (`db.aggregate(...)`).
    diagnostic: { scope: "cluster", options: true },
  },
  $listSampledQueries: {
    description: "Lists sampled queries for all collections or a specific collection.",
    subPipelineFields: [],
    // Cluster-level: run on the admin database.
    diagnostic: { scope: "cluster", options: true },
  },
  $listSearchIndexes: {
    description: "Returns information about existing Atlas Search indexes on a specified collection.",
    subPipelineFields: [],
    diagnostic: { scope: "collection", options: true },
  },
  $listSessions: {
    description: "Lists all sessions that have been active long enough to propagate to the system.sessions collection.",
    subPipelineFields: [],
    // Cluster-level: reads the cluster-wide config.system.sessions collection.
    diagnostic: { scope: "cluster", options: true },
  },
  $lookup: {
    description:
      "Performs a left outer join to another collection in the same database to filter in documents from the joined collection for processing.",
    subPipelineFields: ["pipeline"],
  },
  $match: {
    description:
      "Filters the document stream to allow only matching documents to pass unmodified into the next pipeline stage.",
    subPipelineFields: [],
  },
  $merge: {
    description:
      "Writes the resulting documents of the aggregation pipeline to a collection. Must be the last stage in the pipeline.",
    subPipelineFields: [],
    position: "last",
    forbiddenIn: ["facet", "lookup", "unionWith"],
  },
  $out: {
    description:
      "Writes the resulting documents of the aggregation pipeline to a collection. Must be the last stage in the pipeline.",
    subPipelineFields: [],
    position: "last",
    forbiddenIn: ["facet", "lookup", "unionWith"],
  },
  $planCacheStats: {
    description: "Returns plan cache information for a collection.",
    subPipelineFields: [],
    diagnostic: { scope: "collection", options: false },
    forbiddenIn: ["facet"],
  },
  $project: {
    description:
      "Reshapes each document in the stream, such as by adding new fields or removing existing fields. For each input document, outputs one document.",
    subPipelineFields: [],
  },
  $rankFusion: {
    description: "Combines multiple pipelines using rank-based fusion to create hybrid search results.",
    subPipelineFields: [],
  },
  $redact: {
    description:
      "Reshapes each document in the stream by restricting the content for each document based on information stored in the documents themselves.",
    subPipelineFields: [],
  },
  $replaceRoot: {
    description:
      "Replaces a document with the specified embedded document. The operation replaces all existing fields in the input document, including the _id field.",
    subPipelineFields: [],
  },
  $replaceWith: {
    description:
      "Replaces a document with the specified embedded document. The operation replaces all existing fields in the input document, including the _id field.",
    subPipelineFields: [],
  },
  $sample: { description: "Randomly selects the specified number of documents from its input.", subPipelineFields: [] },
  $scoreFusion: {
    description: "Combines multiple pipelines using relative score fusion to create hybrid search results.",
    subPipelineFields: [],
  },
  $search: {
    description: "Performs a full-text search of the field or fields in an Atlas collection.",
    subPipelineFields: [],
    position: "first",
    // Allowed as the first stage of a $lookup/$unionWith sub-pipeline, so only facet is banned.
    forbiddenIn: ["facet"],
  },
  $searchMeta: {
    description:
      "Returns different types of metadata result documents for the Atlas Search query against an Atlas collection.",
    subPipelineFields: [],
    position: "first",
    forbiddenIn: ["facet"],
  },
  $set: {
    description:
      "Adds new fields to documents. Outputs documents that contain all existing fields from the input documents and newly added fields.",
    subPipelineFields: [],
  },
  $setWindowFields: {
    description: "Groups documents into windows and applies one or more operators to the documents in each window.",
    subPipelineFields: [],
  },
  $shardedDataDistribution: {
    description: "Provides data and size distribution information on sharded collections.",
    subPipelineFields: [],
    diagnostic: { scope: "cluster", options: false },
  },
  $skip: {
    description:
      "Skips the first n documents where n is the specified skip number and passes the remaining documents unmodified to the pipeline.",
    subPipelineFields: [],
  },
  $sort: {
    description:
      "Reorders the document stream by a specified sort key. Only the order changes; the documents remain unmodified.",
    subPipelineFields: [],
  },
  $sortByCount: {
    description:
      "Groups incoming documents based on the value of a specified expression, then computes the count of documents in each distinct group.",
    subPipelineFields: [],
  },
  $unionWith: {
    description:
      "Performs a union of two collections; combines pipeline results from two collections into a single result set.",
    subPipelineFields: ["pipeline"],
  },
  $unset: { description: "Removes or excludes fields from documents.", subPipelineFields: [] },
  $unwind: {
    description:
      "Deconstructs an array field from the input documents to output a document for each element. Each output document replaces the array with an element value.",
    subPipelineFields: [],
  },
  $vectorSearch: {
    description: "Performs an ANN or ENN search on a vector in the specified field.",
    subPipelineFields: [],
    position: "first",
    forbiddenIn: ["facet"],
  },
};

export function lookupStage(name: string): StageDef | undefined {
  return Object.prototype.hasOwnProperty.call(STAGES, name) ? STAGES[name] : undefined;
}

/**
 * Must this stage sit at index 0 of its pipeline? True for the explicit
 * `position: "first"` source stages AND for every diagnostic stage — a
 * diagnostic produces its own document stream (index/collection stats, running
 * ops, …) and ignores any input, so a non-first placement has no valid runtime
 * context. Deriving the diagnostics here keeps the literal-form check in step
 * with the sugar-form check (system-stage-translation.ts) off one source.
 */
export function stageMustBeFirst(def: StageDef): boolean {
  return def.position === "first" || def.diagnostic !== undefined;
}

/** Must this stage be the final stage of its pipeline (a write / terminal stage)? */
export function stageMustBeLast(def: StageDef): boolean {
  return def.position === "last";
}

/**
 * Is `def` forbidden in EVERY sub-pipeline container? Such a stage ($out /
 * $merge) is illegal anywhere but the top-level pipeline, so it can be rejected
 * without knowing which container we're in — which is what lets block-body
 * sub-pipelines (`.aggregate((o) => { … })`) enforce it too, and what the
 * emitted-output backstop in pipeline.ts reads.
 */
export function stageForbiddenInAnySubPipeline(def: StageDef): boolean {
  return stageForbiddenIn(def, "facet") && stageForbiddenIn(def, "lookup") && stageForbiddenIn(def, "unionWith");
}

/** Is this stage forbidden inside the given sub-pipeline container kind? */
export function stageForbiddenIn(def: StageDef, container: "facet" | "lookup" | "unionWith"): boolean {
  return def.forbiddenIn?.includes(container) ?? false;
}
