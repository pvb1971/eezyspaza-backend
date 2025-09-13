// server.js
// SERVER.JS VERSION: 2025-09-13-18:30:00 - FIXED ITEMS EXTRACTION FROM METADATA

import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import crypto from "crypto";
import admin from "firebase-admin";
import fs from 'fs';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// Firebase Initialization (unchanged)
if (!admin.apps.length) {
    try {
        const serviceAccountPath = '/etc/secrets/firebase-service-account-key.json';
        console.log(`[Firebase Init] Attempting to load service account. Preferred path: ${serviceAccountPath}`);
        if (fs.existsSync(serviceAccountPath)) {
            console.log(`[Firebase Init] Service account file found at ${serviceAccountPath}. Reading and parsing...`);
            const serviceAccountJsonString = fs.readFileSync(serviceAccountPath, 'utf8');
            const serviceAccount = JSON.parse(serviceAccountJsonString);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
            });
            console.log("Firebase Admin initialized successfully using Secret File.");
        } else {
            console.warn(`[Firebase Init] Secret file NOT found at ${serviceAccountPath}.`);
            console.warn("[Firebase Init] Attempting fallback to FIREBASE_SERVICE_ACCOUNT environment variable.");
            const serviceAccountStringFromEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
            if (serviceAccountStringFromEnv && serviceAccountStringFromEnv.trim() !== "" && serviceAccountStringFromEnv !== "undefined") {
                console.log("[Firebase Init] Fallback: Found FIREBASE_SERVICE_ACCOUNT environment variable. Parsing...");
                const serviceAccountFromEnv = JSON.parse(serviceAccountStringFromEnv);
                admin.initializeApp({
                    credential: admin.credential.cert(serviceAccountFromEnv),
                });
                console.log("Firebase Admin initialized successfully using FIREBASE_SERVICE_ACCOUNT environment variable (fallback).");
            } else {
                console.error(`[Firebase Init] CRITICAL FAILURE: Service account file NOT found at ${serviceAccountPath} AND FIREBASE_SERVICE_ACCOUNT env var is not set or is invalid.`);
                process.exit(1);
            }
        }
    } catch (error) {
        console.error("[Firebase Init] CRITICAL ERROR during Firebase Admin initialization:", error.message, error);
        if (error instanceof SyntaxError) {
            console.error("[Firebase Init] This often means the service account JSON (from file or env var) is malformed or not valid JSON.");
        }
        process.exit(1);
    }
}
const db = admin.firestore();

