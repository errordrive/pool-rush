import React, { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { sfx, isMuted, setMuted } from './sound.js';
// Mobile-first game UI: one column on phones, wider grids on tablet/desktop.
// No images, no external fonts, no heavy engine library — CSS/SVG/emoji only,
// so the bundle stays small and the game stays fast on a phone and on desktop.
const API = import.meta.env.VITE_API_URL || (window.location.hostname === 'localhost' ? 'http://localhost:4000' : window.location.origin);
const api = async (path, { token, adminKey, method = 'GET', body } = {}) => {
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(adminKey ? { 'x-admin-key': adminKey } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Request failed'); return j;
};
function secsLeft(iso) { if (!iso) return null; return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000)); }
function Countdown({ iso }) { const [, tick] = useState(0); useEffect(() => { const t = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(t); }, []); const s = secsLeft(iso); return <span>{s === null ? '—' : s + 's'}</span>; }
function Confetti({ count }) {
  const n = Math.min(count, window.innerWidth < 700 ? 24 : 48);
  const colours = ['#fbbf24', '#22c55e', '#38bdf8', '#f472b6', '#fff'];
  return <div className="confetti">{Array.from({ length: n }).map((_, i) => <i key={i} style={{ left: (i * 97 % 100) + '%', background: colours[i % colours.length], animationDelay: (i % 10) * 0.15 + 's', transform: `rotate(${i * 37 % 360}deg)` }} />)}</div>;
}
function PoolStage({ round }) {
  const pct = round.filledPct || 0; const coins = Math.min(round.filled_seats || 0, 20);
  return <div className="pool-stage">
    <div className="arena"><div style={{ fontSize: 40 }}>{round.tier_id === 'gold' ? '🥇' : round.tier_id === 'silver' ? '🥈' : '🥉'}</div>
      <div className="big">{round.tier_id.toUpperCase()} ARENA</div>
      <div className="muted">{round.seat_price} coins / seat • Target {round.target_seats} seats</div></div>
    <div className="pool"><div className="pool-water" style={{ height: pct + '%' }} />
      <div className="pool-label">{round.filled_seats}/{round.target_seats} • {pct}%</div>
      <div className="coins">{Array.from({ length: coins }).map((_, i) => <span key={i} className="coin-dot" />)}</div></div>
    <div className="bar"><div className={'fill ' + (round.status === 'lock_bell' ? 'bell' : '')} style={{ width: Math.min(100, pct) + '%' }} /></div>
  </div>;
}
function SeatRing({ title, seats, colour }) {
  return <div className="card"><h3 style={{ marginTop: 0 }}>{title} ({seats.reduce((s, x) => s + x.seat_count, 0)})</h3>
    <div className="seat-ring">{seats.map(s => <div className="seat-item" key={s.id}><div className={'token ' + (s.row === 'front' ? 'front' : 'back') + (s.is_shielded ? ' safe' : '')}>{(s.username || '?')[0].toUpperCase()}</div><span>{s.username}{s.is_boost ? ' ⚡' : ''}{s.is_shielded ? ' 🛡️' : ''}</span><span>{s.amount_paid}🪙</span></div>)}
      {seats.length === 0 && <div className="muted">No seats yet — be the first in.</div>}</div></div>;
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('pr_token') || '');
  const [me, setMe] = useState(null); const [page, setPage] = useState('lobby');
  const [rounds, setRounds] = useState([]); const [tiers, setTiers] = useState([]);
  const [selected, setSelected] = useState(null); const [msg, setMsg] = useState('');
  const [lastClosed, setLastClosed] = useState(null); const [verify, setVerify] = useState(null);
  const [username, setUsername] = useState(''); const [muted, setMutedState] = useState(isMuted());
  const [showPayout, setShowPayout] = useState(false);

  const load = async () => {
    try { setTiers(await api('/api/tiers')); const rs = await api('/api/rounds/active'); setRounds(rs); if (selected) { const f = rs.find(r => r.id === selected.id); if (f) setSelected(f); } } catch (e) { setMsg(e.message); }
    if (token) { try { setMe(await api('/api/me', { token })); } catch {} }
  };
  useEffect(() => { load(); const s = io(API); s.on('round:update', () => load()); s.on('round:closed', (d) => { setLastClosed(d); setShowPayout(true); if (d.payouts?.some(p => p.total > 0)) sfx.win(); else sfx.lose(); load(); }); return () => s.disconnect(); }, [token]);
  useEffect(() => { const t = setInterval(load, 5000); return () => clearInterval(t); }, [token, selected]);

  const login = async (mode) => { try { const d = await api('/api/auth/' + mode, { method: 'POST', body: { username } }); localStorage.setItem('pr_token', d.token); setToken(d.token); setMe({ user: d.user, wallet: d.wallet }); sfx.win(); setMsg('Welcome, ' + d.user.username + ' — ' + d.wallet.balance + ' starter coins (play-money only).'); } catch (e) { setMsg(e.message); } };
  const logout = () => { localStorage.removeItem('pr_token'); setToken(''); setMe(null); };
  const toggleMute = () => { const v = !muted; setMuted(v); setMutedState(v); };
  const join = async (round, boost, useBellShuffle) => { try { sfx.tap(); const d = await api(`/api/rounds/${round.id}/join`, { token, method: 'POST', body: { boost, useBellShuffle } }); sfx.coin(); setMsg(`Seat joined: ${d.seat.row} row, ${d.seat.amount_paid} coins${d.closed ? ' — round closed, payouts sent!' : ''}`); load(); } catch (e) { setMsg(e.message); } };
  const myWin = lastClosed && me ? lastClosed.payouts.filter(p => p.total > 0).reduce((s, p) => s + p.total, 0) : 0;

  return <div className="wrap">
    <div className="top"><div><div className="big">🏊 Pool Rush: 80/20</div><div className="muted">Virtual coins only. No cash-out, ever. Tap, play, win coins for cosmetics.</div></div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={toggleMute} style={{ background: '#1e293b' }}>{muted ? '🔇 Sound off' : '🔊 Sound on'}</button>
        {me ? <><span className="pill">👤 {me.user.username}</span><span className="pill">🪙 {me.wallet?.balance ?? '?'} coins</span>{me.user.gold_front_row && <span className="pill">⭐ Gold Front Row</span>}<span className="pill">🔥 Streak {me.user.streak}</span><button onClick={logout}>Log out</button></> : <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><input placeholder="username" value={username} onChange={e => setUsername(e.target.value)} style={{ width: 160 }} /><button onClick={() => login('register')}>Register</button><button onClick={() => login('login')}>Login</button></div>}
      </div></div>
    {msg && <div className="card">{msg}</div>}
    <div className="nav">{['lobby', 'round', 'wallet', 'profile', 'admin'].map(p => <button key={p} className={page === p ? 'on' : ''} onClick={() => { sfx.tap(); setPage(p); }}>{p === 'lobby' ? '🎮 Lobby' : p === 'round' ? '🏟️ Arena' : p === 'wallet' ? '👛 Wallet' : p === 'profile' ? '👤 Profile' : '🛠️ Admin'}</button>)}</div>

    {showPayout && lastClosed && <div className="overlay" onClick={() => setShowPayout(false)}><Confetti count={48} /><div className="overlay-card" onClick={e => e.stopPropagation()}><div style={{ fontSize: 56 }}>🎉</div><h2 style={{ margin: '8px 0' }}>Round closed!</h2><p className="muted">Seed revealed: <code>{lastClosed.server_seed?.slice(0, 16)}…</code><br />Snapshot: <code>{lastClosed.snapshot_hash?.slice(0, 16)}…</code></p>
      {lastClosed.payouts.filter(p => p.total > 0).slice(0, 12).map((p, i) => <div className="seat" key={i}><span>{p.kind}</span><b>+{p.total} coins</b></div>)}
      <p className="muted">Tap anywhere outside to keep playing.</p><button onClick={() => setShowPayout(false)}>Keep playing</button></div></div>}

    {page === 'lobby' && <div>
      <h2 style={{ marginBottom: 4 }}>Choose your arena</h2><p className="muted">Front Row = seats before 80% fill. At 80% the Lock Bell rings for 20s: late seats cost 2× and lose to Front Row, minus a 10% house cut.</p>
      <div className="grid">{rounds.map(r => { const t = tiers.find(x => x.id === r.tier_id); return <div className="card" key={r.id}>
        <PoolStage round={r} />
        {r.status === 'lock_bell' && <div className="bellbox"><span className="bell-big">🔔</span><div><b>LOCK BELL</b> — closes in <Countdown iso={r.lock_bell_ends_at} /> — late seats 2×</div></div>}
        {r.status === 'priority' && <div>⭐ Priority entry ends in <Countdown iso={r.priority_ends_at} /> (Gold Front Row only)</div>}
        {r.status === 'open' && <div className="muted">Closes in <Countdown iso={r.open_ends_at} /> or at target • Status: <b>{r.status}</b></div>}
        <div className="action-bar">
          <button onClick={() => { setSelected(r); setPage('round'); }}>🏟️ Enter arena</button>
          <button disabled={!token} onClick={() => join(r, false, false)}>Join ({r.status === 'lock_bell' ? r.seat_price * 2 : r.seat_price}🪙)</button>
          <button disabled={!token} onClick={() => join(r, true, false)}>⚡ Boost ×2</button>
        </div>
        {!token && <div className="muted">Log in to join.</div>}
      </div>; })}</div>
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
  const tap = () => { sfx.tap(); const now = Date.now(); if (!tapStart) setTapStart(now); setTaps(t => t + 1); };
  const submitShuffle = async () => { try { const d = await api(`/api/rounds/${round.id}/bell-shuffle/claim`, { token, method: 'POST', body: { taps, durationMs: tapStart ? Date.now() - tapStart : 99999 } }); if (d.granted) sfx.win(); setShuffleMsg(d.granted ? '✅ Granted! Now join with Bell Shuffle (base price).' : `❌ Not fast enough (${d.taps} taps). Attempts left: ${d.attempts_left}`); setTaps(0); setTapStart(null); } catch (e) { setShuffleMsg(e.message); } };
  const shield = async (seatId) => { try { const d = await api(`/api/rounds/${round.id}/shield`, { token, method: 'POST', body: { seatId } }); sfx.coin(); setMsg(`Shielded! Activation fee ${d.activation_fee} coins. Rescued player gets stake back minus 20% rescue fee (paid to you).`); load(); } catch (e) { setMsg(e.message); } };
  return <div>
    <div className="card"><PoolStage round={round} />
      {round.status === 'lock_bell' && <div className="bellbox"><span className="bell-big">🔔</span><div><b>LOCK BELL</b> — <Countdown iso={round.lock_bell_ends_at} /> left — late seats at 2×, Back Row loses to Front Row</div></div>}
      {round.status === 'priority' && <div>⭐ Priority: <Countdown iso={round.priority_ends_at} /> left (Gold Front Row only)</div>}
      {round.status === 'open' && <div className="muted">Open closes in <Countdown iso={round.open_ends_at} /></div>}
      <div className="action-bar">
        <button className="primary" disabled={!token} onClick={() => join(round, false, false)}>🎟️ Join single</button>
        <button disabled={!token} onClick={() => join(round, true, false)}>⚡ Join Boost (2 seats)</button>
        <button disabled={!token} onClick={() => join(round, false, true)}>🎲 Join with Shuffle grant</button>
      </div>
      <div className="muted">Server seed hash (pre-close commitment): <code style={{ wordBreak: 'break-all' }}>{round.serverSeedHash}</code></div>
    </div>
    {round.status === 'lock_bell' && <div className="card"><h3 style={{ marginTop: 0 }}>⚡ Bell Shuffle — tap fast, pay base price</h3><p className="muted">Tap 5 times within 3 seconds to unlock ONE late seat at base price (instead of 2×). Max 3 attempts per round. Big button, thumb-friendly.</p>
      <button className="tap" onClick={tap}>👆 TAP ({taps})</button><div className="action-bar"><button onClick={submitShuffle}>Submit taps</button><button onClick={() => { setTaps(0); setTapStart(null); }}>Reset</button></div>{shuffleMsg && <div>{shuffleMsg}</div>}
    </div>}
    <SeatRing title="🟢 Front Row — stake back + profit share" seats={front} />
    <div className="card"><h3 style={{ marginTop: 0 }}>🔴 Back Row — loses stake unless shielded</h3>
      {back.map(s => <div className="seat" key={s.id}><span>#{s.seq} {s.username}{s.is_shielded ? ' 🛡️ Safe' : ''}{s.is_bell_shuffle ? ' ⚡Shuffle' : ''}</span><span><b>{s.amount_paid} coins</b>{amFront && !s.is_shielded && <button style={{ marginLeft: 8 }} onClick={() => shield(s.id)}>Shield</button>}</span></div>)}
      {back.length === 0 && <div className="muted">No Back seats yet. The Lock Bell starts at 80%.</div>}
    </div>
    <p className="muted">Last player to join before close gets a Last Call consolation (5% of the losers' pool) even if Back Row. 3 Front Row wins in a row unlock Gold Front Row priority entry.</p>
  </div>;
}

function WalletPage({ me, token, setMsg, load }) {
  const [packs, setPacks] = useState([]); const [shop, setShop] = useState([]); const [wallet, setWallet] = useState(null);
  useEffect(() => { api('/api/topup-packs').then(setPacks); api('/api/shop').then(setShop); if (token) api('/api/wallet', { token }).then(setWallet); }, [token]);
  if (!token) return <div className="card">Log in to see your wallet.</div>;
  const topup = async (packId) => { try { const d = await api('/api/wallet/topup', { token, method: 'POST', body: { packId } }); sfx.coin(); setMsg(`Top-up (mock receipt ${d.mock_receipt}): +${d.coins} coins. No real money moved.`); setWallet(d.wallet); load(); } catch (e) { setMsg(e.message); } };
  const buy = async (itemId) => { try { const d = await api('/api/shop/buy', { token, method: 'POST', body: { itemId } }); sfx.win(); setMsg(`Bought ${d.item.name} for ${d.item.price} coins.`); setWallet(d.wallet); load(); } catch (e) { setMsg(e.message); } };
  return <div>
    <div className="card"><h2 style={{ marginTop: 0 }}>👛 Wallet</h2><div className="big">🪙 {wallet?.wallet?.balance ?? me?.wallet?.balance} coins</div><p className="muted">Play-money only. There is no cash-out button in this app, by design.</p>
      <h3>Top up (mock coin packs — demo only, no payment gateway)</h3><div className="action-bar">{packs.map(p => <button key={p.id} onClick={() => topup(p.id)}>{p.label}</button>)}</div>
      <h3>Ledger (double-entry, latest first)</h3>{(wallet?.ledger || []).slice(0, 25).map(l => <div className="seat" key={l.id}><span>{l.ref_type} • {l.memo}</span><b>{l.credit > 0 ? '+' + l.credit : '-' + l.debit}</b></div>)}
    </div>
    <div className="card"><h2 style={{ marginTop: 0 }}>🛍️ Cosmetics shop — spend winnings here</h2>{shop.map(i => <div className="seat" key={i.id}><span>{i.name} — {i.description}</span><span><b>{i.price} coins</b> <button onClick={() => buy(i.id)}>Buy</button></span></div>)}</div>
  </div>;
}

function ProfilePage({ me, token, verify, setVerify }) {
  const [roundId, setRoundId] = useState('');
  if (!me) return <div className="card">Log in to see your profile.</div>;
  const u = me.user;
  const check = async () => { try { setVerify(await api(`/api/rounds/${roundId}/verify`)); } catch (e) { setVerify({ error: e.message }); } };
  return <div className="card"><h2 style={{ marginTop: 0 }}>👤 Profile — {u.username} {u.gold_front_row && '⭐ Gold Front Row'}</h2>
    <p>Streak: <b>{u.streak}</b> Front wins • Total Front wins: {u.total_front_wins} • Rounds played: {u.total_rounds_played}</p>
    <p className="muted">{u.gold_front_row ? 'You get 5 seconds of priority entry into every new round.' : `Win ${3 - u.streak} more Front Row round(s) in a row to unlock Gold Front Row priority entry.`}</p>
    <p>Owned cosmetics: {(me.items || []).join(', ') || 'none yet — win coins and buy some in the Wallet tab.'}</p>
    <h3>Recent payouts</h3>{(me.recent_payouts || []).map(p => <div className="seat" key={p.id}><span>{p.kind}</span><b>+{p.total} coins</b></div>)}
    <h3>Verify a closed round (provably transparent)</h3><p className="muted">Paste a closed round ID. The server seed is revealed only after close; the page re-hashes it and the seat snapshot to check both hashes.</p>
    <input placeholder="round UUID" value={roundId} onChange={e => setRoundId(e.target.value)} /><button style={{ marginTop: 8, width: '100%' }} onClick={check}>Verify</button>
    {verify && <pre style={{ whiteSpace: 'pre-wrap', background: '#0f172a', padding: 12, borderRadius: 12, overflowX: 'auto' }}>{JSON.stringify(verify, null, 2)}</pre>}
  </div>;
}

function AdminPage() {
  const [key, setKey] = useState(''); const [rounds, setRounds] = useState([]); const [ledger, setLedger] = useState([]); const [cfg, setCfg] = useState(null); const [tiers, setTiers] = useState([]); const [msg, setMsg] = useState('');
  const load = async () => { if (!key) return; try { setRounds(await api('/api/admin/rounds', { adminKey: key })); setLedger(await api('/api/admin/ledger', { adminKey: key })); setCfg(await api('/api/config')); setTiers(await api('/api/tiers')); } catch (e) { setMsg(e.message); } };
  const freeze = async (id, frozen) => { try { await api(`/api/admin/rounds/${id}/${frozen ? 'unfreeze' : 'freeze'}`, { adminKey: key, method: 'POST', body: { reason: 'Admin freeze' } }); load(); } catch (e) { setMsg(e.message); } };
  const saveCfg = async () => { try { await api('/api/admin/config', { adminKey: key, method: 'PUT', body: cfg }); setMsg('Config saved.'); } catch (e) { setMsg(e.message); } };
  return <div className="card"><h2 style={{ marginTop: 0 }}>🛠️ Admin</h2><p className="muted">Enter the Render ADMIN_KEY env value. On the test service, use the key given in chat.</p>
    <input value={key} onChange={e => setKey(e.target.value)} placeholder="Admin key" /><button style={{ marginTop: 8, width: '100%' }} onClick={load}>Load admin</button>{msg && <div>{msg}</div>}
    {cfg && <div><h3>Config</h3><label>House cut (bps, 1000 = 10%) </label><input type="number" value={cfg.house_cut_bps} onChange={e => setCfg({ ...cfg, house_cut_bps: Number(e.target.value) })} />
    <label>Streak to unlock </label><input type="number" value={cfg.streak_to_unlock} onChange={e => setCfg({ ...cfg, streak_to_unlock: Number(e.target.value) })} /> <button style={{ marginTop: 8 }} onClick={saveCfg}>Save config</button></div>}
    <h3>Tiers</h3>{tiers.map(t => <div className="seat" key={t.id}><span>{t.name}: {t.seat_price} coins × {t.target_seats} seats</span><span>{t.is_active ? 'active' : 'inactive'}</span></div>)}
    <h3>Rounds</h3>{rounds.slice(0, 20).map(r => <div className="seat" key={r.id}><span>{r.tier_id} • {r.status} • {r.filled_seats}/{r.target_seats}</span><button onClick={() => freeze(r.id, r.status === 'frozen')}>{r.status === 'frozen' ? 'Unfreeze' : 'Freeze'}</button></div>)}
    <h3>Ledger (latest)</h3>{ledger.slice(0, 30).map(l => <div className="seat" key={l.id}><span>{l.account} • {l.ref_type} • {l.memo}</span><b>{l.credit > 0 ? '+' + l.credit : '-' + l.debit}</b></div>)}
  </div>;
}
