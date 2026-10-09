const test = require("node:test");
const assert = require("node:assert");
const express = require("express");

// Configure the environment BEFORE loading the routes (dotenv does not
// override already-set variables, so these stay in effect).
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_test_dummy";
process.env.RAZORPAY_KEY_SECRET = "test_secret_do_not_use";
process.env.NODE_ENV = "production";
process.env.USE_MOCK_RAZORPAY = "false";

const router = require("../routes/user");

// Boot the real router on an ephemeral port.
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

test("POST /verify-payment rejects a forged signature", async () => {
    await withServer(async (base) => {
        const res = await fetch(`${base}/verify-payment`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                razorpay_order_id: "order_test",
                razorpay_payment_id: "pay_test",
                razorpay_signature: "deadbeefdeadbeef",
                userId: "000000000000000000000000",
            }),
        });

        assert.equal(res.status, 400);
        const json = await res.json();
        assert.equal(json.success, false);
    });
});

test("POST /verify-payment rejects missing fields", async () => {
    await withServer(async (base) => {
        const res = await fetch(`${base}/verify-payment`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ razorpay_order_id: "order_test" }),
        });

        assert.equal(res.status, 400);
        const json = await res.json();
        assert.equal(json.success, false);
    });
});

test("POST /resend-licence is disabled when no secret is configured", async () => {
    delete process.env.LICENCE_RESEND_SECRET;

    await withServer(async (base) => {
        const res = await fetch(`${base}/resend-licence`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ regNo: "ATH1" }),
        });

        assert.equal(res.status, 503);
    });
});

test("POST /resend-licence rejects an incorrect secret", async () => {
    process.env.LICENCE_RESEND_SECRET = "test_resend_secret";

    await withServer(async (base) => {
        const res = await fetch(`${base}/resend-licence`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-resend-secret": "wrong",
            },
            body: JSON.stringify({ regNo: "ATH1" }),
        });

        assert.equal(res.status, 401);
    });
});

test("POST /resend-licence requires regNo when authorised", async () => {
    process.env.LICENCE_RESEND_SECRET = "test_resend_secret";

    await withServer(async (base) => {
        const res = await fetch(`${base}/resend-licence`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-resend-secret": "test_resend_secret",
            },
            body: JSON.stringify({}),
        });

        assert.equal(res.status, 400);
    });
});
