# 0161. bson is a peer dependency

Status: Accepted
Applies to: `package.json`, `scripts/build-cjs.mjs`, `src/bson.ts`

## Context

JSMQL builds live BSON values, and the driver of the application serialises them. A `bson` serializer checks the version symbol of a value (`@@mdb.bson.version`) before it writes the value. A copy of `bson` that differs from the copy of the application gives a class that fails `instanceof` in the application. It also gives a version symbol that the serializer can refuse. A class that JSMQL makes by hand must hard-code that number, and an application on another major gets a `BSONVersionError`.

## Decision

`bson` is a peer dependency, range `^6.10.0 || ^7.0.0`. A peer dependency resolves to one copy, the copy of the application. A plain `dependencies` entry lets npm nest a second copy beside it.

The peer dependency gives one resolved copy for each module condition. So the version symbol always agrees. It does not give `instanceof` in every case, and nothing can. `bson` has a dual build: its exports map sends `import` to `lib/bson.node.mjs` and `require` to `lib/bson.cjs`. MEASURED, with JSMQL absent from the test:

```
ESM bson.ObjectId === CJS bson.ObjectId : false
CJS bson.ObjectId === mongodb.ObjectId  : true      (mongodb is CJS)
version symbol both sides               : 7 7
mongodb serialises an ESM-built ObjectId: OK
```

MEASURED in `test/bson-majors.test.ts`: a bson 7 serializer refuses a bson 6 value with `BSONVersionError`. So a nested second copy does not only fail an `instanceof` check: the query never reaches the server.

## Consequences

A CJS consumer, which `mongodb` and `mongoose` are, gets exact class identity with the CJS build of JSMQL. An ESM consumer that reaches the classes of the driver through CJS interop does not get it, with or without JSMQL. Its value still serialises, because the serializer reads the version symbol. So recognition cannot trust the prototype alone: see [ADR 0162](0162-value-recognition.md). The CJS bundle keeps `bson` external, and the site bundle includes it.
