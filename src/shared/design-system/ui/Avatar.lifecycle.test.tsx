// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Avatar, AvatarSourceContext } from "./Avatar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("reveals completed cached artwork on mount without waiting for a load event", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    32,
  );
  const view = render(
    <StrictMode>
      <Avatar src="https://example.test/a.png" alt="Agent" fallback="A" />
    </StrictMode>,
  );
  expect(view.container.querySelector("img")).toHaveAttribute(
    "data-loaded",
    "true",
  );
  expect(view.container.querySelector("img")).toHaveAttribute(
    "loading",
    "lazy",
  );
});

it("uses the fallback for an already completed broken image", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    0,
  );
  render(
    <Avatar src="https://example.test/broken.png" alt="Agent" fallback="A" />,
  );
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByRole("img", { name: "Agent" })).toHaveTextContent("A");
});

it("defers new sources, uses eager loading after success, and forgets a failed remount", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
  const props = {
    src: "https://example.test/warm-remount.png",
    alt: "Agent",
    fallback: "A",
  };
  const first = render(<Avatar {...props} />);
  const image = first.container.querySelector("img");
  if (!image) throw new Error("Expected initial artwork");
  expect(image).toHaveAttribute("loading", "lazy");
  fireEvent.load(image);
  first.unmount();

  const second = render(<Avatar {...props} />);
  const remount = second.container.querySelector("img");
  if (!remount) throw new Error("Expected remounted artwork");
  expect(remount).toHaveAttribute("loading", "eager");
  // Remembered success is only a scheduling hint: the browser may have evicted
  // the bytes, so actual image readiness still controls visibility.
  expect(remount).not.toHaveAttribute("data-loaded");
  fireEvent.error(remount);
  expect(screen.getByRole("img", { name: "Agent" })).toHaveTextContent("A");
  second.unmount();

  const retry = render(<Avatar {...props} />);
  expect(retry.container.querySelector("img")).toHaveAttribute(
    "loading",
    "lazy",
  );
});

it("bounds remembered sources and retains recently used artwork", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
  const src = (index: number) => `https://example.test/bounded-${index}.png`;
  const view = render(<Avatar src={src(0)} alt="Agent" fallback="A" />);
  const mount = (index: number) => {
    view.rerender(<Avatar src={src(index)} alt="Agent" fallback="A" />);
    const image = view.container.querySelector("img");
    if (!image) throw new Error("Expected bounded-cache artwork");
    return image;
  };
  fireEvent.load(mount(0));
  for (let index = 1; index < 128; index++) fireEvent.load(mount(index));
  // Refresh the oldest entry before adding another distinct source.
  expect(mount(0)).toHaveAttribute("loading", "eager");
  fireEvent.load(mount(0));
  fireEvent.load(mount(128));
  expect(mount(1)).toHaveAttribute("loading", "lazy");
  expect(mount(0)).toHaveAttribute("loading", "eager");
});

