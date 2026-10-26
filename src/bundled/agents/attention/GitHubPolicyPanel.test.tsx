// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Host, HostProcessOptions } from "../../../features/host/service";
import { GitHubPolicyPanel } from "./GitHubPolicyEditor";

const homes: string[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(
    homes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "attention-policy-ui-"));
  homes.push(home);
  const path = join(home, ".buzz/preferences/github-pr.json");
  const host: { spawn: NonNullable<Host["spawn"]> } = {
    spawn: async (id, options: HostProcessOptions = {}) => {
      expect(id).toBe("attention-policy");
      const child = spawn(
        "python3",
        [
          resolve("src-tauri/resources/attention/buzz-attention-policy"),
          ...(options.args ?? []),
        ],
        { env: { ...process.env, HOME: home } },
      );
      child.stdout.on("data", (data) => options.onStdout?.(String(data)));
      child.stderr.on("data", (data) => options.onStderr?.(String(data)));
      return {
        write: async () => {},
        end: async () => {},
        kill: async () => {
          child.kill();
        },
        exited: new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        }),
      };
    },
  };
  return { host, path };
}
async function edit() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit allowlist" }),
  );
  return screen.findByRole("textbox", { name: "Trusted organizations" });
}
it("shows the shared warning and saves through the adapter to the same file, preserving rejected drafts", async () => {
  const { host, path } = await fixture();
  render(<GitHubPolicyPanel host={host} />);
  expect(
    await screen.findByText(/GitHub comments and reviews are off/),
  ).toBeTruthy();
  expect(screen.getByText(/CI and PR-state monitoring continue/)).toBeTruthy();
  const organizations = await edit();
  fireEvent.change(organizations, { target: { value: "example-org" } });
  const authors = screen.getByRole("textbox", { name: "Trusted commenters" });
  fireEvent.change(authors, { target: { value: "review-bot[bot]" } });
  fireEvent.click(screen.getByRole("button", { name: "Save allowlist" }));
  await screen.findByText("GitHub author allowlist saved.");
  const policy = JSON.parse(await readFile(path, "utf8"));
  expect(policy).toEqual({
    version: 1,
    trustedOrganizations: ["example-org"],
    trustedAuthors: ["review-bot[bot]"],
    ignoredAuthors: [],
  });
  expect(screen.queryByText(/GitHub comments and reviews are off/)).toBeNull();
  fireEvent.change(authors, { target: { value: "bad/login" } });
  fireEvent.click(screen.getByRole("button", { name: "Save allowlist" }));
  await screen.findByText("trustedAuthors must contain GitHub logins");
  expect(authors).toHaveValue("bad/login");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(policy);
  fireEvent.click(
    screen.getByRole("button", { name: "Cancel editing allowlist" }),
  );
  await edit();
  expect(
    screen.getByRole("textbox", { name: "Trusted commenters" }),
  ).toHaveValue("review-bot[bot]");
  fireEvent.change(
    screen.getByRole("textbox", { name: "Trusted commenters" }),
    { target: { value: "" } },
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Trusted organizations" }),
    { target: { value: "" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save allowlist" }));
  await screen.findByText(/GitHub comments and reviews are off/);
  expect(JSON.parse(await readFile(path, "utf8")).trustedAuthors).toEqual([]);
});
it("reports invalid file contents and recovers from a failed initial read without inventing a policy", async () => {
  const { host, path } = await fixture();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "{invalid");
  const native = host.spawn;
  host.spawn = vi
    .fn()
    .mockRejectedValueOnce(new Error("Host unavailable"))
    .mockImplementation(native);
  render(<GitHubPolicyPanel host={host} />);
  await screen.findByText("Host unavailable");
  expect(screen.queryByRole("button", { name: "Save allowlist" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry GitHub author settings" }),
  );
  await screen.findByText(/GitHub comments and reviews are off/);
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(/property name/),
  );
  const organizations = await edit();
  fireEvent.change(organizations, { target: { value: "trusted-org" } });
  fireEvent.click(screen.getByRole("button", { name: "Save allowlist" }));
  await screen.findByText("GitHub author allowlist saved.");
  expect(screen.queryByRole("alert")).toBeNull();
});
