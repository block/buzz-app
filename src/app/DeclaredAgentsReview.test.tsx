// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import type { PluginManifest } from "../plugins/api";
import {
  allDeclaredAgentIds,
  DeclaredAgentsReview,
  selectedDeclaredAgents,
} from "./DeclaredAgentsReview";

afterEach(cleanup);

const bundle: PluginManifest = {
  id: "example.bundle",
  name: "Example bundle",
  apiVersion: 1,
  agents: [
    { id: "reviewer", name: "Reviewer", instructions: "Review pull requests." },
    { id: "writer", name: "Writer" },
  ],
};

function Review({ manifest }: { manifest: PluginManifest }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() =>
    allDeclaredAgentIds(manifest),
  );
  return (
    <>
      <DeclaredAgentsReview
        manifest={manifest}
        selected={selected}
        onSelectedChange={setSelected}
      />
      <output>
        {selectedDeclaredAgents(manifest, selected)
          .map((agent) => agent.id)
          .join(",")}
      </output>
    </>
  );
}

it("checks every declared agent by default and lets the owner leave one out", () => {
  render(<Review manifest={bundle} />);
  expect(screen.getByText("Review pull requests.")).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("reviewer,writer");
  fireEvent.click(screen.getByRole("checkbox", { name: /Writer/ }));
  expect(screen.getByRole("status")).toHaveTextContent(/^reviewer$/);
});

it("renders nothing for a plugin without declared agents", () => {
  const { container } = render(
    <Review manifest={{ id: "example.page", name: "Page", apiVersion: 1 }} />,
  );
  expect(container.querySelector("section")).toBeNull();
});
