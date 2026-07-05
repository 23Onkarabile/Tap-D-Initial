"use strict";
require("dotenv").config();

const express = require("express");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
}

const createPaymentSession = require("./handlers/createPaymentSession");
const vendorOrderUpdate = require("./handlers/vendorOrderUpdate");
const stitchWebhookHandler = require("./handlers/stitchWebhookHandler");

const app = express();

// Webhook route needs the RAW body for Svix signature verification —
// this must be registered BEFORE express.json() below.
app.post(
  "/stitchWebhookHandler",
  express.raw({ type: "*/*" }),
  stitchWebhookHandler
);

app.use(express.json());

// Mimics Firebase callable auth: expects "Authorization: Bearer <idToken>"
async function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({
      error: { status: "UNAUTHENTICATED", message: "Missing ID token." },
    });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.callableAuth = { uid: decoded.uid, token: decoded };
    next();
  } catch (err) {
    return res.status(401).json({
      error: { status: "UNAUTHENTICATED", message: "Invalid or expired ID token." },
    });
  }
}

app.post("/createPaymentSession", authenticate, createPaymentSession);
app.post("/vendorOrderUpdate", authenticate, vendorOrderUpdate);

app.get("/", (req, res) => res.send("TapDish functions server is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TapDish server listening on port ${PORT}`));
