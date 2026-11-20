-- Orixas: conturi + rezervari Founder Bundle
-- Ruleaza cu: npm run db:local  (sau db:remote / wrangler d1 execute --remote)

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  cui TEXT NOT NULL,
  role TEXT NOT NULL,
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'reserved',
  seat_number INTEGER,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts (email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_seat ON accounts (seat_number);
CREATE INDEX IF NOT EXISTS idx_accounts_created_at ON accounts (created_at);

CREATE TABLE IF NOT EXISTS founder_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total_seats INTEGER NOT NULL
);

INSERT INTO founder_config (id, total_seats)
VALUES (1, 20)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS founder_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seat_number INTEGER,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);
