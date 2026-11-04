import type { Permission, RoleKey } from '@yap/shared';

export interface ListMeta {
  page: number;
  pageSize: number;
  total: number;
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

export interface Session {
  user: {
    id: string;
    fullName: string;
    phone: string;
    email: string | null;
    locale: string | null;
    totpEnabled: boolean;
    isPlatformAdmin: boolean;
  };
  tenant: { id: string; name: string; currency: string; modules: string[] } | null;
  farm: { id: string; name: string } | null;
  role: { id: string; key: RoleKey | string; name: string } | null;
  permissions: (Permission | string)[];
  memberships: Membership[];
  mustEnroll2fa: boolean;
  settings: Record<string, unknown>;
}

export interface AuthResult {
  accessToken: string;
  session: Session;
}

export interface TwoFactorChallenge {
  twoFactorRequired: true;
  challengeToken: string;
}
