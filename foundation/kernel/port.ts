/**
 * A port that the Worker wires (Refactor 17). A lower module defines the
 * port and reads it. A higher module gives the implementation, and the
 * Worker registers it once when its entry module loads
 * (`worker-ports.ts`). A read before the registration is a programmer
 * error, so it throws.
 */
export type Port<T> = Readonly<{
  /** The Worker gives the implementation. */
  register(implementation: T): void;
  /** The implementation that the Worker gave. */
  use(): T;
}>;

export function definePort<T>(name: string): Port<T> {
  let registered: T | null = null;
  return {
    register(implementation) {
      registered = implementation;
    },
    use() {
      if (registered === null) throw new Error(`${name}_unregistered`);
      return registered;
    },
  };
}
