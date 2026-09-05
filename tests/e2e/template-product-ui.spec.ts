import { expect, test, type Page, type Route } from "@playwright/test";

const requestId = "20000000-0000-4000-8000-000000000001";
const organizationA = "20000000-0000-4000-8000-000000000002";
const organizationB = "20000000-0000-4000-8000-000000000003";
const membershipA = "20000000-0000-4000-8000-000000000004";
const membershipB = "20000000-0000-4000-8000-000000000005";
const templateId = "20000000-0000-4000-8000-000000000006";
const secondTemplateId = "20000000-0000-4000-8000-000000000007";
const versionDraftId = "20000000-0000-4000-8000-000000000008";
const versionPublishedId = "20000000-0000-4000-8000-000000000009";
const versionArchivedId = "20000000-0000-4000-8000-000000000010";
const versionClonedId = "20000000-0000-4000-8000-000000000017";
const imageAssetId = "20000000-0000-4000-8000-000000000011";
const fontAssetId = "20000000-0000-4000-8000-000000000012";
const rejectedAssetId = "20000000-0000-4000-8000-000000000013";
const secondImageAssetId = "20000000-0000-4000-8000-000000000016";
const csrfToken = "c".repeat(43);
const managerPermissions = ["template:read", "template:create", "template:update", "template:asset:create", "template:publish"];

const baseDefinition = { format_version: 1 as const, page: { width: 1123, height: 794, unit: "px" as const }, elements: [
  { type: "text" as const, x: 162, y: 286, width: 799, height: 86, opacity: 1, binding: "recipient.display_name" as const, align: "center" as const, color: "#0F172A", font: { family: "Noto Sans Thai", size: 46, weight: 700 as const } }
] };
const template = (id = templateId, name = "เทมเพลตหลัก", status: "ACTIVE" | "INACTIVE" | "ARCHIVED" = "ACTIVE") => ({ id, name, status });
const templateListItem = (id = templateId, name = "เทมเพลตหลัก", status: "ACTIVE" | "INACTIVE" | "ARCHIVED" = "ACTIVE",
  preview: { version: number; status: "DRAFT" | "PUBLISHED" | "ARCHIVED"; definition: unknown } | null = { version: 2, status: "PUBLISHED", definition: baseDefinition }) => ({ ...template(id, name, status), preview });
const version = (id: string, number: number, status: "DRAFT" | "PUBLISHED" | "ARCHIVED", definition: unknown = baseDefinition) => ({ id, template_id: templateId, version: number, definition, asset_ids: [], status, published_at: status === "PUBLISHED" || status === "ARCHIVED" ? "2026-08-20T04:00:00.000Z" : null });
const asset = (id: string, filename: string, mime: "image/png" | "font/ttf", status: "ACTIVE" | "REJECTED" | "ARCHIVED" = "ACTIVE") => ({ id, template_id: templateId, original_filename: filename, detected_mime_type: mime, content_sha256: "a".repeat(64), size_bytes: 2048, width_px: mime === "image/png" ? 320 : null, height_px: mime === "image/png" ? 120 : null, status });

async function routeSession(page: Page, permissions = managerPermissions, multiple = false) {
  await page.route("**/api/admin/auth/session", (route) => route.fulfill({ json: { data: {
    user: { id: "20000000-0000-4000-8000-000000000014", email: "template-ui@example.invalid" },
    memberships: [{ id: membershipA, organization: { id: organizationA, name: "องค์กรออกแบบ A" }, roles: permissions.length === 1 ? ["VIEWER"] : ["TEMPLATE_MANAGER"], permissions },
      ...(multiple ? [{ id: membershipB, organization: { id: organizationB, name: "องค์กรออกแบบ B" }, roles: ["VIEWER"], permissions: ["template:read"] }] : [])], csrf_token: csrfToken
  }, meta: { request_id: requestId } } }));
}

async function fulfillJson(route: Route, data: unknown, status = 200) { await route.fulfill({ status, json: data }); }

test("template library paginates, filters, creates, renames, and archives without UUID-oriented UX", async ({ page }) => {
  await routeSession(page); let created = false; let renamed = false; let archived = false;
  await page.route("**/api/admin/templates**", async (route) => {
    const url = new URL(route.request().url()); const method = route.request().method(); const path = url.pathname;
    expect(route.request().headers()["x-organization-id"]).toBe(organizationA);
    if (path === "/api/admin/templates" && method === "GET") {
      if (url.searchParams.get("status") === "ARCHIVED") return fulfillJson(route, { data: [templateListItem(secondTemplateId, "เทมเพลตเก็บถาวร", "ARCHIVED", null)], meta: { request_id: requestId, next_cursor: null } });
      if (url.searchParams.get("cursor") !== null) return fulfillJson(route, { data: [templateListItem(secondTemplateId, "เทมเพลตหน้าถัดไป", "ACTIVE", { version: 1, status: "DRAFT", definition: baseDefinition })], meta: { request_id: requestId, next_cursor: null } });
      return fulfillJson(route, { data: [templateListItem(templateId, renamed ? "เทมเพลตเปลี่ยนชื่อ" : "เทมเพลตหลัก", archived ? "ARCHIVED" : "ACTIVE")], meta: { request_id: requestId, next_cursor: archived ? null : "next-template-page" } });
    }
    if (path === "/api/admin/templates" && method === "POST") { created = true; expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken); return fulfillJson(route, { data: template(secondTemplateId, "เทมเพลตใหม่"), meta: { request_id: requestId } }, 201); }
    if (path === `/api/admin/templates/${templateId}` && method === "PATCH") { renamed = true; return fulfillJson(route, { data: template(templateId, "เทมเพลตเปลี่ยนชื่อ"), meta: { request_id: requestId } }); }
    if (path === `/api/admin/templates/${templateId}/archive`) { archived = true; return fulfillJson(route, { data: template(templateId, "เทมเพลตเปลี่ยนชื่อ", "ARCHIVED"), meta: { request_id: requestId } }); }
    if (path === `/api/admin/templates/${secondTemplateId}`) return fulfillJson(route, { data: template(secondTemplateId, "เทมเพลตใหม่"), meta: { request_id: requestId } });
    if (path.endsWith("/versions") || path.endsWith("/assets")) return fulfillJson(route, { data: [], meta: { request_id: requestId, next_cursor: null } });
    return fulfillJson(route, {}, 404);
  });
  await page.goto("/admin/templates"); await expect(page.getByRole("heading", { name: "เทมเพลตใบประกาศนียบัตร" })).toBeVisible(); await expect(page.getByText(templateId)).toHaveCount(0);
  await page.getByRole("button", { name: "ถัดไป" }).click(); await expect(page.getByRole("link", { name: "เทมเพลตหน้าถัดไป", exact: true })).toBeVisible(); await page.getByRole("button", { name: "ก่อนหน้า" }).click();
  await page.getByLabel("สถานะ").selectOption("ARCHIVED"); await expect(page.getByRole("link", { name: "เทมเพลตเก็บถาวร", exact: true })).toBeVisible(); await page.getByLabel("สถานะ").selectOption("");
  await page.getByRole("button", { name: "เปลี่ยนชื่อ" }).click(); const renameDialog = page.getByRole("dialog", { name: "เปลี่ยนชื่อเทมเพลต" }); await renameDialog.getByRole("textbox", { name: "ชื่อเทมเพลต" }).fill("เทมเพลตเปลี่ยนชื่อ"); await renameDialog.getByRole("button", { name: "บันทึกชื่อ" }).click(); await expect(page.getByText("เทมเพลตเปลี่ยนชื่อ").first()).toBeVisible();
  await page.getByRole("button", { name: "เก็บถาวร" }).click(); await page.getByRole("dialog", { name: "เก็บเทมเพลตถาวร" }).getByRole("button", { name: "ยืนยันเก็บถาวร" }).click(); await expect(page.getByText("เก็บเทมเพลตถาวรแล้ว")).toBeVisible();
  await page.getByRole("button", { name: "สร้างเทมเพลตใหม่", exact: true }).first().click(); const createDialog = page.getByRole("dialog", { name: "สร้างเทมเพลตใหม่" }); await createDialog.getByRole("textbox", { name: "ชื่อเทมเพลต" }).fill("เทมเพลตใหม่"); await createDialog.getByRole("button", { name: "สร้างเทมเพลต" }).click(); await expect(page).toHaveURL(new RegExp(`/admin/templates/${secondTemplateId}$`)); expect(created).toBe(true);
});

