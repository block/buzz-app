// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Communities } from "../features/communities/service";
import { EnterpriseLoginDialog } from "./EnterpriseLoginDialog";

const communities = {} as Communities;
const communityId = "https://community.example";

afterEach(cleanup);

it("shows a failed cleanup without storage details", () => {
  render(
    <EnterpriseLoginDialog
      communities={communities}
      state={{
        communityId,
        status: "required",
        cleanup: { retained: true, unrecorded: true, unpruned: false },
      }}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Buzz couldn't remove your previous sign-in from secure storage or record that it was refused. Buzz starts no new requests with it while it stays open, but may send it again after a restart.",
  );
  expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
});

it("shows when an outdated refusal record could not be removed", () => {
  render(
    <EnterpriseLoginDialog
      communities={communities}
      state={{
        communityId,
        status: "required",
        cleanup: { retained: false, unrecorded: false, unpruned: true },
      }}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Buzz couldn't remove an outdated sign-in record from this device.",
  );
});

it("waits for a sign-out to finish before signing in", () => {
  render(
    <EnterpriseLoginDialog
      communities={communities}
      state={{ communityId, status: "required", waiting: true }}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Finishing sign-out before you can sign in again.",
  );
  expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
});
