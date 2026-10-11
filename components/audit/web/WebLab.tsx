"use client";

import { useState } from "react";
import { api, refreshAudit } from "@/lib/store";
import { rememberIdentity, rememberPasscode, rememberWebLogin, useSecrets } from "@/lib/session-secrets";
import type { Audit } from "@/lib/types";
import type { TestPushRecord } from "@/lib/clevertap/types";
import { Card, Button, Notice, StatusMark } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { LiveSession } from "./LiveSession";

// Website tests: re-run the website check (optionally with a test login),
// re-check CleverTap for what the visit produced, and trigger + confirm a test
// web push (with and without a link). Passcode and test login stay in memory.

export function WebLab({ audit, visible }: { audit: Audit; visible: boolean }) {
  const secrets = useSecrets(audit.id);
  const scan = audit.webScan;
  const w = audit.api?.web;
  const [passcode, setPasscode] = useState(secrets.passcode);
  const [identity, setIdentity] = useState(secrets.identity);
  const [user, setUser] = useState(secrets.webLogin?.username ?? "");
  const [pass, setPass] = useState(secrets.webLogin?.password ?? "");
  const [loginUrl, setLoginUrl] = useState(secrets.webLogin?.url ?? "");
  const [link, setLink] = useState(() => (audit.target ? new URL(audit.target).origin + "/" : "https://"));
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "fail"; text: string } | null>(null);

  const id = identity.trim();
  const keep = () => {
    if (passcode) rememberPasscode(audit.id, passcode);
    if (id) rememberIdentity(audit.id, id);
  };

  async function guard(name: string, fn: () => Promise<string | void>) {
    setBusy(name);
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ tone: "ok", text });
    } catch (e) {
      setMsg({ tone: "fail", text: (e as Error).message });
    } finally {
      setBusy("");
      refreshAudit(audit.id);
    }
  }

  const verify = (ident?: string) => api(`/api/audits/${audit.id}/verify`, { method: "POST", body: JSON.stringify({ passcode, ...(ident ? { identity: ident } : {}) }) });

  const recheckSite = () =>
    guard("crawl", async () => {
      keep();
      const login = user.trim() && pass ? { url: loginUrl.trim() || undefined, username: user.trim(), password: pass } : undefined;
      if (login) rememberWebLogin(audit.id, login);
      const r = await api<{ identity?: string; login: { ok?: boolean; message?: string } }>(`/api/audits/${audit.id}/crawl`, {
        method: "POST",
        body: JSON.stringify({ login }),
      });
      const ident = r.identity ?? (login?.username.includes("@") ? login.username : undefined) ?? (id || undefined);
      if (ident) {
        setIdentity(ident);
        rememberIdentity(audit.id, ident);
      }
      if (passcode) await verify(ident);
      if (login && !r.login.ok) return `Website checked, but the test login didn't work: ${r.login.message ?? ""}`;
      return passcode ? "Website checked and CleverTap verified." : "Website checked. Add your passcode to also confirm it in CleverTap.";
    });

  const recheckApi = () =>
    guard("verify", async () => {
      keep();
      const r = await api<{ ok: boolean; error?: string }>(`/api/audits/${audit.id}/verify`, {
        method: "POST",
        body: JSON.stringify({ passcode, ...(id ? { identity: id } : {}) }),
      });
      if (!r.ok) throw new Error(r.error ?? "CleverTap API check failed.");
      return "CleverTap checked again.";
    });

  const sendPush = (withLink: boolean) =>
    guard(withLink ? "deeplink" : "push", async () => {
      keep();
      const r = await api<{ test: TestPushRecord }>(`/api/audits/${audit.id}/web-push`, {
        method: "POST",
        body: JSON.stringify({ passcode, identity: id, ...(withLink ? { deepLink: link.trim() } : {}) }),
      });
      if (r.test.status === "failed") throw new Error(r.test.message ?? "CleverTap rejected the web push.");
      return withLink ? "Sent. Click the notification when it appears, then press Check delivery." : "Sent. When the notification appears, press Check delivery.";
    });

  const confirm = (kind: "push" | "deeplink") =>
    guard(`confirm-${kind}`, async () => {
      keep();
      const r = await api<{ test: TestPushRecord; user: { webPushToken: boolean } }>(`/api/audits/${audit.id}/web-push/confirm`, {
        method: "POST",
        body: JSON.stringify({ passcode, identity: id, kind }),
      });
      if (r.test.status === "confirmed") return r.test.clicked ? "Confirmed — CleverTap recorded the click." : "Confirmed — CleverTap recorded Notification Viewed.";
      throw new Error(
        r.user.webPushToken
          ? "Not recorded yet. It can take a minute — try again. If you saw it, tick the check yourself."
          : "The test user has no web push token: open the site in Chrome, log in as this user and click Allow on the prompt, then send again.",
      );
    });

  const needApi = !passcode ? "Enter your CleverTap passcode." : !id ? "Enter the test user's Identity or Email." : "";

  return (
    <div hidden={!visible} className="space-y-6">
      {msg && (
        <Notice tone={msg.tone} title={msg.tone === "ok" ? "Done" : "That didn't work"}>
          {msg.text}
        </Notice>
      )}

      {/* ---- credentials ---- */}
      <Card className="p-6">
        <h3 className="text-lg font-bold">CleverTap passcode and test user</h3>
        <p className="mt-1 text-sm text-muted">Kept in this tab only — a reload forgets them.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Labeled label="Passcode" htmlFor="wl-passcode">
            <input
              id="wl-passcode"
              type="password"
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              placeholder="Paste your passcode"
              className="input font-mono"
            />
          </Labeled>
          <Labeled label="Test user (Identity or Email)" htmlFor="wl-identity">
            <input id="wl-identity" value={identity} onChange={(e) => setIdentity(e.target.value)} placeholder="test.user@yourstore.com" className="input" />
          </Labeled>
        </div>
      </Card>

      {/* ---- live session in the user's own Chrome ---- */}
      <LiveSession audit={audit} passcode={passcode} link={link} onIdentity={setIdentity} />

      {/* ---- website check ---- */}
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold">Automatic check (no helper needed)</h3>
            <p className="mt-1 text-sm text-muted">
              {scan
                ? `Last checked ${formatDate(scan.scannedAt)} · ${scan.pages.length} page${scan.pages.length === 1 ? "" : "s"} · ${Math.round(scan.durationMs / 1000)} s${
                    scan.login.attempted ? ` · login ${scan.login.ok ? "worked" : "didn't work"}` : " · no test login"
                  }`
                : "Not checked yet."}
            </p>
          </div>
          <Button icon="refresh" loading={busy === "crawl"} disabled={!!busy && busy !== "crawl"} onClick={recheckSite}>
            {scan ? "Check again" : "Check my website"}
          </Button>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Labeled label="Website login (test account)" htmlFor="wl-user">
            <input id="wl-user" autoComplete="off" data-1p-ignore value={user} onChange={(e) => setUser(e.target.value)} placeholder="Email or username" className="input" />
          </Labeled>
          <Labeled label="Password" htmlFor="wl-pass">
            <input
              id="wl-pass"
              type="password"
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              placeholder="Never stored"
              className="input"
            />
          </Labeled>
          <Labeled label="Login page (optional)" htmlFor="wl-url">
            <input id="wl-url" value={loginUrl} onChange={(e) => setLoginUrl(e.target.value)} placeholder="/login" className="input font-mono" />
          </Labeled>
        </div>
        {scan && <ScanFacts audit={audit} />}
      </Card>

      {/* ---- CleverTap confirmation ---- */}
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold">Confirm in CleverTap</h3>
            <p className="mt-1 max-w-[62ch] text-sm text-muted">
              Finds the visitor our check created and your test user in CleverTap, and samples your custom events. New data can take a few minutes to show —
              do your key actions on the site, then check again.
            </p>
          </div>
          <Button variant="secondary" icon="refresh" loading={busy === "verify"} disabled={!passcode || (!!busy && busy !== "verify")} onClick={recheckApi}>
            Check CleverTap again
          </Button>
        </div>
        <ul className="mt-4 space-y-2.5 text-[15px] text-text-2">
          <Fact ok={w?.visitor?.found} label="Our test visitor in CleverTap" value={w?.visitor ? (w.visitor.found ? `${w.visitor.identified ? "identified" : "anonymous"} · ${Object.keys(w.visitor.events).slice(0, 4).join(", ") || "no events yet"}` : "not found yet") : "not checked"} />
          <Fact ok={w?.user?.found} label="Test user" value={w?.user ? (w.user.found ? `${w.user.key} · ${w.user.webPushToken ? "subscribed to web push" : "no web push token"}` : `${w.user.key} not found`) : "not checked"} />
          {w?.webPush && !w.webPush.error && (
            <Fact ok={w.webPush.campaigns > 0 ? w.webPush.viewed > 0 : undefined} label="Web push campaigns (30 days)" value={`${w.webPush.campaigns} campaigns · ${w.webPush.sent} sent · ${w.webPush.viewed} viewed · ${w.webPush.clicked} clicked`} />
          )}
        </ul>
      </Card>

      {/* ---- web push ---- */}
      <Card className="p-6">
        <h3 className="text-lg font-bold">Test web push</h3>
        <ol className="mt-3 space-y-2 text-[15px] text-text-2">
          <li>1. Open your website in Chrome (not incognito) and log in as the test user.</li>
          <li>2. Click Allow on CleverTap&apos;s prompt and on the browser&apos;s prompt.</li>
          <li>3. Send a test push here, then press Check delivery once it shows.</li>
        </ol>
        {needApi && <p className="mt-3 text-sm text-muted">{needApi}</p>}
        <div className="mt-5 space-y-4">
          <PushRow
            title="Plain test push"
            test={w?.tests?.push}
            sending={busy === "push"}
            checking={busy === "confirm-push"}
            disabled={!!needApi || (!!busy && !busy.endsWith("push"))}
            onSend={() => sendPush(false)}
            onConfirm={() => confirm("push")}
          />
          <div className="border-t pt-4">
            <Labeled label="Link to open when clicked (https)" htmlFor="wl-link">
              <input id="wl-link" type="url" value={link} onChange={(e) => setLink(e.target.value)} className="input font-mono" />
            </Labeled>
            <div className="mt-3">
              <PushRow
                title="Push with a link"
                test={w?.tests?.deeplink}
                sending={busy === "deeplink"}
                checking={busy === "confirm-deeplink"}
                disabled={!!needApi || !/^https:\/\/.+/.test(link.trim()) || (!!busy && !busy.endsWith("deeplink"))}
                onSend={() => sendPush(true)}
                onConfirm={() => confirm("deeplink")}
              />
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function ScanFacts({ audit }: { audit: Audit }) {
  const s = audit.webScan!;
  const facts: [string, string, boolean | undefined][] = [
    ["CleverTap SDK", s.sdk.present ? `${s.sdk.loading === "head" ? "in <head>" : s.sdk.loading === "bundle" ? "npm bundle" : "script tag"}${s.sdk.version ? ` · v${s.sdk.version}` : ""}` : "not found", s.sdk.present],
    ["Account · region", s.sdk.accountId ? `${s.sdk.accountId} · ${s.sdk.region ?? "?"}` : "—", s.sdk.accountId ? s.sdk.accountId.toUpperCase() === (audit.accountId ?? "").toUpperCase() : undefined],
    ["Requests accepted", `${s.network.accepted} of ${s.network.requests}`, s.network.requests ? s.network.accepted === s.network.requests : undefined],
    ["UTM test", s.utm.sent ? "sent with the page view" : `not sent (landed on ${s.utm.landedOn ?? "?"})`, s.utm.sent],
    ["Service worker", `${s.webPush.serviceWorkerPath} · ${s.webPush.serviceWorker.clevertap ? "CleverTap" : s.webPush.serviceWorker.reachable ? "not CleverTap" : "missing"}`, s.webPush.serviceWorker.clevertap],
    ["Custom events seen", s.events.length ? s.events.map((e) => e.name).slice(0, 4).join(", ") : "none on the pages we opened", s.events.length ? true : undefined],
  ];
  return (
    <ul className="mt-5 grid gap-x-6 gap-y-2.5 border-t pt-4 text-[15px] sm:grid-cols-2">
      {facts.map(([k, v, ok]) => (
        <Fact key={k} label={k} value={v} ok={ok} />
      ))}
      {s.login.attempted && <Fact label="Test login" value={s.login.message ?? (s.login.ok ? "worked" : "didn't work")} ok={s.login.ok} />}
    </ul>
  );
}

function Fact({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <li className="flex min-w-0 items-start gap-2.5">
      <StatusMark status={ok === undefined ? "todo" : ok ? "pass" : "warn"} size={20} />
      <span className="min-w-0">
        <span className="font-semibold text-text">{label}: </span>
        <span className="break-words text-text-2">{value}</span>
      </span>
    </li>
  );
}

function PushRow({
  title,
  test,
  sending,
  checking,
  disabled,
  onSend,
  onConfirm,
}: {
  title: string;
  test?: TestPushRecord;
  sending: boolean;
  checking: boolean;
  disabled: boolean;
  onSend: () => void;
  onConfirm: () => void;
}) {
  const st = test?.status;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <StatusMark status={st === "confirmed" ? "pass" : st === "failed" ? "fail" : st ? "manual" : "todo"} size={24} />
      <div className="min-w-0 flex-1 basis-56">
        <div className="font-bold">{title}</div>
        <div className="text-sm text-muted">
          {!test
            ? "Not sent yet"
            : st === "confirmed"
              ? `Confirmed — ${test.clicked ? "clicked" : "viewed"}`
              : st === "failed"
                ? test.message
                : st === "not-confirmed"
                  ? "Sent — not recorded yet"
                  : `Sent ${new Date(test.sentAt).toLocaleTimeString()}`}
        </div>
      </div>
      <Button size="sm" variant="secondary" icon="bell" loading={sending} disabled={disabled} onClick={onSend}>
        Send
      </Button>
      <Button size="sm" variant="outline" icon="check" loading={checking} disabled={disabled || !test || st === "failed"} onClick={onConfirm}>
        Check delivery
      </Button>
    </div>
  );
}

function Labeled({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-bold">
        {label}
      </label>
      {children}
    </div>
  );
}
