import type { Kysely } from "kysely";

import type { Database } from "./types.js";

export interface DashboardMetricSelection {
  readonly projects: boolean;
  readonly trainings: boolean;
  readonly participants: boolean;
  readonly templates: boolean;
  readonly certificates: boolean;
  readonly jobs: boolean;
}

export interface DashboardAggregateResult {
  readonly projects?: { readonly active: number; readonly total: number };
  readonly trainings?: { readonly active: number; readonly total: number };
  readonly participants?: { readonly total: number };
  readonly templates?: { readonly active: number; readonly publishedVersions: number };
  readonly certificates?: { readonly available: number; readonly inProgress: number; readonly revoked: number };
  readonly jobs?: { readonly queued: number; readonly running: number; readonly failed: number; readonly deadLetter: number };
}

const asNumber = (value: string | number | bigint): number => Number(value);

export const getDashboardAggregates = async (
  database: Kysely<Database>,
  organizationId: string,
  selection: DashboardMetricSelection
): Promise<DashboardAggregateResult> => {
  const [projects, trainings, participants, templates, certificates, jobs] = await Promise.all([
    selection.projects ? database.selectFrom("projects").select((expression) => [
      expression.fn.countAll().as("total"),
      expression.fn.count("id").filterWhere("status", "=", "ACTIVE").as("active")
    ]).where("organization_id", "=", organizationId).executeTakeFirstOrThrow() : undefined,
    selection.trainings ? database.selectFrom("trainings").select((expression) => [
      expression.fn.countAll().as("total"),
      expression.fn.count("id").filterWhere("status", "=", "ACTIVE").as("active")
    ]).where("organization_id", "=", organizationId).executeTakeFirstOrThrow() : undefined,
    selection.participants ? database.selectFrom("participants").select((expression) =>
      expression.fn.countAll().as("total")
    ).where("organization_id", "=", organizationId).executeTakeFirstOrThrow() : undefined,
    selection.templates ? Promise.all([
      database.selectFrom("certificate_templates").select((expression) =>
        expression.fn.count("id").filterWhere("status", "=", "ACTIVE").as("active")
      ).where("organization_id", "=", organizationId).executeTakeFirstOrThrow(),
      database.selectFrom("template_versions as version")
        .innerJoin("certificate_templates as template", (join) => join
          .onRef("template.id", "=", "version.template_id")
          .onRef("template.organization_id", "=", "version.organization_id"))
        .select((expression) => expression.fn.count("version.id").as("published_versions"))
        .where("version.organization_id", "=", organizationId)
        .where("version.status", "=", "PUBLISHED")
        .where("template.status", "=", "ACTIVE")
        .executeTakeFirstOrThrow()
    ]) : undefined,
    selection.certificates ? database.selectFrom("certificates").select((expression) => [
      expression.fn.count("id").filterWhere("status", "=", "AVAILABLE").as("available"),
      expression.fn.count("id").filterWhere("status", "in", ["DRAFT", "GENERATING"]).as("in_progress"),
      expression.fn.count("id").filterWhere("status", "=", "REVOKED").as("revoked")
    ]).where("organization_id", "=", organizationId).executeTakeFirstOrThrow() : undefined,
    selection.jobs ? database.selectFrom("jobs").select((expression) => [
      expression.fn.count("id").filterWhere("status", "=", "QUEUED").as("queued"),
      expression.fn.count("id").filterWhere("status", "=", "RUNNING").as("running"),
      expression.fn.count("id").filterWhere("status", "=", "FAILED").as("failed"),
      expression.fn.count("id").filterWhere("status", "=", "DEAD_LETTER").as("dead_letter")
    ]).where("organization_id", "=", organizationId).executeTakeFirstOrThrow() : undefined
  ]);

  return {
    ...(projects === undefined ? {} : { projects: { active: asNumber(projects.active), total: asNumber(projects.total) } }),
    ...(trainings === undefined ? {} : { trainings: { active: asNumber(trainings.active), total: asNumber(trainings.total) } }),
    ...(participants === undefined ? {} : { participants: { total: asNumber(participants.total) } }),
    ...(templates === undefined ? {} : { templates: {
      active: asNumber(templates[0].active), publishedVersions: asNumber(templates[1].published_versions)
    } }),
    ...(certificates === undefined ? {} : { certificates: {
      available: asNumber(certificates.available), inProgress: asNumber(certificates.in_progress), revoked: asNumber(certificates.revoked)
    } }),
    ...(jobs === undefined ? {} : { jobs: {
      queued: asNumber(jobs.queued), running: asNumber(jobs.running), failed: asNumber(jobs.failed), deadLetter: asNumber(jobs.dead_letter)
    } })
  };
};
