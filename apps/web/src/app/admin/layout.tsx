import type { ReactNode } from "react";

import { AdminSession } from "./admin-session";

export default function AdminLayout({ children }: { readonly children: ReactNode }) {
  return <AdminSession>{children}</AdminSession>;
}
