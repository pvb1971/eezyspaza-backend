// SERVER.JS - Complete Version with Product Management
// KEY FIX: Orders only created/completed AFTER payment verification

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const crypto = require('crypto');
const twilio = require('twilio');
const admin = require('firebase-admin');

dotenv.config();

// Initialize Firebase Admin
if (!admin.apps.length) {
    try {
        let firebaseConfig;
        try {
            const serviceAccount = require('./serviceAccountKey.json');
            firebaseConfig = {
                credential: admin.credential.cert(serviceAccount),
                databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://eezy-spaza-default-rtdb.firebaseio.com/'
            };
            console.log('Using JSON file for Firebase credentials');
        } catch (jsonError) {
            firebaseConfig = {
                credential: admin.credential.cert({
                    projectId: process.env.FIREBASE_PROJECT_ID,
                    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
                }),
                databaseURL: process.env.FIREBASE_DATABASE_URL
            };
            console.log('Using environment variables for Firebase credentials');
        }
        admin.initializeApp(firebaseConfig);
        console.log('✅ Firebase Admin initialized successfully');
    } catch (error) {
        console.error('❌ Firebase Admin initialization failed:', error);
    }
}

const db = admin.firestore();
const app = express();

// CORS Configuration
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    const allowedOrigins = [
      'http://localhost:3001',
      'http://localhost:3000',
      'https://eezyspaza-backend1.onrender.com'
    ];
    if (allowedOrigins.indexOf(origin) !== -1 || origin.startsWith('file://')) {
      callback(null, true);
    } else {
      callback(null, true);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With']
}));

app.use(express.json());
app.use(express.static('public'));

// Initialize Twilio with error handling
let twilioClient = null;
try {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    console.log('✅ Twilio initialized successfully');
    console.log('Twilio Account SID:', process.env.TWILIO_ACCOUNT_SID.substring(0, 10) + '...');
  } else {
    console.warn('⚠️ Twilio credentials not found - WhatsApp notifications disabled');
  }
} catch (twilioError) {
  console.error('❌ Twilio initialization failed:', twilioError.message);
}

console.log('Twilio client status:', twilioClient ? 'Ready' : 'Not configured');

// ============================================
// PRODUCT MANAGEMENT ENDPOINTS
// ============================================

// Get all products
app.get('/api/products', async (req, res) => {
    const requestId = `products_${Date.now()}`;
    console.log(`[${requestId}] Fetching all products`);
    
    try {
        const productsRef = db.collection('products');
        const snapshot = await productsRef
            .where('active', '==', true)
            .orderBy('name', 'asc')
            .get();
        
        const products = [];
        snapshot.forEach(doc => {
            products.push({
                id: doc.id,
                ...doc.data()
            });
        });
        
        console.log(`[${requestId}] Found ${products.length} products`);
        
        res.json({
            success: true,
            count: products.length,
            products: products
        });
        
    } catch (error) {
        console.error(`[${requestId}] Error:`, error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch products',
            message: error.message
        });
    }
});

// Get single product
app.get('/api/products/:id', async (req, res) => {
    try {
        const productDoc = await db.collection('products').doc(req.params.id).get();
        
        if (!productDoc.exists) {
            return res.status(404).json({
                success: false,
                error: 'Product not found'
            });
        }
        
        res.json({
            success: true,
            product: {
                id: productDoc.id,
                ...productDoc.data()
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to fetch product',
            message: error.message
        });
    }
});

// Add product
app.post('/api/products', async (req, res) => {
    try {
        const { name, price, stock, category, description, image_url } = req.body;
        
        if (!name || !price || stock === undefined) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields',
                required: ['name', 'price', 'stock']
            });
        }
        
        const productData = {
            name,
            price: parseFloat(price),
            stock: parseInt(stock),
            category: category || 'Uncategorized',
            description: description || '',
            image_url: image_url || '',
            active: true,
            created_at: admin.firestore.FieldValue.serverTimestamp(),
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        };
        
        const docRef = await db.collection('products').add(productData);
        
        res.json({
            success: true,
            message: 'Product added successfully',
            productId: docRef.id,
            product: {
                id: docRef.id,
                ...productData
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to add product',
            message: error.message
        });
    }
});

// Update product
app.put('/api/products/:id', async (req, res) => {
    try {
        const productRef = db.collection('products').doc(req.params.id);
        const productDoc = await productRef.get();
        
        if (!productDoc.exists) {
            return res.status(404).json({
                success: false,
                error: 'Product not found'
            });
        }
        
        const updates = {
            ...req.body,
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        };
        
        delete updates.id;
        delete updates.created_at;
        
        await productRef.update(updates);
        
        res.json({
            success: true,
            message: 'Product updated successfully',
            productId: req.params.id
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to update product',
            message: error.message
        });
    }
});