test("visual builder edits all canonical element families, protects invalid JSON, saves explicitly, and manages assets", async ({ page }) => {
  await routeSession(page); let savedDefinition: unknown = baseDefinition; let uploadSeen = false; let assetArchived = false;
  await page.route("**/api/admin/templates**", async (route) => {
    const path = new URL(route.request().url()).pathname; const method = route.request().method();
    if (path === `/api/admin/templates/${templateId}`) return fulfillJson(route, { data: template(), meta: { request_id: requestId } });
    if (path.endsWith("/versions") && method === "GET") return fulfillJson(route, { data: [version(versionDraftId, 3, "DRAFT", savedDefinition)], meta: { request_id: requestId, next_cursor: null } });
    if (path.endsWith(`/versions/${versionDraftId}`) && method === "PATCH") { savedDefinition = (route.request().postDataJSON() as { definition: unknown }).definition; return fulfillJson(route, { data: version(versionDraftId, 3, "DRAFT", savedDefinition), meta: { request_id: requestId } }); }
    if (path.endsWith("/assets") && method === "GET") return fulfillJson(route, { data: [asset(imageAssetId, "logo.png", "image/png"), asset(secondImageAssetId, "signature.png", "image/png"), asset(fontAssetId, "brand-thai.ttf", "font/ttf"), asset(rejectedAssetId, "unsafe.png", "image/png", "REJECTED")], meta: { request_id: requestId, next_cursor: null } });
    if (path.endsWith("/assets") && method === "POST") { uploadSeen = true; expect(route.request().headers()["content-type"]).toContain("multipart/form-data; boundary="); return fulfillJson(route, { data: asset("20000000-0000-4000-8000-000000000015", "signature.png", "image/png"), meta: { request_id: requestId } }, 201); }
    if (path.endsWith(`/assets/${imageAssetId}/archive`)) { assetArchived = true; return fulfillJson(route, { data: asset(imageAssetId, "logo.png", "image/png", "ARCHIVED"), meta: { request_id: requestId } }); }
    return fulfillJson(route, {}, 404);
  });
  await page.goto(`/admin/templates/${templateId}`); await expect(page.getByRole("heading", { name: "เทมเพลตหลัก" })).toBeVisible(); await expect(page.getByText(imageAssetId)).toHaveCount(0); await expect(page.getByText("unsafe.png")).toBeVisible(); await expect(page.getByText("ไม่ผ่านการตรวจสอบ", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "เพิ่มข้อความ" }).click(); await page.getByRole("textbox", { name: "ข้อความ", exact: true }).fill("ผ่านการอบรมเรียบร้อยแล้ว"); await page.getByLabel("ขนาดตัวอักษร").fill("30"); await page.getByLabel("จัดแนว", { exact: true }).selectOption("right");
  await page.getByText("ตำแหน่งและขนาดแบบละเอียด").click(); await page.getByLabel("X", { exact: true }).fill("120"); await page.getByLabel("ความกว้าง").fill("500");
  await page.getByRole("button", { name: "เพิ่มข้อมูลอัตโนมัติ" }).click(); await page.getByLabel("ข้อมูลที่แสดง").selectOption("project.name"); await page.getByLabel("แบบอักษรบนใบประกาศ").selectOption(`asset:${fontAssetId}`);
  await page.getByRole("button", { name: "เพิ่มรูปภาพ" }).click(); const imagePicker = page.getByRole("dialog", { name: "เลือกรูปภาพ" }); await expect(imagePicker).toBeVisible(); await expect(page.getByLabel("ไฟล์รูปภาพ")).toHaveCount(0); await imagePicker.getByRole("option", { name: "เลือก signature.png" }).click(); await imagePicker.getByRole("button", { name: "ใช้รูปที่เลือก" }).click(); await expect(page.getByLabel("ไฟล์รูปภาพ")).toHaveValue(secondImageAssetId);
  await page.getByRole("button", { name: "เพิ่มลายเซ็น" }).click(); const signaturePicker = page.getByRole("dialog", { name: "เลือกรูปลายเซ็น" }); await signaturePicker.getByRole("option", { name: "เลือก logo.png" }).click(); await signaturePicker.getByRole("button", { name: "ใช้รูปที่เลือก" }).click(); await expect(page.getByLabel("ไฟล์ลายเซ็น")).toHaveValue(imageAssetId);
  await page.getByRole("button", { name: "QR ตรวจสอบ", exact: true }).click(); await expect(page.getByLabel("สี QR")).toBeVisible(); await page.getByRole("button", { name: "เพิ่มเส้น/กรอบ" }).click(); await page.getByLabel("รูปแบบ").selectOption("line"); await page.getByLabel("ความหนาเส้น").fill("3");
  await page.getByRole("button", { name: "เลื่อนเลเยอร์ลง" }).click(); await page.getByRole("button", { name: "ลบองค์ประกอบ" }).click(); await expect(page.getByText("มีการแก้ไขที่ยังไม่ได้บันทึก")).toBeVisible();
  await page.getByText("JSON ขั้นสูง").click(); await page.getByLabel("JSON ขั้นสูง").fill("{"); await page.getByRole("button", { name: "ตรวจสอบและนำ JSON มาใช้" }).click(); await expect(page.getByText("JSON ไม่ถูกต้อง จึงยังไม่ได้นำมาใช้")).toBeVisible();
  await page.getByRole("button", { name: "บันทึกแบบร่าง" }).click(); await expect(page.getByText("บันทึกแบบร่างแล้ว")).toBeVisible(); const savedElements = (savedDefinition as { elements: Array<Record<string, unknown>> }).elements; expect(savedElements.length).toBeGreaterThan(1);
  const savedQr = savedElements.find((element) => element.type === "qr"); expect(savedQr).toMatchObject({ type: "qr", binding: "verification_url" }); expect(savedQr).not.toHaveProperty("asset_id");
  await page.getByRole("button", { name: "อัปโหลดไฟล์" }).click(); await page.getByLabel("เลือกไฟล์").setInputFiles({ name: "signature.png", mimeType: "image/png", buffer: Buffer.from("bounded-image-fixture") }); await page.getByRole("dialog", { name: "อัปโหลดไฟล์ประกอบ" }).getByRole("button", { name: "อัปโหลดและตรวจสอบ" }).click(); await expect(page.getByRole("region", { name: "ไฟล์ประกอบเทมเพลต" }).getByText("signature.png", { exact: true }).first()).toBeVisible(); expect(uploadSeen).toBe(true);
  await page.getByRole("region", { name: "ไฟล์ประกอบเทมเพลต" }).locator("li", { hasText: "logo.png" }).getByRole("button", { name: "เก็บไฟล์ถาวร" }).click(); await page.getByRole("dialog", { name: "เก็บไฟล์ถาวร" }).getByRole("button", { name: "ยืนยันเก็บถาวร" }).click(); expect(assetArchived).toBe(true);
});

