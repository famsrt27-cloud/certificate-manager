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
  let currentDefinition: unknown = definition;
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
      await route.fulfill({ json: { data: templateCreated ? [{ id: templateId, name: "Secure Template", status: "ACTIVE",
        preview: versionCreated ? { version: 1, status: versionStatus, definition: currentDefinition } : null }] : [],
        meta: { request_id: requestId, next_cursor: null } } }); return;
    }
    if (path === `/api/admin/templates/${templateId}` && method === "GET") {
      await route.fulfill({ json: { data: { id: templateId, name: "Secure Template", status: "ACTIVE" }, meta: { request_id: requestId } } }); return;
    }
    if (path.endsWith("/assets")) {
      await route.fulfill({ json: { data: [], meta: { request_id: requestId, next_cursor: null } } }); return;
    }
    if (path.endsWith("/versions") && method === "POST") {
      const payload = route.request().postDataJSON() as { definition: { format_version: number; page: { width: number; height: number; unit: string }; elements: { type: string }[] } };
      expect(payload.definition.format_version).toBe(1);
      expect(payload.definition.page).toEqual({ width: 1123, height: 794, unit: "px" });
      expect(payload.definition.elements.some((element) => element.type === "text")).toBe(true);
      currentDefinition = payload.definition;
      versionCreated = true;
      await route.fulfill({ status: 201, json: { data: { id: versionId, template_id: templateId, version: 1,
        definition: currentDefinition, asset_ids: [], status: "DRAFT", published_at: null }, meta: { request_id: requestId } } }); return;
    }
    if (path.endsWith("/versions")) {
      await route.fulfill({ json: { data: versionCreated ? [{ id: versionId, template_id: templateId, version: 1,
        definition: currentDefinition, asset_ids: [], status: versionStatus, published_at: versionStatus === "PUBLISHED" ? "2026-08-18T00:00:00.000Z" : null }] : [],
        meta: { request_id: requestId, next_cursor: null } } }); return;
    }
    if (path.endsWith("/preview")) {
      await route.fulfill({ json: { data: { definition: currentDefinition, bound_elements: [{ index: 1, value: "Preview Recipient" }] },
        meta: { request_id: requestId } } }); return;
    }
    if (path.endsWith("/publish")) {
      expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
      versionStatus = "PUBLISHED";
      await route.fulfill({ json: { data: { id: versionId, template_id: templateId, version: 1, definition: currentDefinition,
        asset_ids: [], status: "PUBLISHED", published_at: "2026-08-18T00:00:00.000Z" }, meta: { request_id: requestId } } }); return;
    }
    await route.fulfill({ status: 404, json: {} });
  });

  await page.goto("/admin");
  await page.getByRole("button", { name: "สร้างเทมเพลตใหม่", exact: true }).first().click();
  await page.getByLabel("ชื่อเทมเพลต").fill("Secure Template");
  await page.getByRole("dialog", { name: "สร้างเทมเพลตใหม่" }).getByRole("button", { name: "สร้างเทมเพลต" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/templates/${templateId}$`));
  await page.getByRole("button", { name: "สร้างแบบร่างแรก" }).click();
  await expect(page.getByText("มีการแก้ไขที่ยังไม่ได้บันทึก")).toHaveCount(0);
  await page.getByRole("button", { name: "ตรวจสอบข้อมูลตัวอย่าง" }).click();
  await expect(page.getByText("Preview Recipient").first()).toBeVisible();
  await page.getByRole("button", { name: "เผยแพร่เวอร์ชัน" }).click();
  await page.getByRole("dialog", { name: "เผยแพร่เวอร์ชัน" }).getByRole("button", { name: "ยืนยัน" }).click();
  await expect(page.getByText(/เผยแพร่เวอร์ชัน 1 แล้ว/)).toBeVisible();
  await expect(page.getByRole("button", { name: "บันทึกแบบร่าง" })).toHaveCount(0);
});
