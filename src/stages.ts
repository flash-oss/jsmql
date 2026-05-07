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
  },
  $changeStreamSplitLargeEvent: {
    description:
      "Splits large change stream events that exceed 16 MB into smaller fragments returned in a change stream cursor.",
    subPipelineFields: [],
  },
  $collStats: {
    description: "Returns statistics regarding a collection or view.",
    subPipelineFields: [],
  },
  $count: {
    description:
      "Returns a count of the number of documents at this stage of the aggregation pipeline.",
    subPipelineFields: [],
  },
  $currentOp: {
    description:
      "Returns information on active and/or dormant operations for the MongoDB deployment.",
    subPipelineFields: [],
  },
  $densify: {
    description:
      "Creates new documents in a sequence of documents where certain values in a field are missing.",
    subPipelineFields: [],
  },
  $documents: {
    description: "Returns literal documents from input values.",
    subPipelineFields: [],
  },
  $facet: {
    description:
      "Processes multiple aggregation pipelines within a single stage on the same set of input documents. Enables multi-faceted aggregations characterizing data across multiple dimensions in a single stage.",
    // Every value in the body object is itself a sub-pipeline.
    subPipelineFields: ["*"],
  },
  $fill: {
    description: "Populates null and missing field values within documents.",
    subPipelineFields: [],
  },
  $geoNear: {
    description:
      "Returns an ordered stream of documents based on the proximity to a geospatial point. Incorporates the functionality of $match, $sort, and $limit for geospatial data.",
    subPipelineFields: [],
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
  },
  $limit: {
    description:
      "Passes the first n documents unmodified to the pipeline where n is the specified limit.",
    subPipelineFields: [],
  },
  $listLocalSessions: {
    description:
      "Lists all active sessions recently in use on the currently connected mongos or mongod instance.",
    subPipelineFields: [],
  },
  $listSampledQueries: {
    description: "Lists sampled queries for all collections or a specific collection.",
    subPipelineFields: [],
  },
  $listSearchIndexes: {
    description:
      "Returns information about existing Atlas Search indexes on a specified collection.",
    subPipelineFields: [],
  },
  $listSessions: {
    description:
      "Lists all sessions that have been active long enough to propagate to the system.sessions collection.",
    subPipelineFields: [],
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
  },
  $out: {
    description:
      "Writes the resulting documents of the aggregation pipeline to a collection. Must be the last stage in the pipeline.",
    subPipelineFields: [],
  },
  $planCacheStats: {
    description: "Returns plan cache information for a collection.",
    subPipelineFields: [],
  },
  $project: {
    description:
      "Reshapes each document in the stream, such as by adding new fields or removing existing fields. For each input document, outputs one document.",
    subPipelineFields: [],
  },
  $rankFusion: {
    description:
      "Combines multiple pipelines using rank-based fusion to create hybrid search results.",
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
  $sample: {
    description: "Randomly selects the specified number of documents from its input.",
    subPipelineFields: [],
  },
  $scoreFusion: {
    description:
      "Combines multiple pipelines using relative score fusion to create hybrid search results.",
    subPipelineFields: [],
  },
  $search: {
    description: "Performs a full-text search of the field or fields in an Atlas collection.",
    subPipelineFields: [],
  },
  $searchMeta: {
    description:
      "Returns different types of metadata result documents for the Atlas Search query against an Atlas collection.",
    subPipelineFields: [],
  },
  $set: {
    description:
      "Adds new fields to documents. Outputs documents that contain all existing fields from the input documents and newly added fields.",
    subPipelineFields: [],
  },
  $setWindowFields: {
    description:
      "Groups documents into windows and applies one or more operators to the documents in each window.",
    subPipelineFields: [],
  },
  $shardedDataDistribution: {
    description: "Provides data and size distribution information on sharded collections.",
    subPipelineFields: [],
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
  $unset: {
    description: "Removes or excludes fields from documents.",
    subPipelineFields: [],
  },
  $unwind: {
    description:
      "Deconstructs an array field from the input documents to output a document for each element. Each output document replaces the array with an element value.",
    subPipelineFields: [],
  },
  $vectorSearch: {
    description: "Performs an ANN or ENN search on a vector in the specified field.",
    subPipelineFields: [],
  },
};

export function lookupStage(name: string): StageDef | undefined {
  return Object.prototype.hasOwnProperty.call(STAGES, name) ? STAGES[name] : undefined;
}
