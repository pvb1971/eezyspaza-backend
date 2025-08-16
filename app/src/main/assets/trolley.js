document.addEventListener("DOMContentLoaded", () => {
    console.log("trolley.js: DOMContentLoaded fired");

    const trolleyItemsContainer = document.getElementById("trolleyItemsContainer");
    const trolleySubtotalElement = document.getElementById("trolleySubtotal");
    const trolleyVatElement = document.getElementById("trolleyVat");
    const trolleyTotalElement = document.getElementById("trolleyTotal");
    const checkoutButton = document.getElementById("checkoutButton");
    const clearTrolleyButton = document.getElementById("clearTrolleyButton");
    const navbarTrolleyCountElement = document.getElementById("trolleyCount");

    const VAT_RATE = 0.15; // Make sure this matches your backend if it recalculates

    if (!trolleyItemsContainer || !trolleySubtotalElement || !trolleyVatElement || !trolleyTotalElement || !checkoutButton || !clearTrolleyButton) {
        console.error("trolley.js: One or more essential HTML elements for trolley display/functionality are missing. Check IDs.");
        if (trolleyItemsContainer) {
            trolleyItemsContainer.innerHTML = "<p>Error: Trolley page elements are missing or misconfigured.</p>";
        }
    } else {
        console.log("trolley.js: All essential HTML display elements found.");
    }
    if (!navbarTrolleyCountElement) {
        console.warn("trolley.js: Navbar trolley count element (trolleyCount) not found. Count will not be displayed.");
    }

    function getTrolleyFromStorage() {
        try {
            const storedTrolley = localStorage.getItem("trolley");
            if (!storedTrolley) {
                return [];
            }
            const trolley = JSON.parse(storedTrolley);
            if (Array.isArray(trolley)) {
                const validTrolley = trolley.filter(item => item && typeof item.id !== 'undefined' && typeof item.price !== 'undefined' && typeof item.quantity !== 'undefined');
                if (validTrolley.length !== trolley.length) {
                    console.warn("trolley.js: Some items in localStorage trolley were invalid/incomplete and have been filtered out.");
                }
                return validTrolley;
            } else {
                console.warn("trolley.js: 'trolley' in localStorage was not an array. Clearing and returning empty.");
                localStorage.removeItem("trolley");
                return [];
            }
        } catch (e) {
            console.error("trolley.js: Error parsing 'trolley' from localStorage. Data may be corrupt.", e);
            localStorage.removeItem("trolley");
            return [];
        }
    }

    function saveTrolleyToStorage(trolley) {
        try {
            localStorage.setItem("trolley", JSON.stringify(trolley));
            console.log("trolley.js: Trolley saved. Items:", trolley.length);
            updateNavbarTrolleyCount(trolley);
        } catch (e) {
            console.error("trolley.js: Error saving trolley to localStorage:", e);
            alert("Could not save trolley changes.");
        }
    }

    function calculateAndDisplayTotals(trolley) {
        let subtotal = 0;
        trolley.forEach(item => {
            const price = parseFloat(item.price) || 0;
            const quantity = parseInt(item.quantity) || 0;
            subtotal += price * quantity;
        });

        const vat = subtotal * VAT_RATE;
        const total = subtotal + vat;

        if (trolleySubtotalElement) trolleySubtotalElement.textContent = `R${subtotal.toFixed(2)}`;
        if (trolleyVatElement) trolleyVatElement.textContent = `R${vat.toFixed(2)}`;
        if (trolleyTotalElement) trolleyTotalElement.textContent = `R${total.toFixed(2)}`;
        return { subtotal, vat, total }; // Return the calculated values
    }

    function renderTrolleyItems() {
        console.log("trolley.js: Starting renderTrolleyItems()");
        if (!trolleyItemsContainer) {
            console.error("trolley.js: Cannot render items, trolleyItemsContainer is missing.");
            return;
        }
        trolleyItemsContainer.innerHTML = "";
        const currentTrolley = getTrolleyFromStorage();

        if (currentTrolley.length === 0) {
            console.log("trolley.js: Trolley is empty.");
            trolleyItemsContainer.innerHTML = "<p>Your trolley is empty. <a href='groceries.html'>Go shopping!</a></p>";
            if (checkoutButton) checkoutButton.disabled = true;
        } else {
            console.log(`trolley.js: Rendering ${currentTrolley.length} item(s).`);
            currentTrolley.forEach((item, index) => {
                const itemPrice = parseFloat(item.price) || 0;
                const itemQuantity = parseInt(item.quantity) || 1;
                const lineTotal = itemPrice * itemQuantity;
                const imageSrc = item.imageSrc || "file:///android_asset/groceries_pics/placeholder.png";

                const itemElement = document.createElement("div");
                itemElement.classList.add("trolley-item-card");
                itemElement.innerHTML = `
                    <img src="${imageSrc}" alt="${item.name || 'Product Image'}" class="trolley-item-image" onerror="this.onerror=null;this.src='file:///android_asset/groceries_pics/placeholder.png';">
                    <div class="trolley-item-details">
                        <span class="trolley-item-name">${item.name || `Product ID: ${item.id}`}</span>
                        <div class="trolley-item-quantity-controls">
                            <button class="quantity-decrease" data-index="${index}">-</button>
                            <span class="trolley-item-quantity">${itemQuantity}</span>
                            <button class="quantity-increase" data-index="${index}">+</button>
                        </div>
                        <span class="trolley-item-price-unit">@ R${itemPrice.toFixed(2)}</span>
                    </div>
                    <div class="trolley-item-summary">
                        <span class="trolley-item-subtotal">R${lineTotal.toFixed(2)}</span>
                        <button class="remove-item-btn" data-index="${index}">Remove</button>
                    </div>
                `;
                trolleyItemsContainer.appendChild(itemElement);
            });
            if (checkoutButton) checkoutButton.disabled = false;
            addEventListenersToControls();
        }
        calculateAndDisplayTotals(currentTrolley);
        updateNavbarTrolleyCount(currentTrolley);
    }

    function updateNavbarTrolleyCount(trolley) {
        if (navbarTrolleyCountElement) {
            const totalItems = trolley.reduce((sum, item) => sum + (parseInt(item.quantity) || 0), 0);
            navbarTrolleyCountElement.textContent = totalItems;
        }
    }

    function addEventListenersToControls() {
        if (!trolleyItemsContainer) return;
        trolleyItemsContainer.addEventListener('click', (event) => {
            const target = event.target;
            const itemIndex = parseInt(target.dataset.index);
            if (isNaN(itemIndex)) return;

            if (target.classList.contains('quantity-decrease')) {
                updateItemQuantity(itemIndex, -1);
            } else if (target.classList.contains('quantity-increase')) {
                updateItemQuantity(itemIndex, 1);
            } else if (target.classList.contains('remove-item-btn')) {
                removeItemFromTrolley(itemIndex);
            }
        });
    }

    function updateItemQuantity(index, change) {
        console.log(`trolley.js: Updating quantity for item at index ${index} by ${change}.`);
        let trolley = getTrolleyFromStorage();
        if (index >= 0 && index < trolley.length) {
            const currentQuantity = parseInt(trolley[index].quantity) || 0;
            trolley[index].quantity = Math.max(0, currentQuantity + change); // Ensure quantity doesn't go below 0
            if (trolley[index].quantity === 0) {
                 // Optionally, ask before removing if quantity becomes 0, or just remove
                console.log(`trolley.js: Item "${trolley[index].name}" quantity became 0, removing.`);
                trolley.splice(index, 1);
            }
            saveTrolleyToStorage(trolley);
            renderTrolleyItems(); // Re-render to update display and totals
        } else {
            console.warn(`trolley.js: Invalid index ${index} for updateItemQuantity.`);
        }
    }

    function removeItemFromTrolley(index) {
        console.log(`trolley.js: Attempting to remove item at index ${index}.`);
        let trolley = getTrolleyFromStorage();
        if (index >= 0 && index < trolley.length) {
            if (confirm(`Are you sure you want to remove "${trolley[index].name || 'this item'}" from your trolley?`)) {
                trolley.splice(index, 1);
                saveTrolleyToStorage(trolley);
                renderTrolleyItems(); // Re-render to update display and totals
            } else {
                console.log("trolley.js: Item removal cancelled by user.");
            }
        } else {
            console.warn(`trolley.js: Invalid index ${index} for removeItemFromTrolley.`);
        }
    }

    if (clearTrolleyButton) {
        clearTrolleyButton.addEventListener("click", () => {
            console.log("trolley.js: 'Clear Trolley' button clicked.");
            if (confirm("Are you sure you want to empty your entire trolley?")) {
                localStorage.removeItem("trolley");
                // Clear any other related checkout data if you were using it
                localStorage.removeItem('checkoutSubtotal');
                localStorage.removeItem('checkoutVat');
                localStorage.removeItem('checkoutTotal');
                localStorage.removeItem('checkoutItemsForDisplay');
                console.log("trolley.js: Trolley and related checkout data cleared from localStorage.");
                renderTrolleyItems();
                alert("Trolley has been cleared!");
            } else {
                console.log("trolley.js: Clear trolley action cancelled by user.");
            }
        });
    }

    // --- "Proceed to Checkout" LOGIC using /create-checkout (Yoco Redirect Flow) ---
    if (checkoutButton) {
        checkoutButton.addEventListener("click", async () => {
            console.log("trolley.js: 'Proceed to Checkout' button clicked (Yoco /create-checkout flow).");

            const currentTrolley = getTrolleyFromStorage();
            if (currentTrolley.length === 0) {
                alert("Your trolley is empty. Please add items before checking out.");
                return;
            }

            const totals = calculateAndDisplayTotals(currentTrolley); // Recalculate and get total
            if (totals.total <= 0) { // Basic check for valid total
                 alert("The total amount is invalid. Please check your trolley items.");
                 return;
            }

            // Disable button and show loading state
            checkoutButton.disabled = true;
            checkoutButton.textContent = 'Initializing Payment...';

            // --- Construct order details for /create-checkout ---
            const orderItemsForMetadata = currentTrolley.map(item => ({
                id: item.id,
                name: item.name,
                quantity: item.quantity,
                price: parseFloat(item.price).toFixed(2) // Ensure price is formatted
            }));

            // DEFINE YOUR BACKEND URL AND SUCCESS/CANCEL PAGES
            const backendBaseUrl = 'https://eezyspaza-backend1.onrender.com'; // Your actual backend URL
            const successRedirectUrl = `${backendBaseUrl}/yoco-payment-success`;
            const cancelRedirectUrl = `${backendBaseUrl}/yoco-payment-cancel`;
            // Optional: const failureRedirectUrl = `${backendBaseUrl}/yoco-payment-failure`;

            const orderDataForBackend = {
                amount: totals.total.toFixed(2), // Send as string like "26.44"
                currency: 'ZAR',
                successUrl: successRedirectUrl,
                cancelUrl: cancelRedirectUrl,
                // failureUrl: failureRedirectUrl, // Optional
                metadata: {
                    order_reference: "EazySpaza_Order_" + Date.now(), // Example reference
                    customer_name: "Valued Customer", // Replace with actual customer name if available
                    items: JSON.stringify(orderItemsForMetadata) // Stringify items for metadata
                    // You can add more metadata your backend might find useful
                },
                // customer: { // Optional: if you collect customer details beforehand
                //     name: "John Doe",
                //     email: "john.doe@example.com"
                // }
            };

            try {
                console.log("trolley.js: Calling backend /create-checkout with payload:", orderDataForBackend);
                const response = await fetch(`${backendBaseUrl}/create-checkout`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(orderDataForBackend),
                });

                const data = await response.json();

                if (response.ok && data.redirectUrl) {
                    console.log("trolley.js: Received redirect URL from server:", data.redirectUrl);
                    // Redirect the user to Yoco's hosted payment page
                    window.location.href = data.redirectUrl;
                    // No need to re-enable button here as we are navigating away
                } else {
                    console.error("trolley.js: Failed to create Yoco checkout:", data.message || data.error || "Unknown error from server");
                    alert("Could not initialize payment. " + (data.message || data.error || "Please try again."));
                    checkoutButton.disabled = false;
                    checkoutButton.textContent = 'Proceed to Checkout';
                }
            } catch (error) {
                console.error("trolley.js: Network or other error calling /create-checkout:", error);
                alert("An error occurred while setting up your payment. Please check your connection and try again.");
                checkoutButton.disabled = false;
                checkoutButton.textContent = 'Proceed to Checkout';
            }
        });
    } else {
        console.warn("trolley.js: Checkout button (checkoutButton) not found.");
    }

    console.log("trolley.js: Performing initial render of trolley items.");
    renderTrolleyItems(); // Initial render
});
