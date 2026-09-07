# Architecture Reference (Developer)

**Architecture** · *How the whole system fits together — file paths, modules and versions. The page to hand a new engineer.*

**Audience:** Engineers · **Document date:** 24 July 2026 · Part of the RackTrack documentation set. *A plain-English, path-free version of this same material is in [overview-users.md](overview-users.md).*

---

## On this page

1. In simple terms
2. The big picture
3. The client apps
4. The server
5. The machine-learning pipeline
6. Where data lives
7. How a scan flows through the system
8. Identity, tenancy & access
9. Integrations & external systems
10. Build & deploy
11. Cross-cutting concerns
12. Glossary

---

## 1. In simple terms

RackTrack turns **one photo of a server rack** into a structured, verified inventory. A phone or tablet sends the photo to a server; a Python machine-learning pipeline detects every unit, device and port; the result is stored, shown back to the user for confirmation, checked against their records (CMDB), and turned into shareable reports. Corrections users make are fed back into the models so accuracy improves over time.

Three moving parts do the work: a **React client** (native app + web), a **Node/Express server** (the monolith that holds the business logic), and a **Python ML pipeline** (the vision models). Around them sit SQLite for identity/records, a per-rack filesystem for scan artifacts, and a set of fail-soft integrations (ServiceNow, netdisco, live switches, and more).

## 2. The big picture

```
        ┌─────────────────────────────────────────────┐
        │  CLIENT  (client/)                            │
        │  React 18 + Vite SPA, Capacitor iOS/Android   │
        │  camera → /api/analyze → /results/:rackId     │
        └───────────────┬───────────────────────────────┘
                        │  HTTPS (Bearer JWT / asset token / report token)
                        ▼
        ┌─────────────────────────────────────────────┐
        │  SERVER  (server/app.js, ~9.4k lines)         │
        │  Express 4 · helmet · CORS · asset guard      │
        │  auth · scan · feedback · report · ground-    │
        │  truth · sub-routers (netdisco, cmdb, market) │
        └───┬───────────────┬───────────────┬───────────┘
            │               │               │
   newline-JSON        SQLite          filesystem
   over stdin/out    (better-sqlite3)   outputs/<rackId>/
            │               │               │
            ▼               ▼               ▼
    ┌───────────────┐  ┌──────────┐  ┌──────────────────┐
    │ PYTHON POOL   │  │ auth.db  │  │ device_unit_map  │
    │ pipeline/     │  │ logs.db  │  │ scan_result.json │
    │ YOLO · OCR ·  │  └──────────┘  │ ocr_devices.json │
    │ active learn  │                │ feedback.jsonl   │
    └───────────────┘                │ images/*.png     │
                                     └──────────────────┘

   External (all env-gated, fail-soft):
   ServiceNow CMDB · NetBox/DCIM profiles · netdisco (Docker) ·
   live switches over SSH (lab/EVE-NG) · DOT support bot · Marketplace (Stripe)
```

## 3. The client apps

One React codebase (`client/`) ships two ways: as a **web SPA** and as **native iOS/Android** apps via Capacitor.

- **Stack:** React `^18.3.1`, **react-router-dom `^6.26.0`** (`BrowserRouter`), **Vite `^5.4.0`** (`client/vite.config.js`). Native shell is **Capacitor `^6.2.1`** (`@capacitor/core|ios|android`) with `@capacitor/camera ^6.1.0` and `@capacitor/app ^6.0.3` (hardware back button + resume). 3D topology uses **three `^0.169.0`** + `@react-three/fiber|drei|xr`. Tests: Vitest `^2.1.9`.
- **Capacitor config** (`client/capacitor.config.json`): appId `com.racktrack.app`, `webDir: dist`, custom user-agent `RackTrack/1.0 (native app; …)` — the server uses UA to recognise native clients.
- **API base** (`client/src/utils/api.js`): `VITE_API_BASE` — empty in dev (Vite proxies `/api`, `/outputs`, `/uploads` → `localhost:3001`), set to the public tunnel host for the APK. `authFetch` attaches the Bearer token; `apiUrl()` builds absolute URLs.
- **State & auth** (Context, not Redux): `AuthContext.jsx` keeps the token + user in `localStorage` (via `safeStorage`), validates against `/api/auth/me`, and mints a short-lived **asset token** every ~12h because `<img>` tags can't send an `Authorization` header. Also `ConnectionsContext`, `ShutterContext`, `ThemeContext`.
- **Theme:** a single **light** theme by design. `ThemeContext.jsx` hardcodes `'light'` and `toggleTheme` is a no-op; tokens live in `client/src/index.css` (`:root`, Material-3 palette — primary `#121417`, outline `#E0E0E0`, all surfaces forced to `#FFFFFF`). Dark-mode selectors exist but resolve to the same white tokens — **there is no working dark mode**.
- **Routing:** routes in `client/src/App.jsx`; nav destinations in `client/src/nav/navLinks.jsx` (single source read by both the desktop sidebar `DesktopShell` and the phone `BottomNav`; `ResponsiveLayout`/`useHasSidebar` renders inside the shell at ≥1024px, bare + bottom nav below). Guards: `ProtectedRoute`, `AdminRoute` (org_admin/owner), `OwnerRoute`, `PendingRoute`. Key pages: `ScanPage`, `ResultsPage`, `GroundTruthPage`, `DashboardPage`, `OrgConsolePage`, `ConnectionsPage`, `MarketplacePage`, `HelpPage` (DOT).

