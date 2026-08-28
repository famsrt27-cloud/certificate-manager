type BrandMarkProps = {
  readonly compact?: boolean;
  readonly inverse?: boolean;
};

export function BrandMark({ compact = false, inverse = false }: BrandMarkProps) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${inverse ? "bg-white/10 text-white ring-1 ring-white/15" : "bg-[#2557a7] text-white"}`} aria-hidden="true">
        <svg className="size-5" viewBox="0 0 24 24" fill="none">
          <path d="M7 3.75h7.8L18.5 7.5v12.75H7V3.75Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          <path d="M14.5 3.9v3.9h3.8M9.7 11.1h6.1M9.7 14h4.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          <path d="m13.4 18.8 1.25 1.15 1.25-1.15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </span>
      {compact ? null : (
        <span className="min-w-0">
          <span className={`block truncate text-[15px] font-semibold leading-5 ${inverse ? "text-white" : "text-slate-950"}`}>Certificate Platform</span>
          <span className={`block truncate text-xs leading-5 ${inverse ? "text-slate-300" : "text-slate-500"}`}>ระบบจัดการใบประกาศนียบัตร</span>
        </span>
      )}
    </div>
  );
}
