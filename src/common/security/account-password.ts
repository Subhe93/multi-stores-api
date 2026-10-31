import { randomInt } from 'node:crypto';

// Unambiguous alphabet: no 0/O, 1/l/I, so a password read from an email can
// be typed back without guessing.
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const ALL = LOWER + UPPER + DIGITS;

export const ACCOUNT_PASSWORD_LENGTH = 16;

/**
 * Password for an account the platform creates on the user's behalf (guest
 * checkout, Kustom, admin). 16 characters from a CSPRNG (crypto.randomInt),
 * with at least one lower-case letter, one upper-case letter and one digit.
 * The plain value must only live in memory long enough to hash it and build
 * the credentials email: never log, persist or return it.
 */
export function generateAccountPassword(
  length = ACCOUNT_PASSWORD_LENGTH,
): string {
  const size = Math.max(length, 3);
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS)];
  while (chars.length < size) chars.push(pick(ALL));
  // Fisher-Yates so the guaranteed classes are not always in front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function pick(set: string): string {
  return set[randomInt(set.length)];
}
