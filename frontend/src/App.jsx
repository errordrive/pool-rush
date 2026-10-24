import React, { useEffect, useState, useRef } from 'react';
import { io } from 'socket.io-client';
const API = import.meta.env.VITE_API_URL || (window.location.hostname === 'localhost' ? 'http://localhost:4000' : window.location.origin);
const api = async (path, { token, adminKey, method = 'GET', body } = {}) => {
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(adminKey ? { 'x-admin-key': adminKey } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Request failed'); return j;
};
function secsLeft(iso) { if (!iso) return null; return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000)); }
function Countdown({ iso }) { const [, tick] = useState(0); useEffect(() => { const t = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(t); }, []); const s = secsLeft(iso); return <span>{s === null ? '—' : s + 's'}</span>; }

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('pr_token') || '');
  const [me, setMe] = useState(null); const [page, setPage] = useState('lobby');
  const [rounds, setRounds] = useState([]); const [tiers, setTiers] = useState([]);
  const [selected, setSelected] = useState(null); const [msg, setMsg] = useState('');
  const [lastClosed, setLastClosed] = useState(null); const [verify, setVerify] = useState(null);
  const [username, setUsername] = useState('');

  const load = async () => {
    try { setTiers(await api('/api/tiers')); const rs = await api('/api/rounds/active'); setRounds(rs); if (selected) { const f = rs.find(r => r.id === selected.id); if (f) setSelected(f); } } catch (e) { setMsg(e.message); }
    if (token) { try { setMe(await api('/api/me', { token })); } catch { /* token expired */ } }
  };
  useEffect(() => { load(); const s = io(API); s.on('round:update', () => load()); s.on('round:closed', (d) => { setLastClosed(d); load(); }); s.on('ticker', () => {}); return () => s.disconnect(); }, [token]);
  useEffect(() => { const t = setInterval(load, 5000); return () => clearInterval(t); }, [token, selected]);

  const login = async (mode) => { try { const d = await api('/api/auth/' + mode, { method: 'POST', body: { username } }); localStorage.setItem('pr_token', d.token); setToken(d.token); setMe({ user: d.user, wallet: d.wallet }); setMsg('Welcome, ' + d.user.username + ' — ' + d.wallet.balance + ' starter coins (play-money only).'); } catch (e) { setMsg(e.message); } };
  const logout = () => { localStorage.removeItem('pr_token'); setToken(''); setMe(null); };

  const join = async (round, boost, useBellShuffle) => { try { const d = await api(`/api/rounds/${round.id}/join`, { token, method: 'POST', body: { boost, useBellShuffle } }); setMsg(`Seat joined: ${d.seat.row} row, ${d.seat.amount_paid} coins${d.closed ? ' — round closed, payouts sent!' : ''}`); load(); } catch (e) { setMsg(e.message); } };

  return <div className="wrap">
    <div className="top"><div><div className="big">🏊 Pool Rush: 80/20</div><div className="muted">Virtual coins only. No cash-out, ever. Winners spend coins on cosmetics.</div></div>
      <div>{me ? <><span className="pill">👤 {me.user.username}</span><span className="pill">🪙 {me.wallet?.balance ?? '?'} coins</span>{me.user.gold_front_row && <span className="pill">⭐ Gold Front Row</span>}<span className="pill">🔥 Streak {me.user.streak}</span><button onClick={logout}>Log out</button></> : <><input placeholder="username (a-z, 0-9, _)" value={username} onChange={e => setUsername(e.target.value)} /><button onClick={() => login('register')}>Register</button><button onClick={() => login('login')}>Login</button></>}</div>
    </div>
    {msg && <div className="card">{msg}</div>}
    <div className="nav">{['lobby', 'round', 'wallet', 'profile', 'admin'].map(p => <button key={p} className={page === p ? 'on' : ''} onClick={() => setPage(p)}>{p[0].toUpperCase() + p.slice(1)}</button>)}</div>

    {page === 'lobby' && <div>
      <h2>Lobby — pick a tier</h2><p className="muted">Front Row = seats before 80% fill (base price). At 80% the Lock Bell rings for 20s: late seats cost 2× and lose to Front Row (minus 10% house cut). Reach the target and the pool closes immediately.</p>
      <div className="grid">{rounds.map(r => { const t = tiers.find(x => x.id === r.tier_id); return <div className="card" key={r.id}>
        <h3>{t?.name || r.tier_id} — {r.seat_price} coins / seat</h3>
        <div>Target: {r.target_seats} seats • Filled: {r.filled_seats} ({r.filledPct}%) • Status: <b>{r.status}</b></div>
        <div className="bar" style={{ margin: '10px 0' }}><div className={'fill ' + (r.status === 'lock_bell' ? 'bell' : '')} style={{ width: Math.min(100, r.filledPct) + '%' }} /></div>
        {r.status === 'lock_bell' && <div className="bellbox">🔔 LOCK BELL — closes in <Countdown iso={r.lock_bell_ends_at} /> — late seats 2× price</div>}
        {r.status === 'priority' && <div>⭐ Priority entry ends in <Countdown iso={r.priority_ends_at} /> (Gold Front Row only)</div>}
        {r.status === 'open' && <div className="muted">Closes in <Countdown iso={r.open_ends_at} /> or at target</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button onClick={() => { setSelected(r); setPage('round'); }}>Live round</button>
          <button disabled={!token} onClick={() => join(r, false, false)}>Join ({r.status === 'lock_bell' ? r.seat_price * 2 : r.seat_price})</button>
          <button disabled={!token} onClick={() => join(r, true, false)}>Boost ×2 ({(r.status === 'lock_bell' ? r.seat_price * 2 : r.seat_price) * 2})</button>
        </div>
        {!token && <div className="muted">Log in to join.</div>}
      </div>; })}</div>
      {lastClosed && <div className="card"><h3>🎉 Last round closed — payouts</h3><p className="muted">Seed revealed: <code>{lastClosed.server_seed?.slice(0, 16)}…</code> • Snapshot hash: <code>{lastClosed.snapshot_hash?.slice(0, 16)}…</code> • Verify it on the Profile page.</p>
        {lastClosed.payouts.filter(p => p.total > 0).slice(0, 20).map((p, i) => <div className="seat" key={i}><span>{p.kind}</span><b>+{p.total} coins</b></div>)}
      </div>}
    </div>}

    {page === 'round' && (selected ? <RoundView round={selected} me={me} token={token} join={join} setMsg={setMsg} load={load} /> : <div className="card">Pick a round from the Lobby first.</div>)}

    {page === 'wallet' && <WalletPage me={me} token={token} setMsg={setMsg} load={load} />}
    {page === 'profile' && <ProfilePage me={me} token={token} verify={verify} setVerify={setVerify} />}
    {page === 'admin' && <AdminPage />}
  </div>;
}

