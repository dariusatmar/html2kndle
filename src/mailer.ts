import nodemailer, { type Transporter } from 'nodemailer';
import { emailConfigured, type Config } from './config.js';
import { UserError, type KindleDocument } from './types.js';

export type MailTransport = Pick<Transporter, 'sendMail'>;

function describeSmtpError(err: unknown, cfg: Config): string {
  const e = err as { code?: string; responseCode?: number; message?: string };
  let msg: string;
  if (e.code === 'EAUTH' || e.responseCode === 535) {
    msg = 'SMTP login was rejected; check SMTP_USER and SMTP_PASS (use an app password)';
  } else if (e.code === 'ECONNECTION' || e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.code === 'ETIMEDOUT' || e.code === 'ESOCKET') {
    msg = `Could not reach the SMTP server ${cfg.smtp.host}:${cfg.smtp.port}`;
  } else if (e.responseCode && e.responseCode >= 500) {
    msg = 'The mail server rejected the message; make sure FROM_EMAIL is on your Amazon Approved Personal Document E-mail List and the file is under Amazon\'s size limit';
  } else {
    msg = 'Mail server error';
  }
  return `Email delivery failed: ${msg}`;
}

export async function sendToKindle(
  doc: KindleDocument,
  cfg: Config,
  transport?: MailTransport,
): Promise<{ messageId: string }> {
  if (!emailConfigured(cfg)) throw new UserError('Email delivery is not configured', 503);
  const t: MailTransport =
    transport ??
    nodemailer.createTransport({
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      secure: cfg.smtp.secure,
      auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    });
  try {
    const info = (await t.sendMail({
      from: cfg.fromEmail,
      to: cfg.kindleEmail,
      subject: doc.title,
      text: `Sent by html2kindle: ${doc.title}`,
      attachments: [{ filename: doc.filename, content: doc.data, contentType: doc.contentType }],
    })) as { messageId?: string };
    return { messageId: String(info.messageId ?? '') };
  } catch (err) {
    console.error('[mailer] send failed:', (err as Error).message?.replaceAll(cfg.smtp.pass, '***'));
    throw new UserError(describeSmtpError(err, cfg), 502);
  }
}
