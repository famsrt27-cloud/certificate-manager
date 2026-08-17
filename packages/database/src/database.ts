import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import type { Database } from "./types.js";

export interface DatabaseConnectionConfig {
  readonly connectionString: string;
  readonly maxConnections: number;
}

export const createDatabase = ({
  connectionString,
  maxConnections
}: DatabaseConnectionConfig): Kysely<Database> =>
  new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString,
        max: maxConnections,
        application_name: "certificate-platform"
      })
    })
  });

export const checkDatabase = async (database: Kysely<Database>): Promise<void> => {
  await sql`select 1`.execute(database);
};

export const closeDatabase = async (database: Kysely<Database>): Promise<void> => {
  await database.destroy();
};
