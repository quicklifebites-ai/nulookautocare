-- Opaque moderation tokens keep approval links portable between Cloudflare
-- deployments without requiring an application signing secret. Only SHA-256
-- hashes are stored; the raw one-time tokens exist only in the email links.
CREATE TABLE IF NOT EXISTS review_moderation_tokens (
  review_id TEXT PRIMARY KEY,
  approve_token_hash TEXT NOT NULL UNIQUE,
  deny_token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS moderation_tokens_expiry_index
  ON review_moderation_tokens(expires_at);

-- The Worker creates the random value on first use. Keeping the pepper in D1
-- makes IP rate-limit hashes stable across Worker isolates without a secret.
CREATE TABLE IF NOT EXISTS review_app_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  created_at TEXT NOT NULL
);
