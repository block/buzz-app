import { afterEach, expect, it, vi } from "vitest";
import type { Host, HostResponse } from "../../../features/host/service";
import { createOAuthSession } from "../../../shared/oauth/session";
import { deferred } from "../../../shared/test-helpers";
import { createDriveTitles, displayTitle, driveFileId } from "./drive";
import { DRIVE_API, type GoogleCredential } from "./oauth";

afterEach(() => vi.restoreAllMocks());

const id = "1-B9PqLiMyqTOHYhRPDe7G8VKb0PsuNZVjitRNLHTFp8";
it.each([
  [`https://docs.google.com/document/d/${id}/edit?usp=sharing`, id],
  [`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`, id],
  [`https://docs.google.com/presentation/u/1/d/${id}/edit`, id],
  [`https://docs.google.com/forms/d/${id}/viewform`, id],
  [`https://drive.google.com/file/d/${id}/view?usp=drivesdk`, id],
  [`https://drive.google.com/drive/folders/${id}`, id],
  [`https://drive.google.com/drive/u/0/folders/${id}`, id],
  [`https://drive.google.com/open?id=${id}`, id],
  [`http://docs.google.com/document/d/${id}/edit`, undefined],
  [`https://docs.google.com.example.com/document/d/${id}/edit`, undefined],
  ["https://docs.google.com/document/", undefined],
  ["https://docs.google.com/document/d/short/edit", undefined],
  ["https://drive.google.com/drive/my-drive", undefined],
  ["https://drive.google.com/open?id=../../etc", undefined],
  ["not a url", undefined],
])("identifies the Drive file in %s", (href, expected) => {
  expect(driveFileId(href)).toBe(expected);
});

it("normalizes names to one bounded line", () => {
  expect(displayTitle("  Q4\n plan\t2026 ")).toBe("Q4 plan 2026");
  expect(displayTitle("   ")).toBeNull();
  expect(displayTitle("é".repeat(120))).toBe(`${"é".repeat(99)}…`);
});

const docUrl = `https://docs.google.com/document/d/${id}/edit`;
const named = (name: string): HostResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify({ name }),
});
function fixture(request: Host["request"]) {
  const token = vi.fn(async () => "token-1");
  const credential: GoogleCredential = Object.freeze({
    account: { subject: "123", email: "a@block.xyz" },
    token,
  });
  const session = createOAuthSession<GoogleCredential>(
    "Google",
    async () => credential,
  );
  const host: Host = { runCommand: vi.fn(), request: vi.fn(request) };
  const titles = createDriveTitles(host, session);
  const listener = vi.fn();
  titles.subscribe(listener);
  return { session, host, titles, token, listener };
}

it("names a file once for the signed-in account and never while signed out", async () => {
  const { session, host, titles, listener } = fixture(async () =>
    named(" Buzzin "),
  );
  titles.ensure(docUrl);
  expect(host.request).not.toHaveBeenCalled();
  expect(titles.title(docUrl)).toBeUndefined();
  await session.signIn();
  titles.ensure(docUrl);
  titles.ensure(docUrl);
  await vi.waitFor(() => expect(titles.title(docUrl)).toBe("Buzzin"));
  expect(host.request).toHaveBeenCalledTimes(1);
  expect(host.request).toHaveBeenCalledWith({
    url: `${DRIVE_API}/files/${id}?fields=name&supportsAllDrives=true`,
    method: "GET",
    headers: { Accept: "application/json", Authorization: "Bearer token-1" },
  });
  expect(listener).toHaveBeenCalled();
  titles.ensure(docUrl);
  expect(host.request).toHaveBeenCalledTimes(1);
  expect(titles.title("https://example.com")).toBeUndefined();
});

it("renews the token once after a rejection and keeps unavailable files unlabeled", async () => {
  const responses: HostResponse[] = [
    { status: 401, headers: {}, body: "" },
    named("Buzzin"),
    { status: 404, headers: {}, body: JSON.stringify({ name: "leak" }) },
  ];
  const { session, host, titles, token } = fixture(
    async () => responses.shift() ?? named("unexpected"),
  );
  await session.signIn();
  titles.ensure(docUrl);
  await vi.waitFor(() => expect(titles.title(docUrl)).toBe("Buzzin"));
  expect(token).toHaveBeenNthCalledWith(2, true);
  const missing = "https://drive.google.com/file/d/0000000000missing/view";
  titles.ensure(missing);
  await vi.waitFor(() => expect(host.request).toHaveBeenCalledTimes(3));
  await Promise.resolve();
  expect(titles.title(missing)).toBeUndefined();
  titles.ensure(missing);
  expect(host.request).toHaveBeenCalledTimes(3);
});

it("sign-out drops names and fences results from the retired credential", async () => {
  const first = deferred<HostResponse>();
  const { session, host, titles, listener } = fixture(() => first.promise);
  await session.signIn();
  titles.ensure(docUrl);
  await vi.waitFor(() => expect(host.request).toHaveBeenCalledTimes(1));
  session.signOut();
  first.resolve(named("Buzzin"));
  await first.promise;
  await Promise.resolve();
  expect(titles.title(docUrl)).toBeUndefined();
  listener.mockClear();
  vi.mocked(host.request).mockResolvedValue(named("Buzzin again"));
  await session.signIn();
  titles.ensure(docUrl);
  await vi.waitFor(() => expect(titles.title(docUrl)).toBe("Buzzin again"));
  expect(listener).toHaveBeenCalled();
  listener.mockClear();
  titles.dispose();
  session.signOut();
  expect(listener).not.toHaveBeenCalled();
  expect(titles.title(docUrl)).toBeUndefined();
});

it("runs at most four lookups at once", async () => {
  const gates = new Map<string, ReturnType<typeof deferred<HostResponse>>>();
  const { session, host, titles } = fixture(({ url }) => {
    const gate = deferred<HostResponse>();
    gates.set(url, gate);
    return gate.promise;
  });
  await session.signIn();
  const urls = Array.from(
    { length: 6 },
    (_, index) => `https://drive.google.com/file/d/file-${index}-0000000/view`,
  );
  for (const url of urls) titles.ensure(url);
  await vi.waitFor(() => expect(host.request).toHaveBeenCalledTimes(4));
  await Promise.resolve();
  expect(host.request).toHaveBeenCalledTimes(4);
  // Lookups start in request order, so the first gate belongs to the first URL.
  gates.values().next().value?.resolve(named("First"));
  await vi.waitFor(() => expect(host.request).toHaveBeenCalledTimes(5));
  expect(titles.title(urls[0] ?? "")).toBe("First");
  expect(titles.title(urls[5] ?? "")).toBeUndefined();
});
