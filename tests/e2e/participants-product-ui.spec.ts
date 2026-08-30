import { expect, test, type Page } from "@playwright/test";

const requestId = "10000000-0000-4000-8000-000000000001";
const organizationA = "10000000-0000-4000-8000-000000000002";
const organizationB = "10000000-0000-4000-8000-000000000003";
const membershipA = "10000000-0000-4000-8000-000000000004";
const membershipB = "10000000-0000-4000-8000-000000000005";
const projectId = "10000000-0000-4000-8000-000000000006";
const trainingA = "10000000-0000-4000-8000-000000000007";
const trainingB = "10000000-0000-4000-8000-000000000008";
const participantA = "10000000-0000-4000-8000-000000000009";
const participantB = "10000000-0000-4000-8000-000000000010";
const jobId = "10000000-0000-4000-8000-000000000011";
const csrfToken = "p".repeat(43);
const writePermissions = ["training:read", "training:create", "participant:read", "participant:update", "participant:import", "job:read"];

const training = (id: string, name: string) => ({ id, project_id: projectId, name, code: id === trainingA ? "SAFE-A" : "SAFE-B", start_date: null, end_date: null, status: "ACTIVE" });
const session = (permissions = writePermissions, multiple = false) => ({ data: {
  user: { id: "10000000-0000-4000-8000-000000000012", email: "participant-ui@example.invalid" },
  memberships: [{ id: membershipA, organization: { id: organizationA, name: "องค์กรทดสอบ A" }, roles: ["ORG_ADMIN"], permissions },
    ...(multiple ? [{ id: membershipB, organization: { id: organizationB, name: "องค์กรทดสอบ B" }, roles: ["VIEWER"], permissions: ["training:read", "participant:read"] }] : [])],
  csrf_token: csrfToken
}, meta: { request_id: requestId } });

async function routeSession(page: Page, permissions = writePermissions, multiple = false) {
  await page.route("**/api/admin/auth/session", (route) => route.fulfill({ json: session(permissions, multiple) }));
}

async function routeTrainings(page: Page, rows = [training(trainingA, "การอบรมความปลอดภัย")]) {
  await page.route("**/api/admin/trainings?**", (route) => {
    expect(route.request().headers()["x-organization-id"]).toBeTruthy();
    return route.fulfill({ json: { data: rows, meta: { request_id: requestId, next_cursor: null } } });
  });
}

test("lists, paginates, and edits participants without exposing internal identifiers", async ({ page }) => {
  await routeSession(page); await routeTrainings(page);
  let updated = false; let firstPageRequests = 0;
  await page.route("**/api/admin/participants?**", async (route) => {
    const url = new URL(route.request().url()); expect(url.searchParams.get("training_id")).toBe(trainingA);
    if (url.searchParams.has("cursor")) return route.fulfill({ json: { data: [{ id: participantB, display_name: "ผู้เข้าร่วมหน้าถัดไป", external_reference: null }], meta: { request_id: requestId, next_cursor: null } } });
    firstPageRequests += 1;
    return route.fulfill({ json: { data: [{ id: participantA, display_name: updated ? "ผู้เข้าร่วมแก้ไขแล้ว" : "ผู้เข้าร่วมทดสอบ", external_reference: updated ? null : "REF-001" }], meta: { request_id: requestId, next_cursor: "next-participant-page" } } });
  });
  await page.route(`**/api/admin/participants/${participantA}`, async (route) => {
    expect(route.request().method()).toBe("PATCH"); expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({ display_name: "ผู้เข้าร่วมแก้ไขแล้ว", external_reference: null }); updated = true;
    await route.fulfill({ json: { data: { id: participantA, display_name: "ผู้เข้าร่วมแก้ไขแล้ว", external_reference: null }, meta: { request_id: requestId } } });
  });
  await page.goto("/admin/participants");
  await expect(page.getByText("เลือกการอบรมเพื่อดูผู้เข้าร่วม")).toBeVisible();
  await page.getByLabel("การอบรม").selectOption(trainingA);
  await expect(page.locator("td:visible, h3:visible", { hasText: "ผู้เข้าร่วมทดสอบ" }).first()).toBeVisible();
  await expect(page.getByText(participantA)).toHaveCount(0);
  await page.locator("button:visible", { hasText: "แก้ไข" }).first().click();
  const dialog = page.getByRole("dialog", { name: /แก้ไขผู้เข้าร่วม/ });
  await dialog.getByLabel("ชื่อที่แสดง").fill("ผู้เข้าร่วมแก้ไขแล้ว"); await dialog.getByLabel("รหัสอ้างอิง").fill("");
  await dialog.getByRole("button", { name: "บันทึกการแก้ไข" }).click();
  await expect(page.locator("td:visible, h3:visible", { hasText: "ผู้เข้าร่วมแก้ไขแล้ว" }).first()).toBeVisible(); await expect(page.locator("td:visible, p:visible", { hasText: "ไม่ระบุ" }).first()).toBeVisible();
  await page.getByRole("button", { name: "ถัดไป" }).click(); await expect(page.locator("td:visible, h3:visible", { hasText: "ผู้เข้าร่วมหน้าถัดไป" }).first()).toBeVisible();
  await page.getByRole("button", { name: "ก่อนหน้า" }).click(); await expect(page.locator("td:visible, h3:visible", { hasText: "ผู้เข้าร่วมแก้ไขแล้ว" }).first()).toBeVisible(); expect(firstPageRequests).toBeGreaterThanOrEqual(2);
});

