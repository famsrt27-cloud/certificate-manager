import { expect, test, type Page } from "@playwright/test";

const requestId = "00000000-0000-4000-8000-000000000001";
const organizationA = "00000000-0000-4000-8000-000000000002";
const organizationB = "00000000-0000-4000-8000-000000000003";
const allPermissions = ["organization:read", "project:read", "project:create", "training:read", "training:create",
  "participant:read", "participant:import", "template:read", "template:create", "template:publish", "certificate:read", "job:read"];

const session = (permissions: string[], multiple = false) => ({ data: {
  user: { id: "00000000-0000-4000-8000-000000000004", email: "dashboard@example.invalid" },
  memberships: [{ id: "00000000-0000-4000-8000-000000000005",
    organization: { id: organizationA, name: "องค์กรทดสอบที่มีชื่อยาวสำหรับตรวจสอบการจัดวางแดชบอร์ด" },
    roles: ["ORG_ADMIN"], permissions }, ...(multiple ? [{ id: "00000000-0000-4000-8000-000000000006",
    organization: { id: organizationB, name: "องค์กรที่สอง" }, roles: ["VIEWER"], permissions }] : [])],
  csrf_token: "c".repeat(43)
}, meta: { request_id: requestId } });

const populated = { data: {
  projects: { active: 3, total: 4 }, trainings: { active: 6, total: 7 }, participants: { total: 128 },
  templates: { active: 2, published_versions: 1 }, certificates: { available: 42, in_progress: 3, revoked: 2 },
  jobs: { queued: 1, running: 2, failed: 0, dead_letter: 0 }
}, meta: { request_id: requestId } };

const routeSession = async (page: Page, permissions = allPermissions, multiple = false) => {
  await page.route("**/api/admin/auth/session", (route) => route.fulfill({ json: session(permissions, multiple) }));
  for (const resource of ["projects", "trainings", "participants", "templates"]) {
    await page.route(`**/api/admin/${resource}`, (route) => route.fulfill({ json: { data: [], meta: { request_id: requestId, next_cursor: null } } }));
  }
};

test("dashboard is a focused overview with four primary metrics and no legacy management forms", async ({ page }) => {
  await routeSession(page);
  await page.route("**/api/admin/dashboard", async (route) => {
    expect(route.request().headers()["x-organization-id"]).toBe(organizationA);
    await route.fulfill({ json: populated });
  });
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "ภาพรวม", exact: true })).toBeVisible();
  for (const label of ["โครงการ", "การอบรม", "ผู้เข้าร่วม", "ใบประกาศพร้อมใช้"]) await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "ลำดับการเตรียมความพร้อม" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Projects" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Participant import" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Template Builder" })).toHaveCount(0);
});

test("sidebar navigation opens every real route and follows the active path", async ({ page }) => {
  await routeSession(page);
  await page.route("**/api/admin/dashboard", (route) => route.fulfill({ json: populated }));
  await page.goto("/admin");
  const navigation = page.getByRole("navigation", { name: "เมนูหลัก" }).first();
  const routes = [
    ["โครงการ", "/admin/projects"], ["การอบรม", "/admin/trainings"], ["ผู้เข้าร่วม", "/admin/participants"],
    ["เทมเพลต", "/admin/templates"], ["ใบประกาศนียบัตร", "/admin/certificates"], ["ภาพรวม", "/admin"]
  ] as const;
  for (const [label, path] of routes) {
    await navigation.getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path.replaceAll("/", "\\/")}$`));
    await expect(navigation.getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
  }
});

test("empty dashboard attention provides permission-aware route actions", async ({ page }) => {
  await routeSession(page);
  await page.route("**/api/admin/dashboard", (route) => route.fulfill({ json: { data: {
    projects: { active: 0, total: 0 }, trainings: { active: 0, total: 0 }, participants: { total: 0 },
    templates: { active: 0, published_versions: 0 }, certificates: { available: 0, in_progress: 0, revoked: 0 },
    jobs: { queued: 0, running: 0, failed: 0, dead_letter: 0 }
  }, meta: { request_id: requestId } } }));
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "สิ่งที่ควรดำเนินการ" })).toBeVisible();
  await page.getByRole("link", { name: "สร้างโครงการ" }).click();
  await expect(page).toHaveURL(/\/admin\/projects$/);
});

test("dashboard loading error and retry stay inside the authenticated shell", async ({ page }) => {
  await routeSession(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let succeed = false;
  await page.route("**/api/admin/dashboard", async (route) => {
    if (!succeed) await gate;
    if (!succeed) { await route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE", message: "Unavailable" }, meta: { request_id: requestId } } }); return; }
    await route.fulfill({ json: populated });
  });
  await page.goto("/admin");
  await expect(page.locator('[aria-busy="true"]')).toBeVisible();
  release();
  await expect(page.getByRole("heading", { name: "ไม่สามารถโหลดข้อมูลภาพรวมได้" })).toBeVisible();
  succeed = true;
  await page.getByRole("button", { name: "ลองอีกครั้ง" }).click();
  await expect(page.getByText("ใบประกาศพร้อมใช้", { exact: true })).toBeVisible();
});

test("organization switch clears stale dashboard totals", async ({ page }) => {
  await routeSession(page, ["organization:read", "project:read"], true);
  let releaseSecond: (() => void) | undefined;
  await page.route("**/api/admin/dashboard", async (route) => {
    const selected = route.request().headers()["x-organization-id"];
    if (selected === organizationB) await new Promise<void>((resolve) => { releaseSecond = resolve; });
    await route.fulfill({ json: { data: { projects: { active: selected === organizationA ? 11 : 22, total: selected === organizationA ? 11 : 22 } }, meta: { request_id: requestId } } });
  });
  await page.goto("/admin");
  await expect(page.getByText("11", { exact: true })).toBeVisible();
  await page.locator("#active-organization").selectOption("00000000-0000-4000-8000-000000000006");
  await expect(page.locator('[aria-busy="true"]')).toBeVisible();
  await expect(page.getByText("11", { exact: true })).toHaveCount(0);
  releaseSecond?.();
  await expect(page.getByText("22", { exact: true })).toBeVisible();
});

test("dashboard omits unauthorized metrics and creation actions", async ({ page }) => {
  await routeSession(page, ["organization:read", "project:read", "training:read", "template:read"]);
  await page.route("**/api/admin/dashboard", (route) => route.fulfill({ json: { data: {
    projects: { active: 0, total: 0 }, trainings: { active: 0, total: 0 }, templates: { active: 0, published_versions: 0 }
  }, meta: { request_id: requestId } } }));
  await page.goto("/admin");
  const dashboardContent = page.locator("#main-content");
  await expect(dashboardContent.getByText("ผู้เข้าร่วม", { exact: true })).toHaveCount(0);
  await expect(dashboardContent.getByText("ใบประกาศพร้อมใช้", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "สร้างโครงการ" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "เตรียมเทมเพลต" })).toHaveCount(0);
});

for (const width of [375, 768, 1280, 1440]) {
  test(`admin routes avoid horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await routeSession(page);
    await page.route("**/api/admin/dashboard", (route) => route.fulfill({ json: populated }));
    for (const path of ["/admin", "/admin/projects", "/admin/trainings", "/admin/participants", "/admin/templates", "/admin/certificates"]) {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  });
}
