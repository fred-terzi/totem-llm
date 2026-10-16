/**
 * Email validation utilities (client-side mirror of `User.validations.email` on the server)
 *
 * Requirements:
 * - Optional field: empty/whitespace means "no email" (server stores null)
 * - Normalized to lowercase server-side; max 254 characters (RFC 5321 limit)
 * - Must match a basic local@domain format with a dotted domain (rejects user@localhost)
 */

export const EMAIL_MAX_LENGTH = 254;
export const EMAIL_REGEX = /^[a-z0-9][a-z0-9._%+-]*@([a-z0-9-]+\.)+[a-z]{2,}$/i;

/**
 * HTML5 pattern attribute for email inputs (without ^ and $).
 * Kept explicitly case-tolerant — the server lowercases on save.
 */
export const EMAIL_PATTERN =
  "[a-zA-Z0-9._%+-]+@([a-zA-Z0-9-]+\\.)+[a-zA-Z]{2,}";

/**
 * Validate a (possibly empty) email string.
 * Empty/null/undefined is valid — the field is optional.
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
export function isValidEmail(value) {
  if (value === null || value === undefined) return true;
  const email = String(value).trim();
  if (!email) return true;
  if (email.length > EMAIL_MAX_LENGTH) return false;
  return EMAIL_REGEX.test(email);
}
