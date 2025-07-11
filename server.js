const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const axios = require('axios');
const cors = require('cors');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// ✅ This must exist!
app.post('/pay', async (req, res) => {
  try {
    const response = await axios.post(
      'https://online.yoco.com/checkouts',
      {
        amount: req.body.amount,
        currency: 'ZAR',
        name: 'Eezy Spaza Order',
        redirect_url: 'https://eezyspaza.site/thanks.html'
      },
      {
        headers: {
          'X-Secret-Key': process.env.YOCO_SECRET_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    res.json({ checkoutUrl: response.data.checkout_url });
  } catch (err) {
    console.error('Payment error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Payment failed' });
  }
});

app.get('/', (req, res) => {
  res.send('Eezy Spaza backend is running.');
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
