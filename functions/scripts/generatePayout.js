"use strict";
require("dotenv").config();
const admin = require("firebase-admin");
const fs = require("fs");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
}
const db = admin.firestore();

async function generatePayout(businessId) {
  const bizRef = db.collection("businesses").doc(businessId);
  const bizSnap = await bizRef.get();
  if (!bizSnap.exists) throw new Error(`Business not found: ${businessId}`);
  const biz = bizSnap.data();

  const lastPayoutAt = biz.lastPayoutAt ? biz.lastPayoutAt.toDate() : new Date(0);
  const now = new Date();

  const paymentsSnap = await db.collection("payments")
    .where("businessId", "==", businessId)
    .where("createdAt", ">", lastPayoutAt)
    .orderBy("createdAt", "asc")
    .get();

  if (paymentsSnap.empty) {
    console.log(`No unpaid payments for ${businessId} since ${lastPayoutAt.toISOString()}`);
    return;
  }

  let total = 0;
  const rows = ["orderId,transactionId,date,restaurantPayout,platformFee"];
  paymentsSnap.docs.forEach(doc => {
    const p = doc.data();
    total += p.restaurantPayout || 0;
    const date = p.createdAt ? p.createdAt.toDate().toISOString() : "";
    rows.push(`${p.orderId},${p.transactionId},${date},${p.restaurantPayout},${p.platformFee}`);
  });

  const filename = `payout_${businessId}_${now.toISOString().slice(0,10)}.csv`;
  fs.writeFileSync(filename, rows.join("\n"));

  console.log(`\nPayout statement for: ${biz.businessName || businessId}`);
  console.log(`Period: ${lastPayoutAt.toISOString()} → ${now.toISOString()}`);
  console.log(`Orders included: ${paymentsSnap.size}`);
  console.log(`TOTAL TO PAY: R${total.toFixed(2)}`);
  console.log(`CSV saved to: ${filename}`);

  await bizRef.update({
    unpaidEarnings: 0,
    lastPayoutAt: admin.firestore.Timestamp.fromDate(now),
  });
  console.log(`✅ Marked as paid out. lastPayoutAt updated.`);
}

const businessId = process.argv[2];
if (!businessId) {
  console.error("Usage: node scripts/generatePayout.js <businessId>");
  process.exit(1);
}
generatePayout(businessId).catch(err => {
  console.error("Error generating payout:", err);
  process.exit(1);
});
