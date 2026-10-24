// Pool Rush: 80/20 — backend (Express + Socket.io)
// VIRTUAL COINS ONLY. No real-money cash-out exists in this codebase.
// Top-up is a MOCK coin-pack grant (no payment gateway call). Coins are
// spendable only in-game (seats, shields, cosmetics).
//
// Core rules (see README for worked examples):
//  - Tier sets seat_price + target_seats. Pool target = price * target_seats.
//  - Seats before 80% filled are Front Row (base price). At >=80% the round
//    enters the Lock Bell (20s): joining continues at 2x seat price (Back Row).
//  - Pool closes when filled >= target, when the Lock Bell ends, or when the
//    max timer (180s of open time) expires.
//  - On close: Front Row get stake back + a share of the losers' pool.
//    Back Row (unshielded) lose their stake to Front Row.
//    House cut = 10% of losers' pool (configurable). Rest -> Front Row.
//  - v2: Shield, Boost (2x price = 2 seats), Bell Shuffle (base-price late
//    seat for fast tappers), Last Call (last joiner, if Back Row, gets a
//    consolation from the distributable pool), Streaks (3 Front wins ->
//    Gold Front Row, 5s priority entry into new rounds).
//  - Provable: each round gets a random server_seed at creation; only its
//    sha256 hash is published until close. After close the seed + a
//    snapshot hash (seed + sorted seats) are revealed at /rounds/:id/verify.
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { createStore, TOPUP_PACKS } = require('./store');

const PORT = process.env.PORT || process.env.SERVER_PORT || 4000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-key';
const STARTER_COINS = 1000;
const uuid = () => crypto.randomUUID();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const nowIso = () => new Date().toISOString();

let redis = null;
async function initRedis() {
  if (!process.env.REDIS_URL) return;
  try { const Redis = require('ioredis'); redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, enableReadyCheck: false }); redis.on('error', () => {}); console.log('[redis] client created (live state also kept in-process)'); }
  catch (e) { console.log('[redis] unavailable:', e.message); }
}

