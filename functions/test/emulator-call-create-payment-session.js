// test/emulator-call-create-payment-session.js
// Run with: node test/emulator-call-create-payment-session.js
// PREREQUISITE: firebase emulators:start --only functions,firestore
//               must already be running in another terminal/session.

"use strict";

const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";

const PROJECT_ID = process.env.GCLOUD_PROJECT || "grub-app-database";
admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

const FUNCTIONS_EMULATOR_HOST = "localhost:5001";
const REGION = "us-central1";

async function main() {
  console.log("── Seeding test data into Firestore emulator ──\n");

  const restaurantId = "test-restaurant-001";
  const productId = "test-product-burger";
  const customerId = "test-customer-001";

  await db.collection("restaurants").doc(restaurantId).set({
    name: "Test Burger Joint",
    vendorId: "test-vendor-uid",
    totalEarnings: 0,
  });
  console.log(`✅ Seeded restaurant: ${restaurantId}`);

  await db.collection("products").doc(productId).set({
    restaurantId,
    name: "Test Cheeseburger",
    price: 65.00,
    available: true,
  });
  console.log(`✅ Seeded product: ${productId} @ R65.00`);

  const orderRef = await db.collection("orders").add({
    restaurantId,
    customerId,
    orderNumber: `TD-${Math.floor(Math.random() * 9000) + 1000}`,
    items: [
      { productId, name: "Test Cheeseburger", qty: 1, price: 1.00 },
    ],
    status: "pending_payment",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const orderId = orderRef.id;
  console.log(`✅ Seeded order: ${orderId} (client-claimed price R1.00 — should be corrected to R65.00)\n`);

  console.log("── Calling createPaymentSession ──\n");

  const url = `http://${FUNCTIONS_EMULATOR_HOST}/${PROJECT_ID}/${REGION}/createPaymentSession`;
  console.log("Calling URL:", url);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: { orderId },
    }),
  });

  const result = await res.json();
  console.log("Response status:", res.status);
  console.log("Response body:", JSON.stringify(result, null, 2));

  console.log("\n── Order document after createPaymentSession ──\n");
  const updatedOrder = await orderRef.get();
  console.log(JSON.stringify(updatedOrder.data(), null, 2));

  console.log("\n── What to check ──");
  console.log("1. order.status should be 'payment_initiated'");
  console.log("2. order.items[0].price should be 65 (server price), NOT 1 (client-submitted price)");
  console.log("3. order.pricingSnapshot.subtotal should be 65");
  console.log("4. order.pricingSnapshot.platformFee should be 6.5");
  console.log("5. order.pricingSnapshot.totalPayable should be 71.5");
  console.log("\nNote the orderId for the next step:", orderId);
}

main().catch(err => {
  console.error("❌ Script failed:", err);
  process.exit(1);
});

