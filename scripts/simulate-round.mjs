// Simulates one full Bronze round against a running backend on :4000.
// Fills past 80%, shields one Back seat, closes at target, then verifies
// payouts + provable hashes and asserts ledger balance.
// Usage: node scripts/simulate-round.mjs [baseUrl]
const BASE = process.argv[2] || 'http://localhost:4000';
const j = async (p, o = {}) => { const r = await fetch(BASE + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p} -> ${d.error || r.status}`); return d; };
const assert = (c, m) => { if (!c) throw new Error('ASSERT FAILED: ' + m); };
const user = async (name) => { const d = await j('/api/auth/login', { method: 'POST', body: { username: name } }); await j('/api/wallet/topup', { token: d.token, method: 'POST', body: { packId: 'pack-20000' } }); return d; };
const rounds = await j('/api/rounds/active'); const bronze = rounds.find(r => r.tier_id === 'bronze');
assert(bronze, 'No active Bronze round — is the backend running?');
console.log('Bronze round', bronze.id, 'filled', bronze.filled_seats, '/', bronze.target_seats, 'status', bronze.status);
// 16 Front seats (one user each, so streak logic is visible per player)
const players = []; for (let i = 0; i < 16; i++) players.push(await user('simfront' + i + Date.now() % 100000));
for (const p of players) { const d = await j(`/api/rounds/${bronze.id}/join`, { token: p.token, method: 'POST', body: {} }); assert(d.seat.row === 'front', 'expected front row'); }
console.log('16 Front seats placed. Lock Bell should now be live (or round at 80%).');
// 3 Back seats at 2x, then shield the first, then the final Back seat closes the round at target.
const backers = []; for (let i = 0; i < 4; i++) backers.push(await user('simback' + i + Date.now() % 100000));
let backSeats = []; for (const p of backers.slice(0, 3)) { const d = await j(`/api/rounds/${bronze.id}/join`, { token: p.token, method: 'POST', body: {} }); backSeats.push(d.seat); }
console.log('Back seats (first 3):', backSeats.map(s => `${s.row}:${s.amount_paid}`).join(', '));
// Shield the first Back seat by the first Front player (activation fee 10)
const shield = await j(`/api/rounds/${bronze.id}/shield`, { token: players[0].token, method: 'POST', body: { seatId: backSeats[0].id } });
console.log('Shielded', backSeats[0].id.slice(0, 8), 'activation fee', shield.activation_fee);
const lastBack = await j(`/api/rounds/${bronze.id}/join`, { token: backers[3].token, method: 'POST', body: {} });
backSeats.push(lastBack.seat); console.log('Final Back seat (closes round):', lastBack.seat.row, lastBack.seat.amount_paid);
// Fill to target: round is at 20/20? 16+4=20 already, so it closed at target on the last join.
// If it closed early, payouts are already in; otherwise this loop would not run.
const after = await j(`/api/rounds/${bronze.id}`);
console.log('Round status after fill:', after.status);
assert(after.status === 'closed', 'Round should have closed at target');
const payouts = await j(`/api/rounds/${bronze.id}/verify`);
console.log('Verify: seed_hash_matches =', payouts.seed_hash_matches, '| snapshot_hash_matches =', payouts.snapshot_hash_matches);
assert(payouts.seed_hash_matches && payouts.snapshot_hash_matches, 'Provable hashes must match');
const snap = payouts.snapshot; console.log('Losers pool', snap.losers_pool, '| house cut', snap.house_cut, '| front distributable', snap.distributable, '| last call', snap.last_call_bonus);
// Ledger balance check via admin ledger is not public; check payout arithmetic instead:
// front stake back (1600) + shielded refund (200-40=160) + front profit (distributable) + last-call (40) + house (60? see below) == total stakes (1600 + 800 = 2400)
// losers pool excludes shielded seat: 3 unshielded x 200 = 600; house 60; distributable0 540; last call 30; front profit 510.
assert(snap.losers_pool === 600, `losers pool should be 600 (shielded seat excluded), got ${snap.losers_pool}`);
assert(snap.house_cut === 60, `house cut should be 60, got ${snap.house_cut}`);
// front stakes 1600 + shielded refund 160 + rescue fee 40 to shielder + front profit + last call + house == total stakes 2400
assert(1600 + 160 + 40 + snap.distributable + snap.last_call_bonus + snap.house_cut === 2400, 'Payouts + house must equal total stakes 2400');
console.log('ALL CHECKS PASSED. Front profit pool', snap.distributable, '+ last call', snap.last_call_bonus);
