import type { ButtonHTMLAttributes } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: "primary" | "secondary" | "quiet";
};

const variants = {
  primary: "bg-[#2557a7] text-white hover:bg-[#1e478c] disabled:hover:bg-[#2557a7]",
  secondary: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:hover:bg-white",
  quiet: "text-slate-600 hover:bg-slate-100 hover:text-slate-950 disabled:hover:bg-transparent"
};

export function Button({ className = "", type = "button", variant = "primary", ...props }: ButtonProps) {
  return (
    <button
      className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${variants[variant]} ${className}`}
      type={type}
      {...props}
    />
  );
}
