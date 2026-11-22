// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { type ComponentProps, createRef, useState } from "react";
import type {
  Agent,
  AgentAvatarSource,
  Agents,
  RegisteredAgentAvatarSource,
} from "../../features/agents/service";
import { uploadAvatar } from "../../features/profiles/avatar-upload";
import { AgentIdentityDialog } from "./AgentIdentityDialog";
import {
  AgentAvatarPicker,
  type AvatarSelection,
  PICK_WAIT_MS,
} from "./AgentAvatarPicker";

vi.mock("../../features/profiles/avatar-upload", async (actual) => ({
  ...(await actual<typeof import("../../features/profiles/avatar-upload")>()),
  uploadAvatar: vi.fn(),
}));

// A test may hold decodes to control the order picks finish in.
let hold: ((src: string) => Promise<void>) | undefined;
HTMLImageElement.prototype.decode = function () {
  return hold ? hold(this.src) : Promise.resolve();
};
afterEach(() => {
  cleanup();
  hold = undefined;
  vi.mocked(uploadAvatar).mockReset();
});
/** Holds every decode until released, in any order. */
function holdDecodes() {
  const waiting: { src: string; release(): void }[] = [];
  hold = (src) =>
    new Promise((release) => waiting.push({ src, release: () => release() }));
  return waiting;
}

const picture = "https://images.example/current.png";
const png = (bytes = "png") => new Blob([bytes], { type: "image/png" });
type Choose = ComponentProps<AgentAvatarSource["component"]>["choose"];

function setup() {
  let sources: readonly RegisteredAgentAvatarSource[] = [];
  const listeners = new Set<() => void>();
  let choose: Choose = () => {};
  const names: string[] = [];
  const source: RegisteredAgentAvatarSource = Object.freeze({
    id: "faces",
    key: "buzz.faces/faces",
    pluginId: "buzz.faces",
    revision: "bundled",
    title: "Faces",
    icon: <svg />,
    component: (props) => {
      choose = props.choose;
      names.push(props.name);
      return (
        <>
          <button
            type="button"
            disabled={props.disabled}
            onClick={() => props.choose(png("red"), "red")}
          >
            Red face {props.seed ?? ""}
          </button>
          <button
            type="button"
            disabled={props.disabled}
            onClick={() => props.choose(png("blue"), "blue")}
          >
            Blue face
          </button>
        </>
      );
    },
  });
  const setSources = (next: readonly RegisteredAgentAvatarSource[]) =>
    act(() => {
      sources = next;
      for (const listener of listeners) listener();
    });
  const agents = {
    save: vi.fn(async () => {}),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    avatarSources: () => sources,
    memberships: () => [],
  } as unknown as Agents & { save: ReturnType<typeof vi.fn> };
  sources = [source];
  const onClose = vi.fn();
  render(
    <AgentIdentityDialog
      agent={
        {
          key: "a".repeat(64),
          pubkey: "a".repeat(64),
          name: "  Ada　 Lovelace ",
          picture,
          relay: "https://a.example",
          place: "here",
        } as Agent
      }
      agents={agents}
      onClose={onClose}
      finalFocus={createRef()}
    />,
  );
  return {
    agents,
    onClose,
    source,
    setSources,
    names,
    choose: (...args: Parameters<Choose>) => choose(...args),
    user: userEvent.setup(),
    save: () => screen.getByRole("button", { name: "Save changes" }),
  };
}

it("shows a source as a tab and saves its pick as an ordinary uploaded image", async () => {
  const { agents, onClose, user, save, names } = setup();
  vi.mocked(uploadAvatar).mockResolvedValueOnce("https://images.example/face");
  expect(save()).toBeDisabled();
  await user.click(screen.getByRole("tab", { name: "Faces" }));
  // The host normalizes the name the source sees.
  expect(names.at(-1)).toBe("Ada Lovelace");
  await user.click(screen.getByRole("button", { name: /Red face/ }));
  await screen.findByRole("button", { name: "Red face red" });
  expect(
    screen.getByRole("button", { name: "Red face red" }),
  ).toBeInTheDocument();
  await user.click(save());
  await waitFor(() =>
    expect(agents.save).toHaveBeenCalledExactlyOnceWith("a".repeat(64), {
      picture: "https://images.example/face",
    }),
  );
  const [file, community] = vi.mocked(uploadAvatar).mock.calls[0] ?? [];
  expect(file?.type).toBe("image/png");
  expect(community).toBe("https://a.example");
  expect(onClose).toHaveBeenCalledOnce();
});

