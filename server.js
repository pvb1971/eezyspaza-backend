// server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const admin = require('firebase-admin');
const serviceAccount = require('./eezy-spaza-4a8858965d70.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({
  verify: (req, res, buf, encoding) => {
    if (buf && buf.length) req.rawBody = buf.toString(encoding || 'utf8');
  }
}));

// Environment keys
const YOCO_API_SECRET_KEY = process.env.YOCO_SECRET_KEY;
const YOCO_WEBHOOK_SECRET = process.env.YOCO_WEBHOOK_SECRET;
const YOCO_CHECKOUT_API_URL = 'https://payments.yoco.com/api/checkouts';

// Log all incoming requests
app.use((req, res, next) => {
  console.log(`INCOMING REQUEST: ${req.method} ${req.originalUrl}`);
  next();
});

// ========================
// CREATE CHECKOUT
// ========================
app.post('/create-checkout', async (req, res) => {
  console.log("-----> /create-checkout ROUTE HIT <-----");

  if (!YOCO_API_SECRET_KEY) {
    return res.status(500).json({ success: false, message: 'Yoco API secret key missing' });
  }

  const { amount, currency, metadata } = req.body;
  if (!amount || !currency) {
    return res.status(400).json({ success: false, message: 'Missing amount or currency' });
  }

  // Save order in Firebase
  const orderReference = 'EazySpaza_Order_' + Date.now();
  const orderData = {
    order_reference: orderReference,
    status: 'pending_yoco_payment',
    items: metadata?.items || [],
    customer_name: metadata?.customer_name || 'Guest Customer',
    amount,
    currency,
    checkoutId: null,
    yocoPaymentId: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };

  let firebaseOrderId;
  try {
    const newOrderRef = await db.collection('orders').add(orderData);
    firebaseOrderId = newOrderRef.id;
    console.log('Order added to Firebase with ID:', firebaseOrderId);
  } catch (err) {
    console.error('Error saving order to Firebase:', err);
    return res.status(500).json({ success: false, message: 'Failed to save order' });
  }

  // Build Yoco checkout payload
  const baseUrl = process.env.BASE_URL || 'https://paytest-backend.onrender.com';
  const payload = {
    amount: Math.round(parseFloat(amount) * 100),
    currency,
    successUrl: `${baseUrl}/yoco-payment-success`,
    cancelUrl: `${baseUrl}/yoco-payment-cancel`,
    failureUrl: `${baseUrl}/yoco-payment-failure`,
    metadata: {
      ...metadata,
      firebase_order_id: firebaseOrderId,
      order_reference: orderReference
    }
  };

  console.log("Sending to Yoco:", JSON.stringify(payload, null, 2));

  try {
    const yocoResponse = await axios.post(YOCO_CHECKOUT_API_URL, payload, {
      headers: {
        'Authorization': `Bearer ${YOCO_API_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const checkoutData = yocoResponse.data;
    await db.collection('orders').doc(firebaseOrderId).update({
      checkoutId: checkoutData.id
    });

    res.json({
      success: true,
      redirectUrl: checkoutData.redirectUrl,
      checkoutId: checkoutData.id
    });
  } catch (err) {
    console.error('Error creating Yoco checkout:', err.response?.data || err.message);
    if (firebaseOrderId) {
      await db.collection('orders').doc(firebaseOrderId).update({
        status: 'checkout_failed',
        errorMessage: JSON.stringify(err.response?.data || err.message)
      }).catch(console.error);
    }
    res.status(500).json({ success: false, message: 'Failed to create checkout', details: err.response?.data || err.message });
  }
});

// ========================
// YOCO WEBHOOK RECEIVER
// ========================
app.post('/yoco-webhook-receiver', async (req, res) => {
  console.log("-----> /yoco-webhook-receiver ROUTE HIT <-----");
  console.log("RAW WEBHOOK BODY:", req.rawBody);

  try {
    const event = req.body;
    console.log("PARSED WEBHOOK BODY:", JSON.stringify(event, null, 2));

    const firebaseOrderId = event.payload?.metadata?.firebase_order_id;

    if (event.type === 'payment.succeeded') {
      const productId = JSON.parse(event.payload.metadata.items || '[]')[0]?.id;
      console.log(`(Webhook) Updated stock for product ${productId}.`);

      await db.collection('orders').doc(firebaseOrderId).update({
        status: 'paid',
        yocoPaymentId: event.payload.id
      });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook processing error:", err.message);
    res.sendStatus(500);
  }
});

// ========================
// REDIRECT PAGES
// ========================
app.get('/yoco-payment-success', (req, res) => {
  res.send(`<html><body><h1>Payment Successful!</h1></body></html>`);
});
app.get('/yoco-payment-cancel', (req, res) => res.send('Payment was cancelled.'));
app.get('/yoco-payment-failure', (req, res) => res.send('Payment failed. Please try again.'));

// ========================
// HEALTH CHECK
// ========================
app.get('/health', (req, res) => res.status(200).send('OK'));

// ========================
// START SERVER
// ========================
app.listen(port, () => {
  console.log(`EazySpaza Backend Server running on port ${port}`);
  if (YOCO_API_SECRET_KEY) console.log('Yoco API Key loaded.');
  if (YOCO_WEBHOOK_SECRET) console.log('Yoco Webhook Secret loaded.');
});
