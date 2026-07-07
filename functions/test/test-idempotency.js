// test/test-idempotency.js
// Run with: node test/test-idempotency.js

"use strict";

let failures = 0;
function check(label, condition) {
  if (!condition) failures++;
  console.log(`${condition ? "✅" : "❌"} ${label}`);
}

class MockFirestore {
  constructor() {
    this.collections = { orders: {}, payments: {}, restaurants: {} };
  }
  doc(collection, id) {
    return {
      get: async () => ({
        exists: this.collections[collection][id] !== undefined,
        data: () => this.collections[collection][id],
        id,
      }),
    };
  }
  async runTransaction(fn) {
    const writes = [];
    const txn = {
      get: async (docRef) => docRef.get(),
      update: (docRef, data) => writes.push({ type: "update", docRef, data }),
      set: (docRef, data) => writes.push({ type: "set", docRef, data }),
    };
    await fn(txn);
    for (const w of writes) {
      const { docRef, data } = w;
      const existing = this.collections[docRef._collection]?.[docRef._id] || {};
      if (w.type === "set" && docRef._isNewDoc) {
        this.collections[docRef._collection][docRef._id] = data;
      } else {
        this.collections[docRef._collection][docRef._id] = { ...existing, ...flattenDotted(data) };
      }
    }
    return writes;
  }
}

function flattenDotted(data) {
  const result = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.includes(".")) {
      const [outer, inner] = key.split(".");
      result[outer] = { ...(result[outer] || {}), [inner]: value };
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function processWebhook(db, orderId, payload) {
  let processed = false;
  let skipped = false;

  await db.runTransaction(async (txn) => {
    const orderDocRef = { _collection: "orders", _id: orderId, get: () => db.doc("orders", orderId).get() };
    const orderSnap = await orderDocRef.get();

    if (!orderSnap.exists) throw new Error(`Order not found: ${orderId}`);
    const order = orderSnap.data();

    if (order.status !== "payment_initiated") {
      skipped = true;
      return;
    }

    if (payload.type === "payment.complete") {
      txn.update(orderDocRef, {
        status: "paid",
        "payment.status": "paid",
        "payment.transactionId": payload.id,
      });

      const paymentDocRef = { _collection: "payments", _id: `pay_${orderId}_${Date.now()}`, _isNewDoc: true };
      txn.set(paymentDocRef, {
        orderId,
        amount: order.pricingSnapshot.totalPayable,
        restaurantPayout: order.pricingSnapshot.restaurantPayout,
      });

      const restaurantDocRef = { _collection: "restaurants", _id: order.restaurantId };
      const currentEarnings = (db.collections.restaurants[order.restaurantId]?.totalEarnings) || 0;
      txn.update(restaurantDocRef, {
        totalEarnings: currentEarnings + order.pricingSnapshot.restaurantPayout,
      });

      processed = true;
    }
  });

  return { processed, skipped };
}

(async () => {
  console.log("── idempotency guard test ──\n");

  const db = new MockFirestore();
  const orderId = "order_test_001";

  db.collections.orders[orderId] = {
    status: "payment_initiated",
    restaurantId: "rest_001",
    pricingSnapshot: { totalPayable: 93.50, restaurantPayout: 85.00, platformFee: 8.50 },
  };
  db.collections.restaurants["rest_001"] = { totalEarnings: 0 };

  const webhookPayload = {
    type: "payment.complete",
    id: "txn_abc123",
    externalReference: orderId,
  };

  const result1 = await processWebhook(db, orderId, webhookPayload);
  check("First webhook delivery processed", result1.processed === true && result1.skipped === false);
  check("Order status updated to paid", db.collections.orders[orderId].status === "paid");
  check(
    "Restaurant earnings incremented by restaurantPayout only (R85, not R93.50)",
    db.collections.restaurants["rest_001"].totalEarnings === 85.00
  );

  const earningsAfterFirst = db.collections.restaurants["rest_001"].totalEarnings;

  const result2 = await processWebhook(db, orderId, webhookPayload);
  check("Duplicate webhook delivery correctly skipped", result2.skipped === true && result2.processed === false);
  check(
    "Restaurant earnings NOT double-incremented after duplicate",
    db.collections.restaurants["rest_001"].totalEarnings === earningsAfterFirst
  );
  check(
    "Restaurant earnings still exactly R85 (not R170)",
    db.collections.restaurants["rest_001"].totalEarnings === 85.00
  );

  const result3 = await processWebhook(db, orderId, webhookPayload);
  check("Third (also duplicate) delivery correctly skipped", result3.skipped === true);
  check(
    "Restaurant earnings still exactly R85 after 3 total deliveries",
    db.collections.restaurants["rest_001"].totalEarnings === 85.00
  );

  console.log(`\n${failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
})();

