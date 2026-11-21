// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Bitties, apply, bitties } from ".";
import { bittySeed } from "./generated-avatars";

// Encoding is held per seed so a test controls the order files finish in.
const encoding = new Map<string, (file: File) => void>();
const failing = new Set<string>();
vi.mock("./generated-avatars", async (actual) => ({
  ...(await actual<typeof import("./generated-avatars")>()),
  paintBitty: () => true,
  randomBittySeed: () => "f".repeat(32),
  bittyFile: (seed: string) =>
    failing.has(seed)
      ? Promise.reject(new Error("no canvas"))
      : new Promise<File>((resolve) => encoding.set(seed, resolve)),
}));
const finish = async (seed: string) => {
  const resolve = encoding.get(seed);
  if (!resolve) throw new Error(`nothing is encoding ${seed}`);
  encoding.delete(seed);
  await act(async () => resolve(new File([seed], "avatar.png")));
};

beforeEach(() => {
  encoding.clear();
  failing.clear();
});
afterEach(cleanup);

/** Mounts Bitties as the picker does: `seed` is what it last chose, and
 * only the newest pick lands. */
function mount(initial: { name: string; disabled?: boolean }) {
  const choices: { file: string; seed: string | undefined }[] = [];
  // Every call, as made: the seed, before the encode has finished.
  const calls: (string | undefined)[] = [];
  const failures: string[] = [];
  let newest = 0;
  let rename: (name: string) => void = () => {};
  let lock: (disabled: boolean) => void = () => {};
  function Host() {
    const [name, setName] = useState(initial.name);
    const [disabled, setDisabled] = useState(initial.disabled ?? false);
    const [seed, setSeed] = useState<string | undefined>();
    rename = setName;
    lock = setDisabled;
    return (
      <Bitties
        name={name}
        seed={seed}
        disabled={disabled}
        choose={(image, next) => {
          if (disabled) return;
          calls.push(next);
          const token = ++newest;
          void Promise.resolve(image).then(
            async (blob) => {
              const file = await (blob as Blob).text();
              if (token !== newest) return;
              choices.push({ file, seed: next });
              setSeed(next);
            },
            (reason: Error) => failures.push(reason.message),
          );
        }}
      />
    );
  }
  render(<Host />);
  return {
    choices,
    calls,
    failures,
    rename: (name: string) => act(() => rename(name)),
    lock: (disabled: boolean) => act(() => lock(disabled)),
  };
}

it("registers one Bitties avatar source", () => {
  const registerAvatarSource = vi.fn();
  apply({ agents: { registerAvatarSource } } as never);
  expect(registerAvatarSource).toHaveBeenCalledWith(bitties);
  expect(bitties).toMatchObject({ id: "bitties", title: "Bitties" });
});

it("chooses the name's Bitty and follows the name until pinned", async () => {
  const host = mount({ name: "Ada" });
  await finish(bittySeed("Ada"));
  await waitFor(() =>
    expect(host.choices).toEqual([
      { file: bittySeed("Ada"), seed: `name:${bittySeed("Ada")}` },
    ]),
  );
  host.rename("Ada L");
  await finish(bittySeed("Ada L"));
  await waitFor(() => expect(host.choices).toHaveLength(2));
  expect(host.choices[1]?.file).toBe(bittySeed("Ada L"));

  await userEvent.click(
    screen.getByRole("button", {
      name: "Keep this avatar when the name changes",
    }),
  );
  await finish(bittySeed("Ada L"));
  await waitFor(() =>
    expect(
      screen.getByRole("button", {
        name: "Keep this avatar when the name changes",
      }),
    ).toHaveAttribute("aria-pressed", "true"),
  );
  host.rename("Grace");
  expect(encoding.size).toBe(0);
  expect(host.choices.at(-1)?.seed).toBe(`pin:${bittySeed("Ada L")}`);

  // Unlocking follows the current name again.
  await userEvent.click(
    screen.getByRole("button", {
      name: "Keep this avatar when the name changes",
    }),
  );
  await finish(bittySeed("Grace"));
  await waitFor(() =>
    expect(host.choices.at(-1)).toEqual({
      file: bittySeed("Grace"),
      seed: `name:${bittySeed("Grace")}`,
    }),
  );
});

it("hands each Bitty to choose as its encode starts", async () => {
  // So a Save started before an encode ends waits for that Bitty.
  const host = mount({ name: "A" });
  expect(host.calls).toEqual([`name:${bittySeed("A")}`]);
  host.rename("Ab");
  expect(host.calls).toEqual([
    `name:${bittySeed("A")}`,
    `name:${bittySeed("Ab")}`,
  ]);
  await finish(bittySeed("Ab"));
  await finish(bittySeed("A"));
  await waitFor(() => expect(host.choices).toHaveLength(1));
  expect(host.choices[0]?.file).toBe(bittySeed("Ab"));
});

it("pins a variant or a shuffle from the strip", async () => {
  const host = mount({ name: "Ada" });
  await finish(bittySeed("Ada"));
  const third = bittySeed("Ada", "v3");
  await userEvent.click(screen.getByRole("button", { name: "Bitty 3" }));
  await finish(third);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Bitty 3" })).toHaveAttribute(
      "aria-pressed",
      "true",
    ),
  );
  expect(host.choices.at(-1)).toEqual({ file: third, seed: `pin:${third}` });

  await userEvent.click(screen.getByRole("button", { name: "Shuffle" }));
  await finish("f".repeat(32));
  await waitFor(() =>
    expect(host.choices.at(-1)?.seed).toBe(`pin:${"f".repeat(32)}`),
  );
  expect(screen.getByRole("button", { name: "Bitty 3" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

it("makes the strip one Tab stop moved by arrows, Home and End", async () => {
  mount({ name: "Ada" });
  const strip = screen.getByRole("group", { name: "Bitties for this name" });
  const options = Array.from(strip.querySelectorAll("button"));
  expect(options).toHaveLength(12);
  expect(options.filter((option) => option.tabIndex === 0)).toEqual([
    options[0],
  ]);
  options[0]?.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(options[1]).toHaveFocus();
  await userEvent.keyboard("{End}");
  expect(options[11]).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  expect(options[11]).toHaveFocus();
  await userEvent.keyboard("{Home}");
  expect(options[0]).toHaveFocus();
  expect(options[0]?.tabIndex).toBe(0);
  expect(options[11]?.tabIndex).toBe(-1);
});

it("waits while disabled and follows the name once enabled", async () => {
  const host = mount({ name: "Ada", disabled: true });
  expect(encoding.size).toBe(0);
  for (const button of screen.getAllByRole("button"))
    expect(button).toBeDisabled();
  host.rename("Grace");
  host.lock(false);
  await finish(bittySeed("Grace"));
  await waitFor(() =>
    expect(host.choices).toEqual([
      { file: bittySeed("Grace"), seed: `name:${bittySeed("Grace")}` },
    ]),
  );
});

it("rejects its pick with its own message when a Bitty can't be drawn", async () => {
  failing.add(bittySeed("Ada"));
  const host = mount({ name: "Ada" });
  await waitFor(() =>
    expect(host.failures).toEqual(["Couldn't draw this Bitty. Try another."]),
  );
  expect(host.choices).toEqual([]);
});