test("backend validation gates publishing and published or archived versions stay immutable", async ({ page }) => {
  await routeSession(page); let draftStatus: "DRAFT" | "PUBLISHED" = "DRAFT"; let publishedArchived = false;
  await page.route("**/api/admin/templates**", async (route) => {
    const path = new URL(route.request().url()).pathname; const method = route.request().method();
    if (path === `/api/admin/templates/${templateId}`) return fulfillJson(route, { data: template(), meta: { request_id: requestId } });
    if (path.endsWith("/versions") && method === "GET") return fulfillJson(route, { data: [version(versionDraftId, 3, draftStatus), version(versionPublishedId, 2, publishedArchived ? "ARCHIVED" : "PUBLISHED"), version(versionArchivedId, 1, "ARCHIVED")], meta: { request_id: requestId, next_cursor: null } });
    if (path.endsWith("/assets")) return fulfillJson(route, { data: [], meta: { request_id: requestId, next_cursor: null } });
    if (path.endsWith(`/versions/${versionDraftId}/preview`)) return fulfillJson(route, { data: { definition: baseDefinition, bound_elements: [{ index: 0, value: "ผู้รับตัวอย่าง" }] }, meta: { request_id: requestId } });
    if (path.endsWith(`/versions/${versionDraftId}/publish`)) { draftStatus = "PUBLISHED"; return fulfillJson(route, { data: version(versionDraftId, 3, "PUBLISHED"), meta: { request_id: requestId } }); }
    if (path.endsWith(`/versions/${versionPublishedId}/archive`)) { publishedArchived = true; return fulfillJson(route, { data: version(versionPublishedId, 2, "ARCHIVED"), meta: { request_id: requestId } }); }
    return fulfillJson(route, {}, 404);
  });
  await page.goto(`/admin/templates/${templateId}`); await expect(page.getByRole("button", { name: "เผยแพร่เวอร์ชัน" })).toBeDisabled(); await page.getByRole("button", { name: "ตรวจสอบข้อมูลตัวอย่าง" }).click(); await expect(page.getByText("ผู้รับตัวอย่าง").first()).toBeVisible(); await expect(page.getByRole("button", { name: "เผยแพร่เวอร์ชัน" })).toBeEnabled();
  await page.getByRole("button", { name: "เผยแพร่เวอร์ชัน" }).click(); await expect(page.getByRole("dialog", { name: "เผยแพร่เวอร์ชัน" })).toContainText("ถูกล็อกถาวร"); await page.getByRole("dialog", { name: "เผยแพร่เวอร์ชัน" }).getByRole("button", { name: "ยืนยัน" }).click(); await expect(page.getByRole("button", { name: "บันทึกแบบร่าง" })).toHaveCount(0);
  await page.getByLabel("เวอร์ชันที่กำลังดู").selectOption(versionPublishedId); await expect(page.getByText("เวอร์ชันนี้เป็นประวัติแบบอ่านอย่างเดียว")).toBeVisible(); await page.getByRole("button", { name: "เก็บเวอร์ชันถาวร" }).click(); await page.getByRole("dialog", { name: "เก็บเวอร์ชันถาวร" }).getByRole("button", { name: "ยืนยัน" }).click(); expect(publishedArchived).toBe(true);
  await page.getByLabel("เวอร์ชันที่กำลังดู").selectOption(versionArchivedId); await expect(page.getByRole("button", { name: "เพิ่มข้อความ" })).toBeDisabled();
});

