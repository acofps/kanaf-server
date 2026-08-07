import nodemailer from "nodemailer";

/* ---------------------------------------------------------
   Extracted from index.js so the auth layer can send mail without
   importing the whole entry point. Two behaviour changes, both of
   which the registration flow depends on:

   1. In production, a missing SMTP config now THROWS instead of
      logging and returning. The old version returned silently and
      /api/send-code answered {ok:true} regardless — so a
      misconfigured Render environment looked identical to a working
      one, and the user just never got a code. Registration cannot
      afford that ambiguity: if the mail didn't go, the caller has to
      know.

   2. Explicit timeouts. Render → cPanel SMTP over port 465 can hang
      on connect, and nodemailer's default is to wait indefinitely,
      holding the request open until the platform kills it.
--------------------------------------------------------- */

const IS_PRODUCTION = process.env.NODE_ENV === "production";

let transporter = null;

function isConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (transporter) return transporter;
  const port = Number(process.env.SMTP_PORT || 465);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465, // implicit TLS on 465; STARTTLS on 587
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  return transporter;
}

export async function sendEmail(to, subject, text, extra = {}) {
  if (!isConfigured()) {
    if (IS_PRODUCTION) {
      // Loud, not silent. A production deploy without SMTP is a broken
      // deploy, and the caller needs to return an honest error.
      throw new Error("SMTP is not configured (SMTP_HOST / SMTP_USER / SMTP_PASS)");
    }
    console.log(`[dev] Would send email to ${to}: ${subject}\n${text}`);
    return { delivered: false, dev: true };
  }

  await getTransporter().sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    ...extra,
  });
  return { delivered: true };
}

/**
 * Verifies the SMTP connection at boot. Called from index.js on
 * startup so a bad mail config shows up in the Render logs at deploy
 * time rather than on a real user's first signup attempt.
 */
export async function verifySmtpConnection() {
  if (!isConfigured()) {
    console.warn("SMTP is not configured — verification emails will fail in production.");
    return false;
  }
  try {
    await getTransporter().verify();
    console.log("SMTP connection verified.");
    return true;
  } catch (err) {
    console.error("SMTP verification FAILED — signup emails will not send:", err.message);
    return false;
  }
}
