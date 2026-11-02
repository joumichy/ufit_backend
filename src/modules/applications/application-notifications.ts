import type {BrandApplicationRow, CreatorApplicationRow} from '../../shared/infrastructure/database/schema';
import {NOTIFICATION, type NotificationIntent} from '../notifications/domain/notification.contract';
import {APPLICATION, type ApplicationKind} from './types/application-contract';

const APPLICATION_NOTIFICATION = {
  eventPrefix:'application/', separator:'/', paragraph:'\n\n',
  title:{creator:'Votre candidature créateur Ufit',brand:'Votre candidature marque Ufit'},
  status:{
    [APPLICATION.status.submitted]:'Votre candidature a été reçue. Vous pouvez consulter son état dans Ufit.',
    [APPLICATION.status.underReview]:'Votre candidature est en cours d’examen.',
    [APPLICATION.status.accepted]:'Votre candidature a été acceptée. Votre espace professionnel est disponible dans Ufit.',
    [APPLICATION.status.rejected]:'Votre candidature n’a pas été retenue. Consultez la décision et les corrections possibles dans Ufit.',
    [APPLICATION.status.waitlisted]:'Votre candidature est en liste d’attente. Vous pouvez consulter la décision dans Ufit.',
    [APPLICATION.status.needsMoreInfo]:'Des informations complémentaires sont nécessaires. Reprenez votre candidature dans Ufit.',
  },
} as const;
export function applicationNotification(kind:ApplicationKind, application:CreatorApplicationRow|BrandApplicationRow, notes?:string):NotificationIntent {
  const content=APPLICATION_NOTIFICATION.status[application.status];
  return {eventKey:APPLICATION_NOTIFICATION.eventPrefix+[kind,application.id,application.version].join(APPLICATION_NOTIFICATION.separator),
    recipientUserId:application.userId, resourceType:kind===APPLICATION.kind.creator?NOTIFICATION.resource.creatorApplication:NOTIFICATION.resource.brandApplication,
    resourceId:application.id,audience:NOTIFICATION.audience.applicant,brandId:null,
    subject:APPLICATION_NOTIFICATION.title[kind],text:notes?.trim()?content+APPLICATION_NOTIFICATION.paragraph+notes.trim():content};
}
