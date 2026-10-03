import nodemailer from 'nodemailer';

// Same iCloud mailbox as fc-crm (fernando.c@fccleaningcompany.com); the ICLOUD_* settings
// come from /etc/fc-outreach/outreach.env, loaded by the systemd unit.
let transport;
export const emailConfigured = () => !!(process.env.ICLOUD_SMTP_USER && process.env.ICLOUD_SMTP_PASS);

export async function sendEmail({ to, subject, text, attachments }) {
  if (!emailConfigured()) throw new Error('Email is not set up on the server');
  transport ??= nodemailer.createTransport({
    host: 'smtp.mail.me.com', port: 587, secure: false,
    auth: { user: process.env.ICLOUD_SMTP_USER, pass: process.env.ICLOUD_SMTP_PASS },
  });
  return transport.sendMail({
    from: { name: process.env.ICLOUD_FROM_NAME || 'FC Cleaning Company', address: process.env.ICLOUD_FROM_ADDRESS || process.env.ICLOUD_SMTP_USER },
    to, subject, text, attachments,
  });
}
