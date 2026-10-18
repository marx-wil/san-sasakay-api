# Cognito user pool for email+password auth (mobile + API InitiateAuth).

resource "aws_cognito_user_pool" "commuters" {
  name = "${local.name_prefix}-commuters"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = false
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
  }

  schema {
    name                = "given_name"
    attribute_data_type = "String"
    required            = false
    mutable             = true
  }

  schema {
    name                = "family_name"
    attribute_data_type = "String"
    required            = false
    mutable             = true
  }

  schema {
    name                = "phone_number"
    attribute_data_type = "String"
    required            = false
    mutable             = true
  }

  email_configuration {
    email_sending_account = var.domain_name == "" ? "COGNITO_DEFAULT" : "DEVELOPER"
    from_email_address    = var.domain_name == "" ? null : "no-reply@${var.domain_name}"
    source_arn            = var.domain_name == "" ? null : aws_ses_domain_identity.this[0].arn
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "I-verify ang San Sasakay account mo"
    email_message        = "Ang verification code mo ay {####}. Mag-e-expire ito sa loob ng 24 oras."
  }
}

resource "aws_cognito_user_pool_client" "mobile" {
  name         = "${local.name_prefix}-mobile"
  user_pool_id = aws_cognito_user_pool.commuters.id

  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH",
  ]

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
}
