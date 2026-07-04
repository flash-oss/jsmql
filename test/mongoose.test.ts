import { describe, it, expect } from "vitest";
import jsmqlMongoose from "../src/mongoose.ts";

// Mock-based tests: real mongoose isn't installed as a devDep; instead each
// test constructs the minimal shape the plugin reads — `mongoose.Model` with
// the static methods the plugin patches. Calls are recorded so we can verify
// the arguments the *original* method received after the plugin's transform.

type Recorded = { method: string; args: unknown[]; thisArg: unknown };

function buildMockMongoose(): { mongoose: { Model: any }; Model: any; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  class Model {
    static find(..._args: unknown[]): unknown {
      recorded.push({ method: "find", args: _args, thisArg: this });
      return "find-result";
    }
    static findOne(..._args: unknown[]): unknown {
      recorded.push({ method: "findOne", args: _args, thisArg: this });
      return "findOne-result";
    }
    static findOneAndUpdate(..._args: unknown[]): unknown {
      recorded.push({ method: "findOneAndUpdate", args: _args, thisArg: this });
      return "findOneAndUpdate-result";
    }
    static findOneAndDelete(..._args: unknown[]): unknown {
      recorded.push({ method: "findOneAndDelete", args: _args, thisArg: this });
      return "findOneAndDelete-result";
    }
    static findOneAndReplace(..._args: unknown[]): unknown {
      recorded.push({ method: "findOneAndReplace", args: _args, thisArg: this });
      return "findOneAndReplace-result";
    }
    static findByIdAndUpdate(..._args: unknown[]): unknown {
      recorded.push({ method: "findByIdAndUpdate", args: _args, thisArg: this });
      return "findByIdAndUpdate-result";
    }
    static updateOne(..._args: unknown[]): unknown {
      recorded.push({ method: "updateOne", args: _args, thisArg: this });
      return "updateOne-result";
    }
    static updateMany(..._args: unknown[]): unknown {
      recorded.push({ method: "updateMany", args: _args, thisArg: this });
      return "updateMany-result";
    }
    static deleteOne(..._args: unknown[]): unknown {
      recorded.push({ method: "deleteOne", args: _args, thisArg: this });
      return "deleteOne-result";
    }
    static deleteMany(..._args: unknown[]): unknown {
      recorded.push({ method: "deleteMany", args: _args, thisArg: this });
      return "deleteMany-result";
    }
    static replaceOne(..._args: unknown[]): unknown {
      recorded.push({ method: "replaceOne", args: _args, thisArg: this });
      return "replaceOne-result";
    }
    static countDocuments(..._args: unknown[]): unknown {
      recorded.push({ method: "countDocuments", args: _args, thisArg: this });
      return "countDocuments-result";
    }
    static exists(..._args: unknown[]): unknown {
      recorded.push({ method: "exists", args: _args, thisArg: this });
      return "exists-result";
    }
    static distinct(..._args: unknown[]): unknown {
      recorded.push({ method: "distinct", args: _args, thisArg: this });
      return "distinct-result";
    }
    static aggregate(..._args: unknown[]): unknown {
      recorded.push({ method: "aggregate", args: _args, thisArg: this });
      return "aggregate-result";
    }
  }
  return { mongoose: { Model }, Model, recorded };
}

describe("@koresar/jsmql/mongoose — plugin shape and argument validation", () => {
  it("throws if called with a non-object", () => {
    expect(() => jsmqlMongoose(null as any)).toThrow(/expected the mongoose module/);
    expect(() => jsmqlMongoose(undefined as any)).toThrow(/expected the mongoose module/);
    expect(() => jsmqlMongoose("mongoose" as any)).toThrow(/expected the mongoose module/);
  });

  it("throws if mongoose.Model is missing", () => {
    expect(() => jsmqlMongoose({} as any)).toThrow(/does not look like the mongoose module/);
  });
});

