-- 0007 workflow, documents, notification, audit and the event outbox.

-- ---------------------------------------------------------------- workflow

CREATE TABLE workflow.workflow_definition (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  name        text NOT NULL,
  entity_type text NOT NULL
                CHECK (entity_type IN ('leave_application', 'expense_claim', 'attendance_correction',
                                       'employee_change', 'payroll_run', 'separation')),
  version     integer NOT NULL DEFAULT 1,
  definition  jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity_type, version)
);
SELECT app.enable_tenant_rls('workflow.workflow_definition');
SELECT app.add_updated_at_trigger('workflow.workflow_definition');
COMMENT ON COLUMN workflow.workflow_definition.definition IS
  'Ordered steps: [{ "sequence": 1, "approver": "reporting_manager" | "role", "role_name": "...", "sla_hours": 24 }]';

CREATE TABLE workflow.workflow_instance (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  definition_id      uuid NOT NULL REFERENCES workflow.workflow_definition(id),
  definition_version integer NOT NULL,
  entity_type        text NOT NULL,
  entity_id          uuid NOT NULL,
  subject_employee_id uuid REFERENCES core.employee(id),
  status             text NOT NULL DEFAULT 'in_progress'
                       CHECK (status IN ('in_progress', 'approved', 'rejected', 'cancelled')),
  current_sequence   integer NOT NULL DEFAULT 1,
  started_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('workflow.workflow_instance');
SELECT app.add_updated_at_trigger('workflow.workflow_instance');
CREATE INDEX idx_workflow_instance_entity
  ON workflow.workflow_instance (tenant_id, entity_type, entity_id);
-- One live workflow per entity.
CREATE UNIQUE INDEX idx_workflow_instance_active
  ON workflow.workflow_instance (tenant_id, entity_type, entity_id)
  WHERE status = 'in_progress';
COMMENT ON COLUMN workflow.workflow_instance.definition_version IS
  'Pinned at start. Editing the definition never changes a running instance.';

CREATE TABLE workflow.approval_task (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  workflow_instance_id uuid NOT NULL REFERENCES workflow.workflow_instance(id) ON DELETE CASCADE,
  sequence_no          integer NOT NULL,
  approver_employee_id uuid REFERENCES core.employee(id),
  approver_role_id     uuid REFERENCES identity.role(id),
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'approved', 'rejected', 'skipped', 'cancelled')),
  decision_note        text,
  decided_by           uuid,
  decided_at           timestamptz,
  due_at               timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_task_has_approver CHECK (
    approver_employee_id IS NOT NULL OR approver_role_id IS NOT NULL
  )
);
SELECT app.enable_tenant_rls('workflow.approval_task');
SELECT app.add_updated_at_trigger('workflow.approval_task');
CREATE INDEX idx_approval_task_inbox
  ON workflow.approval_task (tenant_id, approver_employee_id, status) WHERE status = 'pending';
CREATE INDEX idx_approval_task_instance
  ON workflow.approval_task (workflow_instance_id, sequence_no);

-- ---------------------------------------------------------------- documents

CREATE TABLE documents.document (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id    uuid REFERENCES core.employee(id) ON DELETE CASCADE,
  document_type  text NOT NULL
                   CHECK (document_type IN ('identity', 'address', 'education', 'offer_letter',
                                            'contract', 'bank', 'tax', 'certificate', 'payslip',
                                            'expense_receipt', 'experience_letter', 'other')),
  filename       text NOT NULL,
  content_type   text NOT NULL,
  size_bytes     bigint NOT NULL CHECK (size_bytes >= 0),
  s3_bucket      text NOT NULL,
  s3_key         text NOT NULL,
  checksum_sha256 text,
  version        integer NOT NULL DEFAULT 1,
  supersedes_id  uuid REFERENCES documents.document(id),
  is_sensitive   boolean NOT NULL DEFAULT false,
  retain_until   date,
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'available', 'quarantined', 'deleted')),
  uploaded_by    uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (s3_bucket, s3_key)
);
SELECT app.enable_tenant_rls('documents.document');
SELECT app.add_updated_at_trigger('documents.document');
CREATE INDEX idx_document_employee ON documents.document (tenant_id, employee_id, document_type);
COMMENT ON TABLE documents.document IS
  'Metadata only. Binaries live in a private S3 bucket and are reached via short-lived presigned URLs.';

