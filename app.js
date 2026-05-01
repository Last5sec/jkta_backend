const express = require("express");
const app = express();
const bodyParser = require("body-parser");
const cors = require("cors");
const Mongoose = require("mongoose");
require("dotenv").config();

const allowedOrigins = [
    "https://client-work-august.vercel.app",
    "http://localhost:5173",
    "http://localhost:3000",
];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, Postman, etc.)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
}));

app.use(bodyParser.json({ extended: false }));

const User = require("./routes/user");
app.use(User);

Mongoose.connect(process.env.DB_URL)
    .then(() => {
        app.listen(process.env.PORT || 3000);
        console.log(`Database connected & Server running on port ${process.env.PORT || 3000}`);
    })
    .catch((err) => {
        console.error("Error connecting to database:", err);
    });