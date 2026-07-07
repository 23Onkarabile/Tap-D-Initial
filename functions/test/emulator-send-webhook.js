// test/emulator-send-webhook.js
// Run with: node test/emulator-send-webhook.js <orderId>

"use strict";

const admin = require("firebase-admin");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const PROJECT_ID = process.env.GCLOUD_PROJECT || "grub-app-database";
admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

const FUNCTIONS_EMULATOR_HOST = "localhost:5001";
const REGION = "us-central1";

function readSecretLocal(key) {
  const secretPath = path.join(__dirname, "..", ".secret.local");
  if (!fs.existsSync(secretPath)) throw new Error(".secret.local not found.");
  const contents = fs.readFileSync(secretPath, "utf8");
  const match = contents.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!match) throw new Error(`${key} not found in .secret.local`);
  return match[1].trim();
}

const WEBHOOK_SECRET = readSecretLocal("STITCH_WEBHOOK_SECRET");
const WEBHOOK_MODE = (process.env.STITCH_WEBHOOK_MODE || "svix").toLowerCase();

function signSvix(payload, msgId, timestamp, secret) {
  const secretBytes = Buffer.from(secret.split("_")[1], "base64");
  const signedContent = `${msgId}.${timestamp}.${payload}`;
  const sig = crypto.createHmac("sha256", secretBytes).update(signedContent).digest("base64");
  return {
    "svix-id": msgId,
    "svix-timestamp": timestamp,
    "svix-signature": "v1," + sig,
  };
}

function signLegacy(payload, secret) {
  const sig = crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return {
    "x-stitch-signature": `t=${Math.floor(Date.now() / 1000)},hmac_sha256=${sig}`,
  };
}

async function sendWebhook(linkId, label) {
  // Stitch Express webhook payload shape — matches their documented format exactly
  const payload = JSON.stringify({
    type:             "payment.paid",
    id:               `txn_test_${Date.now()}`,
    amount:           7150,              // cents — R71.50
    status:           "PAID",
    linkId:           linkId,            // this is how we look up the order
    consentId:        null,
    subscriptionId:   null,
    terminalSessionId: null,
  });

  let headers = { "Content-Type": "application/json" };
  if (WEBHOOK_MODE === "legacy") {
    headers = { ...headers, ...signLegacy(payload, WEBHOOK_SECRET) };
  } else {
    const msgId = `msg_test_${Date.now()}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    headers = { ...headers, ...signSvix(payload, msgId, timestamp, WEBHOOK_SECRET) };
  }

  const url = `http://${FUNCTIONS_EMULATOR_HOST}/${PROJECT_ID}/${REGION}/stitchWebhookHandler`;
  console.log("Calling URL:", url);

  console.log(`\n── ${label} ──`);
  const res = await fetch(url, { method: "POST", headers, body: payload });
  const text = await res.text();
  console.log(`Response status: ${res.status}`);
  console.log(`Response body: ${text}`);
  return res.status;
}

async function main() {
  const orderId = process.argv[2];
  if (!orderId) {
    console.error("Usage: node test/emulator-send-webhook.js <orderId>");
    process.exit(1);
  }

  // Get the linkId stored on this order
  const orderSnap = await db.collection("orders").doc(orderId).get();
  if (!orderSnap.exists) {
    console.error("Order not found:", orderId);
    process.exit(1);
  }
  const linkId = orderSnap.data()?.payment?.linkId;
  if (!linkId) {
    console.error("Order has no payment.linkId — seed the order correctly first");
    process.exit(1);
  }

  console.log(`Webhook mode: ${WEBHOOK_MODE}`);
  console.log(`Target order: ${orderId}`);
  console.log(`Using linkId: ${linkId}`);

  await sendWebhook(linkId, "First webhook delivery (expect: processed)");

  const orderRef = db.collection("orders").doc(orderId);
  let snap = await orderRef.get();
  console.log("\nOrder status after first delivery:", snap.data()?.status);
  console.log("Payment status:", snap.data()?.payment?.status);

  const restaurantId = snap.data()?.restaurantId;
  if (restaurantId) {
    const restSnap = await db.collection("restaurants").doc(restaurantId).get();
    console.log("Restaurant totalEarnings after first delivery:", restSnap.data()?.totalEarnings);
  }

  await sendWebhook(linkId, "Duplicate webhook delivery (expect: skipped)");

  snap = await orderRef.get();
  console.log("\nOrder status after duplicate:", snap.data()?.status);
  if (restaurantId) {
    const restSnap2 = await db.collection("restaurants").doc(restaurantId).get();
    console.log("Restaurant totalEarnings after duplicate:", restSnap2.data()?.totalEarnings);
  }
}

main().catch(err => {
  console.error("❌ Script failed:", err);
  process.exit(1);
});
