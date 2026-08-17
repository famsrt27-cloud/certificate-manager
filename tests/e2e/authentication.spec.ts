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
  await expect(page.getByRole("heading", { name: "สิทธิ์การเข้าถึงองค์กร" })).toBeVisible();
  await expect(page.getByText("Synthetic Organization")).toBeVisible();
  await page.getByRole("button", { name: "ออกจากระบบ" }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
});
