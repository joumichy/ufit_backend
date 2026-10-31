import type { TransformFnParams } from "class-transformer";
const TEXT_TYPE = "string";
export function trimApplicationText({value}: TransformFnParams): unknown {
  return typeof value === TEXT_TYPE ? value.trim() : value;
}
export function trimApplicationUrls({value}: TransformFnParams): unknown {
  return Array.isArray(value) ? value.map(item => typeof item === TEXT_TYPE ? item.trim() : item) : value;
}
