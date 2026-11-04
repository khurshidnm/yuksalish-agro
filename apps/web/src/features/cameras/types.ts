export const CAMERA_ZONES = ['barn', 'feed_store', 'gate', 'pump'] as const;
export type CameraZone = (typeof CAMERA_ZONES)[number];

export interface Device {
  id: string;
  type: string;
  name: string;
  facilityId: string | null;
  streamUrl: string | null;
  onvifUrl: string | null;
  hasStreamCredentials: boolean;
  status: 'planned' | 'online' | 'offline';
  lastSeenAt: string | null;
  apiKeyId: string | null;
  zone: CameraZone | null;
  liveUrl: string | null;
  offlineAfterMinutes: number | null;
  notes: string | null;
}

export const DEVICES = '/devices';
export const STATUS_VARIANT = { planned: 'neutral', online: 'success', offline: 'danger' } as const;
