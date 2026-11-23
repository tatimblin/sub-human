// Secret patterns, curated from gitleaks' default rules (config/gitleaks.toml, https://github.com/gitleaks/gitleaks,
// Copyright (c) 2019 Zachary Rice, MIT licence). Only rules with a fixed prefix or shape are kept, plus two of ours for
// a long literal assigned to a secret-sounding name, so ordinary prose and code pass. This is data kept as .ts, not
// .json: the hooks module loads only files named like code.

/** One rule: its gitleaks id (or ours) and the expression. */
export interface SecretRule { readonly id: string; readonly re: RegExp }

export const SECRET_RULES: readonly SecretRule[] = [
  { id: 'private-key', re: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY( BLOCK)?-----/ },
  { id: 'aws-secret-key', re: /aws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/i },
  { id: 'aws-access-token', re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/ },
  { id: 'github-token', re: /\bgh[pousr]_[0-9a-zA-Z]{36}\b/ },
  { id: 'github-fine-grained-pat', re: /\bgithub_pat_\w{82}\b/ },
  { id: 'gitlab-pat', re: /\bglpat-[\w-]{20}\b/ },
  { id: 'anthropic-key', re: /\bsk-ant-[\w-]{20,}/ },
  { id: 'openai-api-key', re: /\bsk-(?:proj|svcacct|admin)-[\w-]{20,}/ },
  { id: 'slack-token', re: /\bxox[abposr]-[0-9A-Za-z-]{10,}/ },
  { id: 'slack-webhook-url', re: /hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}/ },
  { id: 'stripe-access-token', re: /\b(?:sk|rk)_(?:test|live|prod)_[0-9a-zA-Z]{10,99}\b/ },
  { id: 'gcp-api-key', re: /\bAIza[\w-]{35}\b/ },
  { id: 'npm-access-token', re: /\bnpm_[a-z0-9]{36}\b/i },
  { id: 'pypi-upload-token', re: /pypi-AgEIcHlwaS5vcmc[\w-]{50,}/ },
  { id: 'sendgrid-api-token', re: /\bSG\.[\w-]{22}\.[\w-]{43}\b/ },
  { id: 'twilio-api-key', re: /\bSK[0-9a-fA-F]{32}\b/ },
  { id: 'bearer-token', re: /\bBearer\s+[\w.~+/-]{20,}=*/i },
  { id: 'jwt', re: /\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/ },
  { id: 'url-credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/:@]{3,}@/ },
  { id: 'secret-assignment', re: /(?:api[_-]?key|secret|token|passw(?:or)?d)\w*["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i },
  { id: 'secret-env-line', re: /^\s*(?:export\s+)?[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*=[^\s"']{16,}/m },
];
