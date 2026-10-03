# 🚗 TREEL TPMS Continuous BLE Receiver & Web Dashboard

A lightweight, mobile-first static web application that captures Bluetooth Low Energy (BLE) signals from **JK Tyre TREEL / SmartTyre TPMS Sensors**, decrypts AES-128-ECB payloads, decodes Apple iBeacon packets, and displays real-time tire pressure, temperature, battery level, and alert statuses.

Deployable directly to **GitHub Pages** with zero backend or build setup required.

---

## 🌟 Key Updates & Features

- **📱 Mobile-First UI**: High-contrast dark automotive cockpit styling, designed specifically for phones mounted in a vehicle.
- **🔐 Universal Decryption**: Uses the factory universal key (`#@Trl2018-lespl$`) across all Treel TPMS sensors. Only `label`, `pos`, and `mac` are required.
- **🔋 Continuous Background Scanning & Driving Mode**:
  - **Screen Wake Lock API**: Automatically prevents the phone display from sleeping while scanning so the BLE radio stays awake while driving.
  - **Silent Audio Session Keep-Alive**: Prevents mobile browsers (iOS / Android) from aggressively suspending the background tab when switching apps or locking the screen.
  - **Auto-Recovery**: Gracefully re-acquires locks and resumes when returning to the tab.
- **🔄 Dual-Endian & Signature Matching**: Matches sensors by Forward MAC (`D2:58:6D:8F:16:10`), Reversed MAC (`10:16:8F:6D:58:D2`), 6-character Short Sensor ID (`8F1610`), or 3-byte payload signatures.
- **💾 LocalStorage Persistence**: Add, Edit, or Delete TPMS modules (`label`, `pos`, `mac`). All settings persist across reloads.
- **📷 QR Code Scanner**: Scan the QR code on the sensor packaging or sticker with your phone camera to instantly extract the sensor MAC address.
- **📊 Units & Alerts**: One-tap toggles for **PSI / BAR / kPa** and **°C / °F**, plus configurable alert thresholds.
- **📟 Live Telemetry Stream**: Collapsible terminal showing incoming BLE packets, RSSI, and decoded fields.

---

## 🚀 How to Deploy to GitHub Pages

1. **Create a GitHub Repository**:
   - Create a new repository on GitHub (e.g. `treel-tpms-web`).
2. **Push the Files**:
   ```bash
   git init
   git add .
   git commit -m "Treel TPMS static web app"
   git branch -M main
   git remote add origin https://github.com/<your-username>/treel-tpms-web.git
   git push -u origin main
   ```
3. **Enable GitHub Pages**:
   - Go to repository **Settings** &rarr; **Pages**.
   - Under **Build and deployment** &rarr; **Source**, select **Deploy from a branch**.
   - Choose `main` branch and `/ (root)` folder, then click **Save**.
4. **Access the Web App**:
   - Your site will be live at `https://<your-username>.github.io/treel-tpms-web/`!

---

## 📱 Mobile Browser Compatibility & Background Scanning

| Platform | Recommended Browser | Web Bluetooth & Background Notes |
| :--- | :--- | :--- |
| **Android** | **Google Chrome** | Fully supported out-of-the-box. Ensure Bluetooth & Location permissions are granted. Screen Wake Lock keeps the display awake while driving. |
| **iOS / iPadOS** | **[Bluefy Browser](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055)** (Free on App Store) | Standard iOS Safari does not support Web Bluetooth. Opening this URL inside Bluefy enables full continuous BLE scanning on iPhone. |

> **Tip for Vehicle Mounting**: In Chrome on Android, tap the three dots &rarr; **Add to Home screen** to run the app in full-screen PWA standalone mode without browser address bars!

---

## 💻 Local Testing Commands

To test locally on your computer with Node.js:

```powershell
npx serve .
```

Or using zero-dependency built-in Node:

```powershell
node -e "const http=require('http'),fs=require('fs');http.createServer((req,res)=>{let f=req.url==='/'?'index.html':req.url.slice(1);fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);res.end('Not found');}else{res.writeHead(200);res.end(d);}});}).listen(8080,()=>console.log('Serving at http://localhost:8080'));"
```

---

## 📂 File Structure

```
├── index.html       # Mobile-optimized HTML5 Dashboard & Modals
├── style.css        # High-contrast cockpit dark styling
├── app.js           # UI Controller, LocalStorage, Continuous Web Bluetooth & Keep-Alive
├── decoder.js       # Treel TPMS BLE decoder, Universal AES decryptor & MAC extractor
├── aes-js.js        # Zero-dependency, pure JS AES block cipher library (MIT)
└── README.md        # Documentation and deployment guide
```

---

## ⚖️ License

MIT License. Created for DIY automotive enthusiasts and open-source vehicle telemetry.
