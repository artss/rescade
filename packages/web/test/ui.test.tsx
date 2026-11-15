import { writeFile } from "node:fs/promises";
import path from "node:path";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, inject, it } from "vitest";
import { App, createQueryClient } from "../src/App.js";
import { ReloadBanner } from "../src/components/Layout.js";
import { keys } from "../src/queries.js";
import { setToken } from "../src/token.js";
import type { DaemonStatus, RunRecord } from "../src/types.js";

const wait = { timeout: 5000 };

function renderApp(url = "/", token: string | null = inject("token")) {
  history.replaceState(null, "", url);
  if (token !== null) setToken(token);
  return render(<App client={createQueryClient()} />);
}

/** Calls the daemon directly, as another client would. */
async function api<T>(method: "GET" | "POST", p: string): Promise<T> {
  const res = await fetch(`/api${p}`, { method, headers: { authorization: `Bearer ${inject("token")}` } });
  return (await res.json()) as T;
}

describe("signing in", () => {
  it("asks for the token and tells when the daemon rejects it", async () => {
    renderApp("/", null);
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("The daemon rejected the token.", {}, wait)).toBeDefined();

    fireEvent.change(screen.getByLabelText("API token"), { target: { value: inject("token") } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "daily" }, wait)).toBeDefined();
    expect(sessionStorage.getItem("rescade.token")).toBe(inject("token"));
    expect(localStorage.getItem("rescade.token")).toBeNull();
  });
});

describe("cascades and runs", () => {
  it("starts a cascade and follows the run to the end with its log", async () => {
    renderApp("/");
    expect(await screen.findByText("Forget old snapshots", {}, wait)).toBeDefined();
    expect(await screen.findByText("live", {}, wait)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Run daily" }));

    await waitFor(() => expect(location.pathname).toMatch(/^\/runs\/\d+$/), wait);
    const id = Number(location.pathname.split("/").at(-1));
    expect(await screen.findByRole("heading", { name: `Run ${id} of daily` }, wait)).toBeDefined();
    await waitFor(() => expect(within(screen.getByRole("heading", { level: 1 }).parentElement!).getByText("success")), wait);
    await waitFor(() => expect(screen.getByTestId("log").textContent).toContain("Applying Policy: keep 7 daily snapshots"), wait);
    expect(screen.getByTestId("log").textContent).toContain("==> [1] retain a");
  });

  it("lists runs of a cascade and opens one", async () => {
    const run = await api<RunRecord>("POST", "/cascades/daily/run");
    renderApp("/runs?cascade=daily");
    const link = await screen.findByRole("link", { name: String(run.id) }, wait);
    expect((screen.getByLabelText("Cascade") as HTMLSelectElement).value).toBe("daily");
    fireEvent.click(link);
    expect(await screen.findByRole("heading", { name: `Run ${run.id} of daily` }, wait)).toBeDefined();
  });

  it("shows the live log and who holds a repo, and cancels the run", async () => {
    const run = await api<RunRecord>("POST", "/cascades/slow/run");
    try {
      const view = renderApp("/repos");
      await waitFor(() => expect(screen.getByRole("link", { name: `run ${run.id}` })), wait);
      view.unmount();

      renderApp(`/runs/${run.id}`);
      await waitFor(() => expect(screen.getByTestId("log").textContent).toContain("holding"), wait);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(within(screen.getByRole("heading", { level: 1 }).parentElement!).getByText("cancelled")), wait);
      expect(screen.queryByRole("button", { name: /Cancel/ })).toBeNull();
    } finally {
      await writeFile(path.join(inject("fakeDir"), "release"), "");
    }
  });
});

describe("daemon status", () => {
  it("warns when a config reload failed and the old config stays", () => {
    const qc = createQueryClient();
    const status: DaemonStatus = {
      version: "0.1.0",
      startedAt: 0,
      config: { path: "/etc/rescade/config", loadedAt: 0, lastReload: { at: 1, ok: false, errors: ["a.yaml:3:1: error: bad"] } },
    };
    qc.setQueryData(keys.status, status);
    render(
      <QueryClientProvider client={qc}>
        <ReloadBanner />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("alert").textContent).toContain("stays in use (/etc/rescade/config)");
    expect(screen.getByText("a.yaml:3:1: error: bad")).toBeDefined();

    qc.setQueryData(keys.status, { ...status, config: { ...status.config, lastReload: { at: 2, ok: true, errors: [] } } });
    return waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
