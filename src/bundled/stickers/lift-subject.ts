import { invoke } from "@tauri-apps/api/core";

/** The host fetches the authenticated image and returns its lifted subject as
 * a transparent PNG; it rejects with a reason when no subject can be lifted. */
export async function liftSubject(source: string): Promise<Blob> {
  const png = await invoke<ArrayBuffer>("media_lift_subject", { source });
  return new Blob([png], { type: "image/png" });
}
