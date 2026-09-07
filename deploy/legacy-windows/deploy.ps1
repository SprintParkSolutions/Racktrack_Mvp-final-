# RackTrack one-command deploy for the Windows GPU box.
#   .\deploy.ps1                 # normal deploy (pull -> CI gate -> deps -> build -> backup -> restart)
#   .\deploy.ps1 -Force          # EMERGENCY: skip the CI gate (logs loudly)
#   .\deploy.ps1 -Rollback       # revert to the previous commit and restart
#
# Pulls the latest code, refuses to ship unless CI is green for that exact
# commit, installs the dependencies the new commit needs, rebuilds the web
# client, backs up the database, restarts the Node server (via start.ps1), and
# prints the commit the server is now actually running.
#
# Run this whenever you want the latest push live. It fixes the recurring
# "my fix isn't showing" problem, which is caused by the Node process not being
# restarted after a pull.
param(
    [switch]$Force,     # emergency override: deploy even if CI is not green
    [switch]$Rollback   # revert to the commit recorded by the last deploy
)

# Derived from where this script lives, not hardcoded: the checkout has moved
# drives more than once (F:\ -> D:\racktrack\), and a stale literal here means
# deploy silently runs against the wrong tree — or dies on Set-Location.
$ProjectRoot = $PSScriptRoot
$Remote = "july9"
$Branch = "july9_full"
$RollbackFile = "$ProjectRoot\.deploy-rollback"   # records the previous good commit

Set-Location $ProjectRoot

# ── Shared: install deps + build + backup + restart ──────────────────────
# Used by both a normal deploy and a rollback, so the two paths can never
# drift (a rollback that skipped `npm ci` would serve new code against old
# node_modules — exactly the class of bug this script exists to prevent).
function Invoke-DepsBuildRestart {
    Write-Host "`n[deps] Installing dependencies the live commit needs ..." -ForegroundColor Cyan

    # deploy.ps1 does NOT install deps historically, so production ran whatever
    # node_modules a human last installed by hand — stripe was in package.json
    # and the lockfile but never installed, so payments were silently disabled.
    # Install now, and ABORT (leaving the old version live) on any failure.

    # Server: production deps only. `npm ci` is deliberate over `npm install`:
    # it is reproducible and it FAILS CLOSED if package.json and the lockfile
    # disagree, rather than quietly resolving something new.
    Set-Location "$ProjectRoot\server"
    npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  SERVER npm ci FAILED — old version still live, nothing restarted." -ForegroundColor Red
        Write-Host "  If package.json changed (e.g. the multer 2.x bump), the lockfile is" -ForegroundColor Yellow
        Write-Host "  stale: run  cd server; npm install  once to regenerate it, then redeploy." -ForegroundColor Yellow
        Set-Location $ProjectRoot
        exit 1
    }

    # Client: FULL install (needs devDependencies — vite/plugins — to build).
    Set-Location "$ProjectRoot\client"
    npm ci
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  CLIENT npm ci FAILED — old version still live, nothing restarted." -ForegroundColor Red
        Set-Location $ProjectRoot
        exit 1
    }
    Set-Location $ProjectRoot

    # Python CV pipeline: install the pinned lockfile into the SAME interpreter
    # the worker pool uses (app.js: PYTHON_PATH env wins, else a project venv,
    # else the `py` launcher), so pipeline.worker actually sees the packages.
    # NOTE: we do NOT pass --extra-index-url for torch here (dependency-confusion
    # shape — see requirements.lock.txt). If this box needs a CUDA torch build,
    # install it from the PyTorch CUDA index out-of-band; the bare lock is CPU.
    if     ($env:PYTHON_PATH)                                       { $py = $env:PYTHON_PATH }
    elseif (Test-Path "$ProjectRoot\venv\Scripts\python.exe")       { $py = "$ProjectRoot\venv\Scripts\python.exe" }
    elseif (Test-Path "$ProjectRoot\.venv\Scripts\python.exe")      { $py = "$ProjectRoot\.venv\Scripts\python.exe" }
    else                                                            { $py = "py" }
    Write-Host "  python: $py" -ForegroundColor DarkGray

    # Remember any CUDA torch build BEFORE the bare lock install below wipes it
    # (the lock pins CPU-only torch for the Linux/Docker target — see the
    # GPU/CUDA NOTE above), so it can be restored afterward on this GPU box.
    $priorTorch = & $py -c "import torch; print(torch.__version__)" 2>$null
    $priorTorchvision = & $py -c "import torchvision; print(torchvision.__version__)" 2>$null

    & $py -m pip install -r "$ProjectRoot\requirements.lock.txt"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  pip install FAILED — old version still live, nothing restarted." -ForegroundColor Red
        exit 1
    }

    if ($priorTorch -match '\+cu\d+$') {
        $cudaTag = ($priorTorch -split '\+')[1]
        Write-Host "  Restoring CUDA torch ($priorTorch) — the lock install above just put CPU-only torch back ..." -ForegroundColor Cyan
        & $py -m pip install "torch==$priorTorch" "torchvision==$priorTorchvision" --index-url "https://download.pytorch.org/whl/$cudaTag"
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  CUDA torch restore FAILED — box is left on CPU-only torch; fix manually." -ForegroundColor Red
        }
    }

    Write-Host "`n[build] Building the web client ..." -ForegroundColor Cyan
    Set-Location "$ProjectRoot\client"
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  BUILD FAILED — server NOT restarted (old build stays up)." -ForegroundColor Red
        Set-Location $ProjectRoot
        exit 1
    }
    Set-Location $ProjectRoot

    # Back up the database BEFORE the restart. Boot applies schema changes
    # implicitly (CREATE TABLE IF NOT EXISTS / ALTER TABLE on every require), so
    # a restart can mutate the production schema — take a restorable copy first.
    if (-not (Backup-AuthDb)) {
        Write-Host "  BACKUP FAILED — refusing to restart (would mutate schema with no backup)." -ForegroundColor Red
        exit 1
    }

    Write-Host "`n[restart] Restarting the Node server (start.ps1) ..." -ForegroundColor Cyan
    & "$ProjectRoot\start.ps1"
    # On success we simply fall through; on ANY failure above we `exit 1`, so the
    # caller never has to test a return value (which would be corrupted by the
    # external commands' stdout landing on this function's output stream).
}

