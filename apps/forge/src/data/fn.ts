import { ForgeError } from "@gitflare/core";
import { notFound } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requestContext } from "@/server/context";

/**
 * The middleware every server function in `src/data` uses. It establishes who
 * is calling and passes that on as `context`, which has exactly the shape a
 * `ForgeApi` operation takes as its first argument. A `not_found` from the
 * operation becomes the router's not-found, so a route's `notFoundComponent`
 * renders instead of an error boundary.
 */
export const authed = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const context = await requestContext(getRequest().headers);
  try {
    return await next({ context });
  } catch (error) {
    if (error instanceof ForgeError && error.code === "not_found") throw notFound();
    throw error;
  }
});
