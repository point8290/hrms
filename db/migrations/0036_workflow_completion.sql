-- 0036 workflow completion: parallel groups, delegation, fallback, escalation, resubmission.
--
-- This extends the existing approval engine rather than replacing it. Three things already
-- worked and are deliberately untouched:
--
--   * a running instance is pinned to `definition_version`, so editing a definition cannot
--     change an approval already under way;
--   * `due_at` is computed from the step's `sla_hours` when the task is created, so the SLA
--     is already frozen at instantiation — there is no second SLA field here;
--   * several tasks may already share a `sequence_no`, and `settleIfComplete` advances only
--     when none remain pending at the lowest sequence. That is ALL semantics, already
--     working. What was missing was a way to say ANY or QUORUM instead, and a record of
--     which was meant — hence `group_mode` on the task rather than a second group table.
--
-- Nothing in payroll is touched. `payroll.guard_finalized_slip` and
-- `guard_finalized_slip_component` are not referenced, altered or reconstructed here.
--
-- Data validated before writing this: 35 approval tasks, 0 rejected, 0 rejected without a
-- reason, 0 instances in progress. Every constraint below is therefore added validated.

-- ---------------------------------------------------------------------------
-- 1. Delegation.
--
-- Time-bounded, scoped, and revocable. A delegation is not an authorization grant: it lets
-- the delegate act *where the delegator already had authority*, which is why nothing here
-- carries a permission. The check happens against the delegator's own authority at decision
-- time (workflow/service.ts).
-- ---------------------------------------------------------------------------

CREATE TABLE workflow.workflow_delegation (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,

  delegator_user_id  uuid NOT NULL REFERENCES identity.app_user(id) ON DELETE CASCADE,
  delegate_user_id   uuid NOT NULL REFERENCES identity.app_user(id) ON DELETE CASCADE,

  -- Explicit scope. An empty array would mean "nothing", so the column is NOT NULL and the
  -- service requires at least one entity type: no delegation is implicitly universal.
  entity_types       text[] NOT NULL,

  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL,

  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  revoked_at         timestamptz,
  revoked_by         uuid REFERENCES identity.app_user(id) ON DELETE SET NULL,

  created_by         uuid REFERENCES identity.app_user(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- Delegating to yourself is not a delegation; it is a way to make maker-checker look
  -- satisfied without a second person being involved.
  CONSTRAINT delegation_not_self CHECK (delegator_user_id <> delegate_user_id),
  CONSTRAINT delegation_bounded  CHECK (ends_at > starts_at),
  CONSTRAINT delegation_scoped   CHECK (cardinality(entity_types) > 0),
  -- Expiry is a fact about `ends_at`, not a status somebody has to remember to flip. Only
  -- revocation is a state change, and it has to say who and when.
  CONSTRAINT delegation_revoked_complete CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL)
  )
);

-- The lookup the decision path makes on every delegated approval: who has delegated to me,
-- right now.
CREATE INDEX idx_delegation_delegate_active
  ON workflow.workflow_delegation (tenant_id, delegate_user_id, starts_at, ends_at)
  WHERE status = 'active';

CREATE INDEX idx_delegation_delegator
  ON workflow.workflow_delegation (tenant_id, delegator_user_id);

ALTER TABLE workflow.workflow_delegation ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON workflow.workflow_delegation
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON workflow.workflow_delegation TO hrms_app, hrms_platform;

CREATE TRIGGER touch_workflow_workflow_delegation
  BEFORE UPDATE ON workflow.workflow_delegation
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON TABLE workflow.workflow_delegation IS
  'Time-bounded, scoped authority to act on another user''s approval tasks (PRD s.16.6). Never a permission grant in itself.';

-- ---------------------------------------------------------------------------
-- 2. Instances: who started it, and what it replaces.
--
-- `initiated_by_user_id` is what makes maker-checker checkable. Until now the instance knew
-- its *subject* but not its *requester*, and for entity types where those differ, refusing
-- self-approval on the subject alone would have been the wrong test.
-- ---------------------------------------------------------------------------

