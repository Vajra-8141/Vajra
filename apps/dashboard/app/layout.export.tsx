import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VAJRA proof record",
  description: "Recorded runs of VAJRA, each labelled with where it happened. Read-only.",
};

/** The root of the static export: see `pnpm export:proof`. No bridge, no wallet, no chain reads. */
export default function ExportLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <div className="top-inner">
            <span className="mark">
              <span className="mark-deva" lang="sa">
                वज्र
              </span>
              <span className="mark-latin">VAJRA</span>
            </span>
          </div>
        </header>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
