terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }
  # For a single-VM MVP, local state is fine. Migrate to S3+DynamoDB backend
  # the day a second engineer joins this repo.
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

locals {
  name_prefix = "${var.project}-${var.environment}"
}

# ─── Networking: use the default VPC + default subnets ──────────────────────
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

# ─── Security group: SSH (your IP only), HTTP, HTTPS ────────────────────────
data "http" "my_ip" {
  url = "https://checkip.amazonaws.com"
}

locals {
  my_ip_cidr = "${chomp(data.http.my_ip.response_body)}/32"
}

resource "aws_security_group" "api" {
  name        = "${local.name_prefix}-sg"
  description = "Sakay API EC2 SG. HTTP + HTTPS public, SSH from operator IP only."
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP (Lets Encrypt + redirect)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "SSH (operator IP only)"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [local.my_ip_cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ─── S3 bucket for daily backups ────────────────────────────────────────────
resource "aws_s3_bucket" "backups" {
  bucket        = "${local.name_prefix}-backups"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    id     = "expire-30d"
    status = "Enabled"
    filter { prefix = "" }
    expiration {
      days = 30
    }
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}

# ─── IAM: instance profile with S3 backup write + SSM + CloudWatch + SES ────
data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${local.name_prefix}-ec2-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "cw_agent" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

data "aws_iam_policy_document" "instance_inline" {
  statement {
    sid     = "BackupWrite"
    actions = ["s3:PutObject", "s3:AbortMultipartUpload", "s3:GetObject", "s3:ListBucket"]
    resources = [
      aws_s3_bucket.backups.arn,
      "${aws_s3_bucket.backups.arn}/*",
    ]
  }
  statement {
    sid       = "SesSend"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "instance_inline" {
  name   = "${local.name_prefix}-inline"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.instance_inline.json
}

resource "aws_iam_instance_profile" "instance" {
  name = "${local.name_prefix}-profile"
  role = aws_iam_role.instance.name
}

# ─── EC2 + Elastic IP ───────────────────────────────────────────────────────
data "aws_ami" "al2023_arm" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-arm64"]
  }
  filter {
    name   = "architecture"
    values = ["arm64"]
  }
}

resource "aws_key_pair" "operator" {
  count      = var.ssh_pubkey == "" ? 0 : 1
  key_name   = "${local.name_prefix}-operator"
  public_key = var.ssh_pubkey
}

resource "aws_instance" "api" {
  ami                    = data.aws_ami.al2023_arm.id
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.api.id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name
  key_name               = var.ssh_pubkey == "" ? null : aws_key_pair.operator[0].key_name

  associate_public_ip_address = true

  root_block_device {
    volume_type = "gp3"
    volume_size = var.ebs_size_gb
    encrypted   = true
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  user_data = templatefile("${path.module}/../cloud-init/user-data.sh", {
    domain_name       = var.domain_name
    api_subdomain     = var.api_subdomain
    ghcr_image        = var.ghcr_image
    letsencrypt_email = var.letsencrypt_email
    s3_backup_bucket  = aws_s3_bucket.backups.bucket
    aws_region        = var.aws_region
    resend_api_key    = var.resend_api_key
    public_api_url    = var.domain_name == "" ? "" : "https://${var.api_subdomain}.${var.domain_name}"
    # Web URL is independent of the API URL: emails CTA + CORS go here.
    # Falls back to the apex domain when not explicitly set, so a deploy
    # with just `domain_name` set keeps working.
    public_web_url = var.public_web_url != "" ? var.public_web_url : (var.domain_name == "" ? "" : "https://${var.domain_name}")
  })

  tags = {
    Name = "${local.name_prefix}-ec2"
  }
}

resource "aws_eip" "api" {
  instance = aws_instance.api.id
  domain   = "vpc"
  tags = {
    Name = "${local.name_prefix}-eip"
  }
}
