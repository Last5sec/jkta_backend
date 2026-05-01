const Coach = require("../model/coach");
const crypto = require("crypto");
const dotenv = require("dotenv");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const fs = require("fs");
const Razorpay = require("razorpay");
const { sendWithAttachment } = require("../controller/mailController");
const expiryDate = require("../utils/expiryDate");

dotenv.config();

const adminEmail = process.env.ADMIN_EMAIL;

// Initialize Razorpay instance
const razorpayInstance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({ dest: "uploads/" });

const uploadFiles = (req, res) => {
    return new Promise((resolve, reject) => {
        const uploadSingle = upload.fields([
            { name: "photo", maxCount: 1 },
            { name: "blackBeltCertificate", maxCount: 1 },
            { name: "birthCertificate", maxCount: 1 },
            { name: "residentCertificate", maxCount: 1 },
            { name: "adharFrontPhoto", maxCount: 1 },
            { name: "adharBackPhoto", maxCount: 1 },
        ]);
        uploadSingle(req, res, (err) => {
            if (err) return reject(err);
            resolve(req.files);
        });
    });
};

const uploadToCloudinary = async (filePath, folder) => {
    try {
        const result = await cloudinary.uploader.upload(filePath, { folder });
        return result.secure_url;
    } catch (error) {
        console.error("Error uploading to Cloudinary:", error);
        throw error;
    }
};

// Register function
exports.register = async (req, res, next) => {
    try {
        const files = await uploadFiles(req, res);

        const {
            playerName,
            fatherName,
            motherName,
            academyName,
            dob,
            gender,
            district,
            mob,
            email,
            adharNumber,
            address,
            pin,
            panNumber,
        } = req.body;

        let photoUrl, blackBeltCertUrl, birthCertUrl, residentCertUrl, adharFrontUrl, adharBackUrl;
        const regNo = `CH${Date.now().toString()}`;

        if (files.photo) {
            photoUrl = await uploadToCloudinary(files.photo[0].path, "uploads");
            fs.unlinkSync(files.photo[0].path);
        }
        if (files.blackBeltCertificate) {
            blackBeltCertUrl = await uploadToCloudinary(files.blackBeltCertificate[0].path, "uploads");
            fs.unlinkSync(files.blackBeltCertificate[0].path);
        }
        if (files.birthCertificate) {
            birthCertUrl = await uploadToCloudinary(files.birthCertificate[0].path, "uploads");
            fs.unlinkSync(files.birthCertificate[0].path);
        }
        if (files.residentCertificate) {
            residentCertUrl = await uploadToCloudinary(files.residentCertificate[0].path, "uploads");
            fs.unlinkSync(files.residentCertificate[0].path);
        }
        if (files.adharFrontPhoto) {
            adharFrontUrl = await uploadToCloudinary(files.adharFrontPhoto[0].path, "uploads");
            fs.unlinkSync(files.adharFrontPhoto[0].path);
        }
        if (files.adharBackPhoto) {
            adharBackUrl = await uploadToCloudinary(files.adharBackPhoto[0].path, "uploads");
            fs.unlinkSync(files.adharBackPhoto[0].path);
        }

        const newCoach = await Coach.create({
            regNo,
            playerName,
            fatherName,
            motherName,
            academyName,
            dob,
            gender,
            district,
            mob,
            email,
            adharNumber,
            address,
            pin,
            panNumber,
            photo: photoUrl,
            blackBeltCertificate: blackBeltCertUrl,
            birthCertificate: birthCertUrl,
            residentCertificate: residentCertUrl,
            adharFrontPhoto: adharFrontUrl,
            adharBackPhoto: adharBackUrl,
        });

        // Amount: 500 INR = 50000 paise
        const orderOptions = {
            amount: email === "info@jkta.in" ? 100 : 50000,
            currency: "INR",
            receipt: `rcpt_${newCoach._id}`,
            payment_capture: 1,
        };

        let order;
        try {
            order = await razorpayInstance.orders.create(orderOptions);
        } catch (razorpayError) {
            console.error("Razorpay order creation failed:", razorpayError);
            return res.status(500).json({
                error: "Payment gateway error. Please try again.",
            });
        }

        // Notify admin - fire and forget
        sendWithAttachment(
            adminEmail,
            `New Coach Registration Initiated (${newCoach.regNo}) - Payment Pending`,
            `Dear Admin,\n\nA new coach registration has been initiated.\n\nName: ${newCoach.playerName}\nReg No: ${newCoach.regNo}\nEmail: ${newCoach.email}\nMobile: ${newCoach.mob}\nDistrict: ${newCoach.district}\n\nPayment is pending.\n\nBest regards,\nJKTA Team`,
            `<h3>Dear Admin,</h3><p>New coach registration initiated:</p><ul><li><strong>Name:</strong> ${newCoach.playerName}</li><li><strong>Reg No:</strong> ${newCoach.regNo}</li><li><strong>Email:</strong> ${newCoach.email}</li><li><strong>Mobile:</strong> ${newCoach.mob}</li><li><strong>District:</strong> ${newCoach.district}</li></ul><p>Payment pending.</p><p>Best regards,<br>JKTA Team</p>`
        );

        res.status(200).json({
            success: true,
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            userId: newCoach._id,
        });
    } catch (error) {
        console.error("Error in coach register:", error);
        res.status(500).json({
            error: "An error occurred while registering the coach.",
        });
    }
};

