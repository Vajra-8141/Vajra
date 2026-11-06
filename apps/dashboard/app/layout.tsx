import type { Metadata, Viewport } from "next";
import { Chrome } from "../components/chrome";
import { AccountProvider } from "../lib/account";
import { ReadsProvider } from "../lib/reads";
import { geist, geistMono } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "VAJRA",
  description: "Keep your wallet. We put a bank around it, and the vault key is one a quantum computer can't break.",
};

export const viewport: Viewport = { themeColor: "#0a0c1b" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body>
        <ReadsProvider>
          <AccountProvider>
            <Chrome>{children}</Chrome>
          </AccountProvider>
        </ReadsProvider>
      </body>
    </html>
  );
}
