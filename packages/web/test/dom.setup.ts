import { cleanup } from "@testing-library/react";
import { afterEach, inject } from "vitest";
import { clearToken } from "../src/token.js";

// the page and the API share the origin, as when the daemon serves the UI
(window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(inject("daemonUrl"));

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  clearToken();
});
