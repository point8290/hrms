/**
 * Redis.
 *
 * Rate limiting and short-lived coordination only. It is never a source of truth
 * (invariants.md #architecture), which is why this is a modest replication group rather
 * than a cluster: losing it degrades limit accuracy and nothing else, and the API is tested
 * against exactly that outage.
 *
 * It still gets encryption in transit, at rest, and an auth token. "Only cache data" is a
 * claim about present intent, not a guarantee about what a future change stores there.
 */

resource "aws_elasticache_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "random_password" "redis_auth" {
  length  = 64
  special = false # ElastiCache restricts the character set for AUTH tokens
}

resource "aws_elasticache_parameter_group" "main" {
  name   = local.name
  family = "redis7"

  # Evict the least recently used key when memory runs out rather than refusing writes. A
  # full Redis that starts erroring would push every request through the limiter's fail-open
  # path; dropping an old counter is the cheaper failure.
  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"
  }
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = local.name
  description          = "${local.name} rate limiting and coordination"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.redis_node_type
  port           = 6379

  num_cache_clusters         = var.environment == "production" ? 2 : 1
  automatic_failover_enabled = var.environment == "production"
  multi_az_enabled           = var.environment == "production"

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.cache.id]
  parameter_group_name = aws_elasticache_parameter_group.main.name

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.redis_auth.result

  # Rate-limit counters are worthless after a restart anyway. Not snapshotting avoids
  # persisting something that was never meant to be durable.
  snapshot_retention_limit = 0
  apply_immediately        = var.environment != "production"

  lifecycle {
    ignore_changes = [auth_token]
  }
}
