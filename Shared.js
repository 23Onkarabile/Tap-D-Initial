// shared.js - ONE source of truth for both app.js (customer) and dashboard.js (vendor).
// Why: the two apps had their own status strings and formatting, so they drifted apart.

// Every status an order can have in Firestore.
export const STATUS = {
  UNPAID: "payment_initiated", // created, customer hasn't paid yet
  PENDING: "pending",          // paid, waiting for the vendor
  PREPARING: "preparing",
  READY: "ready",
  COMPLETED: "completed",      // collected
  REJECTED: "rejected",        // vendor declined (refund is due)
  REFUNDED: "refunded"
};

// Vendors only see paid orders: an unpaid order isn't a real order yet.
export const VENDOR_VISIBLE = [
  STATUS.PENDING, STATUS.PREPARING, STATUS.READY, STATUS.COMPLETED, STATUS.REJECTED, STATUS.REFUNDED
];
// Orders the kitchen still has to act on.
export const LIVE = [STATUS.PENDING, STATUS.PREPARING, STATUS.READY];

// The next step the vendor can take from each live status.
export const NEXT_ACTION = {
  pending:   { label: "Start preparing", next: STATUS.PREPARING },
  preparing: { label: "Mark ready",      next: STATUS.READY },
  ready:     { label: "Collected",       next: STATUS.COMPLETED }
};

// Escape text before putting it in innerHTML. Customer names and item names are
// typed by customers, so without this a customer could run script on the vendor's screen.
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Change the symbol in ONE place (the customer app currently shows "$"; en-ZA would use "R").
export const CURRENCY = "$";
export const money = (n) => CURRENCY + Number(n || 0).toFixed(2);
// Use the amount the customer actually paid when it exists, so both sides show the same number.
export const orderAmount = (o) => o.totalPayable ?? o.total ?? 0;

export const formatTime = (d) =>
  d.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });

