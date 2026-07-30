-- 0008_account_deletion_tokens.sql
-- One-time tokens for the public web account-deletion flow
-- (POST /account-deletion/request → email link → POST /account-deletion/confirm).
-- Mirrors magic_link_tokens: hash at rest, short TTL, single-use via used_at.

CREATE TABLE IF NOT EXISTS account_deletion_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS account_deletion_tokens_expires_idx
  ON account_deletion_tokens (expires_at);

CREATE INDEX IF NOT EXISTS account_deletion_tokens_user_idx
  ON account_deletion_tokens (user_id);
