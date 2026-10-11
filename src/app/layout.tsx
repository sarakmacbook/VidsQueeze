import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "VidSqueeze – Telegram iPhone video compressor",
  description:
    "Setup a Telegram bot that automatically re-encodes iPhone (HEVC/MOV) videos down to a target file size.",
};

const NAV = [
  { href: "/", label: "Dashboard", icon: "▤" },
  { href: "/setup", label: "Setup wizard", icon: "⚙" },
  { href: "/test", label: "Test bench", icon: "▶" },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen text-slate-200 antialiased">
        <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-4 pb-16 pt-5 sm:px-6">
          <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <Link href="/" className="group flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400 to-emerald-400 text-xl shadow-lg shadow-cyan-500/20">
                🎬
              </span>
              <span>
                <span className="block text-lg font-black tracking-tight text-white">
                  Vid<span className="grad-text">Squeeze</span>
                </span>
                <span className="block text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">
                  Telegram video compressor
                </span>
              </span>
            </Link>
            <nav className="flex flex-wrap gap-2">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-lg border border-white/10 bg-white/5 px-3.5 py-2 text-sm font-medium text-slate-300 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-white"
                >
                  <span className="mr-1.5 text-xs opacity-70">{item.icon}</span>
                  {item.label}
                </Link>
              ))}
            </nav>
          </header>
          <main className="flex-1">{children}</main>
          <footer className="mt-14 border-t border-white/5 pt-5 text-xs text-slate-600">
            ffmpeg two-pass encoder · Telegram Bot API · Next.js + Postgres (Drizzle)
          </footer>
        </div>
      </body>
    </html>
  );
}
