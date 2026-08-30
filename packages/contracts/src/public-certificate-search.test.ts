import { describe, expect, it } from "vitest";
import { PublicCertificateSearchRequestSchema, PublicProjectSuggestionRequestSchema,
  PublicTrainingSuggestionRequestSchema } from "./phase-six.js";

describe("public certificate search request", () => {
  it.each([{}, { recipient_name: "สมชาย ใจดี" }, { project_name: "โครงการดิจิทัล" },
    { recipient_name: "สม", project_name: "โครงการดิจิทัล" },
    { certificate_number: "CERT-1", recipient_name: "สมชาย ใจดี", project_name: "โครงการดิจิทัล" },
    { recipient_name: "สมชาย ใจดี", project_name: "โค" },
    { recipient_name: "สมชาย ใจดี", project_name: "โครงการ", external_reference: "private" }])(
    "rejects insufficient or non-canonical input %#", (input) => {
      expect(PublicCertificateSearchRequestSchema.safeParse(input).success).toBe(false);
    });

  it.each([{ certificate_number: " CERT-2569-001 " },
    { recipient_name: "สมชาย   ใจดี", project_name: " โครงการดิจิทัล " },
    { recipient_name: "สมชาย ใจดี", training_name: "หลักสูตรปลอดภัย" },
    { recipient_name: "สมชาย ใจดี", project_name: "โครงการดิจิทัล", training_name: "หลักสูตรปลอดภัย" }])(
    "accepts an approved bounded combination %#", (input) => {
      expect(PublicCertificateSearchRequestSchema.safeParse(input).success).toBe(true);
    });

  it("normalizes Unicode and whitespace without accepting oversized UTF-8 input", () => {
    const parsed = PublicCertificateSearchRequestSchema.parse({ recipient_name: "  สมชาย　ใจดี ",
      project_name: "โครงการดิจิทัล" });
    expect(parsed.recipient_name).toBe("สมชาย ใจดี");
    expect(PublicCertificateSearchRequestSchema.safeParse({ recipient_name: "ก".repeat(101),
      project_name: "โครงการดิจิทัล" }).success).toBe(false);
  });

  it("requires bounded normalized input for independent and project-filtered training suggestions", () => {
    expect(PublicProjectSuggestionRequestSchema.safeParse({ query: "" }).success).toBe(false);
    expect(PublicProjectSuggestionRequestSchema.safeParse({ query: "ก" }).success).toBe(false);
    expect(PublicProjectSuggestionRequestSchema.parse({ query: "  โครงการ　ไทย  " }).query).toBe("โครงการ ไทย");
    expect(PublicTrainingSuggestionRequestSchema.parse({ query: "  อบ " })).toEqual({ query: "อบ" });
    expect(PublicTrainingSuggestionRequestSchema.safeParse({ query: "อ" }).success).toBe(false);
    expect(PublicTrainingSuggestionRequestSchema.safeParse({ query: "อบ", project_name: "" }).success).toBe(false);
    expect(PublicTrainingSuggestionRequestSchema.parse({ query: "  อบ ", project_name: " โครงการไทย " }))
      .toEqual({ query: "อบ", project_name: "โครงการไทย" });
  });
});
