const express = require("express");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const axios = require("axios");

dotenv.config();

const app = express();
app.use(bodyParser.json());

// ✅ Health check route
app.get("/", (req, res) => {
  res.send("Eezy Spaza backend is running!");
});

// Your /pay route (and others) below
app.post("/pay", async (req, res) => {
  // your Yoco payment logic
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
