/**
 * Opt-in secret scrubber for OUTBOUND preview strings (the status uplink).
 *
 * Disabled by default — the adapter ships its previews verbatim (truncated).
 * Enable with `AGENT_ADAPTER_SCRUB_SECRETS=1` (also accepts true/yes/on) to
 * redact common secret shapes before anything leaves the process, so an API
 * key sitting in a tool command, a `KEY=…` assignment, an `Authorization`
 * header, or an agent reply never reaches the Commander.
 *
 * This is a best-effort defence-in-depth pass, not a guarantee: it targets the
 * realistic high-recall cases (named credentials + known vendor key shapes) and
 * deliberately avoids generic high-entropy matching, which over-redacts normal
 * code/paths. Truncation in `protocol.toWireStatus` still applies on top.
 */

const REDACTED = '[redacted]';

/** Each entry redacts the secret portion of a match; the rest of the string is kept. */
const PATTERNS: Array<[RegExp, string]> = [
  // PEM private-key blocks.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // Credentials embedded in a URL: scheme://user:password@host  →  keep user, drop password.
  [/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s/@]+@/gi, `$1:${REDACTED}@`],
  // Authorization-style headers: Bearer/Basic/Token <value>.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // Sensitive `name=value` / `name: value` assignments (keep the name + separator).
  [/\b([A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE)[A-Za-z0-9_.-]*)(\s*[=:]\s*)(["']?)[^\s"';,&]{3,}/gi, `$1$2$3${REDACTED}`],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED],
  // Known vendor key shapes (OpenAI, Anthropic, this Commander, GitHub, Slack, AWS, Google, GitLab, npm).
  [/\b(sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{16,}|cmdr_ak_[A-Za-z0-9]{4,}|gh[oprsu]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z_-]{10,}|glpat-[A-Za-z0-9_-]{10,}|npm_[A-Za-z0-9]{20,})/g, REDACTED],
];

/** True when the operator has opted in via AGENT_ADAPTER_SCRUB_SECRETS. */
export function scrubEnabled(): boolean {
  const v = (process.env.AGENT_ADAPTER_SCRUB_SECRETS || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Redact every known secret shape in `s`. Pure; runs regardless of the opt-in flag. */
export function scrub(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Scrub only when opted in; otherwise return the string unchanged. */
export function redactPreview(s: string): string {
  return scrubEnabled() ? scrub(s) : s;
}
