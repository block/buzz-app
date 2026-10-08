// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ProbeDto,
  RelayStaffBackend,
  StaffContext,
  StaffFailure,
  StaffOutcome,
  StaffRequest,
} from "../../features/relay-staff/contract";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { RelayStaff } from "./RelayStaff";
import { createStaff, type StaffTarget } from "./staff";

const signer = "a".repeat(64);
const member = "b".repeat(64);
const relay = "wss://team.example.com";
const origin = "https://admin.example.com";

type Handler = (
  request: StaffRequest,
) => StaffOutcome<unknown> | Promise<StaffOutcome<unknown>>;
let routes: Partial<Record<StaffRequest["route"], Handler>>;
let calls: StaffRequest[];
let contexts: StaffContext[];
let saved: string[];

const ok = (value: unknown): StaffOutcome<unknown> => ({ ok: true, value });
function fail(patch: Partial<StaffFailure>): StaffOutcome<unknown> {
  return {
    ok: false,
    failure: {
      category: "rejected",
      status: 400,
      bodyComplete: true,
      bodyEmpty: false,
      code: null,
      notSent: false,
      authLost: patch.status === 401 || patch.status === 403,
      message: "Rejected",
      ...patch,
    },
  };
}
const routeMissing = fail({
  category: "unsupported",
  status: 404,
  bodyEmpty: true,
  message: "",
});
const probe = (patch: Partial<ProbeDto> = {}) =>
  ok({
    status: "ok",
    authMode: "nip98",
    role: "moderator",
    source: "db",
    canAct: true,
    canStaff: false,
    ...patch,
  });

const backend: RelayStaffBackend = {
  available: true,
  discover: async () => origin,
  request: (async (context, request) => {
    calls.push(request);
    contexts.push(context);
    const handler = routes[request.route];
    return handler
      ? handler(request)
      : fail({ message: `no ${request.route}` });
  }) as RelayStaffBackend["request"],
  attachment: (async () => {
    return ok(new Uint8Array([1, 2, 3]));
  }) as RelayStaffBackend["attachment"],
  saveAttachment: async (_context, ref) => {
    saved.push(ref.sha256);
    return { state: "saved" };
  },
};

function mount() {
  const staff = createStaff(backend, () => ({ relay, signer }));
  staff.ensure();
  const view = (
    <ToastProvider>
      <RelayStaff staff={staff} active={() => true} />
    </ToastProvider>
  );
  return { staff, ...render(view), view };
}
const sent = (route: StaffRequest["route"]) =>
  calls.filter((c) => c.route === route);

beforeEach(() => {
  calls = [];
  contexts = [];
  saved = [];
  routes = {
    probe: () => probe(),
    listReports: () => ok([]),
    listFeedback: () => ok([]),
    listCommunities: () =>
      ok({
        items: [{ id: "c1", host: "team.example.com", icon: null }],
        nextCursor: null,
      }),
    searchMembers: () =>
      ok({
        items: [
          { pubkey: member, displayName: "Bob", nip05: null, avatarUrl: null },
        ],
      }),
    getMember: () =>
      ok({
        pubkey: member,
        profile: null,
        role: "member",
        banned: false,
        mutedUntil: null,
        isStaff: false,
      }),
  };
});
afterEach(cleanup);

async function openCommunityActions() {
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /team\.example\.com/ }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
  fireEvent.change(screen.getByLabelText("Member"), {
    target: { value: "Bob" },
  });
  fireEvent.click(await screen.findByRole("button", { name: /Bob/ }));
  await screen.findByText("Role: member");
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
}

it("denied staff see their key and nothing else is requested", async () => {
  routes.probe = () => fail({ category: "forbidden", status: 403 });
  mount();
  expect(await screen.findByText("Access denied")).toBeInTheDocument();
  expect(screen.getByText(signer)).toBeInTheDocument();
  expect(calls.map((c) => c.route)).toEqual(["probe"]);
});

it("remembers the role for the same identity and admin host", async () => {
  const { staff } = mount();
  await screen.findByText(/Connected as moderator/);
  cleanup();
  render(
    <ToastProvider>
      <RelayStaff staff={staff} active={() => true} />
    </ToastProvider>,
  );
  await screen.findByText(/Connected as moderator/);
  expect(sent("probe")).toHaveLength(1);
});

