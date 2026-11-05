// Lifts the subject out of a message image for plugins, such as a stickers
// plugin. The desktop host fetches the authenticated media and runs Vision; a
// plugin gets only the resulting PNG.
import { Service, type Context } from "@deepseek-ai/cordis";
import { invoke } from "@tauri-apps/api/core";
import { isNativeMediaSource } from "./attachment-source";
import { prepareAttachment } from "./prepare-attachment";

export type SubjectLift = Readonly<{
  /** Whether `source`, a URL `session.media()` returned, can be lifted here:
   * desktop media in the Mac app. macOS older than 14 still rejects `lift`. */
  supports(source: string): boolean;
  /**
   * The image's subjects over a transparent background, cropped to them and at
   * most 512 px on the longer side, as a metadata-free PNG ready for
   * `session.emoji.upload`. Rejects with the host's reason, such as no subject
   * found or macOS older than 14.
   */
  lift(source: string, signal?: AbortSignal): Promise<File>;
}>;
declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Read with `ctx.reflect.get("subjectLift")` for old-host compatibility. */
    subjectLift?: SubjectLift;
  }
}

export class SubjectLiftService extends Service implements SubjectLift {
  constructor(ctx: Context) {
    super(ctx, "subjectLift");
  }
  supports = (source: string) =>
    isNativeMediaSource(source) && /Mac/.test(navigator.platform);
  lift = async (source: string, signal = new AbortController().signal) => {
    if (!this.supports(source))
      throw new Error("Lifting a subject is available in the Mac app");
    signal.throwIfAborted();
    let png: ArrayBuffer;
    try {
      png = await invoke<ArrayBuffer>("media_lift_subject", { source });
    } catch (reason) {
      throw new Error(
        typeof reason === "string" ? reason : "Could not lift the subject",
      );
    }
    signal.throwIfAborted();
    // The host encodes plain RGBA, so cleaning keeps its exact pixels.
    return prepareAttachment(
      new File([png], "sticker.png", { type: "image/png" }),
      signal,
      true,
    );
  };
}
