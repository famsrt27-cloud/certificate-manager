import Link from "next/link";

const links = [
  { href: "/", label: "หน้าแรก" },
  { href: "/verify", label: "ค้นหาใบประกาศ" },
  { href: "/admin/login", label: "สำหรับผู้ดูแลระบบ" }
] as const;

export function PublicHeader({ current }: Readonly<{ current: "/" | "/verify" }>) {
  return (
    <header className="relative z-20 border-b border-[#d9ddd7]/90 bg-[#f7f5ef]/95 backdrop-blur">
      <div className="mx-auto flex min-h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link className="flex min-h-11 items-center gap-2.5 rounded-lg text-[#173f3b] focus-visible:outline-offset-4" href="/">
          <span className="grid size-9 place-items-center rounded-full border border-[#8dad9f] bg-[#e8f0eb] text-xs font-semibold" aria-hidden="true">CP</span>
          <span className="hidden font-semibold sm:inline">Certificate Platform</span>
          <span className="font-semibold sm:hidden">CP</span>
        </Link>
        <nav aria-label="เมนูสาธารณะ">
          <ul className="flex items-center gap-1 sm:gap-2">
            {links.map((link) => (
              <li key={link.href}>
                <Link aria-current={current === link.href ? "page" : undefined}
                  className={`inline-flex min-h-11 items-center rounded-lg px-2.5 text-sm font-medium transition sm:px-3.5 ${
                    current === link.href ? "bg-[#e5eee8] text-[#174f46]" : "text-[#52615d] hover:bg-white/80 hover:text-[#193e39]"
                  }`} href={link.href}>
                  <span className={link.href === "/admin/login" ? "hidden sm:inline" : undefined}>{link.label}</span>
                  {link.href === "/admin/login" ? <span className="sm:hidden">ผู้ดูแล</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </header>
  );
}
