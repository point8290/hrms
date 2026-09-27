/**
 * Load balancer.
 *
 * The only thing in this stack with a public address. HTTPS only — there is no port 80
 * listener, not even a redirect, because a redirect is a request that already travelled in
 * the clear and for this API that request may carry a bearer token.
 */

resource "aws_lb" "main" {
  name               = local.name
  load_balancer_type = "application"
  internal           = false
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]

  # Longer than the slowest legitimate request. Payroll calculation for a large tenant is
  # asynchronous, so nothing here should be close to it; the margin is for safety, not use.
  idle_timeout = 60

  enable_deletion_protection = var.environment == "production"
  drop_invalid_header_fields = true

  access_logs {
    bucket  = aws_s3_bucket.access_logs.id
    prefix  = "alb"
    enabled = true
  }

  tags = { Name = local.name }
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name}-api"
  port        = 4000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  /**
   * Readiness, not liveness. This decides whether a task receives traffic, so it *should*
   * check the database — a task that cannot reach it has nothing useful to say. The
   * container health check asks the opposite question (/health/live) and deliberately
   * checks nothing, so a database blip does not restart every task at once.
   */
  health_check {
    path                = "/health/ready"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # Long enough for an in-flight request to finish, short enough that a deploy is not slow.
  deregistration_delay = 30

  # Stateless by design: the token carries everything, so any task can serve any request.
  stickiness {
    type    = "lb_cookie"
    enabled = false
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  # TLS 1.2 floor. The 1.3-only policies still exclude too many corporate proxies that HR
  # departments sit behind.
  ssl_policy      = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}
