import { test, expect } from "vitest";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("generated author package exposes shared messages, captured-read Undo, host, identity names, agent sessions, decisions, page navigation metadata, and composer send gates", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "buzz-author-consumer-"));
  const env = {
    ...process.env,
    PATH: `${resolve(root, "bin")}:${process.env.PATH}`,
  };
  const run = (command, args) => {
    const result = spawnSync(command, args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  };
  try {
    await symlink(
      resolve(root, "node_modules"),
      join(dir, "node_modules"),
      "dir",
    );
    run("node", ["scripts/build-author.mjs", join(dir, "author package")]);
    await writeFile(
      join(dir, "consumer.ts"),
      `
import { createElement } from "react";
import type { Context, DocumentEditorProps, DocumentEditorHandle, DocumentEditorSelection, ChannelMembersDialogProps, ChannelGeneralAccessProps, GeneralAccessPolicy, MemberChange, Delivery, HarnessConversation, McpHandler, StandaloneTurn, TurnResult, DecisionResult, Host, HostSecrets, HostSecretStatus, HostRequestOnceOptions, AddedTool, AddedToolContext, AddedToolReply, BuzzClient, Media, HostByteUpload, HostByteRequest, HostByteResponse, HostSavedBytes, PluginManifest, NamingPolicy, PagePreviewProps, PageSidebarProps, SidebarSectionContribution, SidebarSections, SidebarRowContribution, SidebarRows, ReadMutationResult, UnreadCapability, Backdrops, PluginUi, OutgoingMessage, SendGate, Seen, ReviewedInvocationCreateResponse, ReviewedInvocationSupport, HostResponseParent, HostByteSource, ReviewedInvocationExpectedMedia, ReviewedInvocationSourceSelection } from "@buzz/author";
export const manifest: PluginManifest = {
  id: "example.plugin", name: "Example", apiVersion: 1,
  host: {
    commands: [{ id: "status", program: "example-cli", args: ["status"], maxOutputBytes: 65536 }],
    networkOrigins: ["https://api.example.com"],
    managedFiles: true,
    publicImages: true,
    publicPages: true,
    secrets: [{ id: "api-key", label: "API key", origins: ["https://api.example.com"], header: "Authorization", scheme: "Bearer" }],
  },
};
const ExampleSidebar = ({ target, children }: PageSidebarProps) => {
  void target.kind;
  return children;
};
const ExamplePreview = ({ close }: PagePreviewProps) =>
  createElement("button", { type: "button", onClick: close }, "Open");
export const inject = ["agents", "decisions", "host", "identityNames", "pages", "relay"];
export function apply(ctx: Context) {
  const seen: Seen | undefined = ctx.reflect.get("seen");
  const key = "example.plugin/welcome";
  if (seen?.has(key) === false) seen.mark(key);
  const sharingPolicy: GeneralAccessPolicy = { subject: "record", allowPublic: false, visibilityDescription: () => "Record access changes." };
  const general: ChannelGeneralAccessProps = { capability: ctx.relay.snapshot().session.channelDetails, channelId: "record", policy: sharingPolicy };
  const picker: ChannelMembersDialogProps = { session: ctx.relay.snapshot().session, channelId: "record", trigger: { current: null }, close() {},
    nonMemberLabel: "Not in this record",
    memberActions: { canAdd: true, pending: false, async change(change: MemberChange, signal: AbortSignal) { void [change.expectedRole, signal.aborted]; } },
    accessSettings: createElement(ctx.conversation.ui.GeneralAccess, general), shareLink: "buzz://plugin?id=example.plugin" };
  createElement(ctx.conversation.ui.MembersDialog, picker);
  const gate: SendGate = { id: "later", hold: (message: OutgoingMessage) => message.text === "Later" };
  ctx.conversation.registerSendGate(gate);
  const held: OutgoingMessage = { channelId: "record", text: "Later", recipients: [], references: [], attachments: [], picks: {} };
  const sent: Promise<string> = ctx.conversation.publish(ctx.relay.snapshot().session, held);
  void sent;
  type HostPickerKeys = "agents" | "communities" | "navigator" | "signal" | "visit" | "canOpenLink" | "onOpenLink" | "onOpenMessage";
  const pickerHasNoHostProps: Extract<keyof ChannelMembersDialogProps, HostPickerKeys> extends never ? true : false = true;
  void pickerHasNoHostProps;
  // @ts-expect-error Host navigation visits are not plugin props.
  createElement(ctx.conversation.ui.MembersDialog, { ...picker, visit: true });
  const editorRef: { current: DocumentEditorHandle | null } = { current: null };
  const selection: DocumentEditorSelection = { start: 0, end: 1, source: false };
  const editor: DocumentEditorProps = { ref: editorRef, value: "**Hello**", onChange(value) { void value.length; }, editing: true, source: false, onSourceChange() {}, linkOpen: false, onLinkOpenChange() {}, onSave() {}, maxLength: 32768, destinations: [{label: "Reference", href: "buzz://plugin?id=example.plugin"}] };
  createElement(ctx.conversation.ui.DocumentEditor, editor);
  editorRef.current?.focusSelection(selection);
  // @ts-expect-error Source mode must be controlled with a boolean.
  const invalidEditor: DocumentEditorProps = { ...editor, source: "Markdown" };
  void invalidEditor;
  const ui: PluginUi | undefined = ctx.reflect.get("ui");
  if (ui) {
    void createElement(ui.Dialog, { open: true, onOpenChange: (open: boolean) => void open, title: "Edit",
      actions: createElement(ui.Button, { variant: "prominent", onClick: () => {} }, "Save") },
      createElement(ui.Field, { label: "Name" }, createElement(ui.Input, { onValueChange: (value: string) => void value })));
    void createElement(ui.Switch, { label: "Alerts", onCheckedChange: (checked: boolean) => void checked });
    // @ts-expect-error Internal and legacy variants are not part of the plugin contract.
    void createElement(ui.Button, { variant: "glass", children: "Glass" });
  }
  const unread: UnreadCapability = ctx.relay.snapshot().session.unread;
  const conversations: ReturnType<UnreadCapability["inbox"]> = unread.inbox();
  if (unread.markCapturedMessagesRead) {
    const capturedRead: Promise<ReadMutationResult> =
      unread.markCapturedMessagesRead(["example-message-id"]);
    void capturedRead.then(({ undo }) => undo?.());
  }
  if (typeof unread.messages === "function") {
    const listed = unread.messages("example-channel", 50);
    const more: true | undefined = listed.truncated ?? listed.incomplete;
    for (const item of listed.items ?? []) {
      const rootId: string | undefined = item.rootId;
      void [item.id, item.createdAt, item.authorId, rootId, more];
    }
  }
  for (const item of conversations.items) {
    for (const message of item.messages) {
      const id: string = message.id;
      const createdAt: number = message.createdAt;
      const mentioned: boolean = message.mentioned;
      void [id, createdAt, mentioned];
      // @ts-expect-error Shared message facts are immutable.
      message.mentioned = false;
    }
    // @ts-expect-error The shared projection does not expose Archive policy.
    item.archived;
  }
  for (const type of ctx.agents.types())
    for (const session of type.sessions?.list("") ?? [])
      void [session.channelId, session.root, session.at, session.status];
  const policy: NamingPolicy = {
    id: "alternative",
    resolve: (identities) => new Map(identities.map(({ pubkey, name }) => [pubkey, { name }])),
  };
  ctx.identityNames.register(policy);
  const host: Host = ctx.host;
  const upload: HostByteUpload = { url: "https://api.example.com/upload", field: "image", name: "image.png", contentType: "image/png" };
  void host.uploadBytesOnce?.(new Uint8Array([1]), upload, { callId: crypto.randomUUID() });

  // Older structural hosts need not implement saved credentials.
  const oldHost: Host = { runCommand: host.runCommand, request: host.request };
  void oldHost;
  const support: Promise<ReviewedInvocationSupport> | undefined = host.reviewedInvocationSupport?.();
  void support?.then((value) => value.credentialHttp?.continuation satisfies boolean | undefined);
  void host.reviewAndInvokeOnce?.(
    {
      version: 1,
      operation: "create",
      body: "{}",
      destination: { community: "c", viewer: "v", channel: "ch" },
      effect: { kind: "credential-http", method: "POST", url: "https://api.example.com/v1", headers: {}, slot: "api-key" },
      disclosure: { version: "example/1", text: "Costs one credit" },
    },
    { callId: "id", onCreateResponse: (response: ReviewedInvocationCreateResponse) => void response.safeBody },
  );
  // An existing explicitly typed async handler on a legacy request stays assignable.
  const observeCreate = async (response: ReviewedInvocationCreateResponse): Promise<void> => {
    void response.safeBody;
  };
  void host.reviewAndInvokeOnce?.(
    { version: 1, operation: "create", body: "{}", destination: { community: "c", viewer: "v", channel: "ch" }, effect: { kind: "credential-http", method: "POST", url: "https://api.example.com/v1", headers: {}, slot: "api-key" }, disclosure: { version: "example/1", text: "Costs one credit" } },
    { callId: "id", onCreateResponse: observeCreate },
  );
  const expectedMedia: ReviewedInvocationExpectedMedia = { version: 1, kind: "video", container: "mp4", codec: "h264", width: 1280, height: 720, durationMs: 5000, toleranceMs: 50, maxBytes: 1 };
  void host.reviewAndInvokeOnce?.(
    { version: 1, operation: "create", body: "{}", destination: { community: "c", viewer: "v", channel: "ch" }, effect: { kind: "credential-http", method: "POST", url: "https://api.example.com/v1", headers: {}, slot: "api-key" }, disclosure: { version: "example/1", text: "Costs one credit" }, expectedMedia },
    { callId: "id", onCreateResponse: async (): Promise<ReviewedInvocationSourceSelection> => ({ source: { sha256: "0".repeat(64), size: 1 } }) },
  );
  void support?.then((value) => value.credentialHttp?.expectedMedia satisfies 1 | undefined);
  void support?.then((value) => value.reviewStart satisfies 1 | undefined);
  // A start signal carries nothing: it is not approval or a result.
  void host.reviewAndInvokeOnce?.(
    { version: 1, operation: "create", body: "{}", destination: { community: "c", viewer: "v", channel: "ch" }, effect: { kind: "credential-http", method: "POST", url: "https://api.example.com/v1", headers: {}, slot: "api-key" }, disclosure: { version: "example/1", text: "Costs one credit" } },
    { callId: "id", onCreateResponse: () => {}, onStarted: () => {} },
  );
  // @ts-expect-error The start signal has no approval or receipt argument.
  void host.reviewAndInvokeOnce?.({ operation: "x", body: "", destination: { community: "c", viewer: "v", channel: "ch" } }, { callId: "id", onStarted: (approved: boolean) => void approved });
  void host.request({ url: "https://api.example.com/tasks/t", parent: { version: 1, callId: "id" } }).then((response) => response.parent satisfies HostResponseParent | undefined);
  void host.requestBytes?.({ url: "https://cdn.example.com/out.mp4", maxBytes: 1, parent: { version: 1, callId: "id" } }).then((response) => response.source satisfies HostByteSource | undefined);
  const selected: HostByteRequest = { maxBytes: 1, parent: { version: 1, callId: "id" }, result: { version: 1, sequence: 2 } };
  void host.requestBytes?.(selected);
  // @ts-expect-error A result read names a native selection, never also a URL.
  host.requestBytes?.({ ...selected, url: "https://cdn.example.com/out.mp4" });
  // @ts-expect-error A result read continues one call.
  host.requestBytes?.({ maxBytes: 1, result: { version: 1, sequence: 2 } });
  // @ts-expect-error A parent read continues one call; it carries no credential slot authority.
  void host.request({ url: "https://api.example.com/tasks/t", parent: { version: 1, callId: "id", slot: "api-key" } });
  // @ts-expect-error A selection references the retained source; it carries no bytes or path.
  const sourceSelection: ReviewedInvocationSourceSelection = { source: { sha256: "", size: 1 }, path: "/tmp/x" };
  void sourceSelection;
  // @ts-expect-error Approval stays in the host card; there is no accept option.
  void host.reviewAndInvokeOnce?.({ operation: "x", body: "", destination: { community: "c", viewer: "v", channel: "ch" } }, { callId: "id", accept: true });
  if (host.secrets) {
    const secrets: HostSecrets = host.secrets;
    const status: Promise<HostSecretStatus> = secrets.status("api-key");
    const saved: Promise<void> = secrets.set("api-key", "value");
    const cleared: Promise<void> = secrets.clear("api-key");
    const enrolled: Promise<HostSecretStatus> | undefined = secrets.enroll?.("api-key");
    void enrolled;
    // @ts-expect-error Private entry accepts a slot, never a credential value.
    secrets.enroll?.("api-key", "value");
    const statuses: readonly HostSecretStatus[] = ["saved", "missing", "unreadable"];
    void [status, saved, cleared, statuses];
    // @ts-expect-error Clearing returns no credential value.
    const clearedValue: Promise<string> = secrets.clear("api-key");
    void clearedValue;
    // @ts-expect-error Saved credentials never expose values.
    secrets.read("api-key");
    // @ts-expect-error Saved credentials never export values.
    secrets.export("api-key");
    // @ts-expect-error Saved credentials never peek at values.
    secrets.peek("api-key");
    // @ts-expect-error A write returns no credential value.
    const value: Promise<string> = secrets.set("api-key", "value");
    // @ts-expect-error Status is the exact three-value union.
    const invalid: HostSecretStatus = "unknown";
    void [value, invalid];
  }
  // @ts-expect-error Byte GET never accepts a secret slot.
  host.requestBytes?.({ url: "https://api.example.com", maxBytes: 1, secret: "api-key" });
  // @ts-expect-error Byte multipart never accepts a secret slot.
  host.uploadBytesOnce?.(new Uint8Array([1]), { ...upload, secret: "api-key" }, { callId: crypto.randomUUID() });
  // @ts-expect-error Archive uploads never accept a secret slot.
  host.upload?.({ url: "https://api.example.com", file: { field: "file", path: "/home/a.tar.gz", name: "a.tar.gz", contentType: "application/gzip" }, secret: "api-key" });
  const tool: AddedTool = { name: "example_image", description: "Read an image", inputSchema: {},
    async call(client: BuzzClient, context: AddedToolContext): Promise<AddedToolReply> {
      void [context.channel, context.root, context.topLevel, context.wholeChannel];
      const media: Media = await client.media("abc.png");
      return media.data ?? "No inline image";
    },
  };
  ctx.agents.addTool(tool);
  const { harness } = ctx.agents;
  ctx.agents.register({
    id: "example",
    title: "Example",
    defaults: () => ({ config: {} }),
    async run(delivery: Delivery) {
      const conversation: HarnessConversation | undefined = await harness.conversation(delivery, "thread");
      if (!conversation) return delivery.ignored?.();
      void [conversation.key, conversation.channel, conversation.root, conversation.topLevel, conversation.where];
      const system: string = await harness.systemPrompt(delivery, { scope: "thread", cwd: "~", instructions: "", tools: false });
      const first = await harness.turnPrompt(delivery, conversation);
      const prompt = await harness.turnPrompt(delivery, conversation, { cursor: first.cursor });
      const next: string = prompt.cursor;
      const tools: McpHandler = harness.tools(delivery.agent, conversation, { read: async () => new Uint8Array() });
      void host.serveMcp?.(tools);
      void [system, prompt.text, next];
      prompt.restore();
      await harness.reply(delivery.agent, conversation, "Done", { notifyOwner: true });
    },
    async runOnce(turn: StandaloneTurn): Promise<TurnResult> {
      const text = await turn.prompt();
      if (text !== undefined) void harness.standalonePrompt(turn.delivery.agent, text);
      void harness.tools(turn.delivery.agent);
      return { ok: true };
    },
  });
  void host.runCommand("status").then((output: string | null) => void output);
  void host.request({
    url: "https://api.example.com/graphql",
    method: "POST",
    headers: { Authorization: "Bearer sample" },
    body: "{}",
    secret: "api-key",
  }).then((response) => void response.status);
  // Final synchronous eligibility is part of the optional protected method.
  if (typeof host.requestOnce === "function") {
    const options: HostRequestOnceOptions = {
      callId: "12345678-1234-4234-8234-123456789abc",
      isEligible: () => true,
    };
    void host.requestOnce({ url: "https://api.example.com/submit", method: "POST", secret: "api-key" }, options);
    // @ts-expect-error Final caller eligibility must be synchronous.
    const invalid: HostRequestOnceOptions = { callId: options.callId, isEligible: async () => true };
    void invalid;
  }
  const bytes: HostByteRequest = { url: "https://api.example.com/bytes", maxBytes: 1024 };
  void host.requestBytes?.(bytes).then((response: HostByteResponse) => {
    const body: Uint8Array = response.body;
    void host.saveBytes?.(body, { sha256: "0".repeat(64), releaseAfterSend: true }).then((saved: HostSavedBytes) => {
      const acknowledged: true | undefined = saved.releaseAfterSend;
      void [saved.path, saved.size, saved.sha256, saved.expiresAt, acknowledged];
    });
  });
  // @ts-expect-error Byte GET has no caller headers.
  host.requestBytes?.({ ...bytes, headers: {} });
  // @ts-expect-error Release policy must be a boolean, not a callback.
  host.saveBytes?.(new Uint8Array([1]), { sha256: "0".repeat(64), releaseAfterSend: () => true });
  // @ts-expect-error Managed save has no caller account.
  host.saveBytes?.(new Uint8Array([1]), { sha256: "0".repeat(64), owner: "caller supplied" });
  // @ts-expect-error Managed save has no caller path.
  host.saveBytes?.(new Uint8Array([1]), { sha256: "0".repeat(64), path: "/chosen" });
  ctx.pages.register({
    id: "main",
    title: "Example",
    component: () => null,
    icon: "data:image/png;base64,iVBOR",
    primary: true,
    placement: "toolbar",
    sidebar: ExampleSidebar,
    preview: ExamplePreview,
  });
  ctx.pages.register({
    id: "bad-preview",
    title: "Bad preview",
    component: () => null,
    // @ts-expect-error A page preview must be a React component.
    preview: "card",
  });
  ctx.pages.register({
    id: "bad-sidebar",
    title: "Bad sidebar",
    component: () => null,
    // @ts-expect-error A page sidebar must be a React component.
    sidebar: 1,
  });
  const section: SidebarSectionContribution = {
    version: 1,
    id: "work",
    title: "Work",
    icon: "W",
    rows: {
      snapshot: () => [{ id: "today", label: "Today" }],
      subscribe: () => () => {},
    },
    select: () => ({ version: 1, kind: "home" }),
    actions: [{ id: "new", label: "New", icon: createElement("span"), onSelect: () => {} }],
  };
  const backdrops: Backdrops | undefined = ctx.reflect.get("backdrops");
  backdrops?.register({ id: "glow", component: () => null });
  // @ts-expect-error A backdrop must be a React component.
  backdrops?.register({ id: "bad-glow", component: "div" });
  const sidebar: SidebarSections | undefined = ctx.reflect.get("sidebarSections");
  sidebar?.register(section);
  // @ts-expect-error Sidebar contribution versions are explicit.
  sidebar?.register({ ...section, version: 2 });
  // @ts-expect-error Row counts are numeric, not display text.
  const badCount: SidebarSectionContribution = { ...section, rows: { snapshot: () => [{ id: "bad", label: "Bad", count: "two" }], subscribe: () => () => {} } };
  void badCount;
  const hostRows: SidebarRows | undefined = ctx.reflect.get("sidebarRows");
  const decoration: SidebarRowContribution = {
    version: 1, id: "details",
    render: (row, Default) => row.kind === "dm" ? createElement("div", { title: row.label }, Default) : Default,
    sortModes: [{ id: "reverse", label: "Reverse", compare: (a, b) => b.label.localeCompare(a.label) }],
  };
  hostRows?.register(decoration);
  // @ts-expect-error Host row contribution versions are explicit.
  hostRows?.register({ ...decoration, version: 2 });
  // @ts-expect-error Render results must be elements or an intentional null.
  hostRows?.register({ version: 1, id: "invalid", render: () => "text" });
  ctx.pages.register({
    id: "other",
    title: "Other",
    component: () => null,
    // @ts-expect-error A page icon is a data URL string.
    icon: 1,
  });
  for (const placement of ["sidebar", "dock", "topbar", "toolbar"] as const)
    ctx.pages.register({ id: placement, title: placement, component: () => null, primary: true, placement });
  ctx.pages.register({
    id: "bad-placement", title: "Bad placement", component: () => null,
    // @ts-expect-error A placement must name a supported navigation location.
    placement: "floating",
  });
  // @ts-expect-error Programs must be declared in the manifest, not supplied at runtime.
  host.runCommand("example-cli", ["status"]);
  void ctx.decisions
    .decide({
      state: "The build is broken on main.",
      questions: {
        urgent: { type: "yes_no", instructions: "It needs attention now." },
        topic: { type: "choice", instructions: "Topic", options: { build: "CI", other: "Other" } },
        severity: { type: "score", instructions: "Severity", levels: ["low", "high"] },
      },
      timeoutMs: 5000,
    })
    .then((result: DecisionResult) => {
      if (result.outcome === "failed") return void result.reason;
      const answer = result.answers.urgent;
      if (answer?.type === "yes_no") void answer.probability;
      void [result.backend, result.model];
    });
  void ctx.decisions.decide({
    state: "x",
    // @ts-expect-error A question needs a supported type.
    questions: { bad: { type: "freeform", instructions: "x" } },
  });
  void ctx.decisions.backend();
  ctx.decisions.retireProvider("retired");
  // @ts-expect-error Only Settings chooses the backend.
  ctx.decisions.setBackend("typesafe");
}
// @ts-expect-error Host construction is not exported to plugin authors.
import type { createServices } from "@buzz/author";
`,
    );
    await writeFile(
      join(dir, "document-consumer.ts"),
      `
import type { ComponentProps } from "react";
import type { Agents, Context, MarkdownProps, PanelWorkspaceItem, PanelWorkspaceProps, PanelSplit } from "@buzz/author";
export const inject = ["react", "agents", "conversation", "panels"];
export function apply(ctx: Context) {
  const React = ctx.react;
  type TranscriptProps = ComponentProps<NonNullable<Agents["ui"]>["Transcript"]>;
  type Agent = TranscriptProps["agent"];
  function Activity(agent: Agent) {
    const Transcript = ctx.agents.ui?.Transcript;
    if (!Transcript) return null;
    const props: TranscriptProps = {
      agent,
      read: async () => ({
        turns: [{
          turnId: "turn-1", channelId: "chan-1", threadRootId: null,
          triggeringEventIds: ["a".repeat(64)], newSession: true, config: [],
          startedAt: 1_700_000_000_000, endedAt: 1_700_000_001_000,
          outcome: "ended", partial: false,
          items: [
            { id: "m-1", at: 1_700_000_000_500, type: "message", text: "Done", posted: true, messageId: "b".repeat(64) },
          ],
        }],
      }),
      readKey: "chan-1",
      working: false,
      reading: "Reading…",
      missing: null,
      failed: "Could not read transcript",
    };
    return React.createElement(Transcript, props);
  }
  void Activity;
  // @ts-expect-error Agents.ui is optional on older hosts and must be checked.
  void ctx.agents.ui.Transcript;
  const document: MarkdownProps = { content: "**Hello**", scale: "document", openLink: () => false };
  function Reader() {
    ctx.panels.useTabTitle?.("A page", React.createElement("span", null, "A"));
    return React.createElement(ctx.conversation.ui.Markdown, document);
  }
  function Workspace() {
    const split: PanelSplit = ctx.panels.ui.useSplit(undefined, "example.plugin:reader", 448, 320);
    const items: PanelWorkspaceItem[] = [{ id: "page", label: "Page", content: React.createElement(Reader), close: () => false }];
    const props: PanelWorkspaceProps = { items, value: "page", select: () => {} };
    return React.createElement("div", { ref: split.ref, style: split.style }, split.handle,
      React.createElement(ctx.panels.ui.Workspace, props));
  }
  void Workspace;
  // @ts-expect-error Channels tab menus are host-owned.
  const tabMenu: PanelWorkspaceProps = { items: [], value: "", select: () => {}, tabMenu: undefined };
  // @ts-expect-error Channels drag plumbing is host-owned.
  const drag: PanelWorkspaceProps = { items: [], value: "", select: () => {}, drag: undefined };
  // @ts-expect-error Conversation identity is host-owned.
  const identity: PanelWorkspaceProps = { items: [], value: "", select: () => {}, identity: undefined };
  // @ts-expect-error Native Close ownership is not a plugin option.
  const main: PanelWorkspaceProps = { items: [], value: "", select: () => {}, main: true };
  // @ts-expect-error Channels selection adoption is host-owned.
  const adoption: PanelWorkspaceProps = { items: [], value: "", select: () => {}, adoptSelection: undefined };
  // @ts-expect-error The injected component has the same narrow contract.
  React.createElement(ctx.panels.ui.Workspace, { items: [], value: "", select: () => {}, main: true });
  // @ts-expect-error Host opening identities are not plugin tab data.
  const instance: PanelWorkspaceItem = { id: "page", label: "Page", content: null, instance: {} };
  void [tabMenu, drag, identity, main, adoption, instance];
  // @ts-expect-error Host link dispatch must synchronously report acceptance.
  const bad: MarkdownProps = { content: "", openLink: async () => true };
  // @ts-expect-error Only supported host heading scales are public.
  const badScale: MarkdownProps = { content: "", scale: "custom" };
  // @ts-expect-error Tab content is required.
  const missing: PanelWorkspaceItem = { id: "page", label: "Page" };
  void [bad, missing];
}
`,
    );
    await writeFile(
      join(dir, "plugin-status-consumer.ts"),
      `
import type { Context } from "@buzz/author";
export function observePlugin(ctx: Context) {
  const owner = ctx.pluginOwner;
  if (!owner) return;
  const id: string = owner.id;
  const revision: string = owner.revision;
  const active: boolean = ctx.pluginStatus.isActive(id, revision);
  const stop: () => void = ctx.pluginStatus.subscribe(() => {
    const current: boolean = ctx.pluginStatus.isActive(id, revision);
    void current;
  });
  stop();
  const settled: boolean | undefined = ctx.pluginStatus.settled?.();
  const withoutReadiness: Context["pluginStatus"] = {
    isActive: () => true,
    subscribe: () => () => {},
  };
  void [active, settled, withoutReadiness];
  // @ts-expect-error A revision is a string, not a generation number.
  ctx.pluginStatus.isActive(id, 1);
  // @ts-expect-error Subscription requires a callback.
  ctx.pluginStatus.subscribe("changed");
  // @ts-expect-error Readiness is optional and must be checked.
  ctx.pluginStatus.settled();
  // @ts-expect-error Installed ownership is readonly.
  owner.revision = "replacement";
}
`,
    );
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          types: [],
          paths: {
            "@buzz/author": ["./author package/types/plugins/author.d.ts"],
          },
        },
        files: [
          "consumer.ts",
          "plugin-status-consumer.ts",
          "document-consumer.ts",
        ],
      }),
    );
    // Only generated declarations and the external consumer, never host source.
    run("pnpm", ["exec", "tsc", "-p", join(dir, "tsconfig.json")]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
