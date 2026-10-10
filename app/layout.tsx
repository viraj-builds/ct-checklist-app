import type { Metadata } from "next";
import { Atkinson_Hyperlegible_Next, Atkinson_Hyperlegible_Mono } from "next/font/google";
import "./globals.css";
import { Shell } from "@/components/Shell";
import { themeInitScript } from "@/components/ThemeToggle";

// Atkinson Hyperlegible is designed for readability: open letter shapes and
// clearly different characters (Il1, O0), which matters for IDs and passcodes.
const sans = Atkinson_Hyperlegible_Next({
  variable: "--font-sans-app",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  // Next.js has no metrics for this newer font, so it can't build a
  // size-matched fallback. Use a plain system fallback instead of warning.
  adjustFontFallback: false,
  fallback: ["system-ui", "Segoe UI", "Arial", "sans-serif"],
});

const mono = Atkinson_Hyperlegible_Mono({
  variable: "--font-mono-app",
  subsets: ["latin"],
  weight: ["400", "500"],
  adjustFontFallback: false,
  fallback: ["ui-monospace", "Consolas", "monospace"],
});

export const metadata: Metadata = {
  title: "CT Integration Audit",
  description:
    "Audit whether an app or website has correctly integrated CleverTap — SDK, events, profiles, push and data quality.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-full">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
