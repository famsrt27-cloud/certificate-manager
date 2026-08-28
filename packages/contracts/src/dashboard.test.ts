import { describe, expect, it } from "vitest";

import { DashboardSummaryResponseSchema } from "./dashboard.js";

describe("dashboard summary contract", () => {
  it("accepts omitted unauthorized sections and rejects sensitive or malformed additions", () => {
    const response = { data: { projects: { active: 1, total: 2 } }, meta: { request_id: "00000000-0000-4000-8000-000000000001" } };
    expect(DashboardSummaryResponseSchema.parse(response)).toEqual(response);
    expect(DashboardSummaryResponseSchema.safeParse({ ...response, data: { ...response.data, storage_key: "private/key" } }).success).toBe(false);
    expect(DashboardSummaryResponseSchema.safeParse({ ...response, data: { projects: { active: -1, total: 2 } } }).success).toBe(false);
  });
});