test("clone action is single-flight, opens the new draft, and leaves history unchanged on failure", async ({ page }) => {
  await routeSession(page); let cloneRequests = 0; let releaseFirstClone: (() => void) | undefined;
  const firstCloneGate = new Promise<void>((resolve) => { releaseFirstClone = resolve; });
  await page.route("**/api/admin/templates**", async (route) => {
    const path = new URL(route.request().url()).pathname; const method = route.request().method();
    if (path === `/api/admin/templates/${templateId}`) return fulfillJson(route, { data: template(), meta: { request_id: requestId } });
    if (path.endsWith("/versions") && method === "GET") return fulfillJson(route, { data: [
      version(versionDraftId, 3, "DRAFT"), version(versionPublishedId, 2, "PUBLISHED"), version(versionArchivedId, 1, "ARCHIVED")
    ], meta: { request_id: requestId, next_cursor: null } });
    if (path.endsWith("/assets")) return fulfillJson(route, { data: [], meta: { request_id: requestId, next_cursor: null } });
    if (path.endsWith(`/versions/${versionPublishedId}/clone`)) {
      cloneRequests += 1; expect(route.request().postData()).toBeNull();
      expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken); await firstCloneGate;
      return fulfillJson(route, { data: version(versionClonedId, 4, "DRAFT"), meta: { request_id: requestId } }, 201);
    }
    if (path.endsWith(`/versions/${versionArchivedId}/clone`)) {
      cloneRequests += 1;
      return fulfillJson(route, { error: { code: "VALIDATION_FAILED", message: "The request could not be processed." },
        meta: { request_id: requestId } }, 400);
    }
    return fulfillJson(route, {}, 404);
  });

  await page.goto(`/admin/templates/${templateId}`);
  await page.getByLabel("เวอร์ชันที่กำลังดู").selectOption(versionPublishedId);
  await expect(page.getByText("สร้างแบบร่างใหม่ที่แก้ไขได้ โดยเวอร์ชันเดิมจะไม่เปลี่ยนแปลง")).toBeVisible();
  const cloneButton = page.locator("button").filter({ hasText: /สร้างแบบร่างใหม่จากเวอร์ชันนี้|กำลังสร้างแบบร่างใหม่/ });
  await cloneButton.click(); await expect(cloneButton).toBeDisabled();
  await expect(page.getByLabel("เวอร์ชันที่กำลังดู")).toBeDisabled();
  await cloneButton.click({ force: true }); expect(cloneRequests).toBe(1);
  releaseFirstClone?.();
  await expect(page.getByLabel("เวอร์ชันที่กำลังดู")).toBeEnabled();
  await expect(page.getByLabel("เวอร์ชันที่กำลังดู")).toHaveValue(versionClonedId);
  await expect(page.getByText(/สร้างแบบร่างเวอร์ชัน 4 จากเวอร์ชัน 2 แล้ว/)).toBeVisible();

  await page.getByLabel("เวอร์ชันที่กำลังดู").selectOption(versionArchivedId);
  await page.getByRole("button", { name: "สร้างแบบร่างใหม่จากเวอร์ชันนี้" }).click();
  await expect(page.getByText("ไม่สามารถสร้างแบบร่างจากเวอร์ชันนี้ได้ กรุณาตรวจสอบว่าไฟล์อ้างอิงยังพร้อมใช้งานและลองอีกครั้ง")).toBeVisible();
  await expect(page.getByLabel("เวอร์ชันที่กำลังดู")).toHaveValue(versionArchivedId);
  await expect(page.getByLabel("เวอร์ชันที่กำลังดู").locator("option")).toHaveCount(5);
  expect(cloneRequests).toBe(2);
});

test("draft deletion is explicit and unsaved changes are protected when switching versions", async ({ page }) => {
  await routeSession(page); let deleted = false;
  await page.route("**/api/admin/templates**", async (route) => {
    const path = new URL(route.request().url()).pathname; const method = route.request().method();
    if (path === `/api/admin/templates/${templateId}`) return fulfillJson(route, { data: template(), meta: { request_id: requestId } });
    if (path.endsWith("/versions") && method === "GET") return fulfillJson(route, { data: [version(versionDraftId, 3, "DRAFT"), version(versionPublishedId, 2, "PUBLISHED")], meta: { request_id: requestId, next_cursor: null } });
    if (path.endsWith("/assets")) return fulfillJson(route, { data: [], meta: { request_id: requestId, next_cursor: null } });
    if (path.endsWith(`/versions/${versionDraftId}`) && method === "DELETE") { deleted = true; return fulfillJson(route, { data: { deleted: true }, meta: { request_id: requestId } }); }
    return fulfillJson(route, {}, 404);
  });
  await page.goto(`/admin/templates/${templateId}`); await page.getByRole("button", { name: "เพิ่มข้อความ" }).click(); await page.getByLabel("เวอร์ชันที่กำลังดู").selectOption(versionPublishedId); await expect(page.getByRole("dialog", { name: "มีการแก้ไขที่ยังไม่ได้บันทึก" })).toBeVisible(); await page.getByRole("button", { name: "กลับไปบันทึก" }).click(); await expect(page.getByLabel("เวอร์ชันที่กำลังดู")).toHaveValue(versionDraftId);
  await page.getByRole("button", { name: "ลบแบบร่าง" }).click(); await expect(page.getByRole("dialog", { name: "ลบแบบร่าง" })).toContainText("ไม่สามารถกู้คืน"); await page.getByRole("dialog", { name: "ลบแบบร่าง" }).getByRole("button", { name: "ยืนยัน" }).click(); expect(deleted).toBe(true); await expect(page.getByLabel("เวอร์ชันที่กำลังดู")).toHaveValue(versionPublishedId);
});

test("organization switching clears tenant state and read-only users receive no mutation controls", async ({ page }) => {
  await routeSession(page, managerPermissions, true);
  await page.route("**/api/admin/templates**", async (route) => {
    const organization = route.request().headers()["x-organization-id"]; const path = new URL(route.request().url()).pathname;
    if (organization === organizationB) return fulfillJson(route, { error: { code: "NOT_FOUND", message: "not found" }, meta: { request_id: requestId } }, 404);
    if (path === `/api/admin/templates/${templateId}`) return fulfillJson(route, { data: template(templateId, "เทมเพลตองค์กร A"), meta: { request_id: requestId } });
    if (path.endsWith("/versions")) return fulfillJson(route, { data: [version(versionDraftId, 3, "DRAFT")], meta: { request_id: requestId, next_cursor: null } });
    if (path.endsWith("/assets")) return fulfillJson(route, { data: [], meta: { request_id: requestId, next_cursor: null } });
    return fulfillJson(route, {}, 404);
  });
  await page.goto(`/admin/templates/${templateId}`); await expect(page.getByRole("heading", { name: "เทมเพลตองค์กร A" })).toBeVisible(); await page.locator("#active-organization").selectOption(membershipB); await expect(page.getByRole("heading", { name: "เทมเพลตองค์กร A" })).toHaveCount(0); await expect(page.getByText("ไม่สามารถเปิดเทมเพลตได้")).toBeVisible();

  await page.unrouteAll(); await routeSession(page, ["template:read"]); await page.route("**/api/admin/templates**", async (route) => { const path = new URL(route.request().url()).pathname; if (path === `/api/admin/templates/${templateId}`) return fulfillJson(route, { data: template(), meta: { request_id: requestId } }); if (path.endsWith("/versions")) return fulfillJson(route, { data: [version(versionDraftId, 3, "DRAFT")], meta: { request_id: requestId, next_cursor: null } }); return fulfillJson(route, { data: [], meta: { request_id: requestId, next_cursor: null } }); });
  await page.reload(); await expect(page.getByRole("button", { name: "สร้างแบบร่างใหม่" })).toHaveCount(0); await expect(page.getByRole("button", { name: "บันทึกแบบร่าง" })).toHaveCount(0); await expect(page.getByRole("button", { name: "เพิ่มข้อความ" })).toBeDisabled();
});

