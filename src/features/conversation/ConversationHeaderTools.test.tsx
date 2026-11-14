// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationHeaderTools } from "./ConversationHeaderTools";
import { MenuItem } from "../../shared/design-system/ui/Menu";

afterEach(cleanup);

it.each(["hover", "click", "keyboard"] as const)(
  "conversation actions open via %s and remain actionable",
  async (method) => {
    const user = userEvent.setup();
    const run = vi.fn();
    render(
      <ConversationHeaderTools
        actions={<MenuItem onClick={run}>Open details</MenuItem>}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Conversation actions",
    });
    if (method === "hover") await user.hover(trigger);
    else if (method === "click") await user.click(trigger);
    else {
      trigger.focus();
      await user.keyboard("{Enter}");
    }
    const action = await screen.findByRole("button", { name: "Open details" });
    await user.click(action);
    expect(run).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(trigger).toHaveAttribute("aria-expanded", "false"),
    );
  },
);
