const functions = require('firebase-functions');
const admin = require('firebase-admin');
const crypto = require('crypto');
const axios = require('axios');

admin.initializeApp();
const db = admin.firestore();

// ══════════════════════════════════════════════
// SFFM Pricing: 10% of order total, R3 minimum
// ══════════════════════════════════════════════
function calculateServiceFee(foodTotal) {
  return +Math.max(foodTotal * 0.10, 3.00).toFixed(2);
}

// ══════════════════════════════════════════════
// FUNCTION 1: createOrder
// Prices come ONLY from menusCache — never from frontend
// ══════════════════════════════════════════════
exports.createOrder = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated', 'Must be logged in'
    );
  }

  const {
    restaurantId, restaurantName,
    items, customerName, customerPhone, estimatedWait
  } = data;

  if (!items || !items.length) {
    throw new functions.https.HttpsError(
      'invalid-argument', 'No items provided'
    );
  }

  // Single read from menu cache
  const cacheSnap = await db
    .collection('menusCache')
    .doc(restaurantId)
    .get();

  if (!cacheSnap.exists) {
    throw new functions.https.HttpsError(
      'not-found', 'Menu not available — cache missing'
    );
  }

  const cachedItems = cacheSnap.data().items || {};

  // Validate and price every item from cache
  let foodTotal = 0;
  const verifiedItems = [];

  for (const item of items) {
    const cached = cachedItems[item.itemId];
    if (!cached) {
      throw new functions.https.HttpsError(
        'not-found', `Item not found: ${item.name}`
      );
    }

    const realPrice = cached.price;
    const subtotal  = +(realPrice * item.qty).toFixed(2);
    foodTotal      += subtotal;

    verifiedItems.push({
      itemId:   item.itemId,
      name:     cached.name,
      qty:      item.qty,
      price:    realPrice,
      subtotal
    });
  }

  foodTotal = +foodTotal.toFixed(2);
  const serviceFee  = calculateServiceFee(foodTotal);
  const finalAmount = +(foodTotal + serviceFee).toFixed(2);

  // Unique order number
  const orderRef    = db.collection('orders').doc();
  const timestamp   = Date.now().toString(36).toUpperCase();
  const shortId     = orderRef.id.slice(-4).toUpperCase();
  const orderNumber = `GRB-${timestamp}-${shortId}`;

  await orderRef.set({
    orderId:       orderRef.id,
    orderNumber,
    customerId:    context.auth.uid,
    customerName,
    customerPhone,
    restaurantId,
    restaurantName,
    items:         verifiedItems,
    estimatedWait: estimatedWait || '15 min',
    foodTotal,
    serviceFee,
    finalAmount,
    paymentStatus: 'pending',     // money state: pending | paid
    orderStatus:   'pending_payment', // food state: pending_payment | preparing | ready | completed | cancelled
    yocoCheckoutId: null,         // filled in by createYocoCheckout
    createdAt:     admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:     admin.firestore.FieldValue.serverTimestamp()
  });

  return {
    orderId:      orderRef.id,
    orderNumber,
    foodTotal,
    serviceFee,
    finalAmount
  };
});

