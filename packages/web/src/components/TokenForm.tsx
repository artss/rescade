import { useState } from "react";
import { setToken } from "../token.js";

export function TokenForm({ rejected }: { rejected: boolean }) {
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(false);
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <form
        className="space-y-4 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim() !== "") setToken(value.trim(), remember);
        }}
      >
        <h1 className="text-lg font-semibold">rescade</h1>
        {rejected && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            The daemon rejected the token.
          </p>
        )}
        <label className="block text-sm">
          API token
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="mt-1 block w-full rounded border border-zinc-300 bg-transparent px-2 py-1 font-mono dark:border-zinc-700"
          />
        </label>
        <p className="text-xs text-zinc-500">The daemon reads it from RESCADE_TOKEN, RESCADE_TOKEN_FILE or /etc/rescade/token.</p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember on this device
        </label>
        <button type="submit" className="w-full rounded bg-zinc-900 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
          Sign in
        </button>
      </form>
    </main>
  );
}
