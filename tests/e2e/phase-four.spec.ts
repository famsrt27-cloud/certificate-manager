import { expect, test } from "@playwright/test";

const requestId = "00000000-0000-4000-8000-000000000001";
const organizationId = "00000000-0000-4000-8000-000000000002";
const templateId = "00000000-0000-4000-8000-000000000003";
const versionId = "00000000-0000-4000-8000-000000000004";
const csrfToken = "c".repeat(43);
const definition = { format_version: 1, page: { width: 1123, height: 794, unit: "px" }, elements: [{
  type: "text", x: 161, y: 320, width: 800, height: 80, opacity: 1, align: "center", color: "#000000",
  font: { family: "Noto Sans Thai", size: 42, weight: 700 }, binding: "recipient.display_name"
}] };

test("template manager creates, previews, and publishes an immutable version", async ({ page }) => {
  let templateCreated = false;
  let versionCreated = false;
  let versionStatus: "DRAFT" | "PUBLISHED" = "DRAFT";
  await page.route("**/api/admin/auth/session", (route) => route.fulfill({ json: { data: {
    user: { id: "00000000-0000-4000-8000-000000000005", email: "template@example.invalid" },
    memberships: [{ id: "00000000-0000-4000-8000-000000000006",
      organization: { id: organizationId, name: "Synthetic Organization" }, roles: ["TEMPLATE_MANAGER"], permissions: [
        "template:create", "template:read", "template:update", "template:asset:create", "template:publish"
      ] }], csrf_token: csrfToken
  }, meta: { request_id: requestId } } }));
  await page.route("**/api/admin/templates**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    expect(route.request().headers()["x-organization-id"]).toBe(organizationId);
    if (path === "/api/admin/templates" && method === "POST") {
      expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
      templateCreated = true;
      await route.fulfill({ status: 201, json: { data: { id: templateId, name: "Secure Template", status: "ACTIVE" },
        meta: { request_id: requestId } } }); return;
    }
    if (path === "/api/admin/templates") {
      await route.fulfill({ json: { data: templateCreated ? [{ id: templateId, name: "Secure Template", status: "ACTIVE" }] : [],
        meta: { request_id: requestId, next_cursor: null } } }); return;
    }
    if (path.endsWith("/assets")) {
      await route.fulfill({ json: { data: [], meta: { request_id: requestId } } }); return;
    }
    if (path.endsWith("/versions") && method === "POST") {
      expect(route.request().postDataJSON()).toEqual({ definition });
      versionCreated = true;
      await route.fulfill({ status: 201, json: { data: { id: versionId, template_id: templateId, version: 1,
        definition, asset_ids: [], status: "DRAFT", published_at: null }, meta: { request_id: requestId } } }); return;
    }
    if (path.endsWith("/versions")) {
      await route.fulfill({ json: { data: versionCreated ? [{ id: versionId, template_id: templateId, version: 1,
        definition, asset_ids: [], status: versionStatus, published_at: versionStatus === "PUBLISHED" ? "2026-08-18T00:00:00.000Z" : null }] : [],
        meta: { request_id: requestId } } }); return;
    }
    if (path.endsWith("/preview")) {
      await route.fulfill({ json: { data: { definition, bound_elements: [{ index: 0, value: "Preview Recipient" }] },
        meta: { request_id: requestId } } }); return;
    }
    if (path.endsWith("/publish")) {
      expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
      versionStatus = "PUBLISHED";
      await route.fulfill({ json: { data: { id: versionId, template_id: templateId, version: 1, definition,
        asset_ids: [], status: "PUBLISHED", published_at: "2026-08-18T00:00:00.000Z" }, meta: { request_id: requestId } } }); return;
    }
    await route.fulfill({ status: 404, json: {} });
  });

  await page.goto("/admin");
  const builder = page.getByRole("region", { name: "Template Builder" });
  await builder.getByPlaceholder("Template name").fill("Secure Template");
  await builder.getByRole("button", { name: "Create", exact: true }).click();
  await expect(builder.getByRole("combobox", { name: "Template", exact: true })).toHaveValue(templateId);
  await builder.getByRole("button", { name: "New draft" }).click();
  await expect(builder.getByLabel("Template JSON definition")).toContainText("recipient.display_name");
  await builder.getByRole("button", { name: "Preview" }).click();
  await expect(builder.getByText("Preview Recipient")).toBeVisible();
  await builder.getByRole("button", { name: "Publish" }).click();
  await expect(builder.getByText("Template version published and locked.")).toBeVisible();
  await expect(builder.getByLabel("Template JSON definition")).toBeDisabled();
});