test("uploads once, maps validation errors, paginates preview, confirms, and refreshes the selected training", async ({ page }) => {
  await routeSession(page); await routeTrainings(page); let uploadCount = 0; let confirmed = false; let participantLoads = 0; let uploadKey = ""; let confirmKey = "";
  await page.route("**/api/admin/participants?**", (route) => { participantLoads += 1; return route.fulfill({ json: { data: confirmed ? [{ id: participantA, display_name: "ผู้เข้าร่วมใหม่", external_reference: "NEW-001" }] : [], meta: { request_id: requestId, next_cursor: null } } }); });
  await page.route(`**/api/admin/trainings/${trainingA}/participants/import`, async (route) => { uploadCount += 1; uploadKey = route.request().headers()["idempotency-key"] ?? ""; expect(uploadKey.length).toBeGreaterThanOrEqual(8); await new Promise((resolve) => setTimeout(resolve, 150)); await route.fulfill({ status: 202, json: { data: { job_id: jobId, status: "QUEUED" }, meta: { request_id: requestId } } }); });
  await page.route(`**/api/admin/participant-imports/${jobId}?**`, (route) => { const cursor = new URL(route.request().url()).searchParams.get("cursor"); if (cursor !== null) return route.fulfill({ json: { data: { job_id: jobId, status: "AWAITING_CONFIRMATION", progress: { completed: 3, total: 3 }, counts: { valid: 2, invalid: 1 }, preview: [{ row_number: 4, display_name: "ผู้เข้าร่วมใหม่ 2", external_reference: null, status: "VALID", validation_errors: [] }] }, meta: { request_id: requestId, next_cursor: null } } }); return route.fulfill({ json: { data: { job_id: jobId, status: confirmed ? "SUCCEEDED" : "AWAITING_CONFIRMATION", progress: { completed: 3, total: 3 }, counts: { valid: 2, invalid: 1 }, preview: confirmed ? [] : [{ row_number: 2, display_name: "ผู้เข้าร่วมใหม่", external_reference: "NEW-001", status: "VALID", validation_errors: [] }, { row_number: 3, display_name: null, external_reference: "BAD-001", status: "INVALID", validation_errors: [{ code: "DISPLAY_NAME_REQUIRED", field: "display_name" }] }] }, meta: { request_id: requestId, next_cursor: confirmed ? null : "next-preview-page" } } }); });
  await page.route(`**/api/admin/participant-imports/${jobId}/confirm`, async (route) => { confirmKey = route.request().headers()["idempotency-key"] ?? ""; expect(confirmKey.length).toBeGreaterThanOrEqual(8); confirmed = true; await new Promise((resolve) => setTimeout(resolve, 120)); await route.fulfill({ status: 202, json: { data: { job_id: jobId, status: "QUEUED" }, meta: { request_id: requestId } } }); });
  await page.route(`**/api/admin/jobs/${jobId}`, (route) => route.fulfill({ json: { data: { job_id: jobId, type: "PARTICIPANT_IMPORT", status: "SUCCEEDED", progress: { completed: 3, total: 3 }, attempt_count: 1, error_code: null }, meta: { request_id: requestId } } }));
  await page.goto("/admin/participants"); await page.getByLabel("การอบรม").selectOption(trainingA); await expect(page.getByText("ยังไม่มีผู้เข้าร่วมในการอบรมนี้")).toBeVisible();
  await page.getByRole("button", { name: "นำเข้าผู้เข้าร่วม", exact: true }).first().click(); const dialog = page.getByRole("dialog", { name: "นำเข้าผู้เข้าร่วม" });
  await expect(dialog.getByLabel("การอบรม")).toHaveValue(trainingA); await dialog.getByLabel("ไฟล์รายชื่อ CSV หรือ XLSX").setInputFiles({ name: "participants.csv", mimeType: "text/csv", buffer: Buffer.from("display_name,external_reference\nผู้เข้าร่วมใหม่,NEW-001\n,BAD-001\n") });
  const upload = dialog.getByRole("button", { name: "อัปโหลดและตรวจสอบ" }); await upload.dblclick(); await expect(dialog.getByText("รอยืนยัน")).toBeVisible(); expect(uploadCount).toBe(1);
  await expect(dialog.getByText("ถูกต้อง").first()).toBeVisible(); await expect(dialog.getByText("ต้องแก้ไข").first()).toBeVisible(); await expect(dialog.locator("li:visible", { hasText: "ไม่พบชื่อผู้เข้าร่วม" }).first()).toBeVisible();
  await dialog.getByRole("button", { name: "โหลดรายการตัวอย่างเพิ่มเติม" }).click(); await expect(dialog.locator("td:visible, p:visible", { hasText: "ผู้เข้าร่วมใหม่ 2" }).first()).toBeVisible();
  const confirm = dialog.getByRole("button", { name: "ยืนยันการนำเข้า" }); await confirm.dblclick(); await expect(dialog.getByText("นำเข้าผู้เข้าร่วมเรียบร้อยแล้ว")).toBeVisible(); expect(confirmKey).not.toBe("");
  await dialog.getByRole("button", { name: "ดูผู้เข้าร่วมในการอบรมนี้" }).click(); await expect(page.locator("td:visible, h3:visible", { hasText: "ผู้เข้าร่วมใหม่" }).first()).toBeVisible(); expect(participantLoads).toBeGreaterThanOrEqual(2);
});

