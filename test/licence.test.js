const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const {
    deliverLicence,
    resendLicence,
    REGISTRY,
} = require("../controller/licence");
const idcard = require("../controller/idcard");
const { resolveSmtpConfig } = require("../controller/mailController");

const baseRecord = (overrides = {}) => ({
    _id: "u1",
    regNo: "ATHTEST1",
    email: "player@example.com",
    photo: "https://res.cloudinary.com/demo/image/upload/photo.png",
    athleteName: "Asha",
    fatherName: "Ravi",
    gender: "Female",
    dob: "2000-01-01",
    district: "Jaipur",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
});

/**
 * In-memory deps so the whole workflow runs with a mocked email provider and
 * no database. Mirrors the real contract of buildDeps().
 */
const makeDeps = ({
    record,
    sendResult,
    generateCardImpl,
    locked = false,
    existingEnrollments = [],
} = {}) => {
    const state = {
        record: record || baseRecord(),
        saved: [],
        sentCalls: [],
        deleted: 0,
        locked,
        enrollments: [...existingEnrollments],
        resendRecord: null,
    };

    const enrollmentModel = {
        findOne: async ({ regNo }) =>
            state.enrollments.find((e) => String(e.regNo) === String(regNo)) ||
            null,
        countDocuments: async () => state.enrollments.length,
        create: async ({ enrollmentNumber, regNo }) => {
            const rec = { enrollmentNumber, regNo };
            state.enrollments.push(rec);
            return rec;
        },
    };

    const deps = {
        model: {
            findOne: () => ({ lean: async () => state.resendRecord }),
        },
        enrollmentModel,
        generateCard: generateCardImpl || (async () => "/tmp/card.pdf"),
        deleteFiles: async () => {
            state.deleted += 1;
        },
        downloadImage: async () => "/tmp/photo.png",
        createPlaceholderPhoto: async () => "/tmp/placeholder.png",
        sendWithAttachment: async (...args) => {
            state.sentCalls.push(args);
            return sendResult || { sent: true, messageId: "msg-1", error: null };
        },
        now: () => new Date("2026-02-01T00:00:00Z"),
        save: async (id, patch) => {
            state.saved.push({ id, patch });
            Object.assign(state.record, patch);
            return state.record;
        },
        claim: async (id, now, force) => {
            if (state.locked) return null;
            if (!force && state.record.licenceEmailStatus === "sent") return null;
            return { _id: id };
        },
    };

    return { deps, state };
};

test("delivers the licence and records a successful delivery", async () => {
    const { deps, state } = makeDeps();
    const res = await deliverLicence(state.record, "A", { deps });

    assert.equal(res.sent, true);
    assert.equal(res.status, "sent");
    assert.equal(res.enrollmentNumber, "JKTA1001");
    assert.equal(state.sentCalls.length, 1);

    const patch = state.saved.at(-1).patch;
    assert.equal(patch.licenceEmailStatus, "sent");
    assert.equal(patch.licenceEmailError, null);
    assert.ok(patch.licenceIssuedAt instanceof Date);
    assert.equal(patch.enrollmentNumber, "JKTA1001");
    assert.equal(state.deleted, 1, "temp files are cleaned up");
});

test("reuses an existing enrolment number (never issues a second one)", async () => {
    const { deps, state } = makeDeps({
        existingEnrollments: [{ enrollmentNumber: "JKTA2010", regNo: "u1" }],
    });
    const res = await deliverLicence(state.record, "A", { deps });

    assert.equal(res.enrollmentNumber, "JKTA2010");
    assert.equal(state.enrollments.length, 1);
});

test("is idempotent: an already-sent licence is not emailed again", async () => {
    const { deps, state } = makeDeps();

    const first = await deliverLicence(state.record, "A", { deps });
    assert.equal(first.sent, true);

    // Second call sees the updated record (status "sent") and skips.
    const second = await deliverLicence(state.record, "A", { deps });
    assert.equal(second.skipped, true);
    assert.equal(second.status, "sent");
    assert.equal(state.sentCalls.length, 1, "only one email ever sent");
});

test("email provider failure is recorded and retry reuses the same enrolment number without a new charge/registration", async () => {
    const { deps, state } = makeDeps({
        sendResult: { sent: false, error: "550 Sender rejected" },
    });

    const failed = await deliverLicence(state.record, "A", { deps });
    assert.equal(failed.sent, false);
    assert.equal(failed.status, "failed");
    assert.equal(state.saved.at(-1).patch.licenceEmailStatus, "failed");
    assert.equal(state.saved.at(-1).patch.licenceEmailError, "550 Sender rejected");

    // The card is already assigned; a retry must not create a new number.
    const assigned = state.saved.at(-1).patch.enrollmentNumber;
    assert.equal(assigned, "JKTA1001");

    // Retry succeeds (force = resend).
    deps.sendWithAttachment = async (...args) => {
        state.sentCalls.push(args);
        return { sent: true, messageId: "msg-2", error: null };
    };
    const retry = await deliverLicence(state.record, "A", { force: true, deps });
    assert.equal(retry.sent, true);
    assert.equal(retry.enrollmentNumber, "JKTA1001");
    assert.equal(state.enrollments.length, 1, "no duplicate enrolment number");
});

test("card generation failure keeps the paid registration and records the error", async () => {
    const { deps, state } = makeDeps({
        generateCardImpl: async () => {
            throw new Error("input file is missing");
        },
    });

    const res = await deliverLicence(state.record, "A", { deps });
    assert.equal(res.sent, false);
    assert.equal(res.status, "failed");
    assert.equal(res.error, "input file is missing");
    assert.equal(state.saved.at(-1).patch.licenceEmailStatus, "failed");
    assert.equal(state.sentCalls.length, 0, "nothing is emailed on failure");
    assert.equal(state.deleted, 1, "temp files cleaned up even on failure");
});

