// server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto'); // For webhook signature verification
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());

const YOCO_API_SECRET_KEY = process.env.YOCO_SECRET_KEY; // For API calls TO Yoco (e.g., sk_test_...)
const YOCO_WEBHOOK_SECRET = process.env.YOCO_WEBHOOK_SECRET; // For verifying webhooks FROM Yoco (e.g., whsec_...)
const YOCO_CHECKOUT_API_URL = 'https://payments.yoco.com/api/checkouts';

// Helper function to log incoming requests
app.use((req, res, next) => {
    console.log(`INCOMING REQUEST: ${req.method} ${req.originalUrl}`);
    next();
});

// ========================================================================= //
// == YOCO CHECKOUT CREATION ROUTE                                        == //
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

    const host = req.get('host');
    const protocol = req.protocol; // http or https
    const baseUrl = `${protocol}://${host}`;

    const payload = {
        amount: Math.round(parseFloat(amount) * 100),
        currency: currency,
        successUrl: `${baseUrl}/yoco-payment-success`,
        cancelUrl: `${baseUrl}/yoco-payment-cancel`,
        failureUrl: `${baseUrl}/yoco-payment-failure`,
        metadata: {
            ...metadata,
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
        console.log('Yoco Checkout created successfully:', JSON.stringify(checkoutData, null, 2));
        const yocoCheckoutId = checkoutData.id;

        console.log(`IMPORTANT: Received Yoco checkoutId [${yocoCheckoutId}] from Yoco.`);
        console.log(`ACTION REQUIRED: Store this checkoutId [${yocoCheckoutId}] with a 'pending_yoco_payment' status in your database.`);

        res.json({
            success: true,
            redirectUrl: checkoutData.redirectUrl,
            checkoutId: yocoCheckoutId
        });
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
});

