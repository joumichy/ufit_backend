import type { TransformFnParams } from 'class-transformer';
const EMPTY_PROFILE_TEXT = '';
export const profileFieldProvided = (_object: unknown, value: unknown) => value !== undefined;
export const trimProfileText = ({value}: TransformFnParams) => typeof value === 'string' ? value.trim() : value;
export const trimNullableProfileText = (params: TransformFnParams) => {
  const value = trimProfileText(params);
  return value === EMPTY_PROFILE_TEXT ? null : value;
};