test("does not append preview row 19 twice when the same cursor page is requested repeatedly", async ({ page }) => {
  await routeSession(page); await routeTrainings(page); const consoleErrors: string[] = []; let secondPageLoads = 0;
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.route("**/api/admin/participants?**", (route) => route.fulfill({ json: { data: [], meta: { request_id: requestId, next_cursor: null } } }));
  await page.route(`**/api/admin/trainings/${trainingA}/participants/import`, (route) => route.fulfill({ status: 202, json: { data: { job_id: jobId, status: "QUEUED" }, meta: { request_id: requestId } } }));
  await page.route(`**/api/admin/participant-imports/${jobId}?**`, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (cursor !== null) { secondPageLoads += 1; await new Promise((resolve) => setTimeout(resolve, 120)); return route.fulfill({ json: { data: { job_id: jobId, status: "AWAITING_CONFIRMATION", progress: { completed: 18, total: 18 }, counts: { valid: 18, invalid: 0 }, preview: [{ row_number: 19, display_name: "แถวที่สิบเก้า", external_reference: "ROW-19", status: "VALID", validation_errors: [] }] }, meta: { request_id: requestId, next_cursor: null } } }); }
    return route.fulfill({ json: { data: { job_id: jobId, status: "AWAITING_CONFIRMATION", progress: { completed: 18, total: 18 }, counts: { valid: 18, invalid: 0 }, preview: [{ row_number: 18, display_name: "แถวที่สิบแปด", external_reference: "ROW-18", status: "VALID", validation_errors: [] }] }, meta: { request_id: requestId, next_cursor: "preview-after-18" } } });
  });
  await page.goto("/admin/participants"); await page.getByRole("button", { name: "นำเข้าผู้เข้าร่วม", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "นำเข้าผู้เข้าร่วม" });
  await dialog.getByLabel("ไฟล์รายชื่อ CSV หรือ XLSX").setInputFiles({ name: "rows.csv", mimeType: "text/csv", buffer: Buffer.from("display_name\nแถวที่สิบเก้า\n") });
  await dialog.getByRole("button", { name: "อัปโหลดและตรวจสอบ" }).click(); await expect(dialog.getByText("แถวที่สิบแปด").first()).toBeVisible();
  const more = dialog.getByRole("button", { name: "โหลดรายการตัวอย่างเพิ่มเติม" });
  await more.evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(dialog.getByText("แถวที่สิบเก้า").first()).toBeVisible();
  expect(secondPageLoads).toBe(1); expect(await dialog.locator("tbody tr", { hasText: "แถวที่สิบเก้า" }).count()).toBe(1);
  expect(await dialog.locator("li", { hasText: "แถวที่สิบเก้า" }).count()).toBe(1);
  expect(consoleErrors.some((message) => message.includes("same key") || message.includes("Encountered two children"))).toBe(false);
});

