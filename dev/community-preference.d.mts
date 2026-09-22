export type CommunityPreference = {
  url: string;
  name: string;
  selectedAt: number;
};
export function communityPreference(directory?: string): {
  read(viewer: string): CommunityPreference | null;
  write(viewer: string, value: CommunityPreference): Promise<void>;
};
