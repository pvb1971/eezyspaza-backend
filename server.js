// server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const admin = require('firebase-admin');
const serviceAccount = require('./eezy-spaza-4a8858965d70.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const app = express();
const port = process.env.PORT || 3000;

// --- Global JSON middleware with raw body capture (needed for webhook signature) ---
app.use(
  express.json({
    verify: (req, res, buf, encoding) => {
      if (buf && buf.length) req.rawBody = buf.toString(encoding || 'utf8');
    },
  })
);

app.use(cors());

// Env
const YOCO_API_SECRET_KEY = process.env.YOCO_SECRET_KEY;
const YOCO_WEBHOOK_SECRET = process.env.YOCO_WEBHOOK_SECRET;
const YOCO_CHECKOUT_API_URL = 'https://payments.yoco.com/api/checkouts';
const BASE_URL = process.env.BASE_URL || 'https://eezyspaza-backend1.onrender.com';

// Basic logging
app.use((req, res, next) => {
  console.log(`INCOMING REQUEST: ${req.method} ${req.originalUrl}`);
  next();
});

// ------------------------
// Create Checkout (POST)
// ------------------------
app.post('/create-checkout', async (req, res) => {
  console.log('-----> /create-checkout ROUTE HIT <-----');

  if (!YOCO_API_SECRET_KEY) {
    return res
      .status(500)
      .json({ success: false, message: 'Yoco API secret key missing' });
  }

  const { amount, currency, metadata } = req.body || {};
  if (amount == null || !currency) {
    return res
      .status(400)
      .json({ success: false, message: 'Missing amount or currency' });
  }

  // Create pending order
  const orderReference = 'EazySpaza_Order_' + Date.now();
  const orderData = {
    order_reference: orderReference,
    status: 'pending_yoco_payment',
    items: metadata?.items || [],
    customer_name: metadata?.customer_name || 'Valued Customer',
    amount,
    currency,
    checkoutId: null,
    yocoPaymentId: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  let firebaseOrderId = null;

  try {
    const newOrderRef = await db.collection('orders').add(orderData);
    firebaseOrderId = newOrderRef.id;
    console.log('Order added to Firebase with ID:', firebaseOrderId);
  } catch (err) {
    console.error('Error saving order to Firebase:', err);
    return res
      .status(500)
      .json({ success: false, message: 'Failed to save order' });
  }

  const payload = {
    amount: Math.round(parseFloat(amount) * 100), // cents
    currency,
    successUrl: `${BASE_URL}/payment-success-webview`,
    cancelUrl: `${BASE_URL}/yoco-payment-cancel`,
    failureUrl: `${BASE_URL}/yoco-payment-failure`,
    metadata: {
      ...metadata,
      firebase_order_id: firebaseOrderId,
      order_reference: orderReference,
      productType: 'checkout',
    },
  };

  console.log('Sending to Yoco:', JSON.stringify(payload, null, 2));

  try {
    const yocoResponse = await axios.post(YOCO_CHECKOUT_API_URL, payload, {
      headers: {
        Authorization: `Bearer ${YOCO_API_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const checkoutData = yocoResponse.data;
    console.log('Yoco checkout response:', checkoutData);

    await db.collection('orders').doc(firebaseOrderId).update({
      checkoutId: checkoutData.id || null,
    });

    return res.json({
      success: true,
      redirectUrl: checkoutData.redirectUrl,
      checkoutId: checkoutData.id,
    });
  } catch (err) {
    console.error(
      'Error creating Yoco checkout:',
      err.response?.data || err.message
    );
    if (firebaseOrderId) {
      await db
        .collection('orders')
        .doc(firebaseOrderId)
        .update({
          status: 'checkout_failed',
          errorMessage: JSON.stringify(err.response?.data || err.message),
        })
        .catch(console.error);
    }
    return res.status(500).json({
      success: false,
      message: 'Failed to create checkout',
      details: err.response?.data || err.message,
    });
  }
});

// ------------------------
// Webhook (POST)
// ------------------------
app.post('/yoco-webhook-receiver', async (req, res) => {
  console.log('-----> FULL /yoco-webhook-receiver ROUTE HIT <-----');
  console.log('RAW WEBHOOK BODY:', req.rawBody);

  try {
    // 1) Verify signature (Yoco Docs)
    const id = req.headers['webhook-id'];
    const timestamp = req.headers['webhook-timestamp'];
    const signatureHeader = req.headers['webhook-signature'];

    if (!id || !timestamp || !signatureHeader || !YOCO_WEBHOOK_SECRET) {
      console.warn('Missing webhook headers or secret.');
      return res.sendStatus(400);
    }

    // signature format: "t=..., v1=base64..."
    // Sometimes delivered as "v1=...,t=..." – we only need the actual signature value (the one after v1=)
    const sigParts = signatureHeader
      .toString()
      .split(',')
      .map((s) => s.trim());
    const v1Part = sigParts.find((p) => p.startsWith('v1='));
    if (!v1Part) {
      console.warn('Missing v1 signature part.');
      return res.sendStatus(400);
    }
    const providedSig = v1Part.replace('v1=', '');

    const signedContent = `${id}.${timestamp}.${req.rawBody}`;
    const secretBytes = Buffer.from(YOCO_WEBHOOK_SECRET.split('_')[1], 'base64');
    const expectedSignature = crypto
      .createHmac('sha256', secretBytes)
      .update(signedContent)
      .digest('base64');

    if (
      !crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(providedSig)
      )
    ) {
      console.warn('Webhook signature mismatch.');
      return res.sendStatus(403);
    }

    // 2) Parse event safely
    const event = req.body;
    console.log('PARSED WEBHOOK BODY:', JSON.stringify(event, null, 2));

    const type = event?.type;
    const payload = event?.payload || {};
    const status = payload?.status;
    const firebaseOrderId = payload?.metadata?.firebase_order_id;

    console.log(
      `(Webhook) Processing event type: ${type}, status: ${status}. Firebase Order ID: ${firebaseOrderId}.`
    );

    // We only handle succeeded payments
    if (type === 'payment.succeeded' && status === 'succeeded') {
      // Parse items (could be stringified JSON)
      let items = [];
      const rawItems = payload?.metadata?.items;
      try {
        if (Array.isArray(rawItems)) {
          items = rawItems;
        } else if (typeof rawItems === 'string') {
          items = JSON.parse(rawItems);
        } else {
          items = [];
        }
      } catch (e) {
        console.warn('Failed to parse metadata.items:', e.message);
        items = [];
      }

      // Normalize items to { id: string, quantity: number }
      items = (items || []).map((it) => ({
        id: String(it.id ?? it.productId ?? ''),
        quantity: Number(it.quantity ?? 1),
      }));
      // Filter out invalid
      items = items.filter((it) => it.id && Number.isFinite(it.quantity));

      // If we have an order id, run a single transaction for consistency
      if (firebaseOrderId) {
        await db.runTransaction(async (t) => {
          // ---- READS (all reads before writes) ----
          const orderRef = db.collection('orders').doc(firebaseOrderId);
          const orderSnap = await t.get(orderRef);
          if (!orderSnap.exists) {
            throw new Error(`Order not found: ${firebaseOrderId}`);
          }

          // Optional: avoid double-processing
          const currentStatus = orderSnap.get('status');
          if (currentStatus === 'paid') {
            console.log(
              `(Webhook) Order ${firebaseOrderId} already paid. Skipping stock update.`
            );
            return;
          }

          // Read all products first
          const productRefs = items.map((it) =>
            db.collection('products').doc(String(it.id))
          );
          const productSnaps = await Promise.all(
            productRefs.map((ref) => t.get(ref))
          );

          // ---- WRITES (after all reads) ----
          productSnaps.forEach((snap, idx) => {
            const ref = productRefs[idx];
            const qty = items[idx].quantity || 0;

            if (!snap.exists) {
              console.warn(
                `(Webhook) Product doc ${ref.id} not found; skipping stock update.`
              );
              return;
            }

            const current = Number(snap.get('stock') ?? 0);
            const newStock = Math.max(0, current - qty);
            console.log(
              `(Webhook) Update stock for product ${ref.id}: ${current} -> ${newStock} (qty ${qty})`
            );
            t.update(ref, { stock: newStock });
          });

          // Update order as paid
          t.update(orderRef, {
            status: 'paid',
            yocoPaymentId: payload.id || null,
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        });

        console.log(
          `(Webhook) Inventory and order updated for order ${firebaseOrderId}.`
        );
      } else {
        console.warn(
          '(Webhook) No firebase_order_id in metadata; skipping Firestore update.'
        );
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('Webhook processing error:', err.message);
    return res.sendStatus(500);
  }
});

// ------------------------
// Simple success page for WebView
// ------------------------
// Success URL
app.get("/yoco-payment-success", (req, res) => {
  res.send(`
    <h1>✅ Payment Successful</h1>
    <p>Thank you! Your payment has been processed.</p>
  `);
});

// Cancel URL
app.get("/yoco-payment-cancel", (req, res) => {
  res.send(`
    <h1>❌ Payment Cancelled</h1>
    <p>Your payment was cancelled. Please try again.</p>
  `);
});

// Failure URL
app.get("/yoco-payment-failure", (req, res) => {
  res.send(`
    <h1>⚠️ Payment Failed</h1>
    <p>There was a problem processing your payment.</p>
  `);
});

// Health
app.get('/health', (req, res) => res.status(200).send('OK'));

// Start
app.listen(port, () => {
  console.log(`EazySpaza Backend Server running on port ${port}. Waiting for requests...`);
  console.log(`Node Environment: ${process.env.NODE_ENV || 'development'}`);
  if (YOCO_SECRET_KEY_MASK(YOCO_API_SECRET_KEY)) {
    console.log(
      `YOCO_SECRET_KEY (API Secret for calls TO Yoco) is configured: ${YOCO_SECRET_KEY_MASK(
        YOCO_API_SECRET_KEY
      )}`
    );
    if (String(YOCO_API_SECRET_KEY).startsWith('sk_test_')) {
      console.log('INFO: Using TEST Yoco key. Transactions will be simulated.');
    }
  } else {
    console.warn('YOCO_SECRET_KEY is NOT set!');
  }
  if (YOCO_WEBHOOK_SECRET) {
    console.log(
      `YOCO_WEBHOOK_SECRET (Webhook Signing Secret for calls FROM Yoco) is configured: ${YOCO_WEBHOOK_SECRET.slice(
        0,
        10
      )}...`
    );
  } else {
    console.warn('YOCO_WEBHOOK_SECRET is NOT set!');
  }
});

function YOCO_SECRET_KEY_MASK(key) {
  if (!key) return null;
  return key.slice(0, 12) + '...';
}

