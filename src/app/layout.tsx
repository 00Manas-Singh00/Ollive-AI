import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LLM Logging Chatbot",
  description: "Lightweight inference logging and ingestion demo",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
