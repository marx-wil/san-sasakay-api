-- 0012_pending_signups.sql
-- Holds signup payloads until the user enters the email OTP. Cognito user is
-- created only after verification (AdminCreateUser + AdminSetUserPassword).

CREATE TABLE IF NOT EXISTS pending_signups (
  email_hash          TEXT PRIMARY KEY,
  code_hash           TEXT NOT NULL,
  password_ciphertext TEXT NOT NULL,
  first_name          TEXT NOT NULL,
  last_name           TEXT NOT NULL,
  phone_e164          TEXT,
  attempts            INT NOT NULL DEFAULT 0,
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pending_signups_expires_idx
  ON pending_signups (expires_at);
