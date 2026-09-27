/**
 * Task roles.
 *
 * Least privilege, enforced by being specific: every statement names the exact queue,
 * bucket prefix or secret it needs. No wildcards on resources, no managed policies beyond
 * the ECS execution role AWS requires.
 *
 * Two roles per service, for two different principals:
 *
 *   * the **execution role** is used by the ECS agent to pull the image and fetch the
 *     secrets it injects. The application never assumes it.
 *   * the **task role** is what the application's AWS SDK resolves. It is the only AWS
 *     identity the code ever has, which is why there is no access key anywhere in this
 *     stack — nothing to leak, nothing to rotate, nothing to commit by accident.
 *
 * The API and the worker have deliberately different permissions. The API issues presigned
 * URLs and sends messages; it never receives or deletes one. The worker receives and
 * deletes; it does not need to presign. Splitting them means a compromised API task cannot
 * consume the payroll queue.
 */

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    # Confused-deputy guard: this role may only be assumed on behalf of tasks in this
    # account, not by another account that learns the role's ARN.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

# ---------------------------------------------------------------------------
# Execution role: pull images, write logs, read the secrets ECS injects.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.database_url.arn,
      aws_secretsmanager_secret.platform_database_url.arn,
      aws_secretsmanager_secret.jwt.arn,
      aws_secretsmanager_secret.field_encryption_key.arn,
      aws_secretsmanager_secret.redis_url.arn,
    ]
  }

  statement {
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.secrets.arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# ---------------------------------------------------------------------------
# API task role.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "api_task" {
  name               = "${local.name}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "api_task" {
  # Produces events. Never consumes: the API must not be able to drain a queue.
  statement {
    sid       = "PublishEvents"
    effect    = "Allow"
    actions   = ["sqs:SendMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"]
    resources = [for q in aws_sqs_queue.main : q.arn]
  }

  # Presigns and reads document metadata. `s3:DeleteObject` is absent on purpose — a
  # statutory record is not deleted by a request handler.
  statement {
    sid       = "Documents"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:GetObjectAttributes"]
    resources = ["${aws_s3_bucket.documents.arn}/tenants/*"]
  }

  statement {
    sid       = "DocumentBucketMetadata"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.documents.arn]
  }

  statement {
    sid       = "DocumentEncryption"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.documents.arn]
  }

  statement {
    sid       = "QueueEncryption"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.queues.arn]
  }

  # Transactional mail only, and only from the verified identity.
  statement {
    sid       = "SendMail"
    effect    = "Allow"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = [aws_ses_domain_identity.main.arn]
    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = ["no-reply@${var.ses_domain}"]
    }
  }
}

resource "aws_iam_role_policy" "api_task" {
  name   = "api"
  role   = aws_iam_role.api_task.id
  policy = data.aws_iam_policy_document.api_task.json
}

# ---------------------------------------------------------------------------
# Worker task role. The scheduler runs the same image and shares this role: the scheduler
# emits to the outbox and the worker publishes, so both need send, and neither needs more.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "worker_task" {
  name               = "${local.name}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "worker_task" {
  statement {
    sid    = "ConsumeAndPublish"
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:SendMessage",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
    ]
    resources = [for q in aws_sqs_queue.main : q.arn]
  }

  # The worker never reads the dead letter queues; a human does, from the console. Redriving
  # is an operator action with a human decision behind it, not something a loop should do.

  statement {
    sid       = "WritePayslips"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.documents.arn}/tenants/*"]
  }

  statement {
    sid       = "DocumentEncryption"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.documents.arn]
  }

  statement {
    sid       = "QueueEncryption"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.queues.arn]
  }

  statement {
    sid       = "SendMail"
    effect    = "Allow"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = [aws_ses_domain_identity.main.arn]
    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = ["no-reply@${var.ses_domain}"]
    }
  }
}

resource "aws_iam_role_policy" "worker_task" {
  name   = "worker"
  role   = aws_iam_role.worker_task.id
  policy = data.aws_iam_policy_document.worker_task.json
}
