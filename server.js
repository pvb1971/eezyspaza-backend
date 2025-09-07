// At the VERY TOP of server.js (after imports, before any other code)
console.log("SERVER.JS VERSION: 2025-09-07-05:30:00 - DEPLOYED AND RUNNING"); // Replace YOUR_TIME_HERE

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
app.use(bodyParser.json()); // Use bodyParser.json() for routes that expect JSON (like /create-checkout)

// Firebase Admin init
if (!admin.apps.length) {
  try {
    const serviceAccountString = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!serviceAccountString) {
        console.error("FIREBASE_SERVICE_ACCOUNT environment variable is not set or is empty.");
        process.exit(1);
    }
    const serviceAccount = JSON.parse(serviceAccountString);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("Firebase Admin initialized successfully.");
  } catch (error) {
    console.error("Error initializing Firebase Admin:", error.message, error);
    // Log the problematic string if parsing failed (be careful with sensitive data in logs)
    // console.error("Problematic FIREBASE_SERVICE_ACCOUNT string (first 100 chars):", process.env.FIREBASE_SERVICE_ACCOUNT ? process.env.FIREBASE_SERVICE_ACCOUNT.substring(0, 100) : "Not set");
    process.exit(1);
  }
}
const db = admin.firestore();

// Create checkout
app.post("/create-checkout", async (req, res) => {
  console.log("-----> /create-checkout ROUTE HIT! Version 2025-09-07-YOUR_TIME_HERE <-----"); // Match top-level version

  try {
    console.log("[Server /create-checkout] Received req.body:", JSON.stringify(req.body, null, 2));

    const { amount, items, customer_name, firebase_order_id_from_app } = req.body;
    console.log("[Server /create-checkout] Extracted 'amount' from req.body:", amount);
    console.log("[Server /create-checkout] Extracted 'items' from req.body:", items ? `${items.length} items` : "items not found/undefined");

    if (!amount || typeof amount !== 'string' || amount.trim() === "" || // Ensure amount is a non-empty string
        !items || !Array.isArray(items) || items.length === 0) {
      console.error("[Server /create-checkout] Validation FAILED: Missing or invalid required fields. Amount:", amount, "Items:", items);
      return res.status(400).json({ error: "Missing required fields: amount (string) and items array (non-empty)." });
    }
    console.log("[Server /create-checkout] Initial validation passed (amount and items presence).");

    const orderIdForYoco = firebase_order_id_from_app || db.collection("orders").doc().id; // Use 'orders' or a temp collection

    const parsedAmountFloat = parseFloat(amount);
    console.log("[Server /create-checkout] Parsed client amount to float:", parsedAmountFloat);

    if (isNaN(parsedAmountFloat) || parsedAmountFloat <= 0) {
        console.error("[Server /create-checkout] Invalid amount after parsing: float is NaN or zero/negative.", parsedAmountFloat);
        return res.status(400).json({ error: "Invalid amount provided. Amount must be a positive number." });
    }

    const amountInCents = Math.round(parsedAmountFloat * 100);
    console.log("[Server /create-checkout] Calculated amountInCents for Yoco:", amountInCents);

    if (amountInCents <= 0) {
        console.error("[Server /create-checkout] amountInCents is zero or negative after rounding:", amountInCents);
        return res.status(400).json({ error: "Calculated amount for Yoco is invalid (must be > 0 cents)." });
    }

    const yocoPayload = {
      amount: amountInCents,
      currency: "ZAR", // This is hardcoded
      metadata: {
        firebase_order_id: orderIdForYoco,
        items: JSON.stringify(items.map(item => ({
            id: String(item.id), // Ensure IDs are strings
            name: item.name,
            quantity: parseInt(item.quantity), // Ensure quantity is int
            price: String(item.price) // Ensure price is string
        }))),
        customer_name: customer_name || "Valued Customer",
      },
      payment_type: "card",
      success_url: `https://eezyspaza-backend1.onrender.com/yoco-payment-success?orderId=${orderIdForYoco}&status=success`,
      cancel_url: `https://eezyspaza-backend1.onrender.com/yoco-payment-cancel?orderId=${orderIdForYoco}&status=cancelled`,
      failure_url: `https://eezyspaza-backend1.onrender.com/yoco-payment-failure?orderId=${orderIdForYoco}&status=failed`,
    };
    console.log("[Server /create-checkout] CONSTRUCTED yocoPayload TO SEND to Yoco:", JSON.stringify(yocoPayload, null, 2));

    console.log("[Server /create-checkout] About to call Yoco API (https://online.yoco.com/v1/checkout/online/).");
    const yocoApiResponse = await fetch("https://online.yoco.com/v1/checkout/online/", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.YOCO_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(yocoPayload),
    });

    const yocoResponseText = await yocoApiResponse.text();
    console.log("[Server /create-checkout] Yoco API Raw Response Status:", yocoApiResponse.status);
    console.log("[Server /create-checkout] Yoco API Raw Response Text:", yocoResponseText);

    if (!yocoApiResponse.ok) {
      let errorDataFromYoco;
      try {
        errorDataFromYoco = JSON.parse(yocoResponseText);
      } catch (e) {
        errorDataFromYoco = { message: "Failed to parse Yoco error response or Yoco returned non-JSON error.", details: yocoResponseText };
      }
      console.error("[Server /create-checkout] Error from Yoco API:", JSON.stringify(errorDataFromYoco, null, 2));
      // Send Yoco's error message back to the client if possible
      return res.status(yocoApiResponse.status).json(
        errorDataFromYoco.success === false ? errorDataFromYoco : {
            error: "Failed to create Yoco checkout",
            yoco_status: yocoApiResponse.status,
            yoco_message: errorDataFromYoco.message || "See Yoco details",
            yoco_details: errorDataFromYoco
        }
      );
    }

    const dataFromYoco = JSON.parse(yocoResponseText);

    if (!dataFromYoco.redirect_url && !dataFromYoco.url) {
        console.error("[Server /create-checkout] Yoco response OK but did not contain a redirect URL:", dataFromYoco);
        return res.status(500).json({ error: "Yoco did not return a redirect URL." });
    }
    const redirectUrl = dataFromYoco.redirect_url || dataFromYoco.url;
    console.log("[Server /create-checkout] Successfully received redirect URL from Yoco:", redirectUrl);
    res.json({ checkoutUrl: redirectUrl });

  } catch (error) {
    console.error("[Server /create-checkout] CAUGHT UNEXPECTED Error in /create-checkout endpoint:", error);
    res.status(500).json({ error: "Internal server error in /create-checkout", details: error.message });
  }
});


