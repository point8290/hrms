/**
 * Secrets.
 *
 * Terraform creates the *containers*; the values are set out of band. That is the whole
 * point: a secret whose value passes through Terraform is a secret in the plan output, in
 * the state file, and in whatever CI system printed the plan.
 *
 *   aws secretsmanager put-secret-value --secret-id hrms-production/jwt \
 *     --secret-string "$(openssl rand -hex 48)"
 *
 * `ignore_changes` on a value means a rotation performed that way is never reverted by the
 * next `terraform apply`.
 */

resource "aws_kms_key" "secrets" {
  description             = "${local.name} application secrets"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = { Name = "${local.name}-secrets" }
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${local.name}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

resource "aws_secretsmanager_secret" "database_url" {
  name        = "${local.name}/database-url"
  description = "Connection string for hrms_app. Non-owner, no BYPASSRLS: this is the role RLS applies to."
  kms_key_id  = aws_kms_key.secrets.arn
  # Long enough to undo a mistaken destroy, short enough that a name can be reused.
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret" "platform_database_url" {
  name                    = "${local.name}/platform-database-url"
  description             = "Connection string for hrms_platform. BYPASSRLS; used only for provisioning, the outbox and maintenance."
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret" "jwt" {
  name                    = "${local.name}/jwt"
  description             = "Access token signing secret. Rotate by setting JWT_PREVIOUS_SECRET first, so live sessions survive."
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret" "field_encryption_key" {
  name                    = "${local.name}/field-encryption-key"
  description             = "AES-256-GCM key for bank account numbers and MFA secrets. Rotating it requires re-encrypting; not a routine operation."
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 30
}

resource "aws_secretsmanager_secret" "redis_url" {
  name                    = "${local.name}/redis-url"
  description             = "Shared rate-limit store. Cache and coordination only; never a source of truth."
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 7
}

/**
 * The RDS master password is the one secret Terraform does generate, because RDS needs it
 * at creation time. It is written here so rotation has somewhere to live, and the instance
 * ignores changes to it thereafter.
 *
 * The application never uses it: `hrms_app` and `hrms_platform` do, and those roles are
 * created by `db/roles.sql` as part of the schema.
 */
resource "aws_secretsmanager_secret" "db_master" {
  name                    = "${local.name}/db-master"
  description             = "RDS master credential. Used to create the application roles, never by the application."
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 30
}

resource "aws_secretsmanager_secret_version" "db_master" {
  secret_id = aws_secretsmanager_secret.db_master.id

  secret_string = jsonencode({
    username = aws_db_instance.main.username
    password = random_password.db_master.result
    host     = aws_db_instance.main.address
    port     = aws_db_instance.main.port
    dbname   = aws_db_instance.main.db_name
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}
