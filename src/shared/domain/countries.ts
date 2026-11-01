import { isISO31661Alpha2 } from "class-validator";

const COUNTRY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
// Use the same ISO authority as the dossier validator, rather than a UI locale's regional list.
export const COUNTRY_CODES = [...COUNTRY_ALPHABET]
  .flatMap(first => [...COUNTRY_ALPHABET].map(second => first + second))
  .filter(country => isISO31661Alpha2(country));
