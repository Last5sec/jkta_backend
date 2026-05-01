const User = require("../model/user");
const crypto = require("crypto");
const dotenv = require("dotenv");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const fs = require("fs");
const Razorpay = require("razorpay");
const path = require("path");
const { sendWithAttachment } = require("../controller/mailController");
const expiryDate = require("../utils/expiryDate");

dotenv.config();

const adminEmail = process.env.ADMIN_EMAIL;

// Initialize Razorpay instance using environment variables
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

// Configure Multer for file uploads
const upload = multer({ dest: "uploads/" });

// Function to handle file uploads
const uploadFiles = (req, res) => {
    return new Promise((resolve, reject) => {
        const uploadSingle = upload.fields([
            { name: "photo", maxCount: 1 },
            { name: "certificate", maxCount: 1 },
            { name: "residentCertificate", maxCount: 1 },
            { name: "adharFrontPhoto", maxCount: 1 },
            { name: "adharBackPhoto", maxCount: 1 },
        ]);

        uploadSingle(req, res, (err) => {
            if (err) {
                return reject(err);
            }
            resolve(req.files);
        });
    });
};

// Function to upload files to Cloudinary
const uploadToCloudinary = async (filePath, folder) => {
    try {
        const result = await cloudinary.uploader.upload(filePath, {
            folder: folder,
        });
        return result.secure_url;
    } catch (error) {
        console.error("Error uploading to Cloudinary:", error);
        throw error;
    }
};

// Register function
exports.register = async (req, res, next) => {
    try {
        // Upload files using Multer
        const files = await uploadFiles(req, res);

        const {
            athleteName,
            fatherName,
            motherName,
            dob,
            gender,
            district,
            mob,
            email,
            adharNumber,
            address,
            pin,
            panNumber,
            academyName,
            coachName,
        } = req.body;

        // Initialize file URLs
        let photoUrl,
            certificateUrl,
            residentCertificateUrl,
            adharFrontPhotoUrl,
            adharBackPhotoUrl;

        const regNo = `ATH${Date.now().toString()}`;

        // Upload each file to Cloudinary
        if (files.photo) {
            photoUrl = await uploadToCloudinary(files.photo[0].path, "uploads");
            fs.unlinkSync(files.photo[0].path);
        }
        if (files.certificate) {
            certificateUrl = await uploadToCloudinary(files.certificate[0].path, "uploads");
            fs.unlinkSync(files.certificate[0].path);
        }
        if (files.residentCertificate) {
            residentCertificateUrl = await uploadToCloudinary(files.residentCertificate[0].path, "uploads");
            fs.unlinkSync(files.residentCertificate[0].path);
        }
        if (files.adharFrontPhoto) {
            adharFrontPhotoUrl = await uploadToCloudinary(files.adharFrontPhoto[0].path, "uploads");
            fs.unlinkSync(files.adharFrontPhoto[0].path);
        }
        if (files.adharBackPhoto) {
            adharBackPhotoUrl = await uploadToCloudinary(files.adharBackPhoto[0].path, "uploads");
            fs.unlinkSync(files.adharBackPhoto[0].path);
        }

        // Create a new user in the database
        const newUser = await User.create({
            regNo,
            athleteName,
            fatherName,
            motherName,
            dob,
            gender,
            district,
            mob,
            email,
            adharNumber,
            address,
            pin,
            panNumber,
            academyName,
            coachName,
            photo: photoUrl,
            certificate: certificateUrl,
            residentCertificate: residentCertificateUrl,
            adharFrontPhoto: adharFrontPhotoUrl,
            adharBackPhoto: adharBackPhotoUrl,
        });

        // Prepare Razorpay order options
        // Amount is in paise: 300 INR = 30000 paise
        const orderOptions = {
            amount: email === "info@jkta.in" ? 100 : 30000,
            currency: "INR",
            receipt: `rcpt_${newUser._id}`,
            payment_capture: 1,
        };

        // Create Razorpay order
        let order;
        try {
            order = await razorpayInstance.orders.create(orderOptions);
        } catch (razorpayError) {
            console.error("Razorpay order creation failed:", razorpayError);
            return res.status(500).json({
                error: "Payment gateway error. Please try again.",
            });
        }

        // Notify admin - fire and forget (email failure won't block registration)
        sendWithAttachment(
            adminEmail,
            `New Athlete Registration Initiated (${newUser.regNo}) - Payment Pending`,
            `Dear Admin,\n\nA new Athlete registration has been initiated.\n\nName: ${newUser.athleteName}\nReg No: ${newUser.regNo}\nEmail: ${newUser.email}\nMobile: ${newUser.mob}\nDistrict: ${newUser.district}\n\nPayment is pending.\n\nBest regards,\nJKTA Team`,
            `<h3>Dear Admin,</h3><p>A new Athlete registration has been initiated with the following details:</p><ul><li><strong>Name:</strong> ${newUser.athleteName}</li><li><strong>Registration Number:</strong> ${newUser.regNo}</li><li><strong>Email:</strong> ${newUser.email}</li><li><strong>Mobile:</strong> ${newUser.mob}</li><li><strong>District:</strong> ${newUser.district}</li></ul><p>Payment is pending. You will be notified once received.</p><p>Best regards,<br>JKTA Team</p>`
        );

        // Send order details to the client for payment processing
        res.status(200).json({
            success: true,
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            userId: newUser._id,
        });
    } catch (error) {
        console.error("Error in register function:", error);
        res.status(500).json({
            error: "An error occurred while registering. Please try again.",
        });
    }
};

