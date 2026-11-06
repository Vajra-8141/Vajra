import localFont from "next/font/local";

/** Self-hosted, and shared with the extension and the phone. Nothing is fetched from a font service, at build or at run time. */
export const geist = localFont({ src: "../../../packages/shared/ui/fonts/Geist-Variable.woff2", weight: "100 900", variable: "--font-geist", display: "swap" });
export const geistMono = localFont({ src: "../../../packages/shared/ui/fonts/GeistMono-Variable.woff2", weight: "100 900", variable: "--font-geist-mono", display: "swap", preload: false });
