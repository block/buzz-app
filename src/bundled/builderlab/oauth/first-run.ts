import type { Context } from "@deepseek-ai/cordis";
import { invoke } from "@tauri-apps/api/core";
import { recoveryMessage } from "../../../features/federated-identity/CommunitySignIn";
import type { FederatedIdentity } from "../../../features/federated-identity/service";
import type { Host } from "../../../features/host/service";
import type { StorageResult } from "../../../plugins/types";
import manifest from "../manifest.json";
import { federatedAccount } from "../session";
import { browserCredential, type Credential } from "./browser";

/**
 * First launch runs before this plugin can share its Settings session, so the
 * welcome screen signs in through the same OAuth client under the bundled
 * plugin's own native network grant. Native code grants that origin at build
 * time; it does not depend on the plugin's JavaScript having started.
 */
export const bundledHost: Host = {
  runCommand: () => Promise.resolve(null),
  request: (request) =>
    invoke("plugin_host_request", {
      id: manifest.id,
      revision: "bundled",
      request,
    }),
};

/**
 * The NIP-FI session as the bundled plugin's installation calls it. An FI
 * build grants that installation the native forwarder instead of network
 * origins, and native admission checks only that grant, so first run can
 * use it before the plugin's JavaScript has started, as `bundledHost` does.
 */
export const bundledFederatedIdentity = (ctx: Context): FederatedIdentity =>
  ctx.extend({ pluginOwner: { id: manifest.id, revision: "bundled" } })
    .federatedIdentity;

/**
 * The bundled grant exists only while this plugin is enabled, so with it
 * turned off the browser sign-in could finish but never exchange its code.
 * Refuse before opening the browser instead. With `federated`, an FI build's
 * sign-in: see `federatedCredential`.
 */
export async function firstRunCredential(
  signal: AbortSignal,
  federated?: FederatedIdentity,
): Promise<Credential> {
  const result = await invoke<StorageResult>("plugin_catalog").catch(() => {
    throw new Error("Could not complete Builderlab sign-in. Try again.");
  });
  if (
    result.status !== "ready" ||
    !result.catalog.plugins.some(
      (plugin) =>
        plugin.source === "bundled" &&
        plugin.manifest.id === manifest.id &&
        plugin.enabled,
    )
  )
    throw new Error(
      "Builderlab is turned off on this device, so you can't sign in with email. Enter a community address instead.",
    );
  return federated
    ? federatedCredential(federated, signal)
    : browserCredential(bundledHost, signal);
}

/**
 * An FI build's sign-in: the native NIP-FI login, whose browser step, code
 * exchange and token stay native, then its account as the Builderlab plugin
 * reads it. A session that already exists signs in again, so the browser can
 * choose the account. The credential's value is the session's public
 * revision, which first run's later calls are fenced to
 * (`federatedBuilderlabAccount`).
 */
async function federatedCredential(
  identity: FederatedIdentity,
  signal: AbortSignal,
): Promise<Credential> {
  signal.throwIfAborted();
  const cancel = () => void identity.cancelSignIn().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const before = identity.snapshot();
    // Native rejects with a bare failure code, such as a refused renewal's.
    const session = await identity.signIn().catch((error: unknown) => {
      throw new Error(
        recoveryMessage(error instanceof Error ? error.message : ""),
      );
    });
    signal.throwIfAborted();
    // A renewal that did not finish (canceled in the browser, or timed out)
    // answers with the session it would have replaced: never continue as it.
    if (before.status === "signed-in" && session.revision === before.revision)
      throw new Error(recoveryMessage("sign-in-canceled"));
    if (session.status !== "signed-in")
      throw new Error(recoveryMessage(session.failure ?? ""));
    const account = await federatedAccount(identity).catch(() => undefined);
    signal.throwIfAborted();
    if (!account || identity.snapshot().revision !== session.revision)
      throw new Error("Could not load your Builderlab account. Try again.");
    return Object.freeze({ value: session.revision, account });
  } catch (error) {
    if (signal.aborted) throw new Error("Sign-in canceled.");
    throw error instanceof Error
      ? error
      : new Error("Could not complete Builderlab sign-in. Try again.");
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
