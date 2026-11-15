import type { ReactNode } from "react";
import { Link } from "wouter";

export function RunLink({ id, children }: { id: number; children?: ReactNode }) {
  return (
    <Link href={`/runs/${id}`} className="text-sky-700 hover:underline dark:text-sky-400">
      {children ?? `run ${id}`}
    </Link>
  );
}
