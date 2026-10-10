"use client";

import { useState } from "react";
import { api, refreshAudit } from "@/lib/store";
import { customEventNames } from "@/lib/engine/android";
import type { Audit } from "@/lib/types";
import { Card, Button } from "@/components/ui";
import { Icon } from "@/components/Icon";

// Custom events to verify: the few custom events the customer cares about most.
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
      setMsg("Saved. Now do these actions on the phone under “Your key actions”.");
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
      return { t: "property issues", c: "var(--fail-text)" };
    if (live) return { t: `seen live ×${live.count}`, c: "var(--pass)" };
    if (fromApi && fromApi.androidSampled > 0) return { t: `${fromApi.capped ? "≥" : ""}${fromApi.androidSampled} in 30 days`, c: "var(--pass)" };
    if (fromApi) return { t: "no data in 30 days", c: "var(--fail-text)" };
    return { t: "not checked yet", c: "var(--muted-2)" };
  };

  return (
    <Card className="p-6">
      <h3 className="text-lg font-bold">Your key events</h3>
      <p className="mt-1 max-w-[66ch] text-[15px] text-text-2">
        Pick the 3–4 custom events that matter most, such as <i>Product Viewed</i> or <i>Added To Cart</i>. Then do those actions on the phone under
        “Your key actions” below — we check each one arrives with the right property types. Names must match your code exactly.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {list.map((n) => {
          const st = statusOf(n);
          return (
            <span key={n} className="inline-flex min-h-10 items-center gap-2 rounded-full border-[1.5px] border-brand bg-brand-soft py-1 pl-3.5 pr-2 text-sm">
              <b className="font-mono font-medium text-brand-text">{n}</b>
              <span className="font-semibold" style={{ color: st.c }}>
                · {st.t}
              </span>
              <button
                onClick={() => setList(list.filter((x) => x !== n))}
                aria-label={`Remove ${n}`}
                className="flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-text"
              >
                <Icon name="x" size={14} />
              </button>
            </span>
          );
        })}
        {list.length === 0 && <span className="text-sm text-muted">No key events chosen yet.</span>}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add(input)}
          className="input max-w-xs"
          placeholder="Type an event name, press Enter"
          aria-label="Event name"
        />
        <Button variant="secondary" icon="plus" disabled={!input.trim() || list.length >= 10} onClick={() => add(input)}>
          Add
        </Button>
        <Button icon="check" disabled={!dirty || busy} onClick={save}>
          {busy ? "Saving…" : "Save events"}
        </Button>
      </div>

      {suggestions.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted">Seen in this app:</span>
          {suggestions.map((n) => (
            <button
              key={n}
              onClick={() => add(n)}
              className="inline-flex min-h-9 items-center gap-1 rounded-full border border-[var(--border-strong)] px-3 font-mono text-[13px] text-text-2 transition hover:border-brand hover:bg-brand-soft"
            >
              <Icon name="plus" size={13} /> {n}
            </button>
          ))}
        </div>
      )}
      {msg && <p className="mt-3 text-sm font-semibold text-text-2">{msg}</p>}
    </Card>
  );
}
