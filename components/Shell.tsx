"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "./Icon";
import { ThemeToggle } from "./ThemeToggle";
import { cx } from "@/lib/format";

const NAV: { href: string; label: string; icon: IconName }[] = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/new", label: "New audit", icon: "plus" },
  { href: "/audits", label: "My audits", icon: "list" },
  { href: "/checklist", label: "What we check", icon: "clipboard" },
  { href: "/faq", label: "Help & fixes", icon: "help" },
];

// Sidebar width: compact icon rail on every page load, drag the right edge to
// widen it. Narrower than SNAP snaps back to the icon rail. The width lasts
// while moving between pages but resets on refresh.
const RAIL = 76;
const MIN_OPEN = 200;
const MAX = 400;
const SNAP = 150;
const DEFAULT_OPEN = 248;
const settle = (w: number) => (w < SNAP ? RAIL : Math.min(MAX, Math.max(MIN_OPEN, Math.round(w))));

function NavLink({
  href,
  label,
  icon,
  active,
  expanded,
  onClick,
}: {
  href: string;
  label: string;
  icon: IconName;
  active: boolean;
  expanded: boolean;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      title={expanded ? undefined : label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cx(
        "group relative flex min-h-11 items-center gap-3 rounded-xl text-[15px] font-semibold transition-colors",
        expanded ? "px-3" : "justify-center px-0",
        active ? "bg-brand-soft text-brand-text" : "text-muted hover:bg-surface-2 hover:text-text",
      )}
    >
      <Icon name={icon} size={20} className="shrink-0" />
      {expanded && <span className="truncate">{label}</span>}
      {!expanded && (
        <span className="pointer-events-none absolute left-full z-50 ml-3 hidden whitespace-nowrap rounded-lg bg-[var(--text)] px-2.5 py-1.5 text-xs font-semibold text-[var(--surface)] shadow-[var(--shadow-md)] group-hover:block">
          {label}
        </span>
      )}
    </Link>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [savedWidth, setSavedWidth] = useState(RAIL);
  const [lastOpen, setLastOpen] = useState(DEFAULT_OPEN);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? savedWidth;
  const expanded = width >= SNAP;
  const writeNav = (w: number) => {
    setSavedWidth(w);
    if (w >= MIN_OPEN) setLastOpen(w);
  };
  const toggle = () => writeNav(expanded ? RAIL : lastOpen);

  function startDrag(e: React.PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let w = startW;
    const prev = { cursor: document.body.style.cursor, select: document.body.style.userSelect };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => {
      w = Math.min(MAX, Math.max(RAIL, startW + ev.clientX - startX));
      setDragWidth(w);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = prev.cursor;
      document.body.style.userSelect = prev.select;
      setDragWidth(null);
      writeNav(settle(w));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function resizeByKey(e: React.KeyboardEvent) {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === "ArrowRight") writeNav(settle(Math.max(width, SNAP) + step));
    else if (e.key === "ArrowLeft") writeNav(settle(width - step));
    else if (e.key === "Enter" || e.key === " ") toggle();
    else return;
    e.preventDefault();
  }

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  // The sign-in page renders without the app chrome.
  if (pathname === "/login") return <>{children}</>;

  return (
    <div className="flex min-h-full">
      {/* Sidebar (desktop) */}
      <aside
        className={cx("sticky top-0 hidden h-screen shrink-0 flex-col border-r bg-surface px-3 py-4 md:flex", dragWidth !== null && "overflow-hidden")}
        style={{ width: dragWidth ?? (expanded ? Math.max(width, MIN_OPEN) : RAIL) }}
      >
        {/* drag handle on the right edge */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin={RAIL}
          aria-valuemax={MAX}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          title="Drag to resize · double-click to collapse or expand"
          onPointerDown={startDrag}
          onDoubleClick={toggle}
          onKeyDown={resizeByKey}
          className="group absolute -right-1.5 top-0 z-20 h-full w-3 cursor-col-resize touch-none outline-none"
        >
          <span
            className={cx(
              "absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 transition-colors group-hover:bg-brand group-focus-visible:bg-brand",
              dragWidth !== null ? "bg-brand" : "bg-transparent",
            )}
          />
        </div>
        <div className={cx("flex items-center gap-1", expanded ? "justify-between" : "flex-col gap-3")}>
          <Brand expanded={expanded} />
          <button
            onClick={toggle}
            aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
            aria-expanded={expanded}
            title={expanded ? "Collapse sidebar" : "Expand sidebar"}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            <Icon name="sidebar" size={20} />
          </button>
        </div>
        <nav className="mt-5 flex flex-col gap-1 border-t pt-5" aria-label="Main">
          {NAV.map((n) => (
            <NavLink key={n.href} {...n} expanded={expanded} active={isActive(n.href)} />
          ))}
        </nav>
        <div className="mt-auto">
          <UserChip expanded={expanded} />
        </div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/40 animate-fade-in" />
          <aside className="absolute left-0 top-0 flex h-full w-64 flex-col border-r bg-surface px-3 py-4 animate-fade-in-up">
            <Brand expanded />
            <nav className="mt-6 flex flex-col gap-1">
              {NAV.map((n) => (
                <NavLink key={n.href} {...n} expanded active={isActive(n.href)} onClick={() => setOpen(false)} />
              ))}
            </nav>
            <div className="mt-auto">
              <UserChip expanded />
            </div>
          </aside>
        </div>
      )}

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b bg-surface/90 px-4 backdrop-blur md:px-8">
          <button
            className="flex h-11 w-11 items-center justify-center rounded-xl text-muted hover:bg-surface-2 md:hidden"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
          >
            <Icon name="menu" size={22} />
          </button>
          <span className="whitespace-nowrap text-base font-bold md:hidden">Integration Audit</span>
          <div className="ml-auto flex items-center gap-1.5">
            <Link
              href="/faq"
              className="hidden min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-text sm:flex"
            >
              <Icon name="help" size={18} /> Help
            </Link>
            <ThemeToggle />
            {pathname !== "/new" && (
              <Link
                href="/new"
                aria-label="New audit"
                className="ml-1 inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-xl bg-brand px-3 text-sm font-bold text-brand-fg transition-colors hover:bg-brand-hover sm:px-4"
              >
                <Icon name="plus" size={18} /> <span className="hidden sm:inline">New audit</span>
              </Link>
            )}
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 md:px-8 md:py-10">{children}</main>
      </div>
    </div>
  );
}

function Brand({ expanded }: { expanded: boolean }) {
  return (
    <Link href="/" className={cx("flex min-h-11 min-w-0 items-center gap-2.5", expanded ? "pl-1" : "justify-center")} aria-label="Integration Audit home">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--text)] text-[var(--surface)]">
        <Icon name="check" size={20} strokeWidth={2.6} />
      </span>
      {expanded && (
        <span className="leading-tight">
          <span className="block text-base font-bold">Integration Audit</span>
          <span className="block text-xs text-muted">for CleverTap</span>
        </span>
      )}
    </Link>
  );
}

