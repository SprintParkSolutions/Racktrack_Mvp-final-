# syntax=docker/dockerfile:1
###############################################################################
# RackTrack — unified runtime image
#
#   Node/Express server (server/, entry server/app.js, listens on $PORT=3001)
#   + Python CV pipeline (pipeline/, invoked as `python -m pipeline.worker`)
#   + pre-built Vite/React client (client/dist) served as static assets.
#
# CPU-ONLY: torch/torchvision are installed from the CPU wheel index — no CUDA.
#
# NOTE (runtime data — NOT baked into the image):
#   * Models/                       -> mount read-only (git-LFS weights, large)
#   * active_learning_Cache/data    -> mount read-write (active-learning cache)
#   * outputs/                      -> mount read-write (pipeline artifacts)
#   * secrets (JWT, SMTP, MSAL, DB) -> supply via `env_file:` / `--env-file`,
#                                      never COPY'd or ENV'd into a layer.
# See docker-compose.yml for the canonical volume + env wiring.
###############################################################################


###############################################################################
# Stage 1 — build the React client into static assets (client/dist)
###############################################################################
FROM node:20-slim AS client-build

WORKDIR /build/client

# Install deps first (cached until the lockfile changes).
COPY client/package.json client/package-lock.json* ./
RUN npm ci

# Build the client. `vite build` emits ./dist.
COPY client/ ./
RUN npm run build


###############################################################################
# Stage 2 — runtime: Python 3.11 base + Node 20 + server + pipeline
###############################################################################
FROM python:3.11-slim AS runtime

# ---- Node 20 -------------------------------------------------------------
# Copy the Node runtime straight out of the official image instead of adding
# the NodeSource apt repo — smaller, reproducible, one fewer network dep.
COPY --from=node:20-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:20-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# ---- System libraries ----------------------------------------------------
#   libgl1, libglib2.0-0      : OpenCV / torch image ops need these at import
#   libgomp1                  : OpenMP runtime used by torch / ultralytics
#   build-essential, python3-dev : native node modules (better-sqlite3, sharp)
#                                  compile from source if no prebuilt binary
#   ca-certificates           : outbound TLS (vendor scrapers, MSAL, etc.)
# The headless-Chromium libs below are no longer optional. Puppeteer downloads
# its own Chromium during `npm ci`, but that binary cannot start without them:
# every PDF and Teams/Slack report share failed with
#   pdf build: Failed to launch the browser process: Code: 127
# which is the loader failing to resolve a shared object, not a missing binary.
# The note that used to live here said these "may" be needed if the PDF paths
# were exercised. They were, in production, and they were dead.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
        build-essential \
        python3-dev \
        ca-certificates \
        libnss3 \
        libnspr4 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libcups2 \
        libdrm2 \
        libxkbcommon0 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxrandr2 \
        libgbm1 \
        libasound2 \
        libpango-1.0-0 \
        libcairo2 \
        fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- Python deps (CPU-only torch) ---------------------------------------
# Installed before app code so this heavy layer is cached across code changes.
# --extra-index-url pulls the CPU builds of torch/torchvision.
COPY requirements.txt ./
RUN pip install --no-cache-dir \
        --extra-index-url https://download.pytorch.org/whl/cpu \
        -r requirements.txt

# ---- Node server deps (production only) ---------------------------------
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm ci --omit=dev

# ---- Application code -----------------------------------------------------
# app.js does PROJECT_ROOT = path.join(__dirname, '..'), so server/ must sit
# one level below the working dir. With WORKDIR /app and the server at
# /app/server, PROJECT_ROOT resolves to /app (the repo root) as the app expects.
COPY server/    ./server/
COPY pipeline/  ./pipeline/
COPY config.json ./config.json
# Topology generation. /api/topology/:rackId spawns
# servicenow/topology_generate.py (which imports synth.py beside it) whenever a
# rack has no topology.json, and serves 404 "pending" until it finishes. The
# directory was never copied in, so that spawn failed instantly in every
# container: the snapshot was never written, the next request scheduled another
# doomed regen, and the rack sat on "pending" for ever. 11 of 16 racks on the
# demo were in exactly that state, on web and app alike.
# mock_scans (26 MB of fixtures) and __pycache__ are excluded in .dockerignore.
COPY servicenow/ ./servicenow/
# Data input for the vendor spec lookup (pipeline.all_vendor reads it by an
# absolute path under the app root). Without it /api/specs/vendors answers 500
# and the Specifications page is dead in every containerised deployment.
COPY Switch_Vendors_Websites.xlsx ./Switch_Vendors_Websites.xlsx

# Built client assets from stage 1 -> /app/client/dist (served by app.js).
COPY --from=client-build /build/client/dist ./client/dist

# Mount points (declared so the paths exist even before a volume is attached).
# These are populated at runtime via volumes — see the NOTE at the top.
RUN mkdir -p /app/Models /app/outputs /app/active_learning_Cache/data

ENV NODE_ENV=production \
    PORT=3001 \
    PYTHONUNBUFFERED=1

EXPOSE 3001

# Run as a non-root user (hardening — audit finding M1). The whole /app tree,
# including the runtime mount points created above, is handed to this user so it
# can still read config and write outputs/Models/cache.
# NOTE: if outputs/ or Models/ are backed by host volumes, make those volumes
# writable by UID 10001 (chown them on the host, or set the volume's owner).
RUN groupadd -r app && useradd -r -g app -u 10001 app && chown -R app:app /app
USER app

# Run from the repo root (/app) so PROJECT_ROOT, config.json, Models/, outputs/
# and client/dist all resolve correctly.
CMD ["node", "server/app.js"]