test("missing/invalid registered email is recorded without attempting to send", async () => {
    const { deps, state } = makeDeps({ record: baseRecord({ email: "not-an-email" }) });
    const res = await deliverLicence(state.record, "A", { deps });

    assert.equal(res.sent, false);
    assert.equal(res.status, "failed");
    assert.match(res.error, /email address/i);
    assert.equal(state.sentCalls.length, 0);
});

test("a paid registration without a profile photo still gets a card via a placeholder", async () => {
    const { deps, state } = makeDeps({ record: baseRecord({ photo: undefined }) });

    const res = await deliverLicence(state.record, "A", { deps });

    assert.equal(res.sent, true);
    assert.equal(res.status, "sent");
    assert.equal(state.sentCalls.length, 1, "the card is still emailed");
    assert.equal(state.saved.at(-1).patch.licenceEmailStatus, "sent");
});

test("createPlaceholderPhoto produces a real PNG that the card pipeline can read", async () => {
    const id = `PLACEHOLDERTEST${Date.now()}`;
    const outputPath = await idcard.createPlaceholderPhoto(
        `${id}-download.png`,
        "Asha Kumar"
    );

    try {
        const buf = fs.readFileSync(outputPath);
        assert.ok(buf.length > 100, `expected a real PNG, got ${buf.length} bytes`);
    } finally {
        await idcard.deleteFiles(id);
    }
});

test("a concurrent delivery is skipped while the record is locked", async () => {
    const { deps, state } = makeDeps({ locked: true });
    const res = await deliverLicence(state.record, "A", { deps });

    assert.equal(res.sent, false);
    assert.equal(res.skipped, true);
    assert.equal(res.status, "processing");
    assert.equal(state.sentCalls.length, 0);
});

test("resendLicence re-sends for an existing registration using its existing record", async () => {
    const { deps, state } = makeDeps({
        existingEnrollments: [{ enrollmentNumber: "JKTA1001", regNo: "u1" }],
    });
    state.resendRecord = baseRecord({ licenceEmailStatus: "sent" });
    state.record = state.resendRecord;

    const outcome = await resendLicence("ATHTEST1", "A", deps);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.sent, true);
    assert.equal(outcome.result.enrollmentNumber, "JKTA1001");
    assert.equal(state.sentCalls.length, 1);
});

test("licence registry carries the card template type for both athlete and coach", () => {
    assert.equal(REGISTRY.A.cardType, "A");
    assert.equal(REGISTRY.C.cardType, "C");
});

test("deliverLicence passes the card type through to generateCard", async () => {
    let received;
    const { deps, state } = makeDeps({
        generateCardImpl: async (args) => {
            received = args;
            return "/tmp/card.pdf";
        },
    });

    await deliverLicence(state.record, "A", { deps });
    assert.equal(received.type, "A", "a blank/undefined type produces an empty template path");
});

test("resendLicence returns 404 for an unknown registration", async () => {
    const { deps, state } = makeDeps();
    state.resendRecord = null;

    const outcome = await resendLicence("UNKNOWN", "A", deps);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.httpStatus, 404);
});

test("resolveSmtpConfig derives secure from the port", () => {
    const original = { ...process.env };
    try {
        process.env.SMTP_HOST = "smtp-relay.brevo.com";
        process.env.SMTP_EMAIL = "a@b.com";
        process.env.SMTP_PASSWORD = "secret";

        delete process.env.SMTP_SECURE;
        process.env.SMTP_PORT = "587";
        assert.equal(resolveSmtpConfig().secure, false, "587 uses STARTTLS");

        process.env.SMTP_PORT = "465";
        assert.equal(resolveSmtpConfig().secure, true, "465 uses implicit TLS");

        process.env.SMTP_SECURE = "false";
        process.env.SMTP_PORT = "465";
        assert.equal(resolveSmtpConfig().secure, false, "explicit override wins");
    } finally {
        process.env = original;
    }
});

test("generateCard produces a complete, non-empty PDF before resolving", async () => {
    const sharp = require("sharp");
    const id = `UNITTEST${Date.now()}`;
    const input = path.resolve(__dirname, "..", `${id}-download.png`);

    // A real source photo so sharp/pngjs have something to process.
    await sharp({
        create: {
            width: 300,
            height: 300,
            channels: 3,
            background: { r: 10, g: 120, b: 200 },
        },
    })
        .png()
        .toFile(input);

    let outputPath;
    try {
        outputPath = await idcard.generateCard({
            id,
            enrollmentNo: "JKTA1001",
            type: "A",
            name: "Asha",
            parentage: "Ravi",
            gender: "Female",
            dob: "2000-01-01",
            district: "Jaipur",
            valid: "01-01-2027",
        });

        const buf = fs.readFileSync(outputPath);
        assert.ok(buf.length > 800, `expected a non-trivial PDF, got ${buf.length} bytes`);
        assert.equal(buf.subarray(0, 4).toString(), "%PDF");

        // Old bug: the file was still 0 bytes when the promise resolved.
        assert.notEqual(buf.length, 0);
    } finally {
        await idcard.deleteFiles(id);
        if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
});

test("deleteFiles tolerates already-missing files", async () => {
    await assert.doesNotReject(() => idcard.deleteFiles(`NONEXISTENT${Date.now()}`));
});
