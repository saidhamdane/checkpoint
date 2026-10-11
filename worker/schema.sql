CREATE TABLE IF NOT EXISTS decisions (
  id             TEXT PRIMARY KEY,
  key_id         TEXT NOT NULL,
  agent_id       TEXT,
  tool           TEXT NOT NULL,
  action_json    TEXT NOT NULL,
  decision       TEXT NOT NULL CHECK (decision IN ('allow','block','ask')),
  risk           REAL,
  reason         TEXT,
  triggered_json TEXT,
  latency_ms     INTEGER,
  degraded       INTEGER NOT NULL DEFAULT 0,
  status         TEXT CHECK (status IN ('pending','approved','denied','expired')),
  expires_at     INTEGER,
  resolved_by    TEXT,
  resolved_at    INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_key_created ON decisions (key_id, created_at);

CREATE TABLE IF NOT EXISTS waitlist (
  email      TEXT PRIMARY KEY,
  ip_hash    TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  telegram_chat_id    TEXT,
  telegram_link_token TEXT UNIQUE,
  monthly_limit       INTEGER,
  ip_hash             TEXT,
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_ip_created ON users (ip_hash, created_at);

CREATE TABLE IF NOT EXISTS api_keys (
  hash       TEXT PRIMARY KEY,
  key_id     TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  prefix     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_id ON api_keys (key_id);

CREATE TABLE IF NOT EXISTS settings (
  user_id       TEXT PRIMARY KEY,
  policies_json TEXT,
  updated_at    INTEGER
);

CREATE TABLE IF NOT EXISTS usage (
  user_id TEXT NOT NULL,
  period  TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period)
);