// Delete product (soft delete)
app.delete('/api/products/:id', async (req, res) => {
    try {
        const productRef = db.collection('products').doc(req.params.id);
        const productDoc = await productRef.get();
        
        if (!productDoc.exists) {
            return res.status(404).json({
                success: false,
                error: 'Product not found'
            });
        }
        
        await productRef.update({
            active: false,
            deleted_at: admin.firestore.FieldValue.serverTimestamp(),
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        });
        
        res.json({
            success: true,
            message: 'Product deleted successfully',
            productId: req.params.id
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to delete product',
            message: error.message
        });
    }
});

// ============================================
// WHATSAPP NOTIFICATIONS
// ============================================

async function sendWhatsAppNotification(orderData, status) {
  try {
    // Detailed logging for debugging
    console.log('=== WhatsApp Notification Attempt ===');
    console.log('Twilio SID configured:', !!process.env.TWILIO_ACCOUNT_SID);
    console.log('Twilio Token configured:', !!process.env.TWILIO_AUTH_TOKEN);
    
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      console.log('WhatsApp skipped: Twilio not configured');
      return { success: false, error: 'Twilio not configured' };
    }

    const phoneNumber = orderData.customer_info?.customer_phone || 
                       orderData.metadata?.customer_phone || '';
    
    console.log('Raw phone number:', phoneNumber);
    
    if (!phoneNumber || phoneNumber === 'No phone' || phoneNumber.trim() === '') {
      console.log('WhatsApp skipped: No phone number provided');
      return { success: false, error: 'No phone number' };
    }
    
    // Format phone number
    let formattedPhone = phoneNumber.replace(/[\s\-\(\)]/g, '');
    
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '+27' + formattedPhone.substring(1);
    } else if (formattedPhone.startsWith('27')) {
      formattedPhone = '+' + formattedPhone;
    } else if (!formattedPhone.startsWith('+')) {
      formattedPhone = '+27' + formattedPhone;
    }
    
    console.log('Formatted phone:', formattedPhone);
    
    if (!/^\+27[0-9]{9}$/.test(formattedPhone)) {
      console.log('WhatsApp skipped: Invalid phone format');
      return { success: false, error: 'Invalid phone format: ' + formattedPhone };
    }
    
    const whatsappNumber = `whatsapp:${formattedPhone}`;
    const customerName = orderData.customer_info?.customer_name || 
                        orderData.metadata?.customer_name || 'Customer';
    const orderRef = (orderData.order_reference || 'N/A').slice(-8);
    const total = (orderData.amount_display || orderData.amount_cents / 100 || 0).toFixed(2);
    
    let message = `EezySpaza Order Update\n\nOrder #${orderRef}\nStatus: ${status}\nTotal: R${total}\n\nThank you, ${customerName}!`;
    
    console.log('Sending WhatsApp to:', whatsappNumber);
    console.log('Message:', message);
    
    // Verify Twilio client is initialized
    if (!twilioClient) {
      console.error('Twilio client not initialized');
      return { success: false, error: 'Twilio client not initialized' };
    }
    
    const result = await twilioClient.messages.create({
      from: 'whatsapp:+14155238886',
      to: whatsappNumber,
      body: message
    });
    
    console.log('✅ WhatsApp sent successfully:', result.sid);
    return { success: true, messageId: result.sid };
    
  } catch (error) {
    console.error('❌ WhatsApp notification error:', error.message);
    console.error('Error code:', error.code);
    console.error('Error status:', error.status);
    console.error('Full error:', JSON.stringify(error, null, 2));
    
    // Return failure but don't block order creation
    return { 
      success: false, 
      error: error.message,
      code: error.code,
      status: error.status
    };
  }
}

// ============================================
// YOCO PAYMENT FUNCTIONS
// ============================================

const YOCO_CONFIG = {
    API_BASE_URL: 'https://payments.yoco.com/api',
    MIN_AMOUNT_CENTS: 500,
    MAX_AMOUNT_CENTS: 10000000,
    WEBHOOK_TIMEOUT_MS: 30000,
    API_TIMEOUT_MS: 15000,
    RETRY_ATTEMPTS: 2
};

