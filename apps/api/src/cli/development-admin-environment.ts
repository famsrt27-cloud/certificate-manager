export interface DevelopmentAdminEnvironment {
  readonly bcryptCost: number;
  readonly databaseUrl: string;
}

const LOCAL_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export const loadDevelopmentAdminEnvironment = (
  environment: NodeJS.ProcessEnv
): DevelopmentAdminEnvironment => {
  if (environment.NODE_ENV !== "development") {
    throw new Error("Local admin bootstrap requires NODE_ENV=development");
  }

  const databaseUrl = environment.DATABASE_URL;
  if (databaseUrl === undefined) {
    throw new Error("Local admin bootstrap requires an explicit DATABASE_URL");
  }

  let parsedDatabaseUrl: URL;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (
    (parsedDatabaseUrl.protocol !== "postgresql:" && parsedDatabaseUrl.protocol !== "postgres:")
    || !LOCAL_DATABASE_HOSTS.has(parsedDatabaseUrl.hostname)
    || parsedDatabaseUrl.pathname.length <= 1
  ) {
    throw new Error("Local admin bootstrap requires a PostgreSQL database on localhost, 127.0.0.1, or ::1");
  }

  const bcryptCost = Number(environment.BCRYPT_COST ?? "12");
  if (!Number.isInteger(bcryptCost)) {
    throw new Error("BCRYPT_COST must be an integer");
  }

  return { bcryptCost, databaseUrl };
};
