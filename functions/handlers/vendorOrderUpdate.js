"use strict";

const admin = require("firebase-admin");
const db = admin.firestore();

const ALLOWED_TRANSITIONS = {
  paid: ["preparing"],
  preparing: ["ready"],
  ready: ["completed"],
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

    const userSnap = await db.collection("users").doc(callerId).get();
    if (!userSnap.exists) {
      return callableError(res, 404, "NOT_FOUND", "User profile not found.");
    }
    const user = userSnap.data();

    if (user.role !== "vendor") {
      return callableError(res, 403, "PERMISSION_DENIED", "Only vendors can update order status.");
    }
    if (!user.restaurantId) {
      return callableError(res, 403, "PERMISSION_DENIED", "Your account is not linked to a restaurant.");
    }

    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      return callableError(res, 404, "NOT_FOUND", "Order not found.");
    }
    const order = orderSnap.data();

    if (order.restaurantId !== user.restaurantId) {
      console.error(
        `AUTHORIZATION VIOLATION: vendor ${callerId} (restaurant: ${user.restaurantId}) ` +
        `attempted to update order ${orderId} (restaurant: ${order.restaurantId})`
      );
      return callableError(res, 403, "PERMISSION_DENIED", "You are not authorized to update this order.");
    }

    const currentStatus = order.status;
    const VENDOR_ACCESSIBLE_STATUSES = ["paid", "preparing", "ready", "completed"];
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

