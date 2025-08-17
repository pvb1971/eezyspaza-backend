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

const YOCO_API_SECRET_KEY = process.env.YOCO_SECRET_KEY;
const YOCO_WEBHOOK_SECRET = process.env.YOCO_WEBHOOK_SECRET;
const YOCO_CHECKOUT_API_URL = 'https://payments.yoco.com/api/checkouts';

// Helper function to log incoming requests
app.use((req, res, next) => {
   console.log(`INCOMING REQUEST: ${req.method} ${req.originalUrl}`);
   next();
});

// ========================================================================= //
// == YOCO CHECKOUT CREATION ROUTE                                         == //
// ========================================================================= //
app.post('/create-checkout', express.json(), async (req, res) => {
   console.log("-----> /create-checkout ROUTE HIT! <-----");
   
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
   
       await db.collection('orders').doc(newOrderFirebaseId).update({
           checkoutId: yocoCheckoutId
       });
       console.log(`Updated Firebase order with Yoco checkoutId: ${yocoCheckoutId}`);
   
       res.json({
           success: true,
           redirectUrl: checkoutData.redirectUrl,
           checkoutId: yocoCheckoutId
       });
   } catch (error) {
       console.error('Error creating Yoco checkout:', error.response ? error.response.data : error.message);
       
       if (newOrderFirebaseId) {
           await db.collection('orders').doc(newOrderFirebaseId).update({
               status: 'checkout_failed',
               errorMessage: error.response ? JSON.stringify(error.response.data) : error.message
           }).catch(e => console.error("Error updating order status after Yoco failure:", e));
       }
       
       res.status(error.response?.status || 500).json({
           success: false,
           message: 'Failed to create checkout with Yoco.',
           details: error.response?.data || { error: error.message }
       });
   }
});

// ========================================================================= //
// == YOCO WEBHOOK RECEIVER (SERVER-TO-SERVER PAYMENT CONFIRMATION)       == //
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
       console.log("RAW WEBHOOK BODY:", req.rawBody ? req.rawBody.toString() : "No raw body found.");
       console.log("PARSED WEBHOOK BODY:", req.body ? JSON.stringify(req.body, null, 2) : "No parsed body found.");

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
          
          // Webhook Signature is valid - proceed to process the payload
          const event = req.body;
          const eventType = event.type;
          const payload = event.payload;

          const orderIdFromMetadata = payload.metadata ? payload.metadata.firebase_order_id : null;
          const paymentId = payload.id;
          
          console.log(`(Webhook) Processing event type: ${eventType}. Firebase Order ID: ${orderIdFromMetadata}.`);
          
          if (orderIdFromMetadata && paymentId) {
             const orderRef = db.collection('orders').doc(orderIdFromMetadata);
             
             if (eventType === 'payment.succeeded') {
                 
                 // --- NEW INVENTORY LOGIC START ---
                 const items = JSON.parse(webhookData.payload.metadata.items);
                 
                 await db.runTransaction(async (transaction) => {
                     const orderDoc = await transaction.get(orderRef);
                     if (orderDoc.data().status === 'payment_succeeded') {
                         console.log(`(Webhook) Order ${orderIdFromMetadata} already processed. Skipping inventory update.`);
                         return;
                     }
                     
          for (const item of orderItems) {
   const productRef = db.collection('products').doc(item.id);
   const productDoc = await transaction.get(productRef);
   
   if (!productDoc.exists) {
      throw new Error(`Product with ID ${item.id} not found in inventory.`);
   }

   const productData = productDoc.data();
   // --- NEW CODE ADDED HERE ---
   if (!productData || typeof productData.quantity === 'undefined') {
      throw new Error(`Product with ID ${item.id} is missing a 'quantity' field.`);
   }
   // --- END NEW CODE ---
   
   const currentStock = productData.quantity;
   const newStock = currentStock - item.quantity;
   
   if (newStock < 0) {
      throw new Error(`Insufficient stock for product ${item.id}.`);
   }
   
   transaction.update(productRef, { quantity: newStock });
   console.log(`(Webhook) Updated stock for product ${item.id} from ${currentStock} to ${newStock}.`);
}
                     
                     // Update the order status inside the transaction to ensure atomicity
                     transaction.update(orderRef, {
                         yocoPaymentId: paymentId,
                         status: 'payment_succeeded',
                         updatedAt: admin.firestore.FieldValue.serverTimestamp()
                     });
                 });
                 console.log(`(Webhook) Inventory and order updated for order ${orderIdFromMetadata}.`);
                 // --- NEW INVENTORY LOGIC END ---
 
             } else if (eventType === 'payment.failed' || eventType === 'payment.cancelled') {
                 await orderRef.update({
                     yocoPaymentId: paymentId,
                     status: 'payment_failed',
                     updatedAt: admin.firestore.FieldValue.serverTimestamp()
                 });
                 console.log(`(Webhook) Updated order ${orderIdFromMetadata} to 'payment_failed'.`);
             }
          }
          
          // Always send a 200 OK to Yoco to acknowledge receipt
          res.status(200).send('Webhook received and processed.');
 
       } catch (error) {
          console.error("Webhook processing error:", error.message);
          res.status(500).send('Webhook processing error.');
       }
   }
);

// Health check endpoint
app.get('/health', (req, res) => {
   res.status(200).send('OK');
});

// Start the server
app.listen(port, () => {
   console.log(`EazySpaza Backend Server running on port ${port}. Waiting for requests...`);
   console.log(`Node Environment: ${process.env.NODE_ENV || 'development'}`);
   if (YOCO_API_SECRET_KEY) {
       const isTestKey = YOCO_API_SECRET_KEY.startsWith('sk_test_');
       console.log(`YOCO_SECRET_KEY (API Secret for calls TO Yoco) is configured: ${YOCO_API_SECRET_KEY.substring(0, 15)}... (${isTestKey ? 'TEST API key' : 'PRODUCTION API key'})`);
       if (isTestKey) {
           console.log("INFO: Using TEST Yoco key. Transactions will be simulated.");
       }
   } else {
       console.warn("WARNING: YOCO_SECRET_KEY is not configured.");
   }
   if (YOCO_WEBHOOK_SECRET) {
       console.log(`YOCO_WEBHOOK_SECRET (Webhook Signing Secret for calls FROM Yoco) is configured: ${YOCO_WEBHOOK_SECRET.substring(0, 15)}...`);
   } else {
       console.warn("WARNING: YOCO_WEBHOOK_SECRET is not configured.");
   }
});