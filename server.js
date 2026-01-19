const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' })); // 画像データ用に上限を拡張
app.use(express.static('.')); // index.htmlなどを表示する設定

const GAS_URL = "https://script.google.com/macros/s/AKfycbzNfouxEfDaWcoljv1hJBI6DtGbQpKrZDKyljznOvM_ZeZ27i2yhR3Wk3l8zi09vgKbug/exec";

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
        console.log("Starting background upload to GAS...");
        await axios.post(GAS_URL, data);
        console.log("Successfully uploaded to GAS");
    } catch (error) {
        console.error("Error uploading to GAS:", error.message);
    }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
