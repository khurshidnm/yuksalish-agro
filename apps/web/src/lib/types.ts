import type { Permission, RoleKey } from '@yap/shared';

export interface ListMeta {
  page: number;
  pageSize: number;
  total: number;
  /** The server stopped counting at `total`: there are more rows than that. */
  totalCapped?: boolean;
}

export interface Membership {
  id: string;
  tenantId: string;
  tenantName: string;
  farmId: string;
  farmName: string;
  roleKey: RoleKey | string;
  roleName: string;
}

/** A farm asking this person to join, waiting for their answer. */
export interface Invitation {
  id: string;
  tenantName: string;
  farmName: string;
  roleKey: RoleKey | string;
  roleName: string;
  expiresAt: string;
}

export interface Session {
  user: {
    id: string;
    fullName: string;
    phone: string;
    email: string | null;
    locale: string | null;
    totpEnabled: boolean;
    /** Null while two-factor sign-in is off. */
    recoveryCodesLeft: number | null;
    isPlatformAdmin: boolean;
  };
  tenant: { id: string; name: string; currency: string; modules: string[] } | null;
  farm: { id: string; name: string } | null;
  role: { id: string; key: RoleKey | string; name: string } | null;
  permissions: (Permission | string)[];
  memberships: Membership[];
  invitations: Invitation[];
  mustChangePassword: boolean;
  mustEnroll2fa: boolean;
  settings: Record<string, unknown>;
}

export interface AuthResult {
  accessToken: string;
  session: Session;
}

/** Enrolling in 2FA and asking for new codes both answer this way, and only then are the codes readable. */
export interface RecoveryCodesResult {
  session: Session;
  recoveryCodes: string[];
}

export interface TwoFactorChallenge {
  twoFactorRequired: true;
  challengeToken: string;
}
