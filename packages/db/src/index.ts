import type { BatchItem, BatchResponse } from "drizzle-orm/batch";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

export * from "./cost";
export * from "./events";
export * from "./rows";
export { schema };

/**
 * The forge's database: D1 in the Worker, an in-memory SQLite in Node tests
 * (`@gitflare/db/testing`). Both are asynchronous Drizzle SQLite databases
 * over the same schema, and this type is what they have in common.
 *
 * D1 has no interactive transactions. Use `db.batch([...])` when several
 * statements must commit together; never `db.transaction()`.
 */
export type Db = BaseSQLiteDatabase<"async", unknown, typeof schema> & {
  batch<U extends BatchItem<"sqlite">, T extends Readonly<[U, ...U[]]>>(
    batch: T,
  ): Promise<BatchResponse<T>>;
};
