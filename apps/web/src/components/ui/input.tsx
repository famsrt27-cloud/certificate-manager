import type { InputHTMLAttributes } from "react";

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  readonly invalid?: boolean;
};

export function Input({ className = "", invalid = false, ...props }: InputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={`min-h-11 w-full rounded-lg border bg-white px-3.5 py-2.5 text-base text-slate-950 shadow-[0_1px_2px_rgba(16,24,40,0.04)] placeholder:text-slate-400 hover:border-slate-400 focus:border-[#2557a7] focus:outline-none focus:ring-3 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500 ${invalid ? "border-red-400" : "border-slate-300"} ${className}`}
      {...props}
    />
  );
}
