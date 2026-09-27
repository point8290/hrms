import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  continueTrace,
  currentTrace,
  formatTraceparent,
  outgoingTraceparent,
  parseTraceparent,
  sanitiseAttributes,
  setExporters,
  withSpan,
  type FinishedSpan,
} from '../../src/infra/telemetry.ts';

/**
 * Tracing.
 *
 * Two properties, and the second is the one that matters most: a trace is shipped to a
 * third-party backend, retained for months and readable by anyone with dashboard access.
 * Payroll data reaching a span is a data leak with extra steps, so "no PII in traces" is
 * tested rather than documented.
 */
describe('trace context', () => {
  it('parses a valid W3C traceparent', () => {
    const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const parsed = parseTraceparent(header);
    assert.deepEqual(parsed, {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      flags: '01',
    });
    assert.equal(formatTraceparent(parsed!), header);
  });

  it('refuses malformed and sentinel values instead of throwing', () => {
    // A bad header is untrusted input from a caller, not a reason to fail a request.
    assert.equal(parseTraceparent(undefined), undefined);
    assert.equal(parseTraceparent(''), undefined);
    assert.equal(parseTraceparent('garbage'), undefined);
    assert.equal(parseTraceparent('99-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'), undefined);
    // All-zero ids are the spec's explicit "invalid" sentinel.
    assert.equal(parseTraceparent(`00-${'0'.repeat(32)}-00f067aa0ba902b7-01`), undefined);
    assert.equal(parseTraceparent(`00-4bf92f3577b34da6a3ce929d0e0e4736-${'0'.repeat(16)}-01`), undefined);
  });
});

describe('span attributes', () => {
  it('drops anything not on the allow-list', () => {
    const clean = sanitiseAttributes({
      'tenant.id': 'a-tenant',
      'http.status_code': 200,
      // Everything below is the reason the allow-list exists.
      'employee.name': 'Priya Sharma',
      'employee.email': 'priya@example.com',
      'salary.gross': 125000,
      'bank.account_number': '000123456789',
      'tax.pan': 'ABCDE1234F',
      password: 'hunter2',
      refresh_token: 'rt_abc',
      otp_secret: 'JBSWY3DPEHPK3PXP',
    });

    assert.deepEqual(clean, { 'tenant.id': 'a-tenant', 'http.status_code': 200 });
  });

  it('truncates long strings so a span cannot smuggle a payload', () => {
    const clean = sanitiseAttributes({ 'tenant.id': 'x'.repeat(5000) });
    assert.equal((clean['tenant.id'] as string).length, 256);
  });

  it('drops null and undefined rather than exporting them', () => {
    assert.deepEqual(sanitiseAttributes({ 'tenant.id': null, 'job.type': undefined }), {});
  });
});

describe('spans', () => {
  function capture(): { spans: FinishedSpan[]; restore: () => void } {
    const spans: FinishedSpan[] = [];
    setExporters([(span) => spans.push(span)]);
    return { spans, restore: () => setExporters([]) };
  }

  it('records a span with sanitised attributes', async () => {
    const { spans, restore } = capture();
    try {
      await withSpan('test.work', { 'tenant.id': 't1', 'employee.email': 'leak@example.com' }, async () => 'ok');
      assert.equal(spans.length, 1);
      assert.equal(spans[0]!.name, 'test.work');
      assert.equal(spans[0]!.status, 'ok');
      assert.deepEqual(spans[0]!.attributes, { 'tenant.id': 't1' });
    } finally {
      restore();
    }
  });

  it('records an error span with the error type but never its message', async () => {
    const { spans, restore } = capture();
    try {
      await assert.rejects(
        withSpan('test.fails', {}, async () => {
          // A database error message can quote the row that violated a constraint, and that
          // row is employee data. Only the type may be exported.
          throw new TypeError('duplicate key value violates unique constraint (priya@example.com)');
        }),
      );
      assert.equal(spans[0]!.status, 'error');
      assert.equal(spans[0]!.attributes['error.type'], 'TypeError');
      assert.ok(!JSON.stringify(spans[0]).includes('priya@example.com'));
    } finally {
      restore();
    }
  });

  it('nests spans under the same trace, with the parent recorded', async () => {
    const { spans, restore } = capture();
    try {
      await withSpan('outer', {}, async () => {
        await withSpan('inner', {}, async () => undefined);
      });

      const inner = spans.find((s) => s.name === 'inner')!;
      const outer = spans.find((s) => s.name === 'outer')!;
      assert.equal(inner.traceId, outer.traceId, 'one causal chain, one trace id');
      assert.equal(inner.parentSpanId, outer.spanId);
    } finally {
      restore();
    }
  });

  it('carries the trace across an async boundary via traceparent', async () => {
    const { spans, restore } = capture();
    try {
      let propagated: string | undefined;
      await withSpan('producer', {}, async () => {
        // What the outbox stamps onto an event.
        propagated = outgoingTraceparent();
      });

      assert.ok(propagated);
      // What the consumer does with it, in another process, minutes later.
      await continueTrace(propagated, () => withSpan('consumer', {}, async () => undefined));

      const producer = spans.find((s) => s.name === 'producer')!;
      const consumer = spans.find((s) => s.name === 'consumer')!;
      assert.equal(
        consumer.traceId,
        producer.traceId,
        'the async work must belong to the trace of the request that caused it',
      );
      assert.equal(consumer.parentSpanId, producer.spanId);
    } finally {
      restore();
    }
  });

  it('starts a fresh trace when the incoming context is unusable', async () => {
    const { spans, restore } = capture();
    try {
      await continueTrace('not-a-traceparent', () => withSpan('orphan', {}, async () => undefined));
      assert.equal(spans.length, 1);
      assert.match(spans[0]!.traceId, /^[0-9a-f]{32}$/);
      assert.equal(spans[0]!.parentSpanId, undefined);
    } finally {
      restore();
    }
  });

  it('never lets an exporter failure break the work it observes', async () => {
    setExporters([
      () => {
        throw new Error('the trace backend is down');
      },
    ]);
    try {
      assert.equal(await withSpan('resilient', {}, async () => 'finished'), 'finished');
    } finally {
      setExporters([]);
    }
  });

  it('reports no trace outside a span, rather than inventing one', () => {
    assert.equal(currentTrace(), undefined);
    assert.equal(outgoingTraceparent(), undefined);
  });
});
