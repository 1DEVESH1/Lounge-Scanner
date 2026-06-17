"use strict";

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 5020;
const BOOKING_SERVICE_URL = (process.env.BOOKING_SERVICE_URL || "http://localhost:5010").replace(/\/$/, "");
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "";

// ── Middleware ────────────────────────────────────────────────────────────────
const PUBLIC_DIR = path.resolve(__dirname, "public");
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ── Proxy: Validate ──────────────────────────────────────────────────────────
/**
 * POST /api/validate
 * Body: { token: "<scanned JWT>", outletId: "<uuid>" }
 *
 * Proxies to:
 *   POST <BOOKING_SERVICE_URL>/api/v1/booking/validate-booking
 *   Headers: X-Internal-Api-Key, X-Lounge-QR-Token: <token>
 *   Body:    { outletId }
 */
app.post("/api/validate", async (req, res) => {
  const { token, outletId } = req.body || {};

  if (!token) {
    return res.status(400).json({ success: false, error: "token is required" });
  }
  if (!outletId) {
    return res.status(400).json({ success: false, error: "outletId is required" });
  }

  try {
    const response = await axios.post(
      `${BOOKING_SERVICE_URL}/api/v1/booking/validate-booking`,
      { outletId },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Api-Key": INTERNAL_API_KEY,
          "X-Lounge-QR-Token": token,
        },
        // Don't throw on 4xx/5xx — pass the status through to the client
        validateStatus: () => true,
      }
    );
    return res.status(response.status).json(response.data);
  } catch (err) {
    console.error("[validate] proxy error:", err.message);
    return res.status(502).json({ success: false, error: "Booking service unreachable", detail: err.message });
  }
});

// ── Proxy: Redeem ────────────────────────────────────────────────────────────
/**
 * POST /api/redeem
 * Body: { bookingId, bookingItemId, outletId, scannerId?, redeemedBy? }
 *
 * Proxies to:
 *   POST <BOOKING_SERVICE_URL>/api/v1/booking/redeem-booking
 *   Headers: X-Internal-Api-Key
 *   Body:    { bookingId, bookingItemId, outletId, scannerId?, redeemedBy? }
 */
app.post("/api/redeem", async (req, res) => {
  const { bookingId, bookingItemId, outletId, scannerId, redeemedBy } = req.body || {};

  if (!bookingId || !bookingItemId || !outletId) {
    return res.status(400).json({ success: false, error: "bookingId, bookingItemId and outletId are required" });
  }

  const payload = { bookingId, bookingItemId, outletId };
  if (scannerId) payload.scannerId = scannerId;
  if (redeemedBy) payload.redeemedBy = redeemedBy;

  try {
    const response = await axios.post(
      `${BOOKING_SERVICE_URL}/api/v1/booking/redeem-booking`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Api-Key": INTERNAL_API_KEY,
        },
        validateStatus: () => true,
      }
    );
    return res.status(response.status).json(response.data);
  } catch (err) {
    console.error("[redeem] proxy error:", err.message);
    return res.status(502).json({ success: false, error: "Booking service unreachable", detail: err.message });
  }
});

// ── Fallback: serve SPA ──────────────────────────────────────────────────────
app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🛂  TFS Lounge Scanner`);
  console.log(`   Local :  http://localhost:${PORT}`);
  console.log(`   Network: http://<your-ip>:${PORT}`);
  console.log(`   Proxying to: ${BOOKING_SERVICE_URL}`);
  console.log(`   Serving static from: ${PUBLIC_DIR}\n`);
});
