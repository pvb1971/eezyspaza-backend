document.addEventListener('DOMContentLoaded', () => {
    const categoryDivs = document.querySelectorAll('.cat');

    categoryDivs.forEach(div => {
        div.addEventListener('click', () => {
            const category = div.dataset.cat;
            if (category) {
                // Assuming your category HTML files are named like "groceries.html", "butchery.html", etc.
                const targetPage = `${category}.html`;
                console.log(`Navigating to ${targetPage}`);
                window.location.href = targetPage;
            } else {
                console.error('Category data attribute not found for div:', div);
                alert('Could not determine category.');
            }
        });
    });
});
