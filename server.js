const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' })); // 画像データ用に上限を拡張
app.use(express.static('.')); // index.htmlなどを表示する設定

const GAS_URL = "https://script.google.com/macros/s/AKfycbw74zd7i7jF0rg7ZDNk5vibTA_D3VtK3wxKTuIUXbC-qKcShCtdcqo1ckab16kzeHVA5w/exec";

// 画像送信を受け付ける窓口
app.post('/upload', (req, res) => {
    // ブラウザにはすぐに「受付完了」を返す
    res.status(202).json({ message: "Background processing started" });

    // ここから裏側（バックグラウンド）でGASへ送信
    const data = req.body;
    
    // 非同期で実行（awaitしないことでブラウザを待たせない）
    sendToGas(data);
});

async function sendToGas(data) {
    try {
        const { allImages, ...info } = data;
        console.log(`Starting background upload of ${allImages.length} images...`);

        for (let i = 0; i < allImages.length; i++) {
            await axios.post(GAS_URL, {
                ...info,
                singleImage: allImages[i]
            });
            console.log(`GAS upload: ${i + 1}/${allImages.length}`);
            // GASがパンクしないよう少し待つ
            await new Promise(r => setTimeout(r, 500));
        }
    } catch (error) {
        console.error("Error:", error.message);
    }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
