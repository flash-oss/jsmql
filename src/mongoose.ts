/**
 * `@koresar/jsmql/mongoose` — register jsmql with a mongoose module so the
 * standard `Model.find / updateOne / aggregate / …` static methods accept
 * jsmql source directly, alongside the regular MQL-JSON forms.
 *
 *     const mongoose = require("mongoose");
 *     require("@koresar/jsmql/mongoose")(mongoose);
 *
 *     User.find("$.age > 18");                       // → Model.find({ age: { $gt: 18 } })
 *     User.aggregate(({ $ }) => { $match($.age > 18); $sort({ age: 1 }); });
 *     User.updateMany({}, ({ $ }) => $.score += 1);  // → updateMany({}, [{ $set: { score: { $add: ["$score", 1] } } }])
 *
 * ## Detection rule
 *
 * An argument is treated as jsmql input when it is a **string** or a
 * **function**. Plain objects and arrays pass through to the original
 * mongoose method unchanged, so existing MQL-JSON call sites (`Model.find({
 * age: { $gt: 18 } })`, `Model.aggregate([{ $match: ... }])`) keep working
 * exactly as before. Users who want the template-tag form call `jsmql\`…\``
 * themselves — the resulting object/array then takes the pass-through path.
 *
 * Modern mongoose (7+) returns Promises and no longer accepts callback
 * arguments, so the heuristic doesn't collide with `(err, result) => …` in
 * practice.
 *
 * ## One wrapper per method
 *
 * Each patched method is wrapped explicitly with its own named function.
 * The method signatures are stable across mongoose versions and small
 * enough that a per-method wrapper is easier to read and to debug than a
 * lookup table — a stack trace points straight at the method that did the
 * wrong thing, and the signature is right there next to the call.
 *
 * `findOneAndReplace` / `replaceOne` take a full *replacement document* at
 * argument 1, not an update spec — so we patch their filter slot only.
 * `findById` and `findByIdAndDelete` are id-only and aren't patched at all.
 * `Query.prototype.*` builder methods (`.where()`, `.gt()`, `.sort()`, …) are
 * intentionally NOT patched: jsmql keeps the mongoose surface to the `Model`
 * statics so developers don't have to learn a new API (DX-first). See
 * docs/specs/mongoose-plugin.md.
 */

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
 * The `mongoose` parameter is typed `any` deliberately. We don't depend on
 * mongoose at compile time (no peer/dev dep, no `import "mongoose"`), so the
 * real `Mongoose` type isn't in scope here; the plugin treats the argument as
 * a duck-typed `{ Model: { find, …pre-patched statics… } }` and the per-
 * method wrappers below pass the rest through. Annotating each captured
 * original and wrapper parameter individually would add noise without
 * tightening the contract — every value just passes through to mongoose
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
  // Idempotence: a second registration on the same Model would double-wrap
  // every static, and the second wrap would then try to `jsmql.filter()` an
  // already-lowered Filter document and throw. Cheap to guard against, so we
  // do — `__jsmqlPatched` is the marker; one property check, no Symbol indirection.
  if (Model.__jsmqlPatched === true) return;
  Model.__jsmqlPatched = true;

  // Each block below patches a single mongoose static. Same shape every time:
  //   1. Capture the original method under `_<name>`.
  //   2. Reassign with a named function that mirrors the mongoose signature.
  //   3. Inside, run the jsmql-eligible slot(s) through the matching strict
  //      entry when the input is a string or function; pass everything else
  //      through untouched.
  //   4. Delegate to the captured original with `.call(this, …)` so the
  //      subclass receiver and any extra trailing args (projection, options)
  //      reach mongoose unchanged.
  //
  // The captured original is named `_<method>` rather than `<method>` to
  // avoid the named-function-expression shadowing pitfall: inside
  // `function find(...) { ... }` the bare name `find` resolves to the wrapper
  // itself (not to an outer `const find`), so without the underscore prefix
  // the wrapper would recursively call itself and blow the stack.

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

// TypeScript module augmentation. Adds JSMQL-shaped overloads to every
// mongoose `Model` static the plugin patches at runtime, so call sites like
// `User.find("$.age > 18")` and `User.aggregate(({ $ }) => { $match(...) })`
// type-check after `import "@koresar/jsmql/mongoose"` (or after calling the
// default export — the augmentation rides along with the value import).
//
// Each overload is positioned AFTER the methods' existing mongoose
// signatures in resolution order, with `string | function` parameter types
// that don't overlap any normal mongoose call shape — so the augmentation
// can't accidentally win for a call the user meant to type-check against
// mongoose's own overloads. Return types use `any` because re-declaring
// mongoose's schema-aware query/aggregate return-type machinery here would
// be brittle and would drift on every mongoose minor release; users who want
// the precise return type either pass a typed `FilterQuery`/`PipelineStage[]`
// (matching mongoose's own overloads) or cast at the call site.
//
// The augmentation merges into mongoose's `Model<TRawDocType, …>` interface,
// so it activates only when the user actually has mongoose installed. If
// mongoose isn't on the resolution path, this block has no effect on
// downstream type-checking — no spurious "mongoose is missing" errors from
// projects that import this file purely for the runtime plugin.

// Type-only side-effect import: brings mongoose into the program so the
// `declare module "mongoose"` block below has the target interface to merge
// with. The import is `import type` and references no values, so it's erased
// at emit time — no runtime mongoose dependency is introduced. tsc's
// `--isolatedDeclarations` / `--verbatimModuleSyntax` are happy with this
// shape; bundlers tree-shake it to nothing.
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
