// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Contribution } from "../../plugins/contributions";
import { ComposerTools } from "./ComposerTools";
import type { ComposerTool } from "./contracts";

afterEach(cleanup);

const tool = (id: string, placement?: "send") =>
  ({
    key: `test.tools/${id}`,
    pluginId: "test.tools",
    revision: "one",
    id,
    title: id,
    ...(placement ? { placement } : {}),
    component: () => <button type="button">{id}</button>,
  }) as unknown as Contribution<ComposerTool>;
const tools = [tool("row"), tool("beside", "send")];
const registry = { snapshot: () => tools, subscribe: () => () => {} };
const props = {
  disabled: false,
  insertText: () => true,
  insertMention: () => true,
  insertMentions: () => true,
  replaceRecipients: () => true,
  insertResource: () => true,
  focus: () => {},
} as unknown as Omit<Parameters<typeof ComposerTools>[0], "registry">;

it("renders a tool placed beside Send only where the host places it", () => {
  const { rerender } = render(<ComposerTools registry={registry} {...props} />);
  expect(screen.getByRole("button", { name: "row" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "beside" })).toBeNull();

  rerender(<ComposerTools registry={registry} placement="send" {...props} />);
  expect(screen.getByRole("button", { name: "beside" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "row" })).toBeNull();
});
