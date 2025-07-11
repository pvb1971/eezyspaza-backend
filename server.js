app.post("/pay", async (req, res) => {
  const { amount } = req.body;

  if (!amount || typeof amount !== "number") {
    return res.status(400).json({ error: "Invalid or missing amount" });
  }

  try {
    const response = await axios.post(
      "https://online.yoco.com/v1/charges/",
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

    res.json({ checkoutUrl: response.data.redirect_url });
  } catch (error) {
    console.error("Yoco Payment Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Payment failed" });
  }
});
