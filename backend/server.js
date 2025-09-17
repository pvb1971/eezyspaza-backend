// SERVER.JS VERSION: 2025-09-17- Fix: Multiple fallback methods verify when checkout ID isn't passed in the URL.
// FIREBASE-INTEGRATED - Complete Yoco + Firebase Integration
// Enhanced Yoco Checkout API with Firebase database, comprehensive error handling, security, and debugging

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const crypto = require('crypto');

// Firebase Admin SDK
const admin = require('firebase-admin');

// For Node.js 18+ with built-in fetch, remove the require below
// For Node.js < 18, uncomment the line below:
// const fetch = require('node-fetch');

// Load environment variables first
dotenv.config();

// Initialize Firebase Admin
if (!admin.apps.length) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            }),
            databaseURL: process.env.FIREBASE_DATABASE_URL
        });
        console.log('✅ Firebase Admin initialized successfully');
    } catch (error) {
        console.error('❌ Firebase Admin initialization failed:', error);
    }
}

const db = admin.firestore();

// Initialize express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static files from public folder

// Configuration constants
const YOCO_CONFIG = {
    API_BASE_URL: 'https://payments.yoco.com/api',
    MIN_AMOUNT_CENTS: 500, // R5.00 minimum
    MAX_AMOUNT_CENTS: 10000000, // R100,000 maximum
    WEBHOOK_TIMEOUT_MS: 30000,
    API_TIMEOUT_MS: 15000,
    RETRY_ATTEMPTS: 2
};

// Firebase utility functions
async function storeOrder(orderData) {
    try {
        console.log(`[${orderData.request_id}] Storing order in Firebase:`, orderData.order_reference);

        // Store in Firestore
        const docRef = await db.collection('orders').add({
            ...orderData,
            created_at: admin.firestore.FieldValue.serverTimestamp(),
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`[${orderData.request_id}] Order stored with ID: ${docRef.id}`);
        return docRef.id;

    } catch (error) {
        console.error(`[${orderData.request_id}] Firebase storage error:`, error);
        throw error;
    }
}

async function updateOrderStatus(checkoutId, status, additionalData = {}) {
    try {
        const ordersRef = db.collection('orders');
        const snapshot = await ordersRef
            .where('yoco_checkout_id', '==', checkoutId)
            .get();

        if (!snapshot.empty) {
            const orderDoc = snapshot.docs[0];
            const updateData = {
                status: status,
                updated_at: admin.firestore.FieldValue.serverTimestamp(),
                ...additionalData
            };

            if (status === 'completed') {
                updateData.completed_at = admin.firestore.FieldValue.serverTimestamp();
            } else if (status === 'failed') {
                updateData.failed_at = admin.firestore.FieldValue.serverTimestamp();
            } else if (status === 'cancelled') {
                updateData.cancelled_at = admin.firestore.FieldValue.serverTimestamp();
            }

            await orderDoc.ref.update(updateData);
            console.log(`Order ${orderDoc.id} updated to status: ${status}`);
            return orderDoc.id;
        } else {
            console.warn(`No order found for checkout ID: ${checkoutId}`);
            return null;
        }
    } catch (error) {
        console.error('Error updating order status:', error);
        throw error;
    }
}

async function getOrderByReference(orderReference) {
    try {
        const ordersRef = db.collection('orders');
        const snapshot = await ordersRef
            .where('order_reference', '==', orderReference)
            .get();

        if (snapshot.empty) {
            return null;
        }

        const orderDoc = snapshot.docs[0];
        return {
            id: orderDoc.id,
            ...orderDoc.data()
        };
    } catch (error) {
        console.error('Error fetching order:', error);
        throw error;
    }
}

// NEW: Payment verification function
async function verifyYocoPayment(checkoutId, paymentId) {
    try {
        const apiKey = process.env.YOCO_SECRET_KEY;

        // First try to get checkout details
        const checkoutResponse = await fetch(`https://payments.yoco.com/api/checkouts/${checkoutId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        if (checkoutResponse.ok) {
            const checkoutData = await checkoutResponse.json();
            console.log('Checkout verification:', checkoutData);
            return checkoutData;
        }

        // If we have a paymentId, try to get payment details
        if (paymentId) {
            const paymentResponse = await fetch(`https://payments.yoco.com/api/payments/${paymentId}`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (paymentResponse.ok) {
                const paymentData = await paymentResponse.json();
                console.log('Payment verification:', paymentData);
                return paymentData;
            }
        }

        return null;
    } catch (error) {
        console.error('Error verifying payment:', error);
        return null;
    }
}

