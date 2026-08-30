import { expect, test, type Page, type Route } from "@playwright/test";

const requestId = "10000000-0000-4000-8000-000000000001";
const organizationA = "10000000-0000-4000-8000-000000000002";
const organizationB = "10000000-0000-4000-8000-000000000003";
const projectA = "10000000-0000-4000-8000-000000000010";
const projectB = "10000000-0000-4000-8000-000000000011";
const trainingA = "10000000-0000-4000-8000-000000000020";
const csrfToken = "p".repeat(43);
const managementPermissions = ["project:create", "project:read", "project:update", "project:archive", "training:create", "training:read", "training:update", "training:archive"];
const project = (id = projectA, name = "โครงการพัฒนาทักษะดิจิทัล", status = "ACTIVE") => ({ id, name, slug: id === projectA ? "digital-skills" : "leadership", status });
const training = (overrides = {}) => ({ id: trainingA, project_id: projectA, name: "การอบรมความปลอดภัยข้อมูล", code: "SEC-2026", start_date: "2026-09-01", end_date: "2026-09-03", status: "ACTIVE", ...overrides });

const session = (permissions: string[], multiple = false) => ({ data: {
  user: { id: "10000000-0000-4000-8000-000000000004", email: "product@example.invalid" },
  memberships: [{ id: "10000000-0000-4000-8000-000000000005", organization: { id: organizationA, name: "องค์กรหนึ่ง" }, roles: ["ORG_ADMIN"], permissions },
    ...(multiple ? [{ id: "10000000-0000-4000-8000-000000000006", organization: { id: organizationB, name: "องค์กรสอง" }, roles: ["VIEWER"], permissions: ["project:read", "training:read"] }] : [])],
  csrf_token: csrfToken
}, meta: { request_id: requestId } });

const routeSession = async (page: Page, permissions = managementPermissions, multiple = false) => {
  await page.route("**/api/admin/auth/session", (route) => route.fulfill({ json: session(permissions, multiple) }));
};
const list = (data: unknown[], next_cursor: string | null = null) => ({ data, meta: { request_id: requestId, next_cursor } });
const assertWriteHeaders = (route: Route) => {
  expect(route.request().headers()["x-organization-id"]).toBe(organizationA);
  expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
};

test("projects support empty state, validation, creation, filtering, cursor pagination, editing and archive confirmation", async ({ page }) => {
  await routeSession(page);
  let projects = [] as ReturnType<typeof project>[];
  let pageTwo = false;
  await page.route("**/api/admin/projects?**", async (route) => {
    const url = new URL(route.request().url());
    expect(route.request().headers()["x-organization-id"]).toBe(organizationA);
    if (url.searchParams.get("cursor") === "next-projects") { pageTwo = true; await route.fulfill({ json: list([project(projectB, "โครงการผู้นำรุ่นใหม่")]) }); return; }
    const status = url.searchParams.get("status");
    await route.fulfill({ json: list(status === "ARCHIVED" ? projects.filter((item) => item.status === "ARCHIVED") : projects, projects.length > 0 ? "next-projects" : null) });
  });
  await page.route("**/api/admin/projects", async (route) => {
    if (route.request().method() !== "POST") { await route.fallback(); return; }
    assertWriteHeaders(route); const body = route.request().postDataJSON(); expect(body).toEqual({ name: "Digital Skills 2026", slug: "digital-skills-2026" });
    projects = [project(projectA, body.name)]; await route.fulfill({ status: 201, json: { data: projects[0], meta: { request_id: requestId } } });
  });
  await page.route(`**/api/admin/projects/${projectA}`, async (route) => {
    assertWriteHeaders(route); const body = route.request().postDataJSON(); expect(body).toEqual({ name: "Digital Skills Advanced" });
    projects = [{ ...projects[0]!, name: body.name }]; await route.fulfill({ json: { data: projects[0], meta: { request_id: requestId } } });
  });
  await page.route(`**/api/admin/projects/${projectA}/archive`, async (route) => {
    assertWriteHeaders(route); projects = [{ ...projects[0]!, status: "ARCHIVED" }]; await route.fulfill({ json: { data: projects[0], meta: { request_id: requestId } } });
  });

  await page.goto("/admin/projects");
  await expect(page.getByRole("heading", { name: "ยังไม่มีโครงการ" })).toBeVisible();
  await page.getByRole("button", { name: "สร้างโครงการ", exact: true }).first().click();
  const create = page.getByRole("dialog", { name: "สร้างโครงการใหม่" });
  await create.getByLabel("ชื่อโครงการ").fill("โครงการภาษาไทย");
  await create.getByRole("button", { name: "สร้างโครงการ" }).click();
  await expect(create.getByText(/กรุณาระบุ|ตัวพิมพ์เล็ก/)).toBeVisible();
  await create.getByLabel("ชื่อโครงการ").fill("Digital Skills 2026");
  await expect(create.getByLabel("slug")).toHaveValue("digital-skills-2026");
  await create.getByRole("button", { name: "สร้างโครงการ" }).click();
  await expect(page.getByText("สร้างโครงการเรียบร้อยแล้ว")).toBeVisible();
  await page.getByRole("button", { name: "ถัดไป" }).click(); await expect.poll(() => pageTwo).toBe(true);
  await page.getByRole("button", { name: "ก่อนหน้า" }).click();
  await page.getByRole("button", { name: "แก้ไข" }).first().click();
  const edit = page.getByRole("dialog", { name: /แก้ไขโครงการ/ });
  await edit.getByLabel("ชื่อโครงการ").fill("Digital Skills Advanced"); await edit.getByRole("button", { name: "บันทึกการแก้ไข" }).click();
  await page.getByRole("button", { name: "เก็บถาวร" }).first().click();
  const archive = page.getByRole("dialog", { name: "เก็บโครงการถาวร" }); await expect(archive.getByText("Digital Skills Advanced")).toBeVisible();
  await archive.getByRole("button", { name: "ยืนยันเก็บถาวร" }).click();
  await page.getByLabel("สถานะ").selectOption("ARCHIVED"); await expect(page.getByRole("region", { name: "รายการโครงการ" }).locator(':text-is("เก็บถาวร"):visible').first()).toBeVisible();
});

