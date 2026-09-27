terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State holds database endpoints and secret ARNs, so it is sensitive. Configured with
  # `-backend-config` rather than hardcoded, so the same code serves every environment
  # without one being able to read another's state.
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = merge(
      {
        Project     = var.project
        Environment = var.environment
        ManagedBy   = "terraform"
        # Payroll and employee records. Tagged so cost, access review and data-classification
        # tooling can all find this estate without anyone maintaining a second list.
        DataClass = "confidential-pii"
      },
      var.tags,
    )
  }
}

data "aws_caller_identity" "current" {}

locals {
  name = "${var.project}-${var.environment}"

  # One place that decides what a service is called, so a log group, a task role and a
  # security group can never drift apart.
  services = {
    api       = "${var.project}-${var.environment}-api"
    worker    = "${var.project}-${var.environment}-worker"
    scheduler = "${var.project}-${var.environment}-scheduler"
  }
}
