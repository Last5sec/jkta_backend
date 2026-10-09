const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const express = require("express");

// ---- Environment (set before loading routes so dotenv won't override) ----
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_test_dummy";
process.env.RAZORPAY_KEY_SECRET = "test_secret_do_not_use";
process.env.NODE_ENV = "production";
process.env.USE_MOCK_RAZORPAY = "false";
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.LICENCE_RESEND_SECRET = "test_resend_secret";

// ---- Patch external side effects BEFORE loading the controllers ----
// (licence.js/form.js destructure these at require time.)
const mailController = require("../controller/mailController");
const emailLog = [];
let emailResult = { sent: true, messageId: "msg-1", error: null };
mailController.sendWithAttachment = async (to, subject, text, html, filename, filePath) => {
    emailLog.push({ to, subject, text, html, filename, filePath });
    return emailResult;
};

const idcard = require("../controller/idcard");
idcard.generateCard = async () => "/tmp/fake-card.pdf";
idcard.deleteFiles = async () => {};

const downloadImage = require("../utils/downloadImage");
downloadImage.downloadImage = async () => "/tmp/fake-photo.png";

// ---- Fake the mongoose model statics (no database) ----
const User = require("../model/user");
const AtheleteEnrollment = require("../model/athleteEnrollment");

const USER_ID = "000000000000000000000001";
let store = null;

const applyUpdate = (record, update) => {
    if (update.$set) Object.assign(record, update.$set);
    for (const [key, value] of Object.entries(update)) {
        if (key !== "$set") record[key] = value;
    }
    return record;
};

User.findById = async (id) =>
    store && String(store._id) === String(id) ? { ...store } : null;

User.findByIdAndUpdate = (id, update) => {
    if (!store) store = { _id: id };
    applyUpdate(store, update);
    return { lean: async () => ({ ...store }) };
};

User.findOne = (filter) => ({
    lean: async () =>
        store && (!filter.regNo || store.regNo === filter.regNo)
            ? { ...store }
            : null,
});

User.findOneAndUpdate = (filter, update) => {
    if (!store) return { lean: async () => null };
    // The real query filters out already-sent records unless forced, and
    // records currently locked by another attempt.
    if (
        filter.licenceEmailStatus &&
        filter.licenceEmailStatus.$ne === "sent" &&
        store.licenceEmailStatus === "sent"
    ) {
        return { lean: async () => null };
    }
    if (store.licenceProcessingAt) {
        const age = Date.now() - new Date(store.licenceProcessingAt).getTime();
        if (age < 5 * 60 * 1000) return { lean: async () => null };
    }
    applyUpdate(store, update);
    return { lean: async () => ({ ...store }) };
};

AtheleteEnrollment.findOne = async () => null;
AtheleteEnrollment.countDocuments = async () => 0;
AtheleteEnrollment.create = async ({ enrollmentNumber, regNo }) => {
    enrolled = { enrollmentNumber, regNo };
    return enrolled;
};
let enrolled = null;

// Now load the router (this wires the patched dependencies into licence.js).
const router = require("../routes/user");

const seedStore = (overrides = {}) => {
    store = {
        _id: USER_ID,
        regNo: "ATHTEST1",
        email: "player@example.com",
        photo: "https://res.cloudinary.com/demo/photo.png",
        athleteName: "Asha",
        fatherName: "Ravi",
        gender: "Female",
        dob: "2000-01-01",
        district: "Jaipur",
        payment: false,
        status: "pending",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        ...overrides,
    };
    enrolled = null;
    emailLog.length = 0;
    emailResult = { sent: true, messageId: "msg-1", error: null };
};

const sign = (orderId, paymentId) =>
    crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

const withServer = async (fn) => {
    const app = express();
    app.use(express.json());
    app.use(router);

    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();
    try {
        await fn(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
};

const verify = (base, orderId = "order_1", paymentId = "pay_1") =>
    fetch(`${base}/verify-payment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            razorpay_order_id: orderId,
            razorpay_payment_id: paymentId,
            razorpay_signature: sign(orderId, paymentId),
            userId: USER_ID,
        }),
    });

test("verified payment automatically emails the athlete licence card", async () => {
    seedStore();

    await withServer(async (base) => {
        const res = await verify(base);
        const json = await res.json();

        assert.equal(res.status, 201);
        assert.equal(json.success, true);
        assert.equal(json.licenceEmailSent, true);
        assert.equal(json.licenceEmailStatus, "sent");

        // The licence email must carry the PDF attachment.
        const licenceEmail = emailLog.find((m) =>
            String(m.subject).toLowerCase().includes("licence")
        );
        assert.ok(licenceEmail, "a licence email was sent");
        assert.equal(licenceEmail.to, "player@example.com");
        assert.equal(licenceEmail.filename, "ATHTEST1-identity-card.pdf");
        assert.ok(licenceEmail.filePath, "attachment path is present");
        assert.match(licenceEmail.subject, /JKTA1001/);
    });

    // Payment + delivery state persisted on the registration.
    assert.equal(store.payment, true);
    assert.equal(store.licenceEmailStatus, "sent");
    assert.equal(store.enrollmentNumber, "JKTA1001");
    assert.equal(enrolled.enrollmentNumber, "JKTA1001");
});

test("duplicate payment callbacks never re-send the card or re-issue a number", async () => {
    seedStore();

    await withServer(async (base) => {
        await verify(base, "order_1", "pay_1");
        const licenceEmailsAfterFirst = emailLog.filter((m) =>
            String(m.subject).toLowerCase().includes("licence")
        ).length;
        assert.equal(licenceEmailsAfterFirst, 1);

        // Same callback replayed.
        const second = await verify(base, "order_1", "pay_1");
        const json = await second.json();
        assert.equal(second.status, 201);
        assert.equal(json.licenceEmailSent, true);

        const licenceEmailsAfterSecond = emailLog.filter((m) =>
            String(m.subject).toLowerCase().includes("licence")
        ).length;
        assert.equal(licenceEmailsAfterSecond, 1, "no duplicate licence email");
    });

    assert.equal(store.enrollmentNumber, "JKTA1001");
});

test("email provider failure is reported honestly and remains retryable", async () => {
    seedStore();

    await withServer(async (base) => {
        emailResult = { sent: false, messageId: null, error: "550 rejected" };

        const res = await verify(base);
        const json = await res.json();

        assert.equal(res.status, 201);
        assert.equal(json.licenceEmailSent, false);
        assert.equal(json.licenceEmailStatus, "failed");
    });

    // Payment is still recorded and the failure is persisted for a retry.
    assert.equal(store.payment, true);
    assert.equal(store.licenceEmailStatus, "failed");
    assert.equal(store.licenceEmailError, "550 rejected");
    assert.equal(store.enrollmentNumber, "JKTA1001", "number reserved for retry");
});

test("a retry after failure succeeds without any new payment", async () => {
    seedStore();

    await withServer(async (base) => {
        emailResult = { sent: false, messageId: null, error: "550 rejected" };
        await verify(base, "order_1", "pay_1");
        assert.equal(store.licenceEmailStatus, "failed");

        // Simulate the resend/retry after the provider recovers.
        emailResult = { sent: true, messageId: "msg-2", error: null };
        const res = await fetch(`${base}/resend-licence`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-resend-secret": "test_resend_secret",
            },
            body: JSON.stringify({ regNo: "ATHTEST1" }),
        });

        assert.equal(res.status, 200);
        const json = await res.json();
        assert.equal(json.success, true);
    });

    assert.equal(store.licenceEmailStatus, "sent");
    assert.equal(store.enrollmentNumber, "JKTA1001", "same enrolment number");
});
