import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, inject, it, vi } from "vitest";
import { App, createQueryClient } from "../src/App.js";
import { ReloadBanner } from "../src/components/Layout.js";
import { SnapshotTree } from "../src/components/SnapshotTree.js";
import { formatTime } from "../src/format.js";
import { keys } from "../src/queries.js";
import { setToken } from "../src/token.js";
import type { DaemonStatus, RunRecord, Snapshot, SnapshotDir } from "../src/types.js";

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
    renderApp("/runs", null);
    expect(screen.getByRole("heading", { level: 1, name: "rescade" })).toBeDefined();
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("The daemon rejected the token.", {}, wait)).toBeDefined();

    fireEvent.change(screen.getByLabelText("API token"), { target: { value: inject("token") } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    // the logo in the header leads home
    fireEvent.click(await screen.findByRole("link", { name: "rescade" }, wait));
    expect(location.pathname).toBe("/");
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
    expect(screen.queryByRole("list", { name: "Steps of home" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Steps of home" }));
    fireEvent.click(screen.getByRole("button", { name: "Steps of daily" }));
    const home = screen.getByRole("list", { name: "Steps of home" });
    expect(within(home).getByText("Paths").nextElementSibling?.textContent).toBe("/home");
    expect(within(screen.getByRole("list", { name: "Steps of daily" })).getByText("7 daily")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Run daily" }));

    await waitFor(() => expect(location.pathname).toMatch(/^\/runs\/\d+$/), wait);
    const id = Number(location.pathname.split("/").at(-1));
    expect(await screen.findByRole("heading", { name: `Run ${id} of daily` }, wait)).toBeDefined();
    await waitFor(() => expect(within(screen.getByRole("heading", { level: 1 }).parentElement!).getByText("success")), wait);
    await waitFor(() => expect(screen.getByTestId("log").textContent).toContain("Applying Policy: keep 7 daily snapshots"), wait);
    expect(screen.getByTestId("log").textContent).toContain("==> [1] retain a");
  });

  it("groups cascades under headings that collapse, ungrouped ones stay as they are", async () => {
    renderApp("/");
    const group = await screen.findByRole("region", { name: "regular" }, wait);
    expect(within(group).getByRole("heading", { name: "daily" })).toBeDefined();
    expect(within(group).getByRole("heading", { name: "home" })).toBeDefined();
    expect(within(group).queryByRole("heading", { name: "slow" })).toBeNull();
    const toggle = within(group).getByRole("button", { name: /regular/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("heading", { name: "daily" })).toBeNull();
    expect(screen.getByRole("heading", { name: "slow" })).toBeDefined();

    fireEvent.click(toggle);
    expect(screen.getByRole("heading", { name: "daily" })).toBeDefined();
  });

  it("remembers collapsed groups across reloads, separately for each list", async () => {
    const first = renderApp("/");
    fireEvent.click(await screen.findByRole("button", { name: /regular/ }, wait));
    expect(JSON.parse(localStorage.getItem("rescade.collapsed.cascades")!)).toEqual(["regular"]);
    first.unmount();

    const second = renderApp("/");
    const toggle = await screen.findByRole("button", { name: /regular/ }, wait);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("heading", { name: "daily" })).toBeNull();
    fireEvent.click(toggle);
    expect(localStorage.getItem("rescade.collapsed.cascades")).toBeNull();
    second.unmount();

    localStorage.setItem("rescade.collapsed.cascades", "not json");
    renderApp("/");
    expect((await screen.findByRole("button", { name: /regular/ }, wait)).getAttribute("aria-expanded")).toBe("true");
  });

  it("lists runs of a cascade and opens one", async () => {
    const run = await api<RunRecord>("POST", "/cascades/daily/run");
    renderApp("/");
    fireEvent.click(await screen.findByRole("link", { name: "daily" }, wait));
    expect(location.pathname + location.search).toBe("/runs?cascade=daily");
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
      expect(within(screen.getByRole("region", { name: "offsite" })).getByRole("link", { name: "b" })).toBeDefined();
      view.unmount();

      const cascades = renderApp("/");
      const running = await screen.findByRole("link", { name: "Running slow" }, wait);
      expect(running.getAttribute("href")).toBe(`/runs/${run.id}`);
      expect(screen.queryByRole("button", { name: "Run slow" })).toBeNull();
      cascades.unmount();

      renderApp(`/runs/${run.id}`);
      await waitFor(() => expect(screen.getByTestId("log").textContent).toContain("holding"), wait);
      // declining the confirmation leaves the run alone
      const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
      vi.stubGlobal("confirm", confirm);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(confirm).toHaveBeenCalledWith(`Cancel run ${run.id}? The current step will be stopped.`);
      expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      vi.unstubAllGlobals();
      await waitFor(() => expect(within(screen.getByRole("heading", { level: 1 }).parentElement!).getByText("cancelled")), wait);
      expect(screen.queryByRole("button", { name: /Cancel/ })).toBeNull();

      // the cancelled run is started again from its step
      await writeFile(path.join(inject("fakeDir"), "release"), "");
      fireEvent.click(screen.getByRole("button", { name: "Rerun from failed" }));
      await waitFor(() => expect(location.pathname).not.toBe(`/runs/${run.id}`), wait);
      const rerun = await api<RunRecord>("GET", location.pathname);
      expect(rerun).toMatchObject({ cascade: "slow", rerunOf: run.id, fromStep: 0 });
      expect(await screen.findByRole("heading", { name: `Run ${rerun.id} of slow` }, wait)).toBeDefined();
      expect(screen.getByRole("link", { name: `run ${run.id}` }).getAttribute("href")).toBe(`/runs/${run.id}`);
      await waitFor(() => expect(within(screen.getByRole("heading", { level: 1 }).parentElement!).getByText("success")), wait);
      expect(screen.queryByRole("button", { name: "Rerun from failed" })).toBeNull();
    } finally {
      await writeFile(path.join(inject("fakeDir"), "release"), "");
    }
  });
});

describe("snapshots", () => {
  it("lists the snapshots of a repo, opens one as a tree and restores what is checked", async () => {
    const id = "d".repeat(64);
    const node = (p: string, type: string, size?: number) => ({
      name: p.split("/").at(-1),
      type,
      path: p,
      size,
      permissions: type === "symlink" ? "Lrwxrwxrwx" : "-rw-r--r--",
      uid: 1000,
      gid: 100,
      mtime: "2026-10-31T08:00:00Z",
    });
    const dir = path.join(inject("fakeDir"), "snapshots");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, encodeURIComponent("/r/b") + ".json"),
      JSON.stringify({
        snapshots: [{ time: "2026-11-01T10:00:00Z", paths: ["/home"], hostname: "nas", username: "root", tags: ["weekly"], id, short_id: id.slice(0, 8) }],
        nodes: {
          [id]: [
            node("/home", "dir"),
            node("/home/u", "dir"),
            node("/home/u/notes.txt", "file", 2048),
            node("/home/u/link", "symlink"),
            node("/home/v", "dir"),
          ],
        },
      }),
    );

    renderApp("/repos");
    fireEvent.click(await screen.findByRole("link", { name: "b" }, wait));
    expect(location.pathname).toBe("/repos/b");
    expect(await screen.findByText("weekly", {}, wait)).toBeDefined();
    expect(screen.getByText("Chunker polynomial")).toBeDefined();
    fireEvent.click(screen.getByRole("link", { name: "dddddddd" }));

    // folded at first; a directory is listed when opened
    const tree = await screen.findByRole("tree", { name: "Files" }, wait);
    const home = await within(tree).findByRole("treeitem", { name: "home" }, wait);
    expect(home.getAttribute("aria-expanded")).toBe("false");
    expect(within(tree).queryByRole("treeitem", { name: "u" })).toBeNull();
    fireEvent.click(home);
    fireEvent.click(await within(tree).findByRole("treeitem", { name: "u" }, wait));
    const notes = await within(tree).findByRole("treeitem", { name: "notes.txt" }, wait);
    expect(within(notes).getByText("2.0 KiB")).toBeDefined();
    expect(within(notes).getByText("1000:100")).toBeDefined();
    expect(within(notes).getByText("-rw-r--r--")).toBeDefined();
    expect(within(notes).getByText(formatTime(Date.parse("2026-10-31T08:00:00Z")))).toBeDefined();
    expect(within(within(tree).getByRole("treeitem", { name: "link" })).getByRole("img", { name: "symlink" })).toBeDefined();
    expect(within(notes).queryByRole("img", { name: "symlink" })).toBeNull();
    expect(screen.getByRole("link", { name: "b" }).getAttribute("href")).toBe("/repos/b");

    // nothing is checked, so there is nothing to restore
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    const checkbox = (p: string) => screen.getByRole("checkbox", { name: `Restore ${p}` });
    const box = (p: string) => checkbox(p).getAttribute("aria-checked");
    expect(box("/home/u")).toBe("false");
    fireEvent.click(checkbox("/home/u"));
    expect(box("/home/u/notes.txt")).toBe("true");
    expect(box("/home")).toBe("mixed");
    // checking a box does not open or close the directory
    expect(within(tree).getByRole("treeitem", { name: "u" }).getAttribute("aria-expanded")).toBe("true");
    const target = path.join(inject("fakeDir"), "restore", "dddddddd");
    expect(screen.getByText(target)).toBeDefined();
    expect(screen.getByText("1 path")).toBeDefined();

    // unchecking a file of the checked directory leaves the rest of it
    fireEvent.click(checkbox("/home/u/notes.txt"));
    expect(box("/home/u")).toBe("mixed");
    expect(box("/home/u/link")).toBe("true");
    fireEvent.click(checkbox("/home/v"));
    expect(screen.getByText("2 paths")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(location.pathname).toMatch(/^\/runs\/\d+$/), wait);
    const run = await api<RunRecord>("GET", location.pathname);
    expect(run.restore).toMatchObject({ repo: "b", snapshot: id, paths: ["/home/u/link", "/home/v"], target });
  });

  it("links the snapshot of a backup step to the snapshot", async () => {
    const run = await api<RunRecord>("POST", "/cascades/home/run");
    renderApp(`/runs/${run.id}`);
    const link = await screen.findByRole("link", { name: /^[0-9a-f]{8}$/ }, { timeout: 5000 });
    fireEvent.click(link);
    await waitFor(() => expect(location.pathname).toMatch(/^\/repos\/a\/snapshots\/[0-9a-f]{64}$/), wait);
    expect(await screen.findByText("Empty directory.", {}, wait)).toBeDefined();
    expect(screen.queryByRole("treeitem")).toBeNull();
  });

  it("does not offer to restore when the daemon has no restore directory", async () => {
    const qc = createQueryClient();
    const id = "f".repeat(64);
    const snapshot: Snapshot = { id, shortId: id.slice(0, 8), time: 0, hostname: "nas", username: "root", paths: ["/etc"], tags: [] };
    const root: SnapshotDir = { snapshot, path: "/", entries: [{ name: "etc", type: "dir", path: "/etc" }], truncated: false };
    qc.setQueryData(keys.status, { version: "0.1.0", startedAt: 0, config: { path: "/c", loadedAt: 0 } } satisfies DaemonStatus);
    qc.setQueryData(keys.snapshotDir("a", id, "/"), root);
    render(
      <QueryClientProvider client={qc}>
        <SnapshotTree repo="a" snapshot={snapshot} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("checkbox", { name: "Restore /etc" }, wait));
    expect((screen.getByRole("button", { name: "Restore" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Restore is off/)).toBeDefined();

    // while a directory is listed, a spinner stands in place of its checkbox; the daemon knows no such snapshot
    fireEvent.click(screen.getByRole("treeitem", { name: "etc" }));
    await waitFor(() => {
      expect(screen.getByRole("img", { name: "Loading /etc" })).toBeDefined();
      expect(screen.queryByRole("checkbox", { name: "Restore /etc" })).toBeNull();
    }, wait);
    expect(await screen.findByRole("button", { name: "Retry" }, wait)).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "Restore /etc" })).toBeDefined();
  });

  it("says when there is no such repo", async () => {
    renderApp("/repos/nope");
    expect(await screen.findByText("No such repo.", {}, wait)).toBeDefined();
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
