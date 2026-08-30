"use client";

import { AuthenticationResponseSchema, LogoutResponseSchema, type AuthenticationData } from "@certificate-platform/contracts";
import { useRouter } from "next/navigation";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { AdminShell } from "../../components/admin/admin-shell";
import { AdminContextProvider } from "./admin-context";

const apiBasePath = process.env.NEXT_PUBLIC_API_BASE_PATH ?? "/api";

export function AdminSession({ children }: { readonly children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const authenticationRequired = pathname !== "/admin/login";
  const [session, setSession] = useState<AuthenticationData | null>(null);
  const [error, setError] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [activeMembershipId, setActiveMembershipId] = useState<string | null>(null);

  useEffect(() => {
    if (!authenticationRequired) return;
    const controller = new AbortController();
    void fetch(`${apiBasePath}/admin/auth/session`, {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal
    }).then(async (response) => {
      const parsed = AuthenticationResponseSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) {
        router.replace("/admin/login");
        return;
      }
      setSession(parsed.data.data);
      setActiveMembershipId((current) => current ?? parsed.data.data.memberships[0]?.id ?? null);
    }).catch((reason: unknown) => {
      if (!(reason instanceof DOMException && reason.name === "AbortError")) setError(true);
    });
    return () => controller.abort();
  }, [authenticationRequired, router]);

  const logout = async () => {
    if (session === null || logoutPending) return;
    setLogoutPending(true);
    try {
      const response = await fetch(`${apiBasePath}/admin/auth/logout`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-CSRF-Token": session.csrf_token }
      });
      const parsed = LogoutResponseSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error("logout failed");
      router.replace("/admin/login");
    } catch {
      setError(true);
      setLogoutPending(false);
    }
  };

  if (!authenticationRequired) return children;
  if (error) return (
    <main className="grid min-h-dvh place-items-center bg-[#f4f6f8] px-5">
      <div className="w-full max-w-md rounded-xl border border-red-200 bg-white p-6 text-center shadow-sm" role="alert">
        <h1 className="text-lg font-semibold text-slate-950">ไม่สามารถเปิดพื้นที่ทำงานได้</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">ไม่สามารถตรวจสอบเซสชันได้ โปรดลองอีกครั้ง</p>
      </div>
    </main>
  );
  if (session === null) return (
    <main className="grid min-h-dvh place-items-center bg-[#f4f6f8] px-5" aria-live="polite">
      <div className="flex items-center gap-3 text-sm font-medium text-slate-600">
        <span className="size-5 animate-spin rounded-full border-2 border-slate-300 border-t-[#2557a7]" aria-hidden="true" />
        กำลังตรวจสอบเซสชัน…
      </div>
    </main>
  );

  const activeMembership = session.memberships.find((membership) => membership.id === activeMembershipId) ?? null;

  return (
    <AdminShell activeMembershipId={activeMembershipId} logoutPending={logoutPending} memberships={session.memberships}
      onLogout={() => void logout()} onMembershipChange={setActiveMembershipId} userEmail={session.user.email}>
      {activeMembership === null ? null : (
        <AdminContextProvider value={{ session, membership: activeMembership }}>
          <div key={activeMembership.id}>{children}</div>
        </AdminContextProvider>
      )}
    </AdminShell>
  );
}
