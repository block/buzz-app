// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, useEffect, useLayoutEffect, useRef } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  ToastNotice,
  ToastProvider,
  useToastNotification,
} from "../../shared/design-system/ui/Toast";
import { MediaViewerToasts } from "./MediaViewerToasts";

afterEach(cleanup);

it("mounts media immediately and scopes mount-time feedback inside the viewer", async () => {
  const measured: boolean[] = [];
  function Media() {
    const notify = useToastNotification();
    useEffect(() => {
      notify("Comment copied", "success");
    }, [notify]);
    return <div data-review-media="">Media</div>;
  }
  function Viewer() {
    const frame = useRef<HTMLElement>(null);
    useLayoutEffect(() => {
      measured.push(!!frame.current?.querySelector("[data-review-media]"));
    }, []);
    return (
      <section ref={frame} role="dialog" aria-label="Viewer">
        <MediaViewerToasts>
          <Media />
        </MediaViewerToasts>
      </section>
    );
  }
  render(
    <StrictMode>
      <ToastProvider>
        <ToastNotice title="Background update" />
        <Viewer />
      </ToastProvider>
    </StrictMode>,
  );
  const viewer = screen.getByRole("dialog", { name: "Viewer" });
  const notices = await screen.findAllByRole("dialog", {
    name: "Comment copied",
  });
  expect(notices.every((notice) => viewer.contains(notice))).toBe(true);
  expect(measured.length).toBeGreaterThan(0);
  expect(measured.every(Boolean)).toBe(true);
  expect(
    await screen.findByRole("dialog", { name: "Background update" }),
  ).toBeVisible();
  expect(
    within(viewer).queryByRole("dialog", { name: "Background update" }),
  ).toBeNull();
});
