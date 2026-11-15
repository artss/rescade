import { useSyncExternalStore } from "react";

const KEY = "rescade.token";

export interface Auth {
  token: string | null;
  /** The daemon refused the token that was set. */
  rejected: boolean;
}

let auth: Auth = { token: read(), rejected: false };
const listeners = new Set<() => void>();

// storage can be unavailable (private mode, blocked site data): the token then lives until the page reloads
function read(): string | null {
  try {
    return sessionStorage.getItem(KEY) ?? localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  return auth.token;
}

/** Keeps the token for this tab, or across browser restarts with `remember`. */
export function setToken(token: string, remember = false): void {
  try {
    forget();
    (remember ? localStorage : sessionStorage).setItem(KEY, token);
  } catch {
    // kept in memory only
  }
  update({ token, rejected: false });
}

/** Drops the token; `rejected` when the daemon answered 401. */
export function clearToken(rejected = false): void {
  try {
    forget();
  } catch {
    // nothing stored
  }
  update({ token: null, rejected });
}

function forget(): void {
  sessionStorage.removeItem(KEY);
  localStorage.removeItem(KEY);
}

function update(next: Auth): void {
  auth = next;
  for (const l of listeners) l();
}

export function useAuth(): Auth {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => auth,
  );
}
