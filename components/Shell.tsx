"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Icon, type IconName } from "./Icon";
import { ThemeToggle } from "./ThemeToggle";
import { cx } from "@/lib/format";

const NAV: { href: string; label: string; icon: IconName }[] = [
  { href: "/", label: "Dashboard", icon: "dashboard" },
  { href: "/new", label: "New Audit", icon: "plus" },
  { href: "/audits", label: "All Audits", icon: "list" },
  { href: "/checklist", label: "Checklist", icon: "clipboard" },
  { href: "/faq", label: "FAQ & Fixes", icon: "help" },
];

function NavLink({
  href,
  label,
  icon,
  active,
  onClick,
}: {
  href: string;
  label: string;
  icon: IconName;
  active: boolean;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={cx(
        "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition",
        active
          ? "bg-brand-soft text-brand"
          : "text-muted hover:bg-surface-2 hover:text-text",
      )}
    >
      <Icon name={icon} size={18} />
      {label}
    </Link>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <div className="flex min-h-full">
      {/* Sidebar (desktop) */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r bg-surface px-3 py-4 md:flex">
        <Brand />
        <nav className="mt-6 flex flex-col gap-1">
          {NAV.map((n) => (
            <NavLink key={n.href} {...n} active={isActive(n.href)} />
          ))}
        </nav>
        <div className="mt-auto">
          <ModeHint />
          <UserChip />
        </div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/40 animate-fade-in" />
          <aside className="absolute left-0 top-0 h-full w-64 border-r bg-surface px-3 py-4 animate-fade-in-up">
            <Brand />
            <nav className="mt-6 flex flex-col gap-1">
              {NAV.map((n) => (
                <NavLink
                  key={n.href}
                  {...n}
                  active={isActive(n.href)}
                  onClick={() => setOpen(false)}
                />
              ))}
            </nav>
          </aside>
        </div>
      )}

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-surface/80 px-4 backdrop-blur md:px-8">
          <button
            className="flex h-9 w-9 items-center justify-center rounded-xl text-muted hover:bg-surface-2 md:hidden"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
          >
            <Icon name="list" size={20} />
          </button>
          <div className="relative hidden max-w-md flex-1 sm:block">
            <Icon
              name="search"
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-2"
            />
            <input
              placeholder="Search audits, checklist items…"
              className="w-full rounded-xl border bg-surface-2 py-2 pl-9 pr-3 text-sm outline-none placeholder:text-muted-2 focus:bg-surface"
            />
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Link
              href="/faq"
              className="hidden h-9 items-center gap-2 rounded-xl px-3 text-sm text-muted transition hover:bg-surface-2 hover:text-text sm:flex"
            >
              <Icon name="help" size={17} /> Help
            </Link>
            <ThemeToggle />
            <Link
              href="/new"
              className="ml-1 inline-flex items-center gap-2 rounded-xl bg-brand px-3.5 py-2 text-sm font-medium text-brand-fg transition hover:bg-brand-hover"
            >
              <Icon name="plus" size={16} /> New Audit
            </Link>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8 md:py-8">
          {children}
        </main>
        <footer className="border-t px-4 py-4 text-center text-xs text-muted-2 md:px-8">
          Integration Audit · Internal prototype · Frontend preview (mock data —
          no live analysis yet)
        </footer>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-2">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-brand-fg shadow-[var(--shadow-sm)]">
        <Icon name="shield" size={20} />
      </span>
      <div className="leading-tight">
        <div className="text-[15px] font-semibold tracking-tight">CT Audit</div>
        <div className="text-[11px] text-muted">Integration checker</div>
      </div>
    </Link>
  );
}

function UserChip() {
  return (
    <div className="mt-3 flex items-center gap-2.5 rounded-xl border bg-surface-2 px-3 py-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-accent">
        <Icon name="user" size={16} />
      </span>
      <div className="min-w-0 leading-tight">
        <div className="truncate text-xs font-medium">you@clevertap.com</div>
        <div className="text-[11px] text-muted">Engineer</div>
      </div>
    </div>
  );
}

function ModeHint() {
  return (
    <div className="mb-2 rounded-xl border border-dashed px-3 py-2.5 text-[11px] leading-relaxed text-muted">
      <span className="font-medium text-text">Preview build.</span> UI only —
      backend & real analysis are pending sign-off.
    </div>
  );
}
