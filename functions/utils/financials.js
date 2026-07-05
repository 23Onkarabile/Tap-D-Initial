// utils/financials.js
// ═══════════════════════════════════════════════════════════════════
// ALL financial calculations for TapDish live here and ONLY here.
// Frontend NEVER calculates money. Cloud Functions call these utils.
// ═══════════════════════════════════════════════════════════════════

"use strict";

const PLATFORM_FEE_RATE = 0.10;   // 10% of subtotal
const PLATFORM_FEE_MIN  = 3.00;   // Minimum R3.00 platform fee

/**
 * Calculate full pricing breakdown for an order.
 *
 * Rules:
 *   platformFee     = max(subtotal * 10%, R3.00)
 *   totalPayable    = subtotal + platformFee
 *   restaurantPayout = subtotal  (platform keeps only the fee)
 *
 * All values are rounded to 2 decimal places to avoid
 * floating-point drift (e.g. 0.1 + 0.2 = 0.30000000000000004).
 *
 * @param {number} subtotal — sum of (item.price * item.qty) for all items
 * @returns {{ subtotal, platformFee, totalPayable, restaurantPayout }}
 */
function calculatePricing(subtotal) {
  if (typeof subtotal !== "number" || isNaN(subtotal) || subtotal < 0) {
    throw new Error(`Invalid subtotal: ${subtotal}`);
  }

  const raw         = Math.max(subtotal * PLATFORM_FEE_RATE, PLATFORM_FEE_MIN);
  const platformFee = round2(raw);
  const totalPayable    = round2(subtotal + platformFee);
  const restaurantPayout = round2(subtotal); // restaurant gets full subtotal

  return { subtotal: round2(subtotal), platformFee, totalPayable, restaurantPayout };
}

/**
 * Calculate subtotal from an array of order items.
 * Each item must have { price: number, qty: number }.
 * Prices are read from Firestore product docs — never from the client request.
 *
 * @param {Array<{price: number, qty: number, name: string, productId: string}>} items
 * @returns {number} subtotal
 */
function calculateSubtotal(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Order must contain at least one item.");
  }

  const subtotal = items.reduce((sum, item) => {
    if (typeof item.price !== "number" || item.price < 0) {
      throw new Error(`Invalid price for item: ${item.productId}`);
    }
    if (!Number.isInteger(item.qty) || item.qty < 1) {
      throw new Error(`Invalid quantity for item: ${item.productId}`);
    }
    return sum + item.price * item.qty;
  }, 0);

  return round2(subtotal);
}

/**
 * Round to exactly 2 decimal places.
 * Uses the "round half away from zero" method to avoid banker's rounding.
 */
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Verify that a pricing snapshot matches a freshly calculated value.
 * Used during webhook processing to detect tampering.
 *
 * @param {object} snapshot — pricingSnapshot stored on the order doc
 * @param {number} recalcSubtotal — subtotal recalculated server-side
 * @returns {boolean}
 */
function verifyPricingSnapshot(snapshot, recalcSubtotal) {
  const fresh = calculatePricing(recalcSubtotal);
  return (
    snapshot.subtotal      === fresh.subtotal      &&
    snapshot.platformFee   === fresh.platformFee   &&
    snapshot.totalPayable  === fresh.totalPayable
  );
}

module.exports = { calculatePricing, calculateSubtotal, round2, verifyPricingSnapshot };
