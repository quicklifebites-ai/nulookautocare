CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_text TEXT NOT NULL CHECK (length(review_text) BETWEEN 10 AND 1200),
  image_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  created_at TEXT NOT NULL,
  moderated_at TEXT,
  approved_at TEXT,
  ip_hash TEXT,
  notification_error TEXT
);

CREATE INDEX IF NOT EXISTS reviews_public_index ON reviews(status, approved_at DESC);
CREATE INDEX IF NOT EXISTS reviews_created_index ON reviews(created_at DESC);
CREATE INDEX IF NOT EXISTS reviews_ip_created_index ON reviews(ip_hash, created_at DESC);