# ── Database backup with a WAL checkpoint ─────────────────────────────────
# auth.db runs in WAL mode: recently committed rows live in the -wal sidecar
# until a checkpoint folds them back into the main file. A plain file copy
# would silently omit the newest data — the worst possible failure for the one
# artefact you reach for after a bad deploy. Checkpoint first, then copy, then
# read the copy back to prove it opens. (Mirrors server/scripts/reset-data.js.)
function Backup-AuthDb {
    $authDb = "$ProjectRoot\server\data\auth.db"
    if (-not (Test-Path $authDb)) {
        Write-Host "  (no auth.db yet — nothing to back up)" -ForegroundColor DarkGray
        return $true
    }
    $stamp = Get-Date -Format "yyyy-MM-ddTHH-mm-ss"
    $dest  = "$authDb.bak-deploy-$stamp"
    # Use the server's own better-sqlite3 to checkpoint + verify — no extra dep.
    # Reading the script from stdin (`node -`) makes argv: [node, '-', src, dest],
    # so the two paths are argv[2] and argv[3] — NOT [1]/[2].
    $node = @'
const Database = require('better-sqlite3');
const fs = require('fs');
const src = process.argv[2], dest = process.argv[3];
const db = new Database(src);
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
fs.copyFileSync(src, dest);
const chk = new Database(dest, { readonly: true });
const pages = chk.pragma('page_count', { simple: true });
chk.close();
console.log('backup ok: ' + dest + ' (' + pages + ' pages, WAL folded in)');
'@
    Push-Location "$ProjectRoot\server"
    # Capture node's stdout into a variable so it does NOT leak onto this
    # function's output stream (which would corrupt the boolean the caller tests).
    $out = $node | node - $authDb $dest
    $ok = ($LASTEXITCODE -eq 0)
    Pop-Location
    if ($ok) { Write-Host "  $out" -ForegroundColor DarkGray }
    else     { Write-Host "  backup failed: $out" -ForegroundColor Red }
    return $ok
}