// Utility function to validate and sanitize input
function validateCheckoutInput(body) {
    const errors = [];
    const requiredFields = ['amount', 'currency', 'successUrl', 'cancelUrl'];

    // Check required fields
    const missingFields = requiredFields.filter(field => !body[field]);
    if (missingFields.length > 0) {
        errors.push(`Missing required fields: ${missingFields.join(', ')}`);
    }

    // Validate amount
    const amountFloat = parseFloat(body.amount);
    if (isNaN(amountFloat) || amountFloat <= 0) {
        errors.push('Amount must be a positive number');
    }

    // Validate URLs (basic check)
    const urlFields = ['successUrl', 'cancelUrl', 'failureUrl'].filter(field => body[field]);
    urlFields.forEach(field => {
        try {
            new URL(body[field]);
        } catch {
            errors.push(`Invalid URL format for ${field}: ${body[field]}`);
        }
    });

    // Validate currency
    if (body.currency && !/^[A-Z]{3}$/.test(body.currency)) {
        errors.push('Currency must be a 3-letter ISO code (e.g., ZAR)');
    }

    return {
        isValid: errors.length === 0,
        errors,
        amountFloat
    };
}

// Utility function to create Yoco API request with timeout
async function makeYocoRequest(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), YOCO_CONFIG.API_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('Request timed out');
        }
        throw error;
    }
}

