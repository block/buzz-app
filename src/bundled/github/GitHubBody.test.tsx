// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  MAX_MARKDOWN_LENGTH,
  MAX_MARKDOWN_DEPTH,
} from "../../features/relay/message-content";
import { GitHubBody } from "./GitHubBody";
import { GitHubPanel } from "./index";

const url = "https://github.com/block/buzz-app/pull/327";
const before =
  "https://github.com/user-attachments/assets/81e77cff-0e61-4694-9a88-add0c1f997e4";
const after =
  "https://github.com/user-attachments/assets/dd1f7e4f-e2a4-4aec-b661-cb45032f29c5";
const image =
  "https://github.com/user-attachments/assets/cd0773ee-9861-46d9-8a0f-352ae951ec7f";
const audio = "https://github.com/user-attachments/files/123/recording.wav";
const metadata = `<details><summary>before.mp4</summary><video src="https://private-user-images.githubusercontent.com/1888043/659873452-81e77cff-0e61-4694-9a88-add0c1f997e4.mp4?jwt=expired"></video></details><video><source src="${after}" /></video>`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("renders GFM, original links, and Before/After players in document order", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      bodyHtml={metadata}
      body={`# Summary\n\n**Strong** and *emphasis* with [context](../328).\n\n- item\n- [x] done\n\n> quote\n\n| State | Result |\n| --- | --- |\n| Old | New |\n\n## Before\n\n${before}\n\n## After\n\n[Result recording](${after})`}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Summary", level: 1 }),
  ).toBeVisible();
  expect(container.querySelector("strong")).toHaveTextContent("Strong");
  expect(container.querySelector("em")).toHaveTextContent("emphasis");
  expect(screen.getByRole("link", { name: "context" })).toHaveAttribute(
    "href",
    "https://github.com/block/buzz-app/328",
  );
  expect(screen.getByRole("checkbox")).toBeChecked();
  expect(screen.getByRole("checkbox")).toBeDisabled();
  expect(screen.getByRole("table")).toHaveTextContent("StateResultOldNew");
  expect(container.querySelector("blockquote")).toHaveTextContent("quote");
  expect(
    [...container.querySelectorAll("h2, video")].map((node) =>
      node.tagName === "VIDEO" ? node.getAttribute("src") : node.textContent,
    ),
  ).toEqual(["Before", before, "After", after]);
  expect(
    screen.getByRole("link", { name: "Result recording" }),
  ).toHaveAttribute("href", after);
  for (const video of container.querySelectorAll("video")) {
    expect(video).toHaveAttribute("preload", "metadata");
    expect(video).not.toHaveAttribute("autoplay");
    expect(video.closest("p, a")).toBeNull();
  }
});

it("selects images, audio and named attachments while retaining descriptions and file links", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      bodyHtml={`<a href="${after}">capture.mov</a><audio src="${audio}"></audio>`}
      body={`![Screen description](${image})\n\n<img width="120" alt="HTML image" src="${image}" onerror="alert(1)">\n\n[Audio recording](${audio})\n\n[Movie](${after})\n\n[Archive](https://github.com/user-attachments/files/99/source.zip)`}
    />,
  );
  expect(screen.getByAltText("Screen description")).toHaveAttribute(
    "src",
    image,
  );
  expect(screen.getByAltText("HTML image")).not.toHaveAttribute("onerror");
  expect(container.querySelector("audio")).toHaveAttribute("src", audio);
  expect(container.querySelector("video")).toHaveAttribute("src", after);
  expect(screen.getByRole("link", { name: "Archive" })).toHaveAttribute(
    "href",
    "https://github.com/user-attachments/files/99/source.zip",
  );
  const audioElement = container.querySelector("audio");
  const videoElement = container.querySelector("video");
  if (!audioElement || !videoElement) throw new Error("Missing media");
  fireEvent.error(audioElement);
  fireEvent.error(videoElement);
  fireEvent.error(screen.getByAltText("Screen description"));
  expect(screen.getByText("Audio unavailable")).toBeVisible();
  expect(screen.getByText("Video unavailable")).toBeVisible();
  expect(screen.getByText("Image unavailable")).toBeVisible();
  for (const name of ["Screen description", "Audio recording", "Movie"])
    expect(screen.getByRole("link", { name })).toBeVisible();
});

