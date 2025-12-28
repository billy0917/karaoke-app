# YouTube Karaoke App 🎤

這是一個簡單的 YouTube 點歌系統，包含兩個部分：
1. **Server**: 負責處理搜尋 API 和歌單佇列 (Node.js + Express + Socket.io)
2. **Client**: 前端介面，包含播放器和點歌遙控器 (React + Vite)

## 如何啟動

你需要開啟兩個終端機 (Terminal) 分別啟動後端與前端。

### 1. 啟動後端 (Server)
```bash
cd server
npm install  # 如果尚未安裝
npm run dev
```
伺服器將運行於 `http://localhost:3001`

### 2. 啟動前端 (Client)
```bash
cd client
npm install  # 如果尚未安裝
npm run dev
```
前端將運行於 `http://localhost:5173` (預設)

## 使用說明

1. 在瀏覽器打開前端網址 (例如 `http://localhost:5173`)。
2. **主螢幕 (電視/電腦)**：選擇 **"📺 Player (Host)"**。這台設備負責播放影片。
3. **手機/遙控器**：在手機瀏覽器打開相同網址 (需確保手機與電腦在同一 Wi-Fi 下，並輸入電腦的區域 IP)，選擇 **"📱 Remote (User)"**。
4. 在遙控器搜尋歌曲並點擊 `+` 加入歌單。
5. 播放器將會自動開始播放。

## 注意事項
- 搜尋功能使用 `ytsr` 套件，無需 API Key，但可能會受限於 YouTube 的反爬蟲機制。
- 若要公開部署，請修改 `client/vite.config.js` 中的 proxy 設定以及 `client/src/App.jsx` 中的 Socket 連線設定。
