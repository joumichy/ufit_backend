import type { TransformFnParams } from 'class-transformer';
const EMPTY_TEXT = '';
export const fieldProvided = (_object: unknown, value: unknown) => value !== undefined;
export const trimText = ({value}: TransformFnParams) => typeof value === 'string' ? value.trim() : value;
export const trimNullableText = (params: TransformFnParams) => {
  const value = trimText(params);
  return value === EMPTY_TEXT ? null : value;
};
