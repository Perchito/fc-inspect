import nodemailer from 'nodemailer';

// Same iCloud mailbox as fc-crm; ICLOUD_* settings live in this app's own .env on the server.
// Sends as operations@ (staff/operational mail) and always copies in Fernando, unless he's already a recipient.
const FROM = process.env.MAIL_FROM_ADDRESS || 'operations@fccleaningcompany.com';
const CC = process.env.MAIL_CC || 'fernando.c@fccleaningcompany.com';
let transport;
export const emailConfigured = () => !!(process.env.ICLOUD_SMTP_USER && process.env.ICLOUD_SMTP_PASS);

export async function sendEmail({ to, subject, text, html, attachments }) {
  if (!emailConfigured()) throw new Error('Email is not set up on the server');
  transport ??= nodemailer.createTransport({
    host: 'smtp.mail.me.com', port: 587, secure: false,
    auth: { user: process.env.ICLOUD_SMTP_USER, pass: process.env.ICLOUD_SMTP_PASS },
  });
  return transport.sendMail({
    from: { name: process.env.ICLOUD_FROM_NAME || 'FC Cleaning Company', address: FROM },
    to, cc: [to].flat().join(',').toLowerCase().includes(CC.toLowerCase()) ? undefined : CC, subject, text, html, attachments,
  });
}
