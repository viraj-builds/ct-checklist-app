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
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return (
    <div
      className={cx(
        "rounded-[var(--radius)] border bg-surface shadow-[var(--shadow-sm)]",
        hover && "transition hover:shadow-[var(--shadow-md)] hover:-translate-y-0.5",
        className,
      )}
      style={{ borderColor: "var(--border)" }}
    >
      {children}
    </div>
  );
}

/* ---------------- Button ---------------- */
type BtnProps = {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger" | "subtle";
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
    "inline-flex items-center justify-center gap-2 font-medium rounded-xl transition select-none whitespace-nowrap disabled:opacity-50 disabled:pointer-events-none";
  const sizes = {
    sm: "text-[13px] px-3 py-1.5",
    md: "text-sm px-4 py-2.5",
    lg: "text-[15px] px-5 py-3",
  }[size];
  const variants = {
    primary:
      "bg-brand text-brand-fg hover:bg-brand-hover shadow-[var(--shadow-sm)]",
    secondary:
      "bg-surface border border-[var(--border-strong)] text-text hover:bg-surface-2",
    subtle: "bg-surface-2 text-text hover:bg-surface-3",
    ghost: "text-muted hover:bg-surface-2 hover:text-text",
    danger: "bg-[var(--fail)] text-white hover:opacity-90",
  }[variant];
  const cls = cx(base, sizes, variants, full && "w-full", className);
  const inner = (
    <>
      {icon && <Icon name={icon} size={size === "sm" ? 15 : 17} />}
      {children}
      {iconRight && <Icon name={iconRight} size={size === "sm" ? 15 : 17} />}
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
  const tones: Record<string, string> = {
    neutral: "bg-surface-2 text-muted",
    brand: "bg-brand-soft text-brand",
    accent: "text-accent",
    success: "text-[var(--pass)]",
    warn: "text-[var(--warn)]",
    danger: "text-[var(--fail)]",
  };
  const softBg: Record<string, string> = {
    accent: "var(--accent-soft)",
    success: "var(--pass-soft)",
    warn: "var(--warn-soft)",
    danger: "var(--fail-soft)",
  };
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
        tones[tone],
        className,
      )}
      style={softBg[tone] ? { background: softBg[tone] } : undefined}
    >
      {children}
    </span>
  );
}

/* ---------------- StatusBadge ---------------- */
export function StatusBadge({
  status,
  size = "md",
}: {
  status: ItemStatus;
  size?: "sm" | "md";
}) {
  const m = STATUS_META[status];
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full font-semibold",
        size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
      )}
      style={{ background: m.soft, color: m.token }}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: m.token }}
      />
      {m.label}
    </span>
  );
}

/* ---------------- MethodBadge ---------------- */
export function MethodBadge({ method }: { method: CheckMethod }) {
  const m = METHOD_META[method];
  const tone =
    method === "manual"
      ? "var(--manual)"
      : method === "hybrid"
        ? "var(--warn)"
        : "var(--accent)";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide"
      style={{ color: tone, borderColor: "var(--border)" }}
      title={m.desc}
    >
      {m.short}
    </span>
  );
}

/* ---------------- PlatformIcon ---------------- */
export function PlatformIcon({
  platform,
  size = 18,
}: {
  platform: Platform;
  size?: number;
}) {
  const name = PLATFORM_META[platform].icon as IconName;
  return <Icon name={name} size={size} />;
}

/* ---------------- ProgressRing ---------------- */
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
  const color =
    value >= 80 ? "var(--pass)" : value >= 50 ? "var(--warn)" : "var(--fail)";
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--surface-3)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.8s cubic-bezier(.4,0,.2,1)" }}
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-2xl font-bold" style={{ color }}>
          {label ?? `${value}%`}
        </span>
        {sublabel && <span className="text-[11px] text-muted">{sublabel}</span>}
      </div>
    </div>
  );
}

/* ---------------- StatBar (mini stacked bar) ---------------- */
export function StatBar({
  segments,
}: {
  segments: { value: number; color: string }[];
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-3">
      {segments.map((s, i) => (
        <div
          key={i}
          style={{ width: `${(s.value / total) * 100}%`, background: s.color }}
        />
      ))}
    </div>
  );
}

/* ---------------- SectionTitle ---------------- */
export function SectionTitle({
  children,
  sub,
  action,
}: {
  children: ReactNode;
  sub?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{children}</h2>
        {sub && <p className="mt-0.5 text-sm text-muted">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

/* ---------------- EmptyState ---------------- */
export function EmptyState({
  icon,
  title,
  desc,
  action,
}: {
  icon: IconName;
  title: string;
  desc?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[var(--radius)] border border-dashed py-16 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-muted">
        <Icon name={icon} />
      </div>
      <p className="font-medium">{title}</p>
      {desc && <p className="mt-1 max-w-sm text-sm text-muted">{desc}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