for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 900 }, { width: 1280, height: 900 }, { width: 1440, height: 900 }]) {
  test(`template studio remains usable without page overflow at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport); await routeSession(page); await page.route("**/api/admin/templates**", async (route) => { const path = new URL(route.request().url()).pathname; if (path === `/api/admin/templates/${templateId}`) return fulfillJson(route, { data: template(), meta: { request_id: requestId } }); if (path.endsWith("/versions")) return fulfillJson(route, { data: [version(versionDraftId, 3, "DRAFT")], meta: { request_id: requestId, next_cursor: null } }); return fulfillJson(route, { data: [], meta: { request_id: requestId, next_cursor: null } }); });
    await page.goto(`/admin/templates/${templateId}`); await expect(page.getByText("พื้นที่ออกแบบ").first()).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    if (viewport.width < 1280) { await page.getByRole("button", { name: "คุณสมบัติ", exact: true }).click(); await expect(page.getByText("ปรับเนื้อหา รูปแบบ ตำแหน่ง และขนาดอย่างแม่นยำ")).toBeVisible(); await page.getByRole("button", { name: "ไฟล์", exact: true }).click(); await expect(page.getByText("ไฟล์ประกอบ").first()).toBeVisible(); }
  });
}

test("drag, resize, keyboard movement, and canonical layer controls update the saved definition", async ({ page }) => {
  await routeSession(page);
  let savedDefinition: typeof baseDefinition | { format_version: 1; page: typeof baseDefinition.page; elements: Array<Record<string, unknown>> } = {
    ...baseDefinition, elements: [...baseDefinition.elements, { type: "qr", x: 900, y: 620, width: 100, height: 100,
      opacity: 1, binding: "verification_url", foreground: "#000000", background: "#FFFFFF" }]
  };
  await page.route("**/api/admin/templates**", async (route) => {
    const path = new URL(route.request().url()).pathname; const method = route.request().method();
    if (path === `/api/admin/templates/${templateId}`) return fulfillJson(route, { data: template(), meta: { request_id: requestId } });
    if (path.endsWith("/versions") && method === "GET") return fulfillJson(route, { data: [version(versionDraftId, 3, "DRAFT", savedDefinition)], meta: { request_id: requestId, next_cursor: null } });
    if (path.endsWith(`/versions/${versionDraftId}`) && method === "PATCH") { savedDefinition = (route.request().postDataJSON() as { definition: typeof savedDefinition }).definition; return fulfillJson(route, { data: version(versionDraftId, 3, "DRAFT", savedDefinition), meta: { request_id: requestId } }); }
    if (path.endsWith("/assets")) return fulfillJson(route, { data: [], meta: { request_id: requestId, next_cursor: null } });
    return fulfillJson(route, {}, 404);
  });
  await page.goto(`/admin/templates/${templateId}`);
  await page.getByRole("button", { name: "QR Code — ลิงก์ตรวจสอบ", exact: true }).click();
  await expect(page.getByRole("button", { name: /ปรับขนาดจากมุม|ลากเพื่อปรับขนาด/ })).toHaveCount(4);
  const qrResize = page.getByRole("button", { name: "ลากเพื่อปรับขนาด" }); const qrHandle = await qrResize.boundingBox();
  expect(qrHandle).not.toBeNull(); await qrResize.hover(); await page.mouse.down();
  await page.mouse.move(qrHandle!.x + 42, qrHandle!.y + 42, { steps: 4 }); await page.mouse.up();
  await page.getByRole("button", { name: /ข้อความ —/ }).first().click();
  const selection = page.getByRole("group", { name: /เลเยอร์ที่เลือก/ });
  const resize = page.getByRole("button", { name: "ลากเพื่อปรับขนาด" }); const handle = await resize.boundingBox();
  expect(handle).not.toBeNull(); await resize.hover(); await page.mouse.down(); await page.mouse.move(handle!.x + 55, handle!.y + 30, { steps: 4 }); await page.mouse.up();
  const before = await selection.boundingBox(); expect(before).not.toBeNull();
  const dragStart = { x: before!.x + before!.width / 2, y: before!.y + before!.height / 2 };
  await page.mouse.move(dragStart.x, dragStart.y); await page.mouse.down();
  await page.mouse.move(dragStart.x + 80, dragStart.y + 45, { steps: 5 }); await page.mouse.up();
  await selection.press("ArrowRight"); await selection.press("Shift+ArrowDown");
  await page.getByRole("button", { name: "นำเลเยอร์ไปด้านหน้า" }).click();
  await page.getByRole("button", { name: "บันทึกแบบร่าง" }).click();
  const elements = savedDefinition.elements; const moved = elements.at(-1) as { type: string; x: number; y: number; width: number; height: number };
  expect(moved.type).toBe("text"); expect(moved.x).toBeGreaterThan(162); expect(moved.y).toBeGreaterThan(286);
  expect(moved.width).toBeGreaterThan(799); expect(elements[0]).toMatchObject({ type: "qr" });
  const resizedQr = elements[0] as { width: number; height: number };
  expect(resizedQr.width).toBeGreaterThan(100); expect(resizedQr.width).toBe(resizedQr.height);
  await page.reload(); await page.getByRole("button", { name: /ข้อความ —/ }).first().click();
  await expect(page.getByLabel("X", { exact: true })).toHaveValue(String(moved.x));
});

test("imports an A4 landscape image as a locked bottom layer without treating raster pixels as PDF dimensions", async ({ page }) => {
  await routeSession(page); const importedTemplateId = "20000000-0000-4000-8000-000000000020";
  const importedAssetId = "20000000-0000-4000-8000-000000000021"; const importedVersionId = "20000000-0000-4000-8000-000000000022";
  let importedDefinition: Record<string, unknown> | null = null;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await page.route("**/api/admin/templates**", async (route) => {
    const path = new URL(route.request().url()).pathname; const method = route.request().method();
    if (path === "/api/admin/templates" && method === "GET") return fulfillJson(route, { data: [], meta: { request_id: requestId, next_cursor: null } });
    if (path === "/api/admin/templates" && method === "POST") return fulfillJson(route, { data: template(importedTemplateId, "แบบ Canva A4"), meta: { request_id: requestId } }, 201);
    if (path === `/api/admin/templates/${importedTemplateId}/assets` && method === "POST") return fulfillJson(route, { data: { ...asset(importedAssetId, "canva-a4.png", "image/png"), template_id: importedTemplateId, width_px: 3508, height_px: 2480 }, meta: { request_id: requestId } }, 201);
    if (path === `/api/admin/templates/${importedTemplateId}/versions` && method === "POST") { importedDefinition = (route.request().postDataJSON() as { definition: Record<string, unknown> }).definition; return fulfillJson(route, { data: { ...version(importedVersionId, 1, "DRAFT", importedDefinition), template_id: importedTemplateId }, meta: { request_id: requestId } }, 201); }
    if (path === `/api/admin/templates/${importedTemplateId}`) return fulfillJson(route, { data: template(importedTemplateId, "แบบ Canva A4"), meta: { request_id: requestId } });
    if (path === `/api/admin/templates/${importedTemplateId}/versions`) return fulfillJson(route, { data: [{ ...version(importedVersionId, 1, "DRAFT", importedDefinition ?? baseDefinition), template_id: importedTemplateId }], meta: { request_id: requestId, next_cursor: null } });
    if (path === `/api/admin/templates/${importedTemplateId}/assets`) return fulfillJson(route, { data: [{ ...asset(importedAssetId, "canva-a4.png", "image/png"), template_id: importedTemplateId, width_px: 3508, height_px: 2480 }], meta: { request_id: requestId, next_cursor: null } });
    if (path.endsWith(`/${importedAssetId}/content`)) return route.fulfill({ status: 200, body: png, contentType: "image/png", headers: { "cache-control": "private, no-store" } });
    return fulfillJson(route, {}, 404);
  });
  await page.goto("/admin/templates"); await page.getByRole("button", { name: "นำเข้าแบบที่ออกแบบไว้แล้ว" }).click();
  const dialog = page.getByRole("dialog", { name: "นำเข้าแบบที่ออกแบบไว้แล้ว" });
  await dialog.getByLabel("ชื่อเทมเพลต").fill("แบบ Canva A4");
  await dialog.getByLabel("เลือกไฟล์แบบใบประกาศ").setInputFiles({ name: "canva-a4.png", mimeType: "image/png", buffer: png });
  await dialog.getByLabel("การจัดภาพพื้นหลัง").selectOption("cover"); await dialog.getByRole("button", { name: "สร้างแบบร่างจากไฟล์นี้" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/templates/${importedTemplateId}$`));
  const definition = importedDefinition as { page: { width: number; height: number }; elements: Array<Record<string, unknown>> };
  expect(definition.page.width).toBeCloseTo(1122.52, 1); expect(definition.page.height).toBeCloseTo(793.7, 1);
  expect(definition.page.width).not.toBe(3508); expect(definition.elements[0]).toMatchObject({ type: "image", x: 0, y: 0,
    width: definition.page.width, height: definition.page.height, asset_id: importedAssetId, fit: "cover" });
  expect(definition.elements[1]).toMatchObject({ type: "text", binding: "recipient.display_name" });
  await expect(page.locator("img[src^='blob:']")).toBeVisible();
  await page.getByRole("button", { name: /พื้นหลัง/ }).first().click(); await expect(page.getByRole("button", { name: "ปลดล็อกพื้นหลัง" })).toBeVisible();
});

