// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import type {
  ProbeDto,
  RelayStaffBackend,
  StaffFailure,
  StaffOutcome,
  StaffRequest,
} from "../../features/relay-staff/contract";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { RelayStaff } from "./RelayStaff";
import { createStaff } from "./staff";

const signer = "a".repeat(64);
const member = "b".repeat(64);
const relay = "wss://team.example.com";
const origin = "https://admin.example.com";

type Handler = (
  request: StaffRequest,
) => StaffOutcome<unknown> | Promise<StaffOutcome<unknown>>;
let routes: Partial<Record<StaffRequest["route"], Handler>>;
let calls: StaffRequest[];

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
  request: (async (_context, request) => {
    calls.push(request);
    const handler = routes[request.route];
    return handler
      ? handler(request)
      : fail({ message: `no ${request.route}` });
  }) as RelayStaffBackend["request"],
  attachment: async () => fail({}) as never,
  saveAttachment: async () => ({ state: "cancelled" }),
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