// ========================================================================= //
// == YOCO REDIRECT SUCCESS/CANCEL/FAILURE ROUTES (USER FACING)           == //
// ========================================================================= //
function generateHtmlResponse(title, message, linkHref, linkText, type = "info", clearTrolley = false) {
    let titleColor = "#007bff";
    if (type === "success") titleColor = "#4CAF50";
    if (type === "warning") titleColor = "#ff9800";
    if (type === "error") titleColor = "#f44336";

    let clearTrolleyScript = '';
    if (clearTrolley) {
        clearTrolleyScript = `
            <script>
                try {
                    if (window.AndroidBridge && typeof window.AndroidBridge.clearTrolleyData === 'function') {
                        window.AndroidBridge.clearTrolleyData();
                        console.log('Called AndroidBridge.clearTrolleyData() from success page.');
                    } else {
                        localStorage.removeItem('trolley');
                        console.log('Trolley data cleared from localStorage (fallback on success page).');
                    }
                } catch (e) {
                    console.error("Error clearing trolley data via script on success page:", e);
                }
            </script>
        `;
    }
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title><style>body{font-family:Arial,sans-serif;margin:0;padding:20px;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:90vh;background-color:#f4f6f9;color:#333;text-align:center}.container{max-width:600px;background:#fff;padding:30px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.1);margin-top:20px}h1{color:${titleColor};margin-bottom:20px}p{margin-bottom:20px;line-height:1.6}a.button{display:inline-block;padding:12px 25px;background-color:#007bff;color:white;text-decoration:none;border-radius:5px;font-weight:bold;transition:background-color .3s}a.button:hover{background-color:#0056b3}.footer-text{font-size:12px;color:#777;margin-top:30px}</style></head><body><div class="container"><h1>${title}</h1><p>${message}</p><p><a href="${linkHref}" class="button">${linkText}</a></p><p class="footer-text">If not redirected, click above.</p></div>${clearTrolleyScript}</body></html>`;
}

app.get('/yoco-payment-success', (req, res) => {
    console.log("-----> /yoco-payment-success ROUTE HIT <-----");
    // console.log("Yoco Success Redirect Query Params:", JSON.stringify(req.query, null, 2));
    const msg = "Thank you! Your payment is being processed. We will confirm your order details shortly via the app. Your trolley will now be cleared.";
    res.send(generateHtmlResponse("Payment Initiated", msg, "file:///android_asset/groceries.html", "Continue Shopping", "success", true));
});

app.get('/yoco-payment-cancel', (req, res) => {
    console.log("-----> /yoco-payment-cancel ROUTE HIT <-----");
    // console.log("Yoco Cancel Redirect Query Params:", JSON.stringify(req.query, null, 2));
    const msg = "Your payment was cancelled. Your items are still in your trolley.";
    res.send(generateHtmlResponse("Payment Cancelled", msg, "file:///android_asset/trolley.html", "Return to Trolley", "warning"));
});

app.get('/yoco-payment-failure', (req, res) => {
    console.log("-----> /yoco-payment-failure ROUTE HIT <-----");
    // console.log("Yoco Failure Redirect Query Params:", JSON.stringify(req.query, null, 2));
    const msg = "Payment could not be processed. Please try again. Items are in trolley.";
    res.status(400).send(generateHtmlResponse("Payment Failed", msg, "file:///android_asset/trolley.html", "Return to Trolley & Try Again", "error"));
});


// ========================================================================= //
// == YOCO WEBHOOK RECEIVER (SERVER-TO-SERVER PAYMENT CONFIRMATION)       == //
// ========================================================================= //
app.post('/yoco-webhook-receiver',
    express.json({
        verify: (req, res, buf, encoding) => {
            // Save raw body buffer to req.rawBody for signature verification
            if (buf && buf.length) {
                req.rawBody = buf.toString(encoding || 'utf8');
                // console.log("Webhook rawBody captured by verify function.");
            } else {
                // console.log("Webhook verify function (rawBody): buffer empty or not present.");
            }
        }
    }),
    async (req, res) => {
        console.log("-----> FULL /yoco-webhook-receiver ROUTE HIT <-----");
        // console.log("Webhook Headers (Full Handler):", JSON.stringify(req.headers, null, 2));
        // console.log("Webhook Parsed Body (Full Handler):", JSON.stringify(req.body, null, 2));
        // console.log("Webhook Raw Body (Full Handler - first 200 chars):", req.rawBody ? req.rawBody.substring(0, 200) + "..." : "Not captured or empty");

        // --- 0. Check for Webhook Secret Configuration ---
        if (!YOCO_WEBHOOK_SECRET) {
            console.error("CRITICAL (Webhook): YOCO_WEBHOOK_SECRET environment variable is not set. Cannot verify signature.");
            // Send 500 but don't reveal details about secret to client
            return res.status(500).send('Server configuration error: Webhook processing unavailable.');
        }
        if (!YOCO_WEBHOOK_SECRET.startsWith('whsec_')) {
            console.error(`CRITICAL (Webhook): YOCO_WEBHOOK_SECRET format is incorrect. Expected 'whsec_...' but got '${YOCO_WEBHOOK_SECRET.substring(0,10)}...'`);
            return res.status(500).send('Server configuration error: Webhook secret format incorrect.');
        }

        // --- 1. Extract Necessary Headers ---
        const yocoWebhookId = req.headers['webhook-id'];
        const yocoTimestampHeader = req.headers['webhook-timestamp'];
        const yocoSignatureHeader = req.headers['webhook-signature'];

        if (!yocoWebhookId || !yocoTimestampHeader || !yocoSignatureHeader) {
            console.error("(Webhook) Missing one or more required Yoco headers: webhook-id, webhook-timestamp, or webhook-signature.");
            return res.status(400).send('Missing required Yoco webhook headers.');
        }
        // console.log(`Webhook Headers: ID='${yocoWebhookId}', Timestamp='${yocoTimestampHeader}', Signature='${yocoSignatureHeader.substring(0,20)}...'`);

// ... (previous part of /yoco-webhook-receiver route ending with header extraction)

        // --- 2. Verify Timestamp (Avoid Replay Attacks) ---
        const webhookTimestamp = parseInt(yocoTimestampHeader, 10);
        if (isNaN(webhookTimestamp)) {
            console.error("(Webhook) Invalid webhook-timestamp header format:", yocoTimestampHeader);
            return res.status(400).send('Invalid timestamp format.');
        }
        const currentTimestamp = Math.floor(Date.now() / 1000); // Current time in seconds
        const threeMinutesInSeconds = 3 * 60; // Yoco recommends a 3-minute tolerance

        if (Math.abs(currentTimestamp - webhookTimestamp) > threeMinutesInSeconds) {
            console.warn(`(Webhook) Timestamp [${webhookTimestamp}] outside tolerance compared to current time [${currentTimestamp}]. Possible replay or clock skew.`);
            // It's crucial to still respond with 200 OK to acknowledge receipt,
            // even if discarding the event due to age, to prevent Yoco from resending.
            // However, for an initial setup, let's be stricter to see if there are clock issues.
            // In production, you might log this and send 200, but not process.
            return res.status(400).send('Timestamp validation failed (outside tolerance).');
            // For production with 200 OK:
            // console.warn("Acknowledging with 200 OK but discarding due to age.");
            // return res.status(200).send('Webhook acknowledged (timestamp out of tolerance).');
        }
        // console.log("(Webhook) Timestamp validated.");

        // --- 3. Validate Signature ---
        try {
            if (!req.rawBody) {
                console.error("CRITICAL (Webhook): req.rawBody is not defined for signature verification. Ensure express.json({ verify: ... }) is correctly populating it.");
                // This indicates a server-side logic error in setting up the middleware.
                return res.status(500).send('Internal server error: Raw body missing for signature check.');
            }

            const signedContent = `${yocoWebhookId}.${yocoTimestampHeader}.${req.rawBody}`;
            // The webhook secret from Yoco dashboard already includes 'whsec_'
            // For HMAC, we need the actual secret part after 'whsec_' and base64 decoded.
            const secretWithoutPrefix = YOCO_WEBHOOK_SECRET.substring('whsec_'.length);
            const secretBytes = Buffer.from(secretWithoutPrefix, 'base64');

            const calculatedSignature = crypto
                .createHmac('sha256', secretBytes)
                .update(signedContent)
                .digest('base64');

            // Yoco's signature header format is typically "v1,SIGNATURE_VALUE"
            // Or potentially "v1=SIGNATURE_VALUE" or "v1=SIGNATURE_VALUE,vX=OTHER_SIGNATURE"
            // Let's make it more robust.

            const signatureHeaderValue = yocoSignatureHeader; // e.g., "v1,ActualBase64SignatureValue" or "v1=ActualBase64Value"
            let signatureFromHeader = null;

            // Option 1: Handle "v1,SIGNATURE"
            if (signatureHeaderValue.startsWith('v1,')) {
                signatureFromHeader = signatureHeaderValue.substring('v1,'.length);
            }
            // Option 2: Handle "v1=SIGNATURE" (and take the first one if multiple like "v1=SIG,v2=SIG2")
            else {
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
            // console.log("(Webhook) Extracted signature from header:", signatureFromHeader); // Good for debugging


            // Securely compare signatures using crypto.timingSafeEqual
            // Both buffers must be the same length for timingSafeEqual to work without error.
            const calculatedSigBuffer = Buffer.from(calculatedSignature, 'base64');
            const headerSigBuffer = Buffer.from(signatureFromHeader, 'base64');

            if (calculatedSigBuffer.length !== headerSigBuffer.length) {
                console.error("(Webhook) Signature length mismatch. Calculated vs Header.");
                // console.log("(Webhook) Calculated Signature (for debug):", calculatedSignature);
                // console.log("(Webhook) Signature from Header (for debug):", signatureFromHeader);
                return res.status(403).send('Invalid signature (length mismatch).');
            }

            const isSignatureValid = crypto.timingSafeEqual(calculatedSigBuffer, headerSigBuffer);

            if (!isSignatureValid) {
                console.error("CRITICAL (Webhook): Invalid webhook signature.");
                // For security, do not log expected vs received in production long-term.
                // console.log("(Webhook) Calculated Signature (for debug):", calculatedSignature);
                // console.log("(Webhook) Signature from Header (for debug):", signatureFromHeader);
                return res.status(403).send('Invalid signature.'); // 403 Forbidden
            }

            // console.log("(Webhook) Signature VERIFIED successfully!");

            // --- SIGNATURE IS VALID - PROCEED WITH PROCESSING ---
            const eventType = req.body.type;
            const eventPayload = req.body.payload; // This is the actual event data
            const eventId = req.body.id; // Yoco's event ID (e.g., evt_...)

            if (!eventType || !eventPayload) {
                console.error("(Webhook) Incomplete webhook payload from Yoco after signature validation. Missing type or payload.");
                return res.status(400).send('Incomplete payload after signature validation.');
            }

            console.log(`(Webhook) Received Yoco event: '${eventType}', Event ID: '${eventId}'`);
            const yocoCheckoutIdFromEvent = eventPayload.metadata?.checkoutId || eventPayload.checkout_id; // Yoco uses both sometimes
            const orderReferenceFromEvent = eventPayload.metadata?.order_reference;


            // --- Idempotency Check (Placeholder - Simple Check by Event ID) ---
            // In a real DB, you'd check if this eventId has already been processed.
            // For now, we'll just log.
            // Example:
            // if (await hasEventBeenProcessed(eventId)) {
            //     console.log(`(Webhook) Event ID '${eventId}' already processed. Acknowledging with 200 OK.`);
            //     return res.status(200).send('Webhook acknowledged (event already processed).');
            // }


            if (eventType === 'payment.succeeded') {
                const paymentAmount = eventPayload.amount; // in cents
                const currency = eventPayload.currency;
                const yocoPaymentId = eventPayload.id; // Yoco's payment transaction ID (e.g., p_...)

                if (!yocoCheckoutIdFromEvent) {
                    console.error("(Webhook 'payment.succeeded') received, but checkoutId missing in metadata/payload.");
                    // Still send 200 to Yoco to acknowledge receipt, but log this serious issue.
                    return res.status(200).send('Webhook received (acknowledged); checkoutId missing in payment.succeeded payload.');
                }

                console.log(`(Webhook) Payment Succeeded for Yoco Checkout ID: '${yocoCheckoutIdFromEvent}', Order Ref: '${orderReferenceFromEvent || 'N/A'}'`);
                console.log(`(Webhook) Yoco Payment ID: '${yocoPaymentId}', Amount: ${paymentAmount / 100} ${currency}`);
                console.log(`(Webhook) ACTION REQUIRED: Find order by 'yocoCheckoutId: ${yocoCheckoutIdFromEvent}' or 'order_reference: ${orderReferenceFromEvent}' in DB.`);
                console.log(`(Webhook) If order is 'pending_yoco_payment', update status to 'paid', store 'yocoPaymentId: ${yocoPaymentId}'. Trigger fulfillment.`);
                console.log(`(Webhook) Store eventId '${eventId}' to prevent reprocessing.`);

                // PSEUDO-CODE for Database Interaction:
                // try {
                //   const order = await db.findOrder({ yocoCheckoutId: yocoCheckoutIdFromEvent });
                //   if (order) {
                //     if (order.paymentStatus === 'pending_yoco_payment') {
                //       await db.updateOrder(order.id, {
                //         paymentStatus: 'paid',
                //         yocoPaymentId: yocoPaymentId,
                //         paymentAmountConfirmed: paymentAmount,
                //         paymentConfirmedDate: new Date(),
                //         lastWebhookEventId: eventId
                //       });
                //       console.log(`(Webhook) Order for checkoutId '${yocoCheckoutIdFromEvent}' successfully updated to PAID.`);
                //       // Trigger further actions: send confirmation email, notify fulfillment, etc.
                //     } else if (order.paymentStatus === 'paid' && order.yocoPaymentId === yocoPaymentId) {
                //       console.log(`(Webhook) Order for checkoutId '${yocoCheckoutIdFromEvent}' already marked PAID with this payment ID. Ignoring duplicate event.`);
                //     } else {
                //       console.warn(`(Webhook) Order for checkoutId '${yocoCheckoutIdFromEvent}' found, but status is '${order.paymentStatus}'. Needs review.`);
                //     }
                //   } else {
                //     console.error(`(Webhook) CRITICAL: Order not found for yocoCheckoutId '${yocoCheckoutIdFromEvent}'. Payment succeeded but cannot link to order.`);
                //   }
                //   await db.logProcessedEvent(eventId); // Mark event as processed
                // } catch (dbError) {
                //   console.error("(Webhook) Database error during payment.succeeded processing:", dbError);
                //   // Decide if you should retry (5xx) or not (200 if data is bad but event processed)
                //   return res.status(500).send('Internal error updating order status.');
                // }

            } else if (eventType === 'payment.failed') {
                const failureReason = eventPayload.failureReason || 'N/A'; // Yoco might provide this
                console.log(`(Webhook) Payment Failed for Yoco Checkout ID: '${yocoCheckoutIdFromEvent || 'N/A (checkoutId missing)'}', Order Ref: '${orderReferenceFromEvent || 'N/A'}'`);
                console.log(`(Webhook) Failure reason (if available): ${failureReason}`);
                console.log(`(Webhook) ACTION REQUIRED: Find order by 'yocoCheckoutId: ${yocoCheckoutIdFromEvent || 'N/A'}' in DB. Update status to 'payment_failed'.`);
                console.log(`(Webhook) Store eventId '${eventId}' to prevent reprocessing.`);

                // PSEUDO-CODE for Database Interaction:
                // try {
                //   if (yocoCheckoutIdFromEvent) {
                //     // Update order status, similar to success but to 'payment_failed'
                //   }
                //   await db.logProcessedEvent(eventId);
                // } catch (dbError) {
                //   console.error("(Webhook) Database error during payment.failed processing:", dbError);
                //   return res.status(500).send('Internal error updating order status to failed.');
                // }

            } else {
                console.log(`(Webhook) Received unhandled Yoco event type: '${eventType}'. Acknowledging.`);
                // Store eventId if you want to track all events
                // await db.logProcessedEvent(eventId, { unhandled: true });
            }

            // Always respond with 200 OK to Yoco if signature was valid and we've processed (or decided not to process) the event.
            // This prevents Yoco from resending the webhook.
            res.status(200).send('Webhook received, signature verified, and processed.');

        } catch (error) {
            // This catch block is for errors specifically within the signature verification or subsequent logic.
            console.error('(Webhook) Error during webhook signature verification or main processing block:', error.message);
            // console.error(error.stack); // More detailed stack in dev
            // Avoid sending detailed error messages in production for security.
            // Respond 500 if it's a server-side issue, potentially 400 if it's a malformed request that passed initial checks.
            res.status(500).send('Internal server error processing webhook.');
        }
    }
); // End of app.post('/yoco-webhook-receiver')

// ========================================================================= //
// == FALLBACK ROUTES AND ERROR HANDLING                                  == //
// ========================================================================= //

// Catch-all for 404 Not Found errors (if no routes above matched)
app.use((req, res, next) => {
    console.warn(`404 Not Found: ${req.method} ${req.originalUrl} - No specific route matched.`);
    res.status(404).json({ success: false, message: `The requested URL ${req.originalUrl} was not found on this server.` });
});

// Generic error handler (must have 4 arguments: err, req, res, next)
app.use((err, req, res, next) => {
    console.error("Unhandled Application Error:", err.stack || err.message || err);
    if (res.headersSent) {
        // If headers already sent, delegate to the default Express error handler
        return next(err);
    }
    res.status(err.status || 500).json({
        success: false,
        message: err.message || 'An unexpected internal server error occurred.',
        // error: process.env.NODE_ENV === 'development' ? err : {} // Optionally include error details in development
    });
});

// Start the server
app.listen(port, () => {
    console.log(`EazySpaza Backend Server running on port ${port}. Waiting for requests...`);
    console.log(`Node Environment: ${process.env.NODE_ENV || 'development (default)'}`);

    if (YOCO_API_SECRET_KEY && (YOCO_API_SECRET_KEY.startsWith('sk_live_') || YOCO_API_SECRET_KEY.startsWith('sk_test_'))) {
        const keyType = YOCO_API_SECRET_KEY.startsWith('sk_live_') ? "LIVE API" : "TEST API";
        console.log(`YOCO_SECRET_KEY (API Secret for calls TO Yoco) is configured: ${YOCO_API_SECRET_KEY.substring(0,10)}... (${keyType} key)`);
        if (keyType === "TEST API") {
            console.log("INFO: Using TEST Yoco key. Transactions will be simulated.");
        }
    } else {
        console.error("CRITICAL WARNING: YOCO_SECRET_KEY (API Secret) env var is NOT SET or has an invalid format. Yoco API calls WILL FAIL.");
    }

    if (YOCO_WEBHOOK_SECRET && YOCO_WEBHOOK_SECRET.startsWith('whsec_')) {
        console.log(`YOCO_WEBHOOK_SECRET (Webhook Signing Secret for calls FROM Yoco) is configured: ${YOCO_WEBHOOK_SECRET.substring(0,10)}...`);
    } else if (YOCO_WEBHOOK_SECRET) {
        console.error(`CRITICAL WARNING: YOCO_WEBHOOK_SECRET env var is SET but format is INCORRECT. Expected 'whsec_...' but got '${YOCO_WEBHOOK_SECRET.substring(0,10)}...'. Webhook signature verification WILL FAIL.`);
    } else {
        console.error("CRITICAL WARNING: YOCO_WEBHOOK_SECRET (Webhook Signing Secret) env var is NOT SET. Webhook signature verification WILL FAIL.");
    }
});
