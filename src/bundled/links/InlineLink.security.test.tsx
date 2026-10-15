// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Page } from "../../features/pages/service";
import { apply } from "../link-lab";
import { InlineLink, linkKind } from "./InlineLink";

afterEach(cleanup);

it.each([
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  " \tjavascript:alert(1)",
  "java\nscript:alert(1)",
  "java\tscript:alert(1)",
  "data:text/html,<svg onload=alert(1)>",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "mailto:example@example.com",
  "//github.com/block/buzz",
  "buzz://unknown",
  '<img src=x onerror="alert(1)">',
])(
  "renders unsupported input as literal text without an anchor: %s",
  (href) => {
    const { container, rerender } = render(<InlineLink href={href} />);
    expect(linkKind(href)).toBeNull();
    expect(container.textContent).toBe(href);
    expect(container.children).toHaveLength(0);

    const label = '<svg onload="alert(1)">';
    rerender(<InlineLink href={href}>{label}</InlineLink>);
    expect(container.textContent).toBe(label);
    expect(container.children).toHaveLength(0);
  },
);

it.each(["http:", "https:"])(
  "keeps %s destinations and authored labels literal",
  (scheme) => {
    const href = `${scheme}//github.com/?q=" onclick="alert(1)`;
    const label = '<img src=x onerror="alert(1)">';
    const { container } = render(<InlineLink href={href}>{label}</InlineLink>);
    const link = screen.getByRole("link", { name: label });
    expect(link).toHaveAttribute("href", href);
    expect(link).toHaveAttribute("data-kind", "github");
    expect(link).not.toHaveAttribute("onclick");
    expect(container.querySelector("img")).toBeNull();
  },
);

it("guards the Link Lab input-to-anchor path and restores a supported link", () => {
  let page: Page | undefined;
  apply({ pages: { register: (value: Page) => (page = value) } } as never);
  if (!page) throw new Error("expected the link lab page");
  const Lab = page.component;
  const { container } = render(<Lab />);
  const input = screen.getByRole("textbox", { name: "Try a URL" });
  const payload = 'javascript:alert("<img src=x onerror=alert(1)>")';
  fireEvent.change(input, { target: { value: payload } });
  expect(screen.getByText(`Take a look at ${payload}.`)).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: payload })).toBeNull();
  expect(container.querySelector("img")).toBeNull();

  const href = "https://github.com/block/buzz";
  fireEvent.change(input, { target: { value: href } });
  expect(screen.getByRole("link", { name: href })).toHaveAttribute(
    "href",
    href,
  );
});