// Webhook - Using bodyParser.raw for signature verification
// Place this BEFORE app.use(bodyParser.json()) if you have specific raw body needs for one route
// and JSON for others. Or define it like this if it's the only raw consumer.
// However, since app.use(bodyParser.json()) is global, we need to handle this carefully.
// The common pattern is to define raw body parsing specifically for the webhook route.
const rawBodyWebhookParser = bodyParser.raw({ type: "application/json" });

app.post("/webhook", rawBodyWebhookParser, async (req, res) => {
  console.log("-----> /webhook ROUTE HIT! Version 2025-09-07-YOUR_TIME_HERE <-----"); // Match top-level version
  console.log("INCOMING WEBHOOK REQUEST: POST /webhook");
  const sig = req.headers["yoco-signature"];

  // req.body should be a Buffer due to bodyParser.raw
  if (!Buffer.isBuffer(req.body)) {
      console.error("(Webhook) Error: req.body is not a Buffer. Check bodyParser configuration for /webhook.");
      return res.status(500).send("Webhook internal server error: Invalid body type.");
  }
  const payloadString = req.body.toString();

  if (!process.env.YOCO_WEBHOOK_SECRET) {
    console.error("⚠️ (Webhook) YOCO_WEBHOOK_SECRET is not set. Cannot verify signature.");
    return res.status(500).send("Webhook secret not configured.");
  }
  if (!sig) {
    console.warn("⚠️ (Webhook) Request missing yoco-signature header.");
    return res.status(400).send("Missing signature.");
  }

  try {
    const expectedSig = crypto
      .createHmac("sha256", process.env.YOCO_WEBHOOK_SECRET)
      .update(payloadString) // Use the string form of the payload for HMAC
      .digest("hex");

    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
      console.warn(`⚠️ (Webhook) Signature mismatch. Expected: ${expectedSig}, Got: ${sig}. Payload string: ${payloadString}`);
      return res.status(400).send("Invalid signature");
    }
  } catch(hmacError) {
      console.error("⚠️ (Webhook) Error during signature verification:", hmacError);
      return res.status(500).send("Error during signature verification.");
  }

  console.log("✅ (Webhook) Signature verified.");

  let event;
  try {
    event = JSON.parse(payloadString);
  } catch (err) {
    console.error("(Webhook) JSON parsing error:", err.message, "Raw payload string:", payloadString);
    return res.status(400).send("Invalid JSON payload");
  }

  console.log(`(Webhook) Processing event type: ${event.type}. Event ID: ${event.id}`);
  // console.log("(Webhook) Full event payload:", JSON.stringify(event, null, 2));

  if (event.type === "payment.succeeded") {
    const paymentPayload = event.payload;
    const firebaseOrderId = paymentPayload.metadata?.firebase_order_id;
    const itemsString = paymentPayload.metadata?.items;

    if (!firebaseOrderId) {
        console.error("(Webhook) 'firebase_order_id' missing in payment metadata for event:", event.id);
        return res.status(400).send("Missing firebase_order_id in metadata.");
    }
    if (!itemsString) {
        console.warn(`(Webhook) 'items' string missing in payment metadata for order ${firebaseOrderId}, event ${event.id}. Stock will not be updated.`);
        // Decide if this is a fatal error or if order status can still be updated.
        // For now, proceeding to update order status but skipping stock.
    }

    let items = []; // Default to empty array if itemsString is missing
    if (itemsString) {
        try {
            items = JSON.parse(itemsString);
            if (!Array.isArray(items)) {
                console.warn(`(Webhook) Parsed 'items' for order ${firebaseOrderId} is not an array. Items string: ${itemsString}. Stock will not be updated.`);
                items = []; // Reset to empty if not an array
            }
        } catch (e) {
            console.error(`(Webhook) Error parsing 'items' metadata for order ${firebaseOrderId}: ${e.message}. Items string: ${itemsString}. Stock will not be updated.`);
            items = []; // Reset to empty on error
        }
    }

    console.log(`(Webhook) Attempting Firestore transaction for order: ${firebaseOrderId}`);
    try {
        await db.runTransaction(async (transaction) => {
            console.log(`(Webhook) [TXN_START] Order: ${firebaseOrderId}`);

            // --- PHASE 1: ALL READS ---
            console.log(`(Webhook) [TXN_DEBUG] Attempting GET for order: orders/${firebaseOrderId}`);
            const orderRef = db.collection("orders").doc(firebaseOrderId);
            const orderDoc = await transaction.get(orderRef);
            console.log(`(Webhook) [TXN_DEBUG] Completed GET for order: orders/${firebaseOrderId}. Exists: ${orderDoc.exists}`);

            const productReadOperations = [];
            if (items.length > 0) { // Only attempt product reads if items array is valid and populated
                for (const item of items) {
                    if (!item.id || typeof item.quantity === 'undefined' || parseInt(item.quantity) <= 0) {
                        console.warn(`(Webhook) [TXN_INFO] Order ${firebaseOrderId}: Item missing id, quantity, or quantity is zero/invalid. Skipping stock update for:`, item);
                        continue;
                    }
                    const productRef = db.collection("products").doc(String(item.id));
                    productReadOperations.push({
                        ref: productRef,
                        id: String(item.id),
                        quantitySold: parseInt(item.quantity, 10)
                    });
                }
            } else {
                 console.log(`(Webhook) [TXN_INFO] Order ${firebaseOrderId}: No valid items for stock processing.`);
            }

            let productDocsSnapshots = [];
            if (productReadOperations.length > 0) {
                console.log(`(Webhook) [TXN_READ] Getting ${productReadOperations.length} product documents for order ${firebaseOrderId}.`);
                const refsToGetAll = productReadOperations.map(op => op.ref);
                productDocsSnapshots = await transaction.getAll(...refsToGetAll);
                console.log(`(Webhook) [TXN_DEBUG] Completed GETALL for ${productDocsSnapshots.length} products.`);
            } else {
                console.log(`(Webhook) [TXN_INFO] Order ${firebaseOrderId}: No product read operations prepared for stock update.`);
            }

            console.log(`(Webhook) [TXN_READ_COMPLETE] All reads finished for order ${firebaseOrderId}.`);

            // --- PHASE 2: ALL WRITES ---
            console.log(`(Webhook) [TXN_WRITE_START] Starting writes for order ${firebaseOrderId}.`);

            const orderWriteData = {
                yocoPaymentId: paymentPayload.id,
                yocoCheckoutId: paymentPayload.metadata?.checkoutId,
                amount: paymentPayload.amount / 100, // Assuming Yoco amount is in cents
                currency: paymentPayload.currency,
                status: "paid", // Consistent status
                items: items, // Store the parsed (and potentially validated) items array
                customerName: paymentPayload.metadata?.customer_name || "Valued Customer",
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                webhookEventId: event.id,
                paymentStatusYoco: paymentPayload.status // Store Yoco's status too
            };

            if (!orderDoc.exists) {
                console.log(`(Webhook) [TXN_WRITE] Order ${firebaseOrderId} not found, creating new document.`);
                orderWriteData.createdAt = admin.firestore.FieldValue.serverTimestamp(); // Set only on creation
                console.log(`(Webhook) [TXN_DEBUG] Attempting SET on order: ${orderRef.path}`);
                transaction.set(orderRef, orderWriteData);
                console.log(`(Webhook) [TXN_DEBUG] Enqueued SET on order: ${orderRef.path}`);
            } else {
                console.log(`(Webhook) [TXN_WRITE] Updating existing order ${firebaseOrderId}. Current Firestore status: ${orderDoc.data()?.status}`);
                console.log(`(Webhook) [TXN_DEBUG] Attempting UPDATE on order: ${orderRef.path}`);
                transaction.update(orderRef, orderWriteData);
                console.log(`(Webhook) [TXN_DEBUG] Enqueued UPDATE on order: ${orderRef.path}`);
            }
            console.log(`(Webhook) [TXN_WRITE] Order ${firebaseOrderId} status processed.`);

            if (productDocsSnapshots.length > 0) {
                for (let i = 0; i < productDocsSnapshots.length; i++) {
                    const productDocSnapshot = productDocsSnapshots[i];
                    const operation = productReadOperations.find(op => op.ref.path === productDocSnapshot.ref.path);

                    if (!operation) {
                        console.warn(`(Webhook) [TXN_WRITE_WARN] Could not find original operation for product snapshot: ${productDocSnapshot.id} for order ${firebaseOrderId}. Skipping stock update for this item.`);
                        continue;
                    }

                    const { ref: productRef, id: productId, quantitySold } = operation;

                    if (!productDocSnapshot.exists) {
                        console.warn(`(Webhook) [TXN_WRITE_WARN] Product with ID ${productId} (order ${firebaseOrderId}) not found in DB during write phase. Stock not updated.`);
                        continue;
                    }

                    const productData = productDocSnapshot.data();
                    const currentStock = productData.stock;

                    if (typeof currentStock !== 'number' || isNaN(currentStock)) {
                        console.warn(`(Webhook) [TXN_WRITE_WARN] Product ${productId} (order ${firebaseOrderId}) has invalid stock value in DB: '${currentStock}'. Stock not updated.`);
                        continue;
                    }

                    const newStock = currentStock - quantitySold;
                    console.log(`(Webhook) [TXN_WRITE] Stock update for product ${productId} (order ${firebaseOrderId}): from ${currentStock} to ${newStock}. Quantity sold: ${quantitySold}`);

                    console.log(`(Webhook) [TXN_DEBUG] Attempting UPDATE on product: ${productRef.path} with new stock: ${newStock}`);
                    transaction.update(productRef, { stock: newStock, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                    console.log(`(Webhook) [TXN_DEBUG] Enqueued UPDATE on product: ${productRef.path}`);
                }
            }
            console.log(`(Webhook) [TXN_WRITE_COMPLETE] All writes finished for order ${firebaseOrderId}.`);
        }); // End of db.runTransaction

        console.log(`(Webhook) Firestore transaction SUCCEEDED for order ${firebaseOrderId}.`);
        res.status(200).json({ received: true, processed: true, message: "Payment processed and order updated successfully." });

    } catch (transactionError) {
        console.error(`(Webhook) Firestore transaction FAILED for order ${firebaseOrderId}:`, transactionError.message, transactionError);
        res.status(500).send(`Webhook Error: Error processing payment update in database: ${transactionError.message}`);
    }
} else {
    console.log(`(Webhook) Event type ${event.type} received but not handled. Event ID: ${event.id}`);
    res.status(200).json({ received: true, processed: false, message: `Event type ${event.type} not handled.` });
}
});

// Success page
app.get("/yoco-payment-success", (req, res) => {
  const orderId = req.query.orderId || "unknown";
  const status = req.query.status || "success";
  console.log(`Serving /yoco-payment-success page for Order ID: ${orderId}, Status: ${status}`);
  // (Your HTML for success page as before)
  res.send(`
    <html><head><title>Payment Successful</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; padding: 20px; box-sizing: border-box; } h1 { color: #4CAF50; } p { font-size: 1.2em; } .button-container { margin-top: 20px; } .app-button { padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; font-size: 1em; }</style></head>
    <body><h1>✅ Payment Successful!</h1><p>Your order (ID: ${orderId}) has been processed.</p><p>Thank you for your purchase.</p><div class="button-container"><a href="eezyspaza://payment-complete?status=success&orderId=${orderId}" class="app-button">Return to App</a></div>
    <script>
      console.log('Success page script running for order: ${orderId}');
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        console.log('Posting message to ReactNativeWebView: paymentSuccess');
        window.ReactNativeWebView.postMessage(JSON.stringify({type: "paymentSuccess", orderId: "${orderId}",status: "success"}));
      } else { console.log('ReactNativeWebView not available for postMessage on success page.'); }
      setTimeout(function() { console.log('Attempting deep link redirect from success page to eezyspaza://payment-complete'); window.location.href = "eezyspaza://payment-complete?status=success&orderId=${orderId}"; }, 1500);
    </script></body></html>`);
});

// Cancel page
app.get("/yoco-payment-cancel", (req, res) => {
  const orderId = req.query.orderId || "unknown";
  console.log(`Serving /yoco-payment-cancel page for Order ID: ${orderId}`);
  // (Your HTML for cancel page as before)
  res.status(200).send(`
    <html><head><title>Payment Cancelled</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body { font-family: sans-serif; text-align: center; padding-top: 50px; } h1 { color: #f44336; }</style></head>
    <body><h1>❌ Payment Cancelled</h1><p>Your payment for order ID ${orderId} was cancelled.</p><a href="eezyspaza://payment-complete?status=cancelled&orderId=${orderId}">Return to App</a>
    <script>
      console.log('Cancel page script running for order: ${orderId}');
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) { window.ReactNativeWebView.postMessage(JSON.stringify({ type: "paymentCancel", orderId: "${orderId}", status: "cancelled" }));}
      setTimeout(function() { console.log('Attempting deep link redirect from cancel page.'); window.location.href = "eezyspaza://payment-complete?status=cancelled&orderId=${orderId}"; }, 1500);
    </script></body></html>`);
});

// Failure page
app.get("/yoco-payment-failure", (req, res) => {
    const orderId = req.query.orderId || "unknown";
    console.log(`Serving /yoco-payment-failure page for Order ID: ${orderId}`);
    // (Your HTML for failure page as before)
    res.status(200).send(`
    <html><head><title>Payment Failed</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body { font-family: sans-serif; text-align: center; padding-top: 50px; } h1 { color: #f44336; }</style></head>
    <body><h1>❗ Payment Failed</h1><p>There was an issue with your payment for order ID ${orderId}. Please try again or contact support.</p><a href="eezyspaza://payment-complete?status=failed&orderId=${orderId}">Return to App</a>
    <script>
      console.log('Failure page script running for order: ${orderId}');
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) { window.ReactNativeWebView.postMessage(JSON.stringify({ type: "paymentFailure", orderId: "${orderId}", status: "failed" }));}
       setTimeout(function() { console.log('Attempting deep link redirect from failure page.'); window.location.href = "eezyspaza://payment-complete?status=failed&orderId=${orderId}"; }, 1500);
    </script></body></html>`);
});

// Start server
app.listen(PORT, () => {
  console.log(`EazySpaza Backend Server running on port ${PORT}. Node Environment: ${process.env.NODE_ENV || 'development'}`);
  if(process.env.YOCO_SECRET_KEY && process.env.YOCO_SECRET_KEY.startsWith('sk_test_')) {
    console.log("INFO: Using TEST Yoco key. Transactions will be simulated.");
  } else if (process.env.YOCO_SECRET_KEY) {
    console.log("INFO: Using LIVE Yoco key. Transactions will be REAL.");
  } else {
    console.warn("WARNING: YOCO_SECRET_KEY is not set. Yoco integration will fail.");
  }
  if (!process.env.YOCO_WEBHOOK_SECRET) {
      console.warn("WARNING: YOCO_WEBHOOK_SECRET is not set. Webhook signature verification will fail.");
  }
  console.log(`Service accessible at: https://eezyspaza-backend1.onrender.com (if deployed) or http://localhost:${PORT} (locally)`);
});
