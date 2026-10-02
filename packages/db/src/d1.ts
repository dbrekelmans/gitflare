import { drizzle } from "drizzle-orm/d1";
import type { Db } from "./index";
import * as schema from "./schema";

/** Wraps a D1 binding. The parameter is whatever `drizzle-orm/d1` accepts: `env.DB`. */
export function createD1Db(binding: Parameters<typeof drizzle>[0]): Db {
  return drizzle(binding, { schema });
}