async function main() {
  const { store, mode } = await createStore();
  await initRedis();
  const app = express(); app.use(cors()); app.use(express.json({ limit: '200kb' }));
  // Single-service hosting: serve the built frontend from the same origin
  // (so the browser's API + Socket.io calls hit this server, not localhost).
  // Build it first: cd frontend && npm install && npm run build
  const distDir = path.join(__dirname, '../../frontend/dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => { if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next(); res.sendFile(path.join(distDir, 'index.html')); });
  }
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' } });

  // ---- live-round cache (Redis mirror when available, in-process truth) ----
  const liveCache = new Map();
  async function cacheRound(r) {
    liveCache.set(r.id, publicRound(r));
    if (redis) { try { await redis.set(`poolrush:round:${r.id}`, JSON.stringify(publicRound(r)), 'EX', 600); } catch (_) {} }
  }
  // Bell-shuffle grants + attempts: roundId -> Map(userId -> {granted, attempts})
  const shuffleState = new Map();
  // Frozen rounds: roundId -> phase before freeze
  const frozenPhase = new Map();
  // Per-round join lock to keep seq/filled atomic in Node's single thread.
  // (All joins run synchronously between awaits on the store; the lock below
  // serialises the check-then-write section per round.)
  const joinLocks = new Map();
  async function withLock(key, fn) {
    while (joinLocks.get(key)) await new Promise(r => setTimeout(r, 5));
    joinLocks.set(key, true);
    try { return await fn(); } finally { joinLocks.delete(key); }
  }

  function publicRound(r) {
    const { server_seed, ...rest } = r || {};
    return { ...rest, server_seed: undefined, serverSeedHash: r.server_seed_hash, filledPct: r.target_seats ? Math.round((r.filled_seats / r.target_seats) * 100) : 0 };
  }
  async function roundView(r) {
    const seats = await store.listSeats(r.id);
    const users = {}; for (const s of seats) { const u = await store.getUserById(s.user_id); users[s.user_id] = u ? u.username : 'player'; }
    const viewSeats = seats.map(s => ({ ...s, username: users[s.user_id] }));
    return { ...publicRound(r), seats: viewSeats };
  }
  function emitRound(r) { io.emit('round:update', publicRound(r)); cacheRound(r); }

  async function createRoundForTier(tier) {
    const existing = (await store.listRounds()).find(r => r.tier_id === tier.id && r.status !== 'closed');
    if (existing) return existing;
    const seed = crypto.randomBytes(32).toString('hex');
    const started = Date.now();
    const r = {
      id: uuid(), tier_id: tier.id, status: 'priority', seat_price: tier.seat_price, target_seats: tier.target_seats,
      filled_seats: 0, server_seed: seed, server_seed_hash: sha256(seed), snapshot_hash: null, snapshot_json: null,
      started_at: new Date(started).toISOString(),
      priority_ends_at: new Date(started + (tier.priority_seconds ?? 5) * 1000).toISOString(),
      open_ends_at: new Date(started + ((tier.priority_seconds ?? 5) + (tier.max_duration_seconds ?? 180)) * 1000).toISOString(),
      lock_bell_ends_at: null, closed_at: null, house_cut_amount: 0, losers_pool: 0, distributable: 0, frozen_reason: null,
    };
    await store.createRound(r); emitRound(r); return r;
  }
  async function ensureRounds() {
    for (const t of await store.getTiers()) if (t.is_active) await createRoundForTier(t);
  }

  // ---- payout engine (pure arithmetic, then one balanced ledger transfer) ----
  async function closeRound(round) {
    if (round.status === 'closed') return round;
    const cfg = await store.getConfig();
    const seats = await store.listSeats(round.id);
    const front = seats.filter(s => s.row === 'front');
    const back = seats.filter(s => s.row === 'back');
    const backLost = back.filter(s => !s.is_shielded);
    const backSafe = back.filter(s => s.is_shielded);
    const losersPool = backLost.reduce((s, x) => s + x.amount_paid, 0);
    const houseCut = Math.floor(losersPool * cfg.house_cut_bps / 10000);
    const distributable0 = losersPool - houseCut;
    const lastSeat = seats.length ? seats[seats.length - 1] : null;
    const lastIsLoser = !!(lastSeat && lastSeat.row === 'back' && !lastSeat.is_shielded);
    const lastCallBonus = lastIsLoser ? Math.min(Math.floor(losersPool * cfg.last_call_bps_of_losers / 10000), distributable0) : 0;
    const frontProfitPool = distributable0 - lastCallBonus;
    const frontUnits = front.reduce((s, x) => s + x.seat_count, 0);
    const perUnit = frontUnits > 0 ? Math.floor(frontProfitPool / frontUnits) : 0;
    let remainder = frontUnits > 0 ? frontProfitPool - perUnit * frontUnits : 0;

    const userTotals = new Map(); // userId -> total payout
    const addTotal = (uid, amt) => userTotals.set(uid, (userTotals.get(uid) || 0) + amt);
    const payoutRows = [];
    for (const s of front) {
      let extra = 0; if (remainder > 0) { extra = Math.min(s.seat_count, remainder); remainder -= extra; }
      const profit = perUnit * s.seat_count + extra;
      const total = s.amount_paid + profit;
      payoutRows.push({ round_id: round.id, user_id: s.user_id, seat_id: s.id, stake_back: s.amount_paid, profit_share: profit, shield_rescue_fee: 0, last_call_bonus: 0, total, kind: profit > 0 ? 'front_win' : 'front_refund' });
      addTotal(s.user_id, total);
    }
    for (const s of backLost) {
      const bonus = (lastSeat && s.id === lastSeat.id) ? lastCallBonus : 0;
      payoutRows.push({ round_id: round.id, user_id: s.user_id, seat_id: s.id, stake_back: 0, profit_share: 0, shield_rescue_fee: 0, last_call_bonus: bonus, total: bonus, kind: bonus > 0 ? 'last_call' : 'back_loss' });
      if (bonus) addTotal(s.user_id, bonus);
    }
    for (const s of backSafe) {
      const rescue = Math.floor(s.amount_paid * cfg.shield_rescue_bps / 10000);
      const refund = s.amount_paid - rescue;
      payoutRows.push({ round_id: round.id, user_id: s.user_id, seat_id: s.id, stake_back: refund, profit_share: 0, shield_rescue_fee: 0, last_call_bonus: 0, total: refund, kind: 'back_shielded' });
      addTotal(s.user_id, refund);
      if (rescue > 0 && s.shielded_by) {
        payoutRows.push({ round_id: round.id, user_id: s.shielded_by, seat_id: s.id, stake_back: 0, profit_share: 0, shield_rescue_fee: rescue, last_call_bonus: 0, total: rescue, kind: 'shield_rescue' });
        addTotal(s.shielded_by, rescue);
      }
    }
    const totalStakes = seats.reduce((s, x) => s + x.amount_paid, 0);
    if (totalStakes > 0) {
      const entries = [{ account: `escrow:${round.id}`, debit: totalStakes, credit: 0 }];
      for (const [uid, amt] of userTotals) if (amt > 0) entries.push({ account: `user:${uid}`, debit: 0, credit: amt });
      if (houseCut > 0) entries.push({ account: 'house', debit: 0, credit: houseCut });
      // Balance check: escrow out == user payouts + house cut (by construction).
      const credited = [...userTotals.values()].reduce((s, x) => s + x, 0) + houseCut;
      if (credited !== totalStakes) throw new Error(`Payout imbalance: credited ${credited} != stakes ${totalStakes}`);
      await store.postTransfer({ refType: 'payout', refId: round.id, memo: `Round ${round.id} payout`, entries });
    }
    for (const p of payoutRows) await store.createPayout(p);

    // Streaks: front win (profit>0) -> +1; back loss -> reset. Refund/shielded -> unchanged.
    const played = new Set(seats.map(s => s.user_id));
    const frontWinners = new Set(front.filter(s => payoutRows.find(p => p.seat_id === s.id && p.profit_share > 0)).map(s => s.user_id));
    const backLosers = new Set(backLost.map(s => s.user_id));
    for (const uid of played) {
      const u = await store.getUserById(uid); if (!u) continue;
      u.total_rounds_played = (u.total_rounds_played || 0) + 1;
      if (frontWinners.has(uid)) { u.streak = (u.streak || 0) + 1; u.total_front_wins = (u.total_front_wins || 0) + 1; }
      else if (backLosers.has(uid)) { u.streak = 0; }
      u.gold_front_row = (u.streak || 0) >= (cfg.streak_to_unlock || 3);
      await store.updateUser(u);
    }

    const snapshotSeats = seats.map(s => ({ seq: s.seq, user_id: s.user_id, seat_count: s.seat_count, amount_paid: s.amount_paid, row: s.row, is_boost: s.is_boost, is_bell_shuffle: s.is_bell_shuffle, is_shielded: s.is_shielded, placed_at: s.placed_at }));
    const snapshot = { round_id: round.id, tier_id: round.tier_id, seat_price: round.seat_price, target_seats: round.target_seats, filled_seats: round.filled_seats, seats: snapshotSeats, house_cut: houseCut, losers_pool: losersPool, distributable: frontProfitPool, last_call_bonus: lastCallBonus, closed_at: nowIso() };
    round.snapshot_json = snapshot;
    round.snapshot_hash = sha256(round.server_seed + '|' + JSON.stringify(snapshotSeats));
    round.status = 'closed'; round.closed_at = nowIso(); round.house_cut_amount = houseCut; round.losers_pool = losersPool; round.distributable = frontProfitPool;
    await store.updateRound(round);
    io.emit('round:closed', { round: publicRound(round), payouts: payoutRows, server_seed: round.server_seed, snapshot_hash: round.snapshot_hash });
    emitRound(round);
    // Auto-open the next round for this tier after a short breather.
    setTimeout(async () => { const t = await store.getTier(round.tier_id); if (t && t.is_active) await createRoundForTier(t); }, 3000);
    return round;
  }

  // ---- round tick: phase transitions + timers ----
  setInterval(async () => {
    try {
      const rounds = await store.listRounds();
      for (const r of rounds) {
        if (r.status === 'closed' || r.status === 'frozen') continue;
        const now = Date.now();
        if (r.status === 'priority' && r.priority_ends_at && now >= new Date(r.priority_ends_at).getTime()) { r.status = 'open'; await store.updateRound(r); emitRound(r); }
        else if (r.status === 'open' && r.open_ends_at && now >= new Date(r.open_ends_at).getTime()) { await closeRound(r); }
        else if (r.status === 'lock_bell' && r.lock_bell_ends_at && now >= new Date(r.lock_bell_ends_at).getTime()) { await closeRound(r); }
      }
      // 1s ticker so Lock Bell countdowns stay in sync (light payload).
      io.emit('ticker', { at: nowIso() });
    } catch (e) { console.error('[tick]', e.message); }
  }, 1000);

  // ---- auth helpers ----
  async function auth(req, res, next) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Login required (Bearer <userId>)' });
    const u = await store.getUserById(token); if (!u) return res.status(401).json({ error: 'Unknown user token' });
    req.user = u; next();
  }
  function admin(req, res, next) { if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Admin key required (x-admin-key header)' }); next(); }

  // ---- public / auth ----
  app.get('/api/health', (req, res) => res.json({ ok: true, store: mode, redis: !!redis, time: nowIso() }));
  app.post('/api/auth/register', async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-24 chars: a-z, 0-9, _' });
    let u = await store.getUserByUsername(username);
    if (u) return res.status(409).json({ error: 'Username taken — use login instead' });
    u = await store.createUser(username);
    await store.postTransfer({ refType: 'starter', refId: u.id, memo: 'Starter coins (play-money, no cash value)', entries: [{ account: 'mint', debit: STARTER_COINS, credit: 0 }, { account: `user:${u.id}`, debit: 0, credit: STARTER_COINS }] });
    const w = await store.getWallet(u.id); res.json({ user: u, token: u.id, wallet: w });
  });
  app.post('/api/auth/login', async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    let u = await store.getUserByUsername(username);
    if (!u) { u = await store.createUser(username); await store.postTransfer({ refType: 'starter', refId: u.id, memo: 'Starter coins', entries: [{ account: 'mint', debit: STARTER_COINS, credit: 0 }, { account: `user:${u.id}`, debit: 0, credit: STARTER_COINS }] }); }
    const w = await store.getWallet(u.id); res.json({ user: u, token: u.id, wallet: w });
  });
  app.get('/api/me', auth, async (req, res) => {
    const w = await store.getWallet(req.user.id); const items = await store.getUserItems(req.user.id); const payouts = await store.listUserPayouts(req.user.id);
    res.json({ user: req.user, wallet: w, items, recent_payouts: payouts });
  });
  app.get('/api/tiers', async (req, res) => res.json(await store.getTiers()));
  app.get('/api/config', async (req, res) => res.json(await store.getConfig()));
  app.get('/api/topup-packs', (req, res) => res.json(TOPUP_PACKS));

  // ---- rounds ----
  app.get('/api/rounds/active', async (req, res) => {
    const rounds = (await store.listRounds()).filter(r => r.status !== 'closed');
    const views = []; for (const r of rounds) views.push(await roundView(r)); res.json(views);
  });
  app.get('/api/rounds/:id', async (req, res) => {
    const r = await store.getRound(req.params.id); if (!r) return res.status(404).json({ error: 'Round not found' });
    res.json(await roundView(r));
  });
  app.get('/api/rounds/:id/verify', async (req, res) => {
    const r = await store.getRound(req.params.id); if (!r) return res.status(404).json({ error: 'Round not found' });
    if (r.status !== 'closed') return res.json({ round_id: r.id, status: r.status, server_seed_hash: r.server_seed_hash, revealed: false, note: 'Seed is revealed only after close.' });
    const seats = (r.snapshot_json?.seats) || (await store.listSeats(r.id)).map(s => ({ seq: s.seq, user_id: s.user_id, seat_count: s.seat_count, amount_paid: s.amount_paid, row: s.row, is_boost: s.is_boost, is_bell_shuffle: s.is_bell_shuffle, is_shielded: s.is_shielded, placed_at: s.placed_at }));
    res.json({ round_id: r.id, status: 'closed', revealed: true, server_seed: r.server_seed, server_seed_hash: r.server_seed_hash, seed_hash_matches: sha256(r.server_seed) === r.server_seed_hash, snapshot_hash: r.snapshot_hash, snapshot_hash_matches: sha256(r.server_seed + '|' + JSON.stringify(seats)) === r.snapshot_hash, snapshot: r.snapshot_json });
  });

  app.post('/api/rounds/:id/join', auth, async (req, res) => {
    try {
      const out = await withLock(req.params.id, async () => {
        const round = await store.getRound(req.params.id); if (!round) throw Object.assign(new Error('Round not found'), { status: 404 });
        if (round.status === 'frozen') throw Object.assign(new Error('Round is frozen by admin'), { status: 403 });
        if (round.status === 'closed') throw Object.assign(new Error('Round already closed'), { status: 409 });
        if (round.status === 'priority' && !req.user.gold_front_row) throw Object.assign(new Error('Priority entry: Gold Front Row only for 5 seconds'), { status: 403, priority_ends_at: round.priority_ends_at });
        if (round.status !== 'priority' && round.status !== 'open' && round.status !== 'lock_bell') throw Object.assign(new Error(`Cannot join in phase ${round.status}`), { status: 409 });
        const tier = await store.getTier(round.tier_id);
        const boost = req.body.boost === true;
        const useShuffle = req.body.useBellShuffle === true;
        const seatCount = boost ? 2 : 1;
        if (round.filled_seats + seatCount > round.target_seats) throw Object.assign(new Error('Not enough seats left in this round'), { status: 409 });
        const frontThreshold = Math.ceil(round.target_seats * 0.8);
        const isFront = round.filled_seats < frontThreshold;
        const row = isFront ? 'front' : 'back';
        let pricePerSeat = round.seat_price;
        let isShuffle = false;
        if (row === 'back') {
          if (useShuffle) {
            const m = shuffleState.get(round.id)?.get(req.user.id);
            if (!m || !m.granted) throw Object.assign(new Error('No Bell Shuffle grant — win the tap game first'), { status: 403 });
            if (m.used) throw Object.assign(new Error('Bell Shuffle grant already used'), { status: 409 });
            if (boost) throw Object.assign(new Error('Bell Shuffle cannot be combined with Boost'), { status: 400 });
            pricePerSeat = round.seat_price; isShuffle = true; m.used = true;
          } else pricePerSeat = round.seat_price * 2;
        }
        const amount = pricePerSeat * seatCount;
        const wallet = await store.getWallet(req.user.id);
        if (wallet.balance < amount) throw Object.assign(new Error(`Need ${amount} coins, you have ${wallet.balance}`), { status: 402 });
        const seatsSoFar = await store.listSeats(round.id);
        const seq = seatsSoFar.length + 1;
        await store.postTransfer({ refType: 'join', refId: round.id, memo: `${row} seat x${seatCount}${boost ? ' (boost)' : ''}${isShuffle ? ' (bell shuffle)' : ''}`, entries: [{ account: `user:${req.user.id}`, debit: amount, credit: 0 }, { account: `escrow:${round.id}`, debit: 0, credit: amount }] });
        const seat = await store.createSeat({ id: uuid(), round_id: round.id, user_id: req.user.id, seat_count: seatCount, amount_paid: amount, base_price: round.seat_price, row, is_boost: boost, is_bell_shuffle: isShuffle, shielded_by: null, is_shielded: false, placed_at: nowIso(), seq });
        round.filled_seats += seatCount;
        let closedNow = false;
        if (round.filled_seats >= round.target_seats) { await store.updateRound(round); await closeRound(round); closedNow = true; }
        else if (row === 'back' || round.filled_seats >= frontThreshold) {
          if (round.status !== 'lock_bell') { round.status = 'lock_bell'; round.lock_bell_ends_at = new Date(Date.now() + (tier.lock_bell_seconds ?? 20) * 1000).toISOString(); }
          await store.updateRound(round); emitRound(round);
        } else { await store.updateRound(round); emitRound(round); }
        const fresh = await store.getRound(round.id);
        return { seat, round: publicRound(fresh), closed: closedNow };
      });
      res.json(out);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Bell Shuffle: 5+ taps in <=3000ms during the Lock Bell grants ONE base-price late seat.
  app.post('/api/rounds/:id/bell-shuffle/claim', auth, async (req, res) => {
    const round = await store.getRound(req.params.id); if (!round) return res.status(404).json({ error: 'Round not found' });
    if (round.status !== 'lock_bell') return res.status(409).json({ error: 'Bell Shuffle is only available during the Lock Bell' });
    if (!shuffleState.has(round.id)) shuffleState.set(round.id, new Map());
    const m = shuffleState.get(round.id); const cur = m.get(req.user.id) || { granted: false, used: false, attempts: 0 };
    if (cur.granted) return res.json({ granted: true, already: true });
    if (cur.attempts >= 3) return res.status(429).json({ error: 'No Bell Shuffle attempts left in this round (max 3)' });
    cur.attempts += 1; m.set(req.user.id, cur);
    const taps = Number(req.body.taps || 0), durationMs = Number(req.body.durationMs || 99999);
    if (taps >= 5 && durationMs <= 3000) { cur.granted = true; m.set(req.user.id, cur); return res.json({ granted: true, taps, durationMs, note: 'Next join in this round (single seat, no Boost) costs base price.' }); }
    res.json({ granted: false, taps, durationMs, attempts_left: 3 - cur.attempts, note: 'Need 5 taps within 3 seconds.' });
  });

  // Shield: a Front Row player rescues a Back Row seat.
  // Activation fee (10% of seat price) is paid by the shielder to the house NOW.
  // At close, the rescued player gets stake back minus a rescue fee (20% of
  // their stake), and that rescue fee is paid to the shielder.
  app.post('/api/rounds/:id/shield', auth, async (req, res) => {
    try {
      const round = await store.getRound(req.params.id); if (!round) return res.status(404).json({ error: 'Round not found' });
      if (round.status === 'closed' || round.status === 'frozen') return res.status(409).json({ error: 'Round is not shieldable now' });
      const seats = await store.listSeats(round.id);
      const mineFront = seats.find(s => s.user_id === req.user.id && s.row === 'front');
      if (!mineFront) return res.status(403).json({ error: 'Only a Front Row player can shield' });
      const target = seats.find(s => s.id === req.body.seatId);
      if (!target || target.row !== 'back') return res.status(400).json({ error: 'Target must be a Back Row seat in this round' });
      if (target.is_shielded) return res.status(409).json({ error: 'Seat already shielded' });
      if (target.user_id === req.user.id) return res.status(400).json({ error: 'Cannot shield your own Back Row seat' });
      const cfg = await store.getConfig();
      const fee = Math.ceil(round.seat_price * cfg.shield_activation_bps / 10000);
      await store.postTransfer({ refType: 'shield_activation', refId: round.id, memo: `Shield seat ${target.id}`, entries: [{ account: `user:${req.user.id}`, debit: fee, credit: 0 }, { account: 'house', debit: 0, credit: fee }] });
      target.is_shielded = true; target.shielded_by = req.user.id; await store.updateSeat(target);
      emitRound(round); res.json({ ok: true, seat: target, activation_fee: fee, note: 'At close, the rescued player gets stake back minus 20% rescue fee, paid to you.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- wallet / shop ----
  app.get('/api/wallet', auth, async (req, res) => res.json({ wallet: await store.getWallet(req.user.id), ledger: await store.listLedger(req.user.id, 50) }));
  app.post('/api/wallet/topup', auth, async (req, res) => {
    const pack = TOPUP_PACKS.find(p => p.id === req.body.packId);
    const coins = pack ? pack.coins : Number(req.body.coins || 0);
    if (!Number.isInteger(coins) || coins < 100 || coins > 1000000) return res.status(400).json({ error: 'Pick a pack, or a custom amount 100-1,000,000 coins' });
    // MOCK top-up: no gateway is called, no real money moves. The reference
    // below is a demo receipt only. Replace with a real (non-gambling)
    // coin-pack provider only if you add one — never wire this to cash-out.
    const ref = 'MOCK-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    await store.postTransfer({ refType: 'topup', refId: ref, memo: `Mock coin pack ${pack ? pack.label : coins + ' coins'} (demo receipt ${ref})`, entries: [{ account: 'mint', debit: coins, credit: 0 }, { account: `user:${req.user.id}`, debit: 0, credit: coins }] });
    res.json({ ok: true, coins, mock_receipt: ref, wallet: await store.getWallet(req.user.id) });
  });
  app.post('/api/cashout', (req, res) => res.status(403).json({ error: 'Cash-out is disabled by design. Coins are play-money, spendable only in-game, and can never be converted back to money.' }));
  app.get('/api/shop', async (req, res) => res.json(await store.getShop()));
  app.post('/api/shop/buy', auth, async (req, res) => {
    const items = await store.getShop(); const item = items.find(i => i.id === req.body.itemId); if (!item) return res.status(404).json({ error: 'Item not found' });
    const owned = await store.getUserItems(req.user.id); if (owned.includes(item.id)) return res.status(409).json({ error: 'Already owned' });
    try { await store.postTransfer({ refType: 'shop', refId: item.id, memo: `Bought ${item.name}`, entries: [{ account: `user:${req.user.id}`, debit: item.price, credit: 0 }, { account: 'shop', debit: 0, credit: item.price }] }); }
    catch (e) { return res.status(402).json({ error: e.message }); }
    await store.addUserItem(req.user.id, item.id); res.json({ ok: true, item, wallet: await store.getWallet(req.user.id) });
  });

  // ---- admin ----
  app.get('/api/admin/rounds', admin, async (req, res) => { const rs = await store.listRounds(); const out = []; for (const r of rs) out.push(await roundView(r)); res.json(out); });
  app.get('/api/admin/ledger', admin, async (req, res) => res.json(await store.listLedger(null, 200)));
  app.post('/api/admin/tiers', admin, async (req, res) => res.json(await store.upsertTier(req.body)));
  app.put('/api/admin/tiers/:id', admin, async (req, res) => res.json(await store.upsertTier({ ...req.body, id: req.params.id })));
  app.put('/api/admin/config', admin, async (req, res) => res.json(await store.updateConfig(req.body)));
  app.post('/api/admin/rounds/:id/freeze', admin, async (req, res) => {
    const r = await store.getRound(req.params.id); if (!r) return res.status(404).json({ error: 'Round not found' });
    frozenPhase.set(r.id, r.status); r.status = 'frozen'; r.frozen_reason = req.body.reason || 'Frozen by admin'; await store.updateRound(r); emitRound(r); res.json(publicRound(r));
  });
  app.post('/api/admin/rounds/:id/unfreeze', admin, async (req, res) => {
    const r = await store.getRound(req.params.id); if (!r) return res.status(404).json({ error: 'Round not found' });
    const prev = frozenPhase.get(r.id) || 'open'; r.status = prev; r.frozen_reason = null;
    if (prev === 'lock_bell') r.lock_bell_ends_at = new Date(Date.now() + 20000).toISOString();
    if (prev === 'open' || prev === 'priority') r.open_ends_at = new Date(Date.now() + 180000).toISOString();
    await store.updateRound(r); emitRound(r); res.json(publicRound(r));
  });
  app.post('/api/admin/rounds/create', admin, async (req, res) => {
    const t = await store.getTier(req.body.tierId); if (!t) return res.status(404).json({ error: 'Tier not found' });
    res.json(publicRound(await createRoundForTier(t)));
  });

  io.on('connection', (socket) => { socket.emit('hello', { store: mode, at: nowIso() }); });

  await ensureRounds();
  server.listen(PORT, () => console.log(`Pool Rush backend on http://localhost:${PORT} (store=${mode}, admin key=${ADMIN_KEY === 'dev-admin-key' ? 'dev-admin-key (change in prod)' : 'set'})`));
}
main().catch(e => { console.error(e); process.exit(1); });
