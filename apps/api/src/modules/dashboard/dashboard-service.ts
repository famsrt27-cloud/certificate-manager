import { getDashboardAggregates, type DatabaseClient } from "@certificate-platform/database";
import type { EffectiveMembership } from "@certificate-platform/domain";

export class DashboardService {
  readonly #database: DatabaseClient;

  constructor(database: DatabaseClient) {
    this.#database = database;
  }

  async getSummary(organizationId: string, membership: EffectiveMembership) {
    const permissions = new Set(membership.permissions);
    const result = await getDashboardAggregates(this.#database, organizationId, {
      projects: permissions.has("project:read"),
      trainings: permissions.has("training:read"),
      participants: permissions.has("participant:read"),
      templates: permissions.has("template:read"),
      certificates: permissions.has("certificate:read"),
      jobs: permissions.has("job:read")
    });
    return {
      organization: { public_certificate_search_enabled: result.organization.publicCertificateSearchEnabled },
      ...(result.projects === undefined ? {} : { projects: result.projects }),
      ...(result.trainings === undefined ? {} : { trainings: result.trainings }),
      ...(result.participants === undefined ? {} : { participants: result.participants }),
      ...(result.templates === undefined ? {} : { templates: {
        active: result.templates.active, published_versions: result.templates.publishedVersions
      } }),
      ...(result.certificates === undefined ? {} : { certificates: {
        available: result.certificates.available, in_progress: result.certificates.inProgress, revoked: result.certificates.revoked
      } }),
      ...(result.jobs === undefined ? {} : { jobs: {
        queued: result.jobs.queued, running: result.jobs.running, failed: result.jobs.failed, dead_letter: result.jobs.deadLetter
      } })
    };
  }
}
