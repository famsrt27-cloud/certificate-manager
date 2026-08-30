import { expect, test, type Page, type Route } from "@playwright/test";

const verificationToken = "synthetic.verification.token";
const invalidToken = "synthetic.invalid.token";
const unknownToken = "synthetic.unknown.token";
const downloadToken = "synthetic.download.token";
const requestId = "70000000-0000-4000-8000-000000000001";
const pdf = Buffer.from("%PDF-1.7\nsynthetic browser certificate\n%%EOF", "ascii");

const availableResponse = {
  data: {
    status: "valid",
    certificate_number: "CERT-2026-001",
    recipient_name: "สมชาย ตัวอย่าง",
    program_name: "ทักษะดิจิทัล 2569",
    issued_at: "2026-08-26"
  },
  meta: { request_id: requestId }
} as const;

const genericFailure = {
  error: { code: "PUBLIC_REQUEST_FAILED", message: "The request could not be completed." },
  meta: { request_id: requestId }
};

const fulfillJson = (route: Route, body: unknown, status = 200) => route.fulfill({
  status,
  contentType: "application/json",
  body: JSON.stringify(body)
});

const routeAvailableVerification = async (page: Page): Promise<void> => {
  await page.route("**/api/public/verify", (route) => fulfillJson(route, availableResponse));
};

test("valid AVAILABLE certificate shows only canonical public fields in Thai", async ({ page }) => {
  await routeAvailableVerification(page);
  await page.goto(`/verify#token=${encodeURIComponent(verificationToken)}`);

  await expect(page.getByRole("heading", { name: "ใบประกาศนี้ถูกต้องและใช้ยืนยันได้" })).toBeVisible();
  await expect(page.getByText("ตรวจสอบสำเร็จ")).toBeVisible();
  await expect(page.getByText("CERT-2026-001")).toBeVisible();
  await expect(page.getByText("สมชาย ตัวอย่าง")).toBeVisible();
  await expect(page.getByText("ทักษะดิจิทัล 2569")).toBeVisible();
  await expect(page.getByText("26 สิงหาคม 2569")).toBeVisible();
  await expect(page.getByRole("button", { name: "ดาวน์โหลดใบประกาศ" })).toBeVisible();
  expect(await page.locator("body").textContent()).not.toMatch(/UUID|external_reference|storage|MinIO|participant ID|template ID|job ID/i);
});

test("revoked certificate exposes only its canonical certificate number and no download", async ({ page }) => {
  await page.route("**/api/public/verify", (route) => fulfillJson(route, {
    data: { status: "revoked", certificate_number: "CERT-REVOKED" }, meta: { request_id: requestId }
  }));
  await page.goto(`/verify#token=${verificationToken}`);

  await expect(page.getByRole("heading", { name: "ใบประกาศนี้ถูกเพิกถอนแล้ว" })).toBeVisible();
  await expect(page.getByText("CERT-REVOKED")).toBeVisible();
  await expect(page.getByRole("button", { name: "ดาวน์โหลดใบประกาศ" })).toHaveCount(0);
  expect(await page.locator("body").textContent()).not.toMatch(/สมชาย|ทักษะดิจิทัล|เหตุผล/);
});

test("malformed fragment fails locally without sending a public request", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/public/verify", (route) => {
    requests += 1;
    return fulfillJson(route, genericFailure, 400);
  });
  await page.goto("/verify#unexpected=value");

  await expect(page.getByRole("heading", { name: "ไม่สามารถยืนยันความถูกต้องของใบประกาศนี้ได้" })).toBeVisible();
  expect(page.url()).toBe("http://127.0.0.1:3100/verify");
  expect(requests).toBe(0);
});

for (const [label, token] of [["invalid", invalidToken], ["unknown", unknownToken]] as const) {
  test(`${label} certificate token receives the same generic public-safe state`, async ({ page }) => {
    await page.route("**/api/public/verify", (route) => fulfillJson(route, genericFailure, 400));
    await page.goto(`/verify#token=${encodeURIComponent(token)}`);

    await expect(page.getByRole("heading", { name: "ไม่สามารถยืนยันความถูกต้องของใบประกาศนี้ได้" })).toBeVisible();
    expect(page.url()).toBe("http://127.0.0.1:3100/verify");
    expect(await page.locator("body").textContent()).not.toContain(token);
  });
}