// Store PENDING order - not yet completed
async function storePendingOrder(orderData) {
    try {
        const customerInfo = {
            customer_name: orderData.metadata?.customer_name || 'Unknown',
            customer_email: orderData.metadata?.customer_email || '',
            customer_phone: orderData.metadata?.customer_phone || '',
            customer_address: orderData.metadata?.customer_address || '',
            customer_city: orderData.metadata?.customer_city || ''
        };

        const docRef = await db.collection('pending_payments').add({
            ...orderData,
            customer_info: customerInfo,
            status: 'awaiting_payment',
            created_at: admin.firestore.FieldValue.serverTimestamp(),
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`Stored pending payment: ${docRef.id}`);
        return docRef.id;
    } catch (error) {
        console.error('Firebase storage error:', error);
        throw error;
    }
}

// NEW: Create actual order AFTER payment success
async function createCompletedOrder(pendingOrderData, paymentDetails) {
    try {
        const orderData = {
            ...pendingOrderData,
            payment_details: paymentDetails,
            status: 'completed',
            payment_completed_at: admin.firestore.FieldValue.serverTimestamp(),
            created_at: admin.firestore.FieldValue.serverTimestamp(),
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        };

        // Create in orders collection
        const docRef = await db.collection('orders').add(orderData);
        
        // Update product stock
        if (orderData.items && Array.isArray(orderData.items)) {
            const batch = db.batch();
            
            for (const item of orderData.items) {
                if (item.id) {
                    const productRef = db.collection('products').doc(item.id);
                    const productDoc = await productRef.get();
                    
                    if (productDoc.exists) {
                        const currentStock = productDoc.data().stock || 0;
                        const newStock = currentStock - (item.quantity || 1);
                        
                        batch.update(productRef, {
                            stock: Math.max(0, newStock),
                            updated_at: admin.firestore.FieldValue.serverTimestamp()
                        });
                    }
                }
            }
            
            await batch.commit();
            console.log('Product stock updated');
        }
        
        // Send WhatsApp notification
        await sendWhatsAppNotification(orderData, 'completed');

        console.log(`Created completed order: ${docRef.id}`);
        return docRef.id;
    } catch (error) {
        console.error('Error creating completed order:', error);
        throw error;
    }
}

// Get pending order by checkout ID
async function getPendingOrderByCheckoutId(checkoutId) {
    try {
        const snapshot = await db.collection('pending_payments')
            .where('yoco_checkout_id', '==', checkoutId)
            .limit(1)
            .get();
        
        if (snapshot.empty) {
            return null;
        }
        
        const doc = snapshot.docs[0];
        return {
            id: doc.id,
            ...doc.data()
        };
    } catch (error) {
        console.error('Error fetching pending order:', error);
        return null;
    }
}

// Verify payment with Yoco API
async function verifyYocoPayment(checkoutId, paymentId) {
    try {
        const apiKey = process.env.YOCO_SECRET_KEY;
        
        // Try to get checkout details
        const checkoutResponse = await fetch(`${YOCO_CONFIG.API_BASE_URL}/checkouts/${checkoutId}`, {
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
            const paymentResponse = await fetch(`${YOCO_CONFIG.API_BASE_URL}/payments/${paymentId}`, {
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

function validateCheckoutInput(body) {
    const errors = [];
    const requiredFields = ['amount', 'currency', 'successUrl', 'cancelUrl'];
    const missingFields = requiredFields.filter(field => !body[field]);
    if (missingFields.length > 0) {
        errors.push(`Missing required fields: ${missingFields.join(', ')}`);
    }
    const amountFloat = parseFloat(body.amount);
    if (isNaN(amountFloat) || amountFloat <= 0) {
        errors.push('Amount must be a positive number');
    }
    return { isValid: errors.length === 0, errors, amountFloat };
}

async function makeYocoRequest(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), YOCO_CONFIG.API_TIMEOUT_MS);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
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

// ============================================
// PAYMENT ENDPOINTS
// ============================================

app.post('/create-checkout', async (req, res) => {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
        console.log(`[${requestId}] Creating checkout`);
        
        const validation = validateCheckoutInput(req.body);
        if (!validation.isValid) {
            return res.status(400).json({
                error: 'Input validation failed',
                details: validation.errors
            });
        }

        const amountInCents = Math.round(validation.amountFloat * 100);

        if (amountInCents < YOCO_CONFIG.MIN_AMOUNT_CENTS || amountInCents > YOCO_CONFIG.MAX_AMOUNT_CENTS) {
            return res.status(400).json({ error: 'Amount out of range' });
        }

        if (!process.env.YOCO_SECRET_KEY) {
            return res.status(500).json({ error: 'Server configuration error' });
        }

        const orderReference = req.body.metadata?.order_reference ||
            `ORDER_${Date.now()}_${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

        const yocoPayload = {
            amount: amountInCents,
            currency: req.body.currency || 'ZAR',
            cancelUrl: req.body.cancelUrl || 'https://eezyspaza-backend1.onrender.com/yoco-payment-cancel',
            successUrl: req.body.successUrl || 'https://eezyspaza-backend1.onrender.com/yoco-payment-success',
            failureUrl: req.body.failureUrl || 'https://eezyspaza-backend1.onrender.com/yoco-payment-failure',
            metadata: {
                order_reference: orderReference,
                customer_name: req.body.metadata?.customer_name || 'Customer',
                customer_email: req.body.metadata?.customer_email || '',
                customer_phone: req.body.metadata?.customer_phone || '',
                request_id: requestId,
                timestamp: new Date().toISOString()
            }
        };

        let yocoResponse;
        for (let attempt = 1; attempt <= YOCO_CONFIG.RETRY_ATTEMPTS; attempt++) {
            try {
                yocoResponse = await makeYocoRequest(`${YOCO_CONFIG.API_BASE_URL}/checkouts`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(yocoPayload)
                });
                break;
            } catch (error) {
                if (attempt === YOCO_CONFIG.RETRY_ATTEMPTS) throw error;
            }
        }

        if (!yocoResponse || !yocoResponse.ok) {
            return res.status(503).json({ error: 'Payment service unavailable' });
        }

        const yocoData = await yocoResponse.json();
        const redirectUrl = yocoData.redirectUrl || yocoData.redirect_url;
        
        if (!redirectUrl) {
            return res.status(500).json({ error: 'Invalid payment response' });
        }

        const lineItems = req.body.line_items || [];
        const detailedItems = lineItems.map(item => ({
            id: item.id || null,
            name: item.name,
            quantity: item.quantity,
            amount: item.amount,
            price: item.amount / 100
        }));

        // IMPORTANT: Update success URL to include checkoutId for verification
        const successUrlWithCheckout = `${yocoPayload.successUrl}?checkoutId=${yocoData.id}&orderRef=${orderReference}`;
        console.log(`[${requestId}] Success URL: ${successUrlWithCheckout}`);

        // Store as PENDING - not completed yet
        await storePendingOrder({
            id: yocoData.id,
            amount: amountInCents,
            line_items: lineItems,
            metadata: yocoPayload.metadata,
            customer_info: {
                customer_name: yocoPayload.metadata.customer_name,
                customer_email: yocoPayload.metadata.customer_email,
                customer_phone: yocoPayload.metadata.customer_phone,
                customer_address: req.body.metadata?.customer_address || '',
                customer_city: req.body.metadata?.customer_city || '',
                customer_postal_code: req.body.metadata?.customer_postal_code || ''
            },
            items: detailedItems,
            order_reference: orderReference,
            amount_cents: amountInCents,
            amount_display: validation.amountFloat,
            currency: 'ZAR',
            yoco_checkout_id: yocoData.id,
            request_id: requestId,
            success_url_with_checkout: successUrlWithCheckout  // Store for reference
        });

        console.log(`[${requestId}] Checkout created, redirect: ${redirectUrl}`);

        res.json({
            redirectUrl: redirectUrl,
            order_reference: orderReference,
            amount_cents: amountInCents,
            checkout_id: yocoData.id,
            request_id: requestId
        });

    } catch (error) {
        console.error(`[${requestId}] Checkout error:`, error);
        res.status(500).json({ error: 'Payment processing error', message: error.message });
    }
});

// SUCCESS HANDLER - Creates order ONLY after payment verified
app.get('/yoco-payment-success', async (req, res) => {
    const sessionId = `success_${Date.now()}`;
    console.log(`[${sessionId}] === PAYMENT SUCCESS HANDLER ===`);
    console.log(`[${sessionId}] Query params:`, req.query);
    console.log(`[${sessionId}] Full URL:`, req.url);
    
    try {
        let checkoutId = req.query.checkoutId;
        const paymentId = req.query.paymentId;
        const orderRef = req.query.orderRef || req.query.order_reference;
        
        // If no checkoutId, try to get it from pending orders using orderRef
        if (!checkoutId && orderRef) {
            console.log(`[${sessionId}] No checkoutId, looking up by order reference: ${orderRef}`);
            const snapshot = await db.collection('pending_payments')
                .where('order_reference', '==', orderRef)
                .limit(1)
                .get();
            
            if (!snapshot.empty) {
                const pendingOrder = snapshot.docs[0].data();
                checkoutId = pendingOrder.yoco_checkout_id;
                console.log(`[${sessionId}] Found checkoutId from order ref: ${checkoutId}`);
            }
        }
        
        if (!checkoutId) {
            console.log(`[${sessionId}] No checkoutId found - cannot verify payment`);
            return res.redirect(`${process.env.FRONTEND_URL}/payment-failed.html?error=missing_checkout_id`);
        }
        
        console.log(`[${sessionId}] Verifying payment for checkout: ${checkoutId}`);
        
        // 1. Verify payment with Yoco
        const paymentDetails = await verifyYocoPayment(checkoutId, paymentId);
        
        if (!paymentDetails) {
            console.log(`[${sessionId}] Payment verification failed - no details returned`);
            return res.redirect(`${process.env.FRONTEND_URL}/payment-failed.html?error=verification_failed`);
        }
        
        console.log(`[${sessionId}] Payment status:`, paymentDetails.status);
        console.log(`[${sessionId}] Payment ID:`, paymentDetails.paymentId);
        
        // 2. Check if payment was successful
        if (paymentDetails.status === 'successful' || paymentDetails.paymentId) {
            console.log(`[${sessionId}] ✅ Payment successful!`);
            
            // 3. Get pending order
            const pendingOrder = await getPendingOrderByCheckoutId(checkoutId);
            
            if (!pendingOrder) {
                console.log(`[${sessionId}] No pending order found`);
                return res.redirect(`${process.env.FRONTEND_URL}/payment-failed.html?error=order_not_found`);
            }
            
            console.log(`[${sessionId}] Found pending order:`, pendingOrder.id);
            
            // 4. Create completed order (THIS IS WHERE ORDER ACTUALLY GETS CREATED)
            const orderId = await createCompletedOrder(pendingOrder, paymentDetails);
            console.log(`[${sessionId}] ✅ Order created: ${orderId}`);
            
            // 5. Clean up pending payment
            await db.collection('pending_payments').doc(pendingOrder.id).delete();
            console.log(`[${sessionId}] Pending payment cleaned up`);
            
            // 6. Redirect to success
            const successParams = new URLSearchParams({
                status: 'success',
                reference: paymentDetails.metadata?.order_reference || 'unknown',
                amount: paymentDetails.amount / 100,
                order_id: orderId,
                timestamp: new Date().toISOString()
            });
            
            return res.redirect(`${process.env.FRONTEND_URL}/payment-success.html?${successParams}`);
            
        } else {
            // Payment not successful (failed 3D Secure or other issue)
            console.log(`[${sessionId}] ❌ Payment not successful, status: ${paymentDetails.status}`);
            return res.redirect(`${process.env.FRONTEND_URL}/payment-failed.html?error=payment_not_completed&reason=3d_secure_failed`);
        }
        
    } catch (error) {
        console.error(`[${sessionId}] Error:`, error);
        return res.redirect(`${process.env.FRONTEND_URL}/payment-failed.html?error=processing_error`);
    }
});

app.get('/yoco-payment-cancel', async (req, res) => {
    const sessionId = `cancel_${Date.now()}`;
    console.log(`[${sessionId}] Payment cancelled`);
    res.redirect(`${process.env.FRONTEND_URL}/payment-cancelled.html`);
});

app.get('/yoco-payment-failure', async (req, res) => {
    const sessionId = `failure_${Date.now()}`;
    console.log(`[${sessionId}] Payment failed`);
    res.redirect(`${process.env.FRONTEND_URL}/payment-failed.html`);
});

// Get all orders (completed only)
app.get('/admin/orders', async (req, res) => {
    try {
        const snapshot = await db.collection('orders')
            .orderBy('created_at', 'desc')
            .limit(100)
            .get();
        
        const orders = [];
        snapshot.forEach(doc => {
            orders.push({ id: doc.id, ...doc.data() });
        });
        
        res.json({ success: true, count: orders.length, orders });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get pending payments (for debugging)
app.get('/admin/pending-payments', async (req, res) => {
    try {
        const snapshot = await db.collection('pending_payments')
            .orderBy('created_at', 'desc')
            .limit(50)
            .get();
        
        const pending = [];
        snapshot.forEach(doc => {
            pending.push({ id: doc.id, ...doc.data() });
        });
        
        res.json({ success: true, count: pending.length, pending_payments: pending });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.use((error, req, res, next) => {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Server error', message: error.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`API key: ${process.env.YOCO_SECRET_KEY ? 'Configured' : 'MISSING'}`);
    console.log(`Firebase: ${process.env.FIREBASE_PROJECT_ID ? 'Configured' : 'MISSING'}`);
    console.log('✅ Server ready - Orders only created after payment success!');
});