it("keeps a pick through its source's removal, so Save retries the same bytes", async () => {
  const { agents, user, save, setSources } = setup();
  vi.mocked(uploadAvatar)
    .mockRejectedValueOnce(new Error("Upload failed"))
    .mockResolvedValueOnce("https://images.example/face");
  await user.click(screen.getByRole("tab", { name: "Faces" }));
  await user.click(screen.getByRole("button", { name: /Red face/ }));
  await screen.findByRole("button", { name: "Red face red" });
  await user.click(save());
  expect(await screen.findByRole("alert")).toHaveTextContent("Upload failed");
  setSources([]);
  // The tab, its icon and controls go; the failed Save's pick stays.
  expect(
    screen.queryByRole("button", { name: /Red face/ }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "Faces" })).not.toBeInTheDocument();
  expect(screen.getByText(/source is off/)).toBeInTheDocument();
  await user.click(save());
  await waitFor(() =>
    expect(agents.save).toHaveBeenCalledExactlyOnceWith("a".repeat(64), {
      picture: "https://images.example/face",
    }),
  );
  const [first] = vi.mocked(uploadAvatar).mock.calls[0] ?? [];
  const [second] = vi.mocked(uploadAvatar).mock.calls[1] ?? [];
  expect(await second?.text()).toBe(await first?.text());
});

it("restores the saved avatar, Save off, when a source goes before a pick", async () => {
  const { user, save, setSources } = setup();
  await user.click(screen.getByRole("tab", { name: "Faces" }));
  screen.getByRole("button", { name: /Red face/ }).focus();
  setSources([]);
  await waitFor(() =>
    expect(
      screen.queryByRole("tab", { name: "Faces" }),
    ).not.toBeInTheDocument(),
  );
  expect(save()).toBeDisabled();
  const selected = screen.getByRole("tab", { name: "Upload image" });
  expect(selected).toHaveAttribute("aria-selected", "true");
  // Focus inside the vanished tab returns to the selected tab.
  expect(selected).toHaveFocus();
});