test("image and signature pickers require an explicit asset and support active inline upload", async ({ page }) => {
  await routeSession(page); const uploadedId = "20000000-0000-4000-8000-000000000017";
  const reactKeyWarnings: string[] = []; page.on("console", (message) => { if (["warning", "error"].includes(message.type()) && message.text().includes("unique \"key\" prop")) reactKeyWarnings.push(message.text()); });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  let currentAssets = [asset(imageAssetId, "background.png", "image/png"), asset(secondImageAssetId, "logo-b.png", "image/png")];
  const backgroundDefinition = { ...baseDefinition, elements: [
    { type: "image" as const, x: 0, y: 0, width: 1123, height: 794, opacity: 1, asset_id: imageAssetId, fit: "cover" as const },
    ...baseDefinition.elements
  ] };
  await page.route("**/api/admin/templates**", async (route) => {
    const path = new URL(route.request().url()).pathname; const method = route.request().method();
    if (path === `/api/admin/templates/${templateId}`) return fulfillJson(route, { data: template(), meta: { request_id: requestId } });
    if (path.endsWith("/versions")) return fulfillJson(route, { data: [version(versionDraftId, 3, "DRAFT", backgroundDefinition)], meta: { request_id: requestId, next_cursor: null } });
    if (path.endsWith("/assets") && method === "GET") return fulfillJson(route, { data: currentAssets, meta: { request_id: requestId, next_cursor: null } });
    if (path.endsWith("/assets") && method === "POST") { const uploaded = asset(uploadedId, "uploaded-signature.png", "image/png"); currentAssets = [uploaded, ...currentAssets]; return fulfillJson(route, { data: uploaded, meta: { request_id: requestId } }, 201); }
    if (path.endsWith("/content")) return route.fulfill({ status: 200, body: png, contentType: "image/png" });
    return fulfillJson(route, {}, 404);
  });
  await page.goto(`/admin/templates/${templateId}`);
  await page.getByRole("button", { name: "เพิ่มรูปภาพ" }).click(); const picker = page.getByRole("dialog", { name: "เลือกรูปภาพ" });
  await expect(picker.getByText("ใช้อยู่เป็นพื้นหลัง")).toBeVisible(); await expect(page.getByLabel("ไฟล์รูปภาพ")).toHaveCount(0);
  await picker.getByRole("option", { name: "เลือก logo-b.png" }).click(); await expect(picker.getByRole("option", { name: "เลือก logo-b.png" })).toHaveAttribute("aria-selected", "true");
  await picker.getByRole("button", { name: "ใช้รูปที่เลือก" }).click(); await expect(page.getByLabel("ไฟล์รูปภาพ")).toHaveValue(secondImageAssetId);
  await page.getByRole("button", { name: "เพิ่มลายเซ็น" }).click(); await page.getByLabel("อัปโหลดรูปใหม่จากตัวเลือก").setInputFiles({ name: "uploaded-signature.png", mimeType: "image/png", buffer: png });
  await expect(page.getByRole("dialog", { name: "เลือกรูปลายเซ็น" })).toHaveCount(0); await expect(page.getByLabel("ไฟล์ลายเซ็น")).toHaveValue(uploadedId);
  await expect(page.getByText("มีการแก้ไขที่ยังไม่ได้บันทึก")).toBeVisible(); expect(reactKeyWarnings).toEqual([]);
});

