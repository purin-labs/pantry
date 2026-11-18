
export type Predicate =
  | { op: "eq"; path: string; value: unknown }
  | { op: "ne"; path: string; value: unknown }
  | { op: "lt"; path: string; value: number }
  | { op: "lte"; path: string; value: number }
  | { op: "gt"; path: string; value: number }
  | { op: "gte"; path: string; value: number }
  | { op: "in"; path: string; values: unknown[] }
  | { op: "matches"; path: string; pattern: string }
  | { op: "and"; args: Array<Predicate> }
  | { op: "or"; args: Array<Predicate> }
  | { op: "not"; arg: Predicate };
