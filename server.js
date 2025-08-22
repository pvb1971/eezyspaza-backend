// server.js
import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Middleware
app.use(cors());
app.use(bodyParser.json());

// ✅ Firebase init
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}
const db = admin.firestore();

// ✅ Root route
app.get("/", (req, res) => {
  res.send("✅ EezySpaza Backend is running!");
});

// ✅ Create Checkout
app.post("/create-checkout", async (req, res) => {
  try {
    console.log("INCOMING REQUEST: POST /create-checkout");

    const { amount } = req.body;

    const orderRef = await db.collection("orders").add({
      amount,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log("Order added to Firebase with ID:", orderRef.id);

    const response = await fetch("https://payments.yoco.com/api/checkouts", {
      method: "POST",
      headers: {
        "X-Auth-Secret-Key": process.env.YOCO_SECRET_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount,
        currency: "ZAR",
        successUrl: `http://eezyspaza-backend1.onrender.com/yoco-payment-success?orderId=${orderRef.id}`,
        cancelUrl: `http://eezyspaza-backend1.onrender.com/yoco-payment-cancel?orderId=${orderRef.id}`,
        failureUrl: `http://eezyspaza-backend1.onrender.com/yoco-payment-failure?orderId=${orderRef.id}`,
        metadata: {
          firebase_order_id: orderRef.id,
          order_reference: `EazySpaza_Order_${Date.now()}`,
        },
      }),
    });

    const data = await response.json();
    console.log("Yoco Response (/api/checkouts):", JSON.stringify(data, null, 2));

    await orderRef.update({ checkoutId: data.id });
    console.log("Updated Firebase order with Yoco checkoutId:", data.id);

    res.json(data);
  } catch (error) {
    console.error("Error creating checkout:", error);
    res.status(500).send({ error: error.message });
  }
});

// ✅ Webhook Receiver
app.post("/yoco-webhook-receiver", async (req, res) => {
  try {
    console.log("INCOMING REQUEST: POST /yoco-webhook-receiver");
    console.log("RAW WEBHOOK BODY:", JSON.stringify(req.body));

    const event = req.body;
    const eventType = event.type;
    const orderId = event?.payload?.metadata?.firebase_order_id;

    console.log(`(Webhook) Event type: ${eventType}, Order ID: ${orderId}`);

    if (eventType === "payment.succeeded" && orderId) {
      await db.collection("orders").doc(orderId).update({
        status: "paid",
        paymentId: event.payload.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log("✅ Order updated to PAID:", orderId);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error.message);
    res.sendStatus(400);
  }
});

// ✅ Success Page with Order Details
app.get("/yoco-payment-success", async (req, res) => {
  try {
    const { orderId } = req.query;

    if (!orderId) {
      return res.send("<h1>✅ Payment Successful</h1><p>Order ID missing.</p>");
    }

    const orderDoc = await db.collection("orders").doc(orderId).get();

    if (!orderDoc.exists) {
      return res.send(`<h1>✅ Payment Successful</h1><p>Order not found in Firebase.</p>`);
    }

    const order = orderDoc.data();

    res.send(`
      <h1>✅ Payment Successful</h1>
      <p><b>Order Reference:</b> ${order.order_reference || "N/A"}</p>
      <p><b>Firebase Order ID:</b> ${orderId}</p>
      <p><b>Payment ID:</b> ${order.paymentId || "Pending webhook"}</p>
      <p><b>Amount Paid:</b> R ${(order.amount / 100).toFixed(2)}</p>
    `);
  } catch (error) {
    console.error("Error loading success page:", error.message);
    res.send("<h1>✅ Payment Successful</h1><p>Error loading order details.</p>");
  }
});

// ✅ Cancel Page
app.get("/yoco-payment-cancel", (req, res) => {
  res.send(`
    <h1>❌ Payment Cancelled</h1>
    <p>Your payment was cancelled. Please try again.</p>
  `);
});

// ✅ Failure Page
app.get("/yoco-payment-failure", (req, res) => {
  res.send(`
    <h1>⚠️ Payment Failed</h1>
    <p>There was a problem processing your payment.</p>
  `);
});

// ✅ Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
