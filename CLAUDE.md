# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Run from the relevant subdirectory; there is no root `package.json`.

**Backend** (`backend/`):
- `npm install` — install deps
- `npm run dev` — nodemon, hot-reload on port 3001
- `npm start` — plain `node server.js` (what Railway runs)

**Frontend** (`frontend/`):
- `npm install` — install deps
- `npm run dev` — Vite dev server on port 5173 (CORS already permits this origin)
- `npm run build` — `tsc && vite build` → outputs `frontend/dist/`
- `npm start` — serve the built `dist/` via `frontend/server.js` (only used standalone; Railway uses the backend to serve `dist/` instead)

**Tests / lint:** none configured. Don't claim a change is verified by tests — there aren't any. Type-check runs only as part of `npm run build`.

**Production build (matches Railway):** `cd frontend && npm install && npm run build && cd ../backend && npm install && node ../backend/server.js`. The backend auto-serves `frontend/dist/` if it exists ([`backend/server.js`](backend/server.js) — search for `frontendDist`).

## Architecture

**Single-process production deployment.** In prod, [`backend/server.js`](backend/server.js) hosts both the JSON API (`/api/*`) and the static SPA (`frontend/dist/*`) with an `app.get('*')` SPA fallback. The standalone [`frontend/server.js`](frontend/server.js) exists but is unused in the Railway deployment (see [`Procfile`](Procfile) and [`railway.json`](railway.json), which both start `node backend/server.js`).

**Database is sql.js, not better-sqlite3 or sqlite3.** [`backend/database.js`](backend/database.js) loads the entire DB file into memory on startup and writes the full file back via `saveDb()` after every `run(...)` mutation. Implications:
- No prepared-statement reuse, no transactions.
- Concurrent writes are not safe — there is one in-memory `db` object.
- Schema is created and migrated in `initializeDatabase()` / `runMigrations()` in the same file. Migrations are idempotent `ALTER TABLE` calls wrapped in try/catch that swallow "column already exists" errors. To add a column: append to the `migrations` array in [`backend/database.js`](backend/database.js) — do **not** edit the original `CREATE TABLE`.
- DB lives at `backend/crm.db` by default (override with `DB_PATH`). A nightly cron in `server.js` copies it into `backend/backups/`.

**Auth is JWT in the `Authorization: Bearer` header — never cookies.** Token lives in `localStorage` under `crm_token`; user blob under `crm_user`. The frontend [`src/api/index.ts`](frontend/src/api/index.ts) `request<T>()` helper attaches the header and force-logs-out on 401/403 by dispatching a `auth:logout` window event consumed by [`AuthContext`](frontend/src/context/AuthContext.tsx). **Never add `credentials: 'include'` on the client or `credentials: true` on the server CORS config** — doing so makes preflight require an exact-origin match and silently breaks login (this has happened in prod). Every protected route applies `authMiddleware` per-handler (not via `router.use`); follow that pattern when adding routes.

**CORS is hardcoded.** Production origins (`hausdorff-crm-production.up.railway.app`, `crm.hausdorff.co.il`, `localhost:5173`) live as a literal list in `backend/server.js`. The code merges in a comma-split `CORS_ORIGIN` env var, but in practice that env var is intentionally **not** set on Railway — edit the source list instead.

**Frontend API base URL is build-time, not runtime.** [`frontend/vite.config.ts`](frontend/vite.config.ts) uses `define` to substitute `import.meta.env.VITE_API_URL` at build time, with a hardcoded production fallback. The `import.meta.env` lookup in [`frontend/src/api/index.ts`](frontend/src/api/index.ts) (`BASE_URL`) is therefore frozen into the bundle. To point a build at a different backend, set `VITE_API_URL` in the build environment — there is no runtime override.

**Routing.** The Express app mounts one router per resource from [`backend/routes/`](backend/routes) (contacts, companies, projects, properties, deals, tasks, timeline, dashboard, attachments, proposals, activities, goals, calendar, meetings, leads, property_files). The React SPA defines all routes in [`frontend/src/App.tsx`](frontend/src/App.tsx) under a single `<ProtectedRoute><Layout/></ProtectedRoute>` shell; `/login` is the only unauthenticated page.

**Background jobs run inside the API process** via `node-cron` in [`backend/server.js`](backend/server.js):
- `0 6 * * *` Asia/Jerusalem — Smart Match: scores active contacts against available properties, inserts rows into `match_notifications` when score ≥ 80 (yield matches force score = 80).
- `0 2 * * *` Asia/Jerusalem — DB backup: copies `crm.db` to `backups/`, prunes to last `BACKUP_KEEP_COUNT` (default 7).

**Hebrew is the UI language.** Error messages, status enums (`'פעיל'`, `'זמין'`, `'בבנייה'`, `'משרד'`, `'גבוה'`, etc.), and seed data are all Hebrew. The migration block in `runMigrations()` rewrites legacy enum values (e.g. `'דירה'` → `'משרד'`, `'קונה'` → `'רוכש פוטנציאלי'`) — when adding new enum-style values, also add a data migration there if you're renaming an existing value.

## Key paths

- Backend entry: [`backend/server.js`](backend/server.js)
- DB + schema + migrations + seed: [`backend/database.js`](backend/database.js)
- Auth middleware + JWT secret: [`backend/middleware/auth.js`](backend/middleware/auth.js)
- Frontend API client: [`frontend/src/api/index.ts`](frontend/src/api/index.ts)
- Auth context (token storage): [`frontend/src/context/AuthContext.tsx`](frontend/src/context/AuthContext.tsx)
- Routes (top-level): [`frontend/src/App.tsx`](frontend/src/App.tsx)

## Environment variables

Backend reads (none are required for local dev):
- `PORT` (default 3001), `NODE_ENV` (gates rate limits + CORS strictness)
- `JWT_SECRET` — **required in production**, falls back to a hardcoded dev string otherwise (process exits if missing in prod)
- `DB_PATH`, `BACKUP_DIR`, `BACKUP_KEEP_COUNT`, `UPLOADS_DIR`
- `WEBHOOK_VERIFY_TOKEN` (Facebook Lead Ads webhook in `routes/leads.js`)
- Google Calendar OAuth (`routes/calendar.js`): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, plus `BASE_URL` (backend's own public origin — the callback URI is derived as `${BASE_URL}/api/calendar/callback`) and `FRONTEND_URL` (where the callback redirects afterwards, to `/settings`). `GOOGLE_REDIRECT_URI` optionally overrides the derived callback URI outright. The redirect URI must byte-match the one registered in the Google Cloud console.
- `CORS_ORIGIN` exists but **leave unset on Railway** — see CORS note above.

## Test users (seeded on first run)

`admin@hausdorff.co.il / Admin123` · `rafi@hausdorff.co.il / Rafi123` · `david@hausdorff.co.il / David123`
