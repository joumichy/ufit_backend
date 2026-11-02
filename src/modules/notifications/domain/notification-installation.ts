import {z} from 'zod';
import {notificationIdentifierSchema} from './notification.contract';
import {pushDeliverySchema} from './push-delivery';

export const INSTALLATION={
  route:{root:'notifications/installations',read:':installationId',register:':installationId/accounts/:userId',detach:':installationId/associations/:associationId',
    installationId:'installationId',userId:'userId',associationId:'associationId',proof:'x-ufit-installation-key'},
  state:{unregistered:'unregistered',registered:'registered',detached:'detached',invalidated:'invalidated'},
  revision:{absent:0,initial:1,step:1,maximum:2_147_483_647},
  storage:{lock:'update',one:1,lockPrefix:'ufit/notification-installation/',lockSeed:0,uniqueViolation:'23505',
    tokenUnique:'notification_installation_active_token_unique',associationPrimary:'notification_device_associations_pkey',associationActive:'notification_association_active_installation_unique',registrationPrimary:'notification_installation_registrations_pkey',
    relationInstall:'notification_installation_relation',relationAssociation:'notification_association_relation'},
  crypto:{algorithm:'sha256',encoding:'hex',requestEncoding:'utf8',proof:/^[0-9a-f]{64}$/},
  validation:{issue:'custom'},
  failure:{invalid:{code:'notification_installation_invalid',message:'Invalid notification installation'},
    proof:{code:'notification_installation_credential_invalid',message:'Installation credential unavailable'},
    changed:{code:'notification_installation_changed',message:'Installation changed; read it again before registration'},
    inactive:{code:'notification_installation_account_unavailable',message:'Installation unavailable for this account'},
    foreign:{code:'notification_installation_unavailable',message:'Installation unavailable for this account'},
    association:{code:'notification_association_closed',message:'Association unavailable; start a new association'},
    token:{code:'notification_installation_token_in_use',message:'This device token is already registered by another installation'},
    persisted:{code:'notification_installation_persisted_invalid',message:'Installation state requires correction'}},
} as const;
const revision=INSTALLATION.revision,state=INSTALLATION.state;
export const installationProofSchema=z.string().regex(INSTALLATION.crypto.proof);
export const installationRegistrationSchema=z.object({expectedVersion:z.number().int().min(revision.absent).max(revision.maximum-revision.step),
  associationId:notificationIdentifierSchema,registrationId:notificationIdentifierSchema,
  deviceToken:pushDeliverySchema.shape.deviceToken,environment:pushDeliverySchema.shape.environment}).strict();
export const installationDetachSchema=z.object({}).strict();
export const installationTargetSchema=z.object({installationId:notificationIdentifierSchema,associationId:notificationIdentifierSchema,registrationId:notificationIdentifierSchema}).strict();
export const installationDocumentSchema=z.object({installationId:notificationIdentifierSchema,version:z.number().int().min(revision.absent).max(revision.maximum),
  state:z.enum([state.unregistered,state.registered,state.detached,state.invalidated]),associationId:notificationIdentifierSchema.nullable(),
  registrationId:notificationIdentifierSchema.nullable(),environment:pushDeliverySchema.shape.environment.nullable(),registeredAt:z.iso.datetime().nullable(),
  isCurrentAccount:z.boolean(),updatedAt:z.iso.datetime().nullable()}).strict().superRefine((value,ctx)=>{
    const bound=value.state===state.registered||value.state===state.invalidated;
    const fields=[value.associationId,value.registrationId,value.environment,value.registeredAt];
    if((value.version===revision.absent)!==(value.state===state.unregistered)||
      (value.version===revision.absent)!==(value.updatedAt===null)||
      (bound?fields.some(field=>field===null):fields.some(field=>field!==null))||(!bound&&value.isCurrentAccount)) {
      ctx.addIssue({code:INSTALLATION.validation.issue,message:INSTALLATION.failure.persisted.message});
    }
  });
export const installationDetachedSchema=z.object({installationId:notificationIdentifierSchema,associationId:notificationIdentifierSchema,detached:z.literal(true)}).strict();
export type InstallationRegistration=z.infer<typeof installationRegistrationSchema>;
export type InstallationDocument=z.infer<typeof installationDocumentSchema>;
export type InstallationTarget=z.infer<typeof installationTargetSchema>;
export type InstallationDetached=z.infer<typeof installationDetachedSchema>;
