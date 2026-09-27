import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app.ts';
import { closePools } from '../../src/infra/db/pool.ts';
import { closeRedis } from '../../src/infra/redis.ts';
import { setStorage, type Storage } from '../../src/infra/storage.ts';
import { signAccessToken } from '../../src/http/auth.ts';
import * as identity from '../../src/modules/identity/service.ts';
import {
  createEmployee, createTestTenant, dropTestTenant, skipWithoutDb, type TestTenant,
} from './helpers.ts';

/**
 * Attaching a receipt to an expense claim.
 *
 * This closes a defect found by walking the product rather than reading it: the form warned
 * that a receipt was required and offered no way to provide one, so every receipt-required
 * expense type dead-ended at a 422 the user could not act on.
 *
 * The path under test is the existing document abstraction — presign, put, confirm — because
 * the alternative (handing storage credentials to a browser, or letting the API proxy the
 * bytes) is what that abstraction exists to avoid.
 */
describe('expense receipts', skipWithoutDb, () => {
  let app: FastifyInstance;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let claimant: string;
  let claimantEmployeeId: string;
  let outsider: string;
  let requiredTypeId: string;
  let optionalTypeId: string;

  /** In-memory storage, so a test never needs a bucket. */
  function fakeStorage(): Storage {
    const objects = new Map<string, Buffer>();
    const store: Storage = {
      bucket: 'test-bucket',
      buildKey: (tenant, type, filename) => `tenants/${tenant}/${type}/${filename}`,
      async presignUpload(key, contentType) {
        return {
          url: `memory://${key}`, method: 'PUT',
          headers: { 'content-type': contentType },
          bucket: 'test-bucket', key, expiresInSeconds: 60,
        };
      },
      async presignDownload(key) {
        return { url: `memory://${key}`, expiresInSeconds: 60 };
      },
      async putObject(key, body) {
        objects.set(key, body as Buffer);
      },
      async getObject(key) {
        const found = objects.get(key);
        if (!found) throw new Error(`no object at ${key}`);
        return found;
      },
      async healthCheck() {
        /* always healthy in memory */
      },
    };
    return store;
  }

  async function member(t: TestTenant, perms: string[], employeeId?: string) {
    const membership = await t.as((tx) =>
      identity.inviteUser(tx, {
        email: `rcpt-${randomUUID().slice(0, 8)}@receipt.example`,
        fullName: 'Receipt Tester', password: 'ReceiptPass1', roleNames: [],
      }),
    );
    return signAccessToken({
      sub: membership.userId, tid: t.tenantId, mid: membership.membershipId,
      eid: employeeId ?? null, perms, name: 'Receipt Tester', mfa: true,
    });
  }

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  before(async () => {
    process.env.LOG_LEVEL = 'error';
    setStorage(fakeStorage());
    app = await buildApp();
    await app.ready();

    tenantA = await createTestTenant('rc-a');
    tenantB = await createTestTenant('rc-b');

    claimantEmployeeId = await createEmployee(tenantA, {
      code: `RC${randomUUID().slice(0, 6).toUpperCase()}`, joiningDate: '2025-01-01',
    });

    claimant = await member(
      tenantA,
      ['expense.submit', 'expense.read.self', 'document.read.self', 'expense.manage'],
      claimantEmployeeId,
    );
    outsider = await member(tenantB, ['expense.submit', 'expense.read.self', 'document.read.self']);

    const makeType = async (code: string, receiptRequired: boolean) => {
      const response = await app.inject({
        method: 'POST', url: '/api/expense-types', headers: auth(claimant),
        payload: { code, name: code, receiptRequired, requiresBusinessPurpose: false },
      });
      assert.equal(response.statusCode, 201, `could not create expense type ${code}`);
      return (response.json() as { id: string }).id;
    };
    requiredTypeId = await makeType(`RQ${randomUUID().slice(0, 4).toUpperCase()}`, true);
    optionalTypeId = await makeType(`OP${randomUUID().slice(0, 4).toUpperCase()}`, false);
  });

  after(async () => {
    setStorage(undefined);
    await app.close();
    await dropTestTenant(tenantA.tenantId);
    await dropTestTenant(tenantB.tenantId);
    await closePools();
    await closeRedis();
  });

  /** The three-step upload the browser performs, driven through the same endpoints. */
  async function uploadReceipt(token: string, employeeId?: string) {
    const issued = await app.inject({
      method: 'POST', url: '/api/documents/upload-url', headers: auth(token),
      payload: {
        documentType: 'expense_receipt',
        filename: `receipt-${randomUUID().slice(0, 6)}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: 2048,
        ...(employeeId ? { employeeId } : {}),
      },
    });
    if (issued.statusCode !== 201) return { status: issued.statusCode, documentId: null };

    const body = issued.json() as { document_id: string; upload: { url: string; method: string } };
    assert.match(body.upload.url, /^memory:\/\//, 'the browser is given a presigned URL, not credentials');
    assert.equal(body.upload.method, 'PUT');

    const confirmed = await app.inject({
      method: 'POST', url: `/api/documents/${body.document_id}/confirm`,
      headers: auth(token), payload: {},
    });
    assert.equal(confirmed.statusCode, 200);
    return { status: 201, documentId: body.document_id };
  }

  const claim = (token: string, line: Record<string, unknown>, employeeId?: string) =>
    app.inject({
      method: 'POST', url: '/api/expense-claims', headers: auth(token),
      payload: {
        ...(employeeId ? { employeeId } : {}),
        claimDate: '2026-08-05',
        title: 'Client visit',
        lines: [{
          expenseDate: '2026-08-04',
          description: 'Return flight',
          claimedAmount: 1200,
          ...line,
        }],
      },
    });

  it('accepts a receipt-required claim once a receipt is attached', async () => {
    const receipt = await uploadReceipt(claimant, claimantEmployeeId);
    assert.ok(receipt.documentId, 'the upload should have produced a document');

    const response = await claim(claimant, {
      expenseTypeId: requiredTypeId,
      receiptDocumentId: receipt.documentId,
    });
    assert.equal(response.statusCode, 201);
  });

  it('still refuses a receipt-required claim with no receipt', async () => {
    // The validation this workflow exists to satisfy must not have been weakened to make
    // the UI easier.
    const response = await claim(claimant, { expenseTypeId: requiredTypeId });
    assert.equal(response.statusCode, 422);
    assert.equal((response.json() as { error: { code: string } }).error.code, 'receipt_required');
  });

  it('accepts a receipt-optional claim without one', async () => {
    const response = await claim(claimant, { expenseTypeId: optionalTypeId });
    assert.equal(response.statusCode, 201);
  });

  it('accepts a receipt on an optional type too', async () => {
    const receipt = await uploadReceipt(claimant, claimantEmployeeId);
    const response = await claim(claimant, {
      expenseTypeId: optionalTypeId,
      receiptDocumentId: receipt.documentId,
    });
    assert.equal(response.statusCode, 201);
  });

  it('records the document against the claim line', async () => {
    const receipt = await uploadReceipt(claimant, claimantEmployeeId);
    const created = await claim(claimant, {
      expenseTypeId: requiredTypeId,
      receiptDocumentId: receipt.documentId,
    });
    const { id } = created.json() as { id: string };

    const detail = (await app.inject({
      method: 'GET', url: `/api/expense-claims/${id}`, headers: auth(claimant),
    })).json() as { lines: Array<{ receipt_document_id: string | null }> };

    assert.equal(detail.lines[0]!.receipt_document_id, receipt.documentId,
      'the claim must reference the authoritative document, not a copy of it');
  });

  it('refuses a content type the product does not accept', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/documents/upload-url', headers: auth(claimant),
      payload: {
        documentType: 'expense_receipt', filename: 'receipt.exe',
        contentType: 'application/x-msdownload', sizeBytes: 1024,
        employeeId: claimantEmployeeId,
      },
    });
    assert.equal(response.statusCode, 422);
  });

  it('refuses a file beyond the size bound', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/documents/upload-url', headers: auth(claimant),
      payload: {
        documentType: 'expense_receipt', filename: 'huge.pdf',
        contentType: 'application/pdf', sizeBytes: 30 * 1024 * 1024,
        employeeId: claimantEmployeeId,
      },
    });
    assert.equal(response.statusCode, 400);
  });

  it('will not let another tenant attach or read the document', async () => {
    const receipt = await uploadReceipt(claimant, claimantEmployeeId);

    // Reading it from the neighbouring tenant is a miss, not a refusal that confirms it.
    const read = await app.inject({
      method: 'GET', url: `/api/documents/${receipt.documentId}/download-url`, headers: auth(outsider),
    });
    assert.equal(read.statusCode, 404);

    // And a claim in tenant B cannot borrow tenant A's document.
    const borrowed = await app.inject({
      method: 'POST', url: '/api/expense-claims', headers: auth(outsider),
      payload: {
        claimDate: '2026-08-05', title: 'Borrowed receipt',
        lines: [{
          expenseTypeId: requiredTypeId, expenseDate: '2026-08-04',
          description: 'Nope', claimedAmount: 10,
          receiptDocumentId: receipt.documentId,
        }],
      },
    });
    assert.ok(borrowed.statusCode >= 400, `expected a refusal, got ${borrowed.statusCode}`);
  });

  it('refuses an unauthenticated upload', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/documents/upload-url',
      payload: {
        documentType: 'expense_receipt', filename: 'r.pdf',
        contentType: 'application/pdf', sizeBytes: 100,
      },
    });
    assert.equal(response.statusCode, 401);
  });
});
