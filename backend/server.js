// SERVER.JS VERSION: 2025-09-15-07:30:00 - FIXED Yoco API endpoint URL
// Enhanced Yoco Checkout API with comprehensive error handling, security, and debugging
// Dependencies: express, node-fetch (or built-in fetch), crypto for webhook verification

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fetch = require('node-fetch'); // Required for Node.js < 18; remove if using Node.js 18+ with built-in fetch

// Initialize express app
const app = express();

// Load environment variables
dotenv.config();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.raw({ type: 'application/json', limit: '10kb' })); // For webhook endpoint

// Configuration constants - FIXED API URL
const YOCO_CONFIG = {
    API_BASE_URL: 'https://payments.yoco.com/api',
    MIN_AMOUNT_CENTS: 500, // R5.00 minimum (adjust based on Yoco requirements)
    MAX_AMOUNT_CENTS: 10000000, // R100,000 maximum (adjust as needed)
    WEBHOOK_TIMEOUT_MS: 30000,
    API_TIMEOUT_MS: 15000,
    RETRY_ATTEMPTS: 2
};

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

// Enhanced /create-checkout endpoint with comprehensive error handling and debugging
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
        
        // Convert amount to cents for Yoco (critical fix)
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
        
        // Generate order reference if not provided
        const orderReference = req.body.metadata?.order_reference || `ORDER_${Date.now()}_${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
        
        // Prepare Yoco payload with proper structure
        const yocoPayload = {
            amount: amountInCents,
            currency: req.body.currency || 'ZAR',
            cancelUrl: req.body.cancelUrl,
            successUrl: req.body.successUrl,
            ...(req.body.failureUrl && { failureUrl: req.body.failureUrl }),
            metadata: {
                order_reference: orderReference,
                customer_name: req.body.metadata?.customer_name || 'Customer',
                customer_email: req.body.metadata?.customer_email || '',
                request_id: requestId,
                timestamp: new Date().toISOString(),
                // Include limited item info if needed (keep under Yoco's metadata limits)
                ...(req.body.items && req.body.items.length > 0 && {
                    item_count: req.body.items.length,
                    first_item: req.body.items[0]?.name?.substring(0, 50) || 'Item'
                })
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
                
                // FIXED: Use correct Yoco API endpoint
                const yocoApiUrl = `${YOCO_CONFIG.API_BASE_URL}/checkouts`;
                console.log(`[${requestId}] Making request to: ${yocoApiUrl}`);
                
                yocoResponse = await makeYocoRequest(yocoApiUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}`,
                        'Content-Type': 'application/json',
                        'User-Agent': 'EazySpaza/1.0',
                        'X-Request-ID': requestId
                    },
                    body: JSON.stringify(yocoPayload)
                });
                
                break; // Success, exit retry loop
                
            } catch (error) {
                lastError = error;
                console.warn(`[${requestId}] Attempt ${attempt} failed:`, error.message);
                
                if (attempt < YOCO_CONFIG.RETRY_ATTEMPTS) {
                    // Wait before retry (exponential backoff)
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
        
        // Handle non-successful responses with detailed error information
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
            
            // Handle specific 404 error
            if (yocoResponse.status === 404) {
                console.error(`[${requestId}] Yoco API 404 - Check API endpoint and credentials`);
                
                // Check if API key format is correct
                const keyPrefix = process.env.YOCO_SECRET_KEY?.substring(0, 8) || 'MISSING';
                const isValidFormat = process.env.YOCO_SECRET_KEY?.startsWith('sk_test_') || 
                                     process.env.YOCO_SECRET_KEY?.startsWith('sk_live_');
                
                if (!isValidFormat) {
                    console.error(`[${requestId}] Invalid API key format. Key should start with sk_test_ or sk_live_`);
                }
                
                return res.status(400).json({
                    error: 'Payment service configuration error',
                    message: 'The payment endpoint is not accessible. Please check API configuration.',
                    yoco_status: yocoResponse.status,
                    debug_info: process.env.NODE_ENV === 'development' ? {
                        api_endpoint: `${YOCO_CONFIG.API_BASE_URL}/checkouts`,
                        api_key_prefix: keyPrefix,
                        api_key_valid_format: isValidFormat
                    } : undefined
                });
            }
            
            // Map common Yoco errors to user-friendly messages
            let userMessage = 'Payment processing failed';
            if (yocoResponse.status === 400) {
                userMessage = 'Invalid payment information provided';
            } else if (yocoResponse.status === 401) {
                userMessage = 'Payment service authentication failed';
            } else if (yocoResponse.status === 403) {
                userMessage = 'Payment not authorized';
            } else if (yocoResponse.status >= 500) {
                userMessage = 'Payment service temporarily unavailable';
            }
            
            return res.status(yocoResponse.status === 500 ? 503 : 400).json({
                error: userMessage,
                yoco_status: yocoResponse.status,
                yoco_error: errorDetails,
                request_id: requestId,
                retry_recommended: yocoResponse.status >= 500,
                debug_info: process.env.NODE_ENV === 'development' ? {
                    amount_sent: amountInCents,
                    currency_sent: yocoPayload.currency,
                    api_key_prefix: keyPrefix
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
        
        // Validate that we received a redirect URL
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
        
        // Store order information in your database here (recommended)
        try {
            // Example database storage - implement according to your DB schema
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
                created_at: new Date(),
                urls: {
                    success: req.body.successUrl,
                    cancel: req.body.cancelUrl,
                    failure: req.body.failureUrl
                }
            };
            
            // await storeOrder(orderData); // Implement this function
            console.log(`[${requestId}] Order data prepared for storage:`, orderData);
            
        } catch (dbError) {
            console.error(`[${requestId}] Database storage error (non-critical):`, dbError);
            // Don't fail the checkout if database storage fails
        }
        
        // Return the redirect URL for frontend
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
        
        // Map specific network errors
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
        
        // Include error details in development
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

// Enhanced health check endpoint for Yoco connectivity
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
        
        // Test connectivity to Yoco API (optional - remove if causing issues)
        try {
            const testResponse = await makeYocoRequest(`${YOCO_CONFIG.API_BASE_URL}/ping`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}`,
                    'User-Agent': 'EazySpaza/1.0 (health-check)'
                }
            });
            
            healthData.checks.connectivity = {
                status: testResponse.ok ? 'ok' : 'warning',
                message: `API responded with status ${testResponse.status}`,
                response_time: Date.now() // You could measure actual response time
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

// Enhanced webhook endpoint for Yoco payment notifications
app.post('/yoco-webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const webhookId = `webhook_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    
    try {
        console.log(`[${webhookId}] === YOCO WEBHOOK RECEIVED ===`);
        console.log(`[${webhookId}] Headers:`, req.headers);
        
        // Verify webhook signature (implement based on Yoco's documentation)
        const signature = req.headers['x-yoco-signature'];
        if (process.env.YOCO_WEBHOOK_SECRET && signature) {
            // const expectedSignature = crypto
            //     .createHmac('sha256', process.env.YOCO_WEBHOOK_SECRET)
            //     .update(req.body)
            //     .digest('hex');
            
            // if (signature !== expectedSignature) {
            //     console.error(`[${webhookId}] Invalid webhook signature`);
            //     return res.status(401).json({ error: 'Invalid signature' });
            // }
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

// Webhook event handlers (implement based on your business logic)
async function handlePaymentSuccess(paymentData, webhookId) {
    console.log(`[${webhookId}] Processing successful payment:`, paymentData);
    
    try {
        // Update order status in database
        // await updateOrderStatus(paymentData.metadata.order_reference, 'paid');
        
        // Clear user's cart/trolley
        // await clearUserCart(paymentData.metadata.customer_email);
        
        // Send confirmation email
        // await sendPaymentConfirmationEmail(paymentData);
        
        // Trigger fulfillment process
        // await triggerOrderFulfillment(paymentData.metadata.order_reference);
        
        console.log(`[${webhookId}] Payment success processing completed`);
        
    } catch (error) {
        console.error(`[${webhookId}] Error processing successful payment:`, error);
        throw error; // This will cause the webhook to be retried
    }
}

async function handlePaymentFailure(paymentData, webhookId) {
    console.log(`[${webhookId}] Processing failed payment:`, paymentData);
    
    try {
        // Update order status in database
        // await updateOrderStatus(paymentData.metadata.order_reference, 'failed');
        
        // Log failure for analysis
        // await logPaymentFailure(paymentData);
        
        // Send failure notification email
        // await sendPaymentFailureEmail(paymentData);
        
        console.log(`[${webhookId}] Payment failure processing completed`);
        
    } catch (error) {
        console.error(`[${webhookId}] Error processing failed payment:`, error);
        throw error;
    }
}

async function handlePaymentCancellation(paymentData, webhookId) {
    console.log(`[${webhookId}] Processing cancelled payment:`, paymentData);
    
    try {
        // Update order status in database
        // await updateOrderStatus(paymentData.metadata.order_reference, 'cancelled');
        
        // Don't clear the cart - user might want to try again
        
        console.log(`[${webhookId}] Payment cancellation processing completed`);
        
    } catch (error) {
        console.error(`[${webhookId}] Error processing cancelled payment:`, error);
        throw error;
    }
}

// Enhanced success/cancel/failure handlers with better logging and user experience
app.get('/yoco-payment-success', async (req, res) => {
    const sessionId = `success_${Date.now()}`;
    console.log(`[${sessionId}] === PAYMENT SUCCESS PAGE ===`);
    console.log(`[${sessionId}] Query params:`, req.query);
    
    try {
        // Extract order information from query params
        const orderReference = req.query.order_reference || req.query.reference;
        
        if (orderReference) {
            // Optionally fetch and display order details
            // const orderDetails = await getOrderDetails(orderReference);
            console.log(`[${sessionId}] Order reference: ${orderReference}`);
        }
        
        // Redirect to success page with clean URL
        const successParams = new URLSearchParams({
            status: 'success',
            reference: orderReference || 'unknown',
            timestamp: new Date().toISOString()
        });
        
        res.redirect(`/payment-success.html?${successParams}`);
        
    } catch (error) {
        console.error(`[${sessionId}] Error handling success redirect:`, error);
        res.redirect('/payment-success.html?status=success&error=processing');
    }
});

app.get('/yoco-payment-cancel', async (req, res) => {
    const sessionId = `cancel_${Date.now()}`;
    console.log(`[${sessionId}] === PAYMENT CANCELLED ===`);
    console.log(`[${sessionId}] Query params:`, req.query);
    
    try {
        const orderReference = req.query.order_reference || req.query.reference;
        
        if (orderReference) {
            // Mark order as cancelled but don't delete it
            // await updateOrderStatus(orderReference, 'cancelled');
            console.log(`[${sessionId}] Order cancelled: ${orderReference}`);
        }
        
        const cancelParams = new URLSearchParams({
            status: 'cancelled',
            reference: orderReference || 'unknown',
            message: 'Payment was cancelled. Your cart items are still saved.',
            timestamp: new Date().toISOString()
        });
        
        res.redirect(`/payment-cancelled.html?${cancelParams}`);
        
    } catch (error) {
        console.error(`[${sessionId}] Error handling cancel redirect:`, error);
        res.redirect('/payment-cancelled.html?status=cancelled&error=processing');
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
            // Mark order as failed and log the error
            // await updateOrderStatus(orderReference, 'failed', { error_code: errorCode });
            // await logPaymentFailure({ order_reference: orderReference, error_code: errorCode });
            console.log(`[${sessionId}] Order failed: ${orderReference}, Error: ${errorCode}`);
        }
        
        // Provide user-friendly error messages
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
        
        res.redirect(`/payment-failed.html?${failureParams}`);
        
    } catch (error) {
        console.error(`[${sessionId}] Error handling failure redirect:`, error);
        res.redirect('/payment-failed.html?status=failed&error=processing');
    }
});

// Optional: Order status lookup endpoint
app.get('/order-status/:reference', async (req, res) => {
    try {
        const orderReference = req.params.reference;
        
        if (!orderReference) {
            return res.status(400).json({ error: 'Order reference required' });
        }
        
        // Fetch order details from database
        // const orderDetails = await getOrderDetails(orderReference);
        
        // For now, return a placeholder response
        res.json({
            order_reference: orderReference,
            status: 'pending', // This should come from your database
            timestamp: new Date().toISOString(),
            message: 'Order status lookup - implement database integration'
        });
        
    } catch (error) {
        console.error('Error fetching order status:', error);
        res.status(500).json({ error: 'Failed to fetch order status' });
    }
});

// Error handling middleware for the checkout routes
app.use('/yoco*', (error, req, res, next) => {
    console.error('Yoco route error:', error);
    res.status(500).json({
        error: 'Payment service error',
        message: 'An unexpected error occurred in the payment service',
        timestamp: new Date().toISOString()
    });
});

// Export configuration for use in other files
module.exports = {
    YOCO_CONFIG,
    validateCheckoutInput,
    makeYocoRequest
};

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Yoco API endpoint: ${YOCO_CONFIG.API_BASE_URL}/checkouts`);
    console.log(`API key configured: ${process.env.YOCO_SECRET_KEY ? 'Yes' : 'No'}`);
});