import { expect, test, type Page, type Route } from "@playwright/test";

const requestId = "30000000-0000-4000-8000-000000000001";
const organizationA = "30000000-0000-4000-8000-000000000002"; const organizationB = "30000000-0000-4000-8000-000000000003";
const membershipA = "30000000-0000-4000-8000-000000000004"; const membershipB = "30000000-0000-4000-8000-000000000005";
const projectId = "30000000-0000-4000-8000-000000000006"; const trainingId = "30000000-0000-4000-8000-000000000007";
const templateId = "30000000-0000-4000-8000-000000000008"; const versionId = "30000000-0000-4000-8000-000000000009";
const participantA = "30000000-0000-4000-8000-000000000010"; const participantB = "30000000-0000-4000-8000-000000000011";
const certificateId = "30000000-0000-4000-8000-000000000012"; const jobId = "30000000-0000-4000-8000-000000000013";
const csrfToken = "g".repeat(43);
const managerPermissions = ["project:read", "training:read", "participant:read", "template:read", "certificate:read", "certificate:generate", "certificate:revoke", "certificate:download", "job:read"];
const definition = { format_version: 1, page: { width: 1123, height: 794, unit: "px" }, elements: [{ type: "text", x: 180, y: 300, width: 760, height: 80, opacity: 1, binding: "recipient.display_name", align: "center", color: "#0F172A", font: { family: "Noto Sans Thai", size: 44, weight: 700 } }] };
const training = { id: trainingId, project_id: projectId, name: "การอบรมความปลอดภัยดิจิทัล", code: "SAFE-2026", start_date: "2026-08-20", end_date: "2026-08-21", status: "ACTIVE" };
const publishedTemplate = { id: templateId, name: "เทมเพลตประกาศมาตรฐาน", status: "ACTIVE", preview: { version_id: versionId, version: 3, status: "PUBLISHED", definition } };
const participant = (id: string, name: string, reference: string) => ({ id, display_name: name, external_reference: reference });
const certificate = (status: "AVAILABLE" | "REVOKED" = "AVAILABLE") => ({ id: certificateId, certificate_number: "CERT-2026-001", status,
  recipient_display_name: "ผู้รับใบประกาศตัวอย่าง", project_name: "โครงการทักษะดิจิทัล", training_name: training.name, training_code: training.code,
  training_id: trainingId, issued_at: "2026-08-30T05:00:00.000Z", revoked_at: status === "REVOKED" ? "2026-08-30T06:00:00.000Z" : null,
  revocation_reason: status === "REVOKED" ? "ออกให้ผิดราย" : null });

async function routeSession(page: Page, permissions = managerPermissions, multiple = false) {
  await page.route("**/api/admin/auth/session", (route) => route.fulfill({ json: { data: { user: { id: "30000000-0000-4000-8000-000000000014", email: "certificate-ui@example.invalid" }, memberships: [
    { id: membershipA, organization: { id: organizationA, name: "องค์กรออกใบประกาศ A" }, roles: ["CERTIFICATE_MANAGER"], permissions },
    ...(multiple ? [{ id: membershipB, organization: { id: organizationB, name: "องค์กรอ่านอย่างเดียว B" }, roles: ["VIEWER"], permissions: ["certificate:read"] }] : [])
  ], csrf_token: csrfToken }, meta: { request_id: requestId } } }));
}
async function fulfill(route: Route, data: unknown, status = 200) { await route.fulfill({ status, json: data }); }
async function routeDependencies(page: Page, template = publishedTemplate) {
  await page.route("**/api/admin/projects?**", (route) => fulfill(route, { data: [{ id: projectId, name: "โครงการทักษะดิจิทัล", slug: "digital-skills", status: "ACTIVE" }], meta: { request_id: requestId, next_cursor: null } }));
  await page.route("**/api/admin/trainings?**", (route) => fulfill(route, { data: [training], meta: { request_id: requestId, next_cursor: null } }));
  await page.route("**/api/admin/templates?**", (route) => fulfill(route, { data: [template], meta: { request_id: requestId, next_cursor: null } }));
}

