// How a route is defined (Plan 77 step 3). The core and each built-in plugin
// list their routes with `routeFor<TheirRoutes>()`; the core's route table
// joins them. A route's fields are exactly its path parameters, which the
// type checks.
import type { Variant } from "@purin-labs/type-utils";

export type RouteMethod = "DELETE" | "GET" | "POST" | "PUT";

type AnyRoute = Readonly<{ kind: string }>;

export type RouteDefinition<Route extends AnyRoute = AnyRoute> = Readonly<{
  method: RouteMethod;
  kind: Route["kind"];
  pattern: RegExp;
  /** Builds the route from the captured path segments, still percent-encoded. */
  route: (segments: readonly string[]) => Route | undefined;
  /**
   * The command a write body becomes (Plan 80 step 1). The body carries only
   * the command's own fields; the server adds the merchant and the other
   * path parameters, the `Idempotency-Key` header, its clock and this
   * version.
   */
  command?: `underclerk.${string}.v${number}`;
}>;

type PathParameterNames<Path extends string> =
  Path extends `${string}:${infer Name}/${infer Rest}`
    ? Name | PathParameterNames<Rest>
    : Path extends `${string}:${infer Name}`
      ? Name
      : never;

type SameShape<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

/** The path, or never when its parameters are not exactly the route's fields. */
type CheckedPath<
  Route extends AnyRoute,
  Kind extends Route["kind"],
  Path extends string,
> =
  SameShape<
    Variant<Route, Kind>,
    Readonly<{ kind: Kind } & Record<PathParameterNames<Path>, string>>
  > extends true
    ? Path
    : never;

/**
 * The `route` helper of one route union: a route whose fields are its
 * percent-decoded path parameters.
 */
export function routeFor<Route extends AnyRoute>() {
  return function route<
    const Kind extends Route["kind"],
    const Path extends string,
  >(
    method: RouteMethod,
    path: Path & CheckedPath<Route, Kind, Path>,
    kind: Kind,
    command?: RouteDefinition["command"],
  ): RouteDefinition<Route> {
    const names = path
      .split("/")
      .filter((segment) => segment.startsWith(":"))
      .map((segment) => segment.slice(1));
    return {
      method,
      kind,
      ...(command === undefined ? {} : { command }),
      pattern: pathPattern(path),
      route: (segments) => {
        const fields = Object.fromEntries(
          names.map((name, index) => [
            name,
            decodePathSegment(segments[index]),
          ]),
        );
        // CheckedPath makes the parameter names exactly this route's fields.
        return { ...fields, kind } as Variant<Route, Kind>;
      },
    };
  };
}

/** Matches a path template, capturing each `:name` segment. */
export function pathPattern(path: string): RegExp {
  const source = path
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "([^/]+)" : segment))
    .join("\\/");
  return new RegExp(`^${source}$`, "u");
}

export function decodePathSegment(value: string | undefined): string {
  if (value === undefined) throw new Error("Route path segment is missing");
  return decodeURIComponent(value);
}