it("re-probes after an authorization loss", async () => {
  routes.listReports = () => fail({ category: "unauthorized", status: 401 });
  mount();
  await waitFor(() => expect(sent("probe")).toHaveLength(2));
});

it("shows Operators only to operators and lists reports deployment-wide", async () => {
  mount();
  await screen.findByRole("tab", { name: "Reports" });
  expect(
    screen.queryByRole("tab", { name: "Operators" }),
  ).not.toBeInTheDocument();
  await waitFor(() =>
    expect(sent("listReports")[0]).toMatchObject({ query: { scope: "all" } }),
  );
  cleanup();
  routes.probe = () => probe({ role: "operator", canStaff: true });
  mount();
  expect(
    await screen.findByRole("tab", { name: "Operators" }),
  ).toBeInTheDocument();
});

it("auth-disabled relays are read-only", async () => {
  routes.probe = () => probe({ authMode: "disabled" });
  mount();
  expect(await screen.findByText(/console is read-only/)).toBeInTheDocument();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /team\.example\.com/ }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
  expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();
});

it("keeps the Communities tab and explains an unsupported directory", async () => {
  routes.listCommunities = () => routeMissing;
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  expect(
    await screen.findByText(
      "This relay doesn't support community browsing yet.",
    ),
  ).toBeInTheDocument();
});

