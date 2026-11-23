// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReplyPlacementNotice, replyPlacementFor } from "./reply-placement";

afterEach(cleanup);

it("says where tagged agents answer, and offers the other place", () => {
  const choose = vi.fn();
  const view = render(
    <ReplyPlacementNotice
      choice={{ level: "top", checked: true, choose }}
      agents={["Morgarita"]}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Morgarita will reply in a thread",
  );
  fireEvent.click(screen.getByRole("button", { name: "Reply here instead" }));
  expect(choose).toHaveBeenCalledWith(false);
  view.rerender(
    <ReplyPlacementNotice
      choice={{ level: "top", checked: false, choose }}
      agents={["Morgarita", "Spar"]}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Morgarita and Spar will reply here",
  );
  fireEvent.click(screen.getByRole("button", { name: "Use a thread" }));
  expect(choose).toHaveBeenLastCalledWith(true);
  view.rerender(
    <ReplyPlacementNotice
      choice={{ level: "thread", checked: true, choose }}
      agents={["Morgarita", "Spar", "Carl"]}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "3 agents will reply in a subthread",
  );
});

it("asks for one level deeper than the composer, and none past a subthread", () => {
  expect(replyPlacementFor("top", false)).toBe("top");
  expect(replyPlacementFor("top", true)).toBe("thread");
  expect(replyPlacementFor("thread", false)).toBe("thread");
  expect(replyPlacementFor("thread", true)).toBe("subthread");
  expect(replyPlacementFor("subthread", false)).toBe("subthread");
});
