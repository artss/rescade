import { mkdir, writeFile } from "node:fs/promises";
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

describe("snapshots", () => {
  it("lists the snapshots of a repo and browses one a directory at a time", async () => {
    const id = "d".repeat(64);
    const node = (p: string, type: string, size?: number) => ({ name: p.split("/").at(-1), type, path: p, size, permissions: "-rw-r--r--" });
    const dir = path.join(inject("fakeDir"), "snapshots");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, encodeURIComponent("/r/b") + ".json"),
      JSON.stringify({
        snapshots: [{ time: "2026-11-01T10:00:00Z", paths: ["/home"], hostname: "nas", username: "root", tags: ["weekly"], id, short_id: id.slice(0, 8) }],
        nodes: { [id]: [node("/home", "dir"), node("/home/u", "dir"), node("/home/u/notes.txt", "file", 2048)] },
      }),
    );

    renderApp("/repos");
    const card = (await screen.findByRole("heading", { name: "b" }, wait)).parentElement!;
    fireEvent.click(within(card).getByRole("link", { name: "Snapshots" }));
    expect(await screen.findByText("weekly", {}, wait)).toBeDefined();
    fireEvent.click(screen.getByRole("link", { name: "dddddddd" }));

    fireEvent.click(await screen.findByRole("link", { name: "home/" }, wait));
    fireEvent.click(await screen.findByRole("link", { name: "u/" }, wait));
    expect(await screen.findByText("notes.txt", {}, wait)).toBeDefined();
    expect(screen.getByText("2.0 KiB")).toBeDefined();
    expect(location.search).toBe("?path=%2Fhome%2Fu");

    // back up the path
    fireEvent.click(within(screen.getByRole("navigation", { name: "Path" })).getByRole("link", { name: "home" }));
    expect(await screen.findByRole("link", { name: "u/" }, wait)).toBeDefined();
  });

  it("links the snapshot of a backup step to the snapshot", async () => {
    const run = await api<RunRecord>("POST", "/cascades/home/run");
    renderApp(`/runs/${run.id}`);
    const link = await screen.findByRole("link", { name: /^[0-9a-f]{8}$/ }, { timeout: 5000 });
    fireEvent.click(link);
    await waitFor(() => expect(location.pathname).toMatch(/^\/repos\/a\/snapshots\/[0-9a-f]{64}$/), wait);
    expect(await screen.findByText("Empty directory.", {}, wait)).toBeDefined();
  });

  it("shows what restic said when a snapshot cannot be read", async () => {
    renderApp(`/repos/a/snapshots/${"e".repeat(64)}`);
    expect((await screen.findByRole("alert", {}, wait)).textContent).toMatch(/no matching ID found/);
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
