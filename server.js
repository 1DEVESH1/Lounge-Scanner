"use strict";

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 5020;
const BOOKING_SERVICE_URL = (
  process.env.BOOKING_SERVICE_URL || "http://localhost:5010"
).replace(/\/$/, "");
const PROMOTIONAL_SERVICE_URL = (
  process.env.PROMOTIONAL_SERVICE_URL || "http://localhost:8000/api/v1/promotional"
).replace(/\/$/, "");
const CATALOGUE_SERVICE_URL = (
  process.env.CATALOGUE_SERVICE_BASE_URL || "http://localhost:8088/api/v1/catalogue"
).replace(/\/$/, "");
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "";

const PUBLIC_DIR = path.resolve(__dirname, "public");
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS || 10000);

async function proxyPost(baseUrl, pathSuffix, body, extraHeaders = {}) {
  return axios.post(`${baseUrl}${pathSuffix}`, body, {
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Api-Key": INTERNAL_API_KEY,
      ...extraHeaders,
    },
    timeout: PROXY_TIMEOUT_MS,
    validateStatus: () => true,
  });
}

async function proxyGet(baseUrl, pathSuffix) {
  return axios.get(`${baseUrl}${pathSuffix}`, {
    headers: {
      "X-Internal-Api-Key": INTERNAL_API_KEY,
    },
    timeout: PROXY_TIMEOUT_MS,
    validateStatus: () => true,
  });
}

/** Catalogue pickers for scanner (no voucher code required). */
app.get("/api/catalogue/locations", async (_req, res) => {
  try {
    const response = await proxyGet(CATALOGUE_SERVICE_URL, "/locations");
    return res.status(response.status).json(response.data);
  } catch (err) {
    console.error("[catalogue/locations] proxy error:", err.message);
    return res.status(502).json({
      success: false,
      error: "Catalogue service unreachable",
      detail: err.message,
    });
  }
});

app.get("/api/catalogue/outlets", async (req, res) => {
  const locationId = req.query.locationId;
  const qs = locationId ? `?locationId=${encodeURIComponent(locationId)}` : "";
  try {
    const response = await proxyGet(CATALOGUE_SERVICE_URL, `/outlets${qs}`);
    return res.status(response.status).json(response.data);
  } catch (err) {
    console.error("[catalogue/outlets] proxy error:", err.message);
    return res.status(502).json({
      success: false,
      error: "Catalogue service unreachable",
      detail: err.message,
    });
  }
});

app.get("/api/catalogue/outlets/:outletId/services", async (req, res) => {
  try {
    const response = await proxyGet(
      CATALOGUE_SERVICE_URL,
      `/outlets/${req.params.outletId}/services`
    );
    return res.status(response.status).json(response.data);
  } catch (err) {
    console.error("[catalogue/outlet-services] proxy error:", err.message);
    return res.status(502).json({
      success: false,
      error: "Catalogue service unreachable",
      detail: err.message,
    });
  }
});

app.get("/api/catalogue/services", async (req, res) => {
  const locationId = req.query.locationId;
  if (!locationId) {
    return res.status(400).json({
      success: false,
      error: "locationId is required",
    });
  }
  try {
    const response = await proxyGet(
      CATALOGUE_SERVICE_URL,
      `/services?locationId=${encodeURIComponent(locationId)}`
    );
    return res.status(response.status).json(response.data);
  } catch (err) {
    console.error("[catalogue/services] proxy error:", err.message);
    return res.status(502).json({
      success: false,
      error: "Catalogue service unreachable",
      detail: err.message,
    });
  }
});

/**
 * POST /api/validate — lounge booking QR
 * Body: { token, outletId }
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
    const response = await proxyPost(
      BOOKING_SERVICE_URL,
      "/api/v1/booking/validate-booking",
      { outletId },
      { "X-Lounge-QR-Token": token }
    );
    return res.status(response.status).json(response.data);
  } catch (err) {
    console.error("[validate] proxy error:", err.message);
    return res.status(502).json({
      success: false,
      error: "Booking service unreachable",
      detail: err.message,
    });
  }
});

/**
 * POST /api/redeem — lounge booking redeem
 * Body: { bookingId, bookingItemId, outletId, scannerId?, redeemedBy? }
 */
