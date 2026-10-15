import { Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { AppConfig } from '../config/config';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}
export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}
export const MAILER = Symbol('MAILER');

/** Development only: prints the email (including any code in it) to the API console. */
export class LogMailer implements Mailer {
  private readonly log = new Logger('Mail');
  async send(m: MailMessage) {
    this.log.log(`\n--- email (not actually sent: MAIL_DRIVER=log) ---\nTo: ${m.to}\nSubject: ${m.subject}\n\n${m.text}\n---`);
  }
}

/** Real delivery over SMTP. Written against nodemailer's documented API; not yet exercised against a live provider. */
export class SmtpMailer implements Mailer {
  private readonly transport: nodemailer.Transporter;
  constructor(url: string, private readonly from: string) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(m: MailMessage) {
    await this.transport.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text });
  }
}

export function createMailer(cfg: AppConfig): Mailer {
  if (cfg.mail.driver === 'smtp') return new SmtpMailer(cfg.mail.smtpUrl!, cfg.mail.from);
  return new LogMailer();
}
