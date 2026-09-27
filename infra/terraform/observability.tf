/**
 * Logs and alarms.
 *
 * Retention is a compliance decision, not a cost one: an audit asking "who approved this
 * payroll run" three months later needs the logs to still be there. The audit trail itself
 * lives in the database and is append-only by trigger; these are the operational logs
 * around it.
 *
 * Every alarm below exists because of a failure that is **silent** in this system. Errors
 * that shout for themselves — a 500, a failed deploy — need less help.
 */

resource "aws_kms_key" "logs" {
  description             = "${local.name} log encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  # CloudWatch Logs must be able to use the key, and only for this account's log groups.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdmin"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "CloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.${var.aws_region}.amazonaws.com" }
        Action    = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
        Resource  = "*"
        Condition = {
          ArnLike = {
            "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:*"
          }
        }
      },
    ]
  })

  tags = { Name = "${local.name}-logs" }
}

resource "aws_cloudwatch_log_group" "services" {
  for_each = local.services

  name              = "/ecs/${each.value}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn

  tags = { Name = each.value }
}

/**
 * A scheduled job that was abandoned means a tenant period will never be evaluated without
 * a human. For attendance close that silently costs employees LOP accuracy, which is why
 * the application audits it as a sensitive action and why it alarms here.
 */
resource "aws_cloudwatch_log_metric_filter" "abandoned_jobs" {
  name           = "${local.name}-abandoned-jobs"
  log_group_name = aws_cloudwatch_log_group.services["scheduler"].name
  pattern        = "{ $.msg = \"scheduled jobs abandoned after max attempts\" }"

  metric_transformation {
    name      = "AbandonedScheduledJobs"
    namespace = local.name
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "abandoned_jobs" {
  alarm_name          = "${local.name}-abandoned-jobs"
  alarm_description   = "A scheduled job gave up. A tenant period will not be evaluated until someone intervenes."
  namespace           = local.name
  metric_name         = "AbandonedScheduledJobs"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

/**
 * The scheduler not running at all is the failure that hides best. Nothing errors; days
 * simply stop closing, and payroll refuses a month later with a coverage gap nobody can
 * explain. So the alarm is on the *absence* of ticks, and missing data is the breach.
 */
resource "aws_cloudwatch_log_metric_filter" "scheduler_heartbeat" {
  name           = "${local.name}-scheduler-heartbeat"
  log_group_name = aws_cloudwatch_log_group.services["scheduler"].name
  pattern        = "{ $.span = \"scheduler.tick\" }"

  metric_transformation {
    name      = "SchedulerTicks"
    namespace = local.name
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "scheduler_stopped" {
  alarm_name          = "${local.name}-scheduler-stopped"
  alarm_description   = "No scheduler tick in 30 minutes. Attendance is not being closed and payroll will refuse to run."
  namespace           = local.name
  metric_name         = "SchedulerTicks"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

/**
 * A notification that fails permanently is an employee who was never told. The application
 * parks it as `failed` after five attempts rather than retrying for ever, which is right —
 * but the parking has to be visible.
 */
resource "aws_cloudwatch_log_metric_filter" "notification_failures" {
  name           = "${local.name}-notification-failures"
  log_group_name = aws_cloudwatch_log_group.services["worker"].name
  pattern        = "{ $.msg = \"notification dispatch failed\" }"

  metric_transformation {
    name      = "NotificationDispatchFailures"
    namespace = local.name
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "notification_failures" {
  alarm_name          = "${local.name}-notification-failures"
  alarm_description   = "Notification dispatch is failing. Employees are not being told about payslips or leave decisions."
  namespace           = local.name
  metric_name         = "NotificationDispatchFailures"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 2
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${local.name}-api-5xx"
  alarm_description   = "The API is returning server errors."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

/**
 * Connection count climbing is usually a pool leak, or a transaction held open across a
 * network call — the exact shape this phase removed from the outbox publisher and the
 * payslip handler. Worth catching if it comes back.
 */
resource "aws_cloudwatch_metric_alarm" "database_connections" {
  alarm_name          = "${local.name}-database-connections"
  alarm_description   = "Database connection count is high; usually a pool leak or a transaction held across a network call."
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.id }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
