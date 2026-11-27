import type { Env } from "@purin-labs/kernel/env";
import { controlError } from "./http";

/** The parts of one control request that the handler of a route reads. */
export type ControlRequest = Readonly<{
  request: Request;
  env: Env;
  /** The URL of the request, read one time. */
  url: URL;
  execution: ExecutionContext | null;
}>;

type ControlHandler = (call: ControlRequest) => Response | Promise<Response>;

/**
 * One family of control routes: the matcher of its paths with the handler
 * of its routes. It gives the handler of a path that it matches, or null.
 */
export type ControlRouteFamily = (pathname: string) => ControlHandler | null;

/** A family whose handler reads the whole control request. */
export function controlRouteFamilyWith<Route>(
  match: (pathname: string) => Route | null,
  handle: (call: ControlRequest, route: Route) => Response | Promise<Response>,
): ControlRouteFamily {
  return (pathname) => {
    const route = match(pathname);
    return route === null ? null : (call) => handle(call, route);
  };
}

/** A family whose handler reads the request, the environment and the route. */
export function controlRouteFamily<Route>(
  match: (pathname: string) => Route | null,
  handle: (
    request: Request,
    env: Env,
    route: Route,
  ) => Response | Promise<Response>,
): ControlRouteFamily {
  return controlRouteFamilyWith(match, (call, route) =>
    handle(call.request, call.env, route),
  );
}

/**
 * Answers one control request with the first family of the table that
 * matches its path, in the order of the table. A path that no family
 * matches answers 404 `not_found`.
 */
export async function handleControlRouteTable(
  families: readonly ControlRouteFamily[],
  request: Request,
  env: Env,
  execution: ExecutionContext | null,
): Promise<Response> {
  const url = new URL(request.url);
  for (const family of families) {
    const handler = family(url.pathname);
    if (handler !== null) return handler({ request, env, url, execution });
  }
  return controlError("not_found", 404);
}
