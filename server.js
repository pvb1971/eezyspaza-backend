import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import crypto from "crypto";
import admin from "firebase-admin";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
// Use bodyParser.json() for most routes
app.use(bodyParser.json());

// Firebase Admin init
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("Firebase Admin initialized successfully.");
  } catch (error) {
    console.error("Error initializing Firebase Admin:", error.message);
    // You might want to prevent the server from starting if Firebase can't init
    process.exit(1);
  }
}
const db = admin.firestore();

// Create checkout
app.post("/create-checkout", async (req, res) => {
  console.log("Received /create-checkout request:", req.body);
  try {
    // Expect amount (in ZAR), items array, and potentially other order details from the client
    const { amount, items, customer_name, firebase_order_id_from_app } = req.body;

    if (!amount || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Missing required fields: amount and items array." });
    }

    // You might create an order document in Firestore *before* calling Yoco,
    // or pass enough metadata for the webhook to create/update it.
    // Let's assume you pass a pre-generated firebase_order_id from the app, or generate one here.
    // For simplicity, using the one passed from the app if available, or generating one.
    const orderIdForYoco = firebase_order_id_from_app || db.collection("temp_orders").doc().id; // Using a temp ID if not provided by app initially

    // Store initial order details or ensure they are passed to Yoco metadata
    // This example assumes the webhook will handle the full order creation/update
    // based on metadata.

    const amountInCents = Math.round(parseFloat(amount) * 100);

    const yocoPayload = {
      amount: amountInCents, // Yoco typically expects amount in cents
      currency: "ZAR",
      metadata: {
        firebase_order_id: orderIdForYoco, // This ID will be used by the webhook
        items: JSON.stringify(items.map(item => ({ id: item.id, name: item.name, quantity: item.quantity, price: item.price }))), // Stringify items for metadata
        customer_name: customer_name || "Valued Customer",
        // Add any other relevant metadata
      },
      payment_type: "card", // Or other supported types
      // For redirect flow, successUrl and cancelUrl are key
      // THESE ARE ALREADY CORRECTLY USING HTTPS
      success_url: `https://eezyspaza-backend1.onrender.com/yoco-payment-success?orderId=${orderIdForYoco}&status=success`,
      cancel_url: `https://eezyspaza-backend1.onrender.com/yoco-payment-cancel?orderId=${orderIdForYoco}&status=cancelled`,
      failure_url: `https://eezyspaza-backend1.onrender.com/yoco-payment-failure?orderId=${orderIdForYoco}&status=failed`, // Good to have a failure URL too
    };

    console.log("Sending payload to Yoco:", JSON.stringify(yocoPayload, null, 2));

    // IMPORTANT: Verify this is the correct Yoco endpoint for initiating an online redirect checkout.
    // It's often something like 'https://online.yoco.com/v1/checkout/online/'
    // The '/charges/' endpoint might be for different types of transactions.
    // Consult Yoco documentation for the "Online Payments Redirect" flow.
    const response = await fetch("https://online.yoco.com/v1/checkout/online/", { // EXAMPLE ENDPOINT - VERIFY!
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.YOCO_SECRET_KEY}`, // Ensure this is your SECRET key
        "Content-Type": "application/json",
      },
      body: JSON.stringify(yocoPayload),
    });

    const responseText = await response.text(); // Get raw response text for debugging
    console.log("Yoco Raw Response Status:", response.status);
    console.log("Yoco Raw Response Text:", responseText);

    if (!response.ok) {
      let errorData;
      try {
        errorData = JSON.parse(responseText);
      } catch (e) {
        errorData = { message: "Failed to parse Yoco error response", details: responseText };
      }
      console.error("Error from Yoco API:", errorData);
      return res.status(response.status).json({ error: "Failed to create Yoco checkout", details: errorData });
    }

    const data = JSON.parse(responseText);

    // The key from Yoco for redirect is often 'redirect_url' or 'url' in the response
    // Check Yoco's documentation for the exact response structure.
    if (!data.redirect_url && !data.url) {
        console.error("Yoco response did not contain a redirect URL:", data);
        return res.status(500).json({ error: "Yoco did not return a redirect URL." });
    }

    // Send the redirect URL back to the client app
    res.json({ checkoutUrl: data.redirect_url || data.url });

  } catch (error) {
    console.error("Error in /create-checkout endpoint:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});


// Webhook - Using bodyParser.raw for signature verification
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  console.log("INCOMING WEBHOOK REQUEST: POST /webhook");
  const sig = req.headers["yoco-signature"];
  const payload = req.body.toString(); // req.body is a Buffer here

  if (!process.env.YOCO_WEBHOOK_SECRET) {
    console.error("⚠️ YOCO_WEBHOOK_SECRET is not set. Cannot verify signature.");
    return res.status(500).send("Webhook secret not configured.");
  }
  if(!sig){
    console.warn("⚠️ Webhook request missing yoco-signature header.");
    return res.status(400).send("Missing signature.");
  }

  const expectedSig = crypto
    .createHmac("sha256", process.env.YOCO_WEBHOOK_SECRET)
    .update(payload)
    .digest("hex");

  if (sig !== expectedSig) {
    console.warn(`⚠️ Webhook signature mismatch. Expected: ${expectedSig}, Got: ${sig}`);
    return res.status(400).send("Invalid signature");
  }

  console.log("✅ Webhook signature verified.");

  let event;
  try {
    event = JSON.parse(payload);
  } catch (err) {
    console.error("Webhook JSON parsing error:", err.message);
    return res.status(400).send("Invalid JSON payload");
  }

  console.log(`(Webhook) Processing event type: ${event.type}. Event ID: ${event.id}`);
  // console.log("(Webhook) Full event payload:", JSON.stringify(event, null, 2));


  // In your server.js - within the app.post("/webhook", ...) route

// ... (after signature verification and event parsing) ...

if (event.type === "payment.succeeded") {
    const paymentPayload = event.payload;
    const firebaseOrderId = paymentPayload.metadata?.firebase_order_id;
    const itemsString = paymentPayload.metadata?.items;

    // ... (your existing checks for firebaseOrderId and itemsString) ...

    let items;
    try {
        items = JSON.parse(itemsString);
        if (!Array.isArray(items)) throw new Error("Items metadata is not an array.");
    } catch (e) {
        console.error(`(Webhook) Error parsing items metadata for order ${firebaseOrderId}: ${e.message}. Items string: ${itemsString}`);
        return res.status(400).send("Invalid items format in metadata");
    }

    console.log(`(Webhook) Attempting Firestore transaction for order: ${firebaseOrderId}`);
    try {
        await db.runTransaction(async (transaction) => {
            console.log(`(Webhook) [TXN_START] Order: ${firebaseOrderId}`);

            // --- PHASE 1: ALL READS ---
            console.log(`(Webhook) [TXN_READ] Getting order document: ${firebaseOrderId}`);
            const orderRef = db.collection("orders").doc(firebaseOrderId);
            const orderDoc = await transaction.get(orderRef);

            // Prepare product reads
            const productReadOperations = [];
            for (const item of items) {
                if (!item.id || typeof item.quantity === 'undefined') {
                    console.warn(`(Webhook) [TXN_INFO] Order ${firebaseOrderId}: Item missing id or quantity, skipping stock update for:`, item);
                    continue;
                }
                const productRef = db.collection("products").doc(String(item.id));
                productReadOperations.push({
                    ref: productRef,
                    id: String(item.id),
                    quantitySold: parseInt(item.quantity, 10)
                });
            }
            
            let productDocsSnapshots = [];
            if (productReadOperations.length > 0) {
                console.log(`(Webhook) [TXN_READ] Getting ${productReadOperations.length} product documents for order ${firebaseOrderId}.`);
                const refsToGetAll = productReadOperations.map(op => op.ref);
                productDocsSnapshots = await transaction.getAll(...refsToGetAll);
            } else {
                console.log(`(Webhook) [TXN_INFO] Order ${firebaseOrderId}: No valid items with ID and quantity for stock update.`);
            }

            console.log(`(Webhook) [TXN_READ_COMPLETE] All reads finished for order ${firebaseOrderId}.`);

            // --- PHASE 2: ALL WRITES ---
            console.log(`(Webhook) [TXN_WRITE_START] Starting writes for order ${firebaseOrderId}.`);

            // 1. Update/Set Order Document
            if (!orderDoc.exists) {
                console.log(`(Webhook) [TXN_WRITE] Order ${firebaseOrderId} not found, creating new document.`);
                transaction.set(orderRef, {
                    yocoPaymentId: paymentPayload.id,
                    yocoCheckoutId: paymentPayload.metadata?.checkoutId,
                    amount: paymentPayload.amount / 100,
                    currency: paymentPayload.currency,
                    status: "paid",
                    items: items, // Store parsed items from metadata
                    customerName: paymentPayload.metadata?.customer_name,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(), // Set only on creation
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    webhookEventId: event.id
                });
            } else {
                console.log(`(Webhook) [TXN_WRITE] Updating existing order ${firebaseOrderId}. Current status: ${orderDoc.data().status}`);
                transaction.update(orderRef, {
                    status: "paid",
                    yocoPaymentId: paymentPayload.id,
                    paymentStatusYoco: paymentPayload.status,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    webhookEventId: event.id
                });
            }
            console.log(`(Webhook) [TXN_WRITE] Order ${firebaseOrderId} status processed.`);

            // 2. Update Product Stocks
            for (let i = 0; i < productDocsSnapshots.length; i++) {
                const productDocSnapshot = productDocsSnapshots[i];
                const operation = productReadOperations.find(op => op.ref.path === productDocSnapshot.ref.path); // Find corresponding operation data

                if (!operation) {
                    console.warn(`(Webhook) [TXN_WRITE_WARN] Could not find original operation for product snapshot: ${productDocSnapshot.id}`);
                    continue;
                }
                
                const { ref: productRef, id: productId, quantitySold } = operation;

                if (!productDocSnapshot.exists) {
                    console.warn(`(Webhook) [TXN_WRITE_WARN] Product with ID ${productId} (order ${firebaseOrderId}) not found during write phase. Stock not updated.`);
                    continue;
                }

                const productData = productDocSnapshot.data();
                const currentStock = productData.stock;

                if (typeof currentStock !== 'number') {
                    console.warn(`(Webhook) [TXN_WRITE_WARN] Product ${productId} (order ${firebaseOrderId}) has invalid stock value: ${currentStock}. Stock not updated.`);
                    continue;
                }

                const newStock = currentStock - quantitySold;
                console.log(`(Webhook) [TXN_WRITE] Updating stock for product ${productId} (order ${firebaseOrderId}): from ${currentStock} to ${newStock}.`);
                transaction.update(productRef, { stock: newStock });
            }
            console.log(`(Webhook) [TXN_WRITE_COMPLETE] All writes finished for order ${firebaseOrderId}.`);
        }); // End of db.runTransaction

        console.log(`(Webhook) Firestore transaction SUCCEEDED for order ${firebaseOrderId}.`);
        res.json({ received: true, processed: true, message: "Payment processed successfully." });

    } catch (transactionError) {
        console.error(`(Webhook) Firestore transaction FAILED for order ${firebaseOrderId}:`, transactionError.message);
        // Log the full error for more details if needed
        // console.error(transactionError); 
        res.status(500).send(`Error processing payment update in database: ${transactionError.message}`);
    }
} else {
    // ... your existing handling for other event types ...
    console.log(`(Webhook) Event type ${event.type} not handled.`);
    res.json({ received: true, processed: false, message: `Event type ${event.type} not handled.` });
}
 });
// Success page
app.get("/yoco-payment-success", (req, res) => {
  const orderId = req.query.orderId || "unknown";
  const status = req.query.status || "success"; // Get status from query
  console.log(`Serving /yoco-payment-success page for Order ID: ${orderId}, Status: ${status}`);
  res.send(`
    <html>
    <head>
      <title>Payment Successful</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; padding: 20px; box-sizing: border-box; }
        h1 { color: #4CAF50; }
        p { font-size: 1.2em; }
        .button-container { margin-top: 20px; }
        .app-button { padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; font-size: 1em; }
      </style>
    </head>
    <body>
      <h1>✅ Payment Successful!</h1>
      <p>Your order (ID: ${orderId}) has been processed.</p>
      <p>Thank you for your purchase.</p>
      <div class="button-container">
        <!-- This button can be styled to look more like a native app button -->
        <a href="eezyspaza://payment-complete?status=success&orderId=${orderId}" class="app-button">Return to App</a>
      </div>
      <script>
        // For direct communication if WebView is still active and from your app
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
          console.log('Posting message to ReactNativeWebView: paymentSuccess');
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: "paymentSuccess",
            orderId: "${orderId}",
            status: "success"
          }));
        } else {
            console.log('ReactNativeWebView not available for postMessage.');
        }

        // Attempt to redirect via deep link after a short delay
        // This is a fallback if postMessage doesn't work or if the user landed here directly.
        setTimeout(function() {
            // Check if the app is likely installed before trying to open the deep link
            // This is a very basic check; more robust checks are complex.
            // For now, just attempt the redirect.
            console.log('Attempting deep link redirect to eezyspaza://payment-complete');
            window.location.href = "eezyspaza://payment-complete?status=success&orderId=${orderId}";
        }, 1500); // 1.5 second delay
      </script>
    </body>
    </html>
  `);
});

// Cancel page
app.get("/yoco-payment-cancel", (req, res) => {
  const orderId = req.query.orderId || "unknown";
  console.log(`Serving /yoco-payment-cancel page for Order ID: ${orderId}`);
  res.status(200).send(`
    <html>
    <head><title>Payment Cancelled</title><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>body { font-family: sans-serif; text-align: center; padding-top: 50px; } h1 { color: #f44336; }</style></head>
    <body><h1>❌ Payment Cancelled</h1><p>Your payment for order ID ${orderId} was cancelled.</p>
    <a href="eezyspaza://payment-complete?status=cancelled&orderId=${orderId}">Return to App</a>
    <script>
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: "paymentCancel", orderId: "${orderId}", status: "cancelled" }));
      }
      setTimeout(function() { window.location.href = "eezyspaza://payment-complete?status=cancelled&orderId=${orderId}"; }, 1500);
    </script>
    </body></html>`);
});

// Failure page (Good to have)
app.get("/yoco-payment-failure", (req, res) => {
    const orderId = req.query.orderId || "unknown";
    console.log(`Serving /yoco-payment-failure page for Order ID: ${orderId}`);
    res.status(200).send(`
    <html>
    <head><title>Payment Failed</title><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>body { font-family: sans-serif; text-align: center; padding-top: 50px; } h1 { color: #f44336; }</style></head>
    <body><h1>❗ Payment Failed</h1><p>There was an issue with your payment for order ID ${orderId}. Please try again or contact support.</p>
    <a href="eezyspaza://payment-complete?status=failed&orderId=${orderId}">Return to App</a>
    <script>
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: "paymentFailure", orderId: "${orderId}", status: "failed" }));
      }
       setTimeout(function() { window.location.href = "eezyspaza://payment-complete?status=failed&orderId=${orderId}"; }, 1500);
    </script>
    </body></html>`);
});


// Start server
app.listen(PORT, () => {
  console.log(`EazySpaza Backend running on port ${PORT}`);
  console.log(`Service accessible at: https://eezyspaza-backend1.onrender.com (if deployed) or http://localhost:${PORT} (locally)`);
});
