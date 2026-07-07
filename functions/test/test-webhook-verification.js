// test/test-webhook-verification.js
// Run with: node test/test-webhook-verification.js

"use strict";

const crypto = require("crypto");
const { Webhook } = require("svix");

let failures = 0;
function check(label, condition) {
  if (!condition) failures++;
  console.log(`${condition ? "✅" : "❌"} ${label}`);
}

function verifyWithLegacy(rawBody, signatureHeader, secret) {
  if (!signatureHeader) throw new Error("Missing X-Stitch-Signature header.");
  const parts = Object.fromEntries(signatureHeader.split(",").map(kv => kv.split("=")));
  const providedSig = parts.hmac_sha256;
  if (!providedSig) throw new Error("X-Stitch-Signature header missing hmac_sha256 component.");

  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  let valid = false;
  try {
    valid = crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(providedSig, "hex"));
  } catch { valid = false; }
  if (!valid) throw new Error("Legacy signature verification failed.");
  return JSON.parse(rawBody);
}

console.log("── SVIX mode tests ──\n");

(function testSvix() {
  const secret = "whsec_plJ3nmyCDGBKInavdOK15jsl";
  const payload = JSON.stringify({
    type: "payment.complete",
    externalReference: "test-order-123",
    id: "txn_abc123",
    amount: { quantity: 9350, currency: "ZAR" },
  });
  const msgId = "msg_test123";
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const secretBytes = Buffer.from(secret.split("_")[1], "base64");
  const signedContent = `${msgId}.${timestamp}.${payload}`;
  const sig = crypto.createHmac("sha256", secretBytes).update(signedContent).digest("base64");

  const wh = new Webhook(secret);

  try {
    const verified = wh.verify(payload, {
      "svix-id": msgId,
      "svix-timestamp": timestamp,
      "svix-signature": "v1," + sig,
    });
    check("Fresh valid Svix signature accepted", verified.type === "payment.complete");
  } catch (err) {
    check("Fresh valid Svix signature accepted", false);
    console.log(`   error: ${err.message}`);
  }

  try {
    const tampered = payload.replace("9350", "100");
    wh.verify(tampered, {
      "svix-id": msgId,
      "svix-timestamp": timestamp,
      "svix-signature": "v1," + sig,
    });
    check("Tampered Svix payload correctly rejected", false);
  } catch (err) {
    check("Tampered Svix payload correctly rejected", true);
  }

  try {
    const wrongWh = new Webhook("whsec_" + Buffer.from("wrongsecretvalue").toString("base64"));
    wrongWh.verify(payload, {
      "svix-id": msgId,
      "svix-timestamp": timestamp,
      "svix-signature": "v1," + sig,
    });
    check("Wrong Svix secret correctly rejected", false);
  } catch (err) {
    check("Wrong Svix secret correctly rejected", true);
  }

  try {
    wh.verify(payload, { "svix-id": msgId });
    check("Missing Svix headers correctly rejected", false);
  } catch (err) {
    check("Missing Svix headers correctly rejected", true);
  }

  try {
    const staleTimestamp = "1700000000";
    const staleContent = `${msgId}.${staleTimestamp}.${payload}`;
    const staleSig = crypto.createHmac("sha256", secretBytes).update(staleContent).digest("base64");
    wh.verify(payload, {
      "svix-id": msgId,
      "svix-timestamp": staleTimestamp,
      "svix-signature": "v1," + staleSig,
    });
    check("Stale timestamp correctly rejected", false);
  } catch (err) {
    check("Stale timestamp correctly rejected", err.message.toLowerCase().includes("timestamp"));
  }
})();

console.log("\n── LEGACY mode tests ──\n");

(function testLegacy() {
  const secret = "test_legacy_secret_value";
  const payload = JSON.stringify({ type: "payment.complete", externalReference: "order-456" });
  const sig = crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  const header = `t=${Math.floor(Date.now() / 1000)},hmac_sha256=${sig}`;

  try {
    const result = verifyWithLegacy(payload, header, secret);
    check("Valid legacy signature accepted", result.type === "payment.complete");
  } catch (e) {
    check("Valid legacy signature accepted", false);
  }

  try {
    const tampered = payload.replace("order-456", "order-999");
    verifyWithLegacy(tampered, header, secret);
    check("Tampered legacy payload correctly rejected", false);
  } catch (e) {
    check("Tampered legacy payload correctly rejected", true);
  }

  try {
    verifyWithLegacy(payload, header, "wrong_secret");
    check("Wrong legacy secret correctly rejected", false);
  } catch (e) {
    check("Wrong legacy secret correctly rejected", true);
  }

  try {
    verifyWithLegacy(payload, undefined, secret);
    check("Missing legacy header correctly rejected", false);
  } catch (e) {
    check("Missing legacy header correctly rejected", true);
  }

  try {
    verifyWithLegacy(payload, "t=1234567890", secret);
    check("Malformed legacy header correctly rejected", false);
  } catch (e) {
    check("Malformed legacy header correctly rejected", true);
  }
})();

console.log(`\n${failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);

