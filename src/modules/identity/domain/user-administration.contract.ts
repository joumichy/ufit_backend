import {z} from 'zod';
import {USER_ROLES, USER_STATUSES, type UserRole, type UserStatus} from './user.types';

export const USER_ADMINISTRATION = {
  token: {repository: 'UserAdministrationRepository'},
  route: {root: 'admin/users', user: ':userId', status: ':userId/status', adminAccess: ':userId/admin-access', history: ':userId/access-history', parameter: 'userId'},
  role: {admin: 'admin', superAdmin: 'super_admin'},
  status: {active: 'active', suspended: 'suspended', deleted: 'deleted'},
  change: {status: 'status', adminAccess: 'admin_access'},
  limits: {first: 0, one: 1, initialVersion: 1, step: 1, maximumVersion: 2_147_483_647, page: 20, maximumPage: 100, search: 100, reason: 500},
  persistence: {lock: 'update', wildcard: '%', literalPattern: /[\\%_]/g, escapedLiteral: '\\$&'},
  failure: {
    input: 'Les paramètres de gestion du compte sont invalides.',
    access: 'Cet accès est réservé à une administration active.',
    superAdmin: 'Seul un super-administrateur peut modifier cet accès privilégié.',
    missing: 'Ce compte est introuvable.',
    changed: 'Ce compte a changé. Actualisez sa référence avant de réessayer.',
    unchanged: 'Cette décision ne change pas l’accès actuel.',
    deleted: 'Un compte supprimé ne peut pas être réactivé.',
    selfStatus: 'Vous ne pouvez pas suspendre votre propre compte depuis cet outil.',
    cursor: 'La page de comptes demandée est invalide.',
    persisted: 'Les informations d’accès enregistrées sont incohérentes.',
    versionLimit: 'La limite de version de cet accès est atteinte.',
  },
} as const;

const version = z.number().int().min(USER_ADMINISTRATION.limits.initialVersion).max(USER_ADMINISTRATION.limits.maximumVersion);
const reason = z.string().trim().min(USER_ADMINISTRATION.limits.one).max(USER_ADMINISTRATION.limits.reason);
export const userAdministrationIdentifierSchema = z.uuid().transform(value => value.toLowerCase());
const page = {
  cursor: userAdministrationIdentifierSchema.optional(),
  limit: z.coerce.number().int().min(USER_ADMINISTRATION.limits.one).max(USER_ADMINISTRATION.limits.maximumPage).default(USER_ADMINISTRATION.limits.page),
};
export const userAdministrationPageSchema = z.object({...page,
  search: z.string().trim().max(USER_ADMINISTRATION.limits.search).optional(),
  status: z.enum(USER_STATUSES).optional(), role: z.enum(USER_ROLES).optional(),
}).strict();
export const userAccessHistoryPageSchema = z.object(page).strict();
export const changeUserStatusSchema = z.object({expectedVersion: version,
  status: z.enum([USER_ADMINISTRATION.status.active, USER_ADMINISTRATION.status.suspended]), reason,
}).strict();
export const changeUserAdminAccessSchema = z.object({expectedVersion: version, enabled: z.boolean(), reason}).strict();

export type UserAdministrationQuery = z.infer<typeof userAdministrationPageSchema>;
export type UserAccessHistoryQuery = z.infer<typeof userAccessHistoryPageSchema>;
export type ChangeUserStatus = z.infer<typeof changeUserStatusSchema>;
export type ChangeUserAdminAccess = z.infer<typeof changeUserAdminAccessSchema>;
export interface UserAdministrationActions {suspend: boolean; activate: boolean; grantAdmin: boolean; revokeAdmin: boolean;}
export interface UserAdministrationSubject {id: string; status: UserStatus; roles: UserRole[]; version: number;}
export interface UserAdministrationRecord extends UserAdministrationSubject {
  email: string; displayName: string | null;
  createdAt: string; updatedAt: string; actions: UserAdministrationActions;
}
export interface UserAccessChange {
  id: string; userId: string; version: number;
  kind: typeof USER_ADMINISTRATION.change[keyof typeof USER_ADMINISTRATION.change];
  fromStatus: UserStatus; toStatus: UserStatus; adminBefore: boolean; adminAfter: boolean;
  decidedByUserId: string; reason: string; createdAt: string;
}
export interface UserAdministrationPage<Item> {items: Item[]; nextCursor: string | null;}
