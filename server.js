// server.js
const express = require('express');
const axios = require('axios'); // For making HTTP requests from backend to Yoco
const cors = require('cors');
const app = express();
const port = process.env.PORT || 3000;

// --- IMPORTANT: Store your Secret Key securely AS AN ENVIRONMENT VARIABLE ---
// On Render.com, set YOCO_SECRET_KEY in your service's environment settings.
const YOCO_LIVE_SECRET_KEY = process.env.YOCO_SECRET_KEY;

// Middleware
app.use(cors({ origin: '*' })); // Allows requests from any origin (your WebView)
app.use(express.json());       // Parses incoming JSON request bodies
app.use(express.urlencoded({ extended: true })); // Parses URL-encoded bodies

// Simple logging middleware for all requests
app.use((req, res, next) => {
    console.log(`INCOMING REQUEST: ${req.method} ${req.originalUrl}`);
    if (Object.keys(req.body).length > 0) {
        console.log('Request Body:', req.body);
    }
    next();
});

// --- Test Route ---
app.get('/', (req, res) => {
    res.send('EazySpaza Backend is alive and running!');
});


// --- Yoco "Create Checkout" Route (Older Redirect Flow) ---
// This route might be for a different Yoco integration flow.
const YOCO_CHECKOUT_API_URL = 'https://online.yoco.com/v1/checkout/online/';

