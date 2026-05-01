output "instance_id" {
  value       = aws_instance.api.id
  description = "EC2 instance ID. Use with `aws ssm start-session --target <id>` for shell access."
}

output "public_ip" {
  value       = aws_eip.api.public_ip
  description = "Static public IP. Point your DNS A record at this."
}

output "public_dns" {
  value       = aws_instance.api.public_dns
  description = "Default AWS public DNS for the instance."
}

output "backups_bucket" {
  value       = aws_s3_bucket.backups.bucket
  description = "S3 bucket where pg_dump uploads daily."
}

output "ses_dkim_records" {
  value = var.domain_name == "" ? [] : [
    for token in aws_ses_domain_dkim.this[0].dkim_tokens :
    {
      name  = "${token}._domainkey.${var.domain_name}"
      type  = "CNAME"
      value = "${token}.dkim.amazonses.com"
    }
  ]
  description = "DKIM CNAME records to create in your DNS to verify SES."
}

output "ses_verification_token" {
  value       = var.domain_name == "" ? "" : aws_ses_domain_identity.this[0].verification_token
  description = "Add as TXT _amazonses.<domain> to verify SES domain identity."
}

output "dns_a_record" {
  value = var.domain_name == "" ? "" : "${var.api_subdomain}.${var.domain_name} A ${aws_eip.api.public_ip}"
  description = "DNS A record for the API subdomain."
}

output "github_deploy_role_arn" {
  value       = aws_iam_role.github_deploy.arn
  description = "Copy into the GitHub repo secret AWS_DEPLOY_ROLE_ARN."
}
