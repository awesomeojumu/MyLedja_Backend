import { v7 as uuidv7, validate, version } from "uuid";

/** One ID strategy everywhere: UUIDv7 strings (ADR-0006). */
export function newId(): string {
  return uuidv7();
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && validate(value) && version(value) === 7;
}
