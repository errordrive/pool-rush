Pool Rush: 80/20 — Botkeep deploy
================================
1. Botkeep panel -> New workload -> Upload this ZIP (its contents at root).
2. Runtime: Node 24. Start command:
     node start.cjs
   (It installs backend deps once if needed, then runs the server, which
   serves the built frontend itself. No frontend build step on Botkeep.)
3. Port: Botkeep sets SERVER_PORT automatically; the server listens on it.
   Leave PORT unset unless Botkeep asks for it.
4. Environment (optional):
     ADMIN_KEY = a secret admin key (default dev-admin-key if unset)
5. Data is in-memory by default (rounds/wallets reset on restart). That is
   fine for testing. For persistence, add a Postgres DATABASE_URL later.
6. Virtual coins only — no cash-out exists in this app.
