"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, refreshAudit } from "@/lib/store";
import { rememberIdentity } from "@/lib/session-secrets";
import type { Audit } from "@/lib/types";
import type { TestPushRecord } from "@/lib/clevertap/types";
import type { LivePushTest, WebLiveFindings } from "@/lib/web/types";
import {
  buildLiveFindings,
  webHelperClose,
  webHelperLogin,
  latestLoginHints,
  type LoginFillResult,
  type LoginHints,
  webHelperHello,
  webHelperOpen,
  webHelperState,
  webHelperTab,
  WEB_HELPER_MIN_VERSION,
  type LiveEvent,
} from "@/lib/web/live";
import { Card, Button, Notice, StatusMark } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { cx } from "@/lib/format";

// Live session in the user's own Chrome (desktop, or Android over USB) through
// the local helper. Everything the user does on their site is read from Chrome
// itself, so steps tick on their own — including a test push arriving and being
// clicked.

type Helper = { token: string; version: number; chrome: boolean };
type Kind = "push" | "deeplink";

export function LiveSession({
  audit,
  passcode,
  link,
  onIdentity,
  login,
}: {
  audit: Audit;
  passcode: string;
  link: string;
  onIdentity: (identity: string) => void;
  login: { username: string; password: string; url?: string }; // test account on the website (in memory only)
}) {
  const site = audit.target ?? "";
  const [helper, setHelper] = useState<Helper | null>(null);
  const [device, setDevice] = useState<"desktop" | "android">(audit.webLive?.device ?? "desktop");
  const [fresh, setFresh] = useState(!audit.webLive);
  const [running, setRunning] = useState(false);
  const [browser, setBrowser] = useState<string | undefined>(audit.webLive?.browser);
  const [startedAt, setStartedAt] = useState<number>(audit.webLive?.startedAt ?? 0);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [tests, setTests] = useState<Partial<Record<Kind, LivePushTest>>>(audit.webLive?.push.tests ?? {});
  const [revisitAt, setRevisitAt] = useState<number | undefined>(audit.webLive?.revisit?.at);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "fail"; text: string } | null>(null);
  const [fill, setFill] = useState<LoginFillResult | null>(null);
  const [loginStalled, setLoginStalled] = useState(false); // submitted, but no onUserLogin 25 s later
  const since = useRef(0);
  const lastSaved = useRef("");

  // find the helper (it only answers this site's origin)
  useEffect(() => {
    let stop = false;
    const look = async () => {
      const h = await webHelperHello();
      if (!stop) setHelper(h);
    };
    void look();
    const t = window.setInterval(() => !helper && void look(), 3000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [helper]);

  // stream events from the helper
  useEffect(() => {
    if (!helper) return;
    let stop = false;
    const tick = async () => {
      try {
        const st = await webHelperState(helper.token, since.current);
        if (stop) return;
        setRunning(st.running);
        if (st.browser) setBrowser(st.browser);
        if (st.startedAt && st.startedAt !== startedAt && since.current === 0) setStartedAt(st.startedAt);
        if (st.events.length) {
          since.current = st.events[st.events.length - 1].seq;
          setEvents((prev) => [...prev, ...st.events].slice(-6000));
        }
      } catch {
        if (!stop) setHelper(null);
      }
    };
    void tick();
    const t = window.setInterval(tick, 1500);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [helper, startedAt]);

  const startUrl = useMemo(() => {
    try {
      const u = new URL(site);
      u.searchParams.set("utm_source", "ct_audit");
      u.searchParams.set("utm_medium", "live_session");
      u.searchParams.set("utm_campaign", `live_${audit.id.slice(4, 12)}`);
      return u.href;
    } catch {
      return site;
    }
  }, [site, audit.id]);

  const built = useMemo(
    () =>
      events.length
        ? buildLiveFindings(
            events.filter((e) => e.t >= startedAt - 1000),
            { url: startUrl, device, browser, startedAt: startedAt || events[0].t, revisitAt, tests },
          )
        : null,
    [events, startUrl, device, browser, startedAt, revisitAt, tests],
  );
  const live: WebLiveFindings | undefined = built?.findings ?? audit.webLive;
  const identity = built?.identity;

  useEffect(() => {
    if (identity) {
      rememberIdentity(audit.id, identity);
      onIdentity(identity);
    }
  }, [identity, audit.id, onIdentity]);

  // save to the server when something meaningful changed (debounced)
  useEffect(() => {
    if (!built) return;
    const { updatedAt: _u, ...rest } = built.findings;
    void _u;
    const key = JSON.stringify(rest);
    if (key === lastSaved.current) return;
    const t = window.setTimeout(async () => {
      lastSaved.current = key;
      try {
        await api(`/api/audits/${audit.id}/web-live`, { method: "POST", body: JSON.stringify(built.findings) });
        refreshAudit(audit.id);
      } catch {
        lastSaved.current = "";
      }
    }, 2500);
    return () => window.clearTimeout(t);
  }, [built, audit.id]);

  const guard = useCallback(async (name: string, fn: () => Promise<string | void>) => {
    setBusy(name);
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ tone: "ok", text });
    } catch (e) {
      setMsg({ tone: "fail", text: (e as Error).message });
    } finally {
      setBusy("");
    }
  }, []);

  const open = () =>
    guard("open", async () => {
      if (!helper) return;
      since.current = 0;
      setEvents([]);
      setTests({});
      setRevisitAt(undefined);
      lastSaved.current = "";
      const r = await webHelperOpen(helper.token, startUrl, device, fresh);
      setStartedAt(Date.now() - 500);
      setBrowser(r.browser);
      setFresh(false);
      return device === "android" ? "Opened in Chrome on your phone. Follow the steps below on the phone." : "Chrome opened your website. Follow the steps below in that window.";
    });

  const reopen = () =>
    guard("reopen", async () => {
      if (!helper) return;
      setRevisitAt(Date.now());
      await webHelperTab(helper.token, new URL(site).origin + "/");
      return "Opened the site in a new tab, as a returning visitor.";
    });

  const fillLogin = () =>
    guard("login", async () => {
      if (!helper) return;
      if (!login.username) throw new Error("Enter the test account's email, phone or username in the card above first (password too, if your site uses one).");
      setLoginStalled(false);
      const r = await webHelperLogin(helper.token, { username: login.username, password: login.password || undefined, url: login.url });
      setFill(r);
      if (!r.ok && !r.needs) throw new Error(r.message);
      // submitted with nothing left for the user: if the site doesn't identify the user soon, say so
      if (r.ok && !r.needs) window.setTimeout(() => setLoginStalled(true), 25_000);
    });

  const close = () =>
    guard("close", async () => {
      if (helper) await webHelperClose(helper.token);
      setRunning(false);
    });

  const sendPush = (kind: Kind) =>
    guard(kind, async () => {
      if (!passcode) throw new Error("Enter your CleverTap passcode above first.");
      if (!identity) throw new Error("Log in on the site in the test Chrome first — we send the push to that user.");
      const r = await api<{ test: TestPushRecord }>(`/api/audits/${audit.id}/web-push`, {
        method: "POST",
        body: JSON.stringify({ passcode, identity, ...(kind === "deeplink" ? { deepLink: link.trim() } : {}) }),
      });
      if (r.test.status === "failed") throw new Error(r.test.message ?? "CleverTap rejected the web push.");
      setTests((t) => ({ ...t, [kind]: { sentAt: r.test.sentAt, deepLink: r.test.deepLink } }));
      return kind === "deeplink" ? "Sent. Click the notification when it shows — we'll see which page opens." : "Sent. We're watching Chrome for it…";
    });

  /* ---- render ---- */

  if (!helper)
    return (
      <Card className="p-6">
        <Header />
        <ol className="mt-4 space-y-2.5 text-[15px] text-text-2">
          <li>
            1.{" "}
            <a href="/ct-web-bridge.mjs" download className="link">
              Download the website helper
            </a>{" "}
            (one small file, no install).
          </li>
          <li>
            2. Run it (Node.js 22+ and Google Chrome needed):
            <code className="mt-1.5 block overflow-x-auto rounded-lg bg-surface-3 px-3 py-2 font-mono text-[13px]">
              node ct-web-bridge.mjs{typeof window !== "undefined" && window.location.origin !== "http://localhost:3000" ? ` --origin ${window.location.origin}` : ""}
            </code>
          </li>
          <li>3. This page connects by itself.</li>
        </ol>
        <p className="mt-3 text-sm text-muted">
          For Chrome on an Android phone, also connect the phone by USB with USB debugging on (adb), and open Chrome on it once.
        </p>
      </Card>
    );

  const L = live;
  const step = (done: boolean | undefined, warn?: boolean) => (done ? "pass" : warn ? "warn" : "todo") as "pass" | "warn" | "todo";
  const loginPush = L?.profiles.find((p) => p.phase === "login" && (p.hasIdentity || p.hasEmail));
  const loginAction = running && L && !L.login.seen ? loginGuidance(latestLoginHints(events), fill, loginStalled, !!login.username) : null;
  const profileCalls = L?.calls.filter((c) => c.api === "profile").length ?? 0;

  return (
    <Card className="p-6">
      <Header />
      {helper.version < WEB_HELPER_MIN_VERSION && (
        <Notice tone="warn" className="mt-3" title="Old helper">
          Download the helper again — this page needs a newer version.
        </Notice>
      )}
      {!helper.chrome && device === "desktop" && (
        <Notice tone="warn" className="mt-3" title="Chrome not found">
          The helper couldn&apos;t find Google Chrome on this computer. Install it, or start the helper with CHROME_PATH set.
        </Notice>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Where to open" className="inline-flex rounded-xl border p-1">
          {(["desktop", "android"] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDevice(d)}
              aria-pressed={device === d}
              className={cx("min-h-9 rounded-lg px-3 text-sm font-bold", device === d ? "bg-brand text-brand-fg" : "text-text-2 hover:bg-surface-3")}
            >
              {d === "desktop" ? "Chrome on this computer" : "Chrome on Android (USB)"}
            </button>
          ))}
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-text-2">
          <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={fresh} onChange={(e) => setFresh(e.target.checked)} disabled={device === "android"} />
          Start as a brand-new visitor
        </label>
        <span className="basis-full text-[13px] text-muted">
          {fresh
            ? "Clears the test Chrome (cookies, CleverTap ID, notification permission) so the site sees a first-time visitor — checks the anonymous profile, UTM and the permission prompt. Recommended for the first run."
            : "Keeps the test Chrome as it was — you stay logged in and notifications stay allowed. Handy when re-running push tests."}
        </span>
        <Button icon="globe" loading={busy === "open"} disabled={!!busy && busy !== "open"} onClick={open}>
          {running ? "Open again" : "Open my website"}
        </Button>
        {running && (
          <Button variant="ghost" size="sm" icon="x" disabled={!!busy} onClick={close}>
            Close Chrome
          </Button>
        )}
      </div>
      <p className="mt-2 text-sm text-muted">
        {running ? `Live in ${browser ?? "Chrome"}${device === "android" ? " on your phone" : ""} — steps tick as you go.` : "Not running."}
      </p>
      {msg && (
        <Notice tone={msg.tone} className="mt-3">
          {msg.text}
        </Notice>
      )}

      {L && (
        <ol className="mt-5 space-y-4 border-t pt-5">
          <Step
            mark={step(L.sdk.present && L.network.accepted > 0)}
            title="Open as a visitor"
            text={
              L.sdk.present
                ? `CleverTap ${L.sdk.version ? `v${L.sdk.version} ` : ""}started · ${L.network.accepted} requests accepted · UTM ${L.utm.sent ? "sent" : "not sent"}${L.network.webPushConfigured ? " · web push config received" : ""}`
                : "Waiting for CleverTap to start on the page…"
            }
          />
          <Step
            mark={step(!!loginPush && loginPush.phoneValid !== false, loginPush?.phoneValid === false || (!!loginPush && loginPush.issues.length > 0))}
            title="Log in on the site — any way you normally do"
            text={
              loginPush
                ? `onUserLogin sent ${loginPush.keys.join(", ")}${loginPush.phone ? ` · phone ${loginPush.phone} ${loginPush.phoneValid ? "✓ +country code" : "✗ needs +country code"}` : " · no phone"}${loginPush.issues.length ? ` · ⚠ ${loginPush.issues.join("; ")}` : ""}`
                : L.login.seen
                  ? "Logged in."
                  : "Press Fill in test login, or log in yourself in the test Chrome. It ticks as soon as the site sends onUserLogin."
            }
            notice={
              loginAction && (
                <Notice tone={loginAction.act ? "warn" : "info"} title={loginAction.act ? "Action needed in the test Chrome" : undefined} className="mt-2">
                  {loginAction.text}
                </Notice>
              )
            }
            action={
              !L.login.seen && (
                <Button size="sm" variant="secondary" icon="key" loading={busy === "login"} disabled={!running || (!!busy && busy !== "login")} onClick={fillLogin}>
                  Fill in test login
                </Button>
              )
            }
          />
          <Step
            mark={step(L.push.subscribed, L.push.permission === "denied")}
            title="Allow notifications"
            text={
              L.push.subscribed
                ? `Subscribed to web push${L.push.serviceWorker ? ` (${new URL(L.push.serviceWorker).pathname})` : ""}.`
                : L.push.permission === "denied"
                  ? "Blocked — click the lock icon in the address bar → Notifications → Allow, then reload."
                  : "Click Allow on the site's prompt and on Chrome's prompt (profile page → Turn on notifications works too)."
            }
          />
          <Step mark={step(profileCalls > 0)} title="Update your profile on the site" text={profileCalls ? `profile.push called ${profileCalls}×.` : "Change your name, phone or preferences and save."} />
          <Step
            mark={step(L.events.length > 0, L.events.some((e) => e.issues.length > 0))}
            title="Do your key actions"
            text={L.events.length ? L.events.slice(0, 6).map((e) => `${e.name} ×${e.count}${e.issues.length ? " ⚠" : ""}`).join(" · ") : "View a product, add to cart, search…"}
          />
          <Step
            mark={step(L.revisit?.onUserLogin, !!L.revisit && !L.revisit.onUserLogin)}
            title="Come back as a returning user"
            text={L.revisit ? (L.revisit.onUserLogin ? "onUserLogin ran again on return ✓" : "Returned — onUserLogin didn't run again.") : "Stay logged in and reopen the site."}
            action={
              <Button size="sm" variant="secondary" icon="refresh" loading={busy === "reopen"} disabled={!running || (!!busy && busy !== "reopen")} onClick={reopen}>
                Reopen the site
              </Button>
            }
          />
          <Step
            mark={step(!!tests.push && !!L.push.tests.push?.receivedAt)}
            title="Test push — detected automatically"
            text={pushText(L.push.tests.push)}
            action={
              <Button size="sm" variant="secondary" icon="bell" loading={busy === "push"} disabled={!running || (!!busy && busy !== "push")} onClick={() => sendPush("push")}>
                Send test push
              </Button>
            }
          />
          <Step
            mark={step(!!L.push.tests.deeplink?.clickedAt && !!L.push.tests.deeplink.landedUrl)}
            title="Push with a link — click it"
            text={pushText(L.push.tests.deeplink, true)}
            action={
              <Button
                size="sm"
                variant="secondary"
                icon="link"
                loading={busy === "deeplink"}
                disabled={!running || !/^https:\/\/.+/.test(link.trim()) || (!!busy && busy !== "deeplink")}
                onClick={() => sendPush("deeplink")}
              >
                Send push with link
              </Button>
            }
          />
        </ol>
      )}
    </Card>
  );
}

