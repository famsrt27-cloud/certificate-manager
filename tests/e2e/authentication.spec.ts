import { expect, test } from "@playwright/test";

const requestId = "00000000-0000-4000-8000-000000000001";
const csrfToken = "c".repeat(43);
const authenticationResponse = {
  data: {
    user: { id: "00000000-0000-4000-8000-000000000002", email: "admin@example.invalid" },
    memberships: [{
      id: "00000000-0000-4000-8000-000000000003",
      organization: { id: "00000000-0000-4000-8000-000000000004", name: "Synthetic Organization" },
      roles: ["ORG_ADMIN"],
      permissions: ["organization:read"]
    }],
    csrf_token: csrfToken
  },
  meta: { request_id: requestId }
};

test("admin can use the login, session and logout UI without browser-stored session claims", async ({ page }) => {
  await page.route("**/api/admin/auth/login", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      email: "admin@example.invalid",
      password: "synthetic-password"
    });
    await route.fulfill({ json: authenticationResponse });
  });
  await page.route("**/api/admin/auth/session", (route) => route.fulfill({ json: authenticationResponse }));
  await page.route("**/api/admin/auth/logout", async (route) => {
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    await route.fulfill({ json: { data: { logged_out: true }, meta: { request_id: requestId } } });
  });

  await page.goto("/admin/login");
  await page.getByLabel("อีเมลผู้ดูแลระบบ").fill("admin@example.invalid");
  await page.getByLabel("รหัสผ่าน").fill("synthetic-password");
  await page.getByRole("button", { name: "เข้าสู่ระบบ" }).click();

  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "ภาพรวมระบบ" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Synthetic Organization" })).toBeVisible();
  await page.getByRole("button", { name: "ออกจากระบบ" }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
});

test("admin shell exposes an accessible mobile navigation drawer", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route("**/api/admin/auth/session", (route) => route.fulfill({ json: authenticationResponse }));

  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "ภาพรวมระบบ" })).toBeVisible();

  const menuButton = page.getByRole("button", { name: "เปิดเมนู" });
  await expect(menuButton).toHaveAttribute("aria-expanded", "false");
  await menuButton.click();
  await expect(menuButton).toHaveAttribute("aria-expanded", "true");
  const mobileNavigation = page.locator("#admin-mobile-navigation");
  await expect(mobileNavigation.getByRole("navigation", { name: "เมนูหลัก" })).toBeVisible();
  await expect(mobileNavigation.getByRole("button", { name: /โครงการ/ })).toBeDisabled();
  await mobileNavigation.getByRole("button", { name: "ปิดเมนู" }).click();
  await expect(menuButton).toHaveAttribute("aria-expanded", "false");
});

for (const width of [375, 768, 1280, 1440]) {
  test(`login and admin shell avoid horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/admin/auth/session", (route) => route.fulfill({ json: authenticationResponse }));

    await page.goto("/admin/login");
    await expect(page.getByRole("heading", { name: "เข้าสู่ระบบผู้ดูแล" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "ภาพรวมระบบ" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}