it("ignores a late, invalid or locked pick", async () => {
  const { user, save, setSources, choose, source } = setup();
  await user.click(screen.getByRole("tab", { name: "Faces" }));
  choose(new Blob(["text"], { type: "text/plain" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Choose a PNG, JPEG, GIF or WebP image under 380 KiB.",
  );
  choose(png(), "x".repeat(257));
  expect(await screen.findByRole("alert")).toHaveTextContent(/invalid seed/);
  const late = choose;
  setSources([]);
  await waitFor(() => expect(save()).toBeDisabled());
  late(png(), "red");
  // A re-enabled source is a fresh registration; the old one stays fenced.
  setSources([{ ...source }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(save()).toBeDisabled();
});

it("restores the previous choice and moves focus when a picked source goes before Save", async () => {
  const { user, save, setSources } = setup();
  await user.click(screen.getByRole("tab", { name: "Faces" }));
  await user.click(screen.getByRole("button", { name: /Red face/ }));
  await screen.findByRole("button", { name: "Red face red" });
  screen.getByRole("tab", { name: "Faces" }).focus();
  setSources([]);
  await waitFor(() => expect(save()).toBeDisabled());
  expect(screen.queryByRole("tab", { name: "Faces" })).not.toBeInTheDocument();
  expect(screen.queryByText(/source is off/)).not.toBeInTheDocument();
  const selected = screen.getByRole("tab", { name: "Upload image" });
  expect(selected).toHaveAttribute("aria-selected", "true");
  // The focused tab itself went away; focus returns to the selected tab.
  expect(selected).toHaveFocus();
});

it("lets only the newest pick land, whatever order decodes finish in", async () => {
  const { user, save, agents } = setup();
  vi.mocked(uploadAvatar).mockResolvedValueOnce("https://images.example/face");
  await user.click(screen.getByRole("tab", { name: "Faces" }));
  const waiting = holdDecodes();
  await user.click(screen.getByRole("button", { name: /Red face/ }));
  await user.click(screen.getByRole("button", { name: "Blue face" }));
  await waitFor(() => expect(waiting).toHaveLength(2));
  await act(async () => waiting[1]?.release());
  await screen.findByRole("button", { name: "Red face blue" });
  await act(async () => waiting[0]?.release());
  await new Promise((resolve) => setTimeout(resolve, 20));
  hold = undefined;
  await user.click(save());
  await waitFor(() => expect(agents.save).toHaveBeenCalled());
  const [file] = vi.mocked(uploadAvatar).mock.calls[0] ?? [];
  expect(await file?.text()).toBe("blue");
});

it("saves a pick made just before Save once it has decoded", async () => {
  const { user, save, agents } = setup();
  vi.mocked(uploadAvatar).mockResolvedValue("https://images.example/face");
  await user.click(screen.getByRole("tab", { name: "Faces" }));
  await user.click(screen.getByRole("button", { name: /Red face/ }));
  await screen.findByRole("button", { name: "Red face red" });
  // Blue is picked, and Save starts before its preview has updated.
  const waiting = holdDecodes();
  await user.click(screen.getByRole("button", { name: "Blue face" }));
  await waitFor(() => expect(waiting).toHaveLength(1));
  await user.click(save());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(uploadAvatar).not.toHaveBeenCalled();
  hold = undefined;
  await act(async () => waiting[0]?.release());
  await waitFor(() => expect(agents.save).toHaveBeenCalled());
  const [file] = vi.mocked(uploadAvatar).mock.calls[0] ?? [];
  expect(await file?.text()).toBe("blue");
});

it("waits for a source's pick still being made, and drops the ones it replaced", async () => {
  const { user, save, agents, choose } = setup();
  vi.mocked(uploadAvatar).mockResolvedValue("https://images.example/face");
  await user.click(screen.getByRole("tab", { name: "Faces" }));
  await user.click(screen.getByRole("button", { name: /Red face/ }));
  await screen.findByRole("button", { name: "Red face red" });
  let failOld: (reason: Error) => void = () => {};
  let finish: (image: Blob) => void = () => {};
  choose(new Promise<Blob>((_, reject) => (failOld = reject)), "old");
  choose(new Promise<Blob>((resolve) => (finish = resolve)), "green");
  await user.click(save());
  await act(async () => failOld(new Error("old pick failed")));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(uploadAvatar).not.toHaveBeenCalled();
  // A replaced pick's failure says nothing and doesn't stop Save.
  expect(screen.queryByText("old pick failed")).not.toBeInTheDocument();
  await act(async () => finish(png("green")));
  await waitFor(() => expect(agents.save).toHaveBeenCalled());
  const [file] = vi.mocked(uploadAvatar).mock.calls[0] ?? [];
  expect(await file?.text()).toBe("green");
});

it("refuses Save when the newest pick fails, then saves the next pick", async () => {
  const { user, save, agents, choose } = setup();
  vi.mocked(uploadAvatar).mockResolvedValue("https://images.example/face");
  await user.click(screen.getByRole("tab", { name: "Faces" }));
  await user.click(screen.getByRole("button", { name: /Red face/ }));
  await screen.findByRole("button", { name: "Red face red" });
  let fail: (reason: Error) => void = () => {};
  choose(new Promise<Blob>((_, reject) => (fail = reject)), "broken");
  await user.click(save());
  await act(async () => fail(new Error("Couldn't draw this face.")));
  // Save's refusal says why, once.
  await waitFor(() =>
    expect(screen.getAllByText("Couldn't draw this face.")).toHaveLength(1),
  );
  expect(uploadAvatar).not.toHaveBeenCalled();
  expect(agents.save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Blue face" }));
  await user.click(save());
  await waitFor(() => expect(agents.save).toHaveBeenCalled());
  const [file] = vi.mocked(uploadAvatar).mock.calls[0] ?? [];
  expect(await file?.text()).toBe("blue");
});

it("refuses every Save after the newest pick fails, rather than saving the face from before", async () => {
  const { user, save, agents, choose } = setup();
  vi.mocked(uploadAvatar).mockResolvedValue("https://images.example/face");
  await user.click(screen.getByRole("tab", { name: "Faces" }));
  await user.click(screen.getByRole("button", { name: /Red face/ }));
  await screen.findByRole("button", { name: "Red face red" });
  choose(Promise.reject(new Error("Couldn't draw this face.")), "broken");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't draw this face.",
  );
  // The failure is already showing when Save is pressed, twice.
  for (let attempt = 0; attempt < 2; attempt++) {
    await user.click(save());
    await waitFor(() => expect(save()).toBeEnabled());
    expect(
      screen.getAllByText("Couldn't draw this face.").length,
    ).toBeGreaterThan(0);
  }
  expect(uploadAvatar).not.toHaveBeenCalled();
  expect(agents.save).not.toHaveBeenCalled();
  // Another tab's avatar is what the preview shows, so it saves; back on
  // the source, its failure still stands.
  await user.click(screen.getByRole("tab", { name: "Gloopies" }));
  await user.click(screen.getByRole("tab", { name: "Faces" }));
  await user.click(save());
  await waitFor(() => expect(save()).toBeEnabled());
  expect(uploadAvatar).not.toHaveBeenCalled();
  // A pick that lands clears it.
  await user.click(screen.getByRole("button", { name: "Blue face" }));
  await screen.findByRole("button", { name: "Red face blue" });
  await user.click(save());
  await waitFor(() => expect(agents.save).toHaveBeenCalled());
  const files = vi.mocked(uploadAvatar).mock.calls.map(([file]) => file);
  expect(files).toHaveLength(1);
  expect(await files[0]?.text()).toBe("blue");
});

it.each([
  ["an Error with no message", () => new Error()],
  ["an Error with only spaces", () => new Error("   ")],
  ["no reason", () => undefined],
  ["an empty string", () => ""],
])("refuses Save when the newest pick rejects with %s", async (_, reason) => {
  const { user, save, agents, choose } = setup();
  vi.mocked(uploadAvatar).mockResolvedValue("https://images.example/face");
  await user.click(screen.getByRole("tab", { name: "Faces" }));
  await user.click(screen.getByRole("button", { name: /Red face/ }));
  await screen.findByRole("button", { name: "Red face red" });
  choose(Promise.reject(reason()), "blank");
  const pickError = "Choose a PNG, JPEG, GIF or WebP image under 380 KiB.";
  expect(await screen.findByRole("alert")).toHaveTextContent(pickError);
  await user.click(save());
  await waitFor(() => expect(save()).toBeEnabled());
  expect(screen.getAllByText(pickError).length).toBeGreaterThan(0);
  // Red is still shown, but it isn't the pick last made, so nothing saves.
  expect(uploadAvatar).not.toHaveBeenCalled();
  expect(agents.save).not.toHaveBeenCalled();
});

it("saves another tab's avatar after a source's pick fails", async () => {
  const { user, save, agents, choose } = setup();
  await user.click(screen.getByRole("tab", { name: "Faces" }));
  await user.click(screen.getByRole("button", { name: /Red face/ }));
  await screen.findByRole("button", { name: "Red face red" });
  choose(Promise.reject(new Error("Couldn't draw this face.")), "broken");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't draw this face.",
  );
  await user.click(screen.getByRole("tab", { name: "Gloopies" }));
  await user.click(save());
  await waitFor(() => expect(agents.save).toHaveBeenCalledOnce());
  // The Gloopie shown is saved; the failed source's bytes never upload.
  expect(uploadAvatar).not.toHaveBeenCalled();
  const [, change] = agents.save.mock.calls[0] ?? [];
  expect(change.picture).not.toMatch(/^data:|images\.example\/face/);
});

it("observes a promise handed to a choose whose source is gone", async () => {
  const { user, setSources, choose } = setup();
  await user.click(screen.getByRole("tab", { name: "Faces" }));
  setSources([]);
  const unhandled: unknown[] = [];
  const note = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", note);
  try {
    choose(Promise.reject(new Error("late failure")), "late");
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off("unhandledRejection", note);
  }
  expect(unhandled).toEqual([]);
});

it("ends Save's wait at once when the source goes, without asking to choose there", async () => {
  const { user, save, agents, choose, setSources } = setup();
  vi.mocked(uploadAvatar).mockResolvedValue("https://images.example/face");
  await user.click(screen.getByRole("tab", { name: "Faces" }));
  await user.click(screen.getByRole("button", { name: /Red face/ }));
  await screen.findByRole("button", { name: "Red face red" });
  choose(new Promise<Blob>(() => {}), "stuck");
  await user.click(save());
  const started = Date.now();
  setSources([]);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This avatar's source is off. Choose another avatar.",
  );
  expect(Date.now() - started).toBeLessThan(PICK_WAIT_MS / 2);
  expect(screen.queryByText(/Choose it again/)).not.toBeInTheDocument();
  expect(uploadAvatar).not.toHaveBeenCalled();
  expect(agents.save).not.toHaveBeenCalled();
});

it("rejects a pick the avatar previews could not show", async () => {
  const { user, choose } = setup();
  await user.click(screen.getByRole("tab", { name: "Faces" }));
  choose(new Blob([new Uint8Array(381 * 1024)], { type: "image/png" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Choose a PNG, JPEG, GIF or WebP image under 380 KiB.",
  );
  choose(`data:image/png;base64,${"A".repeat(512 * 1024)}`);
  expect(await screen.findByRole("alert")).toHaveTextContent("under 380 KiB");
});

it("retries a failed upload only in the community it started in", async () => {
  vi.mocked(uploadAvatar)
    .mockRejectedValueOnce(new Error("Upload failed"))
    .mockResolvedValueOnce("https://images.example/face");
  const source: RegisteredAgentAvatarSource = Object.freeze({
    id: "faces",
    key: "buzz.faces/faces",
    pluginId: "buzz.faces",
    revision: "bundled",
    title: "Faces",
    icon: <svg />,
    component: (props) => (
      <button type="button" onClick={() => props.choose(png("red"))}>
        Red face
      </button>
    ),
  });
  const sources = [source];
  const avatarRef = createRef<{
    prepare(destination: string | undefined): Promise<string>;
  }>();
  function Harness({ community }: { community: string }) {
    const [selection, setSelection] = useState<AvatarSelection>({
      kind: "image",
      picture,
    });
    return (
      <>
        <output>
          {selection.kind === "source" && selection.file ? "picked" : ""}
        </output>
        <AgentAvatarPicker
          name="Ada"
          selection={selection}
          disabled={false}
          community={community}
          sources={sources}
          onChange={setSelection}
          onBusyChange={() => {}}
          avatarRef={avatarRef}
        />
      </>
    );
  }
  const view = render(<Harness community="https://a.example" />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Faces" }));
  await user.click(screen.getByRole("button", { name: "Red face" }));
  expect(await screen.findByText("picked")).toBeInTheDocument();
  const prepare = (destination: string) => () => {
    const ref = avatarRef.current;
    if (!ref) throw new Error("no picker");
    return ref.prepare(destination);
  };
  await expect(act(prepare("https://a.example"))).rejects.toThrow(
    "Upload failed",
  );
  expect(uploadAvatar).toHaveBeenCalledOnce();
  // The community changes before the retry: Save refuses, uploads nothing.
  view.rerender(<Harness community="https://b.example" />);
  await expect(act(prepare("https://b.example"))).rejects.toThrow(
    /another community/,
  );
  expect(uploadAvatar).toHaveBeenCalledOnce();
  // Back in the first community, the retry sends the same bytes there.
  view.rerender(<Harness community="https://a.example" />);
  await expect(act(prepare("https://a.example"))).resolves.toBe(
    "https://images.example/face",
  );
  const [first, second] = vi.mocked(uploadAvatar).mock.calls;
  expect(second?.[1]).toBe("https://a.example");
  expect(first?.[1]).toBe("https://a.example");
  expect(await second?.[0].text()).toBe(await first?.[0].text());
});

it("starts a same-id replacement empty, even after a failed Save", async () => {
  const { user, save, setSources, source } = setup();
  vi.mocked(uploadAvatar).mockRejectedValueOnce(new Error("Upload failed"));
  await user.click(screen.getByRole("tab", { name: "Faces" }));
  await user.click(screen.getByRole("button", { name: /Red face/ }));
  await screen.findByRole("button", { name: "Red face red" });
  // An unsaved pick never passes to a new registration under the same id.
  setSources([{ ...source }]);
  await waitFor(() => expect(save()).toBeDisabled());
  expect(screen.getByRole("tab", { name: "Upload image" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(screen.getByRole("tab", { name: "Faces" }));
  expect(screen.getByRole("button", { name: "Red face" })).toBeInTheDocument();
  // A failed Save's attempt stays, but never selects or seeds the replacement.
  await user.click(screen.getByRole("button", { name: /Red face/ }));
  await screen.findByRole("button", { name: "Red face red" });
  await user.click(save());
  expect(await screen.findByRole("alert")).toHaveTextContent("Upload failed");
  setSources([{ ...source }]);
  expect(screen.getByRole("tab", { name: "Faces" })).toHaveAttribute(
    "aria-selected",
    "false",
  );
  expect(screen.getByText(/source is off/)).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Faces" }));
  expect(screen.getByRole("button", { name: "Red face" })).toBeInTheDocument();
});

it("keeps the attempt's preview when its source goes during the upload", async () => {
  const { user, save, setSources, agents } = setup();
  let land: (url: string) => void = () => {};
  vi.mocked(uploadAvatar).mockImplementationOnce(
    () => new Promise<string>((resolve) => (land = resolve)),
  );
  await user.click(screen.getByRole("tab", { name: "Faces" }));
  await user.click(screen.getByRole("button", { name: /Red face/ }));
  await screen.findByRole("button", { name: "Red face red" });
  await user.click(save());
  await waitFor(() => expect(uploadAvatar).toHaveBeenCalledOnce());
  setSources([]);
  // The tab goes at once; the preview stays what Save is writing.
  expect(screen.queryByRole("tab", { name: "Faces" })).not.toBeInTheDocument();
  expect(
    document.querySelector('img[src^="data:image/png;base64,"]'),
  ).not.toBeNull();
  expect(document.querySelector(`img[src="${picture}"]`)).toBeNull();
  await act(async () => land("https://images.example/face"));
  await waitFor(() =>
    expect(agents.save).toHaveBeenCalledExactlyOnceWith("a".repeat(64), {
      picture: "https://images.example/face",
    }),
  );
});

/** A picker with one source whose picks the test makes, and Save's handle. */
function pickerHarness() {
  let choose: Choose = () => {};
  const source: RegisteredAgentAvatarSource = Object.freeze({
    id: "faces",
    key: "buzz.faces/faces",
    pluginId: "buzz.faces",
    revision: "bundled",
    title: "Faces",
    icon: <svg />,
    component: (props) => {
      choose = props.choose;
      return null;
    },
  });
  const sources = [source];
  const avatarRef = createRef<{
    prepare(destination: string | undefined): Promise<string>;
  }>();
  function Harness({ community }: { community: string }) {
    const [selection, setSelection] = useState<AvatarSelection>({
      kind: "image",
      picture,
    });
    return (
      <>
        <output>
          {selection.kind === "source" && selection.file ? "picked" : ""}
        </output>
        <AgentAvatarPicker
          name="Ada"
          selection={selection}
          disabled={false}
          community={community}
          sources={sources}
          onChange={setSelection}
          onBusyChange={() => {}}
          avatarRef={avatarRef}
        />
      </>
    );
  }
  const prepare = (destination: string) => {
    const ref = avatarRef.current;
    if (!ref) throw new Error("no picker");
    return ref.prepare(destination);
  };
  return {
    Harness,
    prepare,
    choose: (...args: Parameters<Choose>) => choose(...args),
  };
}

it("refuses Save, without hanging, when a pick never arrives", async () => {
  vi.mocked(uploadAvatar).mockResolvedValue("https://images.example/face");
  const { Harness, prepare, choose } = pickerHarness();
  render(<Harness community="https://a.example" />);
  await userEvent.click(screen.getByRole("tab", { name: "Faces" }));
  act(() => choose(png("red"), "red"));
  expect(await screen.findByText("picked")).toBeInTheDocument();
  vi.useFakeTimers();
  try {
    act(() => choose(new Promise<Blob>(() => {}), "stuck"));
    const saving = prepare("https://a.example");
    const refused = expect(saving).rejects.toThrow(
      "Faces didn't finish this avatar. Choose it again, then save.",
    );
    await act(() => vi.advanceTimersByTimeAsync(PICK_WAIT_MS));
    await refused;
  } finally {
    vi.useRealTimers();
  }
  expect(uploadAvatar).not.toHaveBeenCalled();
  // A second Save with no new choice refuses too; it never sends red.
  await expect(act(() => prepare("https://a.example"))).rejects.toThrow(
    "Faces didn't finish this avatar. Choose it again, then save.",
  );
  expect(uploadAvatar).not.toHaveBeenCalled();
  // The stuck pick is retired; the next one saves.
  act(() => choose(png("blue"), "blue"));
  await waitFor(async () =>
    expect(await act(() => prepare("https://a.example"))).toBe(
      "https://images.example/face",
    ),
  );
  const [file] = vi.mocked(uploadAvatar).mock.calls[0] ?? [];
  expect(await file?.text()).toBe("blue");
});

it("uploads to the community Save names, not the one the picker shows", async () => {
  vi.mocked(uploadAvatar).mockResolvedValue("https://images.example/face");
  const { Harness, prepare, choose } = pickerHarness();
  const view = render(<Harness community="https://a.example" />);
  await userEvent.click(screen.getByRole("tab", { name: "Faces" }));
  act(() => choose(png("red"), "red"));
  expect(await screen.findByText("picked")).toBeInTheDocument();
  view.rerender(<Harness community="https://b.example" />);
  await act(() => prepare("https://a.example"));
  expect(vi.mocked(uploadAvatar).mock.calls[0]?.[1]).toBe("https://a.example");
});
