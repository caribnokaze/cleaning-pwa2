const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static('.'));

const GAS_URL = "https://script.google.com/macros/s/AKfycby20bs8R0K4fiHVKVJbpmtLjlCuA7I97xjoGqEgP9ism3exFRpLSBVszqP9orRMKX5SrQ/exec";

// --- 行列（キュー）管理用の変数 ---
let isProcessing = false;
let uploadQueue = [];

app.post('/upload', (req, res) => {
    // 1. データをキューに追加
    uploadQueue.push(req.body);
    
    // 2. ブラウザにはすぐにレスポンスを返す
    res.status(202).json({ message: "Added to queue" });

    // 3. 行列の処理を開始（すでに動いていれば何もしない）
    processQueue();
});

async function processQueue() {
    if (isProcessing) return; // すでに誰かの分を送信中なら、終わるまで待機
    isProcessing = true;

    while (uploadQueue.length > 0) {
        const data = uploadQueue.shift(); // 行列の先頭を取り出す
        try {
            const { allImages, ...info } = data;
            console.log(`Processing queue: ${allImages.length} images remaining...`);

            for (let i = 0; i < allImages.length; i++) {
                // GASへ送信
                await axios.post(GAS_URL, {
                    ...info,
                    singleImage: allImages[i]
                }, {
                    headers: { 'Content-Type': 'application/json' }
                });

                console.log(`GAS upload success: ${i + 1}/${allImages.length}`);
                
                // 【重要】GAS側のパンクを防ぐため、1.5秒（少し長め）待機
                await new Promise(r => setTimeout(r, 1000));
            }
        } catch (error) {
            console.error("GAS Upload Error:", error.message);
        }
    }

    isProcessing = false; // 全ての行列が空になったらフラグを下ろす
    console.log("--- All queue processes completed ---");
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
