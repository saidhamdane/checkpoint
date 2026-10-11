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
