import type { SVGProps } from "react";

type IconName =
  | "shield"
  | "dashboard"
  | "plus"
  | "list"
  | "clipboard"
  | "help"
  | "android"
  | "apple"
  | "globe"
  | "key"
  | "link"
  | "upload"
  | "terminal"
  | "sun"
  | "moon"
  | "check"
  | "x"
  | "alert"
  | "info"
  | "chevronRight"
  | "chevronDown"
  | "external"
  | "search"
  | "download"
  | "trash"
  | "arrowRight"
  | "clock"
  | "user"
  | "sparkle"
  | "filter"
  | "copy"
  | "eye"
  | "eyeOff"
  | "bell"
  | "zap"
  | "lock"
  | "refresh"
  | "home"
  | "phone"
  | "menu"
  | "sidebar"
  | "book"
  | "auto"
  | "flag"
  | "activity";

const paths: Record<IconName, React.ReactNode> = {
  shield: <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" />,
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  list: (
    <>
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <circle cx="3.5" cy="6" r="1.2" />
      <circle cx="3.5" cy="12" r="1.2" />
      <circle cx="3.5" cy="18" r="1.2" />
    </>
  ),
  clipboard: (
    <>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4a1.5 1.5 0 011.5-1.5h3A1.5 1.5 0 0115 4v1H9V4z" />
      <path d="M8.5 11l2 2 4-4" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 114 2c-1 0.7-1.5 1.2-1.5 2.5" />
      <circle cx="12" cy="17.5" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  android: (
    <>
      <path d="M6 10a1 1 0 011 1v5a1 1 0 01-2 0v-5a1 1 0 011-1zM18 10a1 1 0 011 1v5a1 1 0 01-2 0v-5a1 1 0 011-1z" fill="currentColor" stroke="none" />
      <path d="M7.5 9.5h9V16a1.5 1.5 0 01-1.5 1.5H9A1.5 1.5 0 017.5 16V9.5z" />
      <path d="M9.5 17.5V20a1 1 0 002 0v-2.5M12.5 17.5V20a1 1 0 002 0v-2.5" />
      <path d="M8 9.5a4 4 0 018 0" />
      <path d="M9 5l-1-1.5M15 5l1-1.5" />
    </>
  ),
  apple: (
    <path
      d="M16 12.5c0-2 1.6-3 1.7-3-.9-1.4-2.4-1.6-2.9-1.6-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.6-.7-1.3 0-2.6.8-3.3 2-1.4 2.5-.4 6.1 1 8.1.7 1 1.5 2.1 2.5 2 1-.1 1.4-.7 2.6-.7 1.2 0 1.5.7 2.6.6 1.1 0 1.8-1 2.4-2 .5-.7.8-1.5 1-1.7-.1 0-2.5-1-2.5-2.4zM14 6.3c.5-.6.9-1.5.8-2.3-.8 0-1.7.5-2.2 1.1-.5.5-.9 1.4-.8 2.2.9.1 1.7-.4 2.2-1z"
      fill="currentColor"
      stroke="none"
    />
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.5 3.5 6 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-6-3.5-9s1-6.5 3.5-9z" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="12" r="3.5" />
      <path d="M11.5 12H21l-2 2 2 2M15 12v3" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 005.66 0l2.5-2.5a4 4 0 00-5.66-5.66L11 7.3" />
      <path d="M14 10a4 4 0 00-5.66 0l-2.5 2.5a4 4 0 005.66 5.66L13 16.7" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V4" />
      <path d="M8 8l4-4 4 4" />
      <path d="M4 14v4a2 2 0 002 2h12a2 2 0 002-2v-4" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 019.5 4a7 7 0 100 16 8 8 0 0010.5-5.5z" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  alert: (
    <>
      <path d="M12 3l9.5 16.5H2.5L12 3z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  chevronRight: <path d="M9 6l6 6-6 6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  external: (
    <>
      <path d="M14 5h5v5" />
      <path d="M19 5l-8 8" />
      <path d="M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11" />
      <path d="M8 11l4 4 4-4" />
      <path d="M4 19h16" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2" />
      <path d="M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13" />
    </>
  ),
  arrowRight: <path d="M4 12h16M14 6l6 6-6 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.5-6 8-6s8 2 8 6" />
    </>
  ),
  sparkle: (
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
  ),
  filter: <path d="M3 5h18l-7 8v6l-4-2v-4L3 5z" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 012-2h8" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M3 3l18 18" />
      <path d="M10.6 6.2A9.7 9.7 0 0112 6c6.5 0 10 6 10 6a15 15 0 01-3.3 3.9M6.3 6.4A15 15 0 002 12s3.5 7 10 7a9.6 9.6 0 004-.9" />
      <path d="M9.5 9.6a3 3 0 004.2 4.2" />
    </>
  ),
  bell: (
    <>
      <path d="M6 9a6 6 0 0112 0c0 5 2 6 2 6H4s2-1 2-6z" />
      <path d="M10 20a2 2 0 004 0" />
    </>
  ),
  zap: <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 10-.5 4" />
      <path d="M20 5v6h-6" />
    </>
  ),
  home: (
    <>
      <path d="M4 10.5L12 4l8 6.5" />
      <path d="M6 9v10.5h12V9" />
      <path d="M10 19.5v-5h4v5" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="2.5" />
      <path d="M11 18h2" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  sidebar: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9 4v16" />
    </>
  ),
  book: (
    <>
      <path d="M5 4.5h10a2 2 0 012 2V20H7a2 2 0 01-2-2V4.5z" />
      <path d="M5 18a2 2 0 012-2h10" />
      <path d="M9 8.5h4" />
    </>
  ),
  auto: (
    <>
      <path d="M20 11.5A8 8 0 005.6 7" />
      <path d="M5 3.5v4h4" />
      <path d="M4 12.5A8 8 0 0018.4 17" />
      <path d="M19 20.5v-4h-4" />
    </>
  ),
  flag: (
    <>
      <path d="M12 6v7" />
      <path d="M12 17.5v.5" />
    </>
  ),
  activity: <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />,
};

export function Icon({
  name,
  size = 20,
  ...props
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}

export type { IconName };