-- ---------------------------------------------------------------- notification

CREATE TABLE notification.notification (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  recipient_user_id   uuid REFERENCES identity.app_user(id),
  recipient_email     text,
  channel             text NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'in_app')),
  template_code       text NOT NULL,
  subject             text,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sent', 'failed', 'suppressed')),
  provider_message_id text,
  retry_count         integer NOT NULL DEFAULT 0,
  last_error          text,
  dedupe_key          text,
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('notification.notification');
SELECT app.add_updated_at_trigger('notification.notification');
CREATE INDEX idx_notification_pending ON notification.notification (tenant_id, status) WHERE status = 'pending';
-- A redelivered event must not email the same person twice.
CREATE UNIQUE INDEX idx_notification_dedupe
  ON notification.notification (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- ---------------------------------------------------------------- audit

CREATE TABLE audit.audit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  actor_user_id  uuid,
  actor_employee_id uuid,
  actor_label    text,
  entity_type    text NOT NULL,
  entity_id      uuid,
  action         text NOT NULL,
  is_sensitive   boolean NOT NULL DEFAULT false,
  before_state   jsonb,
  after_state    jsonb,
  metadata       jsonb,
  request_id     text,
  correlation_id text,
  ip_address     inet,
  created_at     timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('audit.audit_log');
SELECT app.make_append_only('audit.audit_log');
CREATE INDEX idx_audit_entity ON audit.audit_log (tenant_id, entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_actor ON audit.audit_log (tenant_id, actor_user_id, created_at DESC);
CREATE INDEX idx_audit_sensitive ON audit.audit_log (tenant_id, created_at DESC) WHERE is_sensitive;

-- ---------------------------------------------------------------- events

-- Written inside the business transaction. The publisher reads it as the platform role.
CREATE TABLE integration.event_outbox (
  id             bigserial PRIMARY KEY,
  event_id       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  event_type     text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text,
  producer       text NOT NULL DEFAULT 'hrms-api',
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  available_at   timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  retry_count    integer NOT NULL DEFAULT 0,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('integration.event_outbox');
CREATE INDEX idx_outbox_unpublished
  ON integration.event_outbox (available_at) WHERE published_at IS NULL;
CREATE INDEX idx_outbox_aggregate
  ON integration.event_outbox (tenant_id, aggregate_type, aggregate_id);
COMMENT ON TABLE integration.event_outbox IS
  'Business write and event intent commit together. The publisher marks published_at after SQS accepts.';

-- The idempotency guard every consumer checks before doing work.
CREATE TABLE integration.processed_event (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  event_id      uuid NOT NULL,
  consumer_name text NOT NULL,
  result        text NOT NULL DEFAULT 'processed' CHECK (result IN ('processed', 'skipped')),
  processed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, consumer_name)
);
SELECT app.enable_tenant_rls('integration.processed_event');
SELECT app.make_append_only('integration.processed_event');

-- Local development / test transport. In AWS this is SQS; the interface is identical.
CREATE TABLE integration.local_queue_message (
  id            bigserial PRIMARY KEY,
  queue_name    text NOT NULL,
  body          jsonb NOT NULL,
  visible_at    timestamptz NOT NULL DEFAULT now(),
  receive_count integer NOT NULL DEFAULT 0,
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_local_queue_poll
  ON integration.local_queue_message (queue_name, visible_at) WHERE deleted_at IS NULL;
COMMENT ON TABLE integration.local_queue_message IS
  'Not tenant-scoped on purpose: it is transport, not business data. Accessed only by the platform role.';
