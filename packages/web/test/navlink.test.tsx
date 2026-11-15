import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NavLink } from "../src/components/NavLink.js";

function renderAt(url: string) {
  history.replaceState(null, "", url);
  render(
    <nav>
      <NavLink href="/">Cascades</NavLink>
      <NavLink href="/runs">Runs</NavLink>
      <NavLink href="/repos">Repos</NavLink>
    </nav>,
  );
}

const current = () =>
  screen
    .getAllByRole("link")
    .filter((l) => l.getAttribute("aria-current") === "page")
    .map((l) => l.textContent);

describe("NavLink", () => {
  it("marks its own page and the pages under it, but not every page under /", () => {
    renderAt("/runs/7");
    expect(current()).toEqual(["Runs"]);
  });

  it("marks / only on /", () => {
    renderAt("/");
    expect(current()).toEqual(["Cascades"]);
  });
});
