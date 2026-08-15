// Type-only validation. Loaded by `tsc --noEmit -p test/types/tsconfig.json`
// to prove the `declare module "mongoose"` augmentation in src/mongoose.ts
// merges correctly with real mongoose types — every patched method must
// accept a JSMQL string or arrow at the right slot.
//
// Not a vitest test (no `.test.ts` suffix, so vitest skips it). The smoke
// suite in test/smoke.test.ts spawns tsc against it; mongoose is pinned at
// `"*"` in devDependencies so every `npm install` pulls the latest, which
// turns this case into the canary that catches our augmentation drifting
// against mongoose's evolving generics.

import mongoose from "mongoose";
import "../../src/mongoose.ts";
import "../../src/globals.ts";

interface User {
  name: string;
  age: number;
  region: string;
  score: number;
  email: string;
  status: string;
}

const userSchema = new mongoose.Schema<User>({
  name: String,
  age: Number,
  region: String,
  score: Number,
  email: String,
  status: String,
});

const UserModel = mongoose.model<User>("User", userSchema);

// All four call-shape inputs must pass type-checking at each slot. The
// regular MQL forms (plain object / array) must keep working untouched —
// that's the pass-through path — and the JSMQL forms (string / arrow) must
// type-check via the augmentation.

// find — filter at 0
UserModel.find({ age: { $gt: 18 } });
UserModel.find("$.age > 18");
UserModel.find(({ $ }) => $.age > 18);

// findOne — filter at 0
UserModel.findOne({ age: 18 });
UserModel.findOne("$.age === 18");
UserModel.findOne(({ $ }) => $.age === 18);

// findOneAndUpdate — filter at 0, update at 1
UserModel.findOneAndUpdate({ age: 18 }, { $set: { name: "x" } });
UserModel.findOneAndUpdate("$.age > 18", { $set: { name: "x" } });
UserModel.findOneAndUpdate(({ $ }) => $.age > 18, { $set: { name: "x" } });
UserModel.findOneAndUpdate({ age: 18 }, "$.name = $.name.toUpperCase()");
UserModel.findOneAndUpdate({ age: 18 }, ({ $ }) => ($.score += 1));

// findOneAndDelete — filter at 0
UserModel.findOneAndDelete({ age: 18 });
UserModel.findOneAndDelete("$.age === 18");
UserModel.findOneAndDelete(({ $ }) => $.age === 18);

// findOneAndReplace — filter at 0; replacement at 1 stays untyped against jsmql
UserModel.findOneAndReplace({ age: 18 }, { name: "x", age: 19, region: "AU", score: 0, email: "x", status: "y" });
UserModel.findOneAndReplace("$.age === 18", { name: "x", age: 19, region: "AU", score: 0, email: "x", status: "y" });

// findByIdAndUpdate — id at 0 (no jsmql), update at 1
UserModel.findByIdAndUpdate("507f1f77bcf86cd799439011", "$.name = $.name.toUpperCase()");
UserModel.findByIdAndUpdate("507f1f77bcf86cd799439011", ({ $ }) => ($.score += 1));

// updateOne — filter at 0, doc at 1
UserModel.updateOne({ age: 18 }, { $set: { name: "x" } });
UserModel.updateOne("$.age > 18", { $set: { name: "x" } });
UserModel.updateOne(({ $ }) => $.age > 18, { $set: { name: "x" } });
UserModel.updateOne({ age: 18 }, "$.name = $.name.toUpperCase()");
UserModel.updateOne({ age: 18 }, ({ $ }) => ($.score += 1));

// updateMany — filter at 0, update at 1
UserModel.updateMany({}, { $set: { score: 1 } });
UserModel.updateMany("$.region === 'AU'", { $set: { score: 1 } });
UserModel.updateMany({}, "$.score += 1");
UserModel.updateMany({}, ({ $ }) => ($.score += 1));

// replaceOne — filter at 0
UserModel.replaceOne({ age: 18 }, { name: "x", age: 19, region: "AU", score: 0, email: "x", status: "y" });
UserModel.replaceOne("$.age === 18", { name: "x", age: 19, region: "AU", score: 0, email: "x", status: "y" });

// deleteOne / deleteMany — filter at 0
UserModel.deleteOne({ age: 18 });
UserModel.deleteOne("$.age > 18");
UserModel.deleteMany({});
UserModel.deleteMany("$.region === 'AU'");
UserModel.deleteMany(({ $ }) => $.region === "AU");

// countDocuments — filter at 0
UserModel.countDocuments({ age: { $gt: 18 } });
UserModel.countDocuments("$.age > 18");

// exists — filter at 0
UserModel.exists({ age: { $gt: 18 } });
UserModel.exists("$.age > 18");

// distinct — field at 0, filter at 1
UserModel.distinct("email");
UserModel.distinct("email", { region: "AU" });
UserModel.distinct("email", "$.region === 'AU'");
UserModel.distinct("email", ({ $ }) => $.region === "AU");

// aggregate — pipeline at 0
UserModel.aggregate([{ $match: { age: { $gt: 18 } } }]);
UserModel.aggregate("$match($.age > 18); $sort({ age: 1 })");
UserModel.aggregate(({ $ }) => {
  $match($.age > 18);
  $sort({ age: 1 });
});
