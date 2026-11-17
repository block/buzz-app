// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SoloChatTitle } from "./SoloChatTitle";

afterEach(cleanup);

function setup() {
  const first = "First title";
  const { container, rerender } = render(<SoloChatTitle title={first} />, {
    wrapper: ({ children }) => <button type="button">{children}</button>,
  });
  const value = () => container.querySelector('[aria-hidden="true"]');
  const characters = () =>
    [...(value()?.children ?? [])].map((node) => node.textContent);
  const rename = (title: string) => {
    rerender(<SoloChatTitle title={title} />);
    expect(screen.getByRole("button")).toHaveAccessibleName(title);
  };
  const expectSettled = (title: string) =>
    waitFor(() => {
      expect(value()?.textContent).toBe(title);
      expect(characters()).toEqual([]);
    });
  return { first, value, characters, rename, expectSettled };
}

it("keeps the latest rename during exit and reveals whole graphemes", async () => {
  const { first, value, characters, rename, expectSettled } = setup();
  rename("Intermediate title");
  expect(value()).toHaveTextContent(first);
  const title = "A 👩🏽‍💻 e\u0301";
  rename(title);
  expect(characters()).toEqual([]);

  await waitFor(() =>
    expect(characters()).toEqual(["A", " ", "👩🏽‍💻", " ", "e\u0301"]),
  );
  await expectSettled(title);
});

it("settles on the original title when renamed back during the reveal", async () => {
  const { first, characters, rename, expectSettled } = setup();
  rename("Second");
  await waitFor(() => expect(characters().join("")).toBe("Second"));

  rename(first);
  await waitFor(() => expect(characters().join("")).toBe(first));
  await expectSettled(first);
});
