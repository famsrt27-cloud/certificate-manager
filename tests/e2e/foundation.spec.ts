import { expect, test } from "@playwright/test";

test("renders the Phase 4 boundary without exposing certificate generation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Certificate Platform" })).toBeVisible();
  await expect(page.getByText("Phase 4 Template Management")).toBeVisible();
  await expect(page.getByText(/validated private assets/)).toBeVisible();
  await expect(page.getByText(/certificate generation/i)).toHaveCount(0);
});
