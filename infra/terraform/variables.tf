variable "aws_region" {
  type        = string
  default     = "ap-southeast-1"
  description = "AWS region. Singapore is closest to Metro Manila."
}

variable "project" {
  type        = string
  default     = "sakay-api"
  description = "Project tag prefix for all resources."
}

variable "environment" {
  type        = string
  default     = "prod"
  description = "Environment name (prod | staging). Drives resource naming."
}

variable "instance_type" {
  type        = string
  default     = "t4g.micro"
  description = "ARM Graviton instance. ~$7.74/mo on-demand in ap-southeast-1."
}

variable "ebs_size_gb" {
  type        = number
  default     = 20
  description = "Root volume size. 20GB gp3 is well within free tier."
}

variable "domain_name" {
  type        = string
  default     = ""
  description = "Apex domain (e.g. sansasakay.example). Leave empty to skip Route 53 + SES."
}

variable "api_subdomain" {
  type        = string
  default     = "api"
  description = "Subdomain for the API (api.<domain_name>)."
}

variable "ghcr_image" {
  type        = string
  default     = "ghcr.io/REPLACE-ME/sakay-api:latest"
  description = "GHCR image the EC2 will pull on boot. Updated by deploy.yml."
}

variable "letsencrypt_email" {
  type        = string
  default     = ""
  description = "Email Let's Encrypt notifies on cert expiry. Required if domain_name is set."
}

variable "ssh_pubkey" {
  type        = string
  default     = ""
  description = "Optional SSH public key. Leave empty to use EC2 Instance Connect only."
}
