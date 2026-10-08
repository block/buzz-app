import { invoke } from "@tauri-apps/api/core";
import { nativeIdentityEnabled } from "../identity/service";
import type {
  AttachmentRef,
  RelayStaffBackend,
  SaveResult,
  StaffContext,
  StaffFailure,
  StaffOutcome,
  StaffRequest,
  StaffResults,
} from "./contract";

function notSent(error: unknown): StaffFailure {
  return {
    category: "notSent",
    status: null,
    bodyComplete: false,
    bodyEmpty: false,
    code: null,
    notSent: true,
    message: typeof error === "string" ? error : "The request was not sent.",
  };
}

/** The native commands return outcomes; a rejected invoke never reached the network. */
async function outcome<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<StaffOutcome<T>> {
  try {
    return await invoke<StaffOutcome<T>>(command, args);
  } catch (error) {
    return { ok: false, failure: notSent(error) };
  }
}

export function nativeRelayStaff(): RelayStaffBackend {
  return {
    available: nativeIdentityEnabled(),
    discover: (relay) =>
      invoke<string | null>("relay_admin_discover", { relay }),
    request: <R extends StaffRequest>(context: StaffContext, request: R) =>
      outcome<StaffResults[R["route"]]>("relay_admin_request", {
        context,
        request,
      }),
    attachment: async (context: StaffContext, ref: AttachmentRef) => {
      const result = await outcome<number[]>("relay_admin_attachment", {
        context,
        attachment: ref,
      });
      return result.ok
        ? { ok: true, value: Uint8Array.from(result.value) }
        : result;
    },
    saveAttachment: async (context, ref) => {
      try {
        return await invoke<SaveResult>("relay_admin_save_attachment", {
          context,
          attachment: ref,
        });
      } catch (error) {
        return { state: "failed", failure: notSent(error) };
      }
    },
  };
}
