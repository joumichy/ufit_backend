import {z} from 'zod';
import {PROFILE_KIND, PROFILE_STATUS, PROFILE_STATUSES} from '../../../shared/domain/profile-editing.contract';
import {USER_ADMINISTRATION, userAdministrationIdentifierSchema} from './user-administration.contract';

export const PROFILE_ADMINISTRATION = {
  token: {repository: 'ProfileAdministrationRepository'},
  route: {root: 'admin/users/:userId/profiles/:kind', profile: ':profileId', history: ':profileId/changes', status: ':profileId/status', user: 'userId', kind: 'kind', id: 'profileId'},
  kind: PROFILE_KIND,
  failure: {
    input: 'Les paramètres de gestion du profil sont invalides.', missing: 'Ce profil est introuvable pour ce compte.',
    changed: 'Ce profil a changé. Actualisez-le avant de décider.',
    unavailable: 'Ce changement de statut n’est plus autorisé. Actualisez le profil.',
    persisted: 'Les informations du profil enregistrées sont incohérentes.',
  },
} as const;
export const PROFILE_ADMINISTRATION_KINDS = [PROFILE_ADMINISTRATION.kind.creator, PROFILE_ADMINISTRATION.kind.brand] as const;
export type AdministeredProfileKind = typeof PROFILE_ADMINISTRATION_KINDS[number];
export type AdministeredProfileStatus = typeof PROFILE_STATUSES[number];
export const profileAdministrationKindSchema = z.enum(PROFILE_ADMINISTRATION_KINDS);
export const profileAdministrationPageSchema = z.object({
  cursor: userAdministrationIdentifierSchema.optional(),
  limit: z.coerce.number().int().min(USER_ADMINISTRATION.limits.one).max(USER_ADMINISTRATION.limits.maximumPage).default(USER_ADMINISTRATION.limits.page),
}).strict();
export const changeProfileStatusSchema = z.object({
  expectedVersion: z.number().int().min(USER_ADMINISTRATION.limits.initialVersion).max(USER_ADMINISTRATION.limits.maximumVersion),
  status: z.enum([PROFILE_STATUS.active, PROFILE_STATUS.paused, PROFILE_STATUS.suspended]),
  reason: z.string().trim().min(USER_ADMINISTRATION.limits.one).max(USER_ADMINISTRATION.limits.reason),
}).strict();
export type ProfileAdministrationQuery = z.infer<typeof profileAdministrationPageSchema>;
export type ChangeProfileStatus = z.infer<typeof changeProfileStatusSchema>;
export interface AdministeredProfileState {
  id: string; kind: AdministeredProfileKind; name: string; slug: string; status: AdministeredProfileStatus;
  version: number; createdAt: string; updatedAt: string; hasActiveOperator: boolean;
}
export interface ProfileAdministrationActions {suspend: boolean; activate: boolean; pause: boolean;}
export type AdministeredProfileRecord = Omit<AdministeredProfileState, 'hasActiveOperator'> & {actions: ProfileAdministrationActions};
export interface ProfileStatusChange {
  id: string; profileId: string; kind: AdministeredProfileKind; version: number;
  fromStatus: AdministeredProfileStatus; toStatus: AdministeredProfileStatus;
  decidedByUserId: string; reason: string; createdAt: string;
}
export function profileAdministrationActions(profile: AdministeredProfileState): ProfileAdministrationActions {
  const mutable = profile.version < USER_ADMINISTRATION.limits.maximumVersion && profile.status !== PROFILE_STATUS.draft;
  return {
    suspend: mutable && profile.status !== PROFILE_STATUS.suspended,
    activate: mutable && profile.hasActiveOperator && profile.status !== PROFILE_STATUS.active,
    pause: mutable && profile.hasActiveOperator && profile.status !== PROFILE_STATUS.paused,
  };
}
