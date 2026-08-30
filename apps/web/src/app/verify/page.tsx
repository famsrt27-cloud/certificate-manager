import type { Metadata } from "next";

import { PublicVerificationClient } from "./public-verification-client";

export const metadata: Metadata = {
  title: "ตรวจสอบใบประกาศ",
  description: "ตรวจสอบสถานะและดาวน์โหลดใบประกาศสาธารณะอย่างปลอดภัย",
  referrer: "no-referrer",
  robots: { index: false, follow: false, nocache: true }
};

export default function PublicVerificationPage() {
  return <PublicVerificationClient />;
}
