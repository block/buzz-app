// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { controlFixture } from "../../features/agents/control-testing";
import type { AgentControl } from "../../features/agents/control";
import {
  buildAgentSnapshot,
  encodeAgentSnapshot,
} from "../../features/agents/snapshot";
import { AgentSnapshotExport, AgentSnapshotImport } from "./AgentSnapshots";
import { uploadAvatar } from "../../features/profiles/avatar-upload";

vi.mock("../../features/profiles/avatar-upload", () => ({
  uploadAvatar: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function file(level: "none" | "core" = "none") {
  const snapshot = buildAgentSnapshot(controlFixture().agent, level, [
    { slug: "core", body: "private fixture memory" },
  ]);
  return new File(
    [Uint8Array.from(encodeAgentSnapshot(snapshot, "json"))],
    "agent.json",
    { type: "application/json" },
  );
}
function importControl() {
  const create = vi.fn(
    async (
      _requestId: string,
      _destination: string,
      _owner: string,
      _edit: unknown,
    ) => ({ ...controlFixture().agent, id: "new-id", pubkey: "cd".repeat(32) }),
  );
  const writeSnapshotMemory = vi.fn(async () => ({ written: 1, errors: [] }));
  const refresh = vi.fn(async () => {});
  const control = {
    create,
    writeSnapshotMemory,
    refresh,
    snapshot: () => ({
      data: {
        harnessOptions: [
          { command: "buzz-agent", defaultArgs: [], available: true },
        ],
        defaultWorkspace: "/local",
      },
    }),
  } as unknown as AgentControl;
  return { control, create, writeSnapshotMemory, refresh };
}
function choose(fileToRead: File) {
  fireEvent.change(screen.getByLabelText("Agent snapshot"), {
    target: { files: [fileToRead] },
  });
}

it("uploads an embedded reference avatar before native creation and saves its local URL", async () => {
  const h = importControl();
  vi.mocked(uploadAvatar).mockResolvedValueOnce(
    "https://relay.example.test/media/avatar.png",
  );
  const snapshot = buildAgentSnapshot(controlFixture().agent);
  snapshot.profile.avatarDataUrl = "data:image/png;base64,iVBORw0KGgo=";
  render(
    <AgentSnapshotImport
      control={h.control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      onClose={() => {}}
    />,
  );
  choose(new File([encodeAgentSnapshot(snapshot, "json")], "agent.json"));
  fireEvent.click(await screen.findByRole("button", { name: "Import" }));
  await waitFor(() => expect(h.create).toHaveBeenCalledOnce());
  expect(uploadAvatar).toHaveBeenCalledWith(
    expect.objectContaining({ type: "image/png" }),
    "https://relay.example.test",
    expect.any(AbortSignal),
  );
  expect(h.create.mock.calls[0]?.[3]).toEqual(
    expect.objectContaining({
      picture: "https://relay.example.test/media/avatar.png",
    }),
  );
});

it("previews instructions without creating, cancels, then creates an independent stopped identity without memory", async () => {
  const h = importControl();
  const close = vi.fn();
  render(
    <AgentSnapshotImport
      control={h.control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      onClose={close}
    />,
  );
  choose(file());
  expect(await screen.findByText("Help with the project.")).toBeVisible();
  expect(screen.getByText("No memory included — config only.")).toBeVisible();
  expect(h.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledOnce();
  expect(h.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => expect(h.create).toHaveBeenCalledOnce());
  expect(h.create.mock.calls[0]?.[3]).toEqual(
    expect.objectContaining({
      environment: {},
      workspace: "/local",
      systemPrompt: "Help with the project.",
    }),
  );
  expect(h.writeSnapshotMemory).not.toHaveBeenCalled();
});

it("publishes opted-in memory only after a fresh identity has been created", async () => {
  const h = importControl();
  render(
    <AgentSnapshotImport
      control={h.control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      onClose={() => {}}
    />,
  );
  choose(file("core"));
  expect(await screen.findByText("Help with the project.")).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent("plaintext");
  expect(h.writeSnapshotMemory).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() =>
    expect(h.writeSnapshotMemory).toHaveBeenCalledWith("new-id", [
      { slug: "core", body: "private fixture memory" },
    ]),
  );
  expect(h.create.mock.invocationCallOrder[0]).toBeLessThan(
    h.writeSnapshotMemory.mock.invocationCallOrder[0] ?? 0,
  );
});

it("does not publish memory if identity creation fails", async () => {
  const h = importControl();
  h.create.mockRejectedValueOnce(new Error("creation failed"));
  render(
    <AgentSnapshotImport
      control={h.control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      onClose={() => {}}
    />,
  );
  choose(file("core"));
  fireEvent.click(await screen.findByRole("button", { name: "Import" }));
  await waitFor(() =>
    expect(
      screen
        .getAllByRole("alert")
        .some((node) => node.textContent?.includes("creation failed")),
    ).toBe(true),
  );
  expect(h.writeSnapshotMemory).not.toHaveBeenCalled();
});

it("exports without reading memory by default and requires confirmation to read memory", async () => {
  const { agent } = controlFixture();
  const download = vi.fn(() => "blob:fixture");
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = download;
      static revokeObjectURL = vi.fn();
    },
  );
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  const refresh = vi.fn(async () => {});
  const dispose = vi.fn();
  const open = vi.fn(() => ({
    refresh,
    dispose,
    snapshot: () => ({
      status: "ready",
      listing: {
        partial: false,
        entries: [{ slug: "core", body: "private fixture memory" }],
      },
    }),
  }));
  const session = { agentMemories: { open } } as never;
  try {
    const mounted = render(
      <AgentSnapshotExport
        agent={agent}
        session={session}
        destination="https://relay.example.test/"
        onClose={() => {}}
      />,
    );
    expect(screen.getByLabelText("Memories")).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
    expect(open).not.toHaveBeenCalled();
    mounted.unmount();
    render(
      <AgentSnapshotExport
        agent={agent}
        session={session}
        destination="https://relay.example.test"
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Memories"), {
      target: { value: "core" },
    });
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(dispose).toHaveBeenCalledOnce();
  } finally {
    click.mockRestore();
  }
});

it("does not read a different community's memory while exporting local config", async () => {
  const { agent } = controlFixture();
  const open = vi.fn();
  const session = { agentMemories: { open } } as never;
  render(
    <AgentSnapshotExport
      agent={agent}
      session={session}
      destination="https://another.example.test"
      onClose={() => {}}
    />,
  );
  expect(screen.getByLabelText("Memories")).toBeDisabled();
  expect(open).not.toHaveBeenCalled();
});
