-- 0018 make the leave period job key work when leave_type_id is NULL.
--
-- `UNIQUE (tenant_id, job_kind, period_start, period_end, leave_type_id)` does not fire
-- when leave_type_id is NULL, because a standard unique constraint treats NULLs as
-- distinct. A tenant-wide job (the common case — accrual and carry-forward normally cover
-- every leave type) could therefore be claimed twice, and the run would report itself as
-- fresh rather than as a repeat.
--
-- The ledger was never at risk: leave_allocation carries its own idempotency key, so the
-- entitlement could not be granted twice either way. What was wrong was the job record
-- claiming to be a first run when it was not, which is exactly the signal an operator
-- relies on to know whether carry-forward has happened.
--
-- COALESCE gives NULL a concrete value so it participates in uniqueness like any other.

ALTER TABLE leave_mgmt.leave_period_job
  DROP CONSTRAINT leave_period_job_tenant_id_job_kind_period_start_period_end_key;

CREATE UNIQUE INDEX leave_period_job_key
  ON leave_mgmt.leave_period_job (
    tenant_id,
    job_kind,
    period_start,
    period_end,
    COALESCE(leave_type_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
