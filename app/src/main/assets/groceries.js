// groceries.js
document.addEventListener("DOMContentLoaded", function () {
    console.log("groceries.js: DOMContentLoaded fired");

    function getTrolley() {
        try {
            const storedTrolley = localStorage.getItem("trolley");
            const trolley = storedTrolley ? JSON.parse(storedTrolley) : [];
            console.log("groceries.js: Retrieved trolley from localStorage:", JSON.stringify(trolley));
            return trolley;
        } catch (e) {
            console.error("groceries.js: Error parsing trolley from localStorage:", e);
            return [];
        }
    }

    function saveTrolley(trolley) {
        try {
            localStorage.setItem("trolley", JSON.stringify(trolley));
            console.log("groceries.js: Trolley saved to localStorage:", JSON.stringify(trolley));
            updateNavbarTrolleyCount();
        } catch (e) {
            console.error("groceries.js: Error saving trolley to localStorage:", e);
        }
    }

    function addToTrolley(item) {
        console.log("groceries.js: Attempting to add to trolley:", JSON.stringify(item));
        if (!item || !item.id) {
            console.warn("groceries.js: Invalid item (missing id):", JSON.stringify(item));
            return;
        }
        // Use fallback values if name or price are missing
        item.name = item.name || `Product ${item.id}`;
        item.price = parseFloat(item.price) || 0;
        item.imageSrc = item.imageSrc || "file:///android_asset/groceries_pics/placeholder.png";
        item.quantity = 1;

        let trolley = getTrolley();
        const existingItem = trolley.find(trolleyItem => trolleyItem.id === item.id);

        if (existingItem) {
            existingItem.quantity = (parseInt(existingItem.quantity) || 1) + 1;
            console.log("groceries.js: Updated quantity for item:", JSON.stringify(existingItem));
        } else {
            trolley.push(item);
            console.log("groceries.js: Added new item to trolley:", JSON.stringify(item));
        }

        saveTrolley(trolley);
        alert(`${item.name} added to trolley!`);
    }

    function updateNavbarTrolleyCount() {
        console.log("groceries.js: Updating navbar trolley count");
        const trolley = getTrolley();
        const trolleyCountElement = document.getElementById("trolleyCount");
        if (trolleyCountElement) {
            const totalItems = trolley.reduce((sum, item) => sum + (parseInt(item.quantity) || 1), 0);
            trolleyCountElement.textContent = totalItems || "0";
            console.log("groceries.js: Updated navbar trolley count:", totalItems);
        } else {
            console.error("groceries.js: trolleyCount element not found");
        }
    }

    // Attach event listeners to add-to-trolley buttons
    const addToTrolleyButtons = document.querySelectorAll(".add-to-trolley");
    console.log("groceries.js: Found", addToTrolleyButtons.length, "add-to-trolley buttons");
    if (addToTrolleyButtons.length === 0) {
        console.error("groceries.js: No add-to-trolley buttons found. Check HTML selectors.");
    }

    addToTrolleyButtons.forEach(button => {
        button.addEventListener("click", function () {
            const item = {
                id: this.dataset.id,
                name: this.dataset.name,
                price: this.dataset.price,
                imageSrc: this.dataset.imageSrc
            };
            console.log("groceries.js: Add-to-trolley clicked, item:", JSON.stringify(item));
            addToTrolley(item);
        });
    });

    // Initial navbar update
    try {
        console.log("groceries.js: Initial navbar update");
        updateNavbarTrolleyCount();
    } catch (e) {
        console.error("groceries.js: Error during initial navbar update:", e);
    }
});