test("empty image picker creates no element and offers inline upload", async ({ page }) => {
  await routeSession(page); await page.route("**/api/admin/templates**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/admin/templates/${templateId}`) return fulfillJson(route, { data: template(), meta: { request_id: requestId } });
    if (path.endsWith("/versions")) return fulfillJson(route, { data: [version(versionDraftId, 3, "DRAFT")], meta: { request_id: requestId, next_cursor: null } });
    if (path.endsWith("/assets")) return fulfillJson(route, { data: [], meta: { request_id: requestId, next_cursor: null } });
    return fulfillJson(route, {}, 404);
  });
  await page.goto(`/admin/templates/${templateId}`); await page.getByRole("button", { name: "เพิ่มรูปภาพ" }).click();
  const picker = page.getByRole("dialog", { name: "เลือกรูปภาพ" }); await expect(picker.getByText("ยังไม่มีรูปภาพที่พร้อมใช้งาน")).toBeVisible();
  await expect(picker.getByRole("button", { name: "อัปโหลดรูปภาพ" })).toBeVisible(); await expect(page.getByLabel("ไฟล์รูปภาพ")).toHaveCount(0);
});

test("Delete and Backspace edit the local draft without breaking form controls or locked backgrounds", async ({ page }) => {
  await routeSession(page); let saved = { ...baseDefinition, elements: [
    { type: "image" as const, x: 0, y: 0, width: 1123, height: 794, opacity: 1, asset_id: imageAssetId, fit: "cover" as const },
    { ...baseDefinition.elements[0], text: undefined },
    { type: "qr" as const, x: 900, y: 620, width: 100, height: 100, opacity: 1, binding: "verification_url" as const, foreground: "#000000", background: "#FFFFFF" }
  ] };
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await page.route("**/api/admin/templates**", async (route) => { const path = new URL(route.request().url()).pathname; const method = route.request().method();
    if (path === `/api/admin/templates/${templateId}`) return fulfillJson(route, { data: template(), meta: { request_id: requestId } });
    if (path.endsWith("/versions") && method === "GET") return fulfillJson(route, { data: [version(versionDraftId, 3, "DRAFT", saved)], meta: { request_id: requestId, next_cursor: null } });
    if (path.endsWith(`/versions/${versionDraftId}`) && method === "PATCH") { saved = (route.request().postDataJSON() as { definition: typeof saved }).definition; return fulfillJson(route, { data: version(versionDraftId, 3, "DRAFT", saved), meta: { request_id: requestId } }); }
    if (path.endsWith("/assets")) return fulfillJson(route, { data: [asset(imageAssetId, "background.png", "image/png")], meta: { request_id: requestId, next_cursor: null } });
    if (path.endsWith("/content")) return route.fulfill({ status: 200, body: png, contentType: "image/png" }); return fulfillJson(route, {}, 404);
  });
  await page.goto(`/admin/templates/${templateId}`);
  await page.getByRole("button", { name: /ข้อความ —/ }).first().click(); await page.getByLabel("ขนาดตัวอักษร").focus(); await page.keyboard.press("Delete");
  await expect(page.getByRole("button", { name: /ข้อความ —/ })).toHaveCount(2);
  const textInput = page.getByLabel("ข้อมูลที่แสดง"); await textInput.focus(); await page.keyboard.press("Backspace"); await expect(page.getByRole("button", { name: /ข้อความ —/ })).toHaveCount(2);
  await page.getByRole("button", { name: "QR Code — ลิงก์ตรวจสอบ", exact: true }).click(); await page.keyboard.press("Backspace"); await expect(page.getByRole("button", { name: "QR Code — ลิงก์ตรวจสอบ", exact: true })).toHaveCount(0);
  const backgroundLayer = page.getByRole("button", { name: "พื้นหลัง — background.png", exact: true }); await backgroundLayer.click(); await page.keyboard.press("Delete"); await expect(backgroundLayer).toHaveCount(1); await expect(page.getByText("ปลดล็อกพื้นหลังก่อนลบ")).toBeVisible();
  await page.getByRole("button", { name: /ข้อความ —/ }).first().click(); await page.keyboard.press("Delete"); await expect(page.getByText("มีการแก้ไขที่ยังไม่ได้บันทึก")).toBeVisible();
  await page.getByRole("button", { name: "บันทึกแบบร่าง" }).click(); expect(saved.elements).toHaveLength(1); await page.reload(); await expect(page.getByRole("button", { name: "พื้นหลัง — background.png", exact: true })).toHaveCount(1);
});