// Updated /create-checkout Endpoint
app.post("/create-checkout", async (req, res) => {
    console.log("-----> /create-checkout ROUTE HIT! Version 2025-09-13-18:30:00 <-----");
    try {
        console.log("[Server /create-checkout] Received req.body:", JSON.stringify(req.body, null, 2));
        const { amount, currency, successUrl, cancelUrl, failureUrl, metadata } = req.body;

        // Validate top-level fields
        if (!amount || (typeof amount !== 'string' && typeof amount !== 'number') || amount.toString().trim() === "") {
            console.error("[Server /create-checkout] Validation FAILED: Missing or invalid amount:", amount);
            return res.status(400).json({ error: "Amount is required and must be a non-empty string or number." });
        }
        if (!currency || typeof currency !== 'string' || currency.trim() === "") {
            console.error("[Server /create-checkout] Validation FAILED: Missing or invalid currency:", currency);
            return res.status(400).json({ error: "Currency is required and must be a non-empty string." });
        }
        if (!successUrl || !cancelUrl || !failureUrl) {
            console.error("[Server /create-checkout] Validation FAILED: Missing URLs:", { successUrl, cancelUrl, failureUrl });
            return res.status(400).json({ error: "Success, cancel, and failure URLs are required." });
        }
        if (!metadata || typeof metadata !== 'object') {
            console.error("[Server /create-checkout] Validation FAILED: Missing or invalid metadata:", metadata);
            return res.status(400).json({ error: "Metadata is required and must be an object." });
        }

        // Extract and validate items from metadata
        const { items, order_reference, customer_name } = metadata;
        let parsedItems = items;
        if (!items || (typeof items === 'string' && items.trim() === "") || (Array.isArray(items) && items.length === 0)) {
            console.error("[Server /create-checkout] Validation FAILED: Missing or invalid items in metadata:", items);
            return res.status(400).json({ error: "Items in metadata are required and must be a non-empty array or valid JSON string." });
        }

        // Parse items if string
        if (typeof items === 'string') {
            try {
                parsedItems = JSON.parse(items);
                console.log("[Server /create-checkout] Parsed stringified 'items' from metadata to array:", parsedItems);
            } catch (e) {
                console.error("[Server /create-checkout] Failed to parse 'items' string from metadata:", e.message);
                return res.status(400).json({ error: "Invalid items format in metadata: must be a valid JSON array" });
            }
        }

        // Validate parsed items
        if (!Array.isArray(parsedItems) || parsedItems.length === 0) {
            console.error("[Server /create-checkout] Validation FAILED: Parsed items is not a non-empty array:", parsedItems);
            return res.status(400).json({ error: "Items in metadata must be a non-empty array." });
        }

        console.log("[Server /create-checkout] Extracted 'amount':", amount, "Items:", `${parsedItems.length} items`);

        // Generate or use provided order ID
        const orderIdForYoco = order_reference || db.collection("orders").doc().id;
        console.log("[Server /create-checkout] Using orderIdForYoco:", orderIdForYoco);

        // Convert amount to cents
        const parsedAmountFloat = parseFloat(amount);
        console.log("[Server /create-checkout] Parsed client amount to float:", parsedAmountFloat);
        if (isNaN(parsedAmountFloat) || parsedAmountFloat <= 0) {
            console.error("[Server /create-checkout] Invalid amount after parsing: float is NaN or zero/negative:", parsedAmountFloat);
            return res.status(400).json({ error: "Amount must be a positive number." });
        }

        const amountInCents = Math.round(parsedAmountFloat * 100);
        console.log("[Server /create-checkout] Converted to cents:", amountInCents);
        if (amountInCents <= 0) {
            console.error("[Server /create-checkout] amountInCents is zero or negative:", amountInCents);
            return res.status(400).json({ error: "Calculated amount for Yoco is invalid (must be > 0 cents)." });
        }

        // Validate YOCO_SECRET_KEY
        if (!process.env.YOCO_SECRET_KEY) {
            console.error("[Server /create-checkout] YOCO_SECRET_KEY is not set.");
            return res.status(500).json({ error: "Server configuration error: Yoco secret key missing." });
        }

        // Construct Yoco payload
        const yocoPayload = {
            amount: amountInCents,
            currency: currency,
            metadata: {
                order_reference: orderIdForYoco,
                customer_name: customer_name || "Valued Customer",
                items: JSON.stringify(parsedItems.map(item => ({
                    id: String(item.id),
                    name: item.name || "Unknown Item",
                    quantity: parseInt(item.quantity) || 1,
                    price: String(item.price || "0")
                }))),
            },
            paymentType: "card",
            successUrl: successUrl,
            cancelUrl: cancelUrl,
            failureUrl: failureUrl,
        };
        console.log("[Server /create-checkout] Sending to Yoco:", JSON.stringify(yocoPayload, null, 2));

        // Make Yoco API request
        console.log("[Server /create-checkout] Calling Yoco API (https://online.yoco.com/v1/checkouts/).");
        const yocoApiResponse = await fetch("https://online.yoco.com/v1/checkouts/", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.YOCO_SECRET_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(yocoPayload),
        });

        const yocoResponseText = await yocoApiResponse.text();
        console.log("[Server /create-checkout] Yoco API Response Status:", yocoApiResponse.status);
        console.log("[Server /create-checkout] Yoco API Response Text:", yocoResponseText);

        if (!yocoApiResponse.ok) {
            let errorDataFromYoco;
            try {
                errorDataFromYoco = JSON.parse(yocoResponseText);
            } catch (e) {
                errorDataFromYoco = { message: "Failed to parse Yoco error response.", details: yocoResponseText };
            }
            console.error("[Server /create-checkout] Error from Yoco API:", JSON.stringify(errorDataFromYoco, null, 2));
            return res.status(yocoApiResponse.status).json({
                error: "Failed to create Yoco checkout",
                yoco_status: yocoApiResponse.status,
                yoco_message: errorDataFromYoco.message || "Unknown Yoco error",
                yoco_details: errorDataFromYoco
            });
        }

        const dataFromYoco = JSON.parse(yocoResponseText);
        const redirectUrl = dataFromYoco.redirectUrl;
        if (!redirectUrl) {
            console.error("[Server /create-checkout] Yoco response missing redirectUrl:", dataFromYoco);
            return res.status(500).json({ error: "Yoco did not return a redirect URL." });
        }

        // Store order details in Firebase
        try {
            const orderRef = db.collection("orders").doc(orderIdForYoco);
            await orderRef.set({
                amount: parsedAmountFloat,
                amountInCents: amountInCents,
                currency: currency,
                items: parsedItems,
                customerName: customer_name || "Valued Customer",
                status: "pending",
                yocoCheckoutId: dataFromYoco.id,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
            console.log("[Server /create-checkout] Stored order in Firebase:", orderIdForYoco);
        } catch (firebaseError) {
            console.error("[Server /create-checkout] Failed to store order in Firebase:", firebaseError.message);
            return res.status(500).json({ error: "Failed to store order in database", details: firebaseError.message });
        }

        console.log("[Server /create-checkout] Success: Redirect URL from Yoco:", redirectUrl);
        res.status(200).json({ checkoutUrl: redirectUrl });

    } catch (error) {
        console.error("[Server /create-checkout] Unexpected Error:", error.message, error.stack);
        res.status(500).json({ error: "Internal server error in /create-checkout", message: error.message });
    }
});

// Webhook and other endpoints (unchanged, except for metadata.order_reference)
const rawBodyWebhookParser = bodyParser.raw({ type: "application/json" });
app.post("/webhook", rawBodyWebhookParser, async (req, res) => {
    console.log("-----> /webhook ROUTE HIT! Version 2025-09-13-18:30:00 <-----");
    console.log("(Webhook) INCOMING WEBHOOK REQUEST: POST /webhook");
    const sig = req.headers["yoco-signature"];

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
            .update(payloadString)
            .digest("hex");

        if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
            console.warn(`⚠️ (Webhook) Signature mismatch. Expected: ${expectedSig}, Got: ${sig}.`);
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

    if (event.type === "payment.succeeded") {
        const paymentPayload = event.payload;
        const firebaseOrderId = paymentPayload.metadata?.order_reference;
        const itemsString = paymentPayload.metadata?.items;

        if (!firebaseOrderId) {
            console.error("(Webhook) 'order_reference' missing in payment metadata for event:", event.id);
            return res.status(400).send("Missing order_reference in metadata.");
        }
        if (!itemsString) {
            console.warn(`(Webhook) 'items' string missing in payment metadata for order ${firebaseOrderId}, event ${event.id}. Stock will not be updated.`);
        }

        let items = [];
        if (itemsString) {
            try {
                items = JSON.parse(itemsString);
                if (!Array.isArray(items)) {
                    console.warn(`(Webhook) Parsed 'items' for order ${firebaseOrderId} is not an array. Stock will not be updated. Items string: ${itemsString}`);
                    items = [];
                }
            } catch (e) {
                console.error(`(Webhook) Error parsing 'items' metadata for order ${firebaseOrderId}: ${e.message}. Stock will not be updated. Items string: ${itemsString}`);
                items = [];
            }
        }

        console.log(`(Webhook) Attempting Firestore transaction for order: ${firebaseOrderId}`);
        try {
            await db.runTransaction(async (transaction) => {
                console.log(`(Webhook) [TXN_START] Order: ${firebaseOrderId}`);
                const orderRef = db.collection("orders").doc(firebaseOrderId);
                console.log(`(Webhook) [TXN_DEBUG] Attempting GET for order: ${orderRef.path}`);
                const orderDoc = await transaction.get(orderRef);
                console.log(`(Webhook) [TXN_DEBUG] Completed GET for order: ${orderRef.path}. Exists: ${orderDoc.exists}`);

                const productReadOperations = [];
                if (items.length > 0) {
                    for (const item of items) {
                        if (!item.id || typeof item.quantity === 'undefined' || parseInt(item.quantity) <= 0) {
                            console.warn(`(Webhook) [TXN_INFO] Order ${firebaseOrderId}: Item missing id, quantity, or quantity is zero/invalid. Skipping stock update for:`, item);
                            continue;
                        }
                        const productRef = db.collection("products").doc(String(item.id));
                        productReadOperations.push({ ref: productRef, id: String(item.id), quantitySold: parseInt(item.quantity, 10) });
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

                console.log(`(Webhook) [TXN_WRITE_START] Starting writes for order ${firebaseOrderId}.`);
                const orderWriteData = {
                    yocoPaymentId: paymentPayload.id,
                    yocoCheckoutId: paymentPayload.metadata?.checkoutId,
                    amount: paymentPayload.amount / 100,
                    currency: paymentPayload.currency,
                    status: "paid",
                    items: items,
                    customerName: paymentPayload.metadata?.customer_name || "Valued Customer",
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    webhookEventId: event.id,
                    paymentStatusYoco: paymentPayload.status
                };

                if (!orderDoc.exists) {
                    console.log(`(Webhook) [TXN_WRITE] Order ${firebaseOrderId} not found, creating new document.`);
                    orderWriteData.createdAt = admin.firestore.FieldValue.serverTimestamp();
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
                            console.warn(`(Webhook) [TXN_WRITE_WARN] Could not find original operation for product snapshot: ${productDocSnapshot.id} for order ${firebaseOrderId}. Skipping stock update.`);
                            continue;
                        }
                        const { ref: productRef, id: productId, quantitySold } = operation;
                        if (!productDocSnapshot.exists) {
                            console.warn(`(Webhook) [TXN_WRITE_WARN] Product ${productId} (order ${firebaseOrderId}) not found in DB during write phase. Stock not updated.`);
                            continue;
                        }
                        const productData = productDocSnapshot.data();
                        const currentStock = productData.stock;
                        if (typeof currentStock !== 'number' || isNaN(currentStock)) {
                            console.warn(`(Webhook) [TXN_WRITE_WARN] Product ${productId} (order ${firebaseOrderId}) has invalid stock value in DB: '${currentStock}'. Stock not updated.`);
                            continue;
                        }
                        const newStock = currentStock - quantitySold;
                        console.log(`(Webhook) [TXN_WRITE] Stock update for product ${productId} (order ${firebaseOrderId}): from ${currentStock} to ${newStock}. Sold: ${quantitySold}`);
                        console.log(`(Webhook) [TXN_DEBUG] Attempting UPDATE on product: ${productRef.path} with new stock: ${newStock}`);
                        transaction.update(productRef, { stock: newStock, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                        console.log(`(Webhook) [TXN_DEBUG] Enqueued UPDATE on product: ${productRef.path}`);
                    }
                }
                console.log(`(Webhook) [TXN_WRITE_COMPLETE] All writes finished for order ${firebaseOrderId}.`);
            });
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

app.get("/yoco-payment-success", (req, res) => {
    const orderId = req.query.orderId || "unknown";
    const status = req.query.status || "success";
    console.log(`Serving /yoco-payment-success page for Order ID: ${orderId}, Status: ${status}`);
    res.send(`<html><head><title>Payment Successful</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; padding: 20px; box-sizing: border-box; } h1 { color: #4CAF50; } p { font-size: 1.2em; } .button-container { margin-top: 20px; } .app-button { padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; font-size: 1em; }</style></head><body><h1>✅ Payment Successful!</h1><p>Your order (ID: ${orderId}) has been processed.</p><p>Thank you for your purchase.</p><div class="button-container"><a href="eezyspaza://payment-complete?status=success&orderId=${orderId}" class="app-button">Return to App</a></div><script>console.log('Success page script running for order: ${orderId}'); if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) { console.log('Posting message to ReactNativeWebView: paymentSuccess'); window.ReactNativeWebView.postMessage(JSON.stringify({type: "paymentSuccess", orderId: "${orderId}",status: "success"})); } else { console.log('ReactNativeWebView not available for postMessage on success page.'); } setTimeout(function() { console.log('Attempting deep link redirect from success page to eezyspaza://payment-complete'); window.location.href = "eezyspaza://payment-complete?status=success&orderId=${orderId}"; }, 1500);</script></body></html>`);
});

app.get("/yoco-payment-cancel", (req, res) => {
    const orderId = req.query.orderId || "unknown";
    console.log(`Serving /yoco-payment-cancel page for Order ID: ${orderId}`);
    res.status(200).send(`<html><head><title>Payment Cancelled</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body { font-family: sans-serif; text-align: center; padding-top: 50px; } h1 { color: #f44336; }</style></head><body><h1>❌ Payment Cancelled</h1><p>Your payment for order ID ${orderId} was cancelled.</p><a href="eezyspaza://payment-complete?status=cancelled&orderId=${orderId}">Return to App</a><script>console.log('Cancel page script running for order: ${orderId}'); if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) { window.ReactNativeWebView.postMessage(JSON.stringify({ type: "paymentCancel", orderId: "${orderId}", status: "cancelled" }));} setTimeout(function() { console.log('Attempting deep link redirect from cancel page.'); window.location.href = "eezyspaza://payment-complete?status=cancelled&orderId=${orderId}"; }, 1500);</script></body></html>`);
});

app.get("/yoco-payment-failure", (req, res) => {
    const orderId = req.query.orderId || "unknown";
    console.log(`Serving /yoco-payment-failure page for Order ID: ${orderId}`);
    res.status(200).send(`<html><head><title>Payment Failed</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body { font-family: sans-serif; text-align: center; padding-top: 50px; } h1 { color: #f44336; }</style></head><body><h1>❗ Payment Failed</h1><p>There was an issue with your payment for order ID ${orderId}. Please try again or contact support.</p><a href="eezyspaza://payment-complete?status=failed&orderId=${orderId}">Return to App</a><script>console.log('Failure page script running for order: ${orderId}'); if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) { window.ReactNativeWebView.postMessage(JSON.stringify({ type: "paymentFailure", orderId: "${orderId}", status: "failed" }));} setTimeout(function() { console.log('Attempting deep link redirect from failure page.'); window.location.href = "eezyspaza://payment-complete?status=failed&orderId=${orderId}"; }, 1500);</script></body></html>`);
});

app.listen(PORT, () => {
    console.log(`EazySpaza Backend Server running on port ${PORT}. Node Environment: ${process.env.NODE_ENV || 'development'}`);
    if (process.env.YOCO_SECRET_KEY && process.env.YOCO_SECRET_KEY.startsWith('sk_test_')) {
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
