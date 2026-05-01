const nodemailer = require("nodemailer");
const dotenv = require("dotenv");
dotenv.config();

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT),
    secure: true,
    auth: {
        user: process.env.SMTP_EMAIL,
        pass: process.env.SMTP_PASSWORD,
    },
});

// Send a plain email (no attachment)
const sendMail = (to, subject, text, html) => {
    const mailOptions = {
        from: process.env.SMTP_EMAIL,
        to,
        subject,
        text,
        html,
    };

    return new Promise((resolve, reject) => {
        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error("Error sending email:", error);
                reject(error);
            } else {
                console.log("Message sent:", info.messageId);
                resolve(info);
            }
        });
    });
};

// Send email with optional attachment
// filename and filePath are optional — if omitted, sends without attachment
const sendWithAttachment = async (to, subject, text, html, filename, filePath) => {
    try {
        const mailOptions = {
            from: process.env.SMTP_EMAIL,
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

        const transporter2 = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT),
            secure: true,
            auth: {
                user: process.env.SMTP_EMAIL,
                pass: process.env.SMTP_PASSWORD,
            },
        });

        const info = await transporter2.sendMail(mailOptions);
        console.log("Email sent successfully:", info.messageId);
        return info;
    } catch (error) {
        console.error("Failed to send email:", error);
        // Do not throw — email failure should not crash the registration flow
    }
};

module.exports = { sendMail, sendWithAttachment };