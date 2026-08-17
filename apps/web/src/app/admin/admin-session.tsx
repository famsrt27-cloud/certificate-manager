"use client";

import { AuthenticationResponseSchema, LogoutResponseSchema, type AuthenticationData } from "@certificate-platform/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const apiBasePath = process.env.NEXT_PUBLIC_API_BASE_PATH ?? "/api";

export function AdminSession() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticationData | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
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
    }).catch((reason: unknown) => {
      if (!(reason instanceof DOMException && reason.name === "AbortError")) setError(true);
    });
    return () => controller.abort();
  }, [router]);

  const logout = async () => {
    if (session === null) return;
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
    }
  };

  if (error) return <p role="alert">ไม่สามารถตรวจสอบเซสชันได้ โปรดลองอีกครั้ง</p>;
  if (session === null) return <p aria-live="polite">กำลังตรวจสอบเซสชัน…</p>;

  return (
    <section className="w-full space-y-6" aria-labelledby="admin-title">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm text-slate-500">เข้าสู่ระบบในชื่อ {session.user.email}</p>
          <h1 className="text-3xl font-semibold tracking-tight" id="admin-title">สิทธิ์การเข้าถึงองค์กร</h1>
        </div>
        <button className="rounded-lg border border-slate-300 bg-white px-4 py-2 font-medium" onClick={() => void logout()} type="button">ออกจากระบบ</button>
      </div>
      {session.memberships.length === 0 ? <p>บัญชีนี้ไม่มีสมาชิกองค์กรที่ใช้งานอยู่</p> : (
        <ul className="grid gap-4">
          {session.memberships.map((membership) => (
            <li className="rounded-xl border border-slate-200 bg-white p-5" key={membership.id}>
              <h2 className="font-semibold">{membership.organization.name}</h2>
              <p className="mt-1 text-sm text-slate-600">{membership.roles.join(", ") || "ไม่มีบทบาท"}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
