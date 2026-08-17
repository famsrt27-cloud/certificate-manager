import { expect, test } from "@playwright/test";

test("renders the Phase 3 boundary without exposing later-phase features", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Certificate Platform" })).toBeVisible();
  await expect(page.getByText("Phase 3 Project, Training & Participant")).toBeVisible();
  await expect(page.getByText(/private, validated participant imports/)).toBeVisible();
  await expect(page.getByText(/Template Builder/)).toHaveCount(0);
});
