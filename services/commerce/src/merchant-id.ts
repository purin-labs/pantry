/**
 * The form of a merchant id (Plan 80 step 2): 3 to 80 lowercase letters,
 * digits, `_` or `-`, starting with a letter or a digit. A merchant's R2
 * keys start with `merchants/<merchantId>/`, so an id never holds a `/`, a
 * `.` or a space, and one id is never a path under another.
 */
const MERCHANT_ID = /^[a-z0-9][a-z0-9_-]{2,79}$/u;

export function isMerchantId(value: string): boolean {
  return MERCHANT_ID.test(value);
}