function pushText(t?: LivePushTest, link = false) {
  if (!t) return link ? "Uses the link below. Click the notification when it shows; we see which page opens." : "Sent to the logged-in user; we spot it arriving in Chrome.";
  const s = (at?: number) => (at ? `${Math.max(1, Math.round((at - t.sentAt) / 1000))} s` : "");
  if (t.clickedAt) return `Clicked after ${s(t.clickedAt)} → opened ${t.landedUrl ?? "nothing"}${t.deepLink ? ` (link: ${t.deepLink})` : ""}`;
  if (t.receivedAt || t.shownAt) return `Arrived in Chrome after ${s(t.receivedAt ?? t.shownAt)}${t.viewedAt ? " · Notification Viewed reported" : ""}${link ? " — now click it." : ""}`;
  const waited = Math.round((Date.now() - t.sentAt) / 1000);
  return waited > 120 ? "Not received after 2 minutes — is the test Chrome subscribed and logged in as this user?" : `Sent ${waited} s ago — watching for it…`;
}

function Header() {
  return (
    <>
      <div className="flex items-center gap-2">
        <h3 className="text-lg font-bold">Live session in your Chrome</h3>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft py-0.5 pl-2 pr-2.5 text-xs font-bold text-brand-text">
          <Icon name="auto" size={13} /> Recommended
        </span>
      </div>
      <p className="mt-1 max-w-[66ch] text-sm text-muted">
        We open your website in a real Chrome window (on this computer or your Android phone). You log in and use the site as usual; we read what CleverTap
        receives and spot test pushes arriving and being clicked — no buttons to confirm.
      </p>
    </>
  );
}

