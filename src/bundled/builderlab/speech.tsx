// Builderlab as a speech provider: native code posts the host's WebRTC offer
// to Builderlab's transcription route with the user's Builderlab sign-in and
// the community the call bills, and Builderlab answers it. The NIP-FI session
// is named by its revision; its token never leaves native. It is offered
// while the user is signed in, and ready only while that account may use
// transcription, as Builderlab decisions are; see `offerBuilderlabSpeech`.
import { useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  SpeechConnectReply,
  SpeechConnectRequest,
  SpeechProvider,
  SpeechProviderStatus,
} from "../../features/speech/service";
import { SPEECH_FAILURES } from "../../features/speech/listen";
import { Login } from "./login/Login";
import type { BuilderlabSession, Credential } from "./session";

/** Native `speech_connect` on Builderlab, as the sign-in `credential`. */
export type BuilderlabSpeechConnect = (
  request: SpeechConnectRequest,
  credential: Credential,
) => Promise<unknown>;
export const nativeBuilderlabSpeech = ():
  | BuilderlabSpeechConnect
  | undefined =>
  isTauri()
    ? (request, credential) =>
        invoke("speech_connect", {
          provider: "builderlab",
          request,
          federated: credential.revision,
        })
    : undefined;

/** Registers Builderlab in Settings > Speech to text while the user is
 * signed in, and removes it otherwise. While it is ready it is the default
 * provider, so it listens unless the user chose another. Builds without
 * native calls never offer it. */
export function offerBuilderlabSpeech(
  ctx: Context,
  session: BuilderlabSession,
  loginAvailable: boolean,
  native: BuilderlabSpeechConnect | undefined = nativeBuilderlabSpeech(),
  openIdentity?: () => void,
) {
  if (!native) return;
  const provider = builderlabSpeechProvider(
    session,
    loginAvailable,
    native,
    openIdentity,
  );
  let withdraw: (() => void) | undefined;
  const update = () => {
    const allowed = session.snapshot().status === "signed-in";
    if (allowed && !withdraw) withdraw = ctx.speech.registerProvider(provider);
    else if (!allowed && withdraw) {
      withdraw();
      withdraw = undefined;
    }
  };
  ctx.effect(() => {
    const stop = session.subscribe(update);
    update();
    return stop;
  });
}

export function builderlabSpeechProvider(
  session: BuilderlabSession,
  loginAvailable: boolean,
  native: BuilderlabSpeechConnect | undefined = nativeBuilderlabSpeech(),
  openIdentity?: () => void,
): SpeechProvider {
  const signedIn = () =>
    session.snapshot().status === "signed-in"
      ? session.credential()
      : undefined;
  // Only Builderlab's explicit yes enables it; otherwise no call goes there.
  const permitted = (credential: Credential) =>
    credential.account.canUseBuilderlabTranscription;
  return {
    id: "builderlab",
    label: "Builderlab",
    description: "Use your Builderlab account. Billed to the community.",
    status: (): SpeechProviderStatus => {
      const state = session.snapshot();
      const credential = signedIn();
      if (!native || !credential) return "needs-setup";
      if (permitted(credential)) return "ready";
      return state.checkingPermissions ? "checking" : "needs-setup";
    },
    subscribe: session.subscribe,
    connect: async (request, { signal }): Promise<SpeechConnectReply> => {
      if (!native) return { outcome: "failed", reason: "unavailable" };
      if (!signedIn())
        return { outcome: "failed", reason: "missing_credentials" };
      let credential: Credential;
      try {
        credential = await session.freshCredential(signal);
      } catch {
        return { outcome: "failed", reason: "missing_credentials" };
      }
      if (!permitted(credential))
        return { outcome: "failed", reason: "unauthorized" };
      let reply: unknown;
      try {
        reply = await native(request, credential);
      } catch {
        return { outcome: "failed", reason: "service_error" };
      }
      if (!reply || typeof reply !== "object")
        return { outcome: "failed", reason: "invalid_response" };
      const { outcome, reason, sdp } = reply as Record<string, unknown>;
      if (outcome === "answered" && typeof sdp === "string")
        return { outcome, sdp };
      return {
        outcome: "failed",
        reason:
          SPEECH_FAILURES.find((known) => known === reason) ??
          "invalid_response",
      };
    },
    Settings: ({ active }) => {
      const state = useSyncExternalStore(session.subscribe, session.snapshot);
      return (
        <>
          <Login
            session={session}
            available={loginAvailable}
            active={active}
            showHeading={false}
            openIdentity={openIdentity}
          />
          {state.status === "signed-in" &&
            !state.checkingPermissions &&
            !state.account?.canUseBuilderlabTranscription && (
              <p role="status" className="text-body-sm text-secondary">
                Builderlab speech to text is unavailable for this account.
              </p>
            )}
        </>
      );
    },
  };
}
