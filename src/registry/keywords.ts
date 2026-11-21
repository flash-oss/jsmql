import type { TokenName } from "./vocabulary.ts";

export type KeywordSpec = { doc: string; token: TokenName };

export type KeywordEntry = KeywordSpec & { kind: "keyword" };

const keyword = (e: KeywordSpec): KeywordEntry => ({ ...e, kind: "keyword" });

export const KEYWORDS = {
  return: keyword({ doc: "Yields a block's value.", token: "Return" }),

  const: keyword({ doc: "Binds a name that cannot be reassigned.", token: "Const" }),

  let: keyword({ doc: "Binds a name that can be reassigned.", token: "Let" }),

  in: keyword({ doc: "Tests membership of a value in an array.", token: "In" }),

  new: keyword({ doc: "Marks a constructor call.", token: "New" }),

  typeof: keyword({ doc: "Gives the type name of a value.", token: "Typeof" }),

  delete: keyword({ doc: "Removes a field from the document.", token: "Delete" }),

  true: keyword({ doc: "The boolean true.", token: "True" }),

  false: keyword({ doc: "The boolean false.", token: "False" }),

  null: keyword({ doc: "An explicit null. Distinct from a missing field.", token: "Null" }),

  undefined: keyword({ doc: "Absence. Compared with `===` it becomes an existence test.", token: "Undefined" }),
};

export type KeywordKey = keyof typeof KEYWORDS;