test("fragment verification and download authorization keep bearer tokens out of URLs and storage", async ({ page }) => {
  const requests: Array<{ url: string; body: string | null }> = [];
  const consoleMessages: string[] = [];
  page.on("console", (message) => consoleMessages.push(message.text()));
  await page.route("**/api/public/verify", (route) => {
    requests.push({ url: route.request().url(), body: route.request().postData() });
    return fulfillJson(route, availableResponse);
  });
  await page.route("**/api/public/certificates/download-authorize", (route) => {
    requests.push({ url: route.request().url(), body: route.request().postData() });
    return fulfillJson(route, { data: { download_token: downloadToken, expires_in: 60 }, meta: { request_id: requestId } });
  });
  await page.route("**/api/public/certificates/download", async (route) => {
    requests.push({ url: route.request().url(), body: route.request().postData() });
    await route.fulfill({ status: 200, contentType: "application/pdf", headers: {
      "content-disposition": 'attachment; filename="certificate.pdf"'
    }, body: pdf });
  });

  const pageResponse = await page.goto(`/verify#token=${encodeURIComponent(verificationToken)}`);
  await expect(page.getByText("ตรวจสอบสำเร็จ")).toBeVisible();
  expect(page.url()).toBe("http://127.0.0.1:3100/verify");
  expect(pageResponse?.request().url()).toBe("http://127.0.0.1:3100/verify");
  if (process.env.CI) expect(pageResponse?.headers()["cache-control"]).toContain("no-store");
  else expect(pageResponse?.headers()["cache-control"]).toMatch(/no-store|no-cache/);
  expect(pageResponse?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(pageResponse?.headers()["x-robots-tag"]).toBe("noindex, nofollow, noarchive");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ดาวน์โหลดใบประกาศ" }).click();
  expect((await download).suggestedFilename()).toBe("certificate.pdf");
  await expect(page.getByText("เริ่มดาวน์โหลดใบประกาศแล้ว")).toBeVisible();
  expect(requests.map((entry) => entry.url)).toEqual([
    "http://127.0.0.1:3100/api/public/verify",
    "http://127.0.0.1:3100/api/public/certificates/download-authorize",
    "http://127.0.0.1:3100/api/public/certificates/download"
  ]);
  expect(requests[0]?.body).toBe(JSON.stringify({ token: verificationToken }));
  expect(requests[1]?.body).toBe(JSON.stringify({ token: verificationToken }));
  expect(requests[2]?.body).toBe(JSON.stringify({ download_token: downloadToken }));
  expect(requests.every((entry) => !entry.url.includes("synthetic"))).toBe(true);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie })))
    .toEqual({ local: 0, session: 0, cookies: "" });
  expect(consoleMessages.join("\n")).not.toMatch(/synthetic\.(verification|download)\.token/);
  const resourceUrls = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name));
  const pageOrigin = new URL(page.url()).origin;
  expect(resourceUrls.every((url) => new URL(url).origin === pageOrigin)).toBe(true);
  expect(resourceUrls.join("\n")).not.toMatch(/synthetic\.(verification|download)\.token/);
});

test("expired or rejected download asks for a fresh verification before retry", async ({ page }) => {
  let verificationRequests = 0;
  await page.route("**/api/public/verify", (route) => {
    verificationRequests += 1;
    return fulfillJson(route, availableResponse);
  });
  await page.route("**/api/public/certificates/download-authorize", (route) => fulfillJson(route, genericFailure, 400));
  await page.goto(`/verify#token=${verificationToken}`);
  await expect(page.getByText("ตรวจสอบสำเร็จ")).toBeVisible();

  await page.getByRole("button", { name: "ดาวน์โหลดใบประกาศ" }).click();
  await expect(page.getByRole("alert").getByText("ไม่สามารถดาวน์โหลดได้")).toBeVisible();
  await page.getByRole("button", { name: "ตรวจสอบสถานะอีกครั้ง" }).click();
  await expect.poll(() => verificationRequests).toBe(2);
  await expect(page.getByText("ตรวจสอบสำเร็จ")).toBeVisible();
});

