import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accepted, authenticate, created, inTenant, parseBody, parseParams, parseQuery } from '../../http/context.ts';
import { requirePermission, resolveTargetEmployee } from '../../http/auth.ts';
import { audit } from '../../infra/audit.ts';
import { conflict, isPgError, PG_UNIQUE_VIOLATION } from '../../infra/errors.ts';
import { assertCanViewEmployee } from '../core-hr/routes.ts';
import * as workforce from './service.ts';

const uuid = z.string().uuid();
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export async function workforceRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- shifts

  app.post('/api/shift-types', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'shift.manage');
      const body = parseBody(
        request,
        z.object({
          name: z.string().min(1).max(120),
          code: z.string().min(1).max(32),
          startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
          endTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
          breakMinutes: z.number().int().min(0).max(480).default(0),
          graceInMinutes: z.number().int().min(0).max(240).default(0),
          graceOutMinutes: z.number().int().min(0).max(240).default(0),
          halfDayThresholdMinutes: z.number().int().min(0).default(240),
          fullDayThresholdMinutes: z.number().int().min(0).default(480),
          overtimeEnabled: z.boolean().default(false),
          overtimeAfterMinutes: z.number().int().min(0).default(480),
          checkinWindowBeforeMinutes: z.number().int().min(0).max(720).default(120),
          checkoutWindowAfterMinutes: z.number().int().min(0).max(720).default(240),
        }),
      );

      // An end time at or before the start means the shift runs past midnight. Deriving
      // it here keeps overnight support from depending on the caller remembering a flag.
      const crossesMidnight = body.endTime <= body.startTime;

      try {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO workforce.shift_type
             (tenant_id, name, code, start_time, end_time, crosses_midnight, break_minutes,
              grace_in_minutes, grace_out_minutes, half_day_threshold_minutes, full_day_threshold_minutes,
              overtime_enabled, overtime_after_minutes, checkin_window_before_minutes, checkout_window_after_minutes)
           VALUES ($1,$2,$3,$4::time,$5::time,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING id`,
          [
            tx.tenantId, body.name, body.code, body.startTime, body.endTime, crossesMidnight,
            body.breakMinutes, body.graceInMinutes, body.graceOutMinutes,
            body.halfDayThresholdMinutes, body.fullDayThresholdMinutes,
            body.overtimeEnabled, body.overtimeAfterMinutes,
            body.checkinWindowBeforeMinutes, body.checkoutWindowAfterMinutes,
          ],
        );
        await audit(tx, {
          entityType: 'shift_type',
          entityId: rows[0]!.id,
          action: 'shift_type.created',
          after: { ...body, crosses_midnight: crossesMidnight },
        });
        return created(reply, { id: rows[0]!.id, crosses_midnight: crossesMidnight });
      } catch (err) {
        if (isPgError(err, PG_UNIQUE_VIOLATION)) {
          throw conflict('shift_code_taken', `Shift code ${body.code} already exists`);
        }
        throw err;
      }
    }),
  );

  app.get('/api/shift-types', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'shift.read');
      const { rows } = await tx.query(
        `SELECT id, name, code, start_time::text, end_time::text, crosses_midnight, break_minutes,
                grace_in_minutes, grace_out_minutes, overtime_enabled, status
           FROM workforce.shift_type WHERE tenant_id = $1 ORDER BY code`,
        [tx.tenantId],
      );
      return { shift_types: rows };
    }),
  );

  app.post('/api/shift-assignments', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'shift.manage');
      const body = parseBody(
        request,
        z.object({
          employeeId: uuid,
          shiftTypeId: uuid,
          holidayListId: uuid.optional(),
          effectiveFrom: dateString,
          effectiveTo: dateString.optional(),
        }),
      );
      const result = await workforce.assignShift(tx, body);
      return created(reply, { id: result.id });
    }),
  );

  // ---------------------------------------------------------------- check-ins

  app.post('/api/attendance/checkins', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      const body = parseBody(
        request,
        z.object({
          employeeId: uuid.optional(),
          checkinAt: z.string().datetime({ offset: true }),
          direction: z.enum(['in', 'out', 'unknown']).default('unknown'),
          source: z.enum(['web', 'mobile', 'biometric', 'api', 'import']).default('web'),
          deviceId: z.string().max(120).optional(),
          latitude: z.number().min(-90).max(90).optional(),
          longitude: z.number().min(-180).max(180).optional(),
          externalEventId: z.string().max(120).optional(),
          deviceRecordedAt: z.string().datetime({ offset: true }).optional(),
        }),
      );

      const target = resolveTargetEmployee(principal, body.employeeId, {
        self: 'attendance.checkin',
        others: 'attendance.checkin.other',
      });

      const result = await workforce.recordCheckin(tx, { ...body, employeeId: target.employeeId });
      // 202: the observation is stored, but the day's attendance is derived asynchronously.
      return accepted(reply, {
        id: result.id,
        duplicate: result.duplicate,
        attendance_date: result.attendanceDate,
      });
    }),
  );

  /**
   * Bulk intake for biometric devices and offline batches.
   *
   * Partial success is the correct outcome here: one malformed row from a device must not
   * discard the rest of the batch, so each row reports its own result.
   */
  app.post('/api/attendance/checkins/bulk', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'attendance.checkin.other');
      const body = parseBody(
        request,
        z.object({
          checkins: z
            .array(
              z.object({
                employeeCode: z.string().max(32).optional(),
                employeeId: uuid.optional(),
                checkinAt: z.string().datetime({ offset: true }),
                direction: z.enum(['in', 'out', 'unknown']).default('unknown'),
                deviceId: z.string().max(120).optional(),
                externalEventId: z.string().max(120).optional(),
              }),
            )
            .min(1)
            .max(500),
        }),
      );

      const results: Array<{ index: number; status: string; id?: string; error?: string }> = [];

      for (const [index, entry] of body.checkins.entries()) {
        try {
          let employeeId = entry.employeeId;
          if (!employeeId && entry.employeeCode) {
            const { rows } = await tx.query<{ id: string }>(
              'SELECT id FROM core.employee WHERE tenant_id = $1 AND employee_code = $2',
              [tx.tenantId, entry.employeeCode],
            );
            employeeId = rows[0]?.id;
          }
          if (!employeeId) {
            results.push({ index, status: 'rejected', error: 'employee not found' });
            continue;
          }

          const result = await workforce.recordCheckin(tx, {
            employeeId,
            checkinAt: entry.checkinAt,
            direction: entry.direction,
            source: 'biometric',
            deviceId: entry.deviceId,
            externalEventId: entry.externalEventId,
          });
          results.push({ index, status: result.duplicate ? 'duplicate' : 'accepted', id: result.id });
        } catch (err) {
          results.push({ index, status: 'rejected', error: err instanceof Error ? err.message : 'unknown error' });
        }
      }

      return {
        accepted: results.filter((r) => r.status === 'accepted').length,
        duplicates: results.filter((r) => r.status === 'duplicate').length,
        rejected: results.filter((r) => r.status === 'rejected').length,
        results,
      };
    }),
  );

  // ---------------------------------------------------------------- attendance

  app.get('/api/attendance', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const query = parseQuery(
        request,
        z.object({ employeeId: uuid.optional(), from: dateString, to: dateString }),
      );
      const target = resolveTargetEmployee(principal, query.employeeId, {
        self: 'attendance.read.self',
        others: 'attendance.read',
      });
      if (target.scope === 'others') {
        await assertCanViewEmployee(tx, principal, target.employeeId);
      }

      const { rows } = await tx.query(
        `SELECT to_char(attendance_date, 'YYYY-MM-DD') AS date, status,
                first_in_at, last_out_at, working_minutes, late_minutes, early_exit_minutes,
                overtime_minutes, lop_units, has_missing_punch, is_corrected, calculation_version
           FROM workforce.attendance
          WHERE tenant_id = $1 AND employee_id = $2 AND attendance_date BETWEEN $3::date AND $4::date
          ORDER BY attendance_date`,
        [tx.tenantId, target.employeeId, query.from, query.to],
      );

      return {
        employee_id: target.employeeId,
        from: query.from,
        to: query.to,
        summary: await workforce.summarise(tx, target.employeeId, query.from, query.to),
        days: rows,
      };
    }),
  );

  app.get('/api/attendance/checkins', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const query = parseQuery(
        request,
        z.object({ employeeId: uuid.optional(), from: dateString, to: dateString }),
      );
      const target = resolveTargetEmployee(principal, query.employeeId, {
        self: 'attendance.read.self',
        others: 'attendance.read',
      });

      const { rows } = await tx.query(
        `SELECT id, checkin_at, direction, source, device_id, external_event_id
           FROM workforce.employee_checkin
          WHERE tenant_id = $1 AND employee_id = $2
            AND checkin_at >= $3::date AND checkin_at < ($4::date + INTERVAL '1 day')
          ORDER BY checkin_at`,
        [tx.tenantId, target.employeeId, query.from, query.to],
      );
      return { checkins: rows };
    }),
  );

  app.post('/api/attendance/recalculate', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'attendance.manage');
      const body = parseBody(
        request,
        z.object({
          employeeIds: z.array(uuid).min(1).max(1000),
          fromDate: dateString,
          toDate: dateString,
          reason: z.string().min(3).max(300),
        }),
      );
      const result = await workforce.requestRecalculation(tx, body);
      return accepted(reply, { jobs_queued: result.jobs });
    }),
  );

  // ---------------------------------------------------------------- corrections

  app.post('/api/attendance/corrections', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      const body = parseBody(
        request,
        z.object({
          employeeId: uuid.optional(),
          attendanceDate: dateString,
          reason: z.string().min(3).max(500),
          proposedInAt: z.string().datetime({ offset: true }).optional(),
          proposedOutAt: z.string().datetime({ offset: true }).optional(),
          proposedStatus: z.enum(['present', 'half_day', 'work_from_home', 'absent']).optional(),
        }),
      );
      const target = resolveTargetEmployee(principal, body.employeeId, {
        self: 'attendance.read.self',
        others: 'attendance.correct',
      });
      const result = await workforce.requestCorrection(tx, { ...body, employeeId: target.employeeId });
      return created(reply, {
        id: result.id,
        status: result.status,
        workflow_instance_id: result.workflowInstanceId,
      });
    }),
  );

  app.get('/api/attendance/corrections', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const query = parseQuery(
        request,
        z.object({ employeeId: uuid.optional(), status: z.string().optional() }),
      );
      const target = resolveTargetEmployee(principal, query.employeeId, {
        self: 'attendance.read.self',
        others: 'attendance.read',
      });
      const { rows } = await tx.query(
        `SELECT id, to_char(attendance_date, 'YYYY-MM-DD') AS attendance_date, reason,
                proposed_in_at, proposed_out_at, proposed_status, status, decided_at, decision_note
           FROM workforce.attendance_correction
          WHERE tenant_id = $1 AND employee_id = $2 AND ($3::text IS NULL OR status = $3)
          ORDER BY attendance_date DESC`,
        [tx.tenantId, target.employeeId, query.status ?? null],
      );
      return { corrections: rows };
    }),
  );
}