## 4. The server

`server/app.js` is the monolith — **~9,441 lines** — holding most route handlers inline (scan/analyze, feedback, report, ground-truth, share) plus the server-rendered report HTML/CSS, and mounting sibling sub-routers. It listens on `PORT || 3001` and is **single-process** (there is no Node `cluster`); "workers" elsewhere means the Python ML pool.

- **Run model:** guarded by `if (require.main === module)` (`app.js:9365`); binds with retry-on-EADDRINUSE (up to 20 attempts), starts the SSH port-poller, and handles SIGINT/SIGTERM graceful shutdown (drain SSH, close worker pool, 30s ceiling).
- **Dependencies** (`server/package.json`): express `^4.18.2`, **better-sqlite3 `^12.11.1`**, **puppeteer `^24.42.0`** (PDF), **sharp `^0.34.5`** (images), jsonwebtoken `^9.0.3`, bcryptjs, helmet `^8.2.0`, cors, multer (uploads), **ssh2 `^1.17.0`** (switch console/poller), **stripe `^22.3.2`** (marketplace), nodemailer, **pino** + pino-http (logs), **prom-client** (metrics).
- **Middleware chain** (order matters, `app.js` ~262–412): `o11y.requestId` → `httpLogger` → `httpMetrics` → **helmet** → **CORS** (allow-list from `CORS_ALLOWED_ORIGINS`) → Stripe raw-body webhook capture → `express.json()` → **static asset guard** on `/uploads` and `/outputs`.
- **Static asset guard** (security-critical): `assetsOnly` serves only image extensions (JSON/OCR/topology/transcripts are API-only), then `assetAuth` normalises the path (repeated percent-decode, backslash folding, `..`-escape check), extracts the rack id, and authorises via **report token OR asset token OR Bearer**, delegating to `rackAccess.canAccessRack`. Denials return **404, never 403** (a 403 would confirm a rack exists across tenants).
- **Rate limits:** `authLimit` on the auth routes; a token-bucket `uploadLimiter` (`server/lib/rate_limit.js`, default 20 uploads/min/caller).
- **Observability** (`server/lib/observability.js`): pino structured logs with secret redaction, prom-client metrics at `/metrics`, `/healthz`, a SQLite log mirror (`server/lib/log-store.js` → `logs.db`), and `/api/version` (live git commit + start time).
- **Sub-routers** (mounted ~430–556, each in try/catch, often env-gated): `auth.registerRoutes` (`/api/auth/*`, orgs/sites/members/invites), `netdisco_proxy` (`/api/netdisco/*`), `port_history` (`/api/ports/*` drift), `support_routes` (`/api/support/*` DOT), `lab_devices` (`/api/lab/*`, owner-only), `cmdb_ticket_proxy` (`/api/cmdb/ticket/*`), `connection_profiles_routes` (`/api/connections/*`), `marketplace_routes` (`/api/marketplace/*`), plus gated demo/mock routers.

## 5. The machine-learning pipeline

