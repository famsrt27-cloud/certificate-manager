import { expect, test, type Route } from "@playwright/test";

const requestId = "00000000-0000-4000-8000-000000000001";
const organizationId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";
const trainingId = "00000000-0000-4000-8000-000000000004";
const jobId = "00000000-0000-4000-8000-000000000005";
const csrfToken = "c".repeat(43);

test("admin creates project/training and previews then confirms a participant import", async ({ page }) => {
  let projectCreated = false;
  let trainingCreated = false;
  let importConfirmed = false;
  await page.route("**/api/admin/auth/session", (route) => route.fulfill({ json: { data: {
    user: { id: "00000000-0000-4000-8000-000000000006", email: "admin@example.invalid" },
    memberships: [{ id: "00000000-0000-4000-8000-000000000007",
      organization: { id: organizationId, name: "Synthetic Organization" }, roles: ["ORG_ADMIN"], permissions: [
        "project:create", "project:read", "training:create", "training:read", "participant:import", "participant:read"
      ] }], csrf_token: csrfToken
  }, meta: { request_id: requestId } } }));
  const projectsHandler = async (route: Route) => {
    expect(route.request().headers()["x-organization-id"]).toBe(organizationId);
    if (route.request().method() === "POST") {
      expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
      projectCreated = true;
      await route.fulfill({ status: 201, json: { data: { id: projectId, name: "Safe Project", slug: "safe-project", status: "ACTIVE" },
        meta: { request_id: requestId } } });
      return;
    }
    await route.fulfill({ json: { data: projectCreated ? [{ id: projectId, name: "Safe Project", slug: "safe-project", status: "ACTIVE" }] : [],
      meta: { request_id: requestId, next_cursor: null } } });
  };
  await page.route("**/api/admin/projects", projectsHandler);
  await page.route("**/api/admin/projects?**", projectsHandler);
  const trainingsHandler = async (route: Route) => {
    if (route.request().method() === "POST") {
      trainingCreated = true;
      await route.fulfill({ status: 201, json: { data: { id: trainingId, project_id: projectId, name: "Safe Training",
        code: "SAFE-1", start_date: null, end_date: null, status: "ACTIVE" }, meta: { request_id: requestId } } });
      return;
    }
    await route.fulfill({ json: { data: trainingCreated ? [{ id: trainingId, project_id: projectId, name: "Safe Training",
      code: "SAFE-1", start_date: null, end_date: null, status: "ACTIVE" }] : [], meta: { request_id: requestId, next_cursor: null } } });
  };
  await page.route("**/api/admin/trainings", trainingsHandler);
  await page.route("**/api/admin/trainings?**", trainingsHandler);
  await page.route("**/api/admin/participants", (route) => route.fulfill({ json: {
    data: [], meta: { request_id: requestId, next_cursor: null }
  } }));
  await page.route("**/api/admin/participants?**", (route) => route.fulfill({ json: {
    data: [], meta: { request_id: requestId, next_cursor: null }
  } }));
  await page.route(`**/api/admin/trainings/${trainingId}/participants/import`, async (route) => {
    expect(route.request().headers()["idempotency-key"]).toBeTruthy();
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    await route.fulfill({ status: 202, json: { data: { job_id: jobId, status: "QUEUED" }, meta: { request_id: requestId } } });
  });
  await page.route(`**/api/admin/participant-imports/${jobId}`, (route) => route.fulfill({ json: { data: {
    job_id: jobId, status: "AWAITING_CONFIRMATION", progress: { completed: 1, total: 1 }, counts: { valid: 1, invalid: 0 },
    preview: [{ row_number: 2, display_name: "Synthetic Person", external_reference: "REF-1", status: "VALID", validation_errors: [] }]
  }, meta: { request_id: requestId, next_cursor: null } } }));
  await page.route(`**/api/admin/participant-imports/${jobId}?**`, (route) => route.fulfill({ json: { data: {
    job_id: jobId, status: importConfirmed ? "SUCCEEDED" : "AWAITING_CONFIRMATION", progress: { completed: 1, total: 1 }, counts: { valid: 1, invalid: 0 },
    preview: importConfirmed ? [] : [{ row_number: 2, display_name: "Synthetic Person", external_reference: "REF-1", status: "VALID", validation_errors: [] }]
  }, meta: { request_id: requestId, next_cursor: null } } }));
  await page.route(`**/api/admin/participant-imports/${jobId}/confirm`, (route) => { importConfirmed = true; return route.fulfill({ status: 202, json: {
    data: { job_id: jobId, status: "QUEUED" }, meta: { request_id: requestId }
  } }); });

  await page.goto("/admin/projects");
  await page.getByRole("button", { name: "สร้างโครงการ", exact: true }).first().click();
  const projectDialog = page.getByRole("dialog", { name: "สร้างโครงการใหม่" });
  await projectDialog.getByLabel("ชื่อโครงการ").fill("Safe Project");
  await projectDialog.getByLabel("slug").fill("safe-project");
  await projectDialog.getByRole("button", { name: "สร้างโครงการ" }).click();
  await expect(page.getByRole("region", { name: "รายการโครงการ" }).locator(':text-is("Safe Project"):visible').first()).toBeVisible();

  await page.goto("/admin/trainings");
  await page.getByRole("button", { name: "เพิ่มการอบรม", exact: true }).first().click();
  const trainingDialog = page.getByRole("dialog", { name: "เพิ่มการอบรม" });
  await trainingDialog.getByLabel("โครงการ").selectOption(projectId);
  await trainingDialog.getByLabel("ชื่อการอบรม").fill("Safe Training");
  await trainingDialog.getByLabel("รหัสการอบรม").fill("SAFE-1");
  await trainingDialog.getByRole("button", { name: "เพิ่มการอบรม" }).click();
  await expect(page.getByRole("region", { name: "รายการการอบรม" }).locator(':text-is("Safe Training"):visible').first()).toBeVisible();

  await page.goto("/admin/participants");
  await page.getByRole("button", { name: "นำเข้าผู้เข้าร่วม", exact: true }).first().click();
  const participantImport = page.getByRole("dialog", { name: "นำเข้าผู้เข้าร่วม" });
  await participantImport.getByLabel("การอบรม").selectOption(trainingId);
  await participantImport.getByLabel("ไฟล์รายชื่อ CSV หรือ XLSX").setInputFiles({ name: "participants.csv", mimeType: "text/csv",
    buffer: Buffer.from("display_name,external_reference\nSynthetic Person,REF-1\n") });
  await participantImport.getByRole("button", { name: "อัปโหลดและตรวจสอบ" }).click();
  await expect(participantImport.locator("td:visible, p:visible", { hasText: "Synthetic Person" }).first()).toBeVisible();
  await participantImport.getByRole("button", { name: "ยืนยันการนำเข้า" }).click();
  await expect(participantImport.getByText("นำเข้าผู้เข้าร่วมเรียบร้อยแล้ว")).toBeVisible();
});
