# Mac — Build the IPA for TestFlight

**Do this on the Mac. It is now only a build machine.**

The server lives on the **Windows box** and is reached at
`https://harpist-tying-aware.ngrok-free.dev`. The Mac never serves anything —
`make-ipa.sh` only writes that URL into the JS bundle as a string. Once the IPA is
on a tester's phone, every API call goes to Windows.

Written: 14 Jul 2026 · companion to `WINDOWS-SERVER-SETUP.md`

---

## ⚠ Read first

**Do NOT `git commit` / `git push` to sync these changes.**
`server/.env` is **tracked in git** and holds the switch SSH credentials, the
Gmail app password and the Slack token. There are also ~70 other uncommitted
files in the tree. Pushing would publish all of it.

Apply the three edits below **by hand**. It's ten minutes, and it's safe.

**Do NOT copy `node_modules` from Windows.** Native modules are platform-specific
and will crash. Run `npm install` on the Mac if you need to.

---

## Step 1 — Three file changes

These are the *only* differences between the Mac and the working Windows build.
All three are in `client/`. Without them the IPA compiles fine and is **broken at
runtime** — see "Why" at the bottom.

### 1a. `client/capacitor.config.json`

Replace the whole file:

```json
{
  "appId": "com.racktrack.app",
  "appName": "RackTrack",
  "webDir": "dist",
  "overrideUserAgent": "RackTrack/1.0 (native app)",
  "android": {
    "overrideUserAgent": "RackTrack/1.0 (native app; Android)"
  },
  "ios": {
    "overrideUserAgent": "RackTrack/1.0 (native app; iOS)"
  }
}
```

### 1b. `client/src/main.jsx`

Add the import and the call:

```jsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import './fonts.css';
import { installFetchInterceptor } from './utils/api.js';   // ← add

installFetchInterceptor();                                   // ← add

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

### 1c. `client/src/utils/api.js`

Add this exported function (paste it after `apiUrl`, before `authFetch`):

```js
// Free ngrok tunnels serve an HTML interstitial ("You are about to visit...")
// instead of the real response to clients that look like a browser — which a
// Capacitor WebView does. Any request carrying this header skips it. Scoped to
// our own backend so third-party fetches are untouched (a custom header on a
// cross-origin request forces a CORS preflight).
//
// Harmless once off ngrok: the header is simply ignored by any other host.
export function installFetchInterceptor() {
  if (typeof window === 'undefined' || window.__rtFetchPatched) return;
  window.__rtFetchPatched = true;

  const nativeFetch = window.fetch.bind(window);

  const isOurBackend = (url) => {
    const u = String(url);
    if (!/^https?:\/\//i.test(u)) return true;        // relative → same origin
    return API_BASE ? u.startsWith(API_BASE) : false; // absolute → only our API
  };

  window.fetch = (input, init = {}) => {
    const url = input instanceof Request ? input.url : input;
    if (!isOurBackend(url)) return nativeFetch(input, init);

    // A Request's headers live on the Request, not on init.
    if (input instanceof Request) {
      const headers = new Headers(input.headers);
      headers.set('ngrok-skip-browser-warning', 'true');
      return nativeFetch(new Request(input, { headers }), init);
    }
    const headers = new Headers(init.headers || {});
    headers.set('ngrok-skip-browser-warning', 'true');
    return nativeFetch(input, { ...init, headers });
  };
}
```

> `API_BASE` is already defined at the top of that file — don't redeclare it.

---

## Step 2 — Bump the build number

TestFlight **rejects a duplicate build number outright.** You are on **1.0 (4)**,
so the next one is **1.0 (5)**.

In `client/ios/App/App.xcodeproj/project.pbxproj`, change **both** occurrences:

```
CURRENT_PROJECT_VERSION = 4;   →   CURRENT_PROJECT_VERSION = 5;
```

(Leave `MARKETING_VERSION = 1.0;` alone.) Or do it in Xcode ▸ target **App** ▸
General ▸ Build.

---

## Step 3 — Sync the native project

`make-ipa.sh` runs `npx cap copy ios`, but run a full sync once so the new
`capacitor.config.json` definitely lands in the Xcode project:

```bash
cd client
npx cap sync ios
```

---

## Step 4 — Build the IPA

```bash
cd client
./make-ipa.sh 6GS882NNAX            # URL comes from BACKEND_URL at the repo root
```

- `6GS882NNAX` = Apple Team ID (SPRINTPARK LLC).
- The URL argument is **required** — the script's guard (`check-api-base.mjs`)
  hard-fails on an empty, `localhost`, or non-HTTPS value, so it cannot silently
  produce a bundle pointing at nothing.
- Output: **`client/build/ipa/*.ipa`**

---

## Step 5 — Ship it

1. Open **Transporter**, drag in the `.ipa`, **Deliver**.
2. App Store Connect ▸ TestFlight — wait for processing.
3. Assign testers.

---

## Step 6 — Verify on a real phone

**The Windows box must be on with `deploy/legacy-windows/start.ps1` running, or none of this works.**

Install from TestFlight, then check:

- [ ] App opens, login works.
- [ ] **Scan a rack** → devices come back (this proves the tunnel + GPU pipeline).
- [ ] **The result image actually renders.** ← the one that catches the ngrok bug.
      A broken/blank image means `overrideUserAgent` didn't make it in.
- [ ] Ports / Network screens load.

---

## Why these changes matter (don't skip them)

Free ngrok serves a **2.8 KB HTML warning page** instead of the real response to
any client whose user-agent looks like a browser — and a Capacitor WebView does.
It returns **HTTP 200**, so the app sees no network error; it just gets an
unparseable body and fails somewhere confusing.

- The **fetch interceptor** (1b/1c) adds the `ngrok-skip-browser-warning` header,
  which fixes API calls.
- The **user-agent override** (1a) is what fixes **images** — `<img>` tags
  *cannot send custom headers*, so no amount of JavaScript can rescue them.
  Without 1a, every scan result image, overlay and rack photo renders **broken**.

Both were verified on the Windows build: with the override, `/outputs/.../*.png`
returns real PNG bytes; without it, HTML.

---

## Quick reference

| Item | Value |
|---|---|
| Backend URL | `https://harpist-tying-aware.ngrok-free.dev` |
| Apple Team ID | `6GS882NNAX` (SPRINTPARK LLC) |
| Bundle ID | `com.racktrack.app` |
| Current build | 1.0 (4) → ship **1.0 (5)** |
| IPA output | `client/build/ipa/` |
| Server | **Windows box** — must be running `deploy/legacy-windows/start.ps1` |