test("direct page open offers bounded public search and QR verification without admin login", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/public/verify", (route) => {
    requests += 1;
    return fulfillJson(route, genericFailure, 400);
  });
  await page.goto("/verify");

  await expect(page.getByRole("heading", { name: "ค้นหาและดาวน์โหลดใบประกาศ" })).toBeVisible();
  await expect(page.getByLabel("ชื่อผู้รับใบประกาศ")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "โครงการ" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "การอบรม" })).toBeEnabled();
  await expect(page.getByLabel("เลขที่ใบประกาศ")).toBeVisible();
  await expect(page.getByText("กรอกชื่อผู้รับพร้อมเลือกโครงการหรือการอบรม")).toBeVisible();
  await expect(page.getByText("กรอกชื่อด้วยตนเอง ระบบจะไม่แนะนำชื่อผู้รับ")).toBeVisible();
  await expect(page.getByText("โดยไม่ต้องเข้าสู่ระบบ")).toBeVisible();
  expect(requests).toBe(0);
});

test("rapid project and training typing is debounced and normalized duplicate prefixes use memory", async ({ page }) => {
  const requestBodies: Record<"project" | "training", string[]> = { project: [], training: [] };
  await page.route("**/api/public/certificates/project-suggestions", (route) => {
    requestBodies.project.push(route.request().postData() ?? "");
    return fulfillJson(route, { data: { suggestions: [{ label: "โครงการพัฒนาทักษะดิจิทัล" }] },
      meta: { request_id: requestId } });
  });
  await page.route("**/api/public/certificates/training-suggestions", (route) => {
    requestBodies.training.push(route.request().postData() ?? "");
    return fulfillJson(route, { data: { suggestions: [{ label: "การอบรมทักษะดิจิทัล" }] },
      meta: { request_id: requestId } });
  });
  await page.goto("/verify");

  const project = page.getByRole("combobox", { name: "โครงการ" });
  await project.pressSequentially("โครงการพัฒนาทักษะดิจิทัล", { delay: 25 });
  await expect(page.getByRole("option", { name: "โครงการพัฒนาทักษะดิจิทัล" })).toBeVisible();
  expect(requestBodies.project).toEqual([JSON.stringify({ query: "โครงการพัฒนาทักษะดิจิทัล" })]);
  await project.fill("  โครงการพัฒนาทักษะดิจิทัล  ");
  await page.waitForTimeout(500);
  expect(requestBodies.project).toHaveLength(1);

  const training = page.getByRole("combobox", { name: "การอบรม" });
  await training.pressSequentially("การอบรมทักษะดิจิทัล", { delay: 25 });
  await expect(page.getByRole("option", { name: "การอบรมทักษะดิจิทัล" })).toBeVisible();
  expect(requestBodies.training).toEqual([JSON.stringify({ query: "การอบรมทักษะดิจิทัล" })]);
});

test("a stale project response cannot replace newer suggestions", async ({ page }) => {
  let firstRequestStarted = false;
  await page.route("**/api/public/certificates/project-suggestions", async (route) => {
    const query = JSON.parse(route.request().postData() ?? "{}") as { query?: string };
    if (query.query === "โค") {
      firstRequestStarted = true;
      await page.waitForTimeout(900);
      await fulfillJson(route, { data: { suggestions: [{ label: "โครงการเก่า" }] },
        meta: { request_id: requestId } }).catch(() => undefined);
      return;
    }
    await fulfillJson(route, { data: { suggestions: [{ label: "โครงการใหม่" }] },
      meta: { request_id: requestId } });
  });
  await page.goto("/verify");
  const project = page.getByRole("combobox", { name: "โครงการ" });
  await project.fill("โค");
  await expect.poll(() => firstRequestStarted).toBe(true);
  await project.fill("โครงการ");
  await expect(page.getByRole("option", { name: "โครงการใหม่" })).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.getByRole("option", { name: "โครงการเก่า" })).toHaveCount(0);
});

