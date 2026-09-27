/**
 * SQS.
 *
 * Three queues, each with a dead letter queue. Standard queues, not FIFO, deliberately:
 * every consumer in this system claims through `integration.processed_event` before doing
 * any work, so duplicate delivery is already absorbed, and nothing depends on message
 * ordering — an event names an aggregate and the consumer re-reads the database for
 * anything authoritative. FIFO would buy ordering nobody uses at a third of the throughput.
 *
 * `max_receive_count` here and `MAX_RECEIVES` in `apps/worker/src/consumer.ts` describe the
 * same policy from two sides. Keep them equal: a consumer that gives up before the redrive
 * does will loop, and one that gives up after has no say at all.
 */

locals {
  max_receive_count = 5

  # Longer than the slowest handler, plus room for a retry inside it. Payslip generation
  # renders a PDF and uploads it; two minutes is generous and still well under the point
  # where a stuck consumer stops being noticed.
  visibility_timeout_seconds = 120

  # Fourteen days. A dead-lettered payroll event is evidence that an employee was not paid
  # correctly, and it has to survive a long weekend and an investigation.
  dlq_retention_seconds = 1209600
}

resource "aws_kms_key" "queues" {
  description             = "${local.name} SQS encryption at rest"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = { Name = "${local.name}-queues" }
}

resource "aws_kms_alias" "queues" {
  name          = "alias/${local.name}-queues"
  target_key_id = aws_kms_key.queues.key_id
}

locals {
  queue_names = ["workforce-jobs", "payroll-jobs", "platform-jobs"]
}

resource "aws_sqs_queue" "dlq" {
  for_each = toset(local.queue_names)

  name                      = "${local.name}-${each.value}-dlq"
  message_retention_seconds = local.dlq_retention_seconds
  kms_master_key_id         = aws_kms_key.queues.id
  # Short, because a DLQ is read by a human with a console open, not polled by a service.
  kms_data_key_reuse_period_seconds = 300

  tags = { Name = "${local.name}-${each.value}-dlq", Role = "dead-letter" }
}

resource "aws_sqs_queue" "main" {
  for_each = toset(local.queue_names)

  name                       = "${local.name}-${each.value}"
  visibility_timeout_seconds = local.visibility_timeout_seconds
  message_retention_seconds  = 345600 # 4 days
  # Long polling. Set here as well as in the client so a future consumer cannot accidentally
  # busy-poll the queue and pay for it.
  receive_wait_time_seconds         = 20
  kms_master_key_id                 = aws_kms_key.queues.id
  kms_data_key_reuse_period_seconds = 300

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.value].arn
    maxReceiveCount     = local.max_receive_count
  })

  tags = { Name = "${local.name}-${each.value}" }
}

resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  for_each = toset(local.queue_names)

  queue_url = aws_sqs_queue.dlq[each.value].id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.main[each.value].arn]
  })
}

/**
 * Alarms.
 *
 * A message in a dead letter queue means work that was accepted and never done — an
 * attendance day never closed, a payslip never produced. There is no acceptable non-zero
 * value, so the threshold is zero and it pages.
 */
resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  for_each = toset(local.queue_names)

  alarm_name          = "${local.name}-${each.value}-dlq-not-empty"
  alarm_description   = "A ${each.value} message could not be processed. Work was accepted and never done."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = { QueueName = aws_sqs_queue.dlq[each.value].name }
  alarm_actions = [aws_sns_topic.alerts.arn]
}

/**
 * Queue depth.
 *
 * Not an error on its own — a payroll run legitimately produces thousands of messages — so
 * this alarms on age rather than count. A message older than fifteen minutes means the
 * consumers are not keeping up or have stopped, which count alone cannot distinguish.
 */
resource "aws_cloudwatch_metric_alarm" "queue_age" {
  for_each = toset(local.queue_names)

  alarm_name          = "${local.name}-${each.value}-backlog-age"
  alarm_description   = "Oldest ${each.value} message is over 15 minutes old; consumers are not keeping up."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 900
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions    = { QueueName = aws_sqs_queue.main[each.value].name }
  alarm_actions = [aws_sns_topic.alerts.arn]
}

resource "aws_sns_topic" "alerts" {
  name              = "${local.name}-alerts"
  kms_master_key_id = aws_kms_key.queues.id
}
