// importProducts.js

const admin = require('firebase-admin');
const cheerio = require('cheerio');
const fs = require('fs');

// --- IMPORTANT: Replace './serviceAccountKey.json' with the correct path to your downloaded key ---
// Make sure this file is secure and NOT publicly accessible.
const serviceAccount = require('./serviceAccountKey.json'); 

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  // If you ever need to interact with Realtime Database, you'd uncomment and set this:
  // databaseURL: "https://eezy-spaza.firebaseio.com" 
});

const db = admin.firestore(); // Get a reference to your Firestore database

async function importProducts() {
  try {
    // Read your HTML file
    const htmlContent = fs.readFileSync('groceries.html', 'utf8');
    const $ = cheerio.load(htmlContent); // Load HTML into Cheerio

    const products = [];

    // Iterate over each product-card div
    $('.product-card').each((index, element) => {
      const id = $(element).attr('data-id');
      const name = $(element).find('h3').text().trim();
      const description = $(element).find('.description').text().trim();
      const priceText = $(element).find('.price').text().trim();
      const imageUrl = $(element).find('img').attr('src');
      
      // Clean up price: remove 'R' and convert to number
      // We also check for 'data-price' on the button as a fallback/primary source if it's more accurate
      const buttonPrice = $(element).find('.add-to-trolley').attr('data-price');
      const price = buttonPrice ? parseFloat(buttonPrice) : parseFloat(priceText.replace('R', ''));

      // Clean up image source: use data-image-src from button if available, otherwise img src
      const buttonImageSrc = $(element).find('.add-to-trolley').attr('data-image-src');
      const finalImageUrl = buttonImageSrc || imageUrl;


      if (id && name && price && finalImageUrl) { // Ensure essential data exists
        products.push({
          id: parseInt(id), // Store ID as a number
          name: name,
          description: description,
          price: price,
          imageUrl: finalImageUrl
        });
      } else {
          console.warn(`Skipping product due to missing data: ID=${id}, Name=${name}, Price=${price}, Image=${finalImageUrl}`);
      }
    });

    console.log(`Found ${products.length} products in HTML. Starting import to Firestore...`);

    // Import products to Firestore
    for (const product of products) {
      // Use the product's ID as the document ID in Firestore for easy retrieval
      // Ensure the ID is a string for .doc() method
      await db.collection('products').doc(String(product.id)).set(product);
      console.log(`Successfully imported product: ${product.name} (ID: ${product.id})`);
    }

    console.log('All products imported successfully!');

  } catch (error) {
    console.error('Error importing products:', error);
  } finally {
    // Ensure the app exits cleanly after the operation
    process.exit(); 
  }
}

// Run the import function
importProducts();
