import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Certificate Management Platform",
    template: "%s | Certificate Management Platform"
  },
  description: "ระบบบริหารจัดการโครงการ การอบรม ผู้เข้าร่วม และใบประกาศนียบัตร",
  robots: {
    index: false,
    follow: false,
    nocache: true
  }
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
