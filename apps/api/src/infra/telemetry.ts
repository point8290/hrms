import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { config } from '../config.ts';

/**
 * Tracing across the synchronous and asynchronous halves of the system.
 *
 * The problem this solves is specific: an HTTP request finalizes payroll, the outbox
 * publisher picks the event up seconds later, SQS delivers it to a worker, the worker fans
 * out four thousand more events, and a Python engine finishes the work minutes after the
 * request that started it returned. Without a trace id carried across every one of those
 * hops, "why did this employee's payslip not arrive" is answered by correlating timestamps
 * by hand.
 *
 * W3C trace context is the unit of propagation, because it is what OpenTelemetry, every
 * APM vendor and every language SDK already speak. The OpenTelemetry SDK itself is loaded
 * **lazily and optionally**: when `OTEL_EXPORTER_OTLP_ENDPOINT` is set and the packages are
 * installed, spans are exported for real; otherwise the same trace ids flow through the
 * same code paths and land in the structured logs. Tracing must never be the reason a
 * deployment cannot start.
 *
 * ## What may go into a span
 *
 * Identifiers and counts. Never values.
 *
 * A trace is shipped to a third-party backend, retained for months and readable by anyone
 * with dashboard access — a far wider audience than the database. A salary figure, a bank
 * account, an email address or an employee's name in a span attribute is a payroll data
 * leak with extra steps. `sanitiseAttributes` enforces that mechanically rather than by
 * convention, because conventions are not enforced at three in the morning.
 */

export type TraceContext = {
  traceId: string;
  spanId: string;
  /** W3C trace flags. `01` = sampled. */
  flags: string;
};

export type SpanAttributes = Record<string, string | number | boolean | undefined | null>;

const storage = new AsyncLocalStorage<TraceContext>();

/**
 * Attribute names a span may carry.
 *
 * An allow-list, not a deny-list. A deny-list has to predict every name someone will invent
 * for a salary field; an allow-list fails closed on the one nobody thought of.
 */
const ALLOWED_ATTRIBUTES = new Set([
  'tenant.id',
  'http.method',
  'http.route',
  'http.status_code',
  'db.operation',
  'db.table',
  'messaging.system',
  'messaging.destination',
  'messaging.operation',
  'event.type',
  'event.id',
  'job.type',
  'job.id',
  'job.execution_date',
  'job.attempt',
  'payroll.run_id',
  'payroll.employee_count',
  'salary_slip.id',
  'employee.id',
  'error.type',
  'outcome',
  'count',
  'duration_ms',
  'consumer',
  'queue',
  'component',
]);

/**
 * Drops anything not explicitly allowed, and truncates what is.
 *
 * Exported so the rule is testable: "no PII in traces" is only a real control if something
 * fails when it is broken.
 */
export function sanitiseAttributes(attributes: SpanAttributes): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    if (!ALLOWED_ATTRIBUTES.has(key)) continue;
    out[key] = typeof value === 'string' ? value.slice(0, 256) : value;
  }
  return out;
}

export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** Parses a `traceparent` header. Returns undefined for anything malformed — never throws. */
export function parseTraceparent(header: string | undefined): TraceContext | undefined {
  if (!header) return undefined;
  const match = TRACEPARENT.exec(header.trim().toLowerCase());
  if (!match) return undefined;
  const [, traceId, spanId, flags] = match;
  // All-zero ids are the spec's "invalid" sentinel.
  if (traceId === '0'.repeat(32) || spanId === '0'.repeat(16)) return undefined;
  return { traceId: traceId!, spanId: spanId!, flags: flags! };
}

