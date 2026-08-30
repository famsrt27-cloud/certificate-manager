"use client";

import type { AuthenticationData } from "@certificate-platform/contracts";
import { createContext, useContext } from "react";

type Membership = AuthenticationData["memberships"][number];

export interface AdminContextValue {
  readonly session: AuthenticationData;
  readonly membership: Membership;
}

const AdminContext = createContext<AdminContextValue | null>(null);

export const AdminContextProvider = AdminContext.Provider;

export function useAdminContext(): AdminContextValue {
  const context = useContext(AdminContext);
  if (context === null) throw new Error("Admin context is unavailable outside the authenticated admin layout");
  return context;
}