ALTER TABLE workflow.workflow_instance
  ADD COLUMN initiated_by_user_id   uuid REFERENCES identity.app_user(id) ON DELETE SET NULL,
  -- A resubmission is a new attempt that points at the rejected one. The rejected instance
  -- is never reopened (PRD s.16.5), so its history stays exactly as it was decided.
  ADD COLUMN supersedes_instance_id uuid REFERENCES workflow.workflow_instance(id),
  ADD COLUMN attempt_no             integer NOT NULL DEFAULT 1 CHECK (attempt_no > 0);

-- An attempt may only supersede a different instance, and only once: two live attempts
-- claiming the same predecessor would make "what replaced the rejection" ambiguous.
ALTER TABLE workflow.workflow_instance
  ADD CONSTRAINT instance_supersedes_not_self CHECK (supersedes_instance_id <> id);

CREATE UNIQUE INDEX idx_workflow_instance_supersedes
  ON workflow.workflow_instance (supersedes_instance_id)
  WHERE supersedes_instance_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Tasks: group policy, delegated authority, fallback, escalation.
--
-- `group_mode` is stored on the task, not read from the definition at decision time, for the
-- same reason `due_at` is stored: a definition edited mid-flight must not change how a
-- running group completes.
-- ---------------------------------------------------------------------------

ALTER TABLE workflow.approval_task
  ADD COLUMN group_mode   text NOT NULL DEFAULT 'all'
                            CHECK (group_mode IN ('all', 'any', 'quorum')),
  ADD COLUMN group_quorum integer CHECK (group_quorum IS NULL OR group_quorum > 0),

  -- Delegation records both identities. `decided_by` stays the person who actually clicked;
  -- this says whose authority they were using (PRD s.16.6, "do not overwrite the actor").
  ADD COLUMN decided_on_behalf_of_user_id uuid REFERENCES identity.app_user(id) ON DELETE SET NULL,
  ADD COLUMN delegation_id                uuid REFERENCES workflow.workflow_delegation(id),

  -- Fallback has to say why it was used. A fallback approver with no recorded trigger is
  -- indistinguishable from an arbitrary administrator being slipped in (PRD s.16.7).
  ADD COLUMN is_fallback     boolean NOT NULL DEFAULT false,
  ADD COLUMN fallback_reason text,

  -- Escalation widens who may act on an overdue task. It never decides one.
  ADD COLUMN escalated_at             timestamptz,
  ADD COLUMN escalated_to_employee_id uuid REFERENCES core.employee(id),
  ADD COLUMN escalation_reason        text;

ALTER TABLE workflow.approval_task
  -- A quorum needs a number; nothing else may carry one.
  ADD CONSTRAINT approval_task_quorum_complete
    CHECK ((group_mode = 'quorum') = (group_quorum IS NOT NULL)),

  ADD CONSTRAINT approval_task_fallback_complete
    CHECK (is_fallback = (fallback_reason IS NOT NULL)),

  ADD CONSTRAINT approval_task_escalation_complete
    CHECK ((escalated_at IS NULL) = (escalated_to_employee_id IS NULL)
           AND (escalated_at IS NULL) = (escalation_reason IS NULL)),

  -- Delegated authority is recorded as a pair or not at all.
  ADD CONSTRAINT approval_task_delegation_complete
    CHECK ((delegation_id IS NULL) = (decided_on_behalf_of_user_id IS NULL)),

  -- A rejection must carry a reason (PRD s.16.4). Validated: no existing row violates it,
  -- because no task has ever been rejected in this database.
  ADD CONSTRAINT approval_task_rejection_reason
    CHECK (status <> 'rejected' OR btrim(coalesce(decision_note, '')) <> '');

-- The escalation sweep's query: overdue, still pending, not yet escalated.
CREATE INDEX idx_approval_task_overdue
  ON workflow.approval_task (tenant_id, due_at)
  WHERE status = 'pending' AND due_at IS NOT NULL AND escalated_at IS NULL;

COMMENT ON COLUMN workflow.approval_task.group_mode IS
  'How this sequence completes: all (default, and the pre-existing behaviour), any, or quorum. Frozen at instantiation.';
COMMENT ON COLUMN workflow.approval_task.decided_on_behalf_of_user_id IS
  'Whose authority the decider used. decided_by remains the person who actually decided.';