test("reorder and duplication preserve logical selection through editor-only identities", async ({ page }) => {
  await routeSession(page); const distinct = { ...baseDefinition, elements: [
    { ...baseDefinition.elements[0], x: 100, width: 400, binding: "recipient.display_name" as const },
    { ...baseDefinition.elements[0], x: 200, width: 400, binding: "training.name" as const },
    { ...baseDefinition.elements[0], x: 300, width: 400, binding: "project.name" as const }
  ] };
  await page.route("**/api/admin/templates**", async (route) => { const path = new URL(route.request().url()).pathname;
    if (path === `/api/admin/templates/${templateId}`) return fulfillJson(route, { data: template(), meta: { request_id: requestId } });
    if (path.endsWith("/versions")) return fulfillJson(route, { data: [version(versionDraftId, 3, "DRAFT", distinct)], meta: { request_id: requestId, next_cursor: null } });
    if (path.endsWith("/assets")) return fulfillJson(route, { data: [], meta: { request_id: requestId, next_cursor: null } }); return fulfillJson(route, {}, 404);
  });
  await page.goto(`/admin/templates/${templateId}`); await page.getByRole("button", { name: /ชื่อการอบรม/ }).first().click(); await expect(page.getByLabel("X", { exact: true })).toHaveValue("200");
  await page.getByRole("button", { name: "นำเลเยอร์ไปด้านหน้า" }).click(); await expect(page.getByLabel("ข้อมูลที่แสดง")).toHaveValue("training.name"); await expect(page.getByLabel("X", { exact: true })).toHaveValue("200");
  await page.keyboard.press("Control+d"); await expect(page.getByLabel("ข้อมูลที่แสดง")).toHaveValue("training.name"); await expect(page.getByLabel("X", { exact: true })).toHaveValue("216");
  await page.keyboard.press("Delete"); await expect(page.getByRole("button", { name: /ชื่อการอบรม/ })).toHaveCount(2);
});

test("template library renders bounded composition thumbnails with safe samples and intentional failures", async ({ page }) => {
  await routeSession(page, ["template:read"]); const portraitId = "20000000-0000-4000-8000-000000000030";
  const emptyId = "20000000-0000-4000-8000-000000000031"; const failedId = "20000000-0000-4000-8000-000000000032";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"); let collectionRequests = 0; let childListRequests = 0;
  const landscape = { ...baseDefinition, elements: [
    { type: "image" as const, x: 0, y: 0, width: 1123, height: 794, opacity: 1, asset_id: imageAssetId, fit: "cover" as const },
    ...baseDefinition.elements,
    { type: "qr" as const, x: 930, y: 620, width: 100, height: 100, opacity: 1, binding: "verification_url" as const, foreground: "#000000", background: "#FFFFFF" }
  ] };
  const portrait = { ...baseDefinition, page: { width: 794, height: 1123, unit: "px" as const }, elements: [
    { ...baseDefinition.elements[0], x: 80, y: 300, width: 634, binding: "training.name" as const }
  ] };
  const failed = { ...baseDefinition, elements: [{ type: "image" as const, x: 0, y: 0, width: 1123, height: 794,
    opacity: 1, asset_id: secondImageAssetId, fit: "contain" as const }] };
  await page.route("**/api/admin/templates**", async (route) => { const path = new URL(route.request().url()).pathname;
    if (path === "/api/admin/templates") { collectionRequests += 1; return fulfillJson(route, { data: [
      templateListItem(templateId, "แบบเผยแพร่แนวนอน", "ACTIVE", { version: 4, status: "PUBLISHED", definition: landscape }),
      templateListItem(portraitId, "แบบร่างแนวตั้ง", "ACTIVE", { version: 2, status: "DRAFT", definition: portrait }),
      templateListItem(emptyId, "แบบยังไม่ออกแบบ", "ACTIVE", null),
      templateListItem(failedId, "แบบไฟล์ขัดข้อง", "ACTIVE", { version: 1, status: "DRAFT", definition: failed })
    ], meta: { request_id: requestId, next_cursor: null } }); }
    if (path.includes("/versions") || path.endsWith("/assets")) { childListRequests += 1; return fulfillJson(route, { data: [], meta: { request_id: requestId, next_cursor: null } }); }
    if (path.includes(secondImageAssetId)) return fulfillJson(route, { error: { code: "SERVICE_UNAVAILABLE", message: "unavailable" }, meta: { request_id: requestId } }, 503);
    if (path.endsWith("/content")) return route.fulfill({ status: 200, body: png, contentType: "image/png" }); return fulfillJson(route, {}, 404);
  });
  await page.goto("/admin/templates"); await expect(page.getByText("นายสมชาย ใจดี")).toBeVisible(); await expect(page.getByText("หลักสูตรอบรมตัวอย่าง")).toBeVisible();
  await expect(page.getByText("ยังไม่ได้ออกแบบ")).toBeVisible(); await expect(page.getByText("ไม่สามารถโหลดตัวอย่าง")).toBeVisible();
  await expect(page.getByText("เวอร์ชัน 4")).toBeVisible(); await expect(page.getByText("เวอร์ชัน 2")).toBeVisible();
  await expect(page.getByText("CERT-0001")).toHaveCount(0); await expect(page.getByText(templateId)).toHaveCount(0); expect(collectionRequests).toBeLessThanOrEqual(2); expect(childListRequests).toBe(0);
  const landscapeSurface = page.getByLabel("เปิดเทมเพลต แบบเผยแพร่แนวนอน").locator("[style*='aspect-ratio']");
  const portraitSurface = page.getByLabel("เปิดเทมเพลต แบบร่างแนวตั้ง").locator("[style*='aspect-ratio']");
  const landscapeBox = await landscapeSurface.boundingBox(); const portraitBox = await portraitSurface.boundingBox();
  expect(landscapeBox!.width / landscapeBox!.height).toBeGreaterThan(1); expect(portraitBox!.width / portraitBox!.height).toBeLessThan(1);
  await page.getByLabel("เปิดเทมเพลต แบบเผยแพร่แนวนอน").click(); await expect(page).toHaveURL(new RegExp(`/admin/templates/${templateId}$`));
});

test("organization switch clears old template thumbnails and read-only cards expose no mutation", async ({ page }) => {
  await routeSession(page, ["template:read"], true); await page.route("**/api/admin/templates**", async (route) => {
    const organization = route.request().headers()["x-organization-id"]; const item = organization === organizationA
      ? templateListItem(templateId, "ภาพตัวอย่างองค์กร A", "ACTIVE", { version: 1, status: "DRAFT", definition: baseDefinition })
      : templateListItem(secondTemplateId, "ภาพตัวอย่างองค์กร B", "ACTIVE", { version: 1, status: "DRAFT", definition: baseDefinition });
    return fulfillJson(route, { data: [item], meta: { request_id: requestId, next_cursor: null } });
  });
  await page.goto("/admin/templates"); await expect(page.getByText("ภาพตัวอย่างองค์กร A", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "เปลี่ยนชื่อ" })).toHaveCount(0); await page.locator("#active-organization").selectOption(membershipB);
  await expect(page.getByText("ภาพตัวอย่างองค์กร A", { exact: true })).toHaveCount(0); await expect(page.getByText("ภาพตัวอย่างองค์กร B", { exact: true })).toBeVisible();
});