test("generates ALL_ELIGIBLE with one stable key, follows real progress, and refreshes AVAILABLE rows", async ({ page }) => {
  await routeSession(page); await routeDependencies(page); let generated = false; let generationBody: unknown; let generationKey = ""; let jobReads = 0;
  await page.route("**/api/admin/certificates?**", (route) => fulfill(route, { data: generated ? [certificate()] : [], meta: { request_id: requestId, next_cursor: null } }));
  await page.route(`**/api/admin/trainings/${trainingId}/certificates/generate`, async (route) => { generationBody = route.request().postDataJSON(); generationKey = route.request().headers()["idempotency-key"] ?? ""; await fulfill(route, { data: { job_id: jobId, status: "QUEUED" }, meta: { request_id: requestId } }, 202); });
  await page.route(`**/api/admin/jobs/${jobId}`, (route) => { jobReads += 1; generated = jobReads > 1; return fulfill(route, { data: { job_id: jobId, type: "CERTIFICATE_GENERATION", status: generated ? "SUCCEEDED" : "RUNNING", progress: { completed: generated ? 1 : 0, total: 1 }, attempt_count: 1, error_code: null }, meta: { request_id: requestId } }); });
  await page.goto("/admin/certificates"); await page.locator("#generation-training").selectOption(trainingId); await page.getByRole("button", { name: /เทมเพลตประกาศมาตรฐาน/ }).click();
  await page.getByRole("button", { name: "สร้างใบประกาศ" }).click(); expect(generationBody).toEqual({ template_version_id: versionId }); expect(generationKey.length).toBeGreaterThanOrEqual(8);
  await expect(page.getByRole("heading", { name: "สำเร็จ" })).toBeVisible({ timeout: 8_000 }); await expect(page.getByText("CERT-2026-001").first()).toBeVisible(); await expect(page.locator("span", { hasText: "พร้อมใช้งาน" }).filter({ hasText: /^พร้อมใช้งาน$/ }).first()).toBeVisible();
});

test("keeps explicit selections across participant cursor pages and submits exact IDs", async ({ page }) => {
  await routeSession(page); await routeDependencies(page); let body: { participant_ids?: string[] } | undefined;
  await page.route("**/api/admin/certificates?**", (route) => fulfill(route, { data: [], meta: { request_id: requestId, next_cursor: null } }));
  await page.route("**/api/admin/participants?**", (route) => { const next = new URL(route.request().url()).searchParams.has("cursor"); return fulfill(route, { data: [next ? participant(participantB, "ผู้รับหน้าสอง", "REF-B") : participant(participantA, "ผู้รับหน้าแรก", "REF-A")], meta: { request_id: requestId, next_cursor: next ? null : "participant-page-2" } }); });
  await page.route(`**/api/admin/trainings/${trainingId}/certificates/generate`, (route) => { body = route.request().postDataJSON() as { participant_ids?: string[] }; return fulfill(route, { data: { job_id: jobId, status: "SUCCEEDED" }, meta: { request_id: requestId } }, 202); });
  await page.goto("/admin/certificates"); await page.locator("#generation-training").selectOption(trainingId); await page.getByRole("button", { name: /เทมเพลตประกาศมาตรฐาน/ }).click(); await page.getByText("เลือกผู้เข้าร่วมเอง").click();
  await page.getByLabel("เลือก ผู้รับหน้าแรก").check(); await page.getByRole("button", { name: "ถัดไป" }).first().click(); await page.getByLabel("เลือก ผู้รับหน้าสอง").check();
  await expect(page.getByText("2 คนที่เลือก")).toBeVisible(); await page.getByRole("button", { name: "สร้างใบประกาศ" }).click(); expect(body?.participant_ids?.sort()).toEqual([participantA, participantB].sort());
});

test("keeps read-only memberships calm without generation or revoke controls", async ({ page }) => {
  await routeSession(page, ["certificate:read"]); await page.route("**/api/admin/certificates?**", (route) => fulfill(route, { data: [certificate()], meta: { request_id: requestId, next_cursor: null } }));
  await page.goto("/admin/certificates"); await expect(page.getByText("CERT-2026-001").first()).toBeVisible(); await expect(page.getByRole("heading", { name: "สร้างใบประกาศชุดใหม่" })).toHaveCount(0); await expect(page.getByRole("button", { name: "เพิกถอน" })).toHaveCount(0); await expect(page.getByRole("button", { name: "ดูใบประกาศ" })).toHaveCount(0); await expect(page.getByRole("button", { name: /ดาวน์โหลด/ })).toHaveCount(0);
});

test("views the actual AVAILABLE application/pdf in a new tab through tenant-aware admin fetch", async ({ page }) => {
  await routeSession(page); await routeDependencies(page);
  await page.route("**/api/admin/certificates?**", (route) => fulfill(route, { data: [certificate()], meta: { request_id: requestId, next_cursor: null } }));
  let disposition = ""; let selectedTenant = "";
  await page.route(`**/api/admin/certificates/${certificateId}/pdf?disposition=inline`, async (route) => {
    disposition = new URL(route.request().url()).searchParams.get("disposition") ?? "";
    selectedTenant = route.request().headers()["x-organization-id"] ?? "";
    await route.fulfill({ status: 200, contentType: "application/pdf", headers: { "Content-Disposition": "inline; filename=\"certificate-CERT-2026-001.pdf\"" }, body: "%PDF-1.7\nsynthetic certificate\n%%EOF" });
  });
  await page.goto("/admin/certificates"); const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "ดูใบประกาศ" }).first().click(); const popup = await popupPromise;
  await expect.poll(() => disposition).toBe("inline"); expect(selectedTenant).toBe(organizationA); expect(popup.isClosed()).toBe(false);
});

