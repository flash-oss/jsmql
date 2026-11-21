import { jsmql, type JsmqlInput } from "./index.ts";

function isJsmql(value: unknown): value is JsmqlInput {
  return typeof value === "string" || typeof value === "function";
}

/**
 * Register jsmql with a mongoose module. The function is the default export
 * of `@koresar/jsmql/mongoose`, so both call shapes work:
 *
 *     const jsmqlMongoose = require("@koresar/jsmql/mongoose");
 *     jsmqlMongoose(mongoose);
 *
 *     // or, ESM:
 *     import jsmqlMongoose from "@koresar/jsmql/mongoose";
 *     jsmqlMongoose(mongoose);
 *
 * The `mongoose` parameter is typed `any` deliberately. This module does not
 * depend on mongoose at compile time (no peer/dev dep, no `import "mongoose"`),
 * so the real `Mongoose` type is not in scope here. The plugin treats the argument as
 * a duck-typed `{ Model: { find, …pre-patched statics… } }` and the per-
 * method wrappers below pass the rest through. An annotation on each captured
 * original and wrapper parameter would add noise without
 * a tighter contract — every value just passes through to mongoose
 * untouched.
 */
export default function jsmqlMongoose(mongoose: any): void {
  if (mongoose === null || typeof mongoose !== "object") {
    const ty = mongoose === null ? "null" : typeof mongoose;
    throw new TypeError(
      `@koresar/jsmql/mongoose: expected the mongoose module as the first argument, got ${ty}. ` +
        `Call it as require("@koresar/jsmql/mongoose")(mongoose).`,
    );
  }
  const Model = mongoose.Model;
  if (typeof Model !== "function") {
    throw new TypeError(
      "@koresar/jsmql/mongoose: argument does not look like the mongoose module (no Model class found). " +
        "Pass the value you got back from require('mongoose').",
    );
  }
  if (Model.__jsmqlPatched === true) return;
  Model.__jsmqlPatched = true;

  const _find = Model.find;
  Model.find = function find(conditions: any, projection: any, options: any) {
    if (isJsmql(conditions)) conditions = jsmql.filter(conditions);
    return _find.call(this, conditions, projection, options);
  };

  const _findOne = Model.findOne;
  Model.findOne = function findOne(conditions: any, projection: any, options: any) {
    if (isJsmql(conditions)) conditions = jsmql.filter(conditions);
    return _findOne.call(this, conditions, projection, options);
  };

  const _findOneAndUpdate = Model.findOneAndUpdate;
  Model.findOneAndUpdate = function findOneAndUpdate(conditions: any, update: any, options: any) {
    if (isJsmql(conditions)) conditions = jsmql.filter(conditions);
    if (isJsmql(update)) update = jsmql.update(update);
    return _findOneAndUpdate.call(this, conditions, update, options);
  };

  const _findOneAndDelete = Model.findOneAndDelete;
  Model.findOneAndDelete = function findOneAndDelete(conditions: any, options: any) {
    if (isJsmql(conditions)) conditions = jsmql.filter(conditions);
    return _findOneAndDelete.call(this, conditions, options);
  };

  const _findOneAndReplace = Model.findOneAndReplace;
  Model.findOneAndReplace = function findOneAndReplace(filter: any, replacement: any, options: any) {
    if (isJsmql(filter)) filter = jsmql.filter(filter);
    return _findOneAndReplace.call(this, filter, replacement, options);
  };

  const _findByIdAndUpdate = Model.findByIdAndUpdate;
  Model.findByIdAndUpdate = function findByIdAndUpdate(id: any, update: any, options: any) {
    if (isJsmql(update)) update = jsmql.update(update);
    return _findByIdAndUpdate.call(this, id, update, options);
  };

  const _updateOne = Model.updateOne;
  Model.updateOne = function updateOne(conditions: any, doc: any, options: any) {
    if (isJsmql(conditions)) conditions = jsmql.filter(conditions);
    if (isJsmql(doc)) doc = jsmql.update(doc);
    return _updateOne.call(this, conditions, doc, options);
  };

  const _updateMany = Model.updateMany;
  Model.updateMany = function updateMany(conditions: any, update: any, options: any) {
    if (isJsmql(conditions)) conditions = jsmql.filter(conditions);
    if (isJsmql(update)) update = jsmql.update(update);
    return _updateMany.call(this, conditions, update, options);
  };

  const _replaceOne = Model.replaceOne;
  Model.replaceOne = function replaceOne(conditions: any, doc: any, options: any) {
    if (isJsmql(conditions)) conditions = jsmql.filter(conditions);
    return _replaceOne.call(this, conditions, doc, options);
  };

  const _deleteOne = Model.deleteOne;
  Model.deleteOne = function deleteOne(conditions: any, options: any) {
    if (isJsmql(conditions)) conditions = jsmql.filter(conditions);
    return _deleteOne.call(this, conditions, options);
  };

  const _deleteMany = Model.deleteMany;
  Model.deleteMany = function deleteMany(conditions: any, options: any) {
    if (isJsmql(conditions)) conditions = jsmql.filter(conditions);
    return _deleteMany.call(this, conditions, options);
  };

  const _countDocuments = Model.countDocuments;
  Model.countDocuments = function countDocuments(conditions: any, options: any) {
    if (isJsmql(conditions)) conditions = jsmql.filter(conditions);
    return _countDocuments.call(this, conditions, options);
  };

  const _exists = Model.exists;
  Model.exists = function exists(filter: any, options: any) {
    if (isJsmql(filter)) filter = jsmql.filter(filter);
    return _exists.call(this, filter, options);
  };

  const _distinct = Model.distinct;
  Model.distinct = function distinct(field: any, conditions: any, options: any) {
    if (isJsmql(conditions)) conditions = jsmql.filter(conditions);
    return _distinct.call(this, field, conditions, options);
  };

  const _aggregate = Model.aggregate;
  Model.aggregate = function aggregate(pipeline: any, options: any) {
    if (isJsmql(pipeline)) pipeline = jsmql.pipeline(pipeline);
    return _aggregate.call(this, pipeline, options);
  };
}

