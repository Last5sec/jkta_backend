const nodemailer = require("nodemailer");
const dotenv = require("dotenv");
dotenv.config();

/**
 * Resolve SMTP settings.
 *
 * `secure` MUST match the port:
 *   - port 465 => implicit TLS  (secure: true)
 *   - port 587/25 => STARTTLS   (secure: false)
 *
 * The previous code hard-coded `secure: true` while connecting to Brevo on
 * port 587, which produced `SSL routines:tls_validate_record_header:wrong
 * version number` and made every email fail. `SMTP_SECURE` can still override
 * explicitly if a provider needs it.
 */
const resolveSmtpConfig = () => {
    const port = parseInt(process.env.SMTP_PORT, 10) || 587;
    const secure =
        process.env.SMTP_SECURE !== undefined && process.env.SMTP_SECURE !== ""
            ? process.env.SMTP_SECURE === "true"
            : port === 465;

    return {
        host: process.env.SMTP_HOST,
        port,
        secure,
        auth: {
            user: process.env.SMTP_EMAIL,
            pass: process.env.SMTP_PASSWORD,
        },
    };
};

const senderAddress = () =>
    process.env.SMTP_EMAIL_FROM || process.env.SMTP_EMAIL;

let cachedTransporter = null;
const getTransporter = () => {
    if (!cachedTransporter) {
        cachedTransporter = nodemailer.createTransport(resolveSmtpConfig());
    }
    return cachedTransporter;
};

// Sanitize an error before logging so provider/delivery details are captured
// without ever writing credentials or full payloads.
const sanitizeError = (error) => {
    if (!error) return "Unknown error";
    const parts = [error.code, error.command, error.responseCode, error.message]
        .filter(Boolean)
        .map(String);
    return parts.join(" | ") || "Unknown error";
};

/**
 * Send a plain email (no attachment). Rejects on failure so callers that care
 * about delivery can react.
 */
const sendMail = (to, subject, text, html) => {
    const mailOptions = {
        from: senderAddress(),
        to,
        subject,
        text,
        html,
    };

    return new Promise((resolve, reject) => {
        getTransporter().sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error("Error sending email:", sanitizeError(error));
                reject(error);
            } else {
                console.log("Message sent:", info.messageId);
                resolve(info);
            }
        });
    });
};

/**
 * Send email with optional attachment.
 *
 * Returns a structured result `{ sent, messageId, error }` and never throws,
 * so a delivery failure cannot crash the registration/payment flow. Callers
 * are expected to persist `sent`/`error` and offer a retry.
 */
const sendWithAttachment = async (to, subject, text, html, filename, filePath) => {
    try {
        const mailOptions = {
            from: senderAddress(),
            to,
            subject,
            text,
            html,
        };

        // Only attach if both filename and filePath are provided
        if (filename && filePath) {
            mailOptions.attachments = [
                {
                    filename: filename,
                    path: filePath,
                },
            ];
        }

        const info = await getTransporter().sendMail(mailOptions);
        console.log("Email sent successfully:", info.messageId);
        return { sent: true, messageId: info.messageId || null, error: null };
    } catch (error) {
        console.error("Failed to send email:", sanitizeError(error));
        return { sent: false, messageId: null, error: sanitizeError(error) };
    }
};

module.exports = { sendMail, sendWithAttachment, resolveSmtpConfig };