function UserChip({ expanded }: { expanded: boolean }) {
  const [user, setUser] = useState<{ email: string; isStaff: boolean } | null>(null);
  useEffect(() => {
    fetch("/api/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setUser(j?.user ?? null))
      .catch(() => {});
  }, []);

  async function signOut() {
    await fetch("/api/me", { method: "DELETE" }).catch(() => {});
    window.location.href = "/login";
  }

  const initial = user?.email?.[0]?.toUpperCase() ?? "";

  if (!expanded)
    return (
      <div className="flex justify-center" title={user ? `${user.email} — ${user.isStaff ? "CleverTap engineer" : "Customer"}` : undefined}>
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-soft text-sm font-bold text-brand-text">
          {initial || <Icon name="user" size={16} />}
        </span>
      </div>
    );

  return (
    <div className="flex items-center gap-2.5 rounded-xl border bg-surface-2 px-3 py-2.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-bold text-brand-text">
        {initial || <Icon name="user" size={16} />}
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-sm font-semibold">{user?.email ?? "…"}</div>
        <div className="text-xs text-muted">{user ? (user.isStaff ? "CleverTap engineer" : "Customer") : ""}</div>
      </div>
      {user && (
        <button onClick={signOut} className="shrink-0 rounded-lg px-1.5 py-1 text-xs font-semibold text-muted hover:text-text" title="Sign out">
          Sign out
        </button>
      )}
    </div>
  );
}
