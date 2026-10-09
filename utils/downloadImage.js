const fs = require("fs");
const path = require("path");
const axios = require("axios");

/**
 * Download an image URL to a local file inside the project root.
 *
 * `name` is sanitized so it can never be used to write outside the root
 * (path traversal / arbitrary file write protection).
 */
const downloadImage = async (url, name) => {
    if (!url || typeof url !== "string") {
        throw new Error("downloadImage: a valid image URL is required");
    }

    const safeName = path.basename(String(name)).replace(/[^a-zA-Z0-9._-]/g, "_");
    const outputPath = path.resolve(__dirname, "..", safeName);

    const response = await axios({
        url,
        method: "GET",
        responseType: "stream",
        timeout: 20000,
        maxRedirects: 3,
    });

    const writer = fs.createWriteStream(outputPath);

    return new Promise((resolve, reject) => {
        response.data.pipe(writer);
        writer.on("finish", () => resolve(outputPath));
        writer.on("error", reject);
        response.data.on("error", reject);
    });
};

module.exports = { downloadImage };
