"use client";

import { useState } from "react";
import { api, refreshAudit } from "@/lib/store";
import { isTestAccount, sameAccount } from "@/lib/account";
import type { Audit } from "@/lib/types";
import { Button, Notice } from "@/components/ui";

// When the app / site sends data to a different CleverTap project than the
// audit was set up for, ask which one is right — usually the test project
// (TEST- prefix) — and switch the audit in one click.

const VALID = /^[A-Za-z0-9-]{3,40}$/;

/** The account ID the build / site / device actually uses, from the freshest evidence. */
export function detectedAccount(a: Audit): string | undefined {
  const found = [
    a.device?.logs?.accountId,
    a.iosDevice?.logs?.accountId,
    a.webLive?.sdk.accountId,
    a.webScan?.sdk.accountId,
    a.scan?.manifest?.metaData?.CLEVERTAP_ACCOUNT_ID,
    a.iosScan?.plist?.accountId,
  ];
  // skip unresolved build settings like ${CT_ACCOUNT} / $(CT_ACCOUNT)
  return found.map((x) => x?.trim()).find((x) => !!x && VALID.test(x));
}

export function AccountCheck({ audit }: { audit: Audit }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const found = detectedAccount(audit);
  if (!found || !audit.accountId || sameAccount(found, audit.accountId)) return null;

  const where = audit.platform === "web" ? "Your website" : "Your app";
  const test = isTestAccount(found);

  async function useFound() {
    setBusy(true);
    setErr("");
    try {
      await api(`/api/audits/${audit.id}`, { method: "PATCH", body: JSON.stringify({ accountId: found }) });
      await refreshAudit(audit.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Notice tone="warn" title={test ? "Is this a test project?" : "Is this the right CleverTap project?"}>
      <p>
        {where} sends data to <b className="font-mono">{found}</b>
        {test ? " — a test project (TEST- prefix)" : ""}, but this audit is set up for <b className="font-mono">{audit.accountId}</b>. Checks that read your
        CleverTap data look at the audit&apos;s project, so they won&apos;t see what this {audit.platform === "web" ? "site" : "app"} sends.
      </p>
      <p className="mt-2">
        {test
          ? "If you're testing on the test dashboard, switch the audit to the test project and use that project's passcode (Settings → Project on the test dashboard)."
          : `If ${found} is the project you meant, switch the audit to it and use its passcode. If not, the ${audit.platform === "web" ? "site" : "app"} has the wrong Project ID.`}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button size="sm" loading={busy} onClick={useFound}>
          Use {found} for this audit
        </Button>
        <span className="text-[13px] text-muted">CleverTap results from the old project are cleared; live results stay.</span>
      </div>
      {err && <p className="mt-2 font-semibold" style={{ color: "var(--fail-text)" }}>{err}</p>}
    </Notice>
  );
}
