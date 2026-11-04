// @vitest-environment jsdom
import * as React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { card } from "./card.tsx";
import { createEmbeddings } from "./embed.ts";
import { load, save } from "./settings.ts";
import { DEFAULT_SETTINGS } from "./types.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
function mounted(active = () => true) {
  const request = vi.fn(
    async (_input: import("../../features/host/service").HostRequest) => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        model: "test",
        data: [{ index: 0, embedding: [3, 4] }],
      }),
    }),
  );
  const embeddings = createEmbeddings({ request }, load);
  const Card = card(
    React,
    { status: () => "ready", subscribe: () => () => {} },
    embeddings,
  );
  render(<Card active={active} />);
  const change = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  return { embeddings, request, change };
}
it("saves explicitly, tests through the real client, and reports model dimensions and elapsed time", async () => {
  const r = mounted();
  r.change("Embedding server URL", "http://127.0.0.1:8080");
  r.change("API key (optional)", "secret");
  expect(load().embeddingUrl).toBeUndefined();
  fireEvent.click(screen.getByText("Test"));
  expect(await screen.findByText(/test: 2 dimensions · \d+ ms/)).toBeTruthy();
  expect(load().embeddingUrl).toBe("http://127.0.0.1:8080");
  expect(r.request).toHaveBeenCalledWith(
    expect.objectContaining({
      url: "http://127.0.0.1:8080/v1/embeddings",
      headers: expect.objectContaining({ Authorization: "Bearer secret" }),
    }),
  );
  expect(screen.getByLabelText("API key (optional)").getAttribute("type")).toBe(
    "password",
  );
});
it("URL edits remove the previous credential, and saving other preferences preserves endpoint settings", async () => {
  save({
    ...DEFAULT_SETTINGS,
    embeddingUrl: "https://old.test",
    embeddingKey: "old-secret",
  });
  const r = mounted();
  r.change("Embedding server URL", "https://new.test");
  fireEvent.click(screen.getByText("Test"));
  await screen.findByText(/test: 2 dimensions/);
  expect(load().embeddingKey).toBe("");
  expect(r.request.mock.calls[0]?.[0]?.headers).not.toHaveProperty(
    "Authorization",
  );
  fireEvent.click(
    screen.getByRole("switch", { name: "Search the whole relay" }),
  );
  expect(load().embeddingUrl).toBe("https://new.test");
});
it("clearing the URL is saved without a test request and preserves newer scope changes", () => {
  save({ ...DEFAULT_SETTINGS, embeddingUrl: "https://old.test" });
  const r = mounted();
  fireEvent.click(
    screen.getByRole("switch", { name: "Search the whole relay" }),
  );
  r.change("Embedding server URL", "");
  fireEvent.click(screen.getByText("Save"));
  expect(load()).toMatchObject({ scope: "relay", embeddingUrl: "" });
  expect(r.request).not.toHaveBeenCalled();
  expect(screen.getByText(/Lexical recall only/)).toBeTruthy();
});
it("inactive cards cannot save or test", () => {
  save({ ...DEFAULT_SETTINGS, embeddingUrl: "https://old.test" });
  const r = mounted(() => false);
  r.change("Embedding server URL", "https://new.test");
  fireEvent.click(screen.getByText("Save"));
  fireEvent.click(screen.getByText("Test"));
  expect(load().embeddingUrl).toBe("https://old.test");
  expect(r.request).not.toHaveBeenCalled();
});
it("invalid URLs never save or send, and host errors never expose credentials", async () => {
  const r = mounted();
  r.change("Embedding server URL", "https://user:secret@example.test");
  fireEvent.click(screen.getByText("Test"));
  expect(screen.getByRole("alert").textContent).toContain("valid HTTPS");
  expect(r.request).not.toHaveBeenCalled();
  r.change("Embedding server URL", "https://example.test");
  r.request.mockRejectedValueOnce(new Error("secret native path"));
  fireEvent.click(screen.getByText("Test"));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Embedding test failed. Check the server, URL and key.",
  );
});
it("a late test cannot publish a result for edited settings", async () => {
  const r = mounted();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = r.request.getMockImplementation();
  if (!original) throw new Error("Missing request fixture");
  r.request.mockImplementationOnce(async () => {
    await gate;
    return original({ url: "https://example.test" });
  });
  r.change("Embedding server URL", "https://example.test");
  fireEvent.click(screen.getByText("Test"));
  expect(screen.getByText("Testing…").hasAttribute("disabled")).toBe(true);
  r.change("Embedding server URL", "https://another.test");
  await act(async () => release());
  expect(screen.queryByText(/test: 2 dimensions/)).toBeNull();
});