test("trainings explain the project prerequisite and keep project immutable while validating dates", async ({ page }) => {
  await routeSession(page);
  let projectsAvailable = false; let created = false; let archived = false;
  await page.route("**/api/admin/projects?**", (route) => route.fulfill({ json: list(projectsAvailable ? [project(), project(projectB, "โครงการผู้นำรุ่นใหม่", "INACTIVE")] : []) }));
  await page.route("**/api/admin/trainings?**", async (route) => {
    const url = new URL(route.request().url());
    if (created) { expect(url.searchParams.get("project_id") === null || url.searchParams.get("project_id") === projectA).toBeTruthy(); }
    await route.fulfill({ json: list(created ? [training({ status: archived ? "ARCHIVED" : "ACTIVE" })] : []) });
  });
  await page.route("**/api/admin/trainings", async (route) => {
    assertWriteHeaders(route); const body = route.request().postDataJSON(); expect(body.project_id).toBe(projectA); expect(body.start_date).toBe("2026-09-01");
    created = true; await route.fulfill({ status: 201, json: { data: training(), meta: { request_id: requestId } } });
  });
  await page.route(`**/api/admin/trainings/${trainingA}`, async (route) => {
    assertWriteHeaders(route); const body = route.request().postDataJSON(); expect(body.project_id).toBeUndefined(); expect(body).toEqual({ name: "การอบรมฉบับปรับปรุง" });
    await route.fulfill({ json: { data: training({ name: body.name }), meta: { request_id: requestId } } });
  });
  await page.route(`**/api/admin/trainings/${trainingA}/archive`, async (route) => { assertWriteHeaders(route); archived = true; await route.fulfill({ json: { data: training({ status: "ARCHIVED" }), meta: { request_id: requestId } } }); });

  await page.goto("/admin/trainings"); await expect(page.getByText("ต้องสร้างโครงการก่อนจึงจะเพิ่มการอบรมได้")).toBeVisible();
  projectsAvailable = true; await page.reload();
  await page.getByRole("button", { name: "เพิ่มการอบรม", exact: true }).first().click();
  const create = page.getByRole("dialog", { name: "เพิ่มการอบรม" }); await create.getByLabel("โครงการ").selectOption(projectA);
  await create.getByLabel("ชื่อการอบรม").fill("การอบรมความปลอดภัยข้อมูล"); await create.getByLabel("รหัสการอบรม").fill("SEC-2026");
  await create.getByLabel("วันที่เริ่ม").fill("2026-09-03"); await create.getByLabel("วันที่สิ้นสุด").fill("2026-09-01"); await create.getByRole("button", { name: "เพิ่มการอบรม" }).click();
  await expect(create.getByText("วันที่สิ้นสุดต้องไม่มาก่อนวันที่เริ่ม")).toBeVisible();
  await create.getByLabel("วันที่เริ่ม").fill("2026-09-01"); await create.getByLabel("วันที่สิ้นสุด").fill("2026-09-03"); await create.getByRole("button", { name: "เพิ่มการอบรม" }).click();
  await page.getByRole("button", { name: "แก้ไข" }).first().click(); const edit = page.getByRole("dialog", { name: /แก้ไขการอบรม/ });
  await expect(edit.getByText("ไม่สามารถย้ายการอบรมไปยังโครงการอื่นได้")).toBeVisible(); await expect(edit.getByLabel("โครงการ")).toHaveCount(0);
  await edit.getByLabel("ชื่อการอบรม").fill("การอบรมฉบับปรับปรุง"); await edit.getByRole("button", { name: "บันทึกการแก้ไข" }).click();
  await page.getByRole("region", { name: "รายการการอบรม" }).locator("select").first().selectOption(projectA); await page.getByLabel("สถานะ").selectOption("ACTIVE");
  await page.getByRole("button", { name: "เก็บถาวร" }).first().click(); await page.getByRole("dialog", { name: "เก็บการอบรมถาวร" }).getByRole("button", { name: "ยืนยันเก็บถาวร" }).click();
  await expect(page.getByText("เก็บการอบรมถาวรแล้ว")).toBeVisible();
});

