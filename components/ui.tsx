import type { ReactNode } from "react";
import Link from "next/link";
import { cx } from "@/lib/format";
import { Icon, type IconName } from "./Icon";
import { STATUS_META, METHOD_META, PLATFORM_META } from "@/lib/meta";
import type { ItemStatus, CheckMethod, Platform } from "@/lib/types";

/* ---------------- Card ---------------- */
export function Card({
  children,
  className,
  hover,
  id,
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
  id?: string;
}) {
  return (
    <div
      id={id}
      className={cx(
        "rounded-[var(--radius)] border bg-surface",
        hover && "transition hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-md)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ---------------- Button ---------------- */
type BtnProps = {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger" | "subtle" | "outline";
  size?: "sm" | "md" | "lg";
  icon?: IconName;
  iconRight?: IconName;
  className?: string;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  type?: "button" | "submit";
  full?: boolean;
};

export function Button({
  children,
  variant = "primary",
  size = "md",
  icon,
  iconRight,
  className,
  onClick,
  href,
  disabled,
  type = "button",
  full,
}: BtnProps) {
  const base =
    "inline-flex items-center justify-center gap-2 font-bold rounded-[10px] transition-colors select-none whitespace-nowrap disabled:opacity-50 disabled:pointer-events-none";
  const sizes = {
    sm: "text-sm min-h-10 px-3.5",
    md: "text-[15px] min-h-11 px-4.5",
    lg: "text-base min-h-12 px-5.5",
  }[size];
  const variants = {
    primary: "bg-brand text-brand-fg hover:bg-brand-hover",
    secondary: "bg-surface border border-[var(--border-strong)] text-text hover:bg-brand-soft",
    outline: "bg-surface border-[1.5px] border-brand text-brand-text hover:bg-brand-soft",
    subtle: "bg-surface-3 text-text hover:bg-brand-soft",
    ghost: "text-muted hover:bg-surface-3 hover:text-text",
    danger: "bg-[var(--fail)] text-white hover:opacity-90",
  }[variant];
  const cls = cx(base, sizes, variants, full && "w-full", className);
  const inner = (
    <>
      {icon && <Icon name={icon} size={size === "sm" ? 16 : 18} />}
      {children}
      {iconRight && <Icon name={iconRight} size={size === "sm" ? 16 : 18} />}
    </>
  );
  if (href)
    return (
      <Link href={href} className={cls}>
        {inner}
      </Link>
    );
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={cls}>
      {inner}
    </button>
  );
}

/* ---------------- Badge ---------------- */
export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "brand" | "accent" | "success" | "warn" | "danger";
  className?: string;
}) {
  const styles: Record<string, { bg: string; fg: string }> = {
    neutral: { bg: "var(--surface-3)", fg: "var(--text-2)" },
    brand: { bg: "var(--brand-soft)", fg: "var(--brand-text)" },
    accent: { bg: "var(--accent-soft)", fg: "var(--brand-text)" },
    success: { bg: "var(--pass-soft)", fg: "var(--pass)" },
    warn: { bg: "var(--warn-soft)", fg: "var(--warn)" },
    danger: { bg: "var(--fail-soft)", fg: "var(--fail-text)" },
  };
  const s = styles[tone];
  return (
    <span
      className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold", className)}
      style={{ background: s.bg, color: s.fg }}
    >
      {children}
    </span>
  );
}

/* ---------------- StatusMark: the round marker used on every row ---------------- */
export function StatusMark({ status, size = 28 }: { status: ItemStatus | "todo" | "busy"; size?: number }) {
  const icon = Math.round(size * 0.5);
  const base = "flex shrink-0 items-center justify-center rounded-full";
  const dim = { width: size, height: size };
  if (status === "pass")
    return (
      <span className={base} style={{ ...dim, background: "var(--pass)", color: "#fff" }} aria-label="Passed">
        <Icon name="check" size={icon} strokeWidth={2.8} />
      </span>
    );
  if (status === "fail")
    return (
      <span className={base} style={{ ...dim, background: "var(--fail)", color: "#fff" }} aria-label="Needs fix">
        <Icon name="flag" size={icon} strokeWidth={2.8} />
      </span>
    );
  if (status === "warn")
    return (
      <span className={base} style={{ ...dim, background: "var(--warn-dot)", color: "#fff" }} aria-label="Check this">
        <Icon name="flag" size={icon} strokeWidth={2.8} />
      </span>
    );
  if (status === "manual")
    return (
      <span className={base} style={{ ...dim, border: "2px solid var(--manual)" }} aria-label="To check">
        <span className="rounded-full" style={{ width: size * 0.36, height: size * 0.36, background: "var(--manual)" }} />
      </span>
    );
  if (status === "busy")
    return <span className={cx(base, "pulse-dot")} style={{ ...dim, border: "2px solid var(--brand)", background: "var(--brand-soft)" }} aria-label="Checking" />;
  if (status === "na")
    return (
      <span className={base} style={{ ...dim, border: "1.5px dashed var(--muted-2)", color: "var(--muted-2)" }} aria-label="Not needed">
        <Icon name="x" size={Math.round(size * 0.4)} strokeWidth={2.4} style={{ transform: "rotate(45deg)" }} />
      </span>
    );
  return <span className={base} style={{ ...dim, border: "1.5px solid var(--border-strong)" }} aria-label="Not started" />;
}

/* ---------------- StatusBadge ---------------- */
export function StatusBadge({ status, size = "md" }: { status: ItemStatus; size?: "sm" | "md" }) {
  const m = STATUS_META[status];
  const color = status === "fail" ? "var(--fail-text)" : m.token;
  return (
    <span className={cx("inline-flex items-center whitespace-nowrap font-bold", size === "sm" ? "text-[13px]" : "text-sm")} style={{ color }}>
      {m.label}
    </span>
  );
}

/* ---------------- MethodBadge: who does the work ---------------- */
export function MethodBadge({ method }: { method: CheckMethod }) {
  const m = METHOD_META[method];
  const auto = method.startsWith("auto");
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full py-0.5 pl-2 pr-2.5 text-xs font-bold"
      style={auto ? { background: "var(--surface-3)", color: "var(--text-2)" } : { background: "var(--brand-soft)", color: "var(--brand-text)" }}
      title={m.desc}
    >
      <Icon name={auto ? "auto" : method === "hybrid" ? "phone" : "user"} size={14} />
      {m.short}
    </span>
  );
}