// Function to verify payment
exports.verifyPayment = async (req, res) => {
    try {
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            userId,
        } = req.body;

        // Validate required fields
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !userId) {
            return res.status(400).json({
                success: false,
                message: "Missing payment verification fields.",
            });
        }

        // Generate expected signature using HMAC SHA256
        const generatedSignature = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(razorpay_order_id + "|" + razorpay_payment_id)
            .digest("hex");

        // Timing-safe comparison to prevent timing attacks
        const signatureMatch =
            generatedSignature.length === razorpay_signature.length &&
            crypto.timingSafeEqual(
                Buffer.from(generatedSignature),
                Buffer.from(razorpay_signature)
            );

        if (signatureMatch) {
            const userData = await User.findById(userId);

            if (!userData) {
                return res.status(404).json({
                    success: false,
                    message: "User record not found.",
                });
            }

            // Mark payment as successful
            await User.findByIdAndUpdate(userData._id, {
                payment: true,
                status: "pending",
            });

            // Send confirmation email to admin - fire and forget
            sendWithAttachment(
                adminEmail,
                `Athlete Registration Completed - Tracking: ${userData.regNo}`,
                `Dear Admin,\n\nAthlete registration completed.\n\nName: ${userData.athleteName}\nReg No: ${userData.regNo}\nPayment ID: ${razorpay_payment_id}\n\nPlease verify and approve.\n\nBest regards,\nJKTA Team`,
                `<h3>Dear Admin,</h3><p>Athlete registration payment received:</p><ul><li><strong>Name:</strong> ${userData.athleteName}</li><li><strong>Reg No:</strong> ${userData.regNo}</li><li><strong>Payment ID:</strong> ${razorpay_payment_id}</li></ul><p>Please verify and approve.</p><p>Best regards,<br>JKTA Team</p>`
            );

            // Send confirmation email to user - fire and forget
            sendWithAttachment(
                userData.email,
                `Payment Confirmed - Tracking Number: ${userData.regNo}`,
                `Dear ${userData.athleteName},\n\nYour payment has been received.\n\nTracking Number: ${userData.regNo}\nPayment ID: ${razorpay_payment_id}\n\nWe will verify your details shortly.\n\nBest regards,\nJKTA Team`,
                `<h3>Dear ${userData.athleteName},</h3><p>Your payment has been successfully received.</p><ul><li><strong>Tracking Number:</strong> ${userData.regNo}</li><li><strong>Payment ID:</strong> ${razorpay_payment_id}</li></ul><p>Our team will verify your details shortly.</p><p>Thank you for your trust in JKTA.</p><p>Best regards,<br>JKTA Team</p>`
            );

            res.status(201).json({
                message: "Payment successful. Admin will verify your details.",
                success: true,
                paymentId: razorpay_payment_id,
                email: userData.email,
                regNo: userData.regNo,
                name: userData.athleteName,
            });
        } else {
            console.warn("Payment signature mismatch for userId:", userId);
            res.status(400).json({
                success: false,
                message: "Payment verification failed. Please contact support.",
            });
        }
    } catch (error) {
        console.error("Error in verifyPayment:", error);
        res.status(500).json({
            success: false,
            message: "Internal server error during payment verification.",
        });
    }
};