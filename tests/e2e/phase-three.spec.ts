import { expect, test } from "@playwright/test";

const requestId = "00000000-0000-4000-8000-000000000001";
const organizationId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";
const trainingId = "00000000-0000-4000-8000-000000000004";
const jobId = "00000000-0000-4000-8000-000000000005";
const csrfToken = "c".repeat(43);

test("admin creates project/training and previews then confirms a participant import", async ({ page }) => {
  let projectCreated = false;
  let trainingCreated = false;
  await page.route("**/api/admin/auth/session", (route) => route.fulfill({ json: { data: {
    user: { id: "00000000-0000-4000-8000-000000000006", email: "admin@example.invalid" },
    memberships: [{ id: "00000000-0000-4000-8000-000000000007",
      organization: { id: organizationId, name: "Synthetic Organization" }, roles: ["ORG_ADMIN"], permissions: [
        "project:create", "project:read", "training:create", "training:read", "participant:import", "participant:read"
      ] }], csrf_token: csrfToken
  }, meta: { request_id: requestId } } }));
  await page.route("**/api/admin/projects", async (route) => {
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
  });
  await page.route("**/api/admin/trainings", async (route) => {
    if (route.request().method() === "POST") {
      trainingCreated = true;
      await route.fulfill({ status: 201, json: { data: { id: trainingId, project_id: projectId, name: "Safe Training",
        code: "SAFE-1", start_date: null, end_date: null, status: "ACTIVE" }, meta: { request_id: requestId } } });
      return;
    }
    await route.fulfill({ json: { data: trainingCreated ? [{ id: trainingId, project_id: projectId, name: "Safe Training",
      code: "SAFE-1", start_date: null, end_date: null, status: "ACTIVE" }] : [], meta: { request_id: requestId, next_cursor: null } } });
  });
  await page.route("**/api/admin/participants", (route) => route.fulfill({ json: {
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
  await page.route(`**/api/admin/participant-imports/${jobId}/confirm`, (route) => route.fulfill({ status: 202, json: {
    data: { job_id: jobId, status: "QUEUED" }, meta: { request_id: requestId }
  } }));

  await page.goto("/admin");
  const projects = page.getByRole("region", { name: "Projects" });
  await projects.getByLabel("Name").fill("Safe Project");
  await projects.getByLabel("Slug").fill("safe-project");
  await projects.getByRole("button", { name: "Create project" }).click();
  await expect(projects.getByText("Safe Project")).toBeVisible();

  const trainings = page.getByRole("region", { name: "Trainings" });
  await trainings.getByLabel("Project").selectOption(projectId);
  await trainings.getByLabel("Name").fill("Safe Training");
  await trainings.getByLabel("Code").fill("SAFE-1");
  await trainings.getByRole("button", { name: "Create training" }).click();
  await expect(trainings.getByText("Safe Training")).toBeVisible();

  const participantImport = page.getByRole("region", { name: "Participant import" });
  await participantImport.getByLabel("Training").selectOption(trainingId);
  await participantImport.getByLabel("File").setInputFiles({ name: "participants.csv", mimeType: "text/csv",
    buffer: Buffer.from("display_name,external_reference\nSynthetic Person,REF-1\n") });
  await participantImport.getByRole("button", { name: "Upload and validate" }).click();
  await participantImport.getByRole("button", { name: "Refresh preview" }).click();
  await expect(participantImport.getByText("Synthetic Person")).toBeVisible();
  await participantImport.getByRole("button", { name: "Confirm import" }).click();
  await expect(page.getByText("Import confirmed and queued.")).toBeVisible();
});
