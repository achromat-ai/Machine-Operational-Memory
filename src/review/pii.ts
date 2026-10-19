/**
 * Triage-time secret and PII scan: stricter than ingestion, which only rejects
 * credential shapes. These are heuristics, not a guarantee. A hit sends the
 * lesson to quarantine for a human, so false positives cost review time, not
 * correctness. Labels name the kind of hit only, never the matched text.
 */
import { findSecret } from "../schema";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i;
const IBAN_CANDIDATE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g;
const CARD_CANDIDATE = /(?<![\d-])(?:\d[ -]?){13,19}(?![\d-])/g;
const US_SSN = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/;
const UK_NI = /\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/;
const PHONE_INTERNATIONAL = /(?<![\d.])\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}(?!\d)/g;
const PHONE_NATIONAL = /(?<![\d.-])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\d-])/;

/** Luhn checksum over a string of digits. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/** ISO 13616 mod-97 check over an IBAN with no spaces. */
export function ibanValid(iban: string): boolean {
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const code = char.charCodeAt(0);
    const chunk = code >= 65 ? String(code - 55) : char;
    for (const digit of chunk) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/** Returns the label of the first secret or PII shape found in `value`, or null. */
export function findPii(value: string): string | null {
  const secret = findSecret(value);
  if (secret) return secret;
  // Most specific first: "user:pass@host" would also satisfy the email pattern.
  if (URL_USERINFO.test(value)) return "URL with embedded credentials";
  if (EMAIL.test(value)) return "email address";
  for (const match of value.matchAll(IBAN_CANDIDATE)) if (ibanValid(match[0].replace(/ /g, ""))) return "IBAN";
  for (const match of value.matchAll(CARD_CANDIDATE)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return "payment card number";
  }
  if (US_SSN.test(value)) return "US social security number";
  if (UK_NI.test(value)) return "UK national insurance number";
  for (const match of value.matchAll(PHONE_INTERNATIONAL)) {
    const digits = match[0].replace(/\D/g, "").length;
    if (digits >= 8 && digits <= 15) return "phone number";
  }
  if (PHONE_NATIONAL.test(value)) return "phone number";
  return null;
}

/** Every string key and value in a JSON value (iterative, bounded). */
export function jsonStrings(value: unknown, limit = 20_000): string[] {
  const out: string[] = [];
  const stack: unknown[] = [value];
  let visited = 0;
  while (stack.length > 0 && visited++ < limit) {
    const node = stack.pop();
    if (typeof node === "string") out.push(node);
    else if (Array.isArray(node)) stack.push(...node);
    else if (typeof node === "object" && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        out.push(key);
        stack.push(child);
      }
    }
  }
  return out;
}