All under `pipeline/` (Python). Frameworks (`requirements.txt`): **PyTorch `torch>=2.1.0`** + torchvision, **Ultralytics YOLO `>=8.3.43`** (floor deliberately above the compromised 8.3.41/42 releases), **EasyOCR `>=1.7.1`**, opencv-headless, Pillow, onnxruntime, numpy pinned `<2.0` (EasyOCR ABI).

- **Models** (`Models/`): `devices_seg.pt` (YOLO segmentation, ~12 device classes), `ports_9.pt` (typed ports — RJ45/SFP/QSFP/console/…), `port_count.pt` (port status/occupancy), `pdu_ports_v1_det_best.pt` (PDU outlets), `cable_eff_best` (EfficientNet cable-colour, 14 classes), `rack_classifier.pth` (occlusion, MobileNet/torch).
- **Node → Python bridge:** a **persistent worker pool** (`server/worker-pool.js`, `class WorkerPool`), spawned in `app.js:763` as `python3 -u -m pipeline.worker` (`RACKTRACK_WORKERS`, `PYTHON_PATH` overridable). Models stay resident; requests are **newline-delimited JSON** over stdin/stdout. Test seams: `RACKTRACK_POOL_MODULE`, `RACKTRACK_SKIP_WORKER_POOL=1`.
- **Worker commands** (`pipeline/worker.py handle_request`): `quality_check`, `detect_only`, `analyze`/`pipeline` (via `handle_pipeline`, sub-commands `enrich_cables`, `select`), `relabel_port_count`, `extract_best_frame`, `split_video_racks`, `extract_ticket`, `feedback_scoreboard`, `feedback_refresh`, and more. Core modules: `runner.py` (orchestrator), `detection.py`, `port.py`/`port_pattern.py`, `ocr_devices.py`, `quality_check.py`, `occlusion_model.py`, `rack_stitch.py`, `multi_rack_split.py`, `sfp_recommend.py`.
- **Active learning** (`pipeline/active_learning/`, scoped per organisation → `active_learning_Cache/data/org_<id>/`): `store.py` keeps per-model `corrections.json` for `("cable","devices","ports","port_type")`, a `verified_ports.json` (**model bypass** — a user-verified port layout served instead of re-running YOLO), a `confirmed_racks.json` alias cache (re-shot confirmed rack served without re-detection, ≥0.96 similarity), and YOLO-format `dataset_for_finetune/` snapshots. `memory.py` matches via a fast **perceptual hash** (Hamming ≤ 6) then a robust **ResNet-18** cosine similarity (512-d, threshold 0.88). `cli.py` is the request handler (`add_correction`, `apply_to_scan`, …).

## 6. Where data lives

Two stores, on purpose: **SQLite for identity/records, filesystem for scan artifacts.**

**SQLite** (`better-sqlite3`, WAL), two DBs under `server/data/`:
- **`auth.db`** — relational core (tables created/migrated in `server/auth.js`): `tenants` (= **Sites**), `users` (`role`, `tenant_id`, `organization_id`, `public_id` like `OWN-/ADM-/USR-0001`), `organizations` (`status` active/pending), `rack_owners` (the tenancy backbone — a many-to-many claim of `rack_id` ↔ `tenant_id`), `rack_groups`/`rack_group_members` (multi-rack scans), `invites`, `pending_signups`, `password_resets`, `monitored_devices` (SSH-polled switches, owner-only), plus marketplace tables.
- **`logs.db`** — operational, separate from business data: `app_logs` (pino mirror) and `audit_log` (`server/audit.js` — append-only, tenant-scoped: `ts, user_id, action, target_type, target_id, status, ip, payload`).
- Also under `server/data/`: `jwt.secret`, `oui-vendors.json` (MAC vendor lookup), `support-kb.json` (DOT KB), `switch_cli_matrix.json`.

**Filesystem — per-rack artifacts** under `outputs/<rackId>/` (shared across tenants who scan the same image; visibility gated by `rack_owners`):
- `device_unit_map.json` — master detection map (devices, classes, confidences, boxes, units, ports, PDU power).
- `scan_result.json` — API-facing canonical record (`schema: scan_result.v1`; devices with `label`, `position`, port counts).
- `ocr_devices.json` — per-device make/model/version from OCR.
- `scan_meta.json` — `rackId`, `userId`, `imageHash`, `timestamp`, `quality`.
- `feedback.jsonl` — append-only corrections (also aggregated to `server/feedback.jsonl`).
- `images/` — rendered stage PNGs (`2_devices_only.png`, `3_units_and_devices.png`, `7_rack_all_ports.png`, …) + `original_image.jpg`; plus `topology.json`, `report.html`, `report.pdf`.

