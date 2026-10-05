// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { CommunityAgent } from "./CommunityAgent";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
afterEach(cleanup);
it("opens the existing creation dialog with shared compute and Auto without creating an identity", async () => {
  const fixture = controlFixture();
  fixture.data.defaultWorkspace = "/fixture/workspace";
  fixture.data.createAvailable = true;
  fixture.data.harnessOptions?.[0]?.providers.push({
    value: "relay-mesh",
    label: "Buzz shared compute",
  });
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const view = render(
    <CommunityAgent
      control={control}
      destination="wss://relay.example.test"
      owner={"de".repeat(32)}
    />,
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Create community agent" }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Community agent");
  expect(
    within(dialog).getByRole("combobox", { name: /^Model$/ }),
  ).toHaveTextContent("Auto");
  expect(within(dialog).getByText("Buzz shared compute")).toBeInTheDocument();
  expect(fixture.calls.map((call) => call.action)).toEqual([
    "snapshot",
    "snapshot",
  ]);
  view.unmount();
});