for (const [label, endpoint] of [["โครงการ", "project-suggestions"], ["การอบรม", "training-suggestions"]] as const) {
  test(`${label} suggestion 429 shows rate-limit feedback instead of no-match feedback`, async ({ page }) => {
    let requests = 0;
    await page.route(`**/api/public/certificates/${endpoint}`, (route) => {
      requests += 1;
      return route.fulfill({ status: 429, contentType: "application/json", headers: { "retry-after": "10" },
        body: JSON.stringify(genericFailure) });
    });
    await page.goto("/verify");
    const combobox = page.getByRole("combobox", { name: label });
    await combobox.fill(label === "โครงการ" ? "โครงการ" : "การอบรม");
    await expect(page.getByText("ค้นหาบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่", { exact: true }).last()).toBeVisible();
    await expect(page.getByText(`ไม่พบ${label}ที่ตรงกับคำค้น`, { exact: true })).toHaveCount(0);
    await combobox.fill(label === "โครงการ" ? "โครงการใหม่" : "การอบรมใหม่");
    await page.waitForTimeout(500);
    expect(requests).toBe(1);
  });
}

test("recipient and independently selected training search downloads through the bounded capability flow", async ({ page }) => {
  const searchResultToken = "synthetic.search-result.token";
  const requests: Array<{ url: string; body: string | null }> = [];
  await page.route("**/api/public/certificates/search", (route) => {
    requests.push({ url: route.request().url(), body: route.request().postData() });
    return fulfillJson(route, { data: { too_broad: false, results: [{
      certificate_number: "CERT-2569-001", recipient_name: "สมชาย ใจดี",
      project_name: "โครงการดิจิทัล", training_name: "การอบรมความปลอดภัย",
      issued_at: "2026-08-30", status: "available", search_result_token: searchResultToken
    }] }, meta: { request_id: requestId } });
  });
  await page.route("**/api/public/certificates/training-suggestions", (route) => fulfillJson(route, {
    data: { suggestions: [{ label: "การอบรมความปลอดภัย" }] }, meta: { request_id: requestId }
  }));
  await page.route("**/api/public/certificates/search-download-authorize", (route) => {
    requests.push({ url: route.request().url(), body: route.request().postData() });
    return fulfillJson(route, { data: { download_token: downloadToken, expires_in: 60 }, meta: { request_id: requestId } });
  });
  await page.route("**/api/public/certificates/download", async (route) => {
    requests.push({ url: route.request().url(), body: route.request().postData() });
    await route.fulfill({ status: 200, contentType: "application/pdf",
      headers: { "content-disposition": 'attachment; filename="certificate.pdf"' }, body: pdf });
  });
  await page.goto("/verify");
  await page.getByLabel("ชื่อผู้รับใบประกาศ").fill("สมชาย ใจดี");
  await page.getByRole("combobox", { name: "การอบรม" }).fill("การอบรม");
  await page.getByRole("option", { name: "การอบรมความปลอดภัย" }).click();
  await page.getByRole("button", { name: "ค้นหาใบประกาศ", exact: true }).click();
  await expect(page.getByRole("heading", { name: "สมชาย ใจดี" })).toBeVisible();
  await expect(page.getByRole("article").getByText("การอบรมความปลอดภัย", { exact: true })).toBeVisible();
  await expect(page.getByText("CERT-2569-001")).toBeVisible();
  expect(await page.locator("body").textContent()).not.toContain(searchResultToken);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ดาวน์โหลดใบประกาศ" }).click();
  expect((await download).suggestedFilename()).toBe("certificate.pdf");
  expect(requests.map((entry) => entry.url)).toEqual([
    "http://127.0.0.1:3100/api/public/certificates/search",
    "http://127.0.0.1:3100/api/public/certificates/search-download-authorize",
    "http://127.0.0.1:3100/api/public/certificates/download"
  ]);
  expect(requests[0]?.body).toBe(JSON.stringify({ recipient_name: "สมชาย ใจดี", training_name: "การอบรมความปลอดภัย" }));
  expect(requests[1]?.body).toBe(JSON.stringify({ search_result_token: searchResultToken }));
  expect(requests[2]?.body).toBe(JSON.stringify({ download_token: downloadToken }));
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })))
    .toEqual({ local: 0, session: 0 });
});

