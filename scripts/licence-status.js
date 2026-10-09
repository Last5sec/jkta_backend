#!/usr/bin/env node
/**
 * Licence-card delivery status.
 *
 * Read-only diagnostic: prints the stored delivery outcome for a registration
 * (or the most recent registrations) so you can tell whether a card was sent,
 * and if not, why. Never sends email and never modifies data.
 *
 * Usage (run where DB_URL is configured):
 *   node scripts/licence-status.js              # latest 10 of each type
 *   node scripts/licence-status.js ATH1791474206723
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const mongoose = require("mongoose");
const User = require("../model/user");
const Coach = require("../model/coach");

const regNoArg = process.argv[2];

const FIELDS =
    "regNo email photo payment licenceEmailStatus licenceEmailError " +
    "licenceEmailAttempts licenceEmailLastAttemptAt licenceIssuedAt " +
    "enrollmentNumber createdAt";

const TYPES = [
    ["Athlete", User],
    ["Coach", Coach],
];

const show = (label, r) => {
    console.log(`\n${label} ${r.regNo}`);
    console.log(`  paid:           ${r.payment ? "yes" : "no"}`);
    console.log(`  email:          ${r.email || "MISSING"}`);
    console.log(`  photo:          ${r.photo ? "present" : "MISSING"}`);
    console.log(`  licence status: ${r.licenceEmailStatus || "none"}`);
    console.log(`  attempts:       ${r.licenceEmailAttempts || 0}`);
    console.log(`  last attempt:   ${r.licenceEmailLastAttemptAt || "-"}`);
    console.log(`  issued at:      ${r.licenceIssuedAt || "-"}`);
    console.log(`  enrolment no:   ${r.enrollmentNumber || "-"}`);
    if (r.licenceEmailError) console.log(`  last error:     ${r.licenceEmailError}`);

    if (r.payment && r.licenceEmailStatus !== "sent") {
        console.log(
            `  -> NOT DELIVERED${
                r.photo ? "" : " (no profile photo - card cannot be generated)"
            }`
        );
    }
};

(async () => {
    if (!process.env.DB_URL) {
        console.error("DB_URL is not configured; aborting.");
        process.exit(1);
    }

    await mongoose.connect(process.env.DB_URL);

    let found = 0;
    for (const [label, Model] of TYPES) {
        const records = regNoArg
            ? await Model.find({ regNo: regNoArg }).select(FIELDS).lean()
            : await Model.find()
                  .select(FIELDS)
                  .sort({ createdAt: -1 })
                  .limit(10)
                  .lean();

        for (const record of records) {
            show(label, record);
            found += 1;
        }
    }

    if (regNoArg && found === 0) {
        console.log(`\nNo registration found for ${regNoArg}`);
    }
    if (!regNoArg) {
        console.log("\n(Showing the 10 most recent of each type.)");
    }

    await mongoose.disconnect();
})().catch(async (error) => {
    console.error("licence-status error:", error && error.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