// Enhanced /create-checkout endpoint with Firebase integration
app.post('/create-checkout', async (req, res) => {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
        console.log(`[${requestId}] === CHECKOUT REQUEST DEBUG ===`);
        console.log(`[${requestId}] Received from frontend:`, JSON.stringify(req.body, null, 2));

        // Input validation
        const validation = validateCheckoutInput(req.body);
        if (!validation.isValid) {
            console.error(`[${requestId}] Validation errors:`, validation.errors);
            return res.status(400).json({
                error: 'Input validation failed',
                details: validation.errors,
                received_fields: Object.keys(req.body)
            });
        }

        // Convert amount to cents for Yoco
        const amountInCents = Math.round(validation.amountFloat * 100);
        console.log(`[${requestId}] Amount conversion:`, req.body.amount, '→', amountInCents, 'cents');

        // Validate amount range
        if (amountInCents < YOCO_CONFIG.MIN_AMOUNT_CENTS) {
            console.error(`[${requestId}] Amount below minimum:`, amountInCents, 'cents');
            return res.status(400).json({
                error: 'Amount below minimum',
                minimum_amount: YOCO_CONFIG.MIN_AMOUNT_CENTS / 100,
                received_amount: validation.amountFloat,
                currency: req.body.currency || 'ZAR'
            });
        }

        if (amountInCents > YOCO_CONFIG.MAX_AMOUNT_CENTS) {
            console.error(`[${requestId}] Amount above maximum:`, amountInCents, 'cents');
            return res.status(400).json({
                error: 'Amount above maximum',
                maximum_amount: YOCO_CONFIG.MAX_AMOUNT_CENTS / 100,
                received_amount: validation.amountFloat,
                currency: req.body.currency || 'ZAR'
            });
        }

        // Validate environment configuration
        if (!process.env.YOCO_SECRET_KEY) {
            console.error(`[${requestId}] YOCO_SECRET_KEY environment variable is not set`);
            return res.status(500).json({
                error: 'Server configuration error',
                message: 'Payment service not properly configured'
            });
        }

        // Generate order reference
        const orderReference = req.body.metadata?.order_reference ||
            `ORDER_${Date.now()}_${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

       
        // Prepare Yoco payload - UPDATED to include checkoutId in success URLs
        const yocoPayload = {
            amount: amountInCents,
            currency: req.body.currency || 'ZAR',
            cancelUrl: req.body.cancelUrl || 'https://eezyspaza-backend1.onrender.com/yoco-payment-cancel',
            failureUrl: req.body.failureUrl || 'https://eezyspaza-backend1.onrender.com/yoco-payment-failure',
            metadata: {
                order_reference: orderReference,
                customer_name: req.body.metadata?.customer_name || 'Customer',
                customer_email: req.body.metadata?.customer_email || '',
                request_id: requestId,
                timestamp: new Date().toISOString(),
                item_count: req.body.items?.length || 0,
                first_item: req.body.items?.[0]?.name?.substring(0, 50) || 'Item'
            }
        };

        console.log(`[${requestId}] Sending to Yoco:`, JSON.stringify(yocoPayload, null, 2));

        // Log API key format for debugging (without exposing the key)
        const keyPrefix = process.env.YOCO_SECRET_KEY.substring(0, 12);
        const isTestKey = process.env.YOCO_SECRET_KEY.startsWith('sk_test_');
        console.log(`[${requestId}] Using ${isTestKey ? 'TEST' : 'LIVE'} Yoco API key starting with:`, keyPrefix);

        // Make request to Yoco with retry logic
        let yocoResponse;
        let lastError;

        for (let attempt = 1; attempt <= YOCO_CONFIG.RETRY_ATTEMPTS; attempt++) {
            try {
                console.log(`[${requestId}] Yoco API attempt ${attempt}/${YOCO_CONFIG.RETRY_ATTEMPTS}`);

                const yocoApiUrl = `${YOCO_CONFIG.API_BASE_URL}/checkouts`;
                console.log(`[${requestId}] Making request to: ${yocoApiUrl}`);

                yocoResponse = await makeYocoRequest(yocoApiUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}`,
                        'Content-Type': 'application/json',
                        'User-Agent': 'EezySpaza/1.0',
                        'X-Request-ID': requestId
                    },
                    body: JSON.stringify(yocoPayload)
                });

                break; // Success, exit retry loop

            } catch (error) {
                lastError = error;
                console.warn(`[${requestId}] Attempt ${attempt} failed:`, error.message);

                if (attempt < YOCO_CONFIG.RETRY_ATTEMPTS) {
                    const delay = Math.pow(2, attempt - 1) * 1000;
                    console.log(`[${requestId}] Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        if (!yocoResponse) {
            console.error(`[${requestId}] All Yoco API attempts failed:`, lastError?.message);
            return res.status(503).json({
                error: 'Payment service unavailable',
                message: 'Unable to connect to payment provider after multiple attempts',
                retry_recommended: true,
                request_id: requestId
            });
        }

        console.log(`[${requestId}] Yoco response status:`, yocoResponse.status);
        console.log(`[${requestId}] Yoco response headers:`, Object.fromEntries(yocoResponse.headers.entries()));

        // Handle non-successful responses
        if (!yocoResponse.ok) {
            let errorDetails;
            const contentType = yocoResponse.headers.get('content-type');

            if (contentType && contentType.includes('application/json')) {
                try {
                    errorDetails = await yocoResponse.json();
                    console.error(`[${requestId}] Yoco JSON Error:`, errorDetails);
                } catch (parseError) {
                    console.error(`[${requestId}] Failed to parse Yoco JSON error:`, parseError);
                    errorDetails = { message: 'Failed to parse error response' };
                }
            } else {
                const errorText = await yocoResponse.text();
                console.error(`[${requestId}] Yoco Text Error:`, errorText);
                errorDetails = { message: errorText || 'Unknown error' };
            }

            // Enhanced error handling for different status codes
            const keyPrefix = process.env.YOCO_SECRET_KEY?.substring(0, 8) || 'MISSING';
            const isValidFormat = process.env.YOCO_SECRET_KEY?.startsWith('sk_test_') ||
                                 process.env.YOCO_SECRET_KEY?.startsWith('sk_live_');

            let userMessage = 'Payment processing failed';
            if (yocoResponse.status === 400) {
                userMessage = 'Invalid payment information provided';
            } else if (yocoResponse.status === 401) {
                userMessage = 'Payment service authentication failed';
            } else if (yocoResponse.status === 403) {
                userMessage = 'Payment not authorized';
            } else if (yocoResponse.status === 404) {
                userMessage = 'Payment service endpoint not found';
            } else if (yocoResponse.status >= 500) {
                userMessage = 'Payment service temporarily unavailable';
            }

            return res.status(yocoResponse.status >= 500 ? 503 : 400).json({
                error: userMessage,
                yoco_status: yocoResponse.status,
                yoco_error: errorDetails,
                request_id: requestId,
                retry_recommended: yocoResponse.status >= 500,
                debug_info: process.env.NODE_ENV === 'development' ? {
                    amount_sent: amountInCents,
                    currency_sent: yocoPayload.currency,
                    api_key_prefix: keyPrefix,
                    api_key_valid_format: isValidFormat,
                    api_endpoint: `${YOCO_CONFIG.API_BASE_URL}/checkouts`
                } : undefined
            });
        }

        // Parse successful response
        let yocoData;
        try {
            yocoData = await yocoResponse.json();
            console.log(`[${requestId}] Yoco success response:`, yocoData);
        } catch (parseError) {
            console.error(`[${requestId}] Failed to parse Yoco success response:`, parseError);
            return res.status(500).json({
                error: 'Failed to parse payment service response',
                message: parseError.message,
                request_id: requestId
            });
        }

        // UPDATED: Now update the success URLs with checkoutId
        yocoPayload.successUrl = `${req.body.successUrl || 'https://eezyspaza-backend1.onrender.com/yoco-payment-success'}?checkoutId=${yocoData.id}`;

        // Validate redirect URL
        const redirectUrl = yocoData.redirectUrl || yocoData.redirect_url;
        if (!redirectUrl) {
            console.error(`[${requestId}] No redirect URL in Yoco response:`, yocoData);
            return res.status(500).json({
                error: 'Invalid payment service response',
                message: 'No redirect URL provided',
                request_id: requestId,
                yoco_response: process.env.NODE_ENV === 'development' ? yocoData : undefined
            });
        }

        // Store order information in Firebase
        try {
            const orderData = {
                order_reference: orderReference,
                amount_cents: amountInCents,
                amount_display: validation.amountFloat,
                currency: req.body.currency || 'ZAR',
                items: req.body.items || [],
                customer_info: req.body.metadata || {},
                yoco_checkout_id: yocoData.id,
                status: 'pending',
                request_id: requestId,
                urls: {
                    success: req.body.successUrl,
                    cancel: req.body.cancelUrl,
                    failure: req.body.failureUrl
                }
            };

            console.log(`[${requestId}] Order data prepared for storage:`, orderData);
            await storeOrder(orderData); // Store in Firebase

        } catch (dbError) {
            console.error(`[${requestId}] Database storage error (non-critical):`, dbError);
            // Continue even if database storage fails
        }

        // Return redirect URL
        console.log(`[${requestId}] Checkout successful, redirect URL:`, redirectUrl);

        res.json({
            redirectUrl: redirectUrl,
            order_reference: orderReference,
            amount_cents: amountInCents,
            amount_display: validation.amountFloat,
            currency: req.body.currency || 'ZAR',
            checkout_id: yocoData.id,
            request_id: requestId
        });

    } catch (networkError) {
        console.error(`[${requestId}] Network/Server error in checkout:`, networkError);

        let errorResponse = {
            error: 'Payment processing error',
            message: 'An unexpected error occurred',
            request_id: requestId,
            retry_recommended: true
        };

        if (networkError.message === 'Request timed out') {
            errorResponse = {
                error: 'Payment service timeout',
                message: 'Payment provider took too long to respond',
                request_id: requestId,
                retry_recommended: true
            };
            return res.status(504).json(errorResponse);
        }

        if (networkError.code === 'ENOTFOUND' || networkError.code === 'ECONNREFUSED') {
            errorResponse = {
                error: 'Payment service unavailable',
                message: 'Unable to connect to payment provider',
                request_id: requestId,
                retry_recommended: true
            };
            return res.status(503).json(errorResponse);
        }

        if (process.env.NODE_ENV === 'development') {
            errorResponse.debug_info = {
                error_name: networkError.name,
                error_code: networkError.code,
                error_message: networkError.message
            };
        }

        res.status(500).json(errorResponse);
    }
});

// NEW: /success route for handling success redirects with payment verification
app.get('/success', async (req, res) => {
    const requestId = `success_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    console.log(`[${requestId}] === PAYMENT SUCCESS PAGE ===`);
    console.log(`[${requestId}] Query params:`, req.query);
    
    try {
        const { checkoutId, paymentId, status } = req.query;
        
        if (checkoutId) {
            console.log(`[${requestId}] Processing payment for checkout: ${checkoutId}`);
            
            // Verify the payment with Yoco API
            const paymentDetails = await verifyYocoPayment(checkoutId, paymentId);
            
            if (paymentDetails && (paymentDetails.status === 'successful' || paymentDetails.status === 'created')) {
                // Update your database with successful payment
                await updateOrderStatus(checkoutId, 'completed', paymentDetails);
                
                // Redirect to your frontend success page with order details
                res.redirect(`${process.env.FRONTEND_URL}/payment-success?order=${paymentDetails.metadata?.order_reference}`);
                return;
            } else {
                console.log(`[${requestId}] Payment verification failed:`, paymentDetails);
                res.redirect(`${process.env.FRONTEND_URL}/payment-failed`);
                return;
            }
        }
        
        // Try to verify payment using order reference if no checkoutId
        const orderReference = req.query.order_reference || req.query.reference;
        
        if (orderReference) {
            console.log(`[${requestId}] Attempting verification with order reference: ${orderReference}`);
            
            try {
                const order = await getOrderByReference(orderReference);
                if (order && order.yoco_checkout_id) {
                    console.log(`[${requestId}] Found order with checkout ID: ${order.yoco_checkout_id}`);
                    
                    const paymentDetails = await verifyYocoPayment(order.yoco_checkout_id);
                    if (paymentDetails && (paymentDetails.status === 'successful' || paymentDetails.status === 'created')) {
                        await updateOrderStatus(order.yoco_checkout_id, 'completed', paymentDetails);
                        
                        res.redirect(`${process.env.FRONTEND_URL}/payment-success?order=${orderReference}`);
                        return;
                    }
                } else {
                    console.log(`[${requestId}] Order found but no checkout ID available`);
                }
            } catch (dbError) {
                console.warn(`[${requestId}] Could not fetch order details:`, dbError.message);
            }
        }
        
        // If no verification method worked
        console.log(`[${requestId}] No checkoutId or order reference found in query params`);
        res.status(400).send('Missing payment information for verification');
        
    } catch (error) {
        console.error(`[${requestId}] Error processing success:`, error);
        res.status(500).send('Error processing payment confirmation');
    }
});

// Health check endpoint with Firebase connectivity
app.get('/yoco-health', async (req, res) => {
    try {
        const healthData = {
            status: 'unknown',
            timestamp: new Date().toISOString(),
            checks: {}
        };

        // Check API key configuration
        if (!process.env.YOCO_SECRET_KEY) {
            healthData.status = 'error';
            healthData.checks.api_key = {
                status: 'error',
                message: 'API key not configured'
            };
        } else {
            const keyFormat = process.env.YOCO_SECRET_KEY.startsWith('sk_test_') ||
                             process.env.YOCO_SECRET_KEY.startsWith('sk_live_');
            const environment = process.env.YOCO_SECRET_KEY.startsWith('sk_test_') ? 'sandbox' : 'live';

            healthData.checks.api_key = {
                status: keyFormat ? 'ok' : 'warning',
                message: keyFormat ? 'API key format is valid' : 'API key format may be incorrect',
                environment: environment
            };
        }

        // Check Firebase connectivity
        try {
            await db.collection('health_check').limit(1).get();
            healthData.checks.firebase = {
                status: 'ok',
                message: 'Firebase connected successfully'
            };
        } catch (firebaseError) {
            healthData.checks.firebase = {
                status: 'error',
                message: `Firebase connection failed: ${firebaseError.message}`
            };
        }

        // Test connectivity to Yoco API (optional ping endpoint)
        try {
            const testResponse = await makeYocoRequest(`${YOCO_CONFIG.API_BASE_URL}/ping`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}`,
                    'User-Agent': 'EezySpaza/1.0 (health-check)'
                }
            });

            healthData.checks.connectivity = {
                status: testResponse.ok ? 'ok' : 'warning',
                message: `API responded with status ${testResponse.status}`,
                response_time: Date.now()
            };

        } catch (connectError) {
            healthData.checks.connectivity = {
                status: 'error',
                message: `Failed to connect: ${connectError.message}`
            };
        }

        // Determine overall status
        const statuses = Object.values(healthData.checks).map(check => check.status);
        if (statuses.includes('error')) {
            healthData.status = 'error';
        } else if (statuses.includes('warning')) {
            healthData.status = 'warning';
        } else {
            healthData.status = 'ok';
        }

        const httpStatus = healthData.status === 'error' ? 503 : 200;
        res.status(httpStatus).json(healthData);

    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Webhook endpoint for Yoco payment notifications with Firebase integration
app.post('/yoco-webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const webhookId = `webhook_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    try {
        console.log(`[${webhookId}] === YOCO WEBHOOK RECEIVED ===`);
        console.log(`[${webhookId}] Headers:`, req.headers);

        // Verify webhook signature if secret is configured
        const signature = req.headers['x-yoco-signature'];
        if (process.env.YOCO_WEBHOOK_SECRET && signature) {
            const expectedSignature = crypto
                .createHmac('sha256', process.env.YOCO_WEBHOOK_SECRET)
                .update(req.body)
                .digest('hex');

            if (signature !== expectedSignature) {
                console.error(`[${webhookId}] Invalid webhook signature`);
                return res.status(401).json({ error: 'Invalid signature' });
            }
        } else {
            console.warn(`[${webhookId}] No webhook signature provided or secret not set`);
        }

        const event = JSON.parse(req.body.toString());
        console.log(`[${webhookId}] Event:`, event);

        // Handle different event types
        switch (event.type) {
            case 'payment.succeeded':
                await handlePaymentSuccess(event.data, webhookId);
                break;

            case 'payment.failed':
                await handlePaymentFailure(event.data, webhookId);
                break;

            case 'payment.cancelled':
                await handlePaymentCancellation(event.data, webhookId);
                break;

            default:
                console.log(`[${webhookId}] Unhandled event type: ${event.type}`);
        }

        res.status(200).json({ received: true, webhook_id: webhookId });

    } catch (error) {
        console.error(`[${webhookId}] Webhook processing error:`, error);
        res.status(500).json({ error: 'Webhook processing failed', webhook_id: webhookId });
    }
});

// Firebase-integrated webhook event handlers
async function handlePaymentSuccess(paymentData, webhookId) {
    console.log(`[${webhookId}] Processing successful payment:`, paymentData);

    try {
        // Update order status in Firebase
        const checkoutId = paymentData.checkoutId || paymentData.id;
        const orderId = await updateOrderStatus(checkoutId, 'completed', {
            payment_data: paymentData,
            payment_method: paymentData.paymentMethod || 'card',
            transaction_id: paymentData.id || paymentData.transactionId
        });

        if (orderId) {
            console.log(`[${webhookId}] Order ${orderId} marked as completed`);

            // TODO: Additional success actions:
            // - Clear user's cart
            // - Send confirmation email
            // - Update inventory
            // - Trigger fulfillment process
        } else {
            console.warn(`[${webhookId}] No order found for checkout ID: ${checkoutId}`);
        }

        console.log(`[${webhookId}] Payment success processing completed`);
    } catch (error) {
        console.error(`[${webhookId}] Error processing successful payment:`, error);
        throw error;
    }
}

async function handlePaymentFailure(paymentData, webhookId) {
    console.log(`[${webhookId}] Processing failed payment:`, paymentData);

    try {
        // Update order status in Firebase
        const checkoutId = paymentData.checkoutId || paymentData.id;
        const orderId = await updateOrderStatus(checkoutId, 'failed', {
            failure_reason: paymentData.failureReason || paymentData.errorMessage || 'Payment failed',
            payment_data: paymentData,
            error_code: paymentData.errorCode || 'unknown'
        });

        if (orderId) {
            console.log(`[${webhookId}] Order ${orderId} marked as failed`);

            // TODO: Additional failure actions:
            // - Send failure notification
            // - Log for analytics
            // - Restore cart items
        }

        console.log(`[${webhookId}] Payment failure processing completed`);
    } catch (error) {
        console.error(`[${webhookId}] Error processing failed payment:`, error);
        throw error;
    }
}

async function handlePaymentCancellation(paymentData, webhookId) {
    console.log(`[${webhookId}] Processing cancelled payment:`, paymentData);

    try {
        // Update order status in Firebase
        const checkoutId = paymentData.checkoutId || paymentData.id;
        const orderId = await updateOrderStatus(checkoutId, 'cancelled', {
            payment_data: paymentData,
            cancellation_reason: 'User cancelled payment'
        });

        if (orderId) {
            console.log(`[${webhookId}] Order ${orderId} marked as cancelled`);

            // TODO: Additional cancellation actions:
            // - Restore cart items
            // - Send cancellation notification
        }

        console.log(`[${webhookId}] Payment cancellation processing completed`);
    } catch (error) {
        console.error(`[${webhookId}] Error processing cancelled payment:`, error);
        throw error;
    }
}

// UPDATED: Payment result handlers with Firebase integration and payment verification
app.get('/yoco-payment-success', async (req, res) => {
    const sessionId = `success_${Date.now()}`;
    console.log(`[${sessionId}] === PAYMENT SUCCESS PAGE ===`);
    console.log(`[${sessionId}] Query params:`, req.query);

    try {
        // Extract payment information from query parameters
        const { checkoutId, paymentId, status } = req.query;

        if (checkoutId) {
            console.log(`[${sessionId}] Processing payment for checkout: ${checkoutId}`);

            // Verify the payment with Yoco API
            const paymentDetails = await verifyYocoPayment(checkoutId, paymentId);

            if (paymentDetails && (paymentDetails.status === 'successful' || paymentDetails.status === 'created')) {
                // Update order status in Firebase
                await updateOrderStatus(checkoutId, 'completed', paymentDetails);

                const successParams = new URLSearchParams({
                    status: 'success',
                    reference: paymentDetails.metadata?.order_reference || 'unknown',
                    amount: paymentDetails.amount / 100,
                    timestamp: new Date().toISOString()
                });

                res.redirect(`${process.env.FRONTEND_URL}/payment-success.html?${successParams}`);
                return;
            }
        }

        // Try to verify payment using order reference if no checkoutId
const orderReference = req.query.order_reference || req.query.reference;

if (orderReference) {
    console.log(`[${sessionId}] Attempting verification with order reference: ${orderReference}`);
    
    try {
        const order = await getOrderByReference(orderReference);
        if (order && order.yoco_checkout_id) {
            console.log(`[${sessionId}] Found order with checkout ID: ${order.yoco_checkout_id}`);
            
            const paymentDetails = await verifyYocoPayment(order.yoco_checkout_id);
            if (paymentDetails && (paymentDetails.status === 'successful' || paymentDetails.status === 'created')) {
                await updateOrderStatus(order.yoco_checkout_id, 'completed', paymentDetails);
                
                const successParams = new URLSearchParams({
                    status: 'success',
                    reference: orderReference,
                    amount: paymentDetails.amount / 100,
                    timestamp: new Date().toISOString()
                });
                
                res.redirect(`${process.env.FRONTEND_URL}/payment-success.html?${successParams}`);
                return;
            }
        } else {
            console.log(`[${sessionId}] Order found but no checkout ID available`);
        }
    } catch (dbError) {
        console.warn(`[${sessionId}] Could not fetch order details:`, dbError.message);
    }
}

        const successParams = new URLSearchParams({
            status: 'success',
            reference: orderReference || 'unknown',
            timestamp: new Date().toISOString()
        });

        res.redirect(`${process.env.FRONTEND_URL}/payment-success.html?${successParams}`);

    } catch (error) {
        console.error(`[${sessionId}] Error handling success redirect:`, error);
        res.redirect(`${process.env.FRONTEND_URL}/payment-success.html?status=success&error=processing`);
    }
});

app.get('/yoco-payment-cancel', async (req, res) => {
    const sessionId = `cancel_${Date.now()}`;
    console.log(`[${sessionId}] === PAYMENT CANCELLED ===`);
    console.log(`[${sessionId}] Query params:`, req.query);

    try {
        const orderReference = req.query.order_reference || req.query.reference;

        if (orderReference) {
            console.log(`[${sessionId}] Order cancelled: ${orderReference}`);

            // Try to update order status in Firebase
            try {
                const order = await getOrderByReference(orderReference);
                if (order && order.yoco_checkout_id) {
                    await updateOrderStatus(order.yoco_checkout_id, 'cancelled', {
                        cancellation_source: 'redirect_handler'
                    });
                }
            } catch (dbError) {
                console.warn(`[${sessionId}] Could not update order status:`, dbError.message);
            }
        }

        const cancelParams = new URLSearchParams({
            status: 'cancelled',
            reference: orderReference || 'unknown',
            message: 'Payment was cancelled. Your cart items are still saved.',
            timestamp: new Date().toISOString()
        });

        res.redirect(`${process.env.FRONTEND_URL}/payment-cancelled.html?${cancelParams}`);

    } catch (error) {
        console.error(`[${sessionId}] Error handling cancel redirect:`, error);
        res.redirect(`${process.env.FRONTEND_URL}/payment-cancelled.html?status=cancelled&error=processing`);
    }
});

app.get('/yoco-payment-failure', async (req, res) => {
    const sessionId = `failure_${Date.now()}`;
    console.log(`[${sessionId}] === PAYMENT FAILED ===`);
    console.log(`[${sessionId}] Query params:`, req.query);

    try {
        const orderReference = req.query.order_reference || req.query.reference;
        const errorCode = req.query.error_code || 'unknown';

        if (orderReference) {
            console.log(`[${sessionId}] Order failed: ${orderReference}, Error: ${errorCode}`);

            // Try to update order status in Firebase
            try {
                const order = await getOrderByReference(orderReference);
                if (order && order.yoco_checkout_id) {
                    await updateOrderStatus(order.yoco_checkout_id, 'failed', {
                        failure_source: 'redirect_handler',
                        error_code: errorCode
                    });
                }
            } catch (dbError) {
                console.warn(`[${sessionId}] Could not update order status:`, dbError.message);
            }
        }

        const errorMessages = {
            'insufficient_funds': 'Payment failed due to insufficient funds.',
            'card_declined': 'Your card was declined. Please try a different payment method.',
            'expired_card': 'Your card has expired. Please use a different card.',
            'invalid_card': 'Invalid card details. Please check your information.',
            'network_error': 'Network error occurred. Please try again.',
            'unknown': 'Payment failed. Please try again or contact support.'
        };

        const failureParams = new URLSearchParams({
            status: 'failed',
            reference: orderReference || 'unknown',
            error_code: errorCode,
            message: errorMessages[errorCode] || errorMessages.unknown,
            timestamp: new Date().toISOString()
        });

        res.redirect(`${process.env.FRONTEND_URL}/payment-failed.html?${failureParams}`);

    } catch (error) {
        console.error(`[${sessionId}] Error handling failure redirect:`, error);
        res.redirect(`${process.env.FRONTEND_URL}/payment-failed.html?status=failed&error=processing`);
    }
});

// Order status lookup endpoint with Firebase integration
app.get('/order-status/:reference', async (req, res) => {
    try {
        const orderReference = req.params.reference;

        if (!orderReference) {
            return res.status(400).json({ error: 'Order reference required' });
        }

        // Query Firebase for order
        const order = await getOrderByReference(orderReference);

        if (!order) {
            return res.status(404).json({
                error: 'Order not found',
                order_reference: orderReference
            });
        }

        res.json({
            order_reference: orderReference,
            status: order.status,
            amount_display: order.amount_display,
            currency: order.currency,
            created_at: order.created_at,
            updated_at: order.updated_at,
            items: order.items || [],
            customer_info: order.customer_info || {}
        });

    } catch (error) {
        console.error('Error fetching order status:', error);
        res.status(500).json({ error: 'Failed to fetch order status' });
    }
});

// Get orders for a customer (new endpoint)
app.get('/orders/customer/:email', async (req, res) => {
    try {
        const customerEmail = req.params.email;

        if (!customerEmail) {
            return res.status(400).json({ error: 'Customer email required' });
        }

        const ordersRef = db.collection('orders');
        const snapshot = await ordersRef
            .where('customer_info.customer_email', '==', customerEmail)
            .orderBy('created_at', 'desc')
            .limit(50)
            .get();

        const orders = [];
        snapshot.forEach(doc => {
            orders.push({
                id: doc.id,
                ...doc.data()
            });
        });

        res.json({
            customer_email: customerEmail,
            total_orders: orders.length,
            orders: orders
        });

    } catch (error) {
        console.error('Error fetching customer orders:', error);
        res.status(500).json({ error: 'Failed to fetch customer orders' });
    }
});

// Admin endpoint to get all orders (with pagination)
app.get('/admin/orders', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const status = req.query.status;

        let query = db.collection('orders').orderBy('created_at', 'desc');

        if (status) {
            query = query.where('status', '==', status);
        }

        const snapshot = await query.limit(limit).get();

        const orders = [];
        snapshot.forEach(doc => {
            orders.push({
                id: doc.id,
                ...doc.data()
            });
        });

        res.json({
            page: page,
            limit: limit,
            total_returned: orders.length,
            status_filter: status || 'all',
            orders: orders
        });

    } catch (error) {
        console.error('Error fetching admin orders:', error);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// Error handling middleware for Yoco routes
app.use('/yoco*', (error, req, res, next) => {
    console.error('Yoco route error:', error);
    res.status(500).json({
        error: 'Payment service error',
        message: 'An unexpected error occurred in the payment service',
        timestamp: new Date().toISOString()
    });
});

// General error handling middleware
app.use((error, req, res, next) => {
    console.error('General server error:', error);
    res.status(500).json({
        error: 'Server error',
        message: 'An unexpected error occurred',
        timestamp: new Date().toISOString()
    });
});

// Export configuration for testing
module.exports = {
    app,
    YOCO_CONFIG,
    validateCheckoutInput,
    makeYocoRequest,
    storeOrder,
    updateOrderStatus,
    getOrderByReference,
    verifyYocoPayment
};

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 EezySpaza Server running on port ${PORT}`);
    console.log(`📊 Yoco API endpoint: ${YOCO_CONFIG.API_BASE_URL}/checkouts`);
    console.log(`🔑 API key configured: ${process.env.YOCO_SECRET_KEY ? 'Yes' : 'No'}`);
    console.log(`🔥 Firebase configured: ${process.env.FIREBASE_PROJECT_ID ? 'Yes' : 'No'}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);

    // Environment validation warnings
    if (!process.env.YOCO_SECRET_KEY) {
        console.warn('⚠️  YOCO_SECRET_KEY not found in environment variables!');
        console.warn('⚠️  Set YOCO_SECRET_KEY in your .env file');
    }

    if (!process.env.FIREBASE_PROJECT_ID) {
        console.warn('⚠️  Firebase configuration incomplete!');
        console.warn('⚠️  Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY in your .env file');
    }

    console.log('✅ Server ready for payments and Firebase operations!');
});