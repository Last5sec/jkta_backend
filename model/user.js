const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const userSchema = new Schema(
    {
        regNo: String,
        athleteName: String,
        fatherName: String,
        motherName: String,
        dob: Date,
        gender: String,
        district: String,
        mob: String,
        email: String,
        adharNumber: String,
        address: String,
        pin: String,
        panNumber: String,
        academyName: String,
        coachName: String,
        photo: String,
        certificate: String,
        residentCertificate: String,
        adharFrontPhoto: String,
        adharBackPhoto: String,
        status: {
            enum: ["pending", "approved", "rejected"],
            type: String,
            default: "pending",
        },
        payment: {
            type: Boolean,
            default: false,
        },
        // ---- Licence card delivery tracking ----
        enrollmentNumber: String,
        licenceEmailStatus: {
            type: String,
            enum: ["pending", "sent", "failed"],
        },
        licenceEmailMessageId: String,
        licenceEmailError: String,
        licenceEmailAttempts: {
            type: Number,
            default: 0,
        },
        licenceEmailLastAttemptAt: Date,
        licenceIssuedAt: Date,
        // Short-lived lock preventing concurrent duplicate deliveries.
        licenceProcessingAt: Date,
        // Guards so repeated payment callbacks do not re-send confirmations.
        paymentEmailSentAt: Date,
        adminPaymentNotifiedAt: Date,
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model("Athlete", userSchema);
