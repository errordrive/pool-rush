// Store layer: same interface for Memory (default) and Postgres (when DATABASE_URL is set).
// Ledger rule (double-entry, enforced in both stores):
//   every transfer has entries [{account, debit, credit}] with sum(debit) == sum(credit).
//   A user wallet balance moves by (credit - debit) for account `user:<id>`.
//   Accounts: user:<id>, escrow:<roundId>, house, mint, shop.
// Virtual coins only. There is no cash-out account, ever.
const crypto = require('crypto');
const uuid = () => crypto.randomUUID();

const DEFAULT_TIERS = [
  { id: 'bronze', name: 'Bronze', seat_price: 100, target_seats: 20, max_duration_seconds: 180, lock_bell_seconds: 20, priority_seconds: 5, is_active: true },
  { id: 'silver', name: 'Silver', seat_price: 500, target_seats: 20, max_duration_seconds: 180, lock_bell_seconds: 20, priority_seconds: 5, is_active: true },
  { id: 'gold', name: 'Gold', seat_price: 2000, target_seats: 20, max_duration_seconds: 180, lock_bell_seconds: 20, priority_seconds: 5, is_active: true },
];
const DEFAULT_CONFIG = { house_cut_bps: 1000, shield_activation_bps: 1000, shield_rescue_bps: 2000, last_call_bps_of_losers: 500, streak_to_unlock: 3 };
const DEFAULT_SHOP = [
  { id: 'frame-gold', name: 'Gold Frame', kind: 'frame', price: 500, description: 'Gold avatar frame' },
  { id: 'frame-neon', name: 'Neon Frame', kind: 'frame', price: 1200, description: 'Neon avatar frame' },
  { id: 'emote-bell', name: 'Bell Ringer Emote', kind: 'emote', price: 300, description: 'Ring the Lock Bell emote' },
  { id: 'theme-midnight', name: 'Midnight Pool Theme', kind: 'theme', price: 2000, description: 'Dark pool theme' },
  { id: 'badge-front', name: 'Front Row Badge', kind: 'badge', price: 5000, description: 'Front Row legend badge' },
];
const TOPUP_PACKS = [
  { id: 'pack-1000', coins: 1000, label: '1,000 coins' },
  { id: 'pack-5000', coins: 5000, label: '5,000 coins' },
  { id: 'pack-20000', coins: 20000, label: '20,000 coins' },
  { id: 'pack-100000', coins: 100000, label: '100,000 coins' },
];

class MemoryStore {
  constructor() {
    this.users = new Map(); this.wallets = new Map(); this.ledger = [];
    this.tiers = new Map(DEFAULT_TIERS.map(t => [t.id, { ...t }]));
    this.config = { ...DEFAULT_CONFIG };
    this.rounds = new Map(); this.seats = new Map(); this.payouts = [];
    this.shop = new Map(DEFAULT_SHOP.map(s => [s.id, { ...s }])); this.userItems = new Map();
  }
  async getTiers() { return [...this.tiers.values()]; }
  async getTier(id) { return this.tiers.get(id) || null; }
  async upsertTier(t) { const cur = this.tiers.get(t.id) || {}; const next = { ...cur, ...t, updated_at: new Date().toISOString() }; this.tiers.set(t.id, next); return next; }
  async getConfig() { return { ...this.config }; }
  async updateConfig(p) { this.config = { ...this.config, ...p }; return { ...this.config }; }
  async createUser(username) {
    const id = uuid(); const u = { id, username, display_name: username, is_admin: false, streak: 0, gold_front_row: false, total_front_wins: 0, total_rounds_played: 0, created_at: new Date().toISOString() };
    this.users.set(id, u); this.wallets.set(id, 0); return u;
  }
  async getUserById(id) { return this.users.get(id) || null; }
  async getUserByUsername(name) { for (const u of this.users.values()) if (u.username === name) return u; return null; }
  async updateUser(u) { this.users.set(u.id, u); return u; }
  async getWallet(userId) { return { user_id: userId, balance: this.wallets.get(userId) || 0 }; }
  async postTransfer({ refType, refId, memo, entries }) {
    const d = entries.reduce((s, e) => s + (e.debit || 0), 0), c = entries.reduce((s, e) => s + (e.credit || 0), 0);
    if (d !== c) throw new Error(`Unbalanced transfer: debit ${d} != credit ${c}`);
    for (const e of entries) {
      if (e.account.startsWith('user:')) {
        const uid = e.account.slice(5); const nb = (this.wallets.get(uid) || 0) + (e.credit || 0) - (e.debit || 0);
        if (nb < 0) throw new Error('Insufficient coins');
      }
    }
    const tid = uuid();
    for (const e of entries) {
      if (e.account.startsWith('user:')) { const uid = e.account.slice(5); this.wallets.set(uid, (this.wallets.get(uid) || 0) + (e.credit || 0) - (e.debit || 0)); }
      this.ledger.push({ id: uuid(), transfer_id: tid, account: e.account, user_id: e.account.startsWith('user:') ? e.account.slice(5) : null, debit: e.debit || 0, credit: e.credit || 0, ref_type: refType, ref_id: refId || null, memo: memo || '', created_at: new Date().toISOString() });
    }
    return tid;
  }
  async listLedger(userId, limit = 100) { const rows = userId ? this.ledger.filter(l => l.user_id === userId) : this.ledger; return rows.slice(-limit).reverse(); }
  async createRound(r) { this.rounds.set(r.id, r); return r; }
  async getRound(id) { return this.rounds.get(id) || null; }
  async listRounds() { return [...this.rounds.values()].sort((a, b) => new Date(b.started_at) - new Date(a.started_at)); }
  async updateRound(r) { this.rounds.set(r.id, r); return r; }
  async createSeat(s) { this.seats.set(s.id, s); return s; }
  async listSeats(roundId) { return [...this.seats.values()].filter(s => s.round_id === roundId).sort((a, b) => a.seq - b.seq); }
  async updateSeat(s) { this.seats.set(s.id, s); return s; }
  async createPayout(p) { const row = { id: uuid(), ...p, created_at: new Date().toISOString() }; this.payouts.push(row); return row; }
  async listPayouts(roundId) { return this.payouts.filter(p => p.round_id === roundId); }
  async listUserPayouts(userId, limit = 50) { return this.payouts.filter(p => p.user_id === userId).slice(-limit).reverse(); }
  async getShop() { return [...this.shop.values()]; }
  async getUserItems(userId) { return [...(this.userItems.get(userId) || new Set())]; }
  async addUserItem(userId, itemId) { if (!this.userItems.has(userId)) this.userItems.set(userId, new Set()); this.userItems.get(userId).add(itemId); }
}