it("never sends a pasted secret key as a search", async () => {
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  await screen.findByRole("button", { name: /team\.example\.com/ });
  const before = sent("listCommunities").length;
  fireEvent.change(screen.getByLabelText("Search communities"), {
    target: { value: `nsec1${"q".repeat(58)}` },
  });
  expect(await screen.findByText(/That's a secret key/)).toBeInTheDocument();
  expect(sent("listCommunities")).toHaveLength(before);
});

it("an unresolved direct action keeps its request id across leaving the page", async () => {
  let first = true;
  routes.directAction = () => {
    if (first) {
      first = false;
      return fail({ category: "ambiguous", status: 502, message: "" });
    }
    return ok({ state: "succeeded", actionId: "a1", replayed: true });
  };
  mount();
  await openCommunityActions();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await screen.findByRole("button", { name: "Retry" });
  // Leave the community page and come back: the reviewed action survives.
  // The console's own Reports tab comes before the community's Reports section.
  fireEvent.click(
    screen.getAllByRole("tab", { name: "Reports" })[0] as HTMLElement,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Communities" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /team\.example\.com/ }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(sent("directAction")).toHaveLength(2));
  const [a, b] = sent("directAction") as Extract<
    StaffRequest,
    { route: "directAction" }
  >[];
  expect(a).toEqual(b);
  expect(a).toMatchObject({
    communityHost: "team.example.com",
    action: "ban",
    target: member,
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument(),
  );
});

it("a pending direct action keeps the same request for a retry", async () => {
  routes.directAction = () => ok({ state: "pending" });
  mount();
  await openCommunityActions();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  expect(await screen.findByText(/still applying it/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(sent("directAction")).toHaveLength(2));
  const [a, b] = sent("directAction");
  expect(a).toEqual(b);
});

it("a request id conflict is an error and is never resent under a new id", async () => {
  routes.directAction = () =>
    fail({ status: 409, code: "request_id_conflict" });
  mount();
  await openCommunityActions();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  expect(
    await screen.findByText(/request id was already used/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
  expect(sent("directAction")).toHaveLength(1);
});

it("explains an unsupported direct action on that action only", async () => {
  routes.directAction = () => routeMissing;
  mount();
  await openCommunityActions();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  expect(
    await screen.findByText("This relay doesn't support direct actions yet."),
  ).toBeInTheDocument();
  // The feature stays available for the next action.
  expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
});

it("refuses to review a staff target", async () => {
  routes.getMember = () =>
    ok({
      pubkey: member,
      profile: null,
      role: "member",
      banned: false,
      mutedUntil: null,
      isStaff: true,
    });
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /team\.example\.com/ }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
  fireEvent.change(screen.getByLabelText("Member"), {
    target: { value: "Bob" },
  });
  fireEvent.click(await screen.findByRole("button", { name: /Bob/ }));
  expect(
    await screen.findByText(/Relay staff can't be banned/),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();
});

const report = {
  id: "r1",
  communityId: "c1",
  communityHost: "team.example.com",
  reportEventId: "e".repeat(64),
  reporterPubkey: member,
  targetKind: "pubkey",
  target: member,
  channelId: null,
  reportType: "spam",
  status: "open",
  createdAt: "2026-10-08T00:00:00Z",
};
const failedAction = {
  id: "act1",
  requestId: "q1",
  actorPubkey: signer,
  actorRole: "moderator",
  action: "ban",
  status: "failed",
  reason: null,
  expiresAt: null,
  errorMessage: "relay timeout",
  createdAt: "2026-10-08T00:00:00Z",
  updatedAt: "2026-10-08T00:00:00Z",
};

async function openReport() {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
}

it("an ambiguous resolve is retried with the same request id", async () => {
  routes.listReports = () => ok([report]);
  routes.getReport = () => ok(report);
  let first = true;
  routes.resolveReport = () => {
    if (!first) return ok({ status: "resolved", activeAction: null });
    first = false;
    return fail({
      category: "ambiguous",
      status: null,
      bodyComplete: false,
      message: "",
    });
  };
  await openReport();
  fireEvent.click(await screen.findByRole("button", { name: "Ban" }));
  expect(
    screen.getByText("Sent verbatim to the affected user."),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Retry: Ban/ }));
  await waitFor(() => expect(sent("resolveReport")).toHaveLength(2));
  const [a, b] = sent("resolveReport");
  expect(a).toEqual(b);
  expect(a).toMatchObject({ id: "r1", action: "ban" });
});

it("a definite rejection releases the frozen resolve", async () => {
  routes.listReports = () => ok([report]);
  routes.getReport = () => ok(report);
  routes.resolveReport = () => fail({ status: 422, code: "invalid" });
  await openReport();
  fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
  expect(
    screen.getByText("Sent verbatim to the reporter."),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Dismiss/ }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /Confirm: Dismiss/ }),
    ).toBeEnabled(),
  );
  expect(
    screen.queryByRole("button", { name: /Retry/ }),
  ).not.toBeInTheDocument();
});

it("offers only the actions a target kind allows", async () => {
  routes.listReports = () =>
    ok([{ ...report, targetKind: "blob", target: "x" }]);
  routes.getReport = () => ok({ ...report, targetKind: "blob", target: "x" });
  await openReport();
  await screen.findByRole("button", { name: "Dismiss" });
  expect(screen.getByRole("button", { name: "Escalate" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Ban" })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Delete" }),
  ).not.toBeInTheDocument();
});

it("cancels a failed enforcement by its action id", async () => {
  const failed = {
    ...report,
    status: "processing",
    actionId: "act1",
    activeAction: failedAction,
  };
  routes.listReports = () => ok([failed]);
  routes.getReport = () => ok(failed);
  routes.cancelReport = () => ok({ status: "open", activeAction: null });
  await openReport();
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel and reopen" }),
  );
  await waitFor(() =>
    expect(sent("cancelReport")).toEqual([
      { route: "cancelReport", id: "r1", actionId: "act1" },
    ]),
  );
  await waitFor(() => expect(sent("getReport").length).toBeGreaterThan(1));
});

it("changes feedback status and previews and saves attachments", async () => {
  const sha = "f".repeat(64);
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: () => "blob:x",
      revokeObjectURL: revoke,
    }),
  );
  routes.listFeedback = () =>
    ok([
      {
        id: "f1",
        communityId: "c1",
        communityHost: "team.example.com",
        submitterPubkey: member,
        bodySummary: "Broken",
        status: "new",
        receivedAt: "2026-10-08T00:00:00Z",
      },
    ]);
  routes.getFeedback = () =>
    ok({
      id: "f1",
      communityId: "c1",
      communityHost: "team.example.com",
      eventId: "e".repeat(64),
      submitterPubkey: member,
      body: "Broken",
      status: "new",
      tags: [["imeta", `x ${sha}`, "m image/png", "size 3"]],
      eventCreatedAt: "2026-10-08T00:00:00Z",
      receivedAt: "2026-10-08T00:00:00Z",
    });
  routes.setFeedbackStatus = (request) =>
    ok({ status: (request as { status: string }).status });
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Feedback" }));
  fireEvent.click(await screen.findByRole("button", { name: /Broken/ }));
  expect(await screen.findByAltText("Feedback attachment")).toHaveAttribute(
    "src",
    "blob:x",
  );
  fireEvent.click(screen.getByRole("button", { name: "reviewed" }));
  await waitFor(() =>
    expect(sent("setFeedbackStatus")).toEqual([
      { route: "setFeedbackStatus", id: "f1", status: "reviewed" },
    ]),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saved).toEqual([sha]));
  cleanup();
  expect(revoke).toHaveBeenCalledWith("blob:x");
});

