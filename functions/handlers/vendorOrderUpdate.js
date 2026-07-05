"use strict";

const admin = require("firebase-admin");
const db = admin.firestore();

const ALLOWED_TRANSITIONS = {
  pending:   ["preparing"],
  preparing: ["ready"],
  ready:     ["completed"],
};

function callableError(res, code, status, message) {
  return res.status(code).json({ error: { status, message } });
}

module.exports = async (req, res) => {
  try {
    const callerId = req.callableAuth.uid;
    const { orderId, newStatus } = req.body.data || {};

    if (!orderId || typeof orderId !== "string") {
      return callableError(res, 400, "INVALID_ARGUMENT", "orderId is required.");
    }
    if (!newStatus || typeof newStatus !== "string") {
      return callableError(res, 400, "INVALID_ARGUMENT", "newStatus is required.");
    }

    // Look up the vendor account (not "users" — vendors live in their own collection)
    const vendorSnap = await db.collection("vendors").doc(callerId).get();
    if (!vendorSnap.exists) {
      return callableError(res, 404, "NOT_FOUND", "Vendor account not found.");
    }
    const vendor = vendorSnap.data();

    if (!vendor.businessId) {
      return callableError(res, 403, "PERMISSION_DENIED", "Your account is not linked to a business.");
    }

    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      return callableError(res, 404, "NOT_FOUND", "Order not found.");
    }
    const order = orderSnap.data();

    // Orders use "businessId", matching dashboard.js's query
    if (order.businessId !== vendor.businessId) {
      console.error(
        `AUTHORIZATION VIOLATION: vendor ${callerId} (business: ${vendor.businessId}) ` +
        `attempted to update order ${orderId} (business: ${order.businessId})`
      );
      return callableError(res, 403, "PERMISSION_DENIED", "You are not authorized to update this order.");
    }

    const currentStatus = order.status;
    const VENDOR_ACCESSIBLE_STATUSES = ["pending", "preparing", "ready", "completed"];
    if (!VENDOR_ACCESSIBLE_STATUSES.includes(currentStatus)) {
      return callableError(res, 400, "FAILED_PRECONDITION", `Order is not in a vendor-manageable state: ${currentStatus}`);
    }

    const allowedNext = ALLOWED_TRANSITIONS[currentStatus] || [];
    if (!allowedNext.includes(newStatus)) {
      return callableError(
        res, 400, "FAILED_PRECONDITION",
        `Cannot transition order from '${currentStatus}' to '${newStatus}'. Allowed: ${allowedNext.join(", ") || "none"}`
      );
    }

    await orderRef.update({
      status: newStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      [`statusHistory.${newStatus}`]: {
        setBy: callerId,
        setAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    });

    console.log(`Order ${orderId} status updated: ${currentStatus} → ${newStatus} by vendor ${callerId}`);

    return res.status(200).json({
      result: { success: true, orderId, prevStatus: currentStatus, newStatus },
    });
  } catch (err) {
    console.error("vendorOrderUpdate unexpected error:", err);
    return callableError(res, 500, "INTERNAL", "Internal error.");
  }
};
