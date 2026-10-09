const crypto = require("crypto");

const User = require("../model/user");
const Coach = require("../model/coach");
const AtheleteEnrollment = require("../model/athleteEnrollment");
const CoachEnrollment = require("../model/coachEnrollment");
const { generateCard, deleteFiles } = require("./idcard");
const { sendWithAttachment } = require("./mailController");
const { downloadImage } = require("../utils/downloadImage");
const expiryDate = require("../utils/expiryDate");

// How long a delivery attempt may hold the per-record lock before another
// attempt (or a retry) is allowed to take over. Protects against a crashed
// process leaving a record permanently "processing".
const LOCK_TTL_MS = 5 * 60 * 1000;

const REGISTRY = {
    A: {
        model: User,
        enrollmentModel: AtheleteEnrollment,
        base: 1000,
        nameField: "athleteName",
        label: "Athlete",
        cardType: "A",
    },
    C: {
        model: Coach,
        enrollmentModel: CoachEnrollment,
        base: 10000,
        nameField: "playerName",
        label: "Coach",
        cardType: "C",
    },
};

/**
 * Build the real (database + mailer + filesystem) dependencies for a type.
 * Kept injectable so the delivery workflow can be exercised in tests with
 * mocked gateways/providers and no real DB or inbox.
 */
const buildDeps = (type) => {
    const cfg = REGISTRY[type];
    return {
        model: cfg.model,
        enrollmentModel: cfg.enrollmentModel,
        generateCard,
        deleteFiles,
        sendWithAttachment,
        downloadImage,
        now: () => new Date(),
        save: (id, patch) =>
            cfg.model
                .findByIdAndUpdate(id, { $set: patch }, { new: true })
                .lean(),
        // Atomically claim the right to deliver. Skips records already
        // delivered (unless forced) and records currently being processed.
        claim: (id, now, force) =>
            cfg.model
                .findOneAndUpdate(
                    {
                        _id: id,
                        ...(force
                            ? {}
                            : { licenceEmailStatus: { $ne: "sent" } }),
                        $or: [
                            { licenceProcessingAt: { $exists: false } },
                            { licenceProcessingAt: null },
                            {
                                licenceProcessingAt: {
                                    $lt: new Date(now.getTime() - LOCK_TTL_MS),
                                },
                            },
                        ],
                    },
                    { $set: { licenceProcessingAt: now } },
                    { new: true }
                )
                .lean(),
    };
};

/**
 * Allocate (or reuse) the enrolment number linked to a registration.
 * Uses the same numbering scheme as the admin backend so a registration
 * approved later reuses the same number instead of creating a new one.
 */
const assignEnrollmentNumber = async (record, cfg, deps) => {
    if (record.enrollmentNumber) return record.enrollmentNumber;

    const existing = await deps.enrollmentModel.findOne({ regNo: record._id });
    if (existing) return existing.enrollmentNumber;

    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const count = await deps.enrollmentModel.countDocuments();
        const enrollmentNumber = `JKTA${cfg.base + count + 1 + attempt}`;
        try {
            const created = await deps.enrollmentModel.create({
                enrollmentNumber,
                regNo: record._id,
            });
            return created.enrollmentNumber;
        } catch (error) {
            lastError = error;
            // 11000 = duplicate key on the unique enrolment number; retry.
            if (error && error.code === 11000) continue;
            throw error;
        }
    }

    throw lastError || new Error("Could not allocate an enrolment number");
};

const buildCard = async (record, cfg, enrollmentNumber, deps) => {
    if (!record.photo) {
        throw new Error("Profile photo is missing; cannot generate licence card");
    }
    if (!cfg.cardType) {
        // Guards against a blank card template path (doc.image("") => ENOENT).
        throw new Error("Card type is not configured for this licence");
    }

    await deps.downloadImage(
        record.photo,
        `${record.regNo}-download.png`
    );

    return deps.generateCard({
        id: record.regNo,
        enrollmentNo: enrollmentNumber,
        type: cfg.cardType,
        name: record[cfg.nameField],
        parentage: record.fatherName,
        gender: record.gender,
        dob: `${record.dob}`,
        district: record.district,
        valid: expiryDate(record.createdAt || new Date()),
    });
};

/**
 * Idempotently generate and email a registration's licence card.
 *
 * - Reuses an existing enrolment number; never issues a second one.
 * - Never sends twice unless `force` is set (used only by resend).
 * - Records delivery status + sanitized error on the registration.
 * - Keeps the paid registration intact even when delivery fails.
 *
 * @returns {{sent:boolean,status:string,skipped?:boolean,messageId?:string,
 *            enrollmentNumber?:string,error?:string}}
 */
