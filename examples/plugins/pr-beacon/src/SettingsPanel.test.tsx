// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsPanel } from "./SettingsPanel";
import type { Preferences } from "./preferences";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function viewerResponse(login: string) {
  return jsonResponse({ data: { viewer: { login } } });
}

const DEFAULT_PREFERENCES: Preferences = {
  vipLogins: [],
  watchedLabels: [],
  hiddenReviewRequestUrls: [],
  pollingEnabled: false,
};

const SettingsPanel = createSettingsPanel(React as never);

// Keeps the form mounted to exercise its connected and disconnected views.
function Harness(props: {
  onSubmitToken?: (token: string) => void;
  onClearToken?: () => void;
  preferences?: Preferences;
  onChangePreferences?: (next: Preferences) => void;
  saveError?: string | null;
}) {
  const [hasToken, setHasToken] = React.useState(false);
  return (
    <SettingsPanel
      hasToken={hasToken}
      onSubmitToken={(token) => {
        setHasToken(true);
        props.onSubmitToken?.(token);
      }}
      onClearToken={() => {
        setHasToken(false);
        props.onClearToken?.();
      }}
      preferences={props.preferences ?? DEFAULT_PREFERENCES}
      onChangePreferences={props.onChangePreferences ?? (() => {})}
      saveError={props.saveError ?? null}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SettingsPanel GitHub connection", () => {
  it("explains token creation and links to the suggested repository permissions", () => {
    render(<Harness />);
    const link = screen.getByRole("link", { name: "Create a GitHub token" });
    const url = new URL(link.getAttribute("href") ?? "");
    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/settings/personal-access-tokens/new");
    expect(url.searchParams.get("contents")).toBe("read");
    expect(url.searchParams.get("pull_requests")).toBe("write");
    expect(
      screen.getByText(/Generate the token, copy it, and paste it below/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Everything else is optional/)).toBeInTheDocument();
  });

  it("disables Connect GitHub while the token field is empty", () => {
    render(<Harness />);
    expect(
      screen.getByRole("button", { name: "Connect GitHub" }),
    ).toBeDisabled();
  });

  it("tests the token against GitHub before accepting it", async () => {
    const onSubmitToken = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(viewerResponse("octocat"));
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness onSubmitToken={onSubmitToken} />);

    await userEvent.type(screen.getByLabelText("GitHub token"), "test-token");
    await userEvent.click(
      screen.getByRole("button", { name: "Connect GitHub" }),
    );

    expect(
      await screen.findByText(/Token loaded for this session/),
    ).toBeInTheDocument();
    expect(onSubmitToken).toHaveBeenCalledWith("test-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows a visible failure and never connects when GitHub rejects the token", async () => {
    const onSubmitToken = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })),
    );
    render(<Harness onSubmitToken={onSubmitToken} />);

    await userEvent.type(screen.getByLabelText("GitHub token"), "bad-token");
    await userEvent.click(
      screen.getByRole("button", { name: "Connect GitHub" }),
    );

    expect(
      await screen.findByText(/GitHub rejected this token/i),
    ).toBeInTheDocument();
    expect(onSubmitToken).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Connect GitHub" }),
    ).toBeInTheDocument();
  });

  it("disables the button and blocks a second submit while the test connection is pending", async () => {
    let resolveFetch: ((response: Response) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    render(<Harness />);

    await userEvent.type(screen.getByLabelText("GitHub token"), "test-token");
    const connectButton = screen.getByRole("button", {
      name: "Connect GitHub",
    });
    await userEvent.click(connectButton);

    const pendingButton = screen.getByRole("button", { name: "Connecting…" });
    expect(pendingButton).toBeDisabled();
    expect(screen.getByLabelText("GitHub token")).toBeDisabled();
    await userEvent.click(pendingButton);
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch?.(viewerResponse("octocat"));
      await Promise.resolve();
    });
    expect(
      await screen.findByText(/Token loaded for this session/),
    ).toBeInTheDocument();
  });

  it("aborts the in-flight connection test on unmount without calling onSubmitToken", async () => {
    let resolveFetch: ((response: Response) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const onSubmitToken = vi.fn();
    const { unmount } = render(<Harness onSubmitToken={onSubmitToken} />);

    await userEvent.type(screen.getByLabelText("GitHub token"), "test-token");
    await userEvent.click(
      screen.getByRole("button", { name: "Connect GitHub" }),
    );

    unmount();
    expect(() => resolveFetch?.(viewerResponse("octocat"))).not.toThrow();
    await act(async () => {
      await Promise.resolve();
    });
    expect(onSubmitToken).not.toHaveBeenCalled();
  });

  it("never claims a verified identity for a token that was set outside this form", () => {
    function AlreadyConnectedHarness() {
      return (
        <SettingsPanel
          hasToken
          onSubmitToken={() => {}}
          onClearToken={() => {}}
          preferences={DEFAULT_PREFERENCES}
          onChangePreferences={() => {}}
          saveError={null}
        />
      );
    }
    render(<AlreadyConnectedHarness />);
    expect(
      screen.getByText(/Token loaded for this session/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Connected to GitHub as/),
    ).not.toBeInTheDocument();
  });

  it("disconnects and returns to the token form", async () => {
    const onClearToken = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(viewerResponse("octocat")),
    );
    render(<Harness onClearToken={onClearToken} />);

    await userEvent.type(screen.getByLabelText("GitHub token"), "test-token");
    await userEvent.click(
      screen.getByRole("button", { name: "Connect GitHub" }),
    );
    await screen.findByText(/Token loaded for this session/);

    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(onClearToken).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Connect GitHub" }),
    ).toBeInTheDocument();
  });
});

describe("SettingsPanel review priorities", () => {
  it("parses comma-separated VIP logins and saves them on blur", async () => {
    const onChangePreferences = vi.fn();
    render(<Harness onChangePreferences={onChangePreferences} />);

    const vipField = screen.getByLabelText(/VIP GitHub usernames/i);
    await userEvent.type(vipField, "octocat, hubot");
    await userEvent.tab();

    expect(onChangePreferences).toHaveBeenCalledWith({
      ...DEFAULT_PREFERENCES,
      vipLogins: ["octocat", "hubot"],
    });
  });

  it("parses comma-separated watched labels and saves them on blur", async () => {
    const onChangePreferences = vi.fn();
    render(<Harness onChangePreferences={onChangePreferences} />);

    const labelField = screen.getByLabelText(/Watched labels/i);
    await userEvent.type(labelField, "urgent, security");
    await userEvent.tab();

    expect(onChangePreferences).toHaveBeenCalledWith({
      ...DEFAULT_PREFERENCES,
      watchedLabels: ["urgent", "security"],
    });
  });
});
