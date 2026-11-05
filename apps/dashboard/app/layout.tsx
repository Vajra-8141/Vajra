import type { Metadata } from "next";
import { Chrome } from "../components/chrome";
import { ReadsProvider } from "../lib/reads";
import "./globals.css";

export const metadata: Metadata = {
  title: "VAJRA",
  description: "An Ethereum account with bank-account rules and a hash-based master key.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ReadsProvider>
          <Chrome>{children}</Chrome>
        </ReadsProvider>
      </body>
    </html>
  );
}
