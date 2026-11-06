import type { Metadata } from "next";
import { Chrome } from "../components/chrome";
import { AccountProvider } from "../lib/account";
import { ReadsProvider } from "../lib/reads";
import "./globals.css";

export const metadata: Metadata = {
  title: "VAJRA",
  description: "Keep your wallet. A stolen key gets a daily limit, and a hash key outranks it.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
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
