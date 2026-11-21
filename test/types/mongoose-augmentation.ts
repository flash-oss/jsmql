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

UserModel.find({ age: { $gt: 18 } });
UserModel.find("$.age > 18");
UserModel.find(({ $ }) => $.age > 18);

UserModel.findOne({ age: 18 });
UserModel.findOne("$.age === 18");
UserModel.findOne(({ $ }) => $.age === 18);

UserModel.findOneAndUpdate({ age: 18 }, { $set: { name: "x" } });
UserModel.findOneAndUpdate("$.age > 18", { $set: { name: "x" } });
UserModel.findOneAndUpdate(({ $ }) => $.age > 18, { $set: { name: "x" } });
UserModel.findOneAndUpdate({ age: 18 }, "$.name = $.name.toUpper()");
UserModel.findOneAndUpdate({ age: 18 }, ({ $ }) => ($.score += 1));

UserModel.findOneAndDelete({ age: 18 });
UserModel.findOneAndDelete("$.age === 18");
UserModel.findOneAndDelete(({ $ }) => $.age === 18);

UserModel.findOneAndReplace({ age: 18 }, { name: "x", age: 19, region: "AU", score: 0, email: "x", status: "y" });
UserModel.findOneAndReplace("$.age === 18", { name: "x", age: 19, region: "AU", score: 0, email: "x", status: "y" });

UserModel.findByIdAndUpdate("507f1f77bcf86cd799439011", "$.name = $.name.toUpper()");
UserModel.findByIdAndUpdate("507f1f77bcf86cd799439011", ({ $ }) => ($.score += 1));

UserModel.updateOne({ age: 18 }, { $set: { name: "x" } });
UserModel.updateOne("$.age > 18", { $set: { name: "x" } });
UserModel.updateOne(({ $ }) => $.age > 18, { $set: { name: "x" } });
UserModel.updateOne({ age: 18 }, "$.name = $.name.toUpper()");
UserModel.updateOne({ age: 18 }, ({ $ }) => ($.score += 1));

UserModel.updateMany({}, { $set: { score: 1 } });
UserModel.updateMany("$.region === 'AU'", { $set: { score: 1 } });
UserModel.updateMany({}, "$.score += 1");
UserModel.updateMany({}, ({ $ }) => ($.score += 1));

UserModel.replaceOne({ age: 18 }, { name: "x", age: 19, region: "AU", score: 0, email: "x", status: "y" });
UserModel.replaceOne("$.age === 18", { name: "x", age: 19, region: "AU", score: 0, email: "x", status: "y" });

UserModel.deleteOne({ age: 18 });
UserModel.deleteOne("$.age > 18");
UserModel.deleteMany({});
UserModel.deleteMany("$.region === 'AU'");
UserModel.deleteMany(({ $ }) => $.region === "AU");

UserModel.countDocuments({ age: { $gt: 18 } });
UserModel.countDocuments("$.age > 18");

UserModel.exists({ age: { $gt: 18 } });
UserModel.exists("$.age > 18");

UserModel.distinct("email");
UserModel.distinct("email", { region: "AU" });
UserModel.distinct("email", "$.region === 'AU'");
UserModel.distinct("email", ({ $ }) => $.region === "AU");

UserModel.aggregate([{ $match: { age: { $gt: 18 } } }]);
UserModel.aggregate("$match($.age > 18); $sort({ age: 1 })");
UserModel.aggregate(({ $ }) => {
  $match($.age > 18);
  $sort({ age: 1 });
});
