import type { Metadata } from "next";
import { Geist, Geist_Mono, Fraunces } from "next/font/google";
import "./globals.css";
import { StorageQuotaGuard } from "@/components/StorageQuotaGuard";
import { LibraryBackup } from "@/components/LibraryBackup";
import { QueueRunner } from "@/components/queue/QueueRunner";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

const fraunces = Fraunces({
  variable: "--font-serif",
  subsets: ["latin"],
  axes: ["opsz"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "MyStoriesLena — Gerador de Roteiros",
  description:
    "Fluxo em 5 etapas com agentes especializados para criar roteiros de romance dark, máfia e milionário.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="pt-BR"
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {children}
        <StorageQuotaGuard />
        <LibraryBackup />
        <QueueRunner />
      </body>
    </html>
  );
}
