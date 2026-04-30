# SES domain identity + DKIM. Skipped entirely if no domain is provided.
# After apply, copy the DKIM CNAME records from `terraform output` into your DNS.

resource "aws_ses_domain_identity" "this" {
  count  = var.domain_name == "" ? 0 : 1
  domain = var.domain_name
}

resource "aws_ses_domain_dkim" "this" {
  count  = var.domain_name == "" ? 0 : 1
  domain = aws_ses_domain_identity.this[0].domain
}

resource "aws_ses_configuration_set" "this" {
  count                       = var.domain_name == "" ? 0 : 1
  name                        = "${var.project}-${var.environment}"
  reputation_metrics_enabled  = true
  sending_enabled             = true
}
