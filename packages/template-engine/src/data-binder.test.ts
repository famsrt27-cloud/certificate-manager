import { describe, expect, it } from "vitest";

import { bindTemplate } from "./data-binder.js";
import { TemplateDefinitionSchema } from "./template-definition.js";

describe("bindTemplate", () => {
  it("resolves only compile-time allowlisted fields without property traversal", () => {
    const definition = TemplateDefinitionSchema.parse({ format_version: 1, page: { width: 500, height: 500, unit: "px" }, elements: [
      { type: "text", binding: "recipient.display_name", font: { family: "Noto Sans Thai", size: 24 } },
      { type: "qr", binding: "verification_url", x: 100, y: 100, width: 100, height: 100 }
    ] });
    expect(bindTemplate(definition, {
      recipient: { displayName: "Synthetic Recipient" }, project: { name: "Project" },
      training: { name: "Training", code: "T-1" }, certificate: { number: "CERT-1", issuedAt: "2026-08-18" },
      verificationUrl: "https://verify.invalid/#token"
    })).toEqual([{ index: 0, value: "Synthetic Recipient" }, { index: 1, value: "https://verify.invalid/#token" }]);
  });

  it.each([
    "<script>inert</script>", "{{constructor.constructor('inert')()}}", "${process.env.SECRET}",
    "<%= inert %>", "javascript:inert", "file:///etc/passwd", "../../../../etc/passwd"
  ])("returns template literal payloads verbatim without evaluation", (text) => {
    const definition = TemplateDefinitionSchema.parse({ format_version: 1, page: { width: 500, height: 500, unit: "px" }, elements: [
      { type: "text", text, font: { family: "Noto Sans Thai", size: 24 } }
    ] });
    const bound = bindTemplate(definition, {
      recipient: { displayName: "Recipient" }, project: { name: "Project" }, training: { name: "Training", code: "T-1" },
      certificate: { number: "CERT-1", issuedAt: "2026-08-18" }, verificationUrl: "https://verify.invalid/#token"
    });
    expect(bound).toEqual([{ index: 0, value: text }]);
  });
});
