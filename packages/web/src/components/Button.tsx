import type { ButtonHTMLAttributes } from "react";
import { Icon } from "./Icon.js";

/** A filled button, blue or red (`danger`), with an optional `@mdi/js` icon before the text. */
export function Button({
  children,
  danger = false,
  icon,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean; icon?: string }) {
  const color = danger ? "bg-red-600 hover:bg-red-700 text-white" : "bg-sky-600 hover:bg-sky-700 text-white dark:hover:bg-sky-500";
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center gap-1.5 rounded px-3 py-1 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${color}`}
    >
      {icon !== undefined && <Icon path={icon} />}
      {children}
    </button>
  );
}
