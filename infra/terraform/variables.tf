variable "project" {
  description = "Resource name prefix. Everything this stack creates starts with it."
  type        = string
  default     = "hrms"
}

variable "environment" {
  description = "Deployment environment. Part of every resource name, so two environments cannot collide."
  type        = string

  validation {
    condition     = contains(["production", "staging", "development"], var.environment)
    error_message = "environment must be production, staging or development."
  }
}

variable "aws_region" {
  type    = string
  default = "ap-south-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "availability_zones" {
  description = "At least two. RDS Multi-AZ and the ALB both require a subnet in each."
  type        = list(string)
  default     = ["ap-south-1a", "ap-south-1b"]

  validation {
    condition     = length(var.availability_zones) >= 2
    error_message = "At least two availability zones are required for a Multi-AZ database and an ALB."
  }
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 100
}

variable "db_backup_retention_days" {
  description = "Payroll data. Seven days is the floor, not a target."
  type        = number
  default     = 30

  validation {
    condition     = var.db_backup_retention_days >= 7
    error_message = "Payroll data requires at least seven days of backup retention."
  }
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "api_image" {
  description = "Fully qualified image reference for the API."
  type        = string
}

variable "worker_image" {
  description = "Fully qualified image reference for the worker. The scheduler runs the same image."
  type        = string
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "worker_desired_count" {
  type    = number
  default = 2
}

variable "scheduler_desired_count" {
  description = <<-EOT
    Scheduler replicas. Two is the recommended value: claiming uses FOR UPDATE SKIP LOCKED,
    so a second replica is redundancy rather than a race, and a scheduler that is down means
    attendance silently stops closing.
  EOT
  type        = number
  default     = 2
}

variable "certificate_arn" {
  description = "ACM certificate for the ALB listener. TLS is not optional; there is no HTTP-only path."
  type        = string
}

variable "cors_origins" {
  description = "Comma-separated origins allowed to call the API from a browser."
  type        = string
}

variable "ses_domain" {
  description = "Domain used as the envelope sender for outbound mail."
  type        = string
}

variable "log_retention_days" {
  type    = number
  default = 90
}

variable "tags" {
  type    = map(string)
  default = {}
}
