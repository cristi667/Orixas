-- Orixas: avans 50 EUR prin Stripe + retragere din contract (OUG 18/2026)
-- Worker-ul aplica automat aceste modificari (ensureSchema), fisierul este pentru rulare manuala.

ALTER TABLE accounts ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid';
ALTER TABLE accounts ADD COLUMN amount_cents INTEGER;
ALTER TABLE accounts ADD COLUMN currency TEXT;
ALTER TABLE accounts ADD COLUMN stripe_session_id TEXT;
ALTER TABLE accounts ADD COLUMN stripe_checkout_url TEXT;
ALTER TABLE accounts ADD COLUMN stripe_payment_intent TEXT;
ALTER TABLE accounts ADD COLUMN checkout_expires_at TEXT;
ALTER TABLE accounts ADD COLUMN paid_at TEXT;
ALTER TABLE accounts ADD COLUMN refunded_at TEXT;
ALTER TABLE accounts ADD COLUMN withdrawal_requested_at TEXT;
ALTER TABLE accounts ADD COLUMN terms_version TEXT;
ALTER TABLE accounts ADD COLUMN terms_accepted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_accounts_payment ON accounts (payment_status);

CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL,
  account_id TEXT,
  email TEXT NOT NULL,
  name TEXT,
  reason TEXT,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL,
  refund_status TEXT,
  refund_id TEXT,
  email_status TEXT,
  note TEXT
);
