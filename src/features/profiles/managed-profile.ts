/** Provider-owned display data; never used for authorization. */
export type ManagedProfile = Readonly<{
  version: 1;
  source_label: string;
  source_url: string;
  fields: readonly Readonly<{
    key: string;
    section: "personal" | "team" | "location";
    label: string;
    value: string;
    username?: string;
  }>[];
  coordinates?: Readonly<{ latitude: number; longitude: number }>;
  city?: string;
  timezone?: string;
  picture?: string;
}>;

const handle = (v: unknown): v is string =>
  typeof v === "string" && /^[a-z0-9._-]{1,64}$/.test(v);
const text = (v: unknown, max: number, empty = false): v is string =>
  typeof v === "string" &&
  (empty || !!v) &&
  v.trim() === v &&
  [...v].length <= max &&
  !/[\p{Cc}]/u.test(v);
const https = (v: unknown): v is string => {
  if (typeof v !== "string" || v.length > 2048) return false;
  try {
    const url = new URL(v);
    return (
      url.protocol === "https:" &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
};
export function parseManagedProfile(
  content: string,
): ManagedProfile | undefined {
  if (!content || new TextEncoder().encode(content).length > 16384) return;
  try {
    const v = JSON.parse(content);
    if (
      v?.version !== 1 ||
      !text(v.source_label, 64) ||
      !https(v.source_url) ||
      !Array.isArray(v.fields) ||
      v.fields.length > 16
    )
      return;
    const keys = new Set<string>();
    for (const f of v.fields) {
      if (
        !f ||
        !handle(f.key) ||
        keys.has(f.key) ||
        !["personal", "team", "location"].includes(f.section) ||
        !text(f.label, 64) ||
        !text(f.value, 512, true) ||
        (f.username != null && !handle(f.username))
      )
        return;
      keys.add(f.key);
    }
    if (
      (v.coordinates != null &&
        (typeof v.coordinates !== "object" ||
          !Number.isFinite(v.coordinates.latitude) ||
          Math.abs(v.coordinates.latitude) > 90 ||
          !Number.isFinite(v.coordinates.longitude) ||
          Math.abs(v.coordinates.longitude) > 180)) ||
      (v.city != null && !text(v.city, 128)) ||
      (v.timezone != null && !text(v.timezone, 128)) ||
      (v.picture != null && !https(v.picture))
    )
      return;
    return v;
  } catch {
    return;
  }
}
