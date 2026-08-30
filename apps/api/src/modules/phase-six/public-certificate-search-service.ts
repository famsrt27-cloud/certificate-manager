import { PUBLIC_CERTIFICATE_SEARCH_RESULT_LIMIT, PUBLIC_CERTIFICATE_SUGGESTION_LIMIT, type PublicCertificateSearchRequest,
  type PublicCertificateSearchResult } from "@certificate-platform/contracts";
import type { PublicCertificateSearchRecord } from "@certificate-platform/database";
import { createCertificateSearchResultToken } from "@certificate-platform/domain";

export interface PublicCertificateSearchRepository {
  search(criteria: {
    certificateNumber?: string;
    recipientName?: string;
    projectName?: string;
    trainingName?: string;
  }, limit: number): Promise<readonly PublicCertificateSearchRecord[]>;
  suggestProjects(query: string, limit: number): Promise<readonly string[]>;
  suggestTrainings(projectName: string | undefined, query: string, limit: number): Promise<readonly string[]>;
}

export interface PublicCertificateSearchServiceOptions {
  readonly repository: PublicCertificateSearchRepository;
  readonly activeSigningKeyId: string;
  readonly activeSigningKey: Uint8Array;
  readonly ttlSeconds: number;
  readonly now?: () => Date;
}

export interface PublicCertificateSearchData {
  readonly results: readonly PublicCertificateSearchResult[];
  readonly too_broad: boolean;
}

export class PublicCertificateSearchFailureError extends Error {
  constructor() {
    super("Public certificate search failed");
    this.name = "PublicCertificateSearchFailureError";
  }
}

export class PublicCertificateSearchService {
  readonly #options: PublicCertificateSearchServiceOptions;

  constructor(options: PublicCertificateSearchServiceOptions) { this.#options = options; }

  async suggestProjects(query: string) {
    const labels = await this.#options.repository.suggestProjects(query, PUBLIC_CERTIFICATE_SUGGESTION_LIMIT);
    return { suggestions: labels.slice(0, PUBLIC_CERTIFICATE_SUGGESTION_LIMIT).map((label) => ({ label })) };
  }

  async suggestTrainings(projectName: string | undefined, query: string) {
    const labels = await this.#options.repository.suggestTrainings(
      projectName, query, PUBLIC_CERTIFICATE_SUGGESTION_LIMIT
    );
    return { suggestions: labels.slice(0, PUBLIC_CERTIFICATE_SUGGESTION_LIMIT).map((label) => ({ label })) };
  }

  async search(request: PublicCertificateSearchRequest): Promise<PublicCertificateSearchData> {
    const records = await this.#options.repository.search({
      ...(request.certificate_number === undefined ? {} : { certificateNumber: request.certificate_number }),
      ...(request.recipient_name === undefined ? {} : { recipientName: request.recipient_name }),
      ...(request.project_name === undefined ? {} : { projectName: request.project_name }),
      ...(request.training_name === undefined ? {} : { trainingName: request.training_name })
    }, PUBLIC_CERTIFICATE_SEARCH_RESULT_LIMIT + 1);
    if (records.length > PUBLIC_CERTIFICATE_SEARCH_RESULT_LIMIT) return { results: [], too_broad: true };
    try {
      const issuedAt = this.#options.now?.() ?? new Date();
      return {
        too_broad: false,
        results: records.map((record) => ({
          certificate_number: record.certificateNumber,
          recipient_name: record.recipientName,
          project_name: record.projectName,
          training_name: record.trainingName,
          issued_at: record.issuedAt.toISOString().slice(0, 10),
          status: "available" as const,
          search_result_token: createCertificateSearchResultToken({
            keyId: this.#options.activeSigningKeyId,
            key: this.#options.activeSigningKey,
            publicIdentifier: record.publicIdentifier,
            issuedAt,
            ttlSeconds: this.#options.ttlSeconds
          })
        }))
      };
    } catch {
      throw new PublicCertificateSearchFailureError();
    }
  }
}
