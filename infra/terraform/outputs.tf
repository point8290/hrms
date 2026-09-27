/**
 * Outputs.
 *
 * Endpoints and ARNs only. No connection string, no password, no auth token — an output is
 * plaintext in state and in whatever printed the apply.
 */

output "alb_dns_name" {
  description = "Point the application's DNS record at this."
  value       = aws_lb.main.dns_name
}

output "database_endpoint" {
  description = "Private RDS endpoint. Reachable only from inside the VPC."
  value       = aws_db_instance.main.endpoint
}

output "redis_endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "documents_bucket" {
  value = aws_s3_bucket.documents.bucket
}

output "queue_urls" {
  description = "Set these as SQS_*_QUEUE_URL if configuring a service outside this stack."
  value       = { for name, q in aws_sqs_queue.main : name => q.url }
}

output "dead_letter_queue_urls" {
  description = "Where work that could never be processed ends up. Read by a human, not a service."
  value       = { for name, q in aws_sqs_queue.dlq : name => q.url }
}

output "secret_arns" {
  description = "Containers only. Set the values with `aws secretsmanager put-secret-value`."
  value = {
    database_url          = aws_secretsmanager_secret.database_url.arn
    platform_database_url = aws_secretsmanager_secret.platform_database_url.arn
    jwt                   = aws_secretsmanager_secret.jwt.arn
    field_encryption_key  = aws_secretsmanager_secret.field_encryption_key.arn
    redis_url             = aws_secretsmanager_secret.redis_url.arn
  }
}

output "ses_dkim_tokens" {
  description = "Create these as CNAME records before mail will be delivered."
  value       = aws_ses_domain_dkim.main.dkim_tokens
}

output "migrate_task_definition" {
  description = "Run before deploying a new service revision."
  value       = aws_ecs_task_definition.migrate.arn
}

output "alerts_topic_arn" {
  description = "Subscribe an on-call destination to this."
  value       = aws_sns_topic.alerts.arn
}
