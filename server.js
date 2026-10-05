"use strict";

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");

// ---------------------------------------------------------------------------
// Configuration — every upstream URL and the internal key must come from env.
// ---------------------------------------------------------------------------

const REQUIRED_ENV = [
  "BOOKING_SERVICE_URL",
  "PROMOTIONAL_SERVICE_URL",
  "CATALOGUE_SERVICE_BASE_URL",
  "INTERNAL_API_KEY",
];

const missingEnv = REQUIRED_ENV.filter((name) => !String(process.env[name] || "").trim());
if (missingEnv.length) {
  console.error(
    `[config] Missing required environment variable(s): ${missingEnv.join(", ")}. ` +
      "See .env.example."
  );
  process.exit(1);
}

const stripTrailingSlash = (url) => url.trim().replace(/\/+$/, "");

const config = {
  port: Number(process.env.PORT) || 5020,
  proxyTimeoutMs: Number(process.env.PROXY_TIMEOUT_MS) || 10000,
  internalApiKey: process.env.INTERNAL_API_KEY.trim(),
  bookingUrl: stripTrailingSlash(process.env.BOOKING_SERVICE_URL),
  promotionalUrl: stripTrailingSlash(process.env.PROMOTIONAL_SERVICE_URL),
  catalogueUrl: stripTrailingSlash(process.env.CATALOGUE_SERVICE_BASE_URL),
};

const UPSTREAMS = {
  booking: { name: "Booking", baseUrl: config.bookingUrl },
  promotional: { name: "Promotional", baseUrl: config.promotionalUrl },
  catalogue: { name: "Catalogue", baseUrl: config.catalogueUrl },
};

const PUBLIC_DIR = path.resolve(__dirname, "public");

// ---------------------------------------------------------------------------
// Proxy helpers
// ---------------------------------------------------------------------------

/**
 * Forwards a request to an upstream service and relays its status + body.
 * The internal API key is attached server-side only and never reaches the browser.
 * Network failures are mapped to 502.
 */
async function forward(res, upstream, { method = "GET", path: urlPath, body, headers = {}, tag }) {
  try {
    const response = await axios({
      method,
      url: `${upstream.baseUrl}${urlPath}`,
      data: body,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        "X-Internal-Api-Key": config.internalApiKey,
        ...headers,
      },
      timeout: config.proxyTimeoutMs,
      validateStatus: () => true,
    });
    return res.status(response.status).json(response.data);
  } catch (err) {
    console.error(`[${tag}] proxy error:`, err.message);
    return res.status(502).json({
      success: false,
      error: `${upstream.name} service unreachable`,
      detail: err.message,
    });
  }
}

const badRequest = (res, error) => res.status(400).json({ success: false, error });

const hasValue = (v) => v !== undefined && v !== null && v !== "";

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ---- Catalogue pickers ----------------------------------------------------

app.get("/api/catalogue/locations", (_req, res) =>
  forward(res, UPSTREAMS.catalogue, { path: "/locations", tag: "catalogue/locations" })
);

app.get("/api/catalogue/outlets", (req, res) => {
  const { locationId } = req.query;
  const qs = locationId ? `?locationId=${encodeURIComponent(locationId)}` : "";
  return forward(res, UPSTREAMS.catalogue, { path: `/outlets${qs}`, tag: "catalogue/outlets" });
});

app.get("/api/catalogue/outlets/:outletId/services", (req, res) =>
  forward(res, UPSTREAMS.catalogue, {
    path: `/outlets/${encodeURIComponent(req.params.outletId)}/services`,
    tag: "catalogue/outlet-services",
  })
);

app.get("/api/catalogue/services", (req, res) => {
  const { locationId } = req.query;
  if (!locationId) return badRequest(res, "locationId is required");
  return forward(res, UPSTREAMS.catalogue, {
    path: `/services?locationId=${encodeURIComponent(locationId)}`,
    tag: "catalogue/services",
  });
});

// ---- Lounge bookings ------------------------------------------------------

