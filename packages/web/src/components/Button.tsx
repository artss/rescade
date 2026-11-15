import type { ButtonHTMLAttributes } from "react";

export function Button({ children, danger = false, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  const color = danger
    ? "bg-red-600 hover:bg-red-700 text-white"
    : "bg-zinc-900 hover:bg-zinc-700 text-white dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
  return (
    <button
      type="button"
      {...props}
      className={`rounded px-3 py-1 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${color}`}
    >
      {children}
    </button>
  );
}
