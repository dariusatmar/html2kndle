/** Runtime configuration, read from environment variables (see .env.example). */
export interface Config {
  port: number;
  /** Shared secret required on every API call. Empty string disables auth (local use only). */
  authToken: string;
  /** Your Send-to-Kindle address, e.g. name_abc123@kindle.com. */
  kindleEmail: string;
  /** Sender address; must be on Amazon's Approved Personal Document E-mail List. */
  fromEmail: string;
  smtp: {
    host: string;
    port: number;
    /** true = implicit TLS (465); false = STARTTLS (587). */
    secure: boolean;
    user: string;
    pass: string;
  };
  /** Max bytes for fetched pages and uploads. */
  maxBytes: number;
  /** Network fetch timeout in ms. */
  fetchTimeoutMs: number;
  /** Allow fetching private/loopback addresses (tests and LAN use only). */
  allowPrivateHosts: boolean;
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const smtpPort = num(env.SMTP_PORT, 587);
  return {
    port: num(env.PORT, 8787),
    authToken: env.AUTH_TOKEN ?? '',
    kindleEmail: env.KINDLE_EMAIL ?? '',
    fromEmail: env.FROM_EMAIL ?? env.SMTP_USER ?? '',
    smtp: {
      host: env.SMTP_HOST ?? '',
      port: smtpPort,
      secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : smtpPort === 465,
      user: env.SMTP_USER ?? '',
      pass: env.SMTP_PASS ?? '',
    },
    maxBytes: num(env.MAX_BYTES, 25 * 1024 * 1024),
    fetchTimeoutMs: num(env.FETCH_TIMEOUT_MS, 20_000),
    allowPrivateHosts: env.ALLOW_PRIVATE_HOSTS === 'true',
  };
}

/** True when everything needed to email the Kindle is present. */
export function emailConfigured(cfg: Config): boolean {
  return Boolean(cfg.kindleEmail && cfg.fromEmail && cfg.smtp.host && cfg.smtp.user && cfg.smtp.pass);
}
