// server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto'); // For webhook signature verification
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
app.use(express.json());

// Log incoming requests
app.use((req, res, next) => {
    console.log(`INCOMING REQUEST: ${req.method} ${req.originalUrl}`);
    next();
});

const YOCO_API_SECRET_KEY = process.env.YOCO_SECRET_KEY;
const YOCO_WEBHOOK_SECRET = process.env.YOCO_WEBHOOK_SECRET;
const YOCO_CHECKOUT_API_URL = 'https://payments.yoco.com/api/checkouts';
const BASE_URL = process.env.BASE_URL || 'https://eezyspaza-backend1.onrender.com';

// ========================
// CREATE Yoco Checkout
// ========================
app.post('/create-checkout', async (req, res) => {
    console.log("-----> /create-checkout ROUTE HIT! <-----");

    if (!YOCO_API_SECRET_KEY) {
        console.error("CRITICAL: YOCO_SECRET_KEY not set.");
        return res.status(500).json({ success: false, message: 'Server misconfiguration: Yoco API key missing.' });
    }

    const { amount, currency, metadata } = req.body;
    if (!amount || !currency) {
        return res.status(400).json({ success: false, message: 'Missing amount or currency.' });
    }

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
        console.log('Order added to Firebase with ID:', newOrderFirebaseId);
    } catch (error) {
        console.error("Error saving order to Firebase:", error);
        return res.status(500).json({ success: false, message: 'Failed to save order to DB.' });
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

    console.log("Sending to Yoco (/api/checkouts):", JSON.stringify(payload, null, 2));

    try {
        const yocoResponse = await axios.post(YOCO_CHECKOUT_API_URL, payload, {
            headers: {
                'Authorization': `Bearer ${YOCO_API_SECRET_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const checkoutData = yocoResponse.data;
        await db.collection('orders').doc(newOrderFirebaseId).update({ checkoutId: checkoutData.id });

        res.json({
            success: true,
            redirectUrl: checkoutData.redirectUrl,
            checkoutId: checkoutData.id
        });
    } catch (error) {
        console.error('Error creating Yoco checkout:', error.response?.data || error.message);
        if (newOrderFirebaseId) {
            await db.collection('orders').doc(newOrderFirebaseId).update({
                status: 'checkout_failed',
                errorMessage: JSON.stringify(error.response?.data || error.message)
            }).catch(e => console.error("Error updating failed order:", e));
        }
        res.status(error.response?.status || 500).json({ success: false, message: 'Failed to create checkout.', details: error.response?.data || error.message });
    }
});

// ========================
// YOCO Webhook Receiver
// ========================
app.post('/yoco-webhook-receiver', express.json({ verify: (req, res, buf, encoding) => {
    if (buf && buf.length) req.rawBody = buf.toString(encoding || 'utf8');
}}), async (req, res) => {
    console.log("-----> FULL /yoco-webhook-receiver ROUTE HIT <-----");
    console.log("RAW WEBHOOK BODY:", req.rawBody);

    try {
        const event = req.body;
        console.log("PARSED WEBHOOK BODY:", JSON.stringify(event, null, 2));

        const checkoutId = event.payload?.metadata?.checkoutId;
        const firebaseOrderId = event.payload?.metadata?.firebase_order_id;
        console.log(`(Webhook) Processing event type: ${event.type}. Firebase Order ID: ${firebaseOrderId}.`);

        // Example: update stock if payment succeeded
        if (event.type === 'payment.succeeded') {
            const productId = JSON.parse(event.payload.metadata.items)[0].id;
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
// Payment Redirect Pages
// ========================
app.get('/yoco-payment-success', (req, res) => {
    console.log('-----> /yoco-payment-success ROUTE HIT <-----');
    console.log('Query Parameters:', req.query);
    res.send('Payment successful! Your order has been placed.');
});

app.get('/yoco-payment-cancel', (req, res) => {
    res.send('Payment was cancelled. Your order has not been placed.');
});

app.get('/yoco-payment-failure', (req, res) => {
    res.send('Payment failed. Please try again.');
});

// ========================
// Health Check
// ========================
app.get('/health', (req, res) => res.status(200).send('OK'));

// ========================
// Start Serv
