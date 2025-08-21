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
  verify: (req, res, buf) => {
    if (buf && buf.length) req.rawBody = buf.toString('utf8');
  }
}));

// Environment variables
const YOCO_API_SECRET_KEY = process.env.YOCO_SECRET_KEY;
const YOCO_WEBHOOK_SECRET = process.env.YOCO_WEBHOOK_SECRET;
const YOCO_CHECKOUT_API_URL = 'https://payments.yoco.com/api/checkouts';
const BASE_URL = process.env.BASE_URL || 'https://eezyspaza-backend1.onrender.com';

// ========================================================================= //
// == CREATE Yoco CHECKOUT ROUTE                                           == //
// ========================================================================= //
app.post('/create-checkout', async (req, res) => {
  const { amount, currency, metadata } = req.body;

  if (!amount || !currency) {
    return res.status(400).json({ success: false, message: 'Missing amount or currency.' });
  }

  // Save order to Firebase
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

  let newOrderFirebaseId;
  try {
    const newOrderRef = await db.collection('orders').add(orderData);
    newOrderFirebaseId = newOrderRef.id;
  } catch (err) {
    console.error("Firebase error:", err);
    return res.status(500).json({ success: false, message: 'Failed to save order.' });
  }

  const payload = {
    amount: Math.round(parseFloat(amount) * 100),
    currency,
    successUrl: `${BASE_URL}/yoco-payment-success`,
    cancelUrl: `${BASE_URL}/yoco-payment-cancel`,
    failureUrl: `${BASE_URL}/yoco-payment-failure`,
    metadata: {
      ...metadata,
      firebase_order_id: newOrderFirebaseId,
      order_reference: orderReference
    }
  };

  try {
    const yocoResponse = await axios.post(YOCO_CHECKOUT_API_URL, payload, {
      headers: {
        'Authorization': `Bearer ${YOCO_API_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const checkoutData = yocoResponse.data;
    await db.collection('orders').doc(newOrderFirebaseId).update({
      checkoutId: checkoutData.id
    });

    res.json({ success: true, redirectUrl: checkoutData.redirectUrl, checkoutId: checkoutData.id });
  } catch (err) {
    console.error('Yoco checkout error:', err.response?.data || err.message);
    if (newOrderFirebaseId) {
      await db.collection('orders').doc(newOrderFirebaseId).update({
        status: 'checkout_failed',
        errorMessage: err.response ? JSON.stringify(err.response.data) : err.message
      });
    }
    res.status(err.response?.status || 500).json({
      success: false,
      message: 'Failed to create checkout.',
      details: err.response?.data || { error: err.message }
    });
  }
});

// ========================================================================= //
// == YOCO WEBHOOK RECEIVER                                                == //
// ========================================================================= //
app.post('/yoco-webhook', async (req, res) => {
  const headers = req.headers;
  const rawBody = req.rawBody || '';

  // Verify webhook signature
  try {
    const webhookId = headers['webhook-id'];
    const webhookTimestamp = headers['webhook-timestamp'];
    const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;

    const secretBytes = Buffer.from(YOCO_WEBHOOK_SECRET.split('_')[1], 'base64');
    const expectedSignature = crypto
      .createHmac('sha256', secretBytes)
      .update(signedContent)
      .digest('base64');

    const receivedSignature = headers['webhook-signature']?.split(' ')[0]?.split(',')[1];

    if (!crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(receivedSignature))) {
      console.warn('Webhook signature mismatch!');
      return res.sendStatus(403);
    }

    // Signature valid, process the event
    const event = req.body;
    console.log('✅ Valid webhook received:', event);

    // Example: update Firebase order status if payment succeeded
    if (event.type === 'payment.success') {
      const checkoutId = event.data?.checkoutId;
      if (checkoutId) {
        const ordersQuery = await db.collection('orders').where('checkoutId', '==', checkoutId).get();
        ordersQuery.forEach(async doc => {
          await db.collection('orders').doc(doc.id).update({ status: 'paid' });
        });
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('Webhook verification error:', err);
    return res.sendStatus(500);
  }
});

// ========================================================================= //
// == REDIRECT PAGES FOR Yoco                                               == //
// ========================================================================= //
app.get('/yoco-payment-success', (req, res) => {
  res.send(`
    <html><head><title>Payment Success</title></head>
    <body style="font-family:sans-serif;text-align:center;padding:40px;">
      <h1>✅ Payment Successful</h1>
      <p>Your order has been placed successfully.</p>
    </body></html>
  `);
});

app.get('/yoco-payment-cancel', (req, res) => {
  res.send(`
    <html><head><title>Payment Cancelled</title></head>
    <body style="font-family:sans-serif;text-align:center;padding:40px;">
      <h1>❌ Payment Cancelled</h1>
      <p>Your order was not placed.</p>
    </body></html>
  `);
});

app.get('/yoco-payment-failure', (req, res) => {
  res.send(`
    <html><head><title>Payment Failed</title></head>
    <body style="font-family:sans-serif;text-align:center;padding:40px;">
      <h1>⚠️ Payment Failed</h1>
      <p>Please try again.</p>
    </body></html>
  `);
});

// Health check
app.get('/health', (req, res) => res.status(200).send('OK'));

// Start server
app.listen(port, () => {
  console.log(`EezySpaza Backend running on port ${port}`);
  console.log(`BASE_URL: ${BASE_URL}`);
  if (YOCO_WEBHOOK_SECRET) console.log('YOCO_WEBHOOK_SECRET is configured');
  if (YOCO_API_SECRET_KEY) console.log('YOCO_API_SECRET_KEY is configured');
});
