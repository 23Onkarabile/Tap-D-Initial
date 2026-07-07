"use strict";

const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const { verifyWebhook } = require("../utils/stitch");
const { round2 } = require("../utils/financials");

const db = admin.firestore();

module.exports = async (req, res) => {
  const rawBody = req.body; // Buffer, thanks to express.raw() in server.js
  if (!rawBody || rawBody.length === 0) {
    console.warn("Webhook received with empty body.");
    return res.status(400).send("Empty body.");
  }

  let payload;
  try {
    payload = verifyWebhook(rawBody, req.headers);
  } catch (err) {
    console.error("Webhook signature verification FAILED:", err.message);
    return res.status(401).send("Invalid signature.");
  }

  console.log("Stitch Express webhook FULL payload:", JSON.stringify(payload));

  if (payload.type !== "payment.paid") {
    return res.status(200).send("Event type not handled.");
  }

  const linkId = payload.linkId;
  if (!linkId) {
    console.error("Webhook missing linkId.");
    return res.status(400).send("Missing linkId.");
  }

  const transactionId = payload.id || null;
  let orderRef, orderId;

  try {
    const snap = await db.collection("orders")
      .where("payment.linkId", "==", linkId)
      .limit(1)
      .get();

    if (snap.empty) {
      console.error(`No order found for linkId: ${linkId}`);
      return res.status(200).send("OK");
    }
    orderRef = snap.docs[0].ref;
    orderId = snap.docs[0].id;
  } catch (err) {
    console.error("Error looking up order by linkId:", err.message);
    return res.status(500).send("Internal error processing webhook.");
  }

  try {
    await db.runTransaction(async (txn) => {
      const orderSnap = await txn.get(orderRef);
      if (!orderSnap.exists) throw new Error(`Order not found: ${orderId}`);
      const order = orderSnap.data();

      if (order.status !== "payment_initiated") {
        console.log(`Order ${orderId} already processed (status: ${order.status}). Skipping.`);
        return;
      }

      if (payload.amount && order.pricingSnapshot) {
        const paidAmountZAR = round2(payload.amount / 100);
        if (paidAmountZAR !== order.pricingSnapshot.totalPayable) {
          console.error(`AMOUNT MISMATCH on order ${orderId}: expected R${order.pricingSnapshot.totalPayable}, got R${paidAmountZAR}`);
          txn.update(orderRef, {
            "payment.status": "amount_mismatch",
            "payment.flagged": true,
            "payment.flagReason": `Expected R${order.pricingSnapshot.totalPayable}, received R${paidAmountZAR}`,
            updatedAt: FieldValue.serverTimestamp(),
          });
          return;
        }
      }

      txn.update(orderRef, {
        status: "paid",
        "payment.status": "paid",
        "payment.transactionId": transactionId,
        "payment.verified": true,
        "payment.paidAt": FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      const paymentRef = db.collection("payments").doc();
      txn.set(paymentRef, {
        orderId,
        restaurantId: order.restaurantId,
        customerId: order.customerId,
        amount: order.pricingSnapshot.totalPayable,
        restaurantPayout: order.pricingSnapshot.restaurantPayout,
        platformFee: order.pricingSnapshot.platformFee,
        status: "paid",
        provider: "stitch_express",
        transactionId,
        linkId,
        rawWebhook: payload,
        createdAt: FieldValue.serverTimestamp(),
      });

      const restaurantRef = db.collection("restaurants").doc(order.restaurantId);
      txn.update(restaurantRef, {
        totalEarnings: FieldValue.increment(order.pricingSnapshot.restaurantPayout),
      });

      console.log(`✅ Payment confirmed for order ${orderId} | Total: R${order.pricingSnapshot.totalPayable} | Restaurant payout: R${order.pricingSnapshot.restaurantPayout} | Platform fee: R${order.pricingSnapshot.platformFee}`);
    });
  } catch (err) {
    console.error(`Webhook processing error for order ${orderId}:`, err.message);
    return res.status(500).send("Internal error processing webhook.");
  }

  return res.status(200).send("OK");
};
