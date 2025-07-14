const app = express();


    }

    try {
        res.json({ checkoutUrl });
    } catch (error) {
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
});