/** POST /api/validate — Body: { token, outletId } */
app.post("/api/validate", (req, res) => {
  const { token, outletId } = req.body || {};
  if (!token) return badRequest(res, "token is required");
  if (!outletId) return badRequest(res, "outletId is required");

  return forward(res, UPSTREAMS.booking, {
    method: "POST",
    path: "/api/v1/booking/validate-booking",
    body: { outletId },
    headers: { "X-Lounge-QR-Token": token },
    tag: "validate",
  });
});

/** POST /api/redeem — Body: { bookingId, bookingItemId, outletId, scannerId?, redeemedBy? } */
app.post("/api/redeem", (req, res) => {
  const { bookingId, bookingItemId, outletId, scannerId, redeemedBy } = req.body || {};
  if (!bookingId || !bookingItemId || !outletId) {
    return badRequest(res, "bookingId, bookingItemId and outletId are required");
  }

  return forward(res, UPSTREAMS.booking, {
    method: "POST",
    path: "/api/v1/booking/redeem-booking",
    body: {
      bookingId,
      bookingItemId,
      outletId,
      ...(scannerId ? { scannerId } : {}),
      ...(redeemedBy ? { redeemedBy } : {}),
    },
    tag: "redeem",
  });
});

// ---- Access vouchers ------------------------------------------------------

/** Picks exactly one credential: qrToken wins over code. */
const voucherCredential = ({ qrToken, code }) => (qrToken ? { qrToken } : { code });

/** POST /api/voucher/validate — Body: { qrToken | code, outletId?, outletServiceVariantId? } */
app.post("/api/voucher/validate", (req, res) => {
  const body = req.body || {};
  if (!body.qrToken && !body.code) return badRequest(res, "qrToken or code is required");

  return forward(res, UPSTREAMS.promotional, {
    method: "POST",
    path: "/internal/program-vouchers/validate",
    body: {
      ...voucherCredential(body),
      ...(body.outletId ? { outletId: body.outletId } : {}),
      ...(body.outletServiceVariantId ? { outletServiceVariantId: body.outletServiceVariantId } : {}),
    },
    tag: "voucher/validate",
  });
});

/**
 * POST /api/voucher/redeem
 * Body: { qrToken | code, outletId | outletServiceVariantId, paxToRedeem?, reportedBillAmount?, boardingPass? }
 * The promotional service enforces the business rules; this proxy only checks the basics.
 */
app.post("/api/voucher/redeem", (req, res) => {
  const body = req.body || {};
  if (!body.qrToken && !body.code) return badRequest(res, "qrToken or code is required");
  if (!body.outletId && !body.outletServiceVariantId) {
    return badRequest(res, "outletId (or outletServiceVariantId) is required");
  }

  return forward(res, UPSTREAMS.promotional, {
    method: "POST",
    path: "/internal/program-vouchers/redeem",
    body: {
      ...voucherCredential(body),
      ...(body.outletId
        ? { outletId: body.outletId }
        : { outletServiceVariantId: body.outletServiceVariantId }),
      redemptionChannel: "QR_SCAN_RP",
      paxToRedeem: Number(body.paxToRedeem) || 1,
      ...(hasValue(body.reportedBillAmount)
        ? { reportedBillAmount: Number(body.reportedBillAmount) }
        : {}),
      ...(body.boardingPass ? { boardingPass: body.boardingPass } : {}),
    },
    tag: "voucher/redeem",
  });
});

// ---- SPA fallback ---------------------------------------------------------

app.get("/voucher", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "voucher.html")));
app.get("*", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

app.listen(config.port, "0.0.0.0", () => {
  console.log("\nTFS Lounge Scanner");
  console.log(`  Local:       http://localhost:${config.port}`);
  console.log(`  Booking:     ${config.bookingUrl}`);
  console.log(`  Promotional: ${config.promotionalUrl}`);
  console.log(`  Catalogue:   ${config.catalogueUrl}\n`);
});
