import type { Metadata } from "next";

import { PublicVerificationClient } from "./public-verification-client";

export const metadata: Metadata = {
  title: "Verify certificate",
  description: "Public certificate verification",
  referrer: "no-referrer",
  robots: { index: false, follow: false, nocache: true }
};

export default function PublicVerificationPage() {
  return <PublicVerificationClient />;
}
