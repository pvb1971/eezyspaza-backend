const express = require("express");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const axios = require("axios");

dotenv.config();
const app = express();
app.use(bodyParser.json());

app.post("/pay", async (req, res) => {
  const { amount } = req.body;

  if (!amount || typeof amount !== "number") {
    return res.status(400).json({ error: "Invalid or missing amount" });
  }

  try {
    console.log("🔍 Sending payment request to Yoco with amount:", amount);
    const response = await axios.post(
      "https://online.yoco.com/v1/once_off_payment_links/",
      {
        amountInCents: amount,
        currency: "ZAR",
      },
      {
        headers: {
          "X-Auth-Secret-Key": process.env.YOCO_SECRET_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Yoco response:", response.data);
    const checkoutUrl = response.data?.redirectUrl;

    if (!checkoutUrl) {
      throw new Error("Missing redirectUrl in response");
    }

    res.json({ checkoutUrl });
  } catch (error) {
    console.error("❌ Yoco Payment Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Payment failed" });
  }
});

app.get("/", (req, res) => {
  res.send("Eezy Spaza backend is running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
