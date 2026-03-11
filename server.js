const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' })); // 画像データを受け取るため大きめに設定
app.use(express.static('.'));

const GAS_URL = "https://script.google.com/macros/s/AKfycbxeqqv2b97EYfIGFzUIOxSBjcBZs48J1XNJQvNjRpQDwNA4LQM18VosPvc5NrCiiPzgmA/exec";

// --- 行列（キュー）管理用の変数 ---
let uploadQueue = [];
let activeWorkers = 0;
const MAX_CONCURRENT_WORKERS = 5; // 同時にGASへ送信する清掃員の数（5人分まで並行処理）

app.post('/upload', (req, res) => {
    // 1. 届いたデータをキュー（行列）に追加
    uploadQueue.push(req.body);
    
    // 2. ブラウザには即座に「受付完了」を返し、清掃員を待たせない
    res.status(202).json({ message: "Queue accepted" });

    // 3. 行列の消化を開始
    processQueue();
});

async function processQueue() {
    // 同時稼働数が上限に達していたら何もしない
    if (activeWorkers >= MAX_CONCURRENT_WORKERS || uploadQueue.length === 0) {
        return;
    }

    activeWorkers++; // 稼働数をカウントアップ
    const data = uploadQueue.shift(); // 行列の先頭（1人分の全画像データ）を取り出す

    try {
        const { allImages, ...info } = data;
        const staffName = info.staff || "不明";
        console.log(`[START] ${staffName}さんの送信を開始 (残りキュー: ${uploadQueue.length})`);

        for (let i = 0; i < allImages.length; i++) {
            try {
                // GASへ1枚ずつ送信
                await axios.post(GAS_URL, {
                    ...info,
                    singleImage: allImages[i]
                }, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 60000 // 1枚あたり60秒でタイムアウト設定
                });

                console.log(`[PROGRESS] ${staffName}: ${i + 1}/${allImages.length} 完了`);
            } catch (err) {
                console.error(`[ERROR] ${staffName}の画像${i+1}枚目で失敗:`, err.message);
            }

            // 【重要】同じ清掃員の次の画像を送る前に1.5秒待機（GASの負荷分散）
            await new Promise(r => setTimeout(r, 1500));
        }
        console.log(`[FINISH] ${staffName}さんの全画像送信が完了しました`);

    } catch (globalError) {
        console.error("予期せぬエラー:", globalError.message);
    } finally {
        activeWorkers--; // 稼働数を戻す
        processQueue(); // 次の行列があれば処理を再開
    }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT} (Parallel Workers: ${MAX_CONCURRENT_WORKERS})`);
});
