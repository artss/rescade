/** A Material Design icon (a path of `@mdi/js`); decorative unless it has a `label`. */
export function Icon({ path, label, className = "size-4" }: { path: string; label?: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`shrink-0 fill-current ${className}`}
      {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
    >
      {label !== undefined && <title>{label}</title>}
      <path d={path} />
    </svg>
  );
}