it("never interprets literal code or executes HTML and unsafe links", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      bodyHtml={metadata}
      body={`\`${before}\`\n\n\`\`\`html\n<img src="${image}">\n${after}\n\`\`\`\n\n<script>alert(1)</script>\n\n<iframe src="https://evil.test"></iframe>\n\n[Bad](javascript:alert%281%29) ![Unsafe](data:image/svg+xml,bad)\n\n<img src="https://github.com.evil.test/image.png" alt="External">`}
    />,
  );
  expect(container.querySelectorAll("code")).toHaveLength(2);
  expect(container.querySelector("pre")).toHaveTextContent(after);
  expect(
    container.querySelector("script, iframe, video, img, audio"),
  ).toBeNull();
  expect(
    container.querySelector('a[href^="javascript:"], a[href^="data:"]'),
  ).toBeNull();
  expect(screen.getByRole("link", { name: "External" })).toHaveAttribute(
    "href",
    "https://github.com.evil.test/image.png",
  );
});

it("does not guess UUID media types or match asset IDs embedded in unrelated paths", () => {
  const { container, rerender } = render(
    <GitHubBody url={url} body={before} />,
  );
  expect(container.querySelector("video")).toBeNull();
  expect(screen.getByRole("link")).toHaveAttribute("href", before);
  rerender(
    <GitHubBody
      url={url}
      body={before}
      bodyHtml='<video src="https://private-user-images.githubusercontent.com/1888043/prefix-81e77cff-0e61-4694-9a88-add0c1f997e4.mp4"></video>'
    />,
  );
  expect(container.querySelector("video")).toBeNull();
});

it.each([`![Linked image](${image})`, `**![Linked image](${image})**`])(
  "keeps linked Markdown images out of anchors and preserves both destinations: %s",
  (content) => {
    const { container } = render(
      <GitHubBody
        url={url}
        body={`[${content}](https://example.com/review)`}
      />,
    );
    expect(screen.getByAltText("Linked image").closest("a, p")).toBeNull();
    expect(screen.getByRole("link", { name: "Linked image" })).toHaveAttribute(
      "href",
      image,
    );
    expect(
      screen.getByRole("link", { name: "https://example.com/review" }),
    ).toBeVisible();
    expect(container.querySelector("a a")).toBeNull();
  },
);

it.each([
  "x".repeat(MAX_MARKDOWN_LENGTH + 1),
  `${"> ".repeat(MAX_MARKDOWN_DEPTH + 1)}deep`,
])("uses a literal fallback for over-budget Markdown", (body) => {
  const { container } = render(
    <GitHubBody url={url} body={body} bodyHtml={metadata} />,
  );
  expect(container.textContent).toBe(body);
  expect(container.querySelector("blockquote, video")).toBeNull();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("retires pending PR loads, retries errors, and clears media when navigating", async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  const retry = deferred<Response>();
  const fetch = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(retry.promise);
  vi.stubGlobal("fetch", fetch);
  const { container, rerender } = render(
    <GitHubPanel target={url} close={() => {}} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
  expect(fetch).toHaveBeenCalledTimes(1);
  rerender(<GitHubPanel target={`${url}0`} close={() => {}} />);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]?.[1].signal.aborted).toBe(true);
  await act(async () => {
    first.resolve(
      new Response(
        JSON.stringify({
          title: "Retired PR",
          body: before,
          body_html: metadata,
        }),
      ),
    );
    await first.promise;
  });
  expect(screen.queryByText("Retired PR")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
  await act(async () => {
    second.resolve(new Response(null, { status: 500 }));
  });
  expect(screen.getByRole("alert")).toHaveTextContent("500");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
  await act(async () => {
    retry.resolve(
      new Response(
        JSON.stringify({
          title: "Current PR",
          body: before,
          body_html: metadata,
        }),
      ),
    );
  });
  expect(screen.getByRole("heading", { name: "Current PR" })).toBeVisible();
  expect(container.querySelector("video")).toHaveAttribute("src", before);
  const next = deferred<Response>();
  fetch.mockReturnValueOnce(next.promise);
  rerender(<GitHubPanel target={`${url}1`} close={() => {}} />);
  expect(container.querySelector("video")).toBeNull();
  await act(async () => {
    next.resolve(
      new Response(JSON.stringify({ title: "No metadata", body: before })),
    );
  });
  expect(screen.getByRole("heading", { name: "No metadata" })).toBeVisible();
  expect(container.querySelector("video")).toBeNull();
});
