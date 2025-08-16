document.addEventListener('DOMContentLoaded', function() {
    console.log('hardware.js: DOMContentLoaded fired');
    function storageAvailable(type) {
        try {
            const storage = window[type];
            const x = '__storage_test__';
            storage.setItem(x, x);
            storage.removeItem(x);
            return true;
        } catch (e) {
            console.error('hardware.js: localStorage not available:', e);
            return false;
        }
    }

    if (!storageAvailable('localStorage')) {
        alert('localStorage is not supported. Trolley functionality may not work.');
        return;
    }

    document.querySelectorAll('.add-to-trolley').forEach(button => {
        button.addEventListener('click', function() {
            const card = this.closest('.product-card');
            if (!card || !card.dataset.id) {
                console.error('hardware.js: Invalid product card or missing data-id');
                return;
            }

            const product = {
                id: card.dataset.id,
                title: card.querySelector('h3').textContent,
                price: parseFloat(card.querySelector('.price').textContent.replace('R', '')),
                image: card.querySelector('img').src,
                quantity: 1
            };

            console.log('hardware.js: Adding to trolley:', product);
            let trolley = [];
            try {
                const storedTrolley = localStorage.getItem('trolley');
                if (storedTrolley) {
                    trolley = JSON.parse(storedTrolley);
                }
            } catch (e) {
                console.error('hardware.js: Error parsing trolley:', e);
                trolley = [];
            }

            if (!Array.isArray(trolley)) {
                console.error('hardware.js: Trolley is not an array, resetting:', trolley);
                trolley = [];
            }

            const existingItem = trolley.find(item => item.id === product.id);
            if (existingItem) {
                existingItem.quantity += 1;
            } else {
                trolley.push(product);
            }

            try {
                localStorage.setItem('trolley', JSON.stringify(trolley));
                console.log('hardware.js: Trolley saved:', trolley);
                alert(`${product.title} added to trolley!`);
            } catch (e) {
                console.error('hardware.js: Error saving to localStorage:', e);
                alert('Failed to add item to trolley.');
            }
        });
    });
});