import type { Metadata } from "next";
import { Noto_Sans_Thai_Looped } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const productFont = Noto_Sans_Thai_Looped({
  subsets: ["thai", "latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-product"
});

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
    <html className={productFont.variable} lang="th">
      <body className={productFont.className}>{children}</body>
    </html>
  );
}