exports.verifyPayment = async (req, res) => {
    try {
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            userId,
        } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !userId) {
            return res.status(400).json({
                success: false,
                message: "Missing payment verification fields.",
            });
        }

        const generatedSignature = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(razorpay_order_id + "|" + razorpay_payment_id)
            .digest("hex");

        const signatureMatch =
            generatedSignature.length === razorpay_signature.length &&
            crypto.timingSafeEqual(
                Buffer.from(generatedSignature),
                Buffer.from(razorpay_signature)
            );

        if (signatureMatch) {
            const userData = await Coach.findById(userId);

            if (!userData) {
                return res.status(404).json({
                    success: false,
                    message: "Coach record not found.",
                });
            }

            await Coach.findByIdAndUpdate(userData._id, {
                payment: true,
                status: "pending",
            });

            // Notify admin - fire and forget
            sendWithAttachment(
                adminEmail,
                `Coach Registration Completed - Tracking: ${userData.regNo}`,
                `Dear Admin,\n\nCoach registration payment received.\n\nName: ${userData.playerName}\nReg No: ${userData.regNo}\nPayment ID: ${razorpay_payment_id}\n\nPlease verify and approve.\n\nBest regards,\nJKTA Team`,
                `<h3>Dear Admin,</h3><p>Coach registration payment received:</p><ul><li><strong>Name:</strong> ${userData.playerName}</li><li><strong>Reg No:</strong> ${userData.regNo}</li><li><strong>Payment ID:</strong> ${razorpay_payment_id}</li></ul><p>Please verify and approve.</p><p>Best regards,<br>JKTA Team</p>`
            );

            // Confirm to user - fire and forget
            sendWithAttachment(
                userData.email,
                `Payment Confirmed - Tracking Number: ${userData.regNo}`,
                `Dear ${userData.playerName},\n\nYour payment has been received.\n\nTracking Number: ${userData.regNo}\nPayment ID: ${razorpay_payment_id}\n\nOur team will verify your details shortly.\n\nBest regards,\nJKTA Team`,
                `<h3>Dear ${userData.playerName},</h3><p>Your payment has been successfully received.</p><ul><li><strong>Tracking Number:</strong> ${userData.regNo}</li><li><strong>Payment ID:</strong> ${razorpay_payment_id}</li></ul><p>Our team will verify your details shortly.</p><p>Thank you for your trust in JKTA.</p><p>Best regards,<br>JKTA Team</p>`
            );

            res.status(201).json({
                message: "Payment successful. Admin will verify your details.",
                success: true,
                paymentId: razorpay_payment_id,
                email: userData.email,
                regNo: userData.regNo,
                name: userData.playerName,
            });
        } else {
            console.warn("Payment signature mismatch for coach userId:", userId);
            res.status(400).json({
                success: false,
                message: "Payment verification failed. Please contact support.",
            });
        }
    } catch (error) {
        console.error("Error in coach verifyPayment:", error);
        res.status(500).json({
            success: false,
            message: "Internal server error during payment verification.",
        });
    }
};