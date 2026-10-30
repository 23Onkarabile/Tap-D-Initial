"use strict";

// POST /notifyOrderReady  { data: { orderId } }
// Called by the vendor dashboard right after an order is marked "ready".
// Sends a push notification to every device the customer has enabled alerts on.

const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");

const db = admin.firestore();
// Where the notification should open. Set APP_BASE_URL on Render to your live site address.
const BASE_URL = process.env.APP_BASE_URL || "https://tapdish.vercel.app";

function callableError(res, code, status, message) {
  return res.status(code).json({ error: { status, message } });
}

module.exports = async (req, res) => {
  try {
    const vendorUid = req.callableAuth.uid;
    const { orderId } = req.body.data || {};
    if (!orderId || typeof orderId !== "string") {
      return callableError(res, 400, "INVALID_ARGUMENT", "orderId is required.");
    }

    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      return callableError(res, 404, "NOT_FOUND", "Order not found.");
    }
    const order = orderSnap.data();

    // Only the vendor that owns this order may trigger the alert
    const vendorSnap = await db.collection("vendors").doc(vendorUid).get();
    if (!vendorSnap.exists || vendorSnap.data().businessId !== order.businessId) {
      return callableError(res, 403, "PERMISSION_DENIED", "Not your order.");
    }

    // The order must really be "ready" (stops anyone sending false alerts)
    if (order.status !== "ready") {
      return callableError(res, 400, "FAILED_PRECONDITION", "Order is not ready.");
    }

    // Never send the same alert twice (e.g. if the vendor taps twice)
    if (order.readyPushSentAt) {
      return res.status(200).json({ result: { sent: 0, alreadySent: true } });
    }

    // Look up the customer's saved device tokens
    const userSnap = await db.collection("users").doc(order.customerId).get();
    const tokens = (userSnap.exists && userSnap.data().fcmTokens) || [];
    if (!tokens.length) {
      return res.status(200).json({ result: { sent: 0, reason: "no-tokens" } });
    }

    // Tapping the notification opens the order tracking screen
    const url = `${BASE_URL}/order-status?reference=${encodeURIComponent(order.orderNumber)}`;

    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: {
        title: `Order ${order.orderNumber} is ready`,
        body: `Come collect it at ${order.businessName || "the restaurant"}.`,
      },
      data: { orderNumber: String(order.orderNumber), url },
      webpush: {
        fcmOptions: { link: url },
        notification: { tag: String(order.orderNumber), requireInteraction: true },
      },
    });

    // Remove tokens that no longer work (app uninstalled, permission revoked)
    const dead = [];
    response.responses.forEach((r, i) => {
      const code = r.error && r.error.code;
      if (code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token") {
        dead.push(tokens[i]);
      }
    });
    if (dead.length) {
      await db.collection("users").doc(order.customerId)
        .update({ fcmTokens: FieldValue.arrayRemove(...dead) });
    }

    if (response.successCount > 0) {
      await orderRef.update({ readyPushSentAt: FieldValue.serverTimestamp() });
    }
    return res.status(200).json({ result: { sent: response.successCount } });
  } catch (err) {
    console.error("notifyOrderReady error:", err);
    return callableError(res, 500, "INTERNAL", "Could not send notification.");
  }
};