/* ---------------- PlatformIcon ---------------- */
export function PlatformIcon({ platform, size = 18 }: { platform: Platform; size?: number }) {
  const name = PLATFORM_META[platform].icon as IconName;
  return <Icon name={name} size={size} />;
}

/* ---------------- ProgressRing (kept for compatibility) ---------------- */
export function ProgressRing({
  value,
  size = 120,
  stroke = 10,
  label,
  sublabel,
}: {
  value: number;
  size?: number;
  stroke?: number;
  label?: string;
  sublabel?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (value / 100) * c;
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--pass)"
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.8s cubic-bezier(.4,0,.2,1)" }}
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-2xl font-bold">{label ?? `${value}%`}</span>
        {sublabel && <span className="text-xs text-muted">{sublabel}</span>}
      </div>
    </div>
  );
}

/* ---------------- StatBar (stacked progress bar) ---------------- */
export function StatBar({
  segments,
  total,
  height = 8,
}: {
  segments: { value: number; color: string }[];
  total?: number;
  height?: number;
}) {
  const sum = total ?? (segments.reduce((s, x) => s + x.value, 0) || 1);
  return (
    <div className="flex w-full overflow-hidden rounded-full bg-surface-3" style={{ height }} aria-hidden>
      {segments.map((s, i) => (
        <div key={i} style={{ width: `${(s.value / (sum || 1)) * 100}%`, background: s.color }} />
      ))}
    </div>
  );
}

/* ---------------- PageHeader ---------------- */
export function PageHeader({ title, sub, action }: { title: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        <h1 className="text-3xl font-bold tracking-[-0.015em]">{title}</h1>
        {sub && <p className="mt-2 text-base text-muted">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

/* ---------------- SectionTitle ---------------- */
export function SectionTitle({ children, sub, action }: { children: ReactNode; sub?: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-xl font-bold">{children}</h2>
        {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

/* ---------------- Notice: calm inline message ---------------- */
export function Notice({
  tone = "info",
  title,
  children,
  icon,
  className,
}: {
  tone?: "info" | "ok" | "warn" | "fail";
  title?: ReactNode;
  children?: ReactNode;
  icon?: IconName;
  className?: string;
}) {
  const t = {
    info: { bg: "var(--brand-soft)", border: "transparent", fg: "var(--brand-text)", ic: "info" as IconName },
    ok: { bg: "var(--pass-soft)", border: "transparent", fg: "var(--pass)", ic: "check" as IconName },
    warn: { bg: "var(--warn-soft)", border: "transparent", fg: "var(--warn)", ic: "info" as IconName },
    fail: { bg: "var(--fail-soft)", border: "var(--fail-border)", fg: "var(--fail-text)", ic: "info" as IconName },
  }[tone];
  return (
    <div className={cx("flex items-start gap-3 rounded-xl border px-4 py-3.5", className)} style={{ background: t.bg, borderColor: t.border }}>
      <Icon name={icon ?? t.ic} size={18} className="mt-0.5 shrink-0" style={{ color: t.fg }} />
      <div className="min-w-0 text-sm text-text-2">
        {title && <div className="font-bold text-text">{title}</div>}
        {children && <div className={cx(title ? "mt-0.5" : "")}>{children}</div>}
      </div>
    </div>
  );
}

/* ---------------- EmptyState ---------------- */
export function EmptyState({ icon, title, desc, action }: { icon: IconName; title: string; desc?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[var(--radius)] border border-dashed bg-surface px-6 py-16 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-3 text-muted">
        <Icon name={icon} />
      </div>
      <p className="text-lg font-bold">{title}</p>
      {desc && <p className="mt-1.5 max-w-md text-sm text-muted">{desc}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
