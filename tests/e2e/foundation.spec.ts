import { expect, test } from "@playwright/test";

test("renders the Phase 2 boundary without exposing Phase 3 features", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Certificate Platform" })).toBeVisible();
  await expect(page.getByText("Phase 2 Authentication & RBAC")).toBeVisible();
  await expect(page.getByText(/Project, training and participant features remain intentionally out of scope/)).toBeVisible();
});
