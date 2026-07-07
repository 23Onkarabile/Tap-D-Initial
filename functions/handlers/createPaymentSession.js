"use strict";

const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const { calculateSubtotal, calculatePricing } = require("../utils/financials");
const { createPaymentLink } = require("../utils/stitch");

const db = admin.firestore();
const BASE_URL = process.env.APP_BASE_URL || "https://tapdish.co.za";

function callableError(res, code, status, message) {
  return res.status(code).json({ error: { status, message } });
}

module.exports = async (req, res) => {
  try {
    const customerId = req.callableAuth.uid;
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

    if (order.customerId !== customerId) {
      return callableError(res, 403, "PERMISSION_DENIED", "You do not have access to this order.");
    }

    const nonPayableStatuses = ["payment_initiated", "paid", "preparing", "ready", "completed", "refunded"];
    if (nonPayableStatuses.includes(order.status)) {
      return callableError(res, 400, "FAILED_PRECONDITION", `Order cannot be paid in its current status: ${order.status}`);
    }

    async function getBusinessItemsMap(businessId) {
      const categoriesSnap = await db
        .collection("menus").doc(businessId).collection("categories").get();
      const map = {};
      for (const catDoc of categoriesSnap.docs) {
        const itemsSnap = await catDoc.ref.collection("items").get();
        itemsSnap.docs.forEach((d) => { map[d.id] = d.data(); });
      }
      return map;
    }

    const itemsMap = await getBusinessItemsMap(order.businessId);

    const itemsWithServerPrices = order.items.map((item) => {
      const product = itemsMap[item.itemId];
      if (!product) {
        throw { httpCode: 404, status: "NOT_FOUND", message: `Item not found: ${item.itemId}` };
      }
      if (product.isAvailable === false) {
        throw { httpCode: 400, status: "FAILED_PRECONDITION", message: `Item is no longer available: ${product.name}` };
      }
      return {
        itemId: item.itemId,
        name: product.name,
        price: product.price,
        qty: item.qty,
        subtotal: Math.round(product.price * item.qty * 100) / 100,
      };
    });

    const subtotal = calculateSubtotal(itemsWithServerPrices);
    const pricing = calculatePricing(subtotal);

    const pricingSnapshot = {
      subtotal: pricing.subtotal,
      platformFee: pricing.platformFee,
      totalPayable: pricing.totalPayable,
      restaurantPayout: pricing.restaurantPayout,
      lockedAt: FieldValue.serverTimestamp(),
    };

    await orderRef.update({
      status: "payment_initiated",
      items: itemsWithServerPrices,
      subtotal: pricing.subtotal,
      platformFee: pricing.platformFee,
      totalPayable: pricing.totalPayable,
      restaurantPayout: pricing.restaurantPayout,
      pricingSnapshot,
      updatedAt: FieldValue.serverTimestamp(),
    });

    let paymentResult;
    try {
      paymentResult = await createPaymentLink({
        orderId,
        orderNumber: order.orderNumber,
        amountZAR: pricing.totalPayable,
        payerName: order.customerName,
      });
    } catch (err) {
      await orderRef.update({
        status: "pending_payment",
        updatedAt: FieldValue.serverTimestamp(),
      });
      console.error("Stitch Express payment link creation failed:", err.message);
      return callableError(res, 500, "INTERNAL", "Payment session could not be created. Please try again.");
    }

    await orderRef.update({
      "payment.provider": "stitch_express",
      "payment.linkId": paymentResult.linkId,
      "payment.checkoutUrl": paymentResult.url,
      "payment.status": "initiated",
      updatedAt: FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      result: { checkoutUrl: paymentResult.url, linkId: paymentResult.linkId },
    });
  } catch (err) {
    if (err.httpCode) {
      return callableError(res, err.httpCode, err.status, err.message);
    }
    console.error("createPaymentSession unexpected error:", err);
    return callableError(res, 500, "INTERNAL", "Internal error.");
  }
};
