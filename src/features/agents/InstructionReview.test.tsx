// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { InstructionReview } from "./InstructionReview";
import { InstructionRequests } from "./instruction-requests";
import type { Agents } from "./service";
import { memoryStorage } from "./test-fakes";

afterEach(cleanup);
it.each(["Cancel", "Send instruction"])(
  "requires the exact host confirmation: %s",
  async (decision) => {
    const listeners = new Set<() => void>();
    const requests = new InstructionRequests(memoryStorage(), () => {
      for (const listener of listeners) listener();
    });
    const id = await requests.id();
    const deliver = vi.fn(async () => "delivered" as const);
    const receipt = requests.submit({
      review: {
        id,
        agent: "selected-agent",
        owner: "synthetic-owner",
        community: "https://synthetic.example.test",
        source: "source-channel",
        plugin: "synthetic",
        operation: "synthetic/link",
        tool: "synthetic_link",
        args: { from: "A", to: "B" },
        text: "Link only A to B.",
      },
      check: () => {},
      cancel: () => {},
      deliver,
    });
    const agents = {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      instructionReviews: requests.snapshot,
      decideInstruction: (id: string, allowed: boolean) =>
        requests.decide(id, allowed),
    } as unknown as Agents;
    render(<InstructionReview agents={agents} />);
    await screen.findByRole("alertdialog");
    expect(screen.getByText("selected-agent")).toBeVisible();
    expect(screen.getByText("Link only A to B.")).toBeVisible();
    expect(screen.getByText(/"from": "A"/)).toBeVisible();
    expect(deliver).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
    await userEvent.click(screen.getByRole("button", { name: decision }));
    await expect(receipt).resolves.toEqual({
      id,
      status: decision === "Cancel" ? "refused" : "delivered",
    });
    expect(deliver).toHaveBeenCalledTimes(decision === "Cancel" ? 0 : 1);
  },
);
