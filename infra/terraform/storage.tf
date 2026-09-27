/**
 * Document storage.
 *
 * This bucket holds payslips, signed contracts and identity documents. Every object is
 * reached through a short-lived presigned URL issued by the API after an authorization
 * check; nothing is public, and no object is ever served from a path a client can guess.
 */

resource "aws_kms_key" "documents" {
  description             = "${local.name} document encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = { Name = "${local.name}-documents" }
}

resource "aws_kms_alias" "documents" {
  name          = "alias/${local.name}-documents"
  target_key_id = aws_kms_key.documents.key_id
}

resource "aws_s3_bucket" "documents" {
  bucket = "${local.name}-documents-${data.aws_caller_identity.current.account_id}"

  tags = { Name = "${local.name}-documents" }
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket = aws_s3_bucket.documents.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.documents.arn
    }
    # Cuts KMS calls on a four-thousand-payslip run from four thousand to a handful.
    bucket_key_enabled = true
  }
}

# Versioning is the recovery path for a bad delete. A payslip is a statutory record; losing
# one to a mistaken lifecycle rule is not recoverable from a database backup, because the
# database holds the metadata, not the PDF.
resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  # Orphan objects: an upload whose transaction then failed leaves an object no document row
  # references. The payslip handler uploads before it writes the row precisely so this is the
  # failure mode rather than the reverse, and this rule cleans up after it.
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }

  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 90 }
  }

  # Payslips are read in the weeks after payday and then almost never. Nothing is deleted:
  # statutory retention in India is years, and the storage is a rounding error next to the
  # cost of not having a record during an audit.
  rule {
    id     = "archive-cold-documents"
    status = "Enabled"
    filter {}
    transition {
      days          = 180
      storage_class = "STANDARD_IA"
    }
  }
}

# Deny anything that is not TLS, and anything that is not encrypted with this key. A
# presigned URL that somehow omitted encryption headers should fail, not succeed quietly.
resource "aws_s3_bucket_policy" "documents" {
  bucket = aws_s3_bucket.documents.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.documents.arn,
          "${aws_s3_bucket.documents.arn}/*",
        ]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "DenyUnencryptedUploads"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.documents.arn}/*"
        Condition = {
          StringNotEquals = { "s3:x-amz-server-side-encryption" = "aws:kms" }
        }
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.documents]
}

# Object-level access to payroll documents is worth an audit trail of its own: "who
# downloaded this payslip" is a question that gets asked.
resource "aws_s3_bucket_logging" "documents" {
  bucket        = aws_s3_bucket.documents.id
  target_bucket = aws_s3_bucket.access_logs.id
  target_prefix = "documents/"
}

resource "aws_s3_bucket" "access_logs" {
  bucket = "${local.name}-access-logs-${data.aws_caller_identity.current.account_id}"
  tags   = { Name = "${local.name}-access-logs" }
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule { object_ownership = "BucketOwnerPreferred" }
}

resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration { days = 365 }
  }
}
