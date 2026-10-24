-- Pool Rush: 80/20 — Postgres schema (virtual coins only, NO cash-out)
-- Run: psql $DATABASE_URL -f db/schema.sql
-- The Node backend mirrors these tables exactly in its in-memory store
-- when DATABASE_URL is not set, so `npm run dev` works with no Postgres.
-- With DATABASE_URL set, the backend uses Postgres for users/wallets/ledger
-- and keeps live round state in Redis if REDIS_URL is set, else in-process.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tiers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  seat_price INTEGER NOT NULL CHECK (seat_price > 0),
  target_seats INTEGER NOT NULL CHECK (target_seats > 0),
  max_duration_seconds INTEGER NOT NULL DEFAULT 180,
  lock_bell_seconds INTEGER NOT NULL DEFAULT 20,
  priority_seconds INTEGER NOT NULL DEFAULT 5,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rounds_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  house_cut_bps INTEGER NOT NULL DEFAULT 1000, -- 1000 bps = 10%
  shield_activation_bps INTEGER NOT NULL DEFAULT 1000, -- 10% of seat price, paid upfront to house
  shield_rescue_bps INTEGER NOT NULL DEFAULT 2000, -- 20% of rescued stake, paid to shielder
  last_call_bps_of_losers INTEGER NOT NULL DEFAULT 500, -- 5% of losers pool
  streak_to_unlock INTEGER NOT NULL DEFAULT 3,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO rounds_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  display_name TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  streak INTEGER NOT NULL DEFAULT 0,
  gold_front_row BOOLEAN NOT NULL DEFAULT FALSE,
  total_front_wins INTEGER NOT NULL DEFAULT 0,
  total_rounds_played INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Double-entry ledger: every transfer_id must balance (sum(debit)=sum(credit)).
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id UUID NOT NULL,
  account TEXT NOT NULL, -- e.g. 'user:<uuid>', 'escrow:<roundId>', 'house', 'mint', 'shop'
  user_id UUID REFERENCES users(id),
  debit INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
  ref_type TEXT NOT NULL, -- topup | join | payout | house_cut | shield_activation | shield_rescue | last_call | shop | starter
  ref_id TEXT,
  memo TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (debit = 0 OR credit = 0)
);
CREATE INDEX IF NOT EXISTS idx_ledger_transfer ON wallet_ledger(transfer_id);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON wallet_ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON wallet_ledger(account, created_at DESC);

CREATE TABLE IF NOT EXISTS rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_id TEXT NOT NULL REFERENCES tiers(id),
  status TEXT NOT NULL DEFAULT 'priority', -- priority | open | lock_bell | closed | frozen
  seat_price INTEGER NOT NULL,
  target_seats INTEGER NOT NULL,
  filled_seats INTEGER NOT NULL DEFAULT 0,
  server_seed TEXT NOT NULL,
  server_seed_hash TEXT NOT NULL,
  snapshot_hash TEXT,
  snapshot_json JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  priority_ends_at TIMESTAMPTZ,
  open_ends_at TIMESTAMPTZ,
  lock_bell_ends_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  house_cut_amount INTEGER NOT NULL DEFAULT 0,
  losers_pool INTEGER NOT NULL DEFAULT 0,
  distributable INTEGER NOT NULL DEFAULT 0,
  frozen_reason TEXT
);

CREATE TABLE IF NOT EXISTS seats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  seat_count INTEGER NOT NULL DEFAULT 1 CHECK (seat_count IN (1,2)),
  amount_paid INTEGER NOT NULL CHECK (amount_paid > 0),
  base_price INTEGER NOT NULL,
  row TEXT NOT NULL CHECK (row IN ('front','back')),
  is_boost BOOLEAN NOT NULL DEFAULT FALSE,
  is_bell_shuffle BOOLEAN NOT NULL DEFAULT FALSE,
  shielded_by UUID REFERENCES users(id),
  is_shielded BOOLEAN NOT NULL DEFAULT FALSE,
  placed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  seat_id UUID REFERENCES seats(id),
  stake_back INTEGER NOT NULL DEFAULT 0,
  profit_share INTEGER NOT NULL DEFAULT 0,
  shield_rescue_fee INTEGER NOT NULL DEFAULT 0,
  last_call_bonus INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL, -- front_win | front_refund | back_loss | back_shielded | last_call
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shop_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL, -- frame | emote | theme | badge
  price INTEGER NOT NULL CHECK (price > 0),
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS user_items (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES shop_items(id),
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);

INSERT INTO tiers (id, name, seat_price, target_seats) VALUES
  ('bronze','Bronze',100,20),
  ('silver','Silver',500,20),
  ('gold','Gold',2000,20)
ON CONFLICT (id) DO NOTHING;

INSERT INTO shop_items (id, name, kind, price, description) VALUES
  ('frame-gold','Gold Frame','frame',500,'Gold avatar frame'),
  ('frame-neon','Neon Frame','frame',1200,'Neon avatar frame'),
  ('emote-bell','Bell Ringer Emote','emote',300,'Ring the Lock Bell emote'),
  ('theme-midnight','Midnight Pool Theme','theme',2000,'Dark pool theme'),
  ('badge-front','Front Row Badge','badge',5000,'Front Row legend badge')
ON CONFLICT (id) DO NOTHING;