it("preserves delayed loading and error fallbacks, resetting when the source changes", () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
  const view = render(
    <Avatar src="https://example.test/a.png" alt="Agent" fallback="A" />,
  );
  const artwork = () => {
    const image = view.container.querySelector("img");
    if (!image) throw new Error("Expected avatar artwork");
    return image;
  };
  const avatar = screen.getByRole("img", { name: "Agent" });
  expect(avatar).toHaveTextContent("");
  act(() => vi.advanceTimersByTime(149));
  expect(avatar).toHaveTextContent("");
  act(() => vi.advanceTimersByTime(1));
  expect(avatar).toHaveTextContent("A");
  fireEvent.load(artwork());
  expect(artwork()).toHaveAttribute("data-loaded", "true");
  expect(avatar).toHaveTextContent("");

  view.rerender(
    <Avatar src="https://example.test/b.png" alt="Agent" fallback="A" />,
  );
  expect(artwork()).not.toHaveAttribute("data-loaded");
  expect(avatar).toHaveTextContent("");
  fireEvent.error(artwork());
  expect(avatar).toHaveTextContent("A");
  expect(document.querySelector("img")).toBeNull();
  view.rerender(
    <Avatar src="https://example.test/c.png" alt="Agent" fallback="A" />,
  );
  fireEvent.load(artwork());
  expect(artwork()).toHaveAttribute("data-loaded", "true");
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps a visible initial until artwork that replaces it is ready", () => {
  vi.useFakeTimers();
  // Images stay pending until the test fires their load or error event.
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
  const props = { alt: "Agent", fallback: "A" };
  const view = render(<Avatar {...props} />);
  const avatar = screen.getByRole("img", { name: "Agent" });
  const artwork = () => {
    const image = view.container.querySelector("img");
    if (!image) throw new Error("Expected avatar artwork");
    return image;
  };
  expect(avatar).toHaveTextContent("A");

  // A picture arriving for an avatar already showing its initial.
  view.rerender(<Avatar {...props} src="https://example.test/arrived.png" />);
  expect(artwork()).not.toHaveAttribute("data-loaded");
  expect(avatar).toHaveTextContent("A");
  act(() => vi.advanceTimersByTime(150));
  expect(avatar).toHaveTextContent("A");

  // A new source replacing a still-loading source whose initial is showing.
  view.rerender(<Avatar {...props} src="https://example.test/resized.png" />);
  expect(artwork()).toHaveAttribute("src", "https://example.test/resized.png");
  expect(avatar).toHaveTextContent("A");
  fireEvent.error(artwork());
  expect(avatar).toHaveTextContent("A");

  // A new source replacing a failed one.
  view.rerender(<Avatar {...props} src="https://example.test/ready.png" />);
  expect(artwork()).not.toHaveAttribute("data-loaded");
  expect(avatar).toHaveTextContent("A");
  fireEvent.load(artwork());
  expect(artwork()).toHaveAttribute("data-loaded", "true");
  expect(avatar).toHaveTextContent("");

  // Replacing loaded artwork keeps the delay: no initial flashes before the
  // next image has had its chance to be ready.
  view.rerender(<Avatar {...props} src="https://example.test/next.png" />);
  expect(avatar).toHaveTextContent("");
  act(() => vi.advanceTimersByTime(149));
  expect(avatar).toHaveTextContent("");
  act(() => vi.advanceTimersByTime(1));
  expect(avatar).toHaveTextContent("A");
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("retries a failed source behind the fallback until it or another mount loads", () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
  const src = "https://example.test/transient.png";
  const view = render(<Avatar src={src} alt="Preview" fallback="P" />);
  const avatar = screen.getByRole("img", { name: "Preview" });
  const artwork = () => view.container.querySelector("img");

  // Each failure keeps the initial visible; the retry requests the same source.
  for (const delay of [2_000, 10_000, 30_000]) {
    const image = artwork();
    if (!image) throw new Error("Expected avatar artwork");
    fireEvent.error(image);
    expect(artwork()).toBeNull();
    act(() => vi.advanceTimersByTime(delay - 1));
    expect(artwork()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(artwork()).toHaveAttribute("src", src);
    expect(artwork()).not.toHaveAttribute("data-loaded");
    expect(avatar).toHaveTextContent("P");
  }
  const last = artwork();
  if (!last) throw new Error("Expected final retry artwork");
  fireEvent.error(last);
  expect(vi.getTimerCount()).toBe(0);
  expect(avatar).toHaveTextContent("P");

  // Once timed retries are spent, another mount loading the source recovers it.
  const reply = render(<Avatar src={src} alt="Reply" fallback="R" />);
  const loaded = reply.container.querySelector("img");
  if (!loaded) throw new Error("Expected reply artwork");
  fireEvent.load(loaded);
  const recovered = artwork();
  if (!recovered) throw new Error("Expected recovered artwork");
  expect(recovered).toHaveAttribute("src", src);
  fireEvent.load(recovered);
  expect(recovered).toHaveAttribute("data-loaded", "true");
  expect(avatar).toHaveTextContent("");
  reply.unmount();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("shows a host-held source's local URL and fetches the rest through the host, never directly", async () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
  let resolve: ((url: string) => void) | undefined;
  const load = vi.fn(
    (_src: string) =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  const sources = {
    held: (src: string) => (src === "native:held" ? "blob:held" : undefined),
    load,
    forget: vi.fn(),
  };
  const view = render(
    <StrictMode>
      <AvatarSourceContext value={sources}>
        <Avatar src="native:held" alt="Held" fallback="H" />
        <Avatar src="native:new" alt="New" fallback="N" />
      </AvatarSourceContext>
    </StrictMode>,
  );
  const image = (name: string) =>
    view.container.querySelector(`[aria-label="${name}"] img`);
  // Local bytes need no lazy scheduling.
  expect(image("Held")).toHaveAttribute("src", "blob:held");
  expect(image("Held")).toHaveAttribute("loading", "eager");
  expect(load).not.toHaveBeenCalledWith("native:held");
  // A source the host has yet to fetch mounts no element that would request it.
  expect(image("New")).toBeNull();
  expect(load).toHaveBeenCalledWith("native:new");
  await act(async () => resolve?.("blob:new"));
  expect(image("New")).toHaveAttribute("src", "blob:new");
  fireEvent.load(image("New") as HTMLImageElement);
  expect(image("New")).toHaveAttribute("data-loaded", "true");
});

it("retries an avatar the host could not fetch, asking the host again", async () => {
  vi.useFakeTimers();
  const load = vi.fn(async (_src: string): Promise<string> => {
    throw new Error("Avatar unavailable: 502");
  });
  const held = vi.fn((_src: string): string | undefined => undefined);
  render(
    <AvatarSourceContext value={{ held, load, forget: vi.fn() }}>
      <Avatar src="native:transient" alt="Transient" fallback="T" />
    </AvatarSourceContext>,
  );
  const avatar = screen.getByRole("img", { name: "Transient" });
  await act(async () => {});
  expect(load).toHaveBeenCalledTimes(1);
  expect(avatar).toHaveTextContent("T");
  load.mockResolvedValueOnce("blob:transient");
  await act(async () => vi.advanceTimersByTime(2_000));
  expect(held).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenCalledTimes(2);
  expect(avatar.querySelector("img")).toHaveAttribute("src", "blob:transient");
  // The initial stays until the retried artwork is ready.
  expect(avatar).toHaveTextContent("T");
});

it("forgets held bytes that fail to decode, so the retry fetches them again", async () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
  let stored: string | undefined = "blob:broken";
  const held = vi.fn((_src: string) => stored);
  const forget = vi.fn((_src: string) => {
    stored = undefined;
  });
  const load = vi.fn(async (_src: string) => "blob:repaired");
  render(
    <AvatarSourceContext value={{ held, load, forget }}>
      <Avatar src="native:repaired" alt="Repaired" fallback="R" />
    </AvatarSourceContext>,
  );
  const avatar = screen.getByRole("img", { name: "Repaired" });
  expect(avatar.querySelector("img")).toHaveAttribute("src", "blob:broken");
  fireEvent.error(avatar.querySelector("img") as HTMLImageElement);
  expect(forget).toHaveBeenCalledWith("native:repaired");
  await act(async () => vi.advanceTimersByTime(2_000));
  expect(load).toHaveBeenCalledWith("native:repaired");
  expect(avatar.querySelector("img")).toHaveAttribute("src", "blob:repaired");
});

it("leaves a direct source's failure to the host cache it never used", () => {
  const forget = vi.fn();
  render(
    <AvatarSourceContext
      value={{ held: (src) => src, load: async (src) => src, forget }}
    >
      <Avatar src="https://example.test/a.png" alt="Direct" fallback="D" />
    </AvatarSourceContext>,
  );
  const image = screen
    .getByRole("img", { name: "Direct" })
    .querySelector("img") as HTMLImageElement;
  fireEvent.error(image);
  expect(forget).not.toHaveBeenCalled();
});
