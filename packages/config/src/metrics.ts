export type OperationalService = "api" | "worker";

type MetricLabels = Readonly<Record<string, string>>;

const HISTOGRAM_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;
const MAX_ROUTE_LABEL_LENGTH = 160;

const escapeLabel = (value: string): string => value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, "\\\"");

const labelKey = (labels: MetricLabels): string => JSON.stringify(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)));

const labelText = (labels: MetricLabels): string => {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0 ? "" : `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
};

const safeRouteLabel = (route: string | undefined): string => {
  if (route === undefined || route.length === 0 || route.length > MAX_ROUTE_LABEL_LENGTH) return "unmatched";
  if (!/^\/[A-Za-z0-9_/:.-]*$/.test(route)) return "unmatched";
  return route;
};

interface CounterSample {
  readonly labels: MetricLabels;
  value: number;
}

class Counter {
  readonly #samples = new Map<string, CounterSample>();

  increment(labels: MetricLabels, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Metric counter increment must be a non-negative finite number");
    const key = labelKey(labels);
    const current = this.#samples.get(key);
    if (current === undefined) {
      this.#samples.set(key, { labels: { ...labels }, value: amount });
      return;
    }
    current.value += amount;
  }

  render(name: string): string[] {
    return [...this.#samples.values()]
      .sort((left, right) => labelKey(left.labels).localeCompare(labelKey(right.labels)))
      .map((sample) => `${name}${labelText(sample.labels)} ${sample.value}`);
  }
}

interface GaugeSample {
  readonly labels: MetricLabels;
  value: number;
}

class Gauge {
  readonly #samples = new Map<string, GaugeSample>();

  set(labels: MetricLabels, value: number): void {
    if (!Number.isFinite(value) || value < 0) throw new Error("Metric gauge value must be a non-negative finite number");
    this.#samples.set(labelKey(labels), { labels: { ...labels }, value });
  }

  render(name: string): string[] {
    return [...this.#samples.values()]
      .sort((left, right) => labelKey(left.labels).localeCompare(labelKey(right.labels)))
      .map((sample) => `${name}${labelText(sample.labels)} ${sample.value}`);
  }
}

interface HistogramSample {
  readonly labels: MetricLabels;
  readonly buckets: number[];
  count: number;
  sum: number;
}

class Histogram {
  readonly #samples = new Map<string, HistogramSample>();

  observe(labels: MetricLabels, value: number): void {
    if (!Number.isFinite(value) || value < 0) throw new Error("Metric histogram value must be a non-negative finite number");
    const key = labelKey(labels);
    let sample = this.#samples.get(key);
    if (sample === undefined) {
      sample = { labels: { ...labels }, buckets: HISTOGRAM_BUCKETS_SECONDS.map(() => 0), count: 0, sum: 0 };
      this.#samples.set(key, sample);
    }
    sample.count += 1;
    sample.sum += value;
    for (const [index, bucket] of HISTOGRAM_BUCKETS_SECONDS.entries()) {
      if (value <= bucket) sample.buckets[index] = (sample.buckets[index] ?? 0) + 1;
    }
  }

  render(name: string): string[] {
    const lines: string[] = [];
    for (const sample of [...this.#samples.values()].sort((left, right) => labelKey(left.labels).localeCompare(labelKey(right.labels)))) {
      for (const [index, bucket] of HISTOGRAM_BUCKETS_SECONDS.entries()) {
        lines.push(`${name}_bucket${labelText({ ...sample.labels, le: String(bucket) })} ${sample.buckets[index] ?? 0}`);
      }
      lines.push(`${name}_bucket${labelText({ ...sample.labels, le: "+Inf" })} ${sample.count}`);
      lines.push(`${name}_sum${labelText(sample.labels)} ${sample.sum}`);
      lines.push(`${name}_count${labelText(sample.labels)} ${sample.count}`);
    }
    return lines;
  }
}

export type RateLimitScope = "login" | "public_download" | "public_search" | "public_verification";
export type DependencyName = "database" | "redis";
export type GenerationEvent = "failed" | "retried" | "stalled";
export type OperationResult = "failure" | "success";

/**
 * A deliberately small, in-process Prometheus/OpenMetrics-compatible surface.
 * It uses only fixed low-cardinality labels and leaves transport/authentication to
 * the private deployment network rather than adding a monitoring platform.
 */
export class OperationalMetrics {
  readonly #service: OperationalService;
  readonly #httpRequests = new Counter();
  readonly #httpDuration = new Histogram();
  readonly #verification = new Counter();
  readonly #download = new Counter();
  readonly #rateLimits = new Counter();
  readonly #dependencyFailures = new Counter();
  readonly #readiness = new Counter();
  readonly #generationQueueDepth = new Gauge();
  readonly #generationDuration = new Histogram();
  readonly #generationEvents = new Counter();
  readonly #rendererFailures = new Counter();
  readonly #objectStorageFailures = new Counter();
  readonly #redisSessionFailures = new Counter();

  constructor(service: OperationalService) {
    this.#service = service;
  }

  recordHttpRequest(input: { readonly method: string; readonly route: string | undefined; readonly statusCode: number; readonly durationMs: number }): void {
    const labels = {
      service: this.#service,
      method: input.method.toUpperCase(),
      route: safeRouteLabel(input.route),
      status_code: String(input.statusCode)
    };
    this.#httpRequests.increment(labels);
    this.#httpDuration.observe({ service: this.#service, method: labels.method, route: labels.route }, input.durationMs / 1_000);
  }

  recordVerification(result: OperationResult): void {
    this.#verification.increment({ service: this.#service, result });
  }

  recordDownload(result: OperationResult): void {
    this.#download.increment({ service: this.#service, result });
  }

  recordRateLimit(scope: RateLimitScope): void {
    this.#rateLimits.increment({ service: this.#service, scope });
  }

  recordDependencyFailure(dependency: DependencyName): void {
    this.#dependencyFailures.increment({ service: this.#service, dependency });
  }

  recordReadiness(dependency: DependencyName, result: OperationResult): void {
    this.#readiness.increment({ service: this.#service, dependency, result });
  }

  setGenerationQueueDepth(state: "active" | "delayed" | "waiting", value: number): void {
    this.#generationQueueDepth.set({ service: this.#service, state }, value);
  }

  recordGenerationDuration(result: OperationResult, durationMs: number): void {
    this.#generationDuration.observe({ service: this.#service, result }, durationMs / 1_000);
  }

  recordGenerationEvent(event: GenerationEvent): void {
    this.#generationEvents.increment({ service: this.#service, event });
  }

  recordRendererFailure(): void {
    this.#rendererFailures.increment({ service: this.#service });
  }

  recordObjectStorageFailure(): void {
    this.#objectStorageFailures.increment({ service: this.#service });
  }

  recordRedisSessionFailure(): void {
    this.#redisSessionFailures.increment({ service: this.#service });
  }

  renderPrometheus(): string {
    const families: Array<readonly [string, string, "counter" | "gauge" | "histogram", Counter | Gauge | Histogram]> = [
      ["certificate_platform_http_requests", "Total completed HTTP requests.", "counter", this.#httpRequests],
      ["certificate_platform_http_request_duration_seconds", "HTTP request duration in seconds.", "histogram", this.#httpDuration],
      ["certificate_platform_public_verification", "Public verification outcomes.", "counter", this.#verification],
      ["certificate_platform_public_download", "Public certificate download outcomes.", "counter", this.#download],
      ["certificate_platform_rate_limit_events", "Rate-limit rejections by fixed scope.", "counter", this.#rateLimits],
      ["certificate_platform_dependency_failures", "Dependency operation failures by fixed dependency.", "counter", this.#dependencyFailures],
      ["certificate_platform_readiness", "Dependency readiness outcomes.", "counter", this.#readiness],
      ["certificate_platform_generation_queue_depth", "Certificate-generation queue depth by state.", "gauge", this.#generationQueueDepth],
      ["certificate_platform_generation_duration_seconds", "Certificate-generation job duration in seconds.", "histogram", this.#generationDuration],
      ["certificate_platform_generation_job_events", "Certificate-generation failed, retried, and stalled job events.", "counter", this.#generationEvents],
      ["certificate_platform_renderer_failures", "Certificate renderer failures.", "counter", this.#rendererFailures],
      ["certificate_platform_object_storage_failures", "Private object-storage operation failures.", "counter", this.#objectStorageFailures],
      ["certificate_platform_redis_session_failures", "Redis-backed authentication/session failures.", "counter", this.#redisSessionFailures]
    ];
    const lines: string[] = [];
    for (const [name, help, type, collector] of families) {
      const exposedName = type === "counter" ? `${name}_total` : name;
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      lines.push(...collector.render(exposedName));
    }
    return `${lines.join("\n")}\n`;
  }
}

export const createOperationalMetrics = (service: OperationalService): OperationalMetrics => new OperationalMetrics(service);
