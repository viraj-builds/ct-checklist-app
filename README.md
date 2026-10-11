# CleverTap Integration Audit

Self-service audit of a CleverTap integration against the C4S checklist. **Android is live** (native, Flutter, React Native, Cordova/Ionic, Unity, .NET); iOS and **Web** (any site — `<head>` snippet or the `clevertap-web-sdk` npm package) are in too.

## Setup

1. `npm install`
2. Copy `.env.example` → `.env.local` and fill in:
   - `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (server only)
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (used for direct-to-storage uploads)
   - `CRON_SECRET` (any random string; protects `/api/cron/cleanup`)
3. `npm run dev`

The database schema (`audits`, `audit_results`, `audit_activity`, private bucket `audit-uploads`) is already applied to the Supabase project. RLS is on with no policies, so only server routes using the secret key can touch it.

Analyse a build from the command line (no database needed):

```bash
npx tsx scripts/scan-apk.ts path/to/app-release.apk
```

## How an Android audit runs

```
Browser                                   Server (Vercel functions)               Supabase
───────                                   ─────────────────────────               ────────
POST /api/audits ───────────────────────▶ create audit row ─────────────────────▶ audits
Private scan:  Web Worker analyses APK
               POST /api/audits/:id/scan ▶ validate report, run rule engine ────▶ audit_results
Upload scan:   PUT signed URL ──────────────────────────────────────────────────▶ storage (private)
               POST /api/audits/:id/analyze ▶ download → analyse → delete file
POST /api/audits/:id/verify {passcode} ─▶ CleverTap API sampling (passcode in memory only)
Report page: tick items (PATCH …/items/:itemId), test push + confirm
```

| Layer | Where | What |
| --- | --- | --- |
| Static analyzer | `lib/analyzer/android` | Unzips APK/AAB/APKS/XAPK, parses binary & proto manifests and DEX bytecode (real call sites, string args such as event names and channel IDs), the Flutter AOT snapshot, and RN/Cordova JS. Isomorphic, so it runs in a Web Worker or on the server. |
| API verifier | `lib/clevertap` | Samples Get Events / Get Profiles: App Launched/Installed, identity/email/phone coverage, E.164 phones, anonymous profiles, push tokens, impressions, custom-event property types, null values. Test push via `/1/send/push.json`. |
| Rule engine | `lib/engine/android.ts` | Pure function (scan + API findings) → one verdict per checklist item, with evidence and fix. Never fails an item on API silence. |
| Persistence | `lib/server` | Supabase repository; results are re-derived on each change, and manual ticks are kept as overrides. |

Signatures (class names, method names, version markers) live in `lib/analyzer/android/signatures.ts`. Update them there when the SDK changes.

## Live-device testing (report page → "Live device testing")

| Mode | Needs | What's automated |
| --- | --- | --- |
| USB in the browser | Chrome/Edge on a computer, USB debugging on | App state (foreground/background/killed) set via ADB, push sent, delivery read from the notification shade; channels, permission, installed version, CleverTap logs, deep links |
| Wi-Fi or USB via helper | Node 18+, Android platform-tools, `node ct-device-bridge.mjs` (download from the page) | Same as USB; Wi-Fi uses Android 11+ Wireless debugging (pair + connect from the page) |
| No cable | Test identity only | You set the app state; we send the push and confirm via the test user's "Notification Viewed" in CleverTap |

Dev checks:

```bash
npx tsx scripts/device-sim.ts                                   # device logic against a simulated phone
CT_ACCOUNT_ID=... CT_REGION=eu1 CT_PASSCODE=... npx tsx --conditions=react-server scripts/ct-api-check.ts [identity] [events...]
```

## How a website audit runs

```
POST /api/audits {platform:"web", siteUrl} ─▶ URL checked (public hosts only) ─▶ audits row (source "url")
POST /api/audits/:id/crawl {login?}        ─▶ headless Chromium opens the site ─▶ scan (WebScanReport)
POST /api/audits/:id/verify {passcode, identity?} ─▶ CleverTap API: crawler's visitor (objectId), test user, events
Report → Website tests: re-check, Confirm in CleverTap, send test web push (+ link) → confirm via Notification Viewed / Clicked
```

| Layer | Where | What |
| --- | --- | --- |
| Crawler | `lib/web/crawler.ts` | Opens the site with test UTM tags and CleverTap debug logs on, optionally signs in with a test account (form found automatically; password never stored), revisits as a returning user, follows a few same-site links (never clicks buttons). Decodes every request the SDK sends (`lib/web/lz.ts`), wraps `onUserLogin` / `profile` / `event` / `notifications` / `privacy` `.push`, reads CleverTap's answer (web push VAPID config), fetches the service worker, and searches the JS the site loaded for CleverTap calls and event names. |
| URL safety | `lib/web/safe-url.ts` | Every host is resolved and private / local addresses are refused (main page and sub-requests). `CRAWL_ALLOW_PRIVATE=1` lifts this for local development only. |
| Browser | `lib/web/browser.ts` | `@sparticuz/chromium` on Vercel / Linux, local Chrome or Edge in development, or `CHROME_PATH`. |
| API verifier | `lib/clevertap/web.ts` | Looks up the visitor the crawl created (`/1/profile.json?objectId=`), the test user, UTM Visited / custom events on Web, web push campaign stats. Test web push via `/1/send/webpush.json`. |
| Rule engine | `lib/engine/web.ts` | Crawl + API → one verdict per web checklist item. |

### Live session in your own Chrome (report page → Website tests)

`public/ct-web-bridge.mjs` is a no-dependency helper (Node 22+, Google Chrome) the user downloads and runs: `node ct-web-bridge.mjs [--origin https://audit-site]`. It listens on `127.0.0.1:47813` (same origin + token handshake as the Android helper), starts Chrome with its own profile (`~/.ct-audit-chrome`) and drives it over the DevTools protocol — or Chrome on an Android phone through `adb forward … localabstract:chrome_devtools_remote`.

- Every tab is attached before it loads, so the same CleverTap hook as the crawler runs; requests to `*.clevertap-prod.com` and CleverTap's answers are reported.
- The site's service worker is attached before it starts, so a push is seen arriving (`Push event`), the viewed ping, and the click (redirect ping with `&b=button…`, then the page that opens). Test pushes pass or fail without a "check delivery" step.
- The user logs in themselves (OTP / Google / captcha all work), allows notifications, edits their profile; the report page (`lib/web/live.ts`) turns the raw events into `WebLiveFindings` (identities masked) and saves them via `POST /api/audits/:id/web-live`. The engine merges them with the crawl (`withLive` in `lib/engine/web.ts`); live evidence wins.

```bash
npx tsx --conditions=react-server scripts/scan-site.ts https://your.site [accountId] [region]     # crawl + verdicts, no database
CT_LOGIN_USER=test@your.site CT_LOGIN_PASS=... npx tsx --conditions=react-server scripts/scan-site.ts https://your.site
```