# ── CI gate ───────────────────────────────────────────────────────────────
# deploy used to verify NOTHING and finish in ~30s while CI takes minutes, so a
# red commit could ship. Query the check-runs for the EXACT commit and refuse
# unless every one is green. -Force overrides (loudly) for emergencies.
function Assert-CiGreen($sha) {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        Write-Host "  gh CLI not found — cannot verify CI." -ForegroundColor Red
        Write-Host "  Install/auth GitHub CLI, or re-run with -Force to bypass (emergency only)." -ForegroundColor Yellow
        return $false
    }
    # Derive owner/repo from the deploy remote rather than hardcoding it (the
    # checkout has moved hosts before).
    $remoteUrl = (git remote get-url $Remote).Trim()
    if ($remoteUrl -notmatch 'github\.com[/:]([^/]+)/([^/]+?)(?:\.git)?$') {
        Write-Host "  Could not parse a GitHub owner/repo from '$remoteUrl'." -ForegroundColor Red
        return $false
    }
    $repoSlug = "$($Matches[1])/$($Matches[2])"
    Write-Host "  Checking CI on $repoSlug @ $sha ..." -ForegroundColor DarkGray

    # CI (minutes) usually is not finished when a ~30s deploy reaches here, so
    # poll until every check-run has COMPLETED, up to a ceiling, then judge.
    $deadline = (Get-Date).AddMinutes(20)
    while ($true) {
        $resp = gh api "repos/$repoSlug/commits/$sha/check-runs" 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  gh api call failed (auth? network?)." -ForegroundColor Red
            return $false
        }
        # Use the API's own total_count for the "did anything run" test. @($x).Count
        # is 1 (not 0) when $x is a single $null, so trusting it here would report
        # a commit with NO checks as green — a dangerous false pass. Also strip any
        # null entries so the status/conclusion filters below see only real runs.
        $parsed = $resp | ConvertFrom-Json
        $total  = [int]$parsed.total_count
        $runs   = @($parsed.check_runs | Where-Object { $_ })
        if ($total -eq 0 -or $runs.Count -eq 0) {
            if ((Get-Date) -gt $deadline) {
                Write-Host "  No CI runs registered for $sha within the wait window." -ForegroundColor Red
                return $false
            }
            Write-Host "  waiting for CI to register for $sha ..." -ForegroundColor DarkGray
            Start-Sleep -Seconds 15
            continue
        }
        $pending = @($runs | Where-Object { $_.status -ne 'completed' })
        if ($pending.Count -gt 0) {
            if ((Get-Date) -gt $deadline) {
                Write-Host "  CI still running after the wait window ($($pending.Count) of $total pending) — refusing to deploy." -ForegroundColor Red
                return $false
            }
            Write-Host "  CI in progress: $($pending.Count) of $total checks pending ..." -ForegroundColor DarkGray
            Start-Sleep -Seconds 20
            continue
        }
        # All completed. 'neutral' and 'skipped' are not failures; anything else
        # (failure, cancelled, timed_out, action_required) blocks the deploy.
        $bad = @($runs | Where-Object { $_.conclusion -notin @('success','neutral','skipped') })
        if ($bad.Count -gt 0) {
            Write-Host "  CI is RED for $sha — refusing to deploy:" -ForegroundColor Red
            foreach ($b in $bad) { Write-Host "    $($b.name): $($b.conclusion)" -ForegroundColor Yellow }
            return $false
        }
        Write-Host "  CI is green ($total checks passed)." -ForegroundColor Green
        return $true
    }
}

# ── Rollback mode ─────────────────────────────────────────────────────────
if ($Rollback) {
    Write-Host "`n[rollback] Reverting to the previously recorded commit ..." -ForegroundColor Magenta
    if (-not (Test-Path $RollbackFile)) {
        Write-Host "  No $RollbackFile — nothing recorded to roll back to." -ForegroundColor Red
        Write-Host "  Roll back manually:  git reset --hard <good-sha>  then  .\deploy.ps1 -Force" -ForegroundColor Yellow
        exit 1
    }
    $target = (Get-Content $RollbackFile -Raw).Trim()
    Write-Host "  Rolling back to $target (from the last deploy) ..." -ForegroundColor Magenta
    git reset --hard $target
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  git reset failed — old version still live." -ForegroundColor Red
        exit 1
    }
    Invoke-DepsBuildRestart    # exits 1 internally on any failure
    Write-Host "`n  Rolled back and restarted on $target." -ForegroundColor Green
    exit 0
}