// Postgres store: implements the same methods against db/schema.sql.
// If the pool cannot connect, the server falls back to MemoryStore at boot
// and logs a clear warning (it never silently invents balances).
class PostgresStore {
  constructor(pool) { this.pool = pool; }
  async q(t, p = []) { return this.pool.query(t, p); }
  async getTiers() { const r = await this.q('SELECT * FROM tiers ORDER BY seat_price'); return r.rows; }
  async getTier(id) { const r = await this.q('SELECT * FROM tiers WHERE id=$1', [id]); return r.rows[0] || null; }
  async upsertTier(t) {
    const r = await this.q(`INSERT INTO tiers(id,name,seat_price,target_seats,max_duration_seconds,lock_bell_seconds,priority_seconds,is_active,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, seat_price=EXCLUDED.seat_price,
      target_seats=EXCLUDED.target_seats, max_duration_seconds=EXCLUDED.max_duration_seconds, lock_bell_seconds=EXCLUDED.lock_bell_seconds,
      priority_seconds=EXCLUDED.priority_seconds, is_active=EXCLUDED.is_active, updated_at=now() RETURNING *`,
      [t.id, t.name, t.seat_price, t.target_seats, t.max_duration_seconds ?? 180, t.lock_bell_seconds ?? 20, t.priority_seconds ?? 5, t.is_active ?? true]);
    return r.rows[0];
  }
  async getConfig() { const r = await this.q('SELECT * FROM rounds_config WHERE id=1'); return r.rows[0]; }
  async updateConfig(p) {
    const cur = await this.getConfig(); const n = { ...cur, ...p };
    await this.q('UPDATE rounds_config SET house_cut_bps=$1, shield_activation_bps=$2, shield_rescue_bps=$3, last_call_bps_of_losers=$4, streak_to_unlock=$5, updated_at=now() WHERE id=1',
      [n.house_cut_bps, n.shield_activation_bps, n.shield_rescue_bps, n.last_call_bps_of_losers, n.streak_to_unlock]); return n;
  }
  async createUser(username) { const r = await this.q('INSERT INTO users(username,display_name) VALUES($1,$1) RETURNING *', [username]); await this.q('INSERT INTO wallets(user_id,balance) VALUES($1,0) ON CONFLICT DO NOTHING', [r.rows[0].id]); return r.rows[0]; }
  async getUserById(id) { const r = await this.q('SELECT * FROM users WHERE id=$1', [id]); return r.rows[0] || null; }
  async getUserByUsername(n) { const r = await this.q('SELECT * FROM users WHERE username=$1', [n]); return r.rows[0] || null; }
  async updateUser(u) { const r = await this.q('UPDATE users SET streak=$1, gold_front_row=$2, total_front_wins=$3, total_rounds_played=$4 WHERE id=$5 RETURNING *', [u.streak, u.gold_front_row, u.total_front_wins, u.total_rounds_played, u.id]); return r.rows[0]; }
  async getWallet(userId) { const r = await this.q('SELECT * FROM wallets WHERE user_id=$1', [userId]); return r.rows[0] || { user_id: userId, balance: 0 }; }
  async postTransfer({ refType, refId, memo, entries }) {
    const d = entries.reduce((s, e) => s + (e.debit || 0), 0), c = entries.reduce((s, e) => s + (e.credit || 0), 0);
    if (d !== c) throw new Error(`Unbalanced transfer: debit ${d} != credit ${c}`);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const e of entries) if (e.account.startsWith('user:')) {
        const uid = e.account.slice(5); const w = await client.query('SELECT balance FROM wallets WHERE user_id=$1 FOR UPDATE', [uid]);
        const nb = (w.rows[0]?.balance || 0) + (e.credit || 0) - (e.debit || 0); if (nb < 0) throw new Error('Insufficient coins');
        await client.query('INSERT INTO wallets(user_id,balance) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET balance=$2, updated_at=now()', [uid, nb]);
      }
      const tid = uuid();
      for (const e of entries) await client.query('INSERT INTO wallet_ledger(transfer_id,account,user_id,debit,credit,ref_type,ref_id,memo) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [tid, e.account, e.account.startsWith('user:') ? e.account.slice(5) : null, e.debit || 0, e.credit || 0, refType, refId || null, memo || '']);
      await client.query('COMMIT'); return tid;
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
  async listLedger(userId, limit = 100) { const r = userId ? await this.q('SELECT * FROM wallet_ledger WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2', [userId, limit]) : await this.q('SELECT * FROM wallet_ledger ORDER BY created_at DESC LIMIT $1', [limit]); return r.rows; }
  async createRound(r) { await this.q('INSERT INTO rounds(id,tier_id,status,seat_price,target_seats,filled_seats,server_seed,server_seed_hash,started_at,priority_ends_at,open_ends_at,lock_bell_ends_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [r.id, r.tier_id, r.status, r.seat_price, r.target_seats, r.filled_seats, r.server_seed, r.server_seed_hash, r.started_at, r.priority_ends_at, r.open_ends_at, r.lock_bell_ends_at]); return r; }
  async getRound(id) { const r = await this.q('SELECT * FROM rounds WHERE id=$1', [id]); if (!r.rows[0]) return null; const row = r.rows[0]; return { ...row, filled_seats: row.filled_seats }; }
  async listRounds() { const r = await this.q('SELECT * FROM rounds ORDER BY started_at DESC LIMIT 100'); return r.rows; }
  async updateRound(r) { await this.q('UPDATE rounds SET status=$1, filled_seats=$2, snapshot_hash=$3, snapshot_json=$4, lock_bell_ends_at=$5, closed_at=$6, house_cut_amount=$7, losers_pool=$8, distributable=$9, frozen_reason=$10 WHERE id=$11',
    [r.status, r.filled_seats, r.snapshot_hash || null, r.snapshot_json ? JSON.stringify(r.snapshot_json) : null, r.lock_bell_ends_at, r.closed_at, r.house_cut_amount || 0, r.losers_pool || 0, r.distributable || 0, r.frozen_reason || null, r.id]); return r; }
  async createSeat(s) { await this.q('INSERT INTO seats(id,round_id,user_id,seat_count,amount_paid,base_price,row,is_boost,is_bell_shuffle,shielded_by,is_shielded,placed_at,seq) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [s.id, s.round_id, s.user_id, s.seat_count, s.amount_paid, s.base_price, s.row, s.is_boost, s.is_bell_shuffle, s.shielded_by, s.is_shielded, s.placed_at, s.seq]); return s; }
  async listSeats(roundId) { const r = await this.q('SELECT * FROM seats WHERE round_id=$1 ORDER BY seq', [roundId]); return r.rows; }
  async updateSeat(s) { await this.q('UPDATE seats SET shielded_by=$1, is_shielded=$2 WHERE id=$3', [s.shielded_by, s.is_shielded, s.id]); return s; }
  async createPayout(p) { const r = await this.q('INSERT INTO payouts(round_id,user_id,seat_id,stake_back,profit_share,shield_rescue_fee,last_call_bonus,total,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [p.round_id, p.user_id, p.seat_id || null, p.stake_back || 0, p.profit_share || 0, p.shield_rescue_fee || 0, p.last_call_bonus || 0, p.total || 0, p.kind]); return r.rows[0]; }
  async listPayouts(roundId) { const r = await this.q('SELECT * FROM payouts WHERE round_id=$1', [roundId]); return r.rows; }
  async listUserPayouts(userId, limit = 50) { const r = await this.q('SELECT * FROM payouts WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2', [userId, limit]); return r.rows; }
  async getShop() { const r = await this.q('SELECT * FROM shop_items ORDER BY price'); return r.rows; }
  async getUserItems(userId) { const r = await this.q('SELECT item_id FROM user_items WHERE user_id=$1', [userId]); return r.rows.map(x => x.item_id); }
  async addUserItem(userId, itemId) { await this.q('INSERT INTO user_items(user_id,item_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [userId, itemId]); }
}

async function createStore() {
  if (process.env.DATABASE_URL) {
    try {
      const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      await pool.query('SELECT 1'); console.log('[store] Postgres connected');
      return { store: new PostgresStore(pool), mode: 'postgres' };
    } catch (e) { console.log('[store] Postgres unavailable, falling back to memory:', e.message); }
  }
  return { store: new MemoryStore(), mode: 'memory' };
}

module.exports = { createStore, TOPUP_PACKS, DEFAULT_TIERS };
