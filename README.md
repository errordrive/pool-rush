# Pool Rush: 80/20 — virtual-coin pari-mutuel game

A full-stack web game. **Virtual coins only. No real-money cash-out exists
anywhere in this codebase** — there is no cash-out endpoint, no withdrawal
flow, and no payout to any payment provider. Top-up is a *mock* coin-pack
grant (a demo receipt, no gateway call). Winners receive coins spendable
only in-game: seats, shields, and cosmetics.

## How a round works

Each tier sets a seat price and a target number of seats.

| Tier | Seat price | Target seats | Pool target |
|---|---|---|---|
| Bronze | 100 | 20 | 2,000 |
| Silver | 500 | 20 | 10,000 |
| Gold | 2,000 | 20 | 40,000 |

1. **Priority (5s):** a new round opens first to Gold Front Row players only
   (3 Front Row wins in a row — see Streaks below).
2. **Open:** seats at base price. Every stake = one seat (Boost = 2× price,
   counts as 2 seats).
3. **80% — the Lock Bell:** when filled seats reach 80% of target (16/20),
   the round enters a 20-second Lock Bell. Joining is still allowed, but
   at **2× seat price**. Seats placed here are Back Row.
4. **Close:** when the pool hits target, when the Lock Bell ends, or when
   the 180s open timer expires — whichever comes first.
5. **Snapshot + payout:**
   - **Front Row** (placed before 80%, base price): stake back + a share
     of the losers' pool.
   - **Back Row** (placed during the Lock Bell, unshielded): stake is lost
     to the Front Row.
   - **House cut:** 10% of the losers' pool (configurable, `house_cut_bps`).
     The rest is split across Front Row seats, pro-rata by seat count,
     with leftover single coins going to the earliest Front seats.
   - If the timer closes a round before 80%, there is no losers' pool:
     Front Row simply get their stake back. No one profits from nothing.

### Worked example (Bronze)

16 Front seats × 100 = 1,600 staked. 4 Back seats × 200 = 800 losers' pool.
House cut = 80. Distributable = 720. Last Call (if the last joiner was Back
Row) = 5% of 800 = 40, leaving 680 for Front Row = 42 each, plus 2 leftover
coins to the first two Front seats (44, 44, 42, …). Each Front seat gets
100 back + ~42 profit. Each Back seat gets 0 (except Last Call).

### v2 twists (all implemented)

- **Shield:** a Front Row player shields a Back Row seat (not their own).
  Activation fee = 10% of seat price, paid by the shielder to the house
  immediately. At close the rescued player gets stake back **minus** a 20%
  rescue fee, and that rescue fee is paid to the shielder. Net for the
  shielder on a Bronze seat: pay 10, earn 40 on a 200-coin Back stake.
- **Boost seats:** 2× current price, counts as 2 seats, profit share ×2.
  Front Boost = 200 (Bronze), Back Boost = 400. Cannot combine with Bell Shuffle.
- **Bell Shuffle:** during the Lock Bell only. Tap 5 times within 3 seconds
  (max 3 attempts per round) to unlock ONE late seat at base price.
- **Last Call:** the last player to join before close, if they are an
  unshielded Back Row seat, gets 5% of the losers' pool as consolation,
  taken from the distributable pool before Front Row shares.
- **Streaks & tiers:** a Front Row seat with profit > 0 is a win; an
  unshielded Back Row seat resets the streak. Refunds and shielded seats
  leave the streak unchanged. At 3 wins, the player becomes Gold Front Row
  and gets 5s priority entry into every new round, until they lose a round.

### Provably transparent

Each round is created with a random 32-byte `server_seed`. Only
`sha256(seed)` is published before close (see the round view and
`GET /api/rounds/:id`). After close, `GET /api/rounds/:id/verify` reveals
the seed, re-checks `sha256(seed) == seed_hash`, and re-checks the
snapshot hash `sha256(seed + '|' + JSON(snapshot seats))`.

## Quick start (no database needed)

```bash
cd pool-rush/backend
npm install
npm run dev        # http://localhost:4000, in-memory store

cd ../frontend
npm install
npm run dev        # http://localhost:5173
```

Open http://localhost:5173, register a username, and join a round.
You start with 1,000 starter coins. Top up from the Wallet tab with a mock
pack if you run low.

## With Postgres + Redis (optional, recommended for real use)

```bash
docker compose up --build   # postgres + redis + backend
# then, in another terminal:
cd frontend && npm install && npm run dev
```

Or run Postgres yourself and point the backend at it:

```bash
psql "$DATABASE_URL" -f db/schema.sql
DATABASE_URL=postgres://user:pass@localhost:5432/poolrush REDIS_URL=redis://localhost:6379 \
  ADMIN_KEY='change-me' npm --prefix backend run dev
```

The backend uses Postgres when `DATABASE_URL` connects, and falls back to
the in-memory store (with a log line) when it does not — it never silently
invents balances. Redis, when `REDIS_URL` is set, mirrors live round state;
Socket.io is the live ticker either way. The schema in `db/schema.sql` is
the canonical table set: `users, wallets, wallet_ledger (double-entry),
rounds, seats, payouts, rounds_config, tiers`, plus `shop_items` and
`user_items`.

## API (base http://localhost:4000)

Auth is demo-grade: `Authorization: Bearer <userId>` returned by
register/login. Do not ship this auth to production unchanged — put real
sessions/JWT in front of it.

- `POST /api/auth/register {username}` / `POST /api/auth/login {username}`
- `GET /api/me`, `GET /api/tiers`, `GET /api/config`, `GET /api/topup-packs`
- `GET /api/rounds/active`, `GET /api/rounds/:id`, `GET /api/rounds/:id/verify`
- `POST /api/rounds/:id/join {boost?, useBellShuffle?}` (auth)
- `POST /api/rounds/:id/bell-shuffle/claim {taps, durationMs}` (auth)
- `POST /api/rounds/:id/shield {seatId}` (auth, Front Row only)
- `GET /api/wallet`, `POST /api/wallet/topup {packId | coins}` (auth, mock)
- `POST /api/cashout` → always 403, by design
- `GET /api/shop`, `POST /api/shop/buy {itemId}` (auth)
- Admin (`x-admin-key` header, default `dev-admin-key`, set `ADMIN_KEY`):
  `GET /api/admin/rounds`, `GET /api/admin/ledger`,
  `POST /api/admin/tiers`, `PUT /api/admin/tiers/:id`,
  `PUT /api/admin/config`,
  `POST /api/admin/rounds/:id/freeze|unfreeze`,
  `POST /api/admin/rounds/create {tierId}`

WebSocket (Socket.io): `round:update` on every join/phase change,
`round:closed` with payouts + revealed seed, `ticker` every second.

## Automated check

```bash
# with the backend running on :4000
node scripts/simulate-round.mjs
```

It registers players, fills a Bronze round past 80%, shields one Back seat,
closes the round at target, and prints every payout plus the verify hashes
— and asserts the ledger balances (payouts + house cut == total stakes).

## Honest limits

- Demo auth (Bearer userId), no passwords, no rate limiting beyond the
  Bell Shuffle attempt cap — add real auth + limits before public use.
- Mock top-up only. If you ever add a real coin-pack provider, keep it
  one-way (buy coins, never cash out) and get legal review for your market.
- Timers run in-process; a backend restart loses in-flight rounds in
  memory mode. Postgres mode persists rounds/seats/ledger, but the tick
  loop restarts from stored state.
