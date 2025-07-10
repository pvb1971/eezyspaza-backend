const express = require('express');
const bodyParser = require('body-parser');
require('dotenv').config();
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const PORT = 3000;

app.post('/pay', async (req, res) => {
  const { token, amountInCents } = req.body;

  try {
    const response = await axios.post(
      'https://online.yoco.com/v1/charges/',
      {
        token,
        amountInCents,
        currency: 'ZAR'
      },
      {
        headers: {
          'X-Secret-Key': process.env.YOCO_SECRET_KEY
        }
      }
    );

    res.json({ message: '✅ Payment successful!' });
  } catch (error) {
    res.status(500).json({ message: '❌ Payment failed.', error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
