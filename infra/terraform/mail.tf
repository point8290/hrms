/**
 * Outbound mail.
 *
 * Notifications are the only way the system tells an employee that their payslip exists or
 * that their leave was decided, so deliverability is a correctness concern rather than a
 * marketing one. DKIM and a configuration set that reports bounces are the minimum: a
 * bounced payslip notification nobody sees is indistinguishable from one never sent.
 */

resource "aws_ses_domain_identity" "main" {
  domain = var.ses_domain
}

resource "aws_ses_domain_dkim" "main" {
  domain = aws_ses_domain_identity.main.domain
}

resource "aws_ses_configuration_set" "main" {
  name = local.name

  delivery_options {
    tls_policy = "Require"
  }

  reputation_metrics_enabled = true
}

# Bounces and complaints go somewhere a human will see them, rather than accumulating
# against the sending reputation until SES throttles the account mid-payroll.
resource "aws_ses_event_destination" "bounces" {
  name                   = "${local.name}-bounces"
  configuration_set_name = aws_ses_configuration_set.main.name
  enabled                = true
  matching_types         = ["bounce", "complaint", "reject", "renderingFailure"]

  sns_destination {
    topic_arn = aws_sns_topic.alerts.arn
  }
}
