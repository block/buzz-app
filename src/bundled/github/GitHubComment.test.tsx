// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { GitHubComment } from "./GitHubComment";

afterEach(cleanup);
it("renders comment Markdown and the shared missing-avatar fallback", () => {
  const { container } = render(
    <GitHubComment
      comment={{
        id: "comment",
        databaseId: 1,
        author: "alex",
        body: "**Strong** and `code`\n\n- first\n- second\n\n[Link](https://example.org)",
        url: "https://github.com/example-org/sample/pull/1#discussion_r1",
      }}
    />,
  );
  expect(container.querySelector("strong")?.textContent).toBe("Strong");
  expect(container.querySelector("code")?.textContent).toBe("code");
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.getByRole("link", { name: "Link" }).getAttribute("href")).toBe(
    "https://example.org/",
  );
  expect(container.querySelector("[data-avatar-fallback]")?.textContent).toBe(
    "A",
  );
});
