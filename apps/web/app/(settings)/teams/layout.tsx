import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Teams",
  description: "Manage your webhook testing teams.",
  alternates: { canonical: null },
  openGraph: { title: "Teams", description: "Manage your webhook testing teams." },
  robots: { index: false, follow: false },
};

export default function TeamsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
