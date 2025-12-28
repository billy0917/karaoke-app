Youtube Data API:
AIzaSyAWFp7iA8fVloX-Ju9RZrG-jRfoBIYsTeo

FireBase:
應用程式暱稱
karaoke-app
應用程式 ID
1:374381226976:web:8d9539e1f1b6b1977b1985
連結的 Firebase 託管網站
karaoke-app-d3300

SDK 設定和配置

npm

CDN

設定
如果你已使用 npm 和 webpack 或 Rollup 等模組整合工具，則可執行下列指令來安裝最新版 SDK (瞭解詳情)：

npm install firebase
請初始化 Firebase，接著即可開始將 SDK 套用至要使用的產品。

// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyBFQyJHv035tZ1JxzK3Nm5LtW1ewow6I4Q",
  authDomain: "karaoke-app-d3300.firebaseapp.com",
  projectId: "karaoke-app-d3300",
  storageBucket: "karaoke-app-d3300.firebasestorage.app",
  messagingSenderId: "374381226976",
  appId: "1:374381226976:web:8d9539e1f1b6b1977b1985",
  measurementId: "G-Y7LF5H1JRX"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
注意事項：這個選項會使用模組 JavaScript SDK，因此 SDK 的大小得以縮減。

如要進一步瞭解適用於網頁應用程式的 Firebase，請查看下列資源：開始使用、Web SDK API 參考資料、使用範例