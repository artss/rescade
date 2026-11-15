export function ErrorBox({ error }: { error: unknown }) {
  const text = error instanceof Error ? error.message : String(error);
  return (
    <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
      {text}
    </p>
  );
}
