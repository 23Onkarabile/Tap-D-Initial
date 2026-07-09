// utils/stitch.js
"use strict";

const axios  = require("axios");
const crypto = require("crypto");
const { Webhook: SvixWebhook } = require("svix");

// ── Config via environment variables ─────────────────────────────
// No defineSecret() or defineString() — uses process.env directly.
// For local emulator: values come from .env.local
// For deployed functions: values come from functions/.env file
const STITCH_CLIENT_ID      = { value: () => process.env.STITCH_CLIENT_ID };
const STITCH_CLIENT_SECRET  = { value: () => process.env.STITCH_CLIENT_SECRET };
const STITCH_WEBHOOK_SECRET = { value: () => process.env.STITCH_WEBHOOK_SECRET };

const TAPDISH_SETTLEMENT_ACCOUNT_NAME   = { value: () => process.env.TAPDISH_SETTLEMENT_ACCOUNT_NAME };
const TAPDISH_SETTLEMENT_BANK_ID        = { value: () => process.env.TAPDISH_SETTLEMENT_BANK_ID };
const TAPDISH_SETTLEMENT_ACCOUNT_NUMBER = { value: () => process.env.TAPDISH_SETTLEMENT_ACCOUNT_NUMBER };

// ── Stitch Express endpoints ──────────────────────────────────────
const BASE_URL = "https://express.stitch.money/api/v1";

// ── Token cache ───────────────────────────────────────────────────
let _cachedToken = null;
let _tokenExpiry = 0;

/**
 * Get a valid Stitch Express access token.
 * Tokens last 15 minutes — cached and reused until 30s before expiry.
 */
async function getAccessToken() {
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiry - 30_000) {
    return _cachedToken;
  }

  let res;
  try {
    res = await axios.post(
      `${BASE_URL}/token`,
      {
        clientId:     STITCH_CLIENT_ID.value(),
        clientSecret: STITCH_CLIENT_SECRET.value(),
        scope:        "client_paymentrequest",
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 10_000,
      }
    );
  } catch (err) {
    console.error("Stitch token request raw error response:", JSON.stringify(err.response?.data));
    throw err;
  }

  const accessToken = res.data?.data?.accessToken;
  if (!accessToken) {
    throw new Error(`Stitch token response missing accessToken: ${JSON.stringify(res.data)}`);
  }

  _cachedToken = accessToken;
  // Stitch tokens are valid for 15 minutes; no expiresIn field returned, so hardcode it.
  _tokenExpiry = now + 15 * 60 * 1000;
  return _cachedToken;
}

/**
 * Create a Stitch Express payment link.
 *
 * @param {object} params
 * @param {string} params.orderId      — Firestore order ID
 * @param {string} params.orderNumber  — Human-readable ref
 * @param {number} params.amountZAR    — totalPayable in ZAR
 * @param {string} params.redirectUrl  — Pre-registered redirect URL
 * @returns {{ linkId: string, url: string }}
 */
async function createPaymentLink({ orderId, orderNumber, amountZAR, payerName }) {
  const token = await getAccessToken();
  const amountCents = Math.round(amountZAR * 100);

  let res;
  try {
    res = await axios.post(
      `${BASE_URL}/payment-links`,
      {
        amount:            amountCents,
        payerName:         payerName || "TapDish Customer",
        merchantReference: orderNumber.slice(0, 50),
      },
      {
        headers: {
          Authorization:  `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 15_000,
      }
    );
  } catch (err) {
    console.error("Stitch payment-links raw error response:", JSON.stringify(err.response?.data));
    throw err;
  }

  const payment = res.data?.data?.payment;
  if (!payment || !payment.id || !payment.link) {
    throw new Error(`Stitch Express payment link creation failed: ${JSON.stringify(res.data)}`);
  }

  const redirectUrl = "https://tapdish.vercel.app/order-status";
  const finalUrl = `${payment.link}?redirect_url=${encodeURIComponent(redirectUrl)}`;

  return {
    linkId: payment.id,
    url:    finalUrl,
  };
}
 

  
// ── Webhook verification ──────────────────────────────────────────
const WEBHOOK_MODE = (process.env.STITCH_WEBHOOK_MODE || "svix").toLowerCase();

function verifyWithSvix(rawBody, headers) {
  const secret = STITCH_WEBHOOK_SECRET.value();
  const wh = new SvixWebhook(secret);
  return wh.verify(rawBody, {
    "svix-id":        headers["svix-id"],
    "svix-timestamp": headers["svix-timestamp"],
    "svix-signature": headers["svix-signature"],
  });
}

function verifyWithLegacy(rawBody, signatureHeader) {
  if (!signatureHeader) {
    throw new Error("Missing X-Stitch-Signature header.");
  }
  const parts = Object.fromEntries(
    signatureHeader.split(",").map(kv => kv.split("="))
  );
  const providedSig = parts.hmac_sha256;
  if (!providedSig) {
    throw new Error("X-Stitch-Signature header missing hmac_sha256 component.");
  }
  const secret   = STITCH_WEBHOOK_SECRET.value();
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");
  let valid = false;
  try {
    valid = crypto.timingSafeEqual(
      Buffer.from(expected,    "hex"),
      Buffer.from(providedSig, "hex")
    );
  } catch { valid = false; }
  if (!valid) throw new Error("Legacy signature verification failed.");
  return JSON.parse(rawBody);
}

function verifyWebhook(rawBody, headers) {
  if (WEBHOOK_MODE === "legacy") {
    return verifyWithLegacy(rawBody, headers["x-stitch-signature"]);
  }
  return verifyWithSvix(rawBody, headers);
}

module.exports = {
  createPaymentLink,
  verifyWebhook,
  WEBHOOK_MODE,
  STITCH_CLIENT_ID,
  STITCH_CLIENT_SECRET,
  STITCH_WEBHOOK_SECRET,
  TAPDISH_SETTLEMENT_ACCOUNT_NAME,
  TAPDISH_SETTLEMENT_BANK_ID,
  TAPDISH_SETTLEMENT_ACCOUNT_NUMBER,
};

