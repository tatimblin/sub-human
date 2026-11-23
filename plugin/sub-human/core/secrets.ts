// The secret filter (R14a): nothing that looks like a secret, and no secret-holding or ignored file, is ever shared.
// Pure; the caller passes the repo's ignore text. It errs toward refusing: a path it can't judge is refused.
import ignore, { isPathValid } from '../vendor/ignore.mjs';
import { SECRET_RULES } from './data/secret-patterns.js';
import { oneLine } from './text.js';

// Files that hold secrets by name, matched on the last path part, and by the folder they sit in.
const SECRET_FILES = /^(?:\.env(?:\..*)?|\.envrc|.*\.(?:pem|key|p12|pfx|p8|jks|keystore|tfstate)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|credentials\.json|service-account.*\.json)$/i;
const SECRET_DIRS = /(?:^|\/)(?:\.aws\/(?:credentials|config)|\.docker\/config\.json|\.kube\/config|[^/]*\.tfstate\.backup)$/;

// the last ignore text compiled: the same repo's text comes on every call, and compiling it is the cost
let cached: { readonly text: string; readonly ig: ReturnType<typeof ignore> } | null = null;

/** Whether a repo-relative path may not be shared: a secret file by name, or one the ignore text ignores. */
export function refusedPath(rel: string, ignoreText = ''): boolean {
  if (!isPathValid(rel)) return true;
  if (SECRET_FILES.test(rel.split('/').at(-1) ?? '') || SECRET_DIRS.test(rel)) return true;
  if (!ignoreText) return false;
  if (cached?.text !== ignoreText) cached = { text: ignoreText, ig: ignore().add(ignoreText) };
  return cached.ig.ignores(rel);
}

/**
 * The id of the first secret rule the text matches, or null. Checked before and after cleaning: an escape sequence can
 * split a secret, and removing a zero-width character or an escape can join one.
 */
export function secretIn(text: string): string | null {
  const clean = oneLine(text, text.length + 1);
  return SECRET_RULES.find(r => r.re.test(text) || r.re.test(clean))?.id ?? null;
}