function RoundView({ round, me, token, join, setMsg, load }) {
  const [taps, setTaps] = useState(0); const [tapStart, setTapStart] = useState(null); const [shuffleMsg, setShuffleMsg] = useState('');
  const front = (round.seats || []).filter(s => s.row === 'front'); const back = (round.seats || []).filter(s => s.row === 'back');
  const amFront = me && front.some(s => s.user_id === me.user.id);
  const tap = () => { const now = Date.now(); if (!tapStart) setTapStart(now); setTaps(t => t + 1); };
  const submitShuffle = async () => { try { const d = await api(`/api/rounds/${round.id}/bell-shuffle/claim`, { token, method: 'POST', body: { taps, durationMs: tapStart ? Date.now() - tapStart : 99999 } }); setShuffleMsg(d.granted ? '✅ Granted! Now join with Bell Shuffle (base price).' : `❌ Not fast enough (${d.taps} taps). Attempts left: ${d.attempts_left}`); setTaps(0); setTapStart(null); } catch (e) { setShuffleMsg(e.message); } };
  const shield = async (seatId) => { try { const d = await api(`/api/rounds/${round.id}/shield`, { token, method: 'POST', body: { seatId } }); setMsg(`Shielded! Activation fee ${d.activation_fee} coins. Rescued player gets stake back minus 20% rescue fee (paid to you).`); load(); } catch (e) { setMsg(e.message); } };
  return <div>
    <h2>Live round — {round.tier_id} • {round.seat_price} coins / seat</h2>
    <div className="card"><div>Filled {round.filled_seats}/{round.target_seats} ({round.filledPct}%) • Status: <b>{round.status}</b></div>
      <div className="bar" style={{ margin: '10px 0' }}><div className={'fill ' + (round.status === 'lock_bell' ? 'bell' : '')} style={{ width: Math.min(100, round.filledPct) + '%' }} /></div>
      {round.status === 'lock_bell' && <div className="bellbox">🔔 LOCK BELL — <Countdown iso={round.lock_bell_ends_at} /> left — late seats at 2×, Back Row loses to Front Row</div>}
      {round.status === 'priority' && <div>⭐ Priority: <Countdown iso={round.priority_ends_at} /> left (Gold Front Row only)</div>}
      {round.status === 'open' && <div className="muted">Open closes in <Countdown iso={round.open_ends_at} /></div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button disabled={!token} onClick={() => join(round, false, false)}>Join single</button>
        <button disabled={!token} onClick={() => join(round, true, false)}>Join Boost (2 seats)</button>
        <button disabled={!token} onClick={() => join(round, false, true)}>Join with Bell Shuffle grant</button>
      </div>
      <div className="muted">Server seed hash (pre-close commitment): <code>{round.serverSeedHash}</code></div>
    </div>
    {round.status === 'lock_bell' && <div className="card"><h3>⚡ Bell Shuffle — tap fast, pay base price</h3><p className="muted">Tap 5 times within 3 seconds to unlock ONE late seat at base price (instead of 2×). Max 3 attempts per round.</p>
      <button className="tap" onClick={tap}>👆 TAP ({taps})</button><div style={{ marginTop: 10 }}><button onClick={submitShuffle}>Submit taps</button> <button onClick={() => { setTaps(0); setTapStart(null); }}>Reset</button></div>{shuffleMsg && <div>{shuffleMsg}</div>}
    </div>}
    <div className="grid">
      <div className="card"><h3>Front Row ({front.reduce((s, x) => s + x.seat_count, 0)} seats) — guaranteed stake back + profit share</h3>
        {front.map(s => <div className="seat" key={s.id}><span>#{s.seq} {s.username}{s.is_boost ? ' ⚡Boost' : ''}</span><b>{s.amount_paid} coins</b></div>)}
        {front.length === 0 && <div className="muted">No Front seats yet.</div>}
      </div>
      <div className="card"><h3>Back Row ({back.reduce((s, x) => s + x.seat_count, 0)} seats) — loses stake to Front Row unless shielded</h3>
        {back.map(s => <div className="seat" key={s.id}><span>#{s.seq} {s.username}{s.is_shielded ? ' 🛡️ Safe' : ''}{s.is_bell_shuffle ? ' ⚡Shuffle' : ''}</span><span><b>{s.amount_paid} coins</b>{amFront && !s.is_shielded && <button style={{ marginLeft: 8 }} onClick={() => shield(s.id)}>Shield</button>}</span></div>)}
        {back.length === 0 && <div className="muted">No Back seats yet. The Lock Bell starts at 80%.</div>}
      </div>
    </div>
    <p className="muted">Last player to join before close gets a Last Call consolation (5% of the losers' pool) even if Back Row. 3 Front Row wins in a row unlock Gold Front Row priority entry.</p>
  </div>;
}

function WalletPage({ me, token, setMsg, load }) {
  const [packs, setPacks] = useState([]); const [shop, setShop] = useState([]); const [wallet, setWallet] = useState(null);
  useEffect(() => { api('/api/topup-packs').then(setPacks); api('/api/shop').then(setShop); if (token) api('/api/wallet', { token }).then(setWallet); }, [token]);
  if (!token) return <div className="card">Log in to see your wallet.</div>;
  const topup = async (packId) => { try { const d = await api('/api/wallet/topup', { token, method: 'POST', body: { packId } }); setMsg(`Top-up (mock receipt ${d.mock_receipt}): +${d.coins} coins. No real money moved.`); setWallet(d.wallet); load(); } catch (e) { setMsg(e.message); } };
  const buy = async (itemId) => { try { const d = await api('/api/shop/buy', { token, method: 'POST', body: { itemId } }); setMsg(`Bought ${d.item.name} for ${d.item.price} coins.`); setWallet(d.wallet); load(); } catch (e) { setMsg(e.message); } };
  return <div>
    <div className="card"><h2>Wallet</h2><div className="big">🪙 {wallet?.wallet?.balance ?? me?.wallet?.balance} coins</div><p className="muted">Play-money only. There is no cash-out button in this app, by design.</p>
      <h3>Top up (mock coin packs — demo only, no payment gateway)</h3><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{packs.map(p => <button key={p.id} onClick={() => topup(p.id)}>{p.label}</button>)}</div>
      <h3>Ledger (double-entry, latest first)</h3>{(wallet?.ledger || []).slice(0, 25).map(l => <div className="seat" key={l.id}><span>{l.ref_type} • {l.memo}</span><b>{l.credit > 0 ? '+' + l.credit : '-' + l.debit}</b></div>)}
    </div>
    <div className="card"><h2>Cosmetics shop — spend winnings here</h2>{shop.map(i => <div className="seat" key={i.id}><span>{i.name} — {i.description}</span><span><b>{i.price} coins</b> <button onClick={() => buy(i.id)}>Buy</button></span></div>)}</div>
  </div>;
}

function ProfilePage({ me, token, verify, setVerify }) {
  const [roundId, setRoundId] = useState('');
  if (!me) return <div className="card">Log in to see your profile.</div>;
  const u = me.user;
  const check = async () => { try { setVerify(await api(`/api/rounds/${roundId}/verify`)); } catch (e) { setVerify({ error: e.message }); } };
  return <div className="card"><h2>Profile — {u.username} {u.gold_front_row && '⭐ Gold Front Row'}</h2>
    <p>Streak: <b>{u.streak}</b> Front wins • Total Front wins: {u.total_front_wins} • Rounds played: {u.total_rounds_played}</p>
    <p className="muted">{u.gold_front_row ? 'You get 5 seconds of priority entry into every new round.' : `Win ${3 - u.streak} more Front Row round(s) in a row to unlock Gold Front Row priority entry.`}</p>
    <p>Owned cosmetics: {(me.items || []).join(', ') || 'none yet — win coins and buy some in the Wallet tab.'}</p>
    <h3>Recent payouts</h3>{(me.recent_payouts || []).map(p => <div className="seat" key={p.id}><span>{p.kind}</span><b>+{p.total} coins</b></div>)}
    <h3>Verify a closed round (provably transparent)</h3><p className="muted">Paste a closed round ID (from Admin, or the last-closed banner). The server seed is revealed only after close; the page re-hashes it and the seat snapshot to check both hashes.</p>
    <input placeholder="round UUID" value={roundId} onChange={e => setRoundId(e.target.value)} style={{ width: '100%' }} /><button style={{ marginTop: 8 }} onClick={check}>Verify</button>
    {verify && <pre style={{ whiteSpace: 'pre-wrap', background: '#0f172a', padding: 12, borderRadius: 12 }}>{JSON.stringify(verify, null, 2)}</pre>}
  </div>;
}

function AdminPage() {
  const [key, setKey] = useState('dev-admin-key'); const [rounds, setRounds] = useState([]); const [ledger, setLedger] = useState([]); const [cfg, setCfg] = useState(null); const [tiers, setTiers] = useState([]); const [msg, setMsg] = useState('');
  const load = async () => { try { setRounds(await api('/api/admin/rounds', { adminKey: key })); setLedger(await api('/api/admin/ledger', { adminKey: key })); setCfg(await api('/api/config')); setTiers(await api('/api/tiers')); } catch (e) { setMsg(e.message); } };
  useEffect(() => { load(); }, []);
  const freeze = async (id, frozen) => { try { await api(`/api/admin/rounds/${id}/${frozen ? 'unfreeze' : 'freeze'}`, { adminKey: key, method: 'POST', body: { reason: 'Admin freeze' } }); load(); } catch (e) { setMsg(e.message); } };
  const saveCfg = async () => { try { await api('/api/admin/config', { adminKey: key, method: 'PUT', body: cfg }); setMsg('Config saved.'); } catch (e) { setMsg(e.message); } };
  return <div className="card"><h2>Admin</h2><p className="muted">Header key: <code>x-admin-key</code>. Default dev key is <code>dev-admin-key</code> — set ADMIN_KEY in production.</p>
    <input value={key} onChange={e => setKey(e.target.value)} /><button onClick={load}>Load</button>{msg && <div>{msg}</div>}
    {cfg && <div><h3>Config</h3><label>House cut (bps, 1000 = 10%) </label><input type="number" value={cfg.house_cut_bps} onChange={e => setCfg({ ...cfg, house_cut_bps: Number(e.target.value) })} />{' '}
    <label>Streak to unlock </label><input type="number" value={cfg.streak_to_unlock} onChange={e => setCfg({ ...cfg, streak_to_unlock: Number(e.target.value) })} /> <button onClick={saveCfg}>Save config</button></div>}
    <h3>Tiers</h3>{tiers.map(t => <div className="seat" key={t.id}><span>{t.name}: {t.seat_price} coins × {t.target_seats} seats</span><span>{t.is_active ? 'active' : 'inactive'}</span></div>)}
    <h3>Rounds</h3>{rounds.slice(0, 20).map(r => <div className="seat" key={r.id}><span>{r.tier_id} • {r.status} • {r.filled_seats}/{r.target_seats} • {r.id.slice(0, 8)}</span><button onClick={() => freeze(r.id, r.status === 'frozen')}>{r.status === 'frozen' ? 'Unfreeze' : 'Freeze'}</button></div>)}
    <h3>Ledger (latest)</h3>{ledger.slice(0, 30).map(l => <div className="seat" key={l.id}><span>{l.account} • {l.ref_type} • {l.memo}</span><b>{l.credit > 0 ? '+' + l.credit : '-' + l.debit}</b></div>)}
  </div>;
}