const deliverLicence = async (record, type, options = {}) => {
    const { force = false, deps = null } = options;
    const cfg = REGISTRY[type];
    const d = deps || buildDeps(type);

    if (!cfg) {
        return { sent: false, status: "failed", error: "Unsupported licence type" };
    }

    // Missing/invalid recipient: record the problem, keep the registration.
    if (!record.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email)) {
        const error = "Registered email address is missing or invalid";
        await d.save(record._id, {
            licenceEmailStatus: "failed",
            licenceEmailError: error,
            licenceEmailLastAttemptAt: d.now(),
        });
        return { sent: false, status: "failed", error };
    }

    if (!force && record.licenceEmailStatus === "sent") {
        return {
            sent: true,
            status: "sent",
            skipped: true,
            enrollmentNumber: record.enrollmentNumber,
        };
    }

    const now = d.now();
    const claimed = await d.claim(record._id, now, force);
    if (!claimed) {
        return {
            sent: false,
            status: record.licenceEmailStatus === "sent" ? "sent" : "processing",
            skipped: true,
            enrollmentNumber: record.enrollmentNumber,
        };
    }

    const attempts = (record.licenceEmailAttempts || 0) + 1;
    let enrollmentNumber;
    let cardPath;
    let result;

    try {
        enrollmentNumber = await assignEnrollmentNumber(record, cfg, d);
        cardPath = await buildCard(record, cfg, enrollmentNumber, d);

        const validUntil = expiryDate(record.createdAt || new Date());
        result = await d.sendWithAttachment(
            record.email,
            `${enrollmentNumber} - Congratulations, your JKTA ${cfg.label} Licence is attached`,
            `Dear ${record[cfg.nameField]},\n\nCongratulations! Your payment has been verified and your JKTA ${cfg.label} Licence is attached to this email.\n\nTracking Number: ${record.regNo}\nEnrolment Number: ${enrollmentNumber}\nValid Until: ${validUntil}\nName: ${record[cfg.nameField]}\n\nPlease keep this email for future reference.\n\nBest regards,\nJKTA Team`,
            `<h3>Dear ${record[cfg.nameField]},</h3><p>Congratulations! Your payment has been verified and your JKTA ${cfg.label} Licence is attached to this email.</p><table><tr><td><strong>Tracking Number:</strong></td><td>${record.regNo}</td></tr><tr><td><strong>Enrolment Number:</strong></td><td>${enrollmentNumber}</td></tr><tr><td><strong>Valid Until:</strong></td><td>${validUntil}</td></tr><tr><td><strong>Name:</strong></td><td>${record[cfg.nameField]}</td></tr></table><p>Please keep this email for future reference.</p><p>Best regards,<br>JKTA Team</p>`,
            `${record.regNo}-identity-card.pdf`,
            cardPath
        );

        if (result && result.sent) {
            await d.save(record._id, {
                enrollmentNumber,
                licenceEmailStatus: "sent",
                licenceEmailMessageId: result.messageId || null,
                licenceEmailError: null,
                licenceEmailAttempts: attempts,
                licenceEmailLastAttemptAt: d.now(),
                licenceIssuedAt: d.now(),
                licenceProcessingAt: null,
            });
            return {
                sent: true,
                status: "sent",
                messageId: result.messageId || null,
                enrollmentNumber,
            };
        }

        const error = (result && result.error) || "Email provider rejected the message";
        await d.save(record._id, {
            enrollmentNumber,
            licenceEmailStatus: "failed",
            licenceEmailError: error,
            licenceEmailAttempts: attempts,
            licenceEmailLastAttemptAt: d.now(),
            licenceProcessingAt: null,
        });
        return { sent: false, status: "failed", enrollmentNumber, error };
    } catch (error) {
        // Card generation / download failure: keep the paid registration and
        // record enough to retry, without ever charging the player again.
        const message =
            error && error.message ? error.message : "Licence generation failed";
        try {
            await d.save(record._id, {
                ...(enrollmentNumber ? { enrollmentNumber } : {}),
                licenceEmailStatus: "failed",
                licenceEmailError: message,
                licenceEmailAttempts: attempts,
                licenceEmailLastAttemptAt: d.now(),
                licenceProcessingAt: null,
            });
        } catch (saveError) {
            console.error(
                "Could not persist licence delivery failure:",
                saveError && saveError.message
            );
        }
        return {
            sent: false,
            status: "failed",
            enrollmentNumber,
            error: message,
        };
    } finally {
        // Best-effort temp cleanup; retries regenerate the card.
        try {
            await d.deleteFiles(record.regNo);
        } catch (_) {
            /* ignore cleanup errors */
        }
    }
};

/**
 * Safely resend an existing registration's licence without any new payment
 * or registration. Reuses the existing enrolment number.
 */
const resendLicence = async (regNo, type, deps = null) => {
    const cfg = REGISTRY[type];
    if (!cfg) {
        return { ok: false, httpStatus: 400, error: "Unsupported licence type" };
    }

    const d = deps || buildDeps(type);
    const model = (d && d.model) || cfg.model;
    const record = await model.findOne({ regNo }).lean();
    if (!record) {
        return { ok: false, httpStatus: 404, error: "Registration not found" };
    }

    const result = await deliverLicence(record, type, { force: true, deps: d });
    return { ok: true, httpStatus: result.sent ? 200 : 502, result };
};

/**
 * Constant-time comparison used by the protected resend endpoint.
 */
const secretMatches = (provided, expected) => {
    if (!expected || !provided) return false;
    const a = Buffer.from(String(provided));
    const b = Buffer.from(String(expected));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
};

module.exports = {
    REGISTRY,
    buildDeps,
    assignEnrollmentNumber,
    deliverLicence,
    resendLicence,
    secretMatches,
};