test("viewer controls are read-only and project navigation initializes the training filter", async ({ page }) => {
  await routeSession(page, ["project:read", "training:read"]);
  await page.route("**/api/admin/projects?**", (route) => route.fulfill({ json: list([project()]) }));
  await page.route("**/api/admin/trainings?**", (route) => route.fulfill({ json: list([training()]) }));
  await page.goto("/admin/projects"); await expect(page.getByRole("button", { name: "สร้างโครงการ", exact: true })).toHaveCount(0); await expect(page.getByRole("button", { name: "แก้ไข" })).toHaveCount(0);
  await page.getByRole("link", { name: "ดูการอบรม" }).click(); await expect(page).toHaveURL(new RegExp(`project=${projectA}`));
  await expect(page.getByRole("region", { name: "รายการการอบรม" }).locator("select").first()).toHaveValue(projectA); await expect(page.locator(':text-is("การอบรมความปลอดภัยข้อมูล"):visible').first()).toBeVisible(); await expect(page.getByRole("button", { name: "เพิ่มการอบรม", exact: true })).toHaveCount(0);
});

test("organization switching clears stale project rows and closes tenant-bound dialogs", async ({ page }) => {
  await routeSession(page, managementPermissions, true); let releaseB!: () => void; const waitB = new Promise<void>((resolve) => { releaseB = resolve; });
  await page.route("**/api/admin/projects?**", async (route) => { const tenant = route.request().headers()["x-organization-id"]; if (tenant === organizationB) await waitB;
    await route.fulfill({ json: list([project(tenant === organizationA ? projectA : projectB, tenant === organizationA ? "โครงการองค์กรหนึ่ง" : "โครงการองค์กรสอง")]) }); });
  await page.goto("/admin/projects"); await expect(page.getByRole("region", { name: "รายการโครงการ" }).locator(':text-is("โครงการองค์กรหนึ่ง"):visible').first()).toBeVisible(); await page.getByRole("button", { name: "แก้ไข" }).first().click();
  await page.locator("#active-organization").selectOption("10000000-0000-4000-8000-000000000006"); await expect(page.getByRole("dialog")).toHaveCount(0); await expect(page.getByRole("region", { name: "รายการโครงการ" }).getByText("โครงการองค์กรหนึ่ง")).toHaveCount(0);
  releaseB(); await expect(page.getByRole("region", { name: "รายการโครงการ" }).locator(':text-is("โครงการองค์กรสอง"):visible').first()).toBeVisible();
});

for (const width of [375, 768, 1280, 1440]) test(`project and training product UI has no horizontal overflow at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await routeSession(page);
  await page.route("**/api/admin/projects?**", (route) => route.fulfill({ json: list([project(projectA, "โครงการที่มีชื่อภาษาไทยยาวมากเพื่อทดสอบการตัดบรรทัดอย่างปลอดภัย")]) }));
  await page.route("**/api/admin/trainings?**", (route) => route.fulfill({ json: list([training()]) }));
  for (const path of ["/admin/projects", "/admin/trainings"]) { await page.goto(path); await expect(page.locator("h1")).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width); }
});

test("admin product UI uses Noto Sans Thai Looped", async ({ page }) => {
  await routeSession(page);
  await page.route("**/api/admin/projects?**", (route) => route.fulfill({ json: list([]) }));
  await page.goto("/admin/projects");
  await expect(page.getByRole("heading", { name: "โครงการ", exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const typography = await page.evaluate(() => ({
    body: getComputedStyle(document.body).fontFamily,
    button: getComputedStyle(document.querySelector("#main-content button")!).fontFamily,
    loaded: document.fonts.check('16px "Noto Sans Thai Looped"', "โครงการ")
  }));
  expect(typography.body).toContain("Noto Sans Thai Looped");
  expect(typography.button).toContain("Noto Sans Thai Looped");
  expect(typography.loaded).toBe(true);
});