test("name-only search stays client-side and project plus training search gives no partial directory", async ({ page }) => {
  let requests = 0;
  let searchBody: string | null = null;
  await page.route("**/api/public/certificates/search", (route) => {
    requests += 1;
    searchBody = route.request().postData();
    return fulfillJson(route, { data: { results: [], too_broad: true }, meta: { request_id: requestId } });
  });
  await page.route("**/api/public/certificates/project-suggestions", (route) => fulfillJson(route, {
    data: { suggestions: [{ label: "โครงการดิจิทัล" }] }, meta: { request_id: requestId }
  }));
  await page.route("**/api/public/certificates/training-suggestions", (route) => fulfillJson(route, {
    data: { suggestions: [{ label: "การอบรมความปลอดภัย" }] }, meta: { request_id: requestId }
  }));
  await page.goto("/verify");
  await page.getByLabel("ชื่อผู้รับใบประกาศ").fill("สมชาย ใจดี");
  await page.getByRole("button", { name: "ค้นหาใบประกาศ", exact: true }).click();
  await expect(page.getByText("กรุณากรอกเลขที่ใบประกาศ หรือกรอกชื่อผู้รับและเลือกโครงการหรือการอบรม", { exact: true }))
    .toBeVisible();
  expect(requests).toBe(0);
  await page.getByRole("combobox", { name: "โครงการ" }).fill("โครงการ");
  await page.getByRole("option", { name: "โครงการดิจิทัล" }).click();
  await page.getByRole("combobox", { name: "การอบรม" }).fill("การอบรม");
  await page.getByRole("option", { name: "การอบรมความปลอดภัย" }).click();
  await page.getByRole("button", { name: "ค้นหาใบประกาศ", exact: true }).click();
  await expect(page.getByText("พบหลายรายการ กรุณาระบุข้อมูลเพิ่มเติม")).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
  expect(searchBody).toBe(JSON.stringify({ recipient_name: "สมชาย ใจดี", project_name: "โครงการดิจิทัล",
    training_name: "การอบรมความปลอดภัย" }));
});

test("QR fragment bypasses the public search form", async ({ page }) => {
  let searchRequests = 0;
  await routeAvailableVerification(page);
  await page.route("**/api/public/certificates/search", (route) => {
    searchRequests += 1;
    return fulfillJson(route, genericFailure, 400);
  });
  await page.goto(`/verify#token=${verificationToken}`);
  await expect(page.getByText("ตรวจสอบสำเร็จ")).toBeVisible();
  await expect(page.getByLabel("ชื่อผู้รับใบประกาศ")).toHaveCount(0);
  expect(searchRequests).toBe(0);
});

test("public root links recipients to search and administrators to login without development terminology", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /ตรวจสอบและดาวน์โหลด.*ใบประกาศของคุณ/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "ค้นหาใบประกาศ" }).first()).toHaveAttribute("href", "/verify");
  await expect(page.getByRole("link", { name: "สำหรับผู้ดูแลระบบ" }).first()).toHaveAttribute("href", "/admin/login");
  expect(await page.locator("body").textContent()).not.toMatch(/Phase|Template Management|tenant-scoped|immutable publishing/i);
});

for (const width of [375, 390, 768, 1280]) {
  test(`public verification has no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/verify");
    await expect(page.getByRole("heading", { name: "ค้นหาและดาวน์โหลดใบประกาศ" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /ตรวจสอบและดาวน์โหลด/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}
