#!/usr/bin/env node
/**
 * Recovery / resend utility for already-paid registrations whose licence card
 * was never delivered.
 *
 * Safe by design:
 *   - Dry-run by default (lists targets, sends nothing).
 *   - Never creates a registration, enrolment number, or charge.
 *   - Reuses an existing enrolment number when present.
 *   - Idempotent: delivered registrations are skipped.
 *
 * Usage (run in the environment that has the production DB + SMTP configured):
 *   node scripts/resend-missing-licences.js             # list only
 *   node scripts/resend-missing-licences.js --apply     # actually resend
 *   node scripts/resend-missing-licences.js --apply --limit=25
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const mongoose = require("mongoose");
const User = require("../model/user");
const Coach = require("../model/coach");
const { resendLicence } = require("../controller/licence");

const apply = process.argv.includes("--apply");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : 0;

const TYPES = [
    ["A", User, "Athlete"],
    ["C", Coach, "Coach"],
];

(async () => {
    if (!process.env.DB_URL) {
        console.error("DB_URL is not configured; aborting.");
        process.exit(1);
    }

    await mongoose.connect(process.env.DB_URL);

    // Paid registrations that do not have a delivered licence card.
    const query = { payment: true, licenceEmailStatus: { $ne: "sent" } };

    const targets = [];
    for (const [type, model, label] of TYPES) {
        const records = await model
            .find(query)
            .select("regNo email photo licenceEmailStatus")
            .lean();
        for (const record of records) {
            targets.push({
                type,
                label,
                regNo: record.regNo,
                hasEmail: Boolean(record.email),
                hasPhoto: Boolean(record.photo),
                status: record.licenceEmailStatus || "none",
            });
        }
    }

    // Photo-ready registrations first, so a --limit batch prefers records whose
    // real photo is available.
    targets.sort((a, b) => Number(b.hasPhoto) - Number(a.hasPhoto));

    const selected = limit > 0 ? targets.slice(0, limit) : targets;

    console.log(
        `Found ${targets.length} paid registration(s) without a delivered licence.`
    );
    for (const target of selected) {
        // Deliberately does not print the email address (PII).
        console.log(
            `- ${target.label} ${target.regNo} | email: ${
                target.hasEmail ? "present" : "MISSING"
            } | photo: ${target.hasPhoto ? "present" : "MISSING"} | licence status: ${
                target.status
            }`
        );
    }

    if (!apply) {
        console.log("\nDry run only. Re-run with --apply to resend.");
        await mongoose.disconnect();
        return;
    }

    let sent = 0;
    let failed = 0;
    for (const target of selected) {
        // A missing photo no longer blocks delivery: the card is generated with
        // a neutral initials placeholder so the paid player still receives it.
        const outcome = await resendLicence(target.regNo, target.type);
        if (outcome.ok && outcome.result && outcome.result.sent) {
            sent += 1;
            console.log(`sent: ${target.regNo}`);
        } else {
            failed += 1;
            const reason =
                (outcome.result && outcome.result.error) ||
                outcome.error ||
                "unknown";
            console.log(`failed: ${target.regNo} (${reason})`);
        }
        // Be gentle on the SMTP provider.
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    console.log(`\nDone. sent=${sent} failed=${failed}`);
    await mongoose.disconnect();
})().catch(async (error) => {
    console.error("Recovery script error:", error && error.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