test("downloads the actual AVAILABLE PDF with a safe certificate-number filename", async ({ page }) => {
  await routeSession(page); await routeDependencies(page);
  await page.route("**/api/admin/certificates?**", (route) => fulfill(route, { data: [certificate()], meta: { request_id: requestId, next_cursor: null } }));
  await page.route(`**/api/admin/certificates/${certificateId}/pdf?disposition=attachment`, (route) => route.fulfill({ status: 200,
    contentType: "application/pdf", headers: { "Content-Disposition": "attachment; filename=\"certificate-CERT-2026-001.pdf\"" }, body: "%PDF-1.7\nsynthetic certificate\n%%EOF" }));
  await page.goto("/admin/certificates"); const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "ดาวน์โหลด PDF" }).first().click(); const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("certificate-CERT-2026-001.pdf");
});

test("does not offer or retrieve PDFs for REVOKED certificates", async ({ page }) => {
  await routeSession(page); let pdfRequests = 0;
  await page.route("**/api/admin/certificates?**", (route) => fulfill(route, { data: [certificate("REVOKED")], meta: { request_id: requestId, next_cursor: null } }));
  await page.route(`**/api/admin/certificates/${certificateId}/pdf?**`, (route) => { pdfRequests += 1; return route.fulfill({ status: 404 }); });
  await page.goto("/admin/certificates"); await expect(page.getByRole("button", { name: "ดูใบประกาศ" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /ดาวน์โหลด/ })).toHaveCount(0); expect(pdfRequests).toBe(0);
});

test("never offers a draft template for certificate generation", async ({ page }) => {
  await routeSession(page); await routeDependencies(page, { ...publishedTemplate, preview: { ...publishedTemplate.preview, version_id: undefined, status: "DRAFT" } });
  await page.route("**/api/admin/certificates?**", (route) => fulfill(route, { data: [], meta: { request_id: requestId, next_cursor: null } }));
  await page.goto("/admin/certificates"); await expect(page.getByText("ยังไม่มีเทมเพลตที่เผยแพร่แล้ว")).toBeVisible();
  await expect(page.getByRole("button", { name: /เทมเพลตประกาศมาตรฐาน/ })).toHaveCount(0); await expect(page.getByRole("button", { name: "สร้างใบประกาศ" })).toBeDisabled();
});

test("revokes an AVAILABLE certificate with a meaningful reason and shows backend REVOKED truth", async ({ page }) => {
  await routeSession(page); await routeDependencies(page); let revoked = false; let reason = "";
  await page.route("**/api/admin/certificates?**", (route) => fulfill(route, { data: [certificate(revoked ? "REVOKED" : "AVAILABLE")], meta: { request_id: requestId, next_cursor: null } }));
  await page.route(`**/api/admin/certificates/${certificateId}/revoke`, (route) => { reason = (route.request().postDataJSON() as { reason: string }).reason; revoked = true; return fulfill(route, { data: certificate("REVOKED"), meta: { request_id: requestId } }); });
  await page.goto("/admin/certificates"); await page.getByRole("button", { name: "เพิกถอน" }).first().click(); const dialog = page.getByRole("dialog", { name: "ยืนยันการเพิกถอนใบประกาศ" });
  await dialog.getByLabel("เหตุผลการเพิกถอน").fill("ออกใบประกาศให้ผู้รับผิดราย"); await dialog.getByRole("button", { name: "ยืนยันเพิกถอน" }).click(); expect(reason).toBe("ออกใบประกาศให้ผู้รับผิดราย"); await expect(page.locator("span", { hasText: "เพิกถอนแล้ว" }).filter({ hasText: /^เพิกถอนแล้ว$/ }).first()).toBeVisible();
});

test("clears tenant-bound generation state and rows on organization switch", async ({ page }) => {
  await routeSession(page, managerPermissions, true); await routeDependencies(page);
  await page.route("**/api/admin/certificates?**", (route) => { const organization = route.request().headers()["x-organization-id"]; return fulfill(route, { data: organization === organizationA ? [certificate()] : [], meta: { request_id: requestId, next_cursor: null } }); });
  await page.goto("/admin/certificates"); await page.locator("#generation-training").selectOption(trainingId); await expect(page.getByText("CERT-2026-001").first()).toBeVisible();
  await page.locator("#active-organization").selectOption(membershipB); await expect(page.getByText("CERT-2026-001")).toHaveCount(0); await expect(page.getByRole("heading", { name: "สร้างใบประกาศชุดใหม่" })).toHaveCount(0);
});

for (const width of [375, 768, 1280, 1440]) test(`has no page-level overflow at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await routeSession(page); await routeDependencies(page); await page.route("**/api/admin/certificates?**", (route) => fulfill(route, { data: [certificate()], meta: { request_id: requestId, next_cursor: null } }));
  await page.goto("/admin/certificates"); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