it("config-backed staff can't be removed, and removing yourself re-probes", async () => {
  const fixedKey = "c".repeat(64);
  routes.probe = () => probe({ role: "operator", canStaff: true });
  routes.listOperators = () =>
    ok([
      { pubkey: fixedKey, effectiveRole: "operator", sources: ["config"] },
      { pubkey: signer, effectiveRole: "operator", sources: ["db"] },
    ]);
  routes.deleteOperator = () => ok({ deleted: signer });
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Operators" }));
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2),
  );
  const [fixed, self] = screen.getAllByRole("button", {
    name: "Remove",
  }) as HTMLElement[];
  expect(fixed).toBeDisabled();
  fireEvent.click(self as HTMLElement);
  expect(
    await screen.findByText(/removing your own staff access/),
  ).toBeInTheDocument();
  const confirm = screen
    .getAllByRole("button", { name: "Remove" })
    .at(-1) as HTMLElement;
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(sent("deleteOperator")).toEqual([
      { route: "deleteOperator", pubkey: signer },
    ]),
  );
  await waitFor(() => expect(sent("probe")).toHaveLength(2));
});

/** Mounts the card for a selection that the test can change. */
function mountSwitchable(local: RelayStaffBackend = backend) {
  const selection = { relay, signer };
  const staff = createStaff(local, () => ({ ...selection }));
  staff.ensure();
  const card = () => (
    <ToastProvider>
      <RelayStaff staff={staff} active={() => true} />
    </ToastProvider>
  );
  const view = render(card());
  const select = async (patch: Partial<typeof selection>) => {
    await act(async () => {
      Object.assign(selection, patch);
      staff.refresh();
    });
  };
  const reopen = () => {
    cleanup();
    render(card());
  };
  return { staff, view, select, reopen };
}

/** Holds the next answer on `route` until `release`; other calls use `then`. */
function holdNext(route: StaffRequest["route"], then: Handler) {
  let release: ((outcome: StaffOutcome<unknown>) => void) | null = null;
  let armed = true;
  routes[route] = (request) => {
    if (!armed) return then(request);
    armed = false;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  return {
    started: () => waitFor(() => expect(release).toBeTypeOf("function")),
    release: (outcome: StaffOutcome<unknown>) =>
      act(async () => release?.(outcome)),
  };
}

async function freezeDirectBan() {
  routes.directAction = () => fail({ category: "ambiguous", status: 502 });
  await openCommunityActions();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await screen.findByRole("button", { name: "Retry" });
}
async function reopenActions() {
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /team\.example\.com/ }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
}
/** The retried request is the first one, byte for byte, in the same context. */
async function expectIdenticalRetry(route: StaffRequest["route"]) {
  await waitFor(() => expect(sent(route)).toHaveLength(2));
  const [first, second] = sent(route);
  expect(second).toEqual(first);
  const at = contexts.filter((_, i) => calls[i]?.route === route);
  expect(at[1]).toEqual(at[0]);
}

it("a report Retry after leaving the report resends the frozen request", async () => {
  routes.listReports = () => ok([report]);
  routes.getReport = () => ok(report);
  routes.resolveReport = () => fail({ category: "ambiguous", status: 502 });
  await openReport();
  fireEvent.click(await screen.findByRole("button", { name: "Ban" }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  await screen.findByRole("button", { name: /Retry: Ban/ });
  fireEvent.click(screen.getByRole("button", { name: "Back to reports" }));
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Retry: Ban/ }));
  await expectIdenticalRetry("resolveReport");
});

