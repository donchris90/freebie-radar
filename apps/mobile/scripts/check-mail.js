// Sends one real test email with your .env settings and prints the exact result.
//   npm run check:mail -- you@example.com
const { resolve } = require('path');
const fs = require('fs');
const envFile = resolve(process.cwd(), '.env');
if (fs.existsSync(envFile) && process.loadEnvFile) process.loadEnvFile(envFile);
const nodemailer = require('nodemailer');

const to = process.argv[2];
if (!to) { console.error('Usage: npm run check:mail -- you@example.com'); process.exit(2); }
const url = process.env.SMTP_URL;
console.log('MAIL_DRIVER =', process.env.MAIL_DRIVER || '(not set)');
console.log('MAIL_FROM   =', process.env.MAIL_FROM || '(not set)');
if (!url) { console.error('\nSMTP_URL is not set in apps/api/.env, so the API only prints emails to its console and never sends them.'); process.exit(1); }
if ((process.env.MAIL_DRIVER || 'smtp') !== 'smtp') console.warn('\nWARNING: MAIL_DRIVER is not "smtp", so the API will NOT send real email even though SMTP_URL is set.');
let safe = url; try { const u = new URL(url); safe = `${u.protocol}//${decodeURIComponent(u.username)}:***@${u.host}`; } catch { console.error('\nSMTP_URL is not a valid URL. Encode "@" in the username as %40 and any special characters in the password.'); process.exit(1); }
console.log('SMTP_URL    =', safe, '\n');

const t = nodemailer.createTransport(url);
(async () => {
  try {
    await t.verify();
    console.log('Login to the mail server: OK');
    const r = await t.sendMail({ from: process.env.MAIL_FROM, to, subject: 'Freebie Radar test email', text: 'If you can read this, email delivery works.' });
    console.log('Sent. accepted =', r.accepted, 'rejected =', r.rejected, '\nCheck the inbox AND the spam folder.');
  } catch (e) {
    console.error('FAILED:', e.code || '', e.responseCode || '', e.message);
    if (e.responseCode === 535 || e.code === 'EAUTH') console.error('Gmail rejected the login. Use a 16-character App Password (2-Step Verification must be on), not your normal password.');
    process.exit(1);
  }
})();
