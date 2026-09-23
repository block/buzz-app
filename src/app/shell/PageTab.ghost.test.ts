// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { ghostSpec, translucent } from "./PageTab";

const ghostPage = readFileSync("public/drag-ghost.js", "utf8");

function strip(selectedFirst = true) {
  document.body.innerHTML = `
    <style>
      .navigation-item { background-color: transparent; color: rgb(1, 2, 3); font: 500 14px Inter; padding: 6px 16px; gap: 6px; border-radius: 999px; }
      .navigation-item[data-selected] { background-color: rgb(10, 20, 30); }
      .buzz-button { background-color: rgba(40, 50, 60, 0.4); border-radius: 999px; box-shadow: inset 0 1px 0 rgb(255, 255, 255); }
      .buzz-button img { width: 16px; height: 16px; }
    </style>
    <nav>
      <button class="navigation-item" data-variant="pill" ${selectedFirst ? "data-selected" : ""} id="home"><svg width="15" height="15"></svg><span>Home</span></button>
      <button class="navigation-item" data-variant="pill" id="messages"><svg width="15" height="15"><path d="M0"/></svg><span>Messages</span></button>
      <button class="buzz-button" id="bestie"><span><img src="/bestie.png" alt="" /></span></button>
    </nav>`;
  const by = (id: string) => document.getElementById(id) as HTMLElement;
  return { home: by("home"), messages: by("messages"), bestie: by("bestie") };
}

function renderGhost(spec: unknown) {
  document.body.innerHTML = `<div id="tab"><span id="title"></span></div>`;
  window.location.hash = `#spec=${encodeURIComponent(JSON.stringify(spec))}`;
  new Function(ghostPage)();
  return document.getElementById("tab") as HTMLElement;
}

beforeEach(() => {
  window.location.hash = "";
});

it("an unselected page tab lifts with the selected look, its icon and its text styles", () => {
  const { messages } = strip();
  const spec = ghostSpec(messages, "Messages", { width: 120.4, height: 32 });
  expect(spec).toMatchObject({
    title: "Messages",
    width: 120,
    height: 32,
    background: "rgb(10, 20, 30)",
    color: "rgb(1, 2, 3)",
    padding: "6px 16px",
    gap: "6px",
    radius: "999px",
  });
  expect(spec.icon).toContain('<path d="M0">');
  expect(spec.icon).toMatch(/^<svg/);
});

it("an opaque tab keeps its background; glass launchers lift as an opaque icon pill", () => {
  const { home, bestie } = strip();
  expect(ghostSpec(home, "Home", { width: 90, height: 32 }).background).toBe(
    "rgb(10, 20, 30)",
  );
  const launcher = ghostSpec(bestie, "Bestie", { width: 36, height: 36 }, true);
  expect(launcher.title).toBe("");
  // Translucent glass would wash out over the desktop; borrow the selected surface.
  expect(launcher.background).toBe("rgb(10, 20, 30)");
  expect(launcher.shadow).toContain("inset");
  expect(launcher.icon).toMatch(/^<img/);
  expect(launcher.iconSize).toBe("16px");
});

it("recognises every translucent computed colour form", () => {
  for (const color of [
    "transparent",
    "rgba(0, 0, 0, 0)",
    "rgba(40, 50, 60, 0.4)",
    "color(srgb 0.1 0.2 0.3 / 0.5)",
    "hsla(10, 20%, 30%, 40%)",
    "",
  ])
    expect(translucent(color), color).toBe(true);
  for (const color of [
    "rgb(1, 2, 3)",
    "rgba(1, 2, 3, 1)",
    "color(srgb 0.1 0.2 0.3)",
    "color(srgb 0.1 0.2 0.3 / 1)",
    "hsl(10, 20%, 30%)",
  ])
    expect(translucent(color), color).toBe(false);
});

it("the ghost page renders the spec and accepts only the tab's own icon element", () => {
  const tab = renderGhost({
    title: "Messages",
    icon: '<svg width="15" height="15"><path d="M0"></path></svg>',
    iconSize: "15px",
    width: 120,
    height: 32,
    background: "rgb(10, 20, 30)",
    color: "rgb(1, 2, 3)",
    font: "500 14px Inter",
    padding: "6px 16px",
    gap: "6px",
    radius: "999px",
    shadow: "rgb(255, 255, 255) 0px 1px 0px 0px inset",
  });
  expect(tab.style.width).toBe("120px");
  expect(tab.style.background).toBe("rgb(10, 20, 30)");
  expect(tab.style.borderRadius).toBe("999px");
  expect(tab.style.boxShadow).toContain("inset");
  expect(tab.style.boxShadow).toContain("0.28");
  expect(tab.querySelector("svg")?.style.width).toBe("15px");
  expect(document.getElementById("title")?.textContent).toBe("Messages");
  // Script, remote image and malformed payloads render nothing dangerous.
  for (const icon of [
    "<script>alert(1)</script>",
    '<img src="https://evil.test/x.png">',
    "<div><svg></svg></div>",
  ]) {
    const next = renderGhost({ title: "x", icon, width: 10, height: 10 });
    expect(next.querySelector("svg, img, script, div")).toBeNull();
  }
  expect(renderGhost({}).style.width).toBe("0px");
  document.body.innerHTML = `<div id="tab"><span id="title">stale</span></div>`;
  window.location.hash = "#spec=not-json";
  new Function(ghostPage)();
  expect(document.getElementById("title")?.textContent).toBe("stale");
});
