import { describe, expect, it } from "vitest";

import { createOperationalMetrics } from "./metrics.js";

describe("operational metrics", () => {
  it("renders fixed low-cardinality HTTP and public-operation metrics", () => {
    const metrics = createOperationalMetrics("api");
    metrics.recordHttpRequest({ method: "post", route: "/api/public/verify", statusCode: 200, durationMs: 18 });
    metrics.recordHttpRequest({ method: "post", route: "/api/public/verify?token=must-not-label", statusCode: 400, durationMs: 9 });
    metrics.recordVerification("success");
    metrics.recordVerification("failure");
    metrics.recordDownload("success");
    metrics.recordRateLimit("public_verification");
    metrics.recordRedisSessionFailure();

    const rendered = metrics.renderPrometheus();

    expect(rendered).toContain("certificate_platform_http_requests_total{method=\"POST\",route=\"/api/public/verify\",service=\"api\",status_code=\"200\"} 1");
    expect(rendered).toContain("certificate_platform_http_requests_total{method=\"POST\",route=\"unmatched\",service=\"api\",status_code=\"400\"} 1");
    expect(rendered).toContain("certificate_platform_public_verification_total{result=\"success\",service=\"api\"} 1");
    expect(rendered).toContain("certificate_platform_public_download_total{result=\"success\",service=\"api\"} 1");
    expect(rendered).toContain("certificate_platform_rate_limit_events_total{scope=\"public_verification\",service=\"api\"} 1");
    expect(rendered).toContain("certificate_platform_redis_session_failures_total{service=\"api\"} 1");
    expect(rendered).not.toContain("must-not-label");
  });

  it("tracks generation duration, queue depth, failure, retry, stalled, renderer, storage, and readiness signals", () => {
    const metrics = createOperationalMetrics("worker");
    metrics.setGenerationQueueDepth("waiting", 7);
    metrics.setGenerationQueueDepth("active", 2);
    metrics.recordGenerationDuration("success", 250);
    metrics.recordGenerationDuration("failure", 1_500);
    metrics.recordGenerationEvent("failed");
    metrics.recordGenerationEvent("retried");
    metrics.recordGenerationEvent("stalled");
    metrics.recordRendererFailure();
    metrics.recordObjectStorageFailure();
    metrics.recordReadiness("database", "success");
    metrics.recordReadiness("redis", "failure");
    metrics.recordDependencyFailure("redis");

    const rendered = metrics.renderPrometheus();

    expect(rendered).toContain("certificate_platform_generation_queue_depth{service=\"worker\",state=\"waiting\"} 7");
    expect(rendered).toContain("certificate_platform_generation_job_events_total{event=\"failed\",service=\"worker\"} 1");
    expect(rendered).toContain("certificate_platform_generation_job_events_total{event=\"retried\",service=\"worker\"} 1");
    expect(rendered).toContain("certificate_platform_generation_job_events_total{event=\"stalled\",service=\"worker\"} 1");
    expect(rendered).toContain("certificate_platform_renderer_failures_total{service=\"worker\"} 1");
    expect(rendered).toContain("certificate_platform_object_storage_failures_total{service=\"worker\"} 1");
    expect(rendered).toContain("certificate_platform_readiness_total{dependency=\"database\",result=\"success\",service=\"worker\"} 1");
    expect(rendered).toContain("certificate_platform_dependency_failures_total{dependency=\"redis\",service=\"worker\"} 1");
  });
});
