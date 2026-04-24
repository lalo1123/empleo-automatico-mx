// Curated list of well-known disposable / throwaway email domains. Blocking
// these at signup filters ~95% of bot signups without inconveniencing real
// users. The list is intentionally short and conservative; it leans on the
// heaviest offenders rather than trying to be exhaustive.
//
// Sources (2024-2026):
//   - https://github.com/disposable/disposable-email-domains (trimmed)
//   - https://github.com/wesbos/burner-email-providers (top entries)
//   - Internal: patterns observed across other SkyBrandMX products.
//
// Extend via env `DISPOSABLE_DOMAINS_EXTRA` (comma-separated) when a new
// throwaway provider starts showing up in signups — no code change needed.

const DOMAINS: readonly string[] = [
  // 10 Minute Mail family
  "10minutemail.com",
  "10minutemail.net",
  "10minutemail.de",
  "10minutesmail.com",
  // Mailinator + aliases
  "mailinator.com",
  "mailinator.net",
  "mailinator2.com",
  "reallymymail.com",
  "binkmail.com",
  "chammy.info",
  "bobmail.info",
  // Guerrilla Mail
  "guerrillamail.com",
  "guerrillamail.net",
  "guerrillamail.biz",
  "guerrillamail.org",
  "guerrillamail.de",
  "guerrillamailblock.com",
  "sharklasers.com",
  "grr.la",
  "spam4.me",
  "pokemail.net",
  // Tempmail / temp-mail / tempail variants
  "tempmail.org",
  "tempmail.com",
  "tempmail.net",
  "temp-mail.org",
  "temp-mail.io",
  "tempail.com",
  "tmail.com",
  "tmpmail.net",
  "tmpmail.org",
  "tmpeml.com",
  "tempr.email",
  // Yopmail + family
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
  "cool.fr.nf",
  "jetable.fr.nf",
  "nospam.ze.tc",
  "nomail.xl.cx",
  "mega.zik.dj",
  "speed.1s.fr",
  // Throwaway / Dispostable / DropMail
  "throwawaymail.com",
  "dispostable.com",
  "dropmail.me",
  "maildrop.cc",
  "mailnesia.com",
  "mohmal.com",
  "getnada.com",
  "nada.email",
  "inboxkitten.com",
  "emailondeck.com",
  // Spambog / spamgourmet
  "spambog.com",
  "spambog.de",
  "spambog.ru",
  "spamgourmet.com",
  "spamgourmet.net",
  "spamgourmet.org",
  // Misc persistent offenders
  "fakeinbox.com",
  "fakemail.net",
  "fakermail.com",
  "trashmail.com",
  "trashmail.de",
  "trashmail.net",
  "trashmail.ws",
  "mt2014.com",
  "mt2015.com",
  "mailcatch.com",
  "mailnull.com",
  "mytrashmail.com",
  "deadaddress.com",
  "einrot.com",
  "mvrht.com",
  "wegwerfemail.de",
  "wegwerfmail.de",
  "wegwerfmail.net",
  "wegwerfmail.org",
  "byom.de",
  "discard.email",
  "discardmail.com",
  "discardmail.de",
  "harakirimail.com",
  "incognitomail.org",
  "mailexpire.com",
  "mailforspam.com",
  "mailmoat.com",
  "spamex.com",
  "hulapla.de",
  "mailtemp.info",
  "tempinbox.com",
  "throwam.com",
  "meltmail.com",
  "mintemail.com",
  "mailsac.com",
  "dodgit.com"
];

const BASE_SET: ReadonlySet<string> = new Set(
  DOMAINS.map((d) => d.toLowerCase())
);

/**
 * Builds the effective blocklist = built-in list ∪ DISPOSABLE_DOMAINS_EXTRA.
 * Kept as a small helper so the env can be re-read in tests via `resetEnvCache()`.
 */
export function buildDisposableSet(extraCsv: string | undefined | null): Set<string> {
  const out = new Set(BASE_SET);
  if (!extraCsv) return out;
  for (const raw of extraCsv.split(",")) {
    const d = raw.trim().toLowerCase();
    if (d.length > 0) out.add(d);
  }
  return out;
}

/**
 * Extract the domain part from an email, lowercased. Returns null for
 * malformed input. Caller has already validated the email shape with zod,
 * so this is mostly a belt-and-suspenders split on "@".
 */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  const d = email.slice(at + 1).trim().toLowerCase();
  return d.length > 0 ? d : null;
}

/** True when the email's domain is in the (base + extra) disposable set. */
export function isDisposableEmail(
  email: string,
  disposableSet: ReadonlySet<string>
): boolean {
  const d = emailDomain(email);
  if (!d) return false;
  return disposableSet.has(d);
}

/** Exposed for tests / admin debugging — number of domains in the bundled set. */
export const BASE_DISPOSABLE_COUNT: number = BASE_SET.size;
