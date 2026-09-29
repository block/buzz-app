// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, useState } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { PanelWorkspace, usePanelTabTitle } from "./PanelWorkspace";
import { PanelSubview } from "./PanelSubview";

afterEach(cleanup);
function Profile({ authorized }: { authorized: boolean }) {
  usePanelTabTitle("Ada");
  const [log, setLog] = useState(false);
  return (
    <>
      <input aria-label="Profile draft" />
      <button type="button" onClick={() => setLog(true)}>
        Open log
      </button>
      {log && authorized && (
        <PanelSubview
          title="Harness log"
          backLabel="Back to profile"
          onBack={() => setLog(false)}
        >
          <input aria-label="Log filter" />
        </PanelSubview>
      )}
    </>
  );
}
function Fixture({ authorized = true }: { authorized?: boolean }) {
  const [ids, setIds] = useState(["Thread", "Profile"]);
  const [value, select] = useState("Thread");
  return ids.length ? (
    <PanelWorkspace
      value={value}
      select={select}
      items={ids.map((id) => ({
        id,
        label: id,
        close() {
          const next = ids.filter((item) => item !== id);
          setIds(next);
          if (id === value) select(next[0] ?? "");
        },
        content:
          id === "Thread" ? (
            <input aria-label="Thread draft" />
          ) : (
            <Profile authorized={authorized} />
          ),
      }))}
    />
  ) : (
    <p>No open panels</p>
  );
}
const tabs = () => screen.getByRole("tablist", { name: "Panel tabs" });
const tab = (name: string) => within(tabs()).getByRole("tab", { name });

test("switches retained panels, associates their tabs, and closes inactive or active tabs with focus recovery", async () => {
  const user = userEvent.setup();
  render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  const draft = screen.getByRole("textbox", { name: "Thread draft" });
  await user.type(draft, "Keep this draft");
  expect(screen.getByRole("tabpanel", { name: "Thread" })).toContainElement(
    draft,
  );
  await user.click(tab("Ada"));
  expect(screen.queryByRole("textbox", { name: "Thread draft" })).toBeNull();
  expect(draft).toBeInTheDocument();
  await user.click(tab("Thread"));
  expect(screen.getByRole("textbox", { name: "Thread draft" })).toBe(draft);
  expect(draft).toHaveValue("Keep this draft");
  await user.click(screen.getByRole("button", { name: "Close Ada tab" }));
  expect(tab("Thread")).toHaveFocus();
  await user.keyboard("{Delete}");
  expect(screen.getByText("No open panels")).toBeVisible();
});

test("local details are retained sibling tabs and close without dismissing the profile", async () => {
  const user = userEvent.setup();
  render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  await user.click(tab("Ada"));
  await user.click(screen.getByRole("button", { name: "Open log" }));
  expect(tab("Harness log")).toHaveFocus();
  const filter = screen.getByRole("textbox", { name: "Log filter" });
  await user.type(filter, "warning");
  await user.click(tab("Ada"));
  expect(screen.getByRole("textbox", { name: "Profile draft" })).toBeVisible();
  expect(filter).toBeInTheDocument();
  await user.click(tab("Harness log"));
  expect(screen.getByRole("textbox", { name: "Log filter" })).toBe(filter);
  expect(filter).toHaveValue("warning");
  await user.keyboard("{Escape}");
  expect(within(tabs()).queryByRole("tab", { name: "Harness log" })).toBeNull();
  expect(tab("Ada")).toHaveFocus();
  expect(filter).not.toBeInTheDocument();
});

test("revoking access removes the local tab; closing its owner also removes retained local content", async () => {
  const user = userEvent.setup();
  const view = render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  await user.click(tab("Ada"));
  await user.click(screen.getByRole("button", { name: "Open log" }));
  view.rerender(
    <StrictMode>
      <Fixture authorized={false} />
    </StrictMode>,
  );
  expect(
    screen.queryByRole("textbox", { name: "Log filter", hidden: true }),
  ).toBeNull();
  expect(tab("Ada")).toHaveFocus();
  view.rerender(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  await user.click(tab("Thread"));
  await user.click(screen.getByRole("button", { name: "Close Ada tab" }));
  expect(
    screen.queryByRole("textbox", { name: "Log filter", hidden: true }),
  ).toBeNull();
  expect(within(tabs()).getAllByRole("tab")).toHaveLength(1);
  expect(tab("Thread")).toHaveFocus();
});
