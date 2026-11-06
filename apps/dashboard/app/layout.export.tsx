import type { Metadata } from "next";
import { Mark } from "../components/mark";
import { geist, geistMono } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "VAJRA proof record",
  description: "Recorded runs of VAJRA, each labelled with where it happened. Read-only.",
};

/** The root of the static export: see `pnpm export:proof`. No bridge, no wallet, no chain reads. */
export default function ExportLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body>
        <header className="top static">
          <span className="mark">
            <Mark />
            VAJRA
          </span>
        </header>
        <div className="shell static">{children}</div>
      </body>
    </html>
  );
}
