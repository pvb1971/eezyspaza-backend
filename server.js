const express = require('express');
const cors = require('cors');
const app = express();

// Enable CORS
app.use(cors());

// Parse JSON bodies
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
    console.log('Backend: Health check accessed');
    res.json({ message: 'Backend is running' });
});

// Payment endpoint
app.post('/payment', (req, res) => {
    const { amount, items } = req.body;
    console.log('Backend: Received payment request:', { amount, items });

    // Validate request
    if (!amount || amount <= 0 || !items || !Array.isArray(items)) {
        console.error('Backend: Invalid payment data:', { amount, items });
        return res.status(400).json({ message: 'Invalid amount or items' });
    }

    // Mock payment gateway integration (replace with Paystack, Stripe, etc.)
    const checkoutUrl = 'https://payment-gateway.com/checkout/123';
    console.log('Backend: Generated checkout URL:', checkoutUrl);
    res.json({ checkoutUrl });
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => {
    console.log(`Backend running on port ${process.env.PORT || 3000}`);
});