app.post('/create-checkout', async (req, res) => {
    console.log("-----> /create-checkout ROUTE HIT! (Redirect Flow) <-----");
    const { amount, currency = 'ZAR', successUrl, cancelUrl, failureUrl, metadata, customer } = req.body;

    if (!amount || parseFloat(amount) < 2) {
        return res.status(400).json({ error: 'Amount must be at least R2.00' });
    }
    if (!YOCO_LIVE_SECRET_KEY) { // Check if the key is loaded from env
        console.error("CRITICAL: YOCO_SECRET_KEY environment variable is not configured for /create-checkout.");
        return res.status(500).json({ error: 'Server configuration error for payments.' });
    }

    try {
        const payload = {
            amount: Math.round(parseFloat(amount) * 100), // Convert to cents
            currency,
            success_url: successUrl || 'file:///android_asset/success.html',
            cancel_url: cancelUrl || 'file:///android_asset/checkout.html',
            failure_url: failureUrl || 'file:///android_asset/failure.html',
            metadata: metadata || {},
            customer: customer || undefined
        };
        console.log("Sending to Yoco /create-checkout:", payload);

        const response = await axios.post(YOCO_CHECKOUT_API_URL, payload, {
            headers: {
                'Authorization': `Bearer ${YOCO_LIVE_SECRET_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const { id, redirect_url } = response.data;
        console.log('Yoco Checkout created (for redirect flow):', { id, redirect_url });
        res.json({ id, redirectUrl: redirect_url });

    } catch (error) {
        console.error('Error creating Yoco redirect checkout:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        res.status(error.response?.status || 500).json({ error: 'Failed to create Yoco redirect checkout' });
    }
});


// --- NEW: Yoco "Finalize Payment" Route (For Frontend SDK Token Flow) ---
// This is the endpoint your pay-now.js is trying to reach.
app.post('/finalize-yoco-payment', async (req, res) => {
    console.log("-----> /finalize-yoco-payment ROUTE HIT! (SDK Token Flow) <-----");
    const { yocoToken, orderAmount } = req.body;

    if (!yocoToken || !orderAmount) {
        console.error("Missing yocoToken or orderAmount in /finalize-yoco-payment request body");
        return res.status(400).json({ success: false, message: "Missing yocoToken or orderAmount from frontend." });
    }

    if (!YOCO_LIVE_SECRET_KEY) { // Check if the key is loaded from env
        console.error("CRITICAL: YOCO_SECRET_KEY environment variable is not configured for /finalize-yoco-payment.");
        return res.status(500).json({ success: false, message: 'Server configuration error for payment verification.' });
    }

    try {
        console.log(`Received for Yoco verification: token='${yocoToken}', expectedAmount='${orderAmount}'`);

        // --- Use Yoco Payment Request API endpoint (as per your latest finding) ---
        const yocoVerificationUrl = `https://online.yoco.com/api/v1/paymentRequests/${yocoToken}`;
        console.log(`Calling Yoco Server API to verify payment request: ${yocoVerificationUrl}`);

        let yocoPaymentRequestData;
        try {
            const yocoApiResponse = await axios.get(yocoVerificationUrl, {
                headers: {
                    'Authorization': `Bearer ${YOCO_LIVE_SECRET_KEY}`
                }
            });
            yocoPaymentRequestData = yocoApiResponse.data;
            // Log the entire response to understand its structure
            console.log("Yoco Server API Response (Payment Request Verification):", JSON.stringify(yocoPaymentRequestData, null, 2));

        } catch (yocoApiError) {
            console.error("Error calling Yoco Server API to verify payment request:",
                yocoApiError.response ? JSON.stringify(yocoApiError.response.data, null, 2) : yocoApiError.message);

            let errorMessage = "Failed to verify payment with Yoco.";
            if (yocoApiError.response && yocoApiError.response.data) {
                 // Try to get a specific message if Yoco provides one
                errorMessage = yocoApiError.response.data.message || yocoApiError.response.data.title || JSON.stringify(yocoApiError.response.data);
            } else if (yocoApiError.response && yocoApiError.response.status === 404) {
                errorMessage = "Payment token not found or invalid with Yoco.";
            } else if (yocoApiError.response && yocoApiError.response.status === 401) {
                errorMessage = "Authentication error with Yoco. Check server secret key configuration.";
            }
            return res.status(yocoApiError.response?.status || 500).json({ success: false, message: errorMessage });
        }

        // --- Process Yoco's Verification Response ---
        // IMPORTANT: Adjust the checks below based on the actual structure of yocoPaymentRequestData
        // Check your console.log output for "Yoco Server API Response (Payment Request Verification)"
        // to see the actual field names for ID, status, and amount.

        const expectedAmountInCents = Math.round(parseFloat(orderAmount) * 100);

        // Example: Assuming the response has fields like 'id', 'state', 'amount'
        // YOU MUST VERIFY THESE FIELD NAMES FROM YOUR LOGGED YOCO RESPONSE
        const paymentIdFromYoco = yocoPaymentRequestData.id;
        const paymentStatusFromYoco = yocoPaymentRequestData.state; // e.g., 'successful', 'complete', 'paid' - CHECK YOCO DOCS
        const paymentAmountFromYoco = yocoPaymentRequestData.amount; // Assuming this is in cents

        if (paymentIdFromYoco && paymentStatusFromYoco && paymentAmountFromYoco !== undefined) {
            if (paymentIdFromYoco === yocoToken &&
                (paymentStatusFromYoco.toLowerCase() === 'successful' || paymentStatusFromYoco.toLowerCase() === 'complete' || paymentStatusFromYoco.toLowerCase() === 'paid') // Be flexible with status strings
               ) {
                if (paymentAmountFromYoco === expectedAmountInCents) {
                    console.log("Yoco payment successfully verified. Token:", yocoToken, "Amount:", paymentAmountFromYoco / 100);

                    // --- PLACE #3: DATABASE INTEGRATION (Your Custom Logic) ---
                    // TODO: Save order to your database here
                    // If you have a database, this is where you would typically create an order record.
                    // Example with Mongoose (see previous detailed explanation):
                    // try {
                    //     const newOrder = new Order({ yocoChargeId: yocoToken, amount: paymentAmountFromYoco, ... });
                    //     const savedOrder = await newOrder.save();
                    //     const newOrderId = savedOrder._id.toString();
                    //     console.log("Order saved to database. Order ID:", newOrderId);
                    //     return res.json({ success: true, orderId: newOrderId, message: "Payment successfully verified and order processed." });
                    // } catch (dbError) { /* ... handle db error ... */ }
                    // --- END Database Example ---

                    // Current example Order ID (if no DB yet)
                    const newOrderId = "ORD_" + Date.now() + "_" + yocoToken.substring(yocoToken.length - 6);

                    console.log("Order processed successfully on backend. Order ID:", newOrderId);
                    return res.json({
                        success: true,
                        orderId: newOrderId,
                        message: "Payment successfully verified and processed by backend."
                    });
                } else {
                    console.error("Yoco payment verification: Amount mismatch.",
                                  "Expected (cents):", expectedAmountInCents,
                                  "Actual from Yoco (cents):", paymentAmountFromYoco);
                    return res.status(400).json({ success: false, message: "Payment amount mismatch after Yoco verification." });
                }
            } else {
                console.error("Yoco payment verification: Status not successful or ID mismatch.",
                              "Yoco Status:", paymentStatusFromYoco,
                              "Yoco ID Match:", paymentIdFromYoco === yocoToken);
                return res.status(400).json({
                    success: false,
                    message: `Payment not successful with Yoco (Status: ${paymentStatusFromYoco}) or ID mismatch.`
                });
            }
        } else {
             console.error("Yoco payment verification: Essential fields (id, state, amount) missing in Yoco's response.",
                           "Received data:", JSON.stringify(yocoPaymentRequestData, null, 2));
             return res.status(500).json({ success: false, message: "Invalid or incomplete response from Yoco verification service." });
        }

    } catch (error) {
        console.error("General error in /finalize-yoco-payment route:", error.message, error.stack);
        return res.status(500).json({ success: false, message: "Internal server error while finalizing payment." });
    }
});


// Catch-all for 404s for any other undefined routes
app.use((req, res, next) => {
    console.log(`404 Not Found: ${req.method} ${req.originalUrl} - No route defined.`);
    res.status(404).json({ success: false, message: `The requested URL ${req.originalUrl} was not found on this server.` });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error("Unhandled Error:", err.stack);
    res.status500().json({ success: false, message: 'Something broke on the server!' });
});


// Start the server
app.listen(port, () => {
    console.log(`EazySpaza Backend running on port ${port}. Waiting for requests...`);
    if (YOCO_LIVE_SECRET_KEY && YOCO_LIVE_SECRET_KEY.startsWith('sk_')) {
        console.log(`YOCO_SECRET_KEY is configured (using environment variable): ${YOCO_LIVE_SECRET_KEY.substring(0, 10)}...`);
    } else {
        console.warn("CRITICAL WARNING: YOCO_SECRET_KEY environment variable is NOT SET or is invalid. Payments WILL FAIL.");
    }
});
