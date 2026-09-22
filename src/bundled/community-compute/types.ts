// Snapshot shape ported from block/buzz PR #7691; no native command coupling.
export type MeshDeviceState = "serving" | "loading" | "standby" | "consuming";

export type MeshSnapshotDevice = {
  deviceId: string | null;
  label: string;
  capacityGb: number | null;
  models: string[];
  state: MeshDeviceState;
  isSelf: boolean;
  memberPubkey?: string | null;
  reportedAt?: number | null;
  modelSizeGb?: number | null;
};

export type MeshSnapshot = {
  sharingDeviceCount: number;
  contributorMemberCount?: number;
  sharedCapacityGb: number | null;
  allocatedCapacityGb?: number | null;
  models: string[];
  devices: MeshSnapshotDevice[];
  includesSelf: boolean;
  observedAt?: number;
  freshnessSeconds?: number;
  memberCount: number;
  reason: string | null;
};
