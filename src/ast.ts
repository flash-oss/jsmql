export type SpreadElement = {
  type: "SpreadElement";
  argument: Expr;
};

export type KeyValueEntry = {
  type: "KeyValueEntry";
  key: string;
  value: Expr;
};

export type ObjectEntry = KeyValueEntry | SpreadElement;
export type ArrayElement = Expr | SpreadElement;

export type Expr =
  | {
      type: "OperatorCall";
      name: string;
      /** positional = args are expressions; object = single ObjectLiteral arg */
      style: "positional" | "object";
      args: Expr[];
    }
  | { type: "FieldRef"; path: string }
  | { type: "NumberLiteral"; value: number }
  | { type: "StringLiteral"; value: string }
  | { type: "BooleanLiteral"; value: boolean }
  | { type: "NullLiteral" }
  | { type: "ArrayLiteral"; elements: ArrayElement[] }
  | { type: "ObjectLiteral"; entries: ObjectEntry[] };
