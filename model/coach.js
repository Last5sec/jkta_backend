const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const coachSchema = new Schema(
    {
        regNo: String,
        playerName: String,
        fatherName: String,
        motherName: String,
        academyName: String,
        dob: String,
        gender: String,
        district: String,
        mob: String,
        email: String,
        adharNumber: String,
        address: String,
        pin: String,
        panNumber: String,
        photo: String,
        blackBeltCertificate: String,
        birthCertificate: String,
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
        licenceProcessingAt: Date,
        // Guards so repeated payment callbacks do not re-send confirmations.
        paymentEmailSentAt: Date,
        adminPaymentNotifiedAt: Date,
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model("Coach", coachSchema);