import type {} from "mongoose";

declare module "mongoose" {
  interface Model<
    TRawDocType,
    TQueryHelpers,
    TInstanceMethods,
    TVirtuals,
    THydratedDocumentType,
    TSchema,
    TLeanResultType,
  > {
    find(filter: JsmqlInput, projection?: any, options?: any): any;
    findOne(filter: JsmqlInput, projection?: any, options?: any): any;
    findOneAndUpdate(filter: JsmqlInput, update?: any, options?: any): any;
    findOneAndUpdate(filter: any, update: JsmqlInput, options?: any): any;
    findOneAndDelete(filter: JsmqlInput, options?: any): any;
    findOneAndReplace(filter: JsmqlInput, replacement?: any, options?: any): any;
    findByIdAndUpdate(id: any, update: JsmqlInput, options?: any): any;
    countDocuments(filter: JsmqlInput, options?: any): any;
    distinct(field: string, filter: JsmqlInput, options?: any): any;
    deleteOne(filter: JsmqlInput, options?: any): any;
    deleteMany(filter: JsmqlInput, options?: any): any;
    updateOne(filter: JsmqlInput, doc?: any, options?: any): any;
    updateOne(filter: any, doc: JsmqlInput, options?: any): any;
    updateMany(filter: JsmqlInput, update?: any, options?: any): any;
    updateMany(filter: any, update: JsmqlInput, options?: any): any;
    replaceOne(filter: JsmqlInput, doc?: any, options?: any): any;
    exists(filter: JsmqlInput, options?: any): any;
    aggregate(pipeline: JsmqlInput, options?: any): any;
  }
}