it("an unresolved direct action survives closing and reopening the card", async () => {
  const { reopen } = mountSwitchable();
  await freezeDirectBan();
  reopen();
  await reopenActions();
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await expectIdenticalRetry("directAction");
});

it("an unresolved direct action survives losing and regaining access", async () => {
  const { staff } = mountSwitchable();
  await freezeDirectBan();
  routes.probe = () => fail({ category: "forbidden", status: 403 });
  await act(async () => {
    const context = staff.context();
    if (context) await staff.probe(context, true);
  });
  await screen.findByText("Access denied");
  routes.probe = () => probe();
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await reopenActions();
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await expectIdenticalRetry("directAction");
});

it("a held action is never offered under another identity", async () => {
  const { select } = mountSwitchable();
  await freezeDirectBan();
  await select({ signer: member });
  await waitFor(() => expect(sent("probe")).toHaveLength(2));
  await reopenActions();
  expect(await screen.findByRole("button", { name: "Review" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  await select({ signer });
  await reopenActions();
  expect(await screen.findByRole("button", { name: "Retry" })).toBeVisible();
});

it("switching identity on the same relay probes as the new identity", async () => {
  const { select } = mountSwitchable();
  await screen.findByText(/Connected as moderator/);
  routes.probe = () => fail({ category: "forbidden", status: 403 });
  await select({ signer: member });
  await screen.findByText("Access denied");
  expect(screen.getByText(member)).toBeInTheDocument();
  expect(sent("probe")).toHaveLength(2);
  expect(contexts.at(-1)?.signer).toBe(member);
});

it("an attachment preview 401 re-checks the role", async () => {
  const original = backend.attachment;
  backend.attachment = (async () =>
    fail({
      category: "unauthorized",
      status: 401,
    })) as RelayStaffBackend["attachment"];
  try {
    await openFeedback("m image/png");
    await screen.findByText("The relay did not accept your signature.");
    await waitFor(() => expect(sent("probe")).toHaveLength(2));
  } finally {
    backend.attachment = original;
  }
});

it("an attachment Save 401 re-checks the role", async () => {
  const original = backend.saveAttachment;
  backend.saveAttachment = async () => ({
    state: "failed",
    failure: (
      fail({ category: "unauthorized", status: 401 }) as {
        failure: StaffFailure;
      }
    ).failure,
  });
  try {
    await openFeedback("m application/pdf");
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent("probe")).toHaveLength(2));
  } finally {
    backend.saveAttachment = original;
  }
});

async function openFeedback(mime: string) {
  const item = {
    id: "f1",
    communityId: "c1",
    communityHost: "team.example.com",
    status: "new",
    receivedAt: "2026-10-08T00:00:00Z",
  };
  routes.listFeedback = () => ok([{ ...item, bodySummary: "Attachment" }]);
  routes.getFeedback = () =>
    ok({
      ...item,
      body: "Attachment",
      tags: [["imeta", `x ${"f".repeat(64)}`, mime, "size 3"]],
    });
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Feedback" }));
  fireEvent.click(await screen.findByRole("button", { name: /Attachment/ }));
}

it("operators on a read-only relay can't add, change or remove staff", async () => {
  routes.probe = () => probe({ role: "operator", authMode: "disabled" });
  routes.listOperators = () =>
    ok([
      {
        pubkey: member,
        effectiveRole: "moderator",
        sources: ["db"],
      },
    ]);
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Operators" }));
  await screen.findByText("moderator");
  expect(screen.queryByText("Add staff")).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  expect(screen.queryByLabelText(/Role for/)).toBeNull();
});

it("a late directory page for an earlier search is dropped", async () => {
  let release!: (outcome: StaffOutcome<unknown>) => void;
  routes.listCommunities = (request) => {
    const q = (request as { q?: string }).q;
    if (q === "old")
      return new Promise((resolve) => {
        release = resolve;
      });
    if (q === "new")
      return ok({
        items: [{ id: "new", host: "new.example.com", icon: null }],
        nextCursor: null,
      });
    return ok({ items: [], nextCursor: null });
  };
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  const search = screen.getByLabelText("Search communities");
  fireEvent.change(search, { target: { value: "old" } });
  await waitFor(() => expect(release).toBeTypeOf("function"));
  fireEvent.change(search, { target: { value: "new" } });
  await screen.findByRole("button", { name: "new.example.com" });
  await act(async () =>
    release(
      ok({
        items: [{ id: "old", host: "old.example.com", icon: null }],
        nextCursor: null,
      }),
    ),
  );
  expect(screen.queryByRole("button", { name: "old.example.com" })).toBeNull();
});

it("a late member search for an earlier query is dropped", async () => {
  let release!: (outcome: StaffOutcome<unknown>) => void;
  const result = (displayName: string, pubkey: string) =>
    ok({ items: [{ pubkey, displayName, nip05: null, avatarUrl: null }] });
  routes.searchMembers = (request) => {
    const q = (request as { q: string }).q;
    if (q === "Old")
      return new Promise((resolve) => {
        release = resolve;
      });
    return result("Newbie", member);
  };
  mount();
  await reopenActions();
  const input = await screen.findByLabelText("Member");
  fireEvent.change(input, { target: { value: "Old" } });
  await waitFor(() => expect(release).toBeTypeOf("function"));
  fireEvent.change(input, { target: { value: "New" } });
  await screen.findByRole("button", { name: /Newbie/ });
  await act(async () => release(result("Oldie", "c".repeat(64))));
  expect(screen.queryByRole("button", { name: /Oldie/ })).toBeNull();
});

/**
 * Both selections are visited first, so their roles are remembered and the
 * switch back and forth needs no probe: the console stays authorized, and
 * only the stale-read guards keep the earlier answer off the screen.
 */
async function lateReadAfterSwitch(
  away: Partial<StaffTarget>,
  local?: RelayStaffBackend,
) {
  const { select } = mountSwitchable(local);
  await screen.findByText(/Connected as moderator/);
  await select(away);
  await screen.findByText(/Connected as moderator/);
  const late = holdNext("listReports", () => ok([]));
  await select({ relay, signer });
  await late.started();
  await select(away);
  await waitFor(() => expect(sent("listReports").length).toBeGreaterThan(3));
  await late.release(ok([report]));
  await screen.findByText(/No reports/);
  expect(screen.queryByRole("button", { name: /spam/ })).toBeNull();
}

it("a late read for an earlier identity is dropped", async () => {
  await lateReadAfterSwitch({ signer: member });
});

it("a late read for an earlier admin host is dropped", async () => {
  const other = "wss://other.example.com";
  await lateReadAfterSwitch(
    { relay: other },
    {
      ...backend,
      discover: async (url) =>
        url === other ? "https://admin.other.example.com" : origin,
    },
  );
  expect(contexts.at(-1)?.origin).toBe("https://admin.other.example.com");
});

it("a late read for an earlier community is dropped", async () => {
  const late = holdNext("listRestrictions", () =>
    ok({ items: [], nextCursor: null }),
  );
  routes.listCommunities = () =>
    ok({
      items: [
        { id: "c1", host: "team.example.com", icon: null },
        { id: "c2", host: "two.example.com", icon: null },
      ],
      nextCursor: null,
    });
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /team\.example\.com/ }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Restrictions" }));
  await late.started();
  fireEvent.click(screen.getByRole("button", { name: "Back to communities" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /two\.example\.com/ }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Restrictions" }));
  await waitFor(() => expect(sent("listRestrictions")).toHaveLength(2));
  await late.release(
    ok({
      items: [{ pubkey: member, banned: true, mutedUntil: null }],
      nextCursor: null,
    }),
  );
  expect(screen.queryByText(/bbbb/)).toBeNull();
});

it("an in-flight direct action that succeeds updates a reopened card", async () => {
  const { reopen } = mountSwitchable();
  const late = holdNext("directAction", () =>
    ok({ state: "succeeded", actionId: "done", replayed: true }),
  );
  await openCommunityActions();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await late.started();
  reopen();
  await reopenActions();
  await late.release(
    ok({ state: "succeeded", actionId: "done", replayed: false }),
  );
  expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  expect(screen.getByRole("button", { name: "Review" })).toBeVisible();
});

it("an in-flight resolve rejected after reopening the report releases the form", async () => {
  routes.listReports = () => ok([report]);
  routes.getReport = () => ok(report);
  const late = holdNext("resolveReport", () =>
    fail({ code: "invalid_action" }),
  );
  await openReport();
  fireEvent.click(await screen.findByRole("button", { name: "Ban" }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  await late.started();
  fireEvent.click(screen.getByRole("button", { name: "Back to reports" }));
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  await screen.findByRole("button", { name: /Retry: Ban/ });
  await late.release(fail({ code: "invalid_action" }));
  expect(screen.queryByRole("button", { name: /Retry: Ban/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Ban" })).toBeEnabled();
});

it("an in-flight direct action can't be discarded or replaced after reopening", async () => {
  const { reopen } = mountSwitchable();
  const late = holdNext("directAction", () =>
    fail({ category: "ambiguous", status: 502 }),
  );
  await openCommunityActions();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await late.started();
  reopen();
  await reopenActions();
  expect(await screen.findByRole("button", { name: "Discard" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  await late.release(fail({ category: "ambiguous", status: 502 }));
  reopen();
  await reopenActions();
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await expectIdenticalRetry("directAction");
});

const dnsDown = fail({
  category: "notSent",
  status: null,
  notSent: true,
  bodyComplete: false,
  message: "DNS unavailable",
});
const refused = fail({ category: "forbidden", status: 403, message: "" });

it.each([
  ["ambiguous", fail({ category: "ambiguous", status: 502 }), dnsDown],
  ["ambiguous", fail({ category: "ambiguous", status: 502 }), refused],
  [
    "pending",
    ok({ state: "pending", actionId: "a1", replayed: false }),
    dnsDown,
  ],
  [
    "pending",
    ok({ state: "pending", actionId: "a1", replayed: false }),
    refused,
  ],
])(
  "a direct action that was %s stays held when a retry fails without an answer",
  async (_, first, retry) => {
    routes.directAction = () => first;
    mountSwitchable();
    await openCommunityActions();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await screen.findByRole("button", { name: "Retry" });
    routes.directAction = () => retry;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(sent("directAction")).toHaveLength(2));
    routes.directAction = () => fail({ category: "ambiguous", status: 502 });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(sent("directAction")).toHaveLength(3));
    const [a, , c] = sent("directAction");
    expect(c).toEqual(a);
  },
);

it.each([
  ["refused before sending", dnsDown],
  ["refused for authorization", refused],
])("an uncertain resolve stays held when a retry is %s", async (_, retry) => {
  routes.listReports = () => ok([report]);
  routes.getReport = () => ok(report);
  routes.resolveReport = () => fail({ category: "ambiguous", status: 502 });
  await openReport();
  fireEvent.click(await screen.findByRole("button", { name: "Ban" }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  await screen.findByRole("button", { name: /Retry: Ban/ });
  routes.resolveReport = () => retry;
  fireEvent.click(screen.getByRole("button", { name: /Retry: Ban/ }));
  await waitFor(() => expect(sent("resolveReport")).toHaveLength(2));
  routes.resolveReport = () => fail({ category: "ambiguous", status: 502 });
  fireEvent.click(await screen.findByRole("button", { name: /Retry: Ban/ }));
  await waitFor(() => expect(sent("resolveReport")).toHaveLength(3));
  const [a, , c] = sent("resolveReport");
  expect(c).toEqual(a);
});

it("a first attempt refused before sending releases the write", async () => {
  routes.directAction = () => dnsDown;
  mountSwitchable();
  await openCommunityActions();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await screen.findByText(/DNS unavailable/);
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

it("a gateway 401 after a sent write re-checks access and keeps the write", async () => {
  routes.directAction = () =>
    fail({ category: "ambiguous", status: 401, authLost: true });
  mountSwitchable();
  await openCommunityActions();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(sent("probe")).toHaveLength(2));
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await expectIdenticalRetry("directAction");
});
