/**
 * A module of the Session actor. A journey puts a fault hook on a method of
 * the module that owns the step, because the modules call each other and
 * not the Actor class.
 */
export function sessionModule(
  actor: object,
  name: "checkpoints" | "harnessTurns",
): object {
  const module: unknown = Reflect.get(actor, name);
  if (typeof module !== "object" || module === null)
    throw new Error(`Missing Session module ${name}`);
  return module;
}
