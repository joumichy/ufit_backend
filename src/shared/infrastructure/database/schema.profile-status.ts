import {ufitSchema} from './schema-base';
import {PROFILE_STATUSES} from '../../domain/profile-editing.contract';

export const profileStatusEnum = ufitSchema.enum('profile_status', PROFILE_STATUSES);