function Step({ mark, title, text, action, notice }: { mark: "pass" | "warn" | "todo"; title: string; text: string; action?: React.ReactNode; notice?: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-start gap-3">
      <StatusMark status={mark} size={24} />
      <div className="min-w-0 flex-1 basis-64">
        <div className="font-bold">{title}</div>
        <div className="break-words text-sm text-text-2">{text}</div>
        {notice}
      </div>
      {action}
    </li>
  );
}

/**
 * What the user should do next on their login page, from what the helper sees
 * there right now and what happened when we filled it. `act` = the user must do
 * something themselves in the test Chrome.
 */
function loginGuidance(h: LoginHints | undefined, fill: LoginFillResult | null, stalled: boolean, haveLogin: boolean): { act: boolean; text: string } | null {
  if (stalled)
    return {
      act: true,
      text: "We submitted the login 25 s ago and the site still hasn't sent onUserLogin. If the test Chrome shows you logged in, the site isn't identifying users to CleverTap — call clevertap.onUserLogin.push({Site: {Identity, Email}}) after login. If it doesn't, check the page there.",
    };
  // the page itself is the most up-to-date signal
  if (h?.form === "otp") return { act: true, text: "The page is asking for a code (OTP). Type the code you received into the test Chrome — we'll see the login when it goes through." };
  if (h?.captcha) return { act: true, text: "The page has a captcha. Solve it in the test Chrome and press the site's login button there." };
  if (fill?.needs) return { act: true, text: fill.message };
  if (h?.form === "social")
    return { act: true, text: `This page only offers ${h.social.join(" / ")} sign-in. Log in yourself in the test Chrome — we can't type into Google / Apple pages.` };
  if (h && h.form !== "none")
    return haveLogin
      ? { act: false, text: `Login form found (${h.form === "password" ? "email / username + password" : h.form === "phone" ? "phone number" : "email first, then the next step"}). Press Fill in test login.` }
      : { act: true, text: "Enter the test account above and press Fill in test login — or just log in yourself in the test Chrome." };
  if (h?.form === "none" && !fill) return { act: false, text: "No login form on this page yet. Press Fill in test login (we look for the site's Log in link), set the Login page above, or open it yourself in the test Chrome." };
  return null;
}
