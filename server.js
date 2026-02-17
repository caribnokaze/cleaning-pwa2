const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static('.'));

const GAS_URL = "https://script.google.com/macros/s/AKfycbwUV55c_aZBVyGg1YPILziEcjikRocvZJQDbdi3cYg0KggEGJEQ_5vb71XsqT1XgIX-jg/exec";

// 画像送信を受け付ける窓口
app.post('/upload', (req, res) => {
    // ブラウザにはすぐに「受付完了」を返す
    res.status(202).json({ message: "Background processing started" });

    // ここから裏側（バックグラウンド）でGASへ送信
    const data = req.body;
    
    // 非同期で実行（awaitしないことでブラウザを待たせない）
    sendToGas(data);
});

// --- Server.js の sendToGas 関数 ---

async function sendToGas(data) {
    try {
        const { allImages, ...info } = data;
        console.log(`Starting background upload of ${allImages.length} images...`);

        for (let i = 0; i < allImages.length; i++) {
            // axios.post の第3引数にオプションを追加
            await axios.post(GAS_URL, {
                ...info,
                singleImage: allImages[i]
            }, {
                maxRedirects: 5, // GASのリダイレクトを許可
                headers: { 'Content-Type': 'application/json' }
            });

            console.log(`GAS upload success: ${i + 1}/${allImages.length}`);
            
            // GAS側のロック競合を避けるため、待機時間を1秒(1000ms)に推奨
            await new Promise(r => setTimeout(r, 1000));
        }
        console.log("--- All background processes completed ---");
    } catch (error) {
        // エラー内容を詳しくログ出力
        console.error("GAS Upload Error:", error.response ? error.response.status : error.message);
    }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
