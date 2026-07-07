// test/test-financials.js
// Run with: node test/test-financials.js

"use strict";

const f = require("../utils/financials");

let failures = 0;

function check(label, actual, expected) {
  const pass = actual === expected;
  if (!pass) failures++;
  console.log(`${pass ? "✅" : "❌"} ${label}: expected ${expected}, got ${actual}`);
}

console.log("── financials.js regression test ──\n");

const p1 = f.calculatePricing(85);
check("R85 platformFee", p1.platformFee, 8.50);
check("R85 totalPayable", p1.totalPayable, 93.50);
check("R85 restaurantPayout", p1.restaurantPayout, 85);

const p2 = f.calculatePricing(20);
check("R20 platformFee (min)", p2.platformFee, 3.00);
check("R20 totalPayable", p2.totalPayable, 23.00);

const p3 = f.calculatePricing(30);
check("R30 platformFee (boundary)", p3.platformFee, 3.00);

const p4 = f.calculatePricing(49.90);
check("R49.90 platformFee", p4.platformFee, 4.99);
check("R49.90 totalPayable", p4.totalPayable, 54.89);

const sub = f.calculateSubtotal([
  { productId: "p1", price: 15.00, qty: 2 },
  { productId: "p2", price: 8.50, qty: 1 },
]);
check("Subtotal from items", sub, 38.50);

console.log(`\n${failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);

