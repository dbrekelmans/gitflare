import { ForgeError, httpStatus } from "@gitflare/core";
import type { ApiContext, HttpErrorBody } from "@gitflare/core/api";
import type { z } from "zod";
import { requestContext } from "./context";

function errorResponse(error: unknown): Response {
  if (error instanceof ForgeError) {
    const body: HttpErrorBody = { error: { code: error.code, message: error.message } };
    return Response.json(body, { status: httpStatus(error.code) });
  }
  if (error instanceof Error && error.name === "NotImplementedError") {
    const body: HttpErrorBody = { error: { code: "unavailable", message: error.message } };
    return Response.json(body, { status: 501 });
  }
  console.error(error);
  const body: HttpErrorBody = { error: { code: "unavailable", message: "Something went wrong." } };
  return Response.json(body, { status: 500 });
}

/**
 * A handler for an authenticated JSON server route: it establishes the
 * caller, runs `handle`, and turns the result or the failure into a response.
 * Every server route under `/api` except health and the WebSocket upgrade is
 * written with it, so they all fail the same way.
 */
export function apiRoute<Params>(
  handle: (input: { ctx: ApiContext; request: Request; params: Params }) => Promise<unknown>,
) {
  return async ({ request, params }: { request: Request; params: Params }): Promise<Response> => {
    try {
      const ctx = await requestContext(request.headers);
      const result = await handle({ ctx, request, params });
      return result === undefined ? new Response(null, { status: 204 }) : Response.json(result);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/** Validates route params or any other untrusted value; what does not fit is an `invalid` error, never a 500. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ForgeError("invalid", parsed.error.message);
  return parsed.data;
}

/** Reads and validates a JSON body; a body that does not parse is an `invalid` error. */
export async function readJson<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.output<S>> {
  return parseInput(schema, await request.json().catch(() => undefined));
}
