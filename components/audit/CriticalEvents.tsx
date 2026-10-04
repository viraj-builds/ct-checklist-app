"use client";

import { useState } from "react";
import { api, refreshAudit } from "@/lib/store";
import { customEventNames } from "@/lib/engine/android";
import type { Audit } from "@/lib/types";
import { Card, Button } from "@/components/ui";
import { Icon } from "@/components/Icon";

// Business-critical events: the few events the customer's business depends on.
// Each one is checked two ways — the CleverTap API (did it arrive in the last
// 30 days, with which property types) and the live log session (fired on the
// phone just now, with which properties).

export function CriticalEvents({ audit }: { audit: Audit }) {
  const saved = audit.criticalEvents ?? [];
  const [list, setList] = useState<string[]>(saved);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const dirty = list.join("|") !== saved.join("|");

  // Events we've actually seen — offered as one-click suggestions.
  const seen = [
    ...(audit.device?.logs?.events.map((e) => e.name) ?? []),
    ...customEventNames(audit.api?.testUser),
    ...(audit.scan?.eventNames ?? []),
  ];
  const suggestions = [...new Set(seen)].filter((n) => !list.includes(n)).slice(0, 12);

  const add = (name: string) => {
    const n = name.trim();
    if (n && !list.includes(n) && list.length < 10) setList([...list, n]);
    setInput("");
  };

  async function save() {
    setBusy(true);
    setMsg("");
    try {
      await api(`/api/audits/${audit.id}`, { method: "PATCH", body: JSON.stringify({ criticalEvents: list }) });
      setMsg(audit.api?.ok ? "Saved. Press “Re-run API checks” to fetch their data from CleverTap." : "Saved.");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
      refreshAudit(audit.id);
    }
  }

  const statusOf = (name: string) => {
    const live = audit.device?.logs?.events.find((e) => e.name === name);
    const fromApi = audit.api?.events[name];
    if (live?.issues.length || Object.values(fromApi?.props ?? {}).some((p) => p.numericStrings || p.dateLikeStrings || p.types.nullish))
      return { t: "property issues", c: "var(--fail)" };
    if (live) return { t: `seen live ×${live.count}`, c: "var(--pass)" };
    if (fromApi && fromApi.androidSampled > 0) return { t: `${fromApi.capped ? "≥" : ""}${fromApi.androidSampled} in 30 days`, c: "var(--pass)" };
    if (fromApi) return { t: "no data in 30 days", c: "var(--fail)" };
    return { t: "not checked yet", c: "var(--na)" };
  };

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <Icon name="zap" size={17} className="text-brand" />
        <h2 className="font-semibold">Business-critical events</h2>
      </div>
      <p className="mt-1 text-sm text-muted">
        The 3–4 events your business depends on (e.g. <i>Charged</i>, <i>Added To Cart</i>). Each is checked in CleverTap (did it arrive in
        the last 30 days?) and live on the phone (do its properties have the right types?). Names must match the dashboard exactly.
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {list.map((n) => {
          const st = statusOf(n);
          return (
            <span key={n} className="inline-flex items-center gap-1.5 rounded-full border bg-surface-2 px-2.5 py-1 text-xs">
              <b>{n}</b>
              <span style={{ color: st.c }}>· {st.t}</span>
              <button onClick={() => setList(list.filter((x) => x !== n))} aria-label={`Remove ${n}`} className="text-muted hover:text-text">
                <Icon name="x" size={12} />
              </button>
            </span>
          );
        })}
        {list.length === 0 && <span className="text-xs text-muted">None yet.</span>}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add(input)}
          className="input max-w-xs"
          placeholder="Type an event name and press Enter"
        />
        <Button size="sm" variant="secondary" icon="plus" disabled={!input.trim() || list.length >= 10} onClick={() => add(input)}>
          Add
        </Button>
        <Button size="sm" icon="check" disabled={!dirty || busy} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>

      {suggestions.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted">Seen in this app:</span>
          {suggestions.map((n) => (
            <button key={n} onClick={() => add(n)} className="rounded-full border px-2 py-0.5 text-muted transition hover:bg-surface-2 hover:text-text">
              + {n}
            </button>
          ))}
        </div>
      )}
      {msg && <p className="mt-2 text-xs text-muted">{msg}</p>}
    </Card>
  );
}
