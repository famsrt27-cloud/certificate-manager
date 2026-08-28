"use client";

import type { AuthenticationData } from "@certificate-platform/contracts";
import { useEffect, useState, type ReactNode } from "react";

import { BrandMark } from "../brand-mark";
import { Button } from "../ui/button";

type Membership = AuthenticationData["memberships"][number];

type AdminShellProps = {
  readonly activeMembershipId: string | null;
  readonly children?: ReactNode;
  readonly logoutPending: boolean;
  readonly memberships: readonly Membership[];
  readonly onLogout: () => void;
  readonly onMembershipChange: (membershipId: string) => void;
  readonly userEmail: string;
};

const navigation = [
  { label: "ภาพรวม", active: true },
  { label: "โครงการ", active: false },
  { label: "การอบรม", active: false },
  { label: "ผู้เข้าร่วม", active: false },
  { label: "เทมเพลต", active: false },
  { label: "ใบประกาศนียบัตร", active: false }
] as const;

function MenuIcon({ open = false }: { readonly open?: boolean }) {
  return open ? (
    <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ) : (
    <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4.5 7h15M4.5 12h15M4.5 17h15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function OverviewIcon() {
  return (
    <svg className="size-[18px]" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4.5 4.5h6v6h-6v-6Zm9 0h6v6h-6v-6Zm-9 9h6v6h-6v-6Zm9 0h6v6h-6v-6Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function PlaceholderIcon() {
  return (
    <svg className="size-[18px]" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 6.5h14M5 12h14M5 17.5h9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function SidebarNavigation({ onNavigate }: { readonly onNavigate?: () => void }) {
  return (
    <nav className="mt-8 flex-1" aria-label="เมนูหลัก">
      <p className="px-3 text-[11px] font-semibold tracking-[0.12em] text-slate-500 uppercase">เมนูหลัก</p>
      <ul className="mt-3 space-y-1">
        {navigation.map((item) => (
          <li key={item.label}>
            {item.active ? (
              <button
                aria-current="page"
                className="flex min-h-10 w-full items-center gap-3 rounded-lg bg-blue-50 px-3 text-left text-sm font-semibold text-[#1e478c]"
                onClick={onNavigate}
                type="button"
              >
                <OverviewIcon />
                {item.label}
              </button>
            ) : (
              <button
                className="flex min-h-10 w-full cursor-not-allowed items-center gap-3 rounded-lg px-3 text-left text-sm font-medium text-slate-400"
                disabled
                title="พร้อมใช้งานในส่วนถัดไป"
                type="button"
              >
                <PlaceholderIcon />
                {item.label}
                <span className="ml-auto text-[10px] font-normal text-slate-400">เร็ว ๆ นี้</span>
              </button>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Account({ logoutPending, onLogout, userEmail }: Pick<AdminShellProps, "logoutPending" | "onLogout" | "userEmail">) {
  const initial = userEmail.trim().charAt(0).toUpperCase() || "A";
  return (
    <div className="border-t border-slate-200 pt-4">
      <div className="flex min-w-0 items-center gap-3 px-2">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-slate-200 text-sm font-semibold text-slate-700" aria-hidden="true">{initial}</span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-800">ผู้ดูแลระบบ</p>
          <p className="truncate text-xs text-slate-500" title={userEmail}>{userEmail}</p>
        </div>
      </div>
      <Button className="mt-3 w-full justify-start px-3" disabled={logoutPending} onClick={onLogout} variant="quiet">
        <svg className="size-[18px]" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M10 5H5.5v14H10M14.5 8l4 4-4 4M8.5 12h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {logoutPending ? "กำลังออกจากระบบ…" : "ออกจากระบบ"}
      </Button>
    </div>
  );
}

export function AdminShell({
  activeMembershipId,
  children,
  logoutPending,
  memberships,
  onLogout,
  onMembershipChange,
  userEmail
}: AdminShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const activeMembership = memberships.find((membership) => membership.id === activeMembershipId) ?? null;

  useEffect(() => {
    if (!mobileOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", handleEscape);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  return (
    <div className="min-h-dvh bg-[#f4f6f8] lg:pl-64">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-slate-200 bg-white px-4 py-5 lg:flex" aria-label="แถบนำทางผู้ดูแลระบบ">
        <div className="px-2"><BrandMark /></div>
        <SidebarNavigation />
        <Account logoutPending={logoutPending} onLogout={onLogout} userEmail={userEmail} />
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button className="absolute inset-0 bg-slate-950/45" aria-label="ปิดเมนู" onClick={() => setMobileOpen(false)} type="button" />
          <aside className="relative flex h-full w-[min(85vw,300px)] flex-col bg-white px-4 py-5 shadow-2xl" id="admin-mobile-navigation" aria-label="แถบนำทางผู้ดูแลระบบ">
            <div className="flex items-center justify-between gap-4 px-2">
              <BrandMark />
              <button className="grid size-10 shrink-0 place-items-center rounded-lg text-slate-600 hover:bg-slate-100" aria-label="ปิดเมนู" onClick={() => setMobileOpen(false)} type="button">
                <MenuIcon open />
              </button>
            </div>
            <SidebarNavigation onNavigate={() => setMobileOpen(false)} />
            <Account logoutPending={logoutPending} onLogout={onLogout} userEmail={userEmail} />
          </aside>
        </div>
      ) : null}

      <header className="sticky top-0 z-20 flex min-h-16 items-center border-b border-slate-200 bg-white/95 px-4 backdrop-blur-sm sm:px-6 lg:px-8">
        <button
          aria-controls="admin-mobile-navigation"
          aria-expanded={mobileOpen}
          aria-label="เปิดเมนู"
          className="mr-3 grid size-10 shrink-0 place-items-center rounded-lg text-slate-600 hover:bg-slate-100 lg:hidden"
          onClick={() => setMobileOpen(true)}
          type="button"
        >
          <MenuIcon />
        </button>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">ภาพรวม</p>
          <p className="truncate text-xs text-slate-500 sm:hidden">{activeMembership?.organization.name ?? "Certificate Platform"}</p>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-3">
          {memberships.length > 0 ? (
            <div className="hidden items-center gap-3 sm:flex">
              <label className="text-xs font-medium text-slate-500" htmlFor="active-organization">องค์กร</label>
              {memberships.length === 1 ? (
                <span className="max-w-64 truncate text-sm font-semibold text-slate-700">{activeMembership?.organization.name}</span>
              ) : (
                <select
                  className="min-h-9 max-w-64 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 focus:border-[#2557a7] focus:outline-none focus:ring-3 focus:ring-blue-100"
                  id="active-organization"
                  onChange={(event) => onMembershipChange(event.target.value)}
                  value={activeMembershipId ?? ""}
                >
                  {memberships.map((membership) => <option key={membership.id} value={membership.id}>{membership.organization.name}</option>)}
                </select>
              )}
            </div>
          ) : null}
          <span className="hidden h-6 w-px bg-slate-200 sm:block" aria-hidden="true" />
          <span className="hidden max-w-52 truncate text-xs text-slate-500 md:block" title={userEmail}>{userEmail}</span>
        </div>
      </header>

      <main className="w-full px-4 py-6 sm:px-6 sm:py-8 lg:px-8 xl:px-10" id="main-content">
        <div className="mx-auto w-full max-w-[1480px]">
          <section aria-labelledby="admin-title">
            <p className="text-sm font-semibold text-[#2557a7]">พื้นที่ทำงานผู้ดูแลระบบ</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-slate-950 sm:text-[28px]" id="admin-title">ภาพรวมระบบ</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">ติดตามและจัดการกระบวนการออกใบประกาศนียบัตรขององค์กรจากพื้นที่ทำงานนี้</p>
          </section>

          {memberships.length === 0 ? (
            <section className="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-900" role="status">
              บัญชีนี้ยังไม่มีสมาชิกองค์กรที่ใช้งานอยู่ โปรดติดต่อผู้ดูแลระบบขององค์กร
            </section>
          ) : (
            <>
              {memberships.length > 1 ? (
                <div className="mt-6 sm:hidden">
                  <label className="block text-sm font-semibold text-slate-700" htmlFor="active-organization-mobile">องค์กร</label>
                  <select
                    className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800 focus:border-[#2557a7] focus:outline-none focus:ring-3 focus:ring-blue-100"
                    id="active-organization-mobile"
                    onChange={(event) => onMembershipChange(event.target.value)}
                    value={activeMembershipId ?? ""}
                  >
                    {memberships.map((membership) => <option key={membership.id} value={membership.id}>{membership.organization.name}</option>)}
                  </select>
                </div>
              ) : null}
              <section className="mt-6 rounded-xl border border-slate-200 bg-white px-5 py-6 sm:px-6 sm:py-7" aria-labelledby="workspace-ready-title">
                <div className="flex items-start gap-4">
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-blue-50 text-[#2557a7]" aria-hidden="true"><OverviewIcon /></span>
                  <div>
                    <h2 className="text-base font-semibold text-slate-950" id="workspace-ready-title">พื้นที่ทำงานพร้อมใช้งาน</h2>
                    <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">เนื้อหาแดชบอร์ดและข้อมูลสรุปจะได้รับการพัฒนาใน Frontend Part 2 โดยไม่มีการแสดงข้อมูลตัวอย่างหรือสถิติที่ไม่ได้มาจากระบบจริง</p>
                  </div>
                </div>
              </section>
              {children ? (
                <section className="mt-8" aria-labelledby="current-tools-title">
                  <div className="mb-4 border-b border-slate-200 pb-4">
                    <h2 className="text-base font-semibold text-slate-900" id="current-tools-title">เครื่องมือจัดการปัจจุบัน</h2>
                    <p className="mt-1 text-sm text-slate-500">หน้าจอการทำงานเดิมจะได้รับการปรับรูปแบบในส่วนถัดไป</p>
                  </div>
                  {children}
                </section>
              ) : null}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
