export const truthy = (v: unknown) => ({
  $and: [{ $gt: [v, null] }, { $ne: [v, false] }, { $ne: [v, ""] }, { $ne: [v, 0] }],
});

export const truthyAnd = (...vs: unknown[]) => ({ $and: vs.flatMap((v) => truthy(v).$and) });

export const truthyOr = (...vs: unknown[]) => ({ $or: vs.map((v) => truthy(v)) });