export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.flags}`;
}

/** The trace this code is running inside, if any. */
export function currentTrace(): TraceContext | undefined {
  return storage.getStore();
}

/** The header to attach to anything leaving this process. */
export function outgoingTraceparent(): string | undefined {
  const context = currentTrace();
  return context ? formatTraceparent(context) : undefined;
}

type SpanExporter = (span: FinishedSpan) => void;

export type FinishedSpan = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startedAt: number;
  durationMs: number;
  status: 'ok' | 'error';
  attributes: Record<string, string | number | boolean>;
};

let exporters: SpanExporter[] = [];

/**
 * Structured-log exporter.
 *
 * Deliberately the default. A trace that only exists in a vendor a team has not bought yet
 * is no trace at all; a span on stdout with a trace id is greppable, ships with the logs
 * that are already collected, and costs nothing.
 */
function logExporter(span: FinishedSpan): void {
  console.log(
    JSON.stringify({
      level: span.status === 'error' ? 'error' : 'info',
      msg: 'span',
      span: span.name,
      trace_id: span.traceId,
      span_id: span.spanId,
      parent_span_id: span.parentSpanId,
      duration_ms: Math.round(span.durationMs * 100) / 100,
      status: span.status,
      ...span.attributes,
    }),
  );
}

/**
 * Wires up exporters.
 *
 * Called once at boot. When the OpenTelemetry SDK is present and an OTLP endpoint is
 * configured, spans additionally go there; when it is not, nothing fails — the log exporter
 * carries the same information.
 */
export async function initTelemetry(options: { serviceName: string }): Promise<void> {
  exporters = [];
  const cfg = config();
  if (cfg.TELEMETRY_LOG_SPANS) exporters.push(logExporter);

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;

  try {
    const [api, sdkTrace, otlp, resources] = await Promise.all([
      import('@opentelemetry/api' as string),
      import('@opentelemetry/sdk-trace-node' as string),
      import('@opentelemetry/exporter-trace-otlp-http' as string),
      import('@opentelemetry/resources' as string),
    ]);

    const provider = new sdkTrace.NodeTracerProvider({
      resource: new resources.Resource({ 'service.name': options.serviceName }),
    });
    provider.addSpanProcessor(
      new sdkTrace.BatchSpanProcessor(new otlp.OTLPTraceExporter({ url: `${endpoint}/v1/traces` })),
    );
    provider.register();

    const tracer = api.trace.getTracer(options.serviceName);
    exporters.push((span) => {
      // Re-emitted rather than instrumented in place: the span boundaries here are the ones
      // this system cares about, not every function the auto-instrumentation would wrap.
      const exported = tracer.startSpan(span.name, {
        startTime: span.startedAt,
        attributes: span.attributes,
      });
      if (span.status === 'error') exported.setStatus({ code: api.SpanStatusCode.ERROR });
      exported.end(span.startedAt + span.durationMs);
    });

    console.log(JSON.stringify({ level: 'info', msg: 'otlp exporter enabled', service: options.serviceName }));
  } catch (err) {
    // Missing packages or a bad endpoint must never stop the service from starting.
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'otlp exporter unavailable; spans will only be logged',
        err: String(err),
      }),
    );
  }
}

/** Test seam. */
export function setExporters(next: SpanExporter[]): void {
  exporters = next;
}

/**
 * Runs `fn` inside a span.
 *
 * The span becomes the parent of anything started inside it, including across `await`,
 * because the context lives in an AsyncLocalStorage rather than a variable someone has to
 * remember to thread through.
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (context: TraceContext) => Promise<T>,
): Promise<T> {
  const parent = currentTrace();
  const context: TraceContext = {
    traceId: parent?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    flags: parent?.flags ?? '01',
  };

  const startedAt = Date.now();
  const clean = sanitiseAttributes(attributes);

  return storage.run(context, async () => {
    try {
      const result = await fn(context);
      emit({
        name,
        traceId: context.traceId,
        spanId: context.spanId,
        parentSpanId: parent?.spanId,
        startedAt,
        durationMs: Date.now() - startedAt,
        status: 'ok',
        attributes: clean,
      });
      return result;
    } catch (err) {
      emit({
        name,
        traceId: context.traceId,
        spanId: context.spanId,
        parentSpanId: parent?.spanId,
        startedAt,
        durationMs: Date.now() - startedAt,
        status: 'error',
        attributes: {
          ...clean,
          // The error *type*, never the message: a database error message can contain the
          // row that violated a constraint, and that row is employee data.
          'error.type': err instanceof Error ? err.constructor.name : 'Error',
        },
      });
      throw err;
    }
  });
}

/**
 * Runs `fn` inside an existing trace context, without opening a span.
 *
 * For framework integrations whose start and end are separate callbacks — a Fastify
 * `onRequest`/`onResponse` pair — where `withSpan` cannot wrap the work in one function.
 * The caller is responsible for calling `recordSpan` when the work finishes.
 */
export function runInTrace<T>(context: TraceContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Records a span whose timing the caller measured itself. Pairs with `runInTrace`. */
export function recordSpan(span: {
  name: string;
  context: TraceContext;
  parentSpanId?: string;
  startedAt: number;
  status: 'ok' | 'error';
  attributes: SpanAttributes;
}): void {
  emit({
    name: span.name,
    traceId: span.context.traceId,
    spanId: span.context.spanId,
    parentSpanId: span.parentSpanId,
    startedAt: span.startedAt,
    durationMs: Date.now() - span.startedAt,
    status: span.status,
    attributes: sanitiseAttributes(span.attributes),
  });
}

/**
 * Continues a trace that started in another process.
 *
 * This is the join between the synchronous and asynchronous halves: the worker calls it
 * with the `traceparent` an event carried, so the span it opens belongs to the HTTP request
 * that ultimately caused the work, however many queues ago that was.
 */
export function continueTrace<T>(traceparent: string | undefined, fn: () => Promise<T>): Promise<T> {
  const parsed = parseTraceparent(traceparent);
  if (!parsed) return fn();
  return storage.run(parsed, fn);
}

function emit(span: FinishedSpan): void {
  for (const exporter of exporters) {
    try {
      exporter(span);
    } catch {
      // Telemetry must never break the thing it observes.
    }
  }
}
