// A Base UI part takes a class name or a function of its state. withClass
// puts the Portal class of a part in front of the class that a caller passes.
type ClassName<State> = string | ((state: State) => string | undefined);

export function withClass<State>(
  base: string,
  className: ClassName<State> | undefined,
): ClassName<State> {
  if (typeof className === "function")
    return (state) => joinClasses(base, className(state));
  return joinClasses(base, className);
}

export function joinClasses(base: string, extra: string | undefined): string {
  return extra ? `${base} ${extra}` : base;
}
