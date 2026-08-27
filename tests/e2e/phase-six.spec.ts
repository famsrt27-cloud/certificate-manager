import { expect, test } from "@playwright/test";

const verificationToken = "synthetic.verification.token";
const downloadToken = "synthetic.download.token";
const pdf = Buffer.from("%PDF-1.7\nsynthetic browser certificate\n%%EOF", "ascii");

test("fragment verification and application-mediated PDF download keep bearer tokens out of URLs and storage", async ({ page }) => {
  const requests: Array<{ url: string; body: string | null }> = [];
  const consoleMessages: string[] = [];
  page.on("console", (message) => consoleMessages.push(message.text()));
  await page.route("**/api/public/verify", async (route) => {
    requests.push({ url: route.request().url(), body: route.request().postData() });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
      status: "valid", certificate_number: "CERT-2026-001", recipient_name: "Synthetic Recipient",
      program_name: "Synthetic Program", issued_at: "2026-08-26" }, meta: { request_id: crypto.randomUUID() } }) });
  });
  await page.route("**/api/public/certificates/download-authorize", async (route) => {
    requests.push({ url: route.request().url(), body: route.request().postData() });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
      download_token: downloadToken, expires_in: 60 }, meta: { request_id: crypto.randomUUID() } }) });
  });
  await page.route("**/api/public/certificates/download", async (route) => {
    requests.push({ url: route.request().url(), body: route.request().postData() });
    await route.fulfill({ status: 200, contentType: "application/pdf", headers: {
      "content-disposition": 'attachment; filename="certificate.pdf"' }, body: pdf });
  });

  const pageResponse = await page.goto(`/verify#token=${encodeURIComponent(verificationToken)}`);
  await expect(page.getByText("Valid certificate")).toBeVisible();
  expect(page.url()).toBe("http://127.0.0.1:3100/verify");
  expect(pageResponse?.request().url()).toBe("http://127.0.0.1:3100/verify");
  if (process.env.CI) expect(pageResponse?.headers()["cache-control"]).toContain("no-store");
  else expect(pageResponse?.headers()["cache-control"]).toMatch(/no-store|no-cache/);
  expect(pageResponse?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(pageResponse?.headers()["x-robots-tag"]).toBe("noindex, nofollow, noarchive");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download certificate PDF" }).click();
  expect((await download).suggestedFilename()).toBe("certificate.pdf");
  await expect.poll(() => requests.length).toBe(3);
  expect(requests.map((entry) => entry.url)).toEqual([
    "http://127.0.0.1:3100/api/public/verify",
    "http://127.0.0.1:3100/api/public/certificates/download-authorize",
    "http://127.0.0.1:3100/api/public/certificates/download"
  ]);
  expect(requests[0]?.body).toBe(JSON.stringify({ token: verificationToken }));
  expect(requests[1]?.body).toBe(JSON.stringify({ token: verificationToken }));
  expect(requests[2]?.body).toBe(JSON.stringify({ download_token: downloadToken }));
  expect(requests.every((entry) => !entry.url.includes(verificationToken) && !entry.url.includes(downloadToken))).toBe(true);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length,
    cookies: document.cookie }))).toEqual({ local: 0, session: 0, cookies: "" });
  expect(consoleMessages.join("\n")).not.toContain(verificationToken);
  expect(consoleMessages.join("\n")).not.toContain(downloadToken);
});

test("revoked and malformed tokens show only generic safe public states", async ({ page }) => {
  const failedToken = "synthetic.failed.verification.token";
  const consoleMessages: string[] = [];
  page.on("console", (message) => consoleMessages.push(message.text()));
  await page.route("**/api/public/verify", async (route) => {
    const body = route.request().postDataJSON() as { token?: string };
    if (body.token === verificationToken) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
        status: "revoked", certificate_number: "CERT-REVOKED" }, meta: { request_id: crypto.randomUUID() } }) });
      return;
    }
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: {
      code: "PUBLIC_REQUEST_FAILED", message: "The request could not be completed." },
    meta: { request_id: crypto.randomUUID() } }) });
  });
  await page.goto(`/verify#token=${verificationToken}`);
  await expect(page.getByText("Certificate revoked")).toBeVisible();
  await expect(page.getByRole("button", { name: /Download/ })).toHaveCount(0);

  await page.goto("/verify#unexpected=value");
  await expect(page.getByText("The certificate could not be verified.")).toBeVisible();
  expect(page.url()).toBe("http://127.0.0.1:3100/verify");

  await page.goto(`/verify#token=${encodeURIComponent(failedToken)}`);
  await expect(page.getByText("The certificate could not be verified.")).toBeVisible();
  expect(page.url()).toBe("http://127.0.0.1:3100/verify");
  expect(await page.locator("body").textContent()).not.toContain(failedToken);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length,
    cookies: document.cookie }))).toEqual({ local: 0, session: 0, cookies: "" });
  expect(consoleMessages.join("\n")).not.toContain(failedToken);
  const resourceUrls = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name));
  const pageOrigin = new URL(page.url()).origin;
  expect(resourceUrls.every((url) => new URL(url).origin === pageOrigin)).toBe(true);
  expect(resourceUrls.join("\n")).not.toContain(failedToken);
});
