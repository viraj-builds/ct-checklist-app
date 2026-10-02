"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { Audit, ItemStatus } from "./types";
import { itemsForPlatform } from "./checklist";

// ---------------------------------------------------------------------------
// Client-side cache over the /api/audits endpoints, with a subscription so
// every component showing the same audit stays in sync.
// ---------------------------------------------------------------------------

interface State {
  list?: Audit[];
  listError?: string;
  byId: Record<string, Audit | null>; // null = not found
  errors: Record<string, string>;
}

let state: State = { byId: {}, errors: {} };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const SERVER_STATE: State = { byId: {}, errors: {} };

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
    cache: "no-store",
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Request failed (${res.status})`);
  return json as T;
}

/* ---- loaders ---- */

export async function refreshAudits() {
  try {
    const { audits } = await api<{ audits: Audit[] }>("/api/audits");
    set({ list: audits, listError: undefined });
  } catch (e) {
    set({ listError: (e as Error).message, list: state.list ?? [] });
  }
}

export async function refreshAudit(id: string) {
  try {
    const { audit } = await api<{ audit: Audit }>(`/api/audits/${id}`);
    const errors = { ...state.errors };
    delete errors[id];
    set({
      byId: { ...state.byId, [id]: audit },
      errors,
      list: state.list?.map((a) => (a.id === id ? { ...a, ...audit } : a)),
    });
    return audit;
  } catch (e) {
    const msg = (e as Error).message;
    if (/not found/i.test(msg)) set({ byId: { ...state.byId, [id]: null } });
    else set({ errors: { ...state.errors, [id]: msg } });
    return undefined;
  }
}

/* ---- mutations ---- */

export async function deleteAudit(id: string) {
  await api(`/api/audits/${id}`, { method: "DELETE" });
  const byId = { ...state.byId };
  delete byId[id];
  set({ byId, list: state.list?.filter((a) => a.id !== id) });
}

export async function setItemStatus(auditId: string, itemId: string, status: ItemStatus) {
  // optimistic
  const a = state.byId[auditId];
  if (a) {
    const prev = a.results[itemId];
    set({
      byId: {
        ...state.byId,
        [auditId]: {
          ...a,
          results: {
            ...a.results,
            [itemId]: { ...(prev ?? { itemId }), status, checkedManually: status !== "manual" },
          },
        },
      },
    });
  }
  try {
    await api(`/api/audits/${auditId}/items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: status === "pass" || status === "fail" ? status : "manual" }),
    });
  } finally {
    await refreshAudit(auditId);
  }
}

/* ---- hooks ---- */

/** All audits (newest first). `undefined` while the first load is in flight. */
export function useAudits(): Audit[] | undefined {
  const s = useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
  useEffect(() => {
    refreshAudits();
  }, []);
  return s.list;
}

export function useAuditsError(): string | undefined {
  return useSyncExternalStore(subscribe, () => state.listError, () => undefined);
}

const ACTIVE = new Set(["draft", "scanning", "verifying"]);

/**
 * One audit with polling while a server-side job is running.
 * `audit === undefined` = loading, `null` = not found.
 */
export function useAudit(id: string): { audit: Audit | null | undefined; error?: string } {
  const s = useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
  const audit = s.byId[id];
  const status = audit?.status;
  useEffect(() => {
    refreshAudit(id);
  }, [id]);
  useEffect(() => {
    if (!status || !ACTIVE.has(status)) return;
    const t = setInterval(() => refreshAudit(id), 2500);
    return () => clearInterval(t);
  }, [id, status]);
  return { audit, error: s.errors[id] };
}

/* ---- summary helpers ---- */
export interface AuditSummary {
  total: number;
  counts: Record<ItemStatus, number>;
  autoDone: number; // pass among non-manual
  score: number; // 0-100, pass/(pass+fail+warn) over auto-checkable
  manualPending: number;
}

export function summarize(a: Audit): AuditSummary {
  const items = itemsForPlatform(a.platform);
  const counts: Record<ItemStatus, number> = { pass: 0, fail: 0, warn: 0, manual: 0, na: 0 };
  for (const it of items) {
    const st = a.results[it.id]?.status ?? "manual";
    counts[st] = (counts[st] ?? 0) + 1;
  }
  const autoScorable = counts.pass + counts.fail + counts.warn;
  const score = autoScorable === 0 ? 0 : Math.round((counts.pass / autoScorable) * 100);
  return { total: items.length, counts, autoDone: counts.pass, score, manualPending: counts.manual };
}

// convenience: know when we're mounted (avoid hydration mismatch for time strings)
const noopSubscribe = () => () => {};
export function useMounted() {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}