**Rack identity:** `computeRackId` (`app.js:712`) = `RK-` + first 8 hex of `SHA-256(scope + '\0' + imageBytes)`, where `scope` ∈ `org:<id>` / `tenant:<id>` / `global`. Content-addressed (re-uploading the same image is a cache hit), scope-separated (unrelated orgs can't collide). `scanId === rackId`. Validated everywhere by `RACK_ID_RE = /^RK-[A-Za-z0-9]{4,32}$/` (`server/lib/rack_access.js`).

## 7. How a scan flows through the system

1. **Capture & send** — `ScanPage.jsx` posts the photo to `POST /api/analyze` (multer field `image`).
2. **Quality gate** — `pipeline/quality_check.py` checks tilt, letterbox, side-angle and occlusion (`rack_classifier.pth`); hard-fails or soft-warns; metrics saved to `scan_meta.json`.
3. **Detect** — the Python pool runs device segmentation, port detection, PDU outlets; OCR runs just after. Output → `device_unit_map.json` + `images/`.
4. **Identity & cache** — `computeRackId` hashes the image; a duplicate returns the cached result.
5. **Canonical result** — `writeCanonicalScanResult` merges everything into `scan_result.json`, overlaying any user corrections with a `_correction` trail and an accuracy scoreboard.
6. **Show & correct** — `ResultsPage.jsx` draws boxes over the photo; corrections post to the `/api/feedback/*` family, append to `feedback.jsonl`, and feed active-learning memory.
7. **Report & share** — `buildScanReportData` → `renderHTMLReport` (HTML/PDF/CSV/JSON); a 5-minute report token authorises the iframe; PDF shares to Slack/Teams/Outlook.

*(For the full trace see the [Scan Results & Device Detection](../features/scan-results-device-detection.md) doc.)*

## 8. Identity, tenancy & access

**Hierarchy:** **Owner (platform) → Organization (+ Org Admin) → Site (a `tenants` row) → Users.** Racks/scans are per-Site; active-learning memory is shared across the whole Organization.

- **Roles** (`users.role`, default `member`): `owner` (platform superadmin, sees everything), `org_admin` (one organisation), `site_manager` (one Site), `member` (regular user).
- **JWT** (`server/auth.js`): HS256 signed with `data/jwt.secret` (or `JWT_SECRET`). Payload `{ sub, username, tenantId, organizationId, role }`, TTL **30d**.
- **Rack access** — single source of truth `server/lib/rack_access.js` `canAccessRack(principal, rackId, tenant)`: `owner` → every rack; `org_admin` → any rack held by a Site in their org; everyone else → their own Site only, **fails closed**. `rackOwnershipParam` builds the `:rackId` Express guard, mounted on the parent app *and* each sub-router (Express doesn't propagate `app.param` to mounted routers — an audit once found netdisco unguarded). The ownership DB layer over `rack_owners` is `server/lib/tenant.js` (`claimRack`, `tenantOwnsRack`, `rackInOrg`, `orgRackIds`, `visibleTenantIds`).

## 9. Integrations & external systems

All are **env-gated and fail-soft** — absent dependencies degrade (skip / 503) rather than crash.

- **ServiceNow CMDB** (`servicenow/`, Python; Node bridge `server/cmdb_ticket_proxy.js`, `/api/cmdb/ticket/*`): correlates an incident + CMDB walk + a physical scan and posts a reconciliation work note. Every CMDB write is gated behind a Service-Request approval; a 5-minute poller (`startTicketPoller`) sweeps.
- **NetBox / other DCIM** (Orion, Spectrum): via per-user **encrypted connection profiles** (`server/connection_profiles_routes.js` + `server/lib/connection_profiles.js`, `/api/connections/*`); mocks in `server/mock_routes.js`.
- **netdisco** (live LLDP neighbours + learned MACs): Node proxy `server/netdisco_proxy.js` (`/api/netdisco/*`) in front of the Docker stack in `netdisco-docker/`. Env `NETDISCO_URL` (default `http://localhost:5000`).
- **Live switches over SSH** (`ssh2`): `server/lib/port_poller.js` + `port_history_db.js` poll `monitored_devices` on a schedule and record port-state **drift** into `auth.db`; parsers `cisco_parser.js`, `tplink_parser.js`, matrix `switch_cli_matrix.json`. `server/lab_devices.js` (`/api/lab/*`, owner-only) administers the EVE-NG lab switches; creds encrypted (`server/lib/ssh-creds.js`).
- **DOT support bot** (`server/lib/support_bot.js` + `server/support_routes.js`, `/api/support/*`): grounded Q&A over `server/data/support-kb.json` in three tiers — **verbatim** (generates nothing, can't hallucinate), **grounded** (optional local **Ollama**, default `llama3.2:3b`), **refusal** (hands off to `/contact`). Local BM25 search; degrades to search-only without Ollama.
- **Marketplace** (`server/marketplace_routes.js`, `/api/marketplace/*`): surplus-gear market; direct listings in `auth.db`, partner redirects (eBay, Amazon, FS.com, Curvature), **Stripe** payments (env-gated, raw-body webhook verified), Discord notifications.

## 10. Build & deploy

**Split: a Windows GPU box is production; a Mac is dev.**

- **Client build:** `vite build` → `client/dist`, served either by the Node server (it serves `client/dist` if present) or as the Capacitor `webDir` for native (`cap sync`). `VITE_TUNNEL=1` inlines dynamic imports into one bundle (ngrok-interstitial workaround); native/prod builds keep code-splitting. APK URL updated via `deploy/legacy-windows/update-apk-url.ps1`.
- **Server deploy (Windows prod):** `deploy/legacy-windows/deploy.ps1` — `git pull` (remote `july9`, branch `july9_full`), refuses to ship unless CI is green for that commit (`-Force` overrides, `-Rollback` reverts), `npm ci`, rebuild client, DB backup, restart via `deploy/legacy-windows/start.ps1`. `deploy/legacy-windows/start.ps1` manages the **ngrok** tunnel on a **reserved domain** recorded in the repo-root `BACKEND_URL` file (currently `https://harpist-uncorrupt-chowder.ngrok-free.dev`) and sets `NODE_ENV=production`. Dev on Mac: `npm run dev` (nodemon) + the Vite proxy.
- **Reports/PDF:** server-rendered HTML (markup/CSS inline in `app.js`, `body.pdfMode` print styles) → **puppeteer** with one warm shared browser → `outputs/<rackId>/report.pdf`.
- **Sharing:** `POST /api/scan/:rackId/{slack,teams,outlook}` shell out to Python senders (`pipeline.slack_email`, `teams_send`, `outlook_send`); Microsoft Graph helper `server/lib/graphMail.js`; links carry a 300-second report token.

## 11. Cross-cutting concerns

- **Security:** tenant isolation fails closed; the asset guard normalises paths before authorising and returns 404 (not 403) to avoid existence disclosure; report tokens are read-only (GET/HEAD); the YOLO version floor sits above known-compromised releases; logs redact secrets; `audit_log` is append-only.
- **Observability:** structured pino logs, Prometheus metrics (`/metrics`), health (`/healthz`), a queryable SQLite log mirror, and `/api/version`.
- **Resilience:** integrations mount in try/catch and are env-gated — the product degrades (feature off / 503) rather than crashing when ServiceNow, netdisco, Ollama or Stripe are absent.
- **Design:** one light theme, flat white surfaces, no dark mode by choice.

## 12. Glossary

| Term | Meaning |
|---|---|
| **Rack id / scan id** | `RK-XXXXXXXX`, a content hash of the photo (+ owner scope). Same photo → same id. |
| **Unit (U)** | One rack slot; a device occupies one or more units. |
| **Site** | A `tenants` row — the level racks are owned at. |
| **Organization** | A group of Sites; active-learning memory is shared org-wide. |
| **Owner** | Platform superadmin — sees every rack and org. |
| **Ground truth** | A human-verified device label, used to measure and retrain the model. |
| **Drift** | A change in a switch's live port state over time, recorded by the SSH poller. |
| **CMDB** | The customer's configuration database (e.g. ServiceNow) that scans are reconciled against. |
| **Active learning** | The store of user corrections that lets future scans auto-apply fixes. |

---

— Architecture Reference (Developer) —
