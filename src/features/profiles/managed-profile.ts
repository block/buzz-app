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
