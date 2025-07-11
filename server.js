require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

// ✅ Yoco /pay route
app.post('/pay', async (req, res) => {
  const amount = req.body.amount;

  try {
    const response = await axios.post(
      'https://online.yoco.com/v1/checkout/session',
      {
        amount,
        currency: 'ZAR',
        name: 'Eezy Spaza',
        description: 'Your purchase',
        redirect_url: 'https://eezyspaza.com/success' // or any valid URL
      },
      {
        headers: {
          'X-Auth-Secret-Key': process.env.YOCO_SECRET_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({ checkoutUrl: response.data.checkout_url });
  } catch (error) {
    console.error('Yoco API error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to create Yoco payment session' });
  }
});

// ✅ Root route for testing
app.get('/', (req, res) => {
  res.send('Eezy Spaza backend is running.');
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
