# ─── GitHub Actions OIDC: identity provider + deploy role ──────────────────
# Lets the `deploy.yml` workflow in ${var.github_repo} assume an AWS role
# with no long-lived access keys. The role can only call SSM SendCommand
# on the EC2 instance in this region.
#
# If an OIDC provider for GitHub already exists in this AWS account (e.g.
# from another Terraform workspace or a manual click-ops setup), import it
# before the first apply:
#
#   terraform import aws_iam_openid_connect_provider.github_actions \
#     arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com

variable "github_repo" {
  type        = string
  default     = "marx-wil/san-sasakay-api"
  description = "GitHub repo (owner/name) allowed to assume the deploy role."
}

resource "aws_iam_openid_connect_provider" "github_actions" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # AWS auto-validates this thumbprint for the GitHub Actions issuer, so the
  # value is effectively a formality. Hardcoded to avoid pulling the tls
  # provider just for one fingerprint lookup.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

resource "aws_iam_role" "github_deploy" {
  name = "${local.name_prefix}-github-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = aws_iam_openid_connect_provider.github_actions.arn }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        # Lock to the main branch of this specific repo. Widen to
        # "repo:${var.github_repo}:*" if you later deploy from tags/envs.
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:ref:refs/heads/main"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_deploy_ssm" {
  name = "${local.name_prefix}-github-deploy-ssm"
  role = aws_iam_role.github_deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SendDeployCommand"
        Effect = "Allow"
        Action = ["ssm:SendCommand"]
        Resource = [
          "arn:aws:ec2:${var.aws_region}:*:instance/*",
          "arn:aws:ssm:${var.aws_region}::document/AWS-RunShellScript",
        ]
      },
      {
        Sid      = "PollCommandStatus"
        Effect   = "Allow"
        Action   = ["ssm:ListCommandInvocations", "ssm:GetCommandInvocation"]
        Resource = "*"
      },
    ]
  })
}
