/**
 * ECS services.
 *
 * Three services from two images. The scheduler runs the *worker* image with
 * `WORKER_ROLES=scheduler`, which is the whole architectural point of the role split: job
 * execution and scheduling have opposite scaling pressures, and a worker fleet saturated by
 * a payroll run must not be the reason a tenant's attendance stops closing (ADR-010).
 *
 * Every secret arrives through `secrets`, never `environment`. A value in `environment` is
 * visible to anyone who can call `ecs:DescribeTaskDefinition`, which is a much wider set of
 * people than those who should be able to read a database password.
 */

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

locals {
  # Non-secret configuration, identical across the services so a difference is always
  # deliberate rather than an oversight in one of three copies.
  common_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "AWS_REGION", value = var.aws_region },
    { name = "QUEUE_DRIVER", value = "sqs" },
    { name = "STORAGE_DRIVER", value = "s3" },
    { name = "MAILER_DRIVER", value = "ses" },
    { name = "S3_BUCKET", value = aws_s3_bucket.documents.bucket },
    { name = "SQS_WORKFORCE_QUEUE_URL", value = aws_sqs_queue.main["workforce-jobs"].url },
    { name = "SQS_PAYROLL_QUEUE_URL", value = aws_sqs_queue.main["payroll-jobs"].url },
    { name = "SQS_PLATFORM_QUEUE_URL", value = aws_sqs_queue.main["platform-jobs"].url },
    { name = "SES_FROM_ADDRESS", value = "no-reply@${var.ses_domain}" },
    { name = "LOG_LEVEL", value = "info" },
  ]

  common_secrets = [
    { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
    { name = "PLATFORM_DATABASE_URL", valueFrom = aws_secretsmanager_secret.platform_database_url.arn },
    { name = "JWT_SECRET", valueFrom = aws_secretsmanager_secret.jwt.arn },
    { name = "FIELD_ENCRYPTION_KEY", valueFrom = aws_secretsmanager_secret.field_encryption_key.arn },
    { name = "REDIS_URL", valueFrom = aws_secretsmanager_secret.redis_url.arn },
  ]
}

# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "api" {
  family                   = local.services.api
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.api_task.arn

  container_definitions = jsonencode([{
    name      = "api"
    image     = var.api_image
    essential = true

    portMappings = [{ containerPort = 4000, protocol = "tcp" }]

    environment = concat(local.common_environment, [
      { name = "SERVICE_NAME", value = local.services.api },
      { name = "API_PORT", value = "4000" },
      { name = "CORS_ORIGINS", value = var.cors_origins },
    ])

    secrets = local.common_secrets

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.services["api"].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "api"
      }
    }

    # Liveness, not readiness. ECS restarts a container that fails this, so it must not
    # depend on the database: a database blip would otherwise restart every task at once and
    # turn a brief incident into a long one. Readiness is the load balancer's question, and
    # it asks /health/ready.
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://localhost:4000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }

    # Nothing in the image is written to at runtime; documents go to S3.
    readonlyRootFilesystem = true
    user                   = "node"
  }])
}

resource "aws_ecs_service" "api" {
  name            = local.services.api
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 4000
  }

  # Long enough for the RLS probe and the first health check. A too-short grace period makes
  # a rolling deploy kill healthy tasks before they finish starting.
  health_check_grace_period_seconds = 60

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Never fewer than the desired count during a deploy: payroll requests do not tolerate a
  # capacity dip, and there is no cost reason to accept one.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  enable_execute_command = var.environment != "production"

  depends_on = [aws_lb_listener.https]
}

# ---------------------------------------------------------------------------
# Worker: consumer, publisher, notifications. Scales with queue depth.
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "worker" {
  family                   = local.services.worker
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.worker_task.arn

  container_definitions = jsonencode([{
    name      = "worker"
    image     = var.worker_image
    essential = true

    environment = concat(local.common_environment, [
      { name = "SERVICE_NAME", value = local.services.worker },
      # Everything except the scheduler. Splitting the roles is a deployment decision, not a
      # code change — the same binary runs both services.
      { name = "WORKER_ROLES", value = "consumer,publisher,notifications" },
    ])

    secrets = local.common_secrets

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.services["worker"].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "worker"
      }
    }

    readonlyRootFilesystem = true
    user                   = "node"

    # SIGTERM finishes the current batch and lets anything half-processed be redelivered,
    # which is safe because every consumer is idempotent. Thirty seconds is generous for it.
    stopTimeout = 30
  }])
}

resource "aws_ecs_service" "worker" {
  name            = local.services.worker
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = false
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  enable_execute_command = var.environment != "production"
}

# ---------------------------------------------------------------------------
# Scheduler: the same image, one role.
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "scheduler" {
  family                   = local.services.scheduler
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  # Smaller than the worker on purpose: a tick is a handful of queries per tenant, and the
  # scheduler doing less work is part of why it is separated from job execution.
  cpu                = 512
  memory             = 1024
  execution_role_arn = aws_iam_role.execution.arn
  task_role_arn      = aws_iam_role.worker_task.arn

  container_definitions = jsonencode([{
    name      = "scheduler"
    image     = var.worker_image
    essential = true

    environment = concat(local.common_environment, [
      { name = "SERVICE_NAME", value = local.services.scheduler },
      { name = "WORKER_ROLES", value = "scheduler" },
      { name = "SCHEDULER_INTERVAL_MS", value = "300000" },
      { name = "SCHEDULER_BACKFILL_DAYS", value = "7" },
    ])

    secrets = local.common_secrets

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.services["scheduler"].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "scheduler"
      }
    }

    readonlyRootFilesystem = true
    user                   = "node"
    stopTimeout            = 30
  }])
}

resource "aws_ecs_service" "scheduler" {
  name            = local.services.scheduler
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.scheduler.arn
  desired_count   = var.scheduler_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = false
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # 100% minimum healthy: the scheduler is the one service whose downtime is invisible, so a
  # deploy must never leave zero of them running even briefly.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  enable_execute_command = var.environment != "production"
}

# ---------------------------------------------------------------------------
# Migrations: a task definition, never a service.
#
# Run once, before the new service revision is deployed. Running migrations at service
# start-up would race every replica starting at the same time, and a failed migration would
# present as a crash loop rather than a failed deploy step.
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.worker_task.arn

  container_definitions = jsonencode([{
    name      = "migrate"
    image     = var.api_image
    essential = true
    command   = ["node", "--experimental-strip-types", "src/infra/db/migrate.ts"]

    environment = [{ name = "NODE_ENV", value = "production" }]

    # The migration runner is the *only* thing that connects as the owner. The application
    # roles cannot create or alter a table, which is what keeps a compromised API task from
    # dropping a policy.
    secrets = [
      { name = "MIGRATION_DATABASE_URL", valueFrom = aws_secretsmanager_secret.db_master.arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.services["api"].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "migrate"
      }
    }
  }])
}