app.post("/api/redeem", async (req, res) => {
  const { bookingId, bookingItemId, outletId, scannerId, redeemedBy } =
    req.body || {};

  if (!bookingId || !bookingItemId || !outletId) {
    return res.status(400).json({
      success: false,
      error: "bookingId, bookingItemId and outletId are required",
    });
  }

  const payload = { bookingId, bookingItemId, outletId };
  if (scannerId) payload.scannerId = scannerId;
  if (redeemedBy) payload.redeemedBy = redeemedBy;

  try {
    const response = await proxyPost(
      BOOKING_SERVICE_URL,
      "/api/v1/booking/redeem-booking",
      payload
    );
    return res.status(response.status).json(response.data);
  } catch (err) {
    console.error("[redeem] proxy error:", err.message);
    return res.status(502).json({
      success: false,
      error: "Booking service unreachable",
      detail: err.message,
    });
  }
});

/**
 * POST /api/voucher/validate — Access Voucher QR / code
 * Body: { qrToken } | { code }
 */
app.post("/api/voucher/validate", async (req, res) => {
  const { qrToken, code, outletId, serviceLocationId, locationId, billableAmount } =
    req.body || {};
  if (!qrToken && !code) {
    return res
      .status(400)
      .json({ success: false, error: "qrToken or code is required" });
  }

  try {
    const response = await proxyPost(
      PROMOTIONAL_SERVICE_URL,
      "/internal/program-vouchers/validate",
      {
        ...(qrToken ? { qrToken } : { code }),
        ...(outletId ? { outletId } : {}),
        ...(serviceLocationId ? { serviceLocationId } : {}),
        ...(locationId ? { locationId } : {}),
        ...(billableAmount != null ? { billableAmount: Number(billableAmount) } : {}),
      }
    );
    return res.status(response.status).json(response.data);
  } catch (err) {
    console.error("[voucher/validate] proxy error:", err.message);
    return res.status(502).json({
      success: false,
      error: "Promotional service unreachable",
      detail: err.message,
    });
  }
});

/**
 * POST /api/voucher/redeem — Access Voucher redeem
 * Body: { qrToken|code, serviceLocationId, outletId?, locationId?, paxAdmitted?, ... }
 * Service redeem: locationId + serviceLocationId (no outletId)
 * Outlet redeem: outletId + serviceLocationId
 */
app.post("/api/voucher/redeem", async (req, res) => {
  const body = req.body || {};
  if (!body.qrToken && !body.code) {
    return res
      .status(400)
      .json({ success: false, error: "qrToken or code is required" });
  }
  if (!body.serviceLocationId) {
    return res.status(400).json({
      success: false,
      error: "serviceLocationId is required",
    });
  }
  if (!body.outletId && !body.locationId) {
    return res.status(400).json({
      success: false,
      error: "outletId (outlet redeem) or locationId (service redeem) is required",
    });
  }
  if (body.billableAmount == null || Number(body.billableAmount) <= 0) {
    return res.status(400).json({
      success: false,
      error: "billableAmount is required and must be positive",
    });
  }

  const payload = {
    ...body,
    redemptionChannel: body.redemptionChannel || "QR_SCAN_RP",
    paxAdmitted: Number(body.paxAdmitted || 1),
    billableAmount: Number(body.billableAmount),
  };

  try {
    const response = await proxyPost(
      PROMOTIONAL_SERVICE_URL,
      "/internal/program-vouchers/redeem",
      payload
    );
    return res.status(response.status).json(response.data);
  } catch (err) {
    console.error("[voucher/redeem] proxy error:", err.message);
    return res.status(502).json({
      success: false,
      error: "Promotional service unreachable",
      detail: err.message,
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🛂  TFS Lounge Scanner`);
  console.log(`   Local :  http://localhost:${PORT}`);
  console.log(`   Network: http://<your-ip>:${PORT}`);
  console.log(`   Booking: ${BOOKING_SERVICE_URL}`);
  console.log(`   Promotional: ${PROMOTIONAL_SERVICE_URL}`);
  console.log(`   Catalogue:   ${CATALOGUE_SERVICE_URL}`);
  console.log(`   Serving static from: ${PUBLIC_DIR}\n`);
});
