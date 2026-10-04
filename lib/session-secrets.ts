"use client";

import { useSyncExternalStore } from "react";

// Keeps the CleverTap passcode and test identity in memory for the current tab
// only, so the report page can run API / device tests without asking again.
// Never written to storage — a reload forgets them.

type Secrets = { passcode: string; identity: string };
const byAudit = new Map<string, Secrets>();
const listeners = new Set<() => void>();
const EMPTY: Secrets = { passcode: "", identity: "" };

function update(auditId: string, patch: Partial<Secrets>) {
  byAudit.set(auditId, { ...(byAudit.get(auditId) ?? EMPTY), ...patch });
  listeners.forEach((l) => l());
}

export const rememberPasscode = (auditId: string, passcode: string) => update(auditId, { passcode });
export const rememberIdentity = (auditId: string, identity: string) => update(auditId, { identity });
export const recallPasscode = (auditId: string) => byAudit.get(auditId)?.passcode || undefined;

export function useSecrets(auditId: string): Secrets {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => byAudit.get(auditId) ?? EMPTY,
    () => EMPTY,
  );
}
