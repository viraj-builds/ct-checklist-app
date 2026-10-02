# CleverTap Integration Audit

Self-service audit of a CleverTap integration against the C4S checklist. **Android is live** (native, Flutter, React Native, Cordova/Ionic, Unity, .NET); iOS and Web come next.

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