# ── Normal deploy ─────────────────────────────────────────────────────────
Write-Host "`n[1/4] Pulling $Remote/$Branch ..." -ForegroundColor Cyan
$before = (git rev-parse --short HEAD).Trim()
git pull $Remote $Branch

# STOP if the pull failed. Without this the script sailed on, rebuilt the OLD
# tree and restarted Node, then reported success — so a deploy looked healthy
# (fresh uptime, no errors) while serving code 14 commits stale, security fixes
# included. The usual cause is uncommitted local edits to a file the incoming
# commits also touch: git refuses to overwrite them and exits non-zero.
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n  PULL FAILED — nothing was built or restarted." -ForegroundColor Red
    Write-Host "  The old version is still live. Most likely local edits block the merge:" -ForegroundColor Yellow
    git status --short
    Write-Host "`n  Fix with:  git stash push -m wip <file>   (keep them)" -ForegroundColor Yellow
    Write-Host "         or:  git reset --hard $Remote/$Branch  (discard them)" -ForegroundColor Yellow
    exit 1
}

$head = (git rev-parse --short HEAD).Trim()
$fullSha = (git rev-parse HEAD).Trim()
Write-Host "  HEAD $before -> $head" -ForegroundColor DarkGray

# A successful pull that changed nothing is worth calling out too: it means the
# box was already current, so if the live version still looks old the problem is
# a second node process, not the pull.
if ($before -eq $head) {
    Write-Host "  (already up to date — no new commits)" -ForegroundColor DarkGray
}

# Record the commit we are moving away from so `-Rollback` can return to it.
# Written only after a clean pull, so it always names a real prior state.
if ($before -ne $head) { $before | Set-Content $RollbackFile }

Write-Host "`n[2/4] Verifying CI is green for $head ..." -ForegroundColor Cyan
if ($Force) {
    Write-Host "  !! -Force: SKIPPING the CI gate. Shipping $head UNVERIFIED." -ForegroundColor Red
    Write-Host "  !! Emergency override in use — confirm the build by hand." -ForegroundColor Red
} elseif (-not (Assert-CiGreen $fullSha)) {
    Write-Host "`n  DEPLOY ABORTED — CI is not green for $head. Old version still live." -ForegroundColor Red
    Write-Host "  Override for a real emergency:  .\deploy.ps1 -Force" -ForegroundColor Yellow
    exit 1
}

Write-Host "`n[3/4] Installing deps, building, backing up, restarting ..." -ForegroundColor Cyan
Invoke-DepsBuildRestart    # exits 1 internally on any failure; falls through on success

# Give the server a few seconds to bind + report its version.
Write-Host "`n[4/4] Confirming the live server version ..." -ForegroundColor Cyan
Start-Sleep -Seconds 4
Write-Host "`nLive server version:" -ForegroundColor Green
for ($i = 0; $i -lt 10; $i++) {
    try {
        $v = (Invoke-WebRequest "http://localhost:3001/api/version" -UseBasicParsing -TimeoutSec 3).Content
        Write-Host "  $v" -ForegroundColor Green
        if ($v -match $head) {
            Write-Host "  OK — live commit matches HEAD ($head)." -ForegroundColor Green
            break
        } else {
            # Non-zero exit, not just a warning: a deploy that serves a different
            # commit than HEAD has failed, however healthy it looks.
            Write-Host "  FAILED — live commit does not match HEAD ($head)." -ForegroundColor Red
            Write-Host "  Another node process is probably serving an older tree:" -ForegroundColor Yellow
            Get-Process node -ErrorAction SilentlyContinue |
                Select-Object Id, Path | Format-Table -AutoSize
            Write-Host "  Roll back with:  .\deploy.ps1 -Rollback" -ForegroundColor Yellow
            exit 1
        }
    } catch {
        Start-Sleep -Seconds 2
    }
}
Write-Host ""
