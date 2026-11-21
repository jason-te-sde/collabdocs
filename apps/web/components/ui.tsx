import type { ButtonHTMLAttributes, ReactNode } from "react";

const focus =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-700 focus-visible:ring-offset-2";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
};

export function Button({ variant = "secondary", className = "", type, ...props }: ButtonProps) {
  const styles = {
    primary: "bg-indigo-700 text-white hover:bg-indigo-800 border-transparent",
    secondary: "bg-white text-slate-900 hover:bg-slate-100 border-slate-400",
    danger: "bg-white text-red-800 hover:bg-red-50 border-red-700",
  }[variant];
  return (
    <button
      type={type ?? "button"}
      className={`inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60 ${styles} ${focus} ${className}`}
      {...props}
    />
  );
}

export const inputClass = `block w-full rounded-md border border-slate-500 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-600 ${focus}`;

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm font-medium text-red-800">
      {children}
    </p>
  );
}
