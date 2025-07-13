const express = require('express');
const app = express();

// Enable CORS for WebView and local testing
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*'); // Allow all origins for testing
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') {
        console.log('Backend: Handling OPTIONS preflight request');
        return res.status(200).json({});
    }
    next();
});

app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
    console.log('Backend: Health check accessed');
    res.json({ message: 'Backend is running' });
});

// Pay endpoint
app.post('/pay', async (req, res) => {
    const { amount, items } = req.body;
    console.log('Backend: Received payment request:', { amount, items });

    // Validate request
    if (!amount || amount <= 0) {
        console.error('Backend: Invalid amount:', amount);
        return res.status(400).json({ message: 'Invalid amount' });
    }

    // Mock payment gateway integration
    try {
        const checkoutUrl = 'https://payment-gateway.com/checkout/123';
        console.log('Backend: Generated checkout URL:', checkoutUrl);
        res.json({ checkoutUrl });
    } catch (error) {
        console.error('Backend: Payment processing error:', error);
        res.status(500).json({ message: 'Payment processing failed' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});