// ══════════════════════════════════════════════
// FUNCTION 2: createYocoCheckout
// Server-to-server call to Yoco Checkout API.
// Returns redirectUrl — frontend redirects the browser there.
// ══════════════════════════════════════════════
exports.createYocoCheckout = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated', 'Must be logged in'
    );
  }

  const { orderId, baseUrl } = data;

  if (!orderId || !baseUrl) {
    throw new functions.https.HttpsError(
      'invalid-argument', 'orderId and baseUrl are required'
    );
  }

  const orderRef  = db.collection('orders').doc(orderId);
  const orderSnap = await orderRef.get();

  if (!orderSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Order not found');
  }

  const order = orderSnap.data();

  if (order.customerId !== context.auth.uid) {
    throw new functions.https.HttpsError(
      'permission-denied', 'Not your order'
    );
  }

  // Don't create a second checkout if one already exists and order isn't paid
  if (order.paymentStatus === 'paid') {
    throw new functions.https.HttpsError(
      'already-exists', 'Order already paid'
    );
  }

  const secretKey = functions.config().yoco.secret_key; // sk_test_... or sk_live_...
  const amountInCents = Math.round(order.finalAmount * 100);

  let checkout;
  try {
    const response = await axios.post(
      'https://payments.yoco.com/api/checkouts',
      {
        amount: amountInCents,
        currency: 'ZAR',
        successUrl: `${baseUrl}/order/${orderId}/success`,
        cancelUrl:  `${baseUrl}/order/${orderId}/cancel`,
        failureUrl: `${baseUrl}/order/${orderId}/failed`,
        metadata: {
          orderId // our custom field — webhook tries this first
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${secretKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    checkout = response.data;
  } catch(err) {
    const msg = err.response?.data?.message || err.message;
    console.error('Yoco checkout creation failed:', msg);
    throw new functions.https.HttpsError(
      'internal', 'Could not create payment checkout: ' + msg
    );
  }

  // Save checkoutId on the order — this is the fallback lookup key
  // for the webhook if metadata.orderId doesn't come back.
  await orderRef.update({
    yocoCheckoutId: checkout.id,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return {
    checkoutId:  checkout.id,
    redirectUrl: checkout.redirectUrl
  };
});

// ══════════════════════════════════════════════
// FUNCTION 3: yocoWebhook
// Verified against official Yoco docs:
//   - Header: webhook-signature (format "v1,<base64sig>")
//   - Algorithm: HMAC-SHA256, base64 encoded
//   - Signed content: webhook-id + "." + webhook-timestamp + "." + rawBody
//   - Secret: strip "whsec_" prefix, base64-decode before HMAC
//   - Replay protection: reject if webhook-timestamp > 3 min old
//   - Event types that exist: payment.succeeded, refund.succeeded, refund.failed
//     (there is NO payment.failed event)
// ══════════════════════════════════════════════
exports.yocoWebhook = functions.https.onRequest(async (req, res) => {

  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  // ── Step 1: Verify signature ──
  const webhookId        = req.headers['webhook-id'];
  const webhookTimestamp = req.headers['webhook-timestamp'];
  const webhookSigHeader = req.headers['webhook-signature'];
  const webhookSecret    = functions.config().yoco.webhook_secret; // whsec_...

  if (!webhookId || !webhookTimestamp || !webhookSigHeader || !webhookSecret) {
    console.error('Missing webhook headers or secret');
    return res.status(401).send('Unauthorized');
  }

  const rawBody = req.rawBody?.toString('utf8');
  if (!rawBody) {
    console.error('No raw body available');
    return res.status(400).send('Bad request');
  }

  // Replay attack protection — reject if older than 3 minutes
  const timestampMs = parseInt(webhookTimestamp, 10) * 1000;
  const diffMinutes = Math.abs(Date.now() - timestampMs) / 60000;

  if (!Number.isFinite(diffMinutes) || diffMinutes > 3) {
    console.error('Webhook timestamp invalid or too old — possible replay');
    return res.status(401).send('Unauthorized');
  }

  // Build signed content: webhook-id.webhook-timestamp.rawBody
  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;

  // Strip "whsec_" prefix, base64-decode secret
  const secretB64   = webhookSecret.replace(/^whsec_/, '');
  const secretBytes = Buffer.from(secretB64, 'base64');

  // HMAC-SHA256, base64 encoded
  const expectedSig = crypto
    .createHmac('sha256', secretBytes)
    .update(signedContent)
    .digest('base64');

  // Header format: "v1,<sig>" — possibly multiple space-separated
  const candidates = webhookSigHeader.split(' ');
  const verified = candidates.some(candidate => {
    const sig = candidate.replace(/^v\d+,/, '');
    try {
      return crypto.timingSafeEqual(
        Buffer.from(sig, 'utf8'),
        Buffer.from(expectedSig, 'utf8')
      );
    } catch {
      return false; // length mismatch etc.
    }
  });

  if (!verified) {
    console.error('Invalid Yoco signature — rejecting');
    return res.status(401).send('Unauthorized');
  }

  // ── Step 2: Parse event ──
  const event       = req.body;
  const yocoEventId = event?.id;      // evt_... — used for idempotency
  const yocoPaymentId = event?.payload?.id; // p_... — the payment record
  const eventType   = event?.type;

  if (!eventType || !yocoEventId) {
    return res.status(400).send('Missing event data');
  }

  // ── Step 3: Basic idempotency ──
  const processedRef = db.collection('processedWebhooks').doc(yocoEventId);
  const alreadyProcessed = await processedRef.get();

  if (alreadyProcessed.exists) {
    console.log('Duplicate webhook ignored:', yocoEventId);
    return res.status(200).send('OK');
  }

  // We only act on payment.succeeded for MVP.
  // refund.succeeded / refund.failed are acknowledged but not processed yet.
  if (eventType !== 'payment.succeeded') {
    await processedRef.set({
      yocoEventId,
      eventType,
      note: 'Event type acknowledged but not processed in MVP',
      processedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return res.status(200).send('OK');
  }

  // ── Step 4: Resolve orderId ──
  // Try our custom metadata.orderId first
  let orderId = event?.payload?.metadata?.orderId;

  // Fallback: Yoco's own metadata.checkoutId → look up by yocoCheckoutId
  if (!orderId) {
    const checkoutId = event?.payload?.metadata?.checkoutId;

    if (checkoutId) {
      console.warn('metadata.orderId missing — falling back to checkoutId lookup');
      const snap = await db
        .collection('orders')
        .where('yocoCheckoutId', '==', checkoutId)
        .limit(1)
        .get();

      if (!snap.empty) {
        orderId = snap.docs[0].id;
      }
    }
  }

  if (!orderId) {
    console.error('Could not resolve orderId for event:', yocoEventId);
    await processedRef.set({
      yocoEventId,
      eventType,
      error: 'orderId unresolvable',
      processedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    // Return 200 so Yoco stops retrying an unfixable event
    return res.status(200).send('OK');
  }

  // ── Step 5: Update order ──
  const orderRef  = db.collection('orders').doc(orderId);
  const orderSnap = await orderRef.get();

  if (!orderSnap.exists) {
    console.error('Order not found:', orderId);
    await processedRef.set({
      yocoEventId,
      eventType,
      orderId,
      error: 'order not found',
      processedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return res.status(200).send('OK');
  }

  const order = orderSnap.data();

  // Retry-safe: never overwrite an order that's already paid
  if (order.paymentStatus !== 'paid') {
    await orderRef.update({
      paymentStatus: 'paid',
      orderStatus:   'preparing',
      yocoPaymentId: yocoPaymentId || null,
      yocoEventId,
      paidAt:        admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:     admin.firestore.FieldValue.serverTimestamp()
    });

    // Save a payment record
    await db.collection('payments')
      .doc(yocoPaymentId || orderId)
      .set({
        orderId,
        customerId:    order.customerId,
        amount:        order.finalAmount,
        currency:      'ZAR',
        yocoPaymentId: yocoPaymentId || null,
        yocoEventId,
        status:        'paid',
        createdAt:     admin.firestore.FieldValue.serverTimestamp()
      });
  } else {
    console.log('Order already paid — skipping update:', orderId);
  }

  // ── Step 6: Mark webhook processed ──
  await processedRef.set({
    yocoEventId,
    yocoPaymentId: yocoPaymentId || null,
    orderId,
    eventType,
    processedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  console.log(`Webhook processed: ${eventType} for order ${orderId}`);
  return res.status(200).send('OK');
});
