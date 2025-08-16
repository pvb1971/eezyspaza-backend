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
 
// REVISED: Access environment variables directly to avoid potential issues.
const YOCO_API_SECRET_KEY = process.env.YOCO_SECRET_KEY;
const YOCO_WEBHOOK_SECRET = process.env.YOCO_WEBHOOK_SECRET;
const YOCO_CHECKOUT_API_URL = 'https://payments.yoco.com/api/checkouts';
 
// Helper function to log incoming requests
app.use((req, res, next) => {
   console.log(`INCOMING REQUEST: ${req.method} ${req.originalUrl}`);
   next();
});
 
// ========================================================================= //
// == YOCO CHECKOUT CREATION ROUTE                                        == //
// ========================================================================= //
app.post('/create-checkout', express.json(), async (req, res) => {
   console.log("-----> /create-checkout ROUTE HIT! <-----");
   // console.log("Request Body for /create-checkout:", JSON.stringify(req.body, null, 2));
 
   if (!YOCO_API_SECRET_KEY) {
       console.error("CRITICAL: YOCO_SECRET_KEY (API Secret) environment variable is not set.");
       return res.status(500).json({ success: false, message: 'Server configuration error: Yoco API secret key missing.' });
   }
 
   const { amount, currency, metadata } = req.body;
   if (!amount || !currency) {
       return res.status(400).json({ success: false, message: 'Missing amount or currency.' });
   }
 
   // --- FIREBASE ORDER SAVE CODE ---
   const orderReference = 'EazySpaza_Order_' + Date.now();
   const orderData = {
     order_reference: orderReference,
     status: 'pending_yoco_payment',
     items: metadata ? metadata.items : [],
     customer_name: metadata ? metadata.customer_name : 'Guest Customer',
     amount: amount,
     currency: currency,
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
       return res.status(500).json({ success: false, message: 'Failed to save order to database.' });
   }
   // --- END FIREBASE ORDER SAVE CODE ---
 
   const host = req.get('host');
   const protocol = req.protocol;
   const baseUrl = `${protocol}://${host}`;
 
   const payload = {
       amount: Math.round(parseFloat(amount) * 100),
       currency: currency,
       successUrl: `${baseUrl}/yoco-payment-success`,
       cancelUrl: `${baseUrl}/yoco-payment-cancel`,
       failureUrl: `${baseUrl}/yoco-payment-failure`,
       metadata: {
           ...metadata,
           // **CORRECTION:** Adding the Firebase order ID to Yoco's metadata. This is crucial for webhook matching!
           firebase_order_id: newOrderFirebaseId,
           order_reference: orderReference
       },
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
       const yocoCheckoutId = checkoutData.id;
 
       // **CORRECTION:** Update the Firestore document with the Yoco checkoutId
       await db.collection('orders').doc(newOrderFirebaseId).update({
         checkoutId: yocoCheckoutId
       });
       console.log(`Updated Firebase order with Yoco checkoutId: ${yocoCheckoutId}`);
 
       res.json({
           success: true,
           redirectUrl: checkoutData.redirectUrl,
           checkoutId: yocoCheckoutId
       });
// ... (code above) ...

   } catch (error) {
       console.error('Error creating Yoco checkout:');
       if (error.response) {
           console.error('Yoco API Error Status:', error.response.status);
           console.error('Yoco API Error Data:', JSON.stringify(error.response.data, null, 2));
           res.status(error.response.status || 500).json({
                success: false,
                message: 'Failed to create checkout with Yoco.',
                details: error.response.data
           });
       } else {
           console.error('Network/Request Error:', error.message);
           res.status(500).json({ success: false, message: 'Internal server error during checkout creation.' });
       }
   }
 
// ... (code below) ...
 
// ... (rest of your code is unchanged) ...
 
// ========================================================================= //
// == YOCO WEBHOOK RECEIVER (SERVER-TO-SERVER PAYMENT CONFIRMATION)      == //
// ========================================================================= //
app.post('/yoco-webhook-receiver',
   express.json({
       verify: (req, res, buf, encoding) => {
           if (buf && buf.length) {
              req.rawBody = buf.toString(encoding || 'utf8');
           }
       }
   }),
   async (req, res) => {
       console.log("-----> FULL /yoco-webhook-receiver ROUTE HIT <-----");
       
       if (!YOCO_WEBHOOK_SECRET) {
          console.error("CRITICAL (Webhook): YOCO_WEBHOOK_SECRET environment variable is not set. Cannot verify signature.");
          return res.status(500).send('Server configuration error: Webhook processing unavailable.');
       }
       if (!YOCO_WEBHOOK_SECRET.startsWith('whsec_')) {
          console.error(`CRITICAL (Webhook): YOCO_WEBHOOK_SECRET format is incorrect. Expected 'whsec_...' but got '${YOCO_WEBHOOK_SECRET.substring(0,10)}...'`);
          return res.status(500).send('Server configuration error: Webhook secret format incorrect.');
       }
 
       const yocoWebhookId = req.headers['webhook-id'];
       const yocoTimestampHeader = req.headers['webhook-timestamp'];
       const yocoSignatureHeader = req.headers['webhook-signature'];
 
       if (!yocoWebhookId || !yocoTimestampHeader || !yocoSignatureHeader) {
          console.error("(Webhook) Missing one or more required Yoco headers: webhook-id, webhook-timestamp, or webhook-signature.");
          return res.status(400).send('Missing required Yoco webhook headers.');
       }
 
       const webhookTimestamp = parseInt(yocoTimestampHeader, 10);
       const currentTimestamp = Math.floor(Date.now() / 1000);
       const threeMinutesInSeconds = 3 * 60;
 
       if (Math.abs(currentTimestamp - webhookTimestamp) > threeMinutesInSeconds) {
          console.warn(`(Webhook) Timestamp [${webhookTimestamp}] outside tolerance compared to current time [${currentTimestamp}].`);
          return res.status(400).send('Timestamp validation failed (outside tolerance).');
       }
 
       try {
          if (!req.rawBody) {
             console.error("CRITICAL (Webhook): req.rawBody is not defined.");
             return res.status(500).send('Internal server error: Raw body missing for signature check.');
          }
 
          const signedContent = `${yocoWebhookId}.${yocoTimestampHeader}.${req.rawBody}`;
          const secretWithoutPrefix = YOCO_WEBHOOK_SECRET.substring('whsec_'.length);
          const secretBytes = Buffer.from(secretWithoutPrefix, 'base64');
 
          const calculatedSignature = crypto
              .createHmac('sha256', secretBytes)
              .update(signedContent)
              .digest('base64');
 
          const signatureHeaderValue = yocoSignatureHeader;
          let signatureFromHeader = null;
 
          if (signatureHeaderValue.startsWith('v1,')) {
             signatureFromHeader = signatureHeaderValue.substring('v1,'.length);
          } else {
             const signatureParts = signatureHeaderValue.split(',');
             for (const part of signatureParts) {
               if (part.startsWith('v1=')) {
                 signatureFromHeader = part.substring('v1='.length);
                 break;
               }
             }
          }
 
          if (!signatureFromHeader) {
             console.error("(Webhook) Could not extract 'v1' signature from webhook-signature header:", signatureHeaderValue);
             return res.status(400).send('Invalid signature header format (v1 signature not found).');
          }
 
          const calculatedSigBuffer = Buffer.from(calculatedSignature, 'base64');
          const headerSigBuffer = Buffer.from(signatureFromHeader, 'base64');
 
          if (calculatedSigBuffer.length !== headerSigBuffer.length) {
             console.error("(Webhook) Signature length mismatch. Calculated vs Header.");
             return res.status(403).send('Invalid signature (length mismatch).');
          }
 
          const isSignatureValid = crypto.timingSafeEqual(calculatedSigBuffer, headerSigBuffer);
 
        if (!isSignatureValid) {
                console.error("CRITICAL (Webhook): Invalid webhook signature.");
                return res.status(403).send('Invalid signature.'); // 403 Forbidden
           }