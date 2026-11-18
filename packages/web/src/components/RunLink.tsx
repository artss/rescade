import type { ReactNode } from "react";
import { Link } from "wouter";

export function RunLink({ id, children }: { id: number; children?: ReactNode }) {
  return (
    <Link href={`/runs/${id}`} className="text-accent hover:underline">
      {children ?? `run ${id}`}
    </Link>
  );
}
