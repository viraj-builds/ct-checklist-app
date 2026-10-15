"use client";

import { useState } from "react";
import Link from "next/link";
import { api, refreshAudit } from "@/lib/store";
import { CONSENT_POINTS, CONSENT_VERSION, SCREENSHOT_POINT } from "@/lib/consent";
import { Card, Button, Notice } from "@/components/ui";
import { Icon } from "@/components/Icon";

/** The two consent checkboxes (data capture: required · screenshots: optional). */
export function ConsentFields({
  data,
  onData,
  screenshots,
  onScreenshots,
}: {
  data: boolean;
  onData: (v: boolean) => void;
  screenshots: boolean;
  onScreenshots: (v: boolean) => void;
}) {
  return (
    <div className="rounded-xl border px-4 py-4">
      <div className="flex items-center gap-2 text-[15px] font-bold">
        <Icon name="shield" size={17} className="text-brand" /> Data &amp; privacy
      </div>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-2">
        {CONSENT_POINTS.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <Link href="/privacy" target="_blank" className="link mt-2 inline-flex items-center gap-1 text-sm">
        Full privacy details <Icon name="external" size={13} />
      </Link>
      <label className="mt-4 flex cursor-pointer items-start gap-3 text-[15px]">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--brand)]" checked={data} onChange={(e) => onData(e.target.checked)} />
        <span>
          <span className="font-bold">I agree</span> — I&apos;m allowed to test this app / website and CleverTap project, and I agree to the data capture described
          above. <span className="text-muted">(required)</span>
        </span>
      </label>
      <label className="mt-3 flex cursor-pointer items-start gap-3 text-[15px]">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--brand)]" checked={screenshots} onChange={(e) => onScreenshots(e.target.checked)} />
        <span>
          Screenshots <span className="text-muted">(optional)</span>
          <span className="block text-sm text-muted">{SCREENSHOT_POINT}</span>
        </span>
      </label>
    </div>
  );
}

export const consentBody = (screenshots: boolean) => ({ version: CONSENT_VERSION, dataCapture: true as const, screenshots });

/** For audits created before consent existed: shown instead of the live / device tests until accepted. */
export function ConsentGate({ auditId }: { auditId: string }) {
  const [data, setData] = useState(false);
  const [shots, setShots] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function accept() {
    setBusy(true);
    setErr("");
    try {
      await api(`/api/audits/${auditId}`, { method: "PATCH", body: JSON.stringify({ consent: consentBody(shots) }) });
      await refreshAudit(auditId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="p-6">
      <h3 className="text-lg font-bold">Before the live tests</h3>
      <p className="mt-1 text-sm text-muted">This audit was created before we asked for consent. Please review what the tests capture and agree to continue.</p>
      <div className="mt-4">
        <ConsentFields data={data} onData={setData} screenshots={shots} onScreenshots={setShots} />
      </div>
      {err && (
        <Notice tone="fail" className="mt-3">
          {err}
        </Notice>
      )}
      <div className="mt-4">
        <Button icon="check" loading={busy} disabled={!data} onClick={accept}>
          Agree and continue
        </Button>
      </div>
    </Card>
  );
}
