import type { ReactNode } from "react";

export function Alert({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-sm leading-6 text-red-800" role="alert" aria-live="polite">
      <svg className="mt-0.5 size-5 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.7" />
        <path d="M12 7.7v5.2M12 16.25v.05" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      </svg>
      <p>{children}</p>
    </div>
  );
}
