import { sql } from "kysely";

import type { DatabaseClient } from "./database.js";

export interface PublicCertificateSearchCriteria {
  readonly certificateNumber?: string;
  readonly recipientName?: string;
  readonly projectName?: string;
  readonly trainingName?: string;
}

export interface PublicCertificateSearchRecord {
  readonly publicIdentifier: string;
  readonly certificateNumber: string;
  readonly recipientName: string;
  readonly projectName: string;
  readonly trainingName: string;
  readonly issuedAt: Date;
}

const normalizedEquals = (column: Parameters<typeof sql.ref>[0], value: string) =>
  sql<boolean>`lower(regexp_replace(normalize(btrim(${sql.ref(column)}), NFKC), '[[:space:]]+', ' ', 'g')) = lower(${value})`;

const normalizedStartsWith = (column: Parameters<typeof sql.ref>[0], value: string) =>
  sql<boolean>`starts_with(lower(regexp_replace(normalize(btrim(${sql.ref(column)}), NFKC), '[[:space:]]+', ' ', 'g')), lower(${value}))`;

const canonicalRecipientNameEquals = (column: Parameters<typeof sql.ref>[0], value: string) =>
  sql<boolean>`(
    public.canonical_public_recipient_name(${sql.ref(column)}, FALSE)
      = public.canonical_public_recipient_name(${value}, FALSE)
    OR public.canonical_public_recipient_name(${sql.ref(column)}, TRUE)
      = public.canonical_public_recipient_name(${value}, FALSE)
  )`;

const eligiblePublicSnapshots = (database: DatabaseClient) => database
  .selectFrom("certificates as certificate")
  .innerJoin("certificate_issuance_snapshots as snapshot", "snapshot.certificate_id", "certificate.id")
  .innerJoin("organizations as organization", "organization.id", "certificate.organization_id")
  .where("certificate.status", "=", "AVAILABLE")
  .where("organization.public_certificate_search_enabled", "=", true);

export const suggestPublicCertificateProjects = async (
  database: DatabaseClient,
  query: string,
  limit: number
): Promise<readonly string[]> => {
  const rows = await eligiblePublicSnapshots(database)
    .where(normalizedStartsWith("snapshot.project_name", query))
    .select("snapshot.project_name as label")
    .distinct()
    .orderBy("snapshot.project_name", "asc")
    .limit(limit)
    .execute();
  return rows.map((row) => row.label);
};

export const suggestPublicCertificateTrainings = async (
  database: DatabaseClient,
  projectName: string | undefined,
  query: string,
  limit: number
): Promise<readonly string[]> => {
  let eligibleTrainings = eligiblePublicSnapshots(database)
    .where(normalizedStartsWith("snapshot.training_name", query))
  if (projectName !== undefined) {
    eligibleTrainings = eligibleTrainings.where(normalizedEquals("snapshot.project_name", projectName));
  }
  const rows = await eligibleTrainings
    .select("snapshot.training_name as label")
    .distinct()
    .orderBy("snapshot.training_name", "asc")
    .limit(limit)
    .execute();
  return rows.map((row) => row.label);
};

export const findPublicCertificatesBySearch = async (
  database: DatabaseClient,
  criteria: PublicCertificateSearchCriteria,
  limit: number
): Promise<readonly PublicCertificateSearchRecord[]> => {
  let query = eligiblePublicSnapshots(database);

  if (criteria.certificateNumber !== undefined) {
    query = query.where(normalizedEquals("certificate.certificate_number", criteria.certificateNumber));
  } else {
    query = query.where(canonicalRecipientNameEquals("snapshot.recipient_display_name", criteria.recipientName!));
    if (criteria.projectName !== undefined) {
      query = query.where(normalizedEquals("snapshot.project_name", criteria.projectName));
    }
    if (criteria.trainingName !== undefined) {
      query = query.where(normalizedEquals("snapshot.training_name", criteria.trainingName));
    }
  }

  return query.select([
    "certificate.public_identifier as publicIdentifier",
    "certificate.certificate_number as certificateNumber",
    "snapshot.recipient_display_name as recipientName",
    "snapshot.project_name as projectName",
    "snapshot.training_name as trainingName",
    "snapshot.issued_at as issuedAt"
  ]).orderBy("snapshot.issued_at", "desc").orderBy("certificate.certificate_number", "asc")
    .limit(limit).execute();
};