describe("@koresar/jsmql/mongoose — Filter-accepting methods", () => {
  const methods = [
    "find",
    "findOne",
    "findOneAndDelete",
    "findOneAndReplace",
    "countDocuments",
    "deleteOne",
    "deleteMany",
    "replaceOne",
    "exists",
  ] as const;

  for (const name of methods) {
    it(`Model.${name}: string filter is lowered through jsmql.filter`, () => {
      const { mongoose, Model, recorded } = buildMockMongoose();
      jsmqlMongoose(mongoose);
      Model[name]("$.age > 18");
      expect(recorded).toHaveLength(1);
      expect(recorded[0].args[0]).toEqual({ age: { $gt: 18 } });
    });

    it(`Model.${name}: arrow filter is lowered through jsmql.filter`, () => {
      const { mongoose, Model, recorded } = buildMockMongoose();
      jsmqlMongoose(mongoose);
      Model[name](({ $ }: any) => $.age > 18);
      expect(recorded[0].args[0]).toEqual({ age: { $gt: 18 } });
    });

    it(`Model.${name}: plain-object filter passes through untouched`, () => {
      const { mongoose, Model, recorded } = buildMockMongoose();
      jsmqlMongoose(mongoose);
      const original = { age: { $gt: 18 } };
      Model[name](original);
      expect(recorded[0].args[0]).toBe(original);
    });
  }

  it("trailing args (projection / options) are preserved verbatim", () => {
    const { mongoose, Model, recorded } = buildMockMongoose();
    jsmqlMongoose(mongoose);
    const projection = { name: 1, age: 1 };
    const options = { limit: 10 };
    Model.find("$.age > 18", projection, options);
    expect(recorded[0].args).toEqual([{ age: { $gt: 18 } }, projection, options]);
  });

  it("a Pipeline-shaped source at a filter slot surfaces the strict error", () => {
    const { mongoose, Model } = buildMockMongoose();
    jsmqlMongoose(mongoose);
    expect(() => Model.find("$match($.x > 0); $sort({ x: 1 })")).toThrow(
      /jsmql\.filter\(\) expects a Filter.*`;`-separated Pipeline/s,
    );
  });
});

describe("@koresar/jsmql/mongoose — Filter + update slots", () => {
  for (const name of ["updateOne", "updateMany", "findOneAndUpdate"] as const) {
    it(`Model.${name}(filter, update): both slots are lowered`, () => {
      const { mongoose, Model, recorded } = buildMockMongoose();
      jsmqlMongoose(mongoose);
      Model[name]("$.status === 'active'", ({ $ }: any) => ($.score += 1));
      expect(recorded[0].args[0]).toEqual({ status: "active" });
      expect(recorded[0].args[1]).toEqual([{ $set: { score: { $add: ["$score", 1] } } }]);
    });

    it(`Model.${name}: plain-object filter + plain-object update both pass through`, () => {
      const { mongoose, Model, recorded } = buildMockMongoose();
      jsmqlMongoose(mongoose);
      const filter = { status: "active" };
      const update = { $set: { score: 1 } };
      Model[name](filter, update);
      expect(recorded[0].args[0]).toBe(filter);
      expect(recorded[0].args[1]).toBe(update);
    });

    it(`Model.${name}: mixed — plain-object filter + jsmql update`, () => {
      const { mongoose, Model, recorded } = buildMockMongoose();
      jsmqlMongoose(mongoose);
      const filter = { _id: 1 };
      Model[name](filter, "$.name = $.name.toUpperCase()");
      expect(recorded[0].args[0]).toBe(filter);
      expect(recorded[0].args[1]).toEqual([{ $set: { name: { $toUpper: "$name" } } }]);
    });
  }

  it("a bare-expression update surfaces jsmql.update()'s actionable error", () => {
    const { mongoose, Model } = buildMockMongoose();
    jsmqlMongoose(mongoose);
    expect(() => Model.updateOne({}, "$.age > 18")).toThrow(/jsmql\.update\(\) expects a Pipeline/);
  });

  it("an out-of-whitelist stage inside an update surfaces the named error", () => {
    const { mongoose, Model } = buildMockMongoose();
    jsmqlMongoose(mongoose);
    expect(() => Model.updateMany({}, "$set({ a: 1 }); $sort({ a: 1 })")).toThrow(
      /jsmql\.update\(\) rejected '\$sort'/,
    );
  });
});