test("shows role-aware prerequisites and clears an active import when organization changes", async ({ page }) => {
  await routeSession(page, writePermissions, true);
  await page.route("**/api/admin/trainings?**", (route) => { const organization = route.request().headers()["x-organization-id"]; return route.fulfill({ json: { data: organization === organizationA ? [training(trainingA, "การอบรมองค์กร A")] : [], meta: { request_id: requestId, next_cursor: null } } }); });
  await page.route("**/api/admin/participants?**", (route) => route.fulfill({ json: { data: [], meta: { request_id: requestId, next_cursor: null } } }));
  await page.goto("/admin/participants"); await page.getByRole("button", { name: "นำเข้าผู้เข้าร่วม", exact: true }).first().click(); const dialog = page.getByRole("dialog", { name: "นำเข้าผู้เข้าร่วม" });
  await dialog.getByLabel("ไฟล์รายชื่อ CSV หรือ XLSX").setInputFiles({ name: "tenant-a.csv", mimeType: "text/csv", buffer: Buffer.from("display_name\nTenant A Person\n") }); await expect(dialog.getByText("tenant-a.csv")).toBeVisible();
  await page.locator("#active-organization").selectOption(membershipB); await expect(dialog).toHaveCount(0); await expect(page.getByText("องค์กรนี้ยังไม่มีการอบรม")).toBeVisible(); await expect(page.getByRole("button", { name: "นำเข้าผู้เข้าร่วม", exact: true })).toHaveCount(0);
});

test("shows an actionable training prerequisite and keeps read-only participants non-editable", async ({ page }) => {
  await routeSession(page); await routeTrainings(page, []);
  await page.goto("/admin/participants");
  await expect(page.getByText("ต้องมีการอบรมก่อนจึงจะนำเข้าผู้เข้าร่วมได้")).toBeVisible();
  await expect(page.getByRole("link", { name: "ไปที่การอบรม" })).toHaveAttribute("href", "/admin/trainings");

  await page.unrouteAll(); await routeSession(page, ["training:read", "participant:read"]); await routeTrainings(page, [training(trainingB, "การอบรมสำหรับผู้ดูข้อมูล")]);
  await page.route("**/api/admin/participants?**", (route) => route.fulfill({ json: { data: [{ id: participantB, display_name: "ผู้เข้าร่วมแบบอ่านอย่างเดียว", external_reference: null }], meta: { request_id: requestId, next_cursor: null } } }));
  await page.reload(); await page.getByLabel("การอบรม").selectOption(trainingB);
  await expect(page.locator("td:visible, h3:visible", { hasText: "ผู้เข้าร่วมแบบอ่านอย่างเดียว" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "นำเข้าผู้เข้าร่วม", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "แก้ไข", exact: true })).toHaveCount(0);
});

