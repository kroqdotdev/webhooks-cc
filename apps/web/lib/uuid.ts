const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical UUID string, so a malformed id can be a miss instead of a database error. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