describe("@koresar/jsmql/mongoose — findByIdAndUpdate (id-at-0)", () => {
  it("leaves the id slot alone and lowers only the update slot", () => {
    const { mongoose, Model, recorded } = buildMockMongoose();
    jsmqlMongoose(mongoose);
    Model.findByIdAndUpdate("507f1f77bcf86cd799439011", ({ $ }: any) => ($.lastSeen = new Date(0)));
    expect(recorded[0].args[0]).toBe("507f1f77bcf86cd799439011");
    expect(Array.isArray(recorded[0].args[1])).toBe(true);
  });
});

describe("@koresar/jsmql/mongoose — distinct (filter-at-1)", () => {
  it("Model.distinct(field, jsmqlFilter): field passes through, filter lowers", () => {
    const { mongoose, Model, recorded } = buildMockMongoose();
    jsmqlMongoose(mongoose);
    Model.distinct("email", "$.region === 'AU'");
    expect(recorded[0].args[0]).toBe("email");
    expect(recorded[0].args[1]).toEqual({ region: "AU" });
  });

  it("Model.distinct(field) with no filter is a no-op pass-through", () => {
    const { mongoose, Model, recorded } = buildMockMongoose();
    jsmqlMongoose(mongoose);
    Model.distinct("email");
    expect(recorded[0].args[0]).toBe("email");
  });
});

describe("@koresar/jsmql/mongoose — aggregate (pipeline-at-0)", () => {
  it("string pipeline is lowered through jsmql.pipeline", () => {
    const { mongoose, Model, recorded } = buildMockMongoose();
    jsmqlMongoose(mongoose);
    Model.aggregate("$match($.x > 0); $sort({ x: 1 })");
    expect(recorded[0].args[0]).toEqual([{ $match: { x: { $gt: 0 } } }, { $sort: { x: 1 } }]);
  });

  it("arrow pipeline is lowered through jsmql.pipeline", () => {
    const { mongoose, Model, recorded } = buildMockMongoose();
    jsmqlMongoose(mongoose);
    Model.aggregate(({ $ }: any) => {
      $match($.x > 0);
      $sort({ x: 1 });
    });
    expect(recorded[0].args[0]).toEqual([{ $match: { x: { $gt: 0 } } }, { $sort: { x: 1 } }]);
  });

  it("array-of-stages passes through untouched", () => {
    const { mongoose, Model, recorded } = buildMockMongoose();
    jsmqlMongoose(mongoose);
    const pipeline = [{ $match: { x: { $gt: 0 } } }];
    Model.aggregate(pipeline);
    expect(recorded[0].args[0]).toBe(pipeline);
  });

  it("bare-expression pipeline surfaces jsmql.pipeline()'s actionable error", () => {
    const { mongoose, Model } = buildMockMongoose();
    jsmqlMongoose(mongoose);
    expect(() => Model.aggregate("$.x > 0")).toThrow(/jsmql\.pipeline\(\) expects a Pipeline/);
  });
});

describe("@koresar/jsmql/mongoose — subclass propagation", () => {
  it("subclasses inherit the patched statics", () => {
    const { mongoose, Model, recorded } = buildMockMongoose();
    jsmqlMongoose(mongoose);
    class User extends Model {}
    User.find("$.age > 18");
    expect(recorded[0].args[0]).toEqual({ age: { $gt: 18 } });
    // The patched function is reached via prototype-chain lookup, so it
    // executes with the subclass as `this` — matching real mongoose behaviour.
    expect(recorded[0].thisArg).toBe(User);
  });
});

describe("@koresar/jsmql/mongoose — idempotence", () => {
  it("a second registration is a no-op (no double-lowering)", () => {
    // Without the `__jsmqlPatched` guard, the second `jsmqlMongoose(mongoose)`
    // call would wrap each already-wrapped static one more time. On the next
    // `Model.find("$.x > 0")`, the outer wrapper would lower the string to a
    // Filter document (a plain object), then the inner wrapper would see the
    // *object* and pass it through to the original — accidentally working —
    // but a second `Model.find(jsmql.filter("$match(...)"))` path would feed
    // the strict lowerer's output back into itself and explode. Easier to
    // make the second call a no-op than to reason about that.
    const { mongoose, Model, recorded } = buildMockMongoose();
    jsmqlMongoose(mongoose);
    jsmqlMongoose(mongoose);
    Model.find("$.age > 18");
    expect(recorded[0].args[0]).toEqual({ age: { $gt: 18 } });
  });
});