test("accepts an XLSX selection and presents a bounded failed-job result", async ({ page }) => {
  await routeSession(page); await routeTrainings(page);
  await page.route(`**/api/admin/trainings/${trainingA}/participants/import`, (route) => route.fulfill({ status: 202, json: { data: { job_id: jobId, status: "QUEUED" }, meta: { request_id: requestId } } }));
  await page.route(`**/api/admin/participant-imports/${jobId}?**`, (route) => route.fulfill({ json: { data: { job_id: jobId, status: "FAILED", progress: { completed: 0, total: 0 }, counts: { valid: 0, invalid: 0 }, preview: [] }, meta: { request_id: requestId, next_cursor: null } } }));
  await page.route(`**/api/admin/jobs/${jobId}`, (route) => route.fulfill({ json: { data: { job_id: jobId, type: "PARTICIPANT_IMPORT", status: "FAILED", progress: { completed: 0, total: 0 }, attempt_count: 1, error_code: "IMPORT_FILE_INVALID" }, meta: { request_id: requestId } } }));
  await page.goto("/admin/participants"); await page.getByRole("button", { name: "นำเข้าผู้เข้าร่วม", exact: true }).first().click(); const dialog = page.getByRole("dialog", { name: "นำเข้าผู้เข้าร่วม" });
  await dialog.getByLabel("ไฟล์รายชื่อ CSV หรือ XLSX").setInputFiles({ name: "participants.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("synthetic-xlsx-boundary") });
  await expect(dialog.getByText("participants.xlsx")).toBeVisible(); await dialog.getByRole("button", { name: "อัปโหลดและตรวจสอบ" }).click();
  await expect(dialog.getByRole("heading", { name: "ไม่สามารถดำเนินการนำเข้าได้" })).toBeVisible(); await expect(dialog.getByText("ไฟล์ไม่ผ่านการตรวจสอบความถูกต้อง กรุณาเลือกไฟล์ต้นฉบับใหม่")).toBeVisible();
  await expect(dialog.getByText(jobId)).toHaveCount(0);
});

for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 900 }, { width: 1280, height: 900 }, { width: 1440, height: 900 }]) {
  test(`remains usable without page overflow at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport); await routeSession(page); await routeTrainings(page, [training(trainingA, "การอบรมชื่อภาษาไทยที่ยาวสำหรับทดสอบหน้าจอและการตัดบรรทัด")]);
    await page.route("**/api/admin/participants?**", (route) => route.fulfill({ json: { data: [{ id: participantA, display_name: "ชื่อผู้เข้าร่วมภาษาไทยที่ยาวมากเพื่อทดสอบการตัดบรรทัดบนหน้าจอขนาดต่าง ๆ", external_reference: "REFERENCE-WITH-A-VERY-LONG-VALUE-THAT-MUST-WRAP-SAFELY-001" }], meta: { request_id: requestId, next_cursor: null } } }));
    await page.goto("/admin/participants"); await page.getByLabel("การอบรม").selectOption(trainingA); await expect(page.locator("td:visible, h3:visible", { hasText: "ชื่อผู้เข้าร่วมภาษาไทยที่ยาวมาก" }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.getByRole("button", { name: "นำเข้าผู้เข้าร่วม", exact: true }).first().click(); await expect(page.getByRole("dialog", { name: "นำเข้าผู้เข้าร่วม" })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}
