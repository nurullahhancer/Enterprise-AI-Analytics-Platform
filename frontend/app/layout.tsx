import "./styles.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Enterprise AI Analytics",
  description: "Tenant-safe AI analytics platform"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
