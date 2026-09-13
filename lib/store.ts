"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { Audit, ItemStatus } from "./types";
import { seedAudits } from "./mock";
import { itemsForPlatform } from "./checklist";

const KEY = "ct-audit-store-v1";

// ---------------------------------------------------------------------------
// Tiny localStorage-backed store with a subscription so multiple components
// stay in sync. All reads/writes are wrapped in try/catch (private windows,
// blocked storage, SSR).
// ---------------------------------------------------------------------------

let cache: Audit[] | null = null;
const listeners = new Set<() => void>();
const EMPTY: Audit[] = [];

// Pure snapshot for useSyncExternalStore — no listener notifications here.
function read(): Audit[] {
  if (cache) return cache;
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      cache = JSON.parse(raw) as Audit[];
      return cache;
    }
  } catch {
    /* ignore */
  }
  // First run: seed and persist silently (no notify — we're inside a snapshot).
  cache = seedAudits();
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
  return cache;
}

function write(audits: Audit[]) {
  cache = audits;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(audits));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ---- mutations ----
export function addAudit(a: Audit) {
  const all = read();
  write([a, ...all.filter((x) => x.id !== a.id)]);
}

export function deleteAudit(id: string) {
  write(read().filter((a) => a.id !== id));
}

export function getAuditById(id: string): Audit | undefined {
  return read().find((a) => a.id === id);
}

export function setItemStatus(auditId: string, itemId: string, status: ItemStatus) {
  const all = read();
  const next = all.map((a) => {
    if (a.id !== auditId) return a;
    const r = a.results[itemId] ?? { itemId, status };
    return {
      ...a,
      results: {
        ...a.results,
        [itemId]: { ...r, status, checkedManually: status === "pass" },
      },
    };
  });
  write(next);
}

export function resetStore() {
  write(seedAudits());
}

// ---- hooks ----
export function useAudits(): Audit[] {
  const snap = useSyncExternalStore(
    subscribe,
    () => read(),
    () => EMPTY,
  );
  return snap;
}

export function useAudit(id: string): Audit | undefined {
  const audits = useAudits();
  return audits.find((a) => a.id === id);
}

// ---- summary helpers ----
export interface AuditSummary {
  total: number;
  counts: Record<ItemStatus, number>;
  autoDone: number; // pass among non-manual
  score: number; // 0-100, pass/(pass+fail+warn) over auto-checkable
  manualPending: number;
}

export function summarize(a: Audit): AuditSummary {
  const items = itemsForPlatform(a.platform);
  const counts: Record<ItemStatus, number> = {
    pass: 0,
    fail: 0,
    warn: 0,
    manual: 0,
    na: 0,
  };
  for (const it of items) {
    const st = a.results[it.id]?.status ?? "na";
    counts[st] = (counts[st] ?? 0) + 1;
  }
  const autoScorable = counts.pass + counts.fail + counts.warn;
  const score =
    autoScorable === 0 ? 0 : Math.round((counts.pass / autoScorable) * 100);
  return {
    total: items.length,
    counts,
    autoDone: counts.pass,
    score,
    manualPending: counts.manual,
  };
}

// convenience: know when we're mounted (avoid hydration mismatch for time strings)
export function useMounted() {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}
