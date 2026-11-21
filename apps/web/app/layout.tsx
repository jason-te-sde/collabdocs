import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "CollabDocs", template: "%s | CollabDocs" },
  description: "Write documents together, in real time.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-indigo-800 focus:shadow-lg focus:ring-2 focus:ring-indigo-700"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
