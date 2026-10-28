import type { Metadata } from "next";
import "./globals.css";
import { TopBar } from "@/components/TopBar";

export const metadata: Metadata = {
  title: "PR Reviewer",
  description: "Visual, AI-assisted risk review for GitHub pull requests",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <TopBar />
        <main style={{ maxWidth: 1400, margin: "0 auto", padding: "22px 24px 80px" }}>{children}</main>
      </body>
    </html>
  );
}
