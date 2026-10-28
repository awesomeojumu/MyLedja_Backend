import { v7 as uuidv7, validate, version } from 'uuid';

/** A new record id: a UUID v7 string (TECH-SPEC 5.4). */
export function newId(): string {
  return uuidv7();
}

export function isUuidV7(value: string): boolean {
  return validate(value) && version(value) === 7;
}
