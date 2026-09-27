/**
 * PostgreSQL.
 *
 * The isolation boundary for every tenant in the system is a row-level security policy in
 * this database, so its configuration is a security control, not an operations detail.
 *
 * Three roles connect to it — `hrms_owner`, `hrms_app` and `hrms_platform` — created by
 * `db/roles.sql`, not by Terraform. Terraform provisions the master credential; the
 * application roles are schema, and schema belongs in migrations where it is versioned and
 * reviewable (ADR-002).
 */

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = local.name }
}

resource "aws_kms_key" "database" {
  description             = "${local.name} RDS encryption at rest"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = { Name = "${local.name}-database" }
}

resource "aws_kms_alias" "database" {
  name          = "alias/${local.name}-database"
  target_key_id = aws_kms_key.database.key_id
}

resource "aws_db_parameter_group" "main" {
  name   = local.name
  family = "postgres16"

  # Log every statement that takes longer than a second. At payroll scale a slow query is
  # usually a missing tenant predicate, which is both a performance and a correctness smell.
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  # Connections are pooled in the application; a runaway count here means a pool leak.
  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  # A transaction left open holds row locks. The application sets this per connection too;
  # setting it here means a psql session someone forgot about cannot block payroll.
  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }

  # TLS only. The application connects from inside the VPC, but "inside the VPC" is not an
  # encryption story.
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "random_password" "db_master" {
  length  = 48
  special = false # RDS rejects several punctuation characters in a master password
}

resource "aws_db_instance" "main" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = "16.4"
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_allocated_storage_gb * 4
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.database.arn

  db_name  = "hrms"
  username = "hrms_master"
  password = random_password.db_master.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.database.id]
  parameter_group_name   = aws_db_parameter_group.main.name
  publicly_accessible    = false

  # Multi-AZ everywhere, including staging. A failover that has never been exercised outside
  # production is a failover nobody trusts during an incident.
  multi_az = true

  backup_retention_period = var.db_backup_retention_days
  backup_window           = "18:00-19:00" # 23:30 IST, after the attendance close cutoff
  maintenance_window      = "sun:19:30-sun:20:30"
  copy_tags_to_snapshot   = true

  # Point-in-time recovery is what makes a bad migration survivable. Deletion protection is
  # what makes a bad terraform apply survivable.
  deletion_protection      = var.environment == "production"
  skip_final_snapshot      = var.environment != "production"
  final_snapshot_identifier = var.environment == "production" ? "${local.name}-final" : null

  performance_insights_enabled          = true
  performance_insights_retention_period = 7
  performance_insights_kms_key_id       = aws_kms_key.database.arn
  monitoring_interval                   = 60
  monitoring_role_arn                   = aws_iam_role.rds_monitoring.arn

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  auto_minor_version_upgrade = true
  apply_immediately          = var.environment != "production"

  lifecycle {
    # The master password is rotated in Secrets Manager, not by re-applying Terraform.
    ignore_changes = [password]
  }
}

resource "aws_iam_role" "rds_monitoring" {
  name = "${local.name}-rds-monitoring"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}
