/**
 * Treel TPMS Mobile Web Dashboard - Main Application Logic
 * Pure Real-Time BLE Scanner, Persistent LocalStorage, Screen Wake Lock & Background Keep-Alive
 */

(function() {
    'use strict';

    // Default 4-wheel configuration
    const DEFAULT_MODULES = [
        { id: 'fl_01', label: 'Front Left', pos: 'FL', mac: 'D2:58:6D:8F:16:10' },
        { id: 'fr_02', label: 'Front Right', pos: 'FR', mac: 'CA:E8:6C:2D:92:15' },
        { id: 'rl_03', label: 'Rear Left',  pos: 'RL', mac: 'F7:FC:85:AD:35:E2' },
        { id: 'rr_04', label: 'Rear Right', pos: 'RR', mac: 'CD:8D:E6:9E:FB:E6' }
    ];

    const DEFAULT_CONFIG = {
        pressUnit: 'psi',       // 'psi' | 'bar' | 'kpa'
        tempUnit: 'c',          // 'c' | 'f'
        minPsi: 26.0,
        maxPsi: 42.0,
        maxTempC: 70.0,
        minBatt: 15,
        preventSleep: true,     // Screen WakeLock to keep screen on while driving
        backgroundAudio: true   // Silent audio keep-alive for background tab survival
    };

    // State
    let modules = [];
    let config = { ...DEFAULT_CONFIG };
    let telemetryMap = {}; // Keyed by module.id
    let isScanning = false;
    let bleScanInstance = null;
    let wakeLockSentinel = null;
    let silentAudioElement = null;
    let totalBlePackets = 0;
    let totalTpmsPackets = 0;
    let qrVideoStream = null;
    let currentEditingModuleId = null;

    // Local Storage Keys
    const LS_MODULES_KEY = 'treel_tpms_modules_v3';
    const LS_CONFIG_KEY  = 'treel_tpms_config_v3';

    // -------------------------------------------------------------------------
    // Initialization & Storage
    // -------------------------------------------------------------------------

    function init() {
        loadSettings();
        loadModules();
        setupEventListeners();
        checkBluetoothSupport();
        renderTireCards();
        updateSummaryHeader();

        // 1-second ticker for "last seen" relative age
        setInterval(updateAgeTimers, 1000);

        // Visibility change listener: re-acquire wake lock if user switches back
        document.addEventListener('visibilitychange', handleVisibilityChange);

        logTerminal('TREEL TPMS Receiver initialized.', 'meta');
    }

    function loadSettings() {
        try {
            const saved = localStorage.getItem(LS_CONFIG_KEY);
            if (saved) {
                config = Object.assign({}, DEFAULT_CONFIG, JSON.parse(saved));
            }
        } catch (e) {
            console.warn('Failed to load settings', e);
        }
        applyUnitTogglesUI();
    }

    function saveSettings() {
        try {
            localStorage.setItem(LS_CONFIG_KEY, JSON.stringify(config));
        } catch (e) {
            console.error('Failed to save settings', e);
        }
    }

    function loadModules() {
        try {
            const saved = localStorage.getItem(LS_MODULES_KEY);
            if (saved) {
                modules = JSON.parse(saved);
            } else {
                modules = JSON.parse(JSON.stringify(DEFAULT_MODULES));
                saveModules();
            }
        } catch (e) {
            modules = JSON.parse(JSON.stringify(DEFAULT_MODULES));
        }
    }

    function saveModules() {
        try {
            localStorage.setItem(LS_MODULES_KEY, JSON.stringify(modules));
        } catch (e) {
            console.error('Failed to save modules', e);
        }
    }

    // -------------------------------------------------------------------------
    // Unit Conversions & Alert Evaluation
    // -------------------------------------------------------------------------

    function getFormattedPressure(psi) {
        if (psi == null || isNaN(psi) || psi < 0) return { val: '--', unit: config.pressUnit.toUpperCase(), sub: '(--)' };

        let displayVal = psi;
        let subText = '';

        if (config.pressUnit === 'bar') {
            displayVal = psi * 0.0689476;
            subText = psi.toFixed(1) + ' PSI';
        } else if (config.pressUnit === 'kpa') {
            displayVal = psi * 6.89476;
            subText = (psi * 0.0689476).toFixed(2) + ' Bar';
        } else {
            subText = (psi * 0.0689476).toFixed(2) + ' Bar';
        }

        return {
            val: (config.pressUnit === 'kpa') ? Math.round(displayVal) : displayVal.toFixed(1),
            unit: config.pressUnit.toUpperCase(),
            sub: '(' + subText + ')'
        };
    }

    function getFormattedTemperature(tempC) {
        if (tempC == null || isNaN(tempC)) return '--';
        if (config.tempUnit === 'f') {
            const tempF = (tempC * 1.8) + 32;
            return Math.round(tempF) + ' °F';
        }
        return tempC.toFixed(1) + ' °C';
    }

    function evaluateAlertState(data) {
        if (!data || data.pressurePsi == null) return 'WAITING';
        if (data.pressurePsi < config.minPsi) return 'LOW PRESSURE';
        if (data.pressurePsi > config.maxPsi) return 'HIGH PRESSURE';
        if (data.tempC != null && data.tempC > config.maxTempC) return 'HIGH TEMP';
        if (data.battery != null && data.battery >= 0 && data.battery < config.minBatt) return 'LOW BATTERY';
        return 'NORMAL';
    }

    // -------------------------------------------------------------------------
    // DOM Rendering
    // -------------------------------------------------------------------------

    function renderTireCards() {
        const stack = document.getElementById('tiresStack');
        if (!stack) return;

        if (modules.length === 0) {
            stack.innerHTML = `
                <div class="banner">
                    <div>No TPMS modules configured. Tap <strong>"+ Add New TPMS Module"</strong> below to add one.</div>
                </div>
            `;
            return;
        }

        let html = '';
        modules.forEach(mod => {
            const tele = telemetryMap[mod.id] || null;
            const hasData = tele != null && tele.pressurePsi != null;
            const press = getFormattedPressure(hasData ? tele.pressurePsi : null);
            const tempStr = getFormattedTemperature(hasData ? tele.tempC : null);
            const battVal = (hasData && tele.battery >= 0) ? tele.battery : null;
            const alertStr = hasData ? evaluateAlertState(tele) : 'WAITING';

            let cardAlertClass = 'alert-normal';
            let badgeClass = 'ok';
            if (alertStr === 'WAITING') {
                cardAlertClass = '';
                badgeClass = '';
            } else if (alertStr === 'LOW PRESSURE' || alertStr === 'HIGH PRESSURE' || alertStr === 'HIGH TEMP') {
                cardAlertClass = 'alert-danger';
                badgeClass = 'danger';
            } else if (alertStr === 'LOW BATTERY') {
                cardAlertClass = 'alert-warning';
                badgeClass = 'warn';
            }

            const battBarWidth = battVal != null ? battVal + '%' : '0%';
            const isBattLow = battVal != null && battVal < config.minBatt;
            const posBadge = mod.pos || mod.label.substr(0, 2).toUpperCase();
            const ageStr = tele && tele.lastSeenMs ? formatAge(Math.floor((Date.now() - tele.lastSeenMs) / 1000)) : 'Never';

            html += `
            <div class="tire-card ${cardAlertClass}" id="card-${mod.id}">
                <div class="card-header">
                    <div class="tire-title">
                        <span class="pos-tag">${escapeHtml(posBadge)}</span>
                        <span class="tire-name">${escapeHtml(mod.label)}</span>
                    </div>
                    <span class="status-badge ${badgeClass}" id="badge-${mod.id}">${alertStr}</span>
                </div>

                <div class="pressure-hero">
                    <div class="pressure-main">
                        <span class="val-psi" id="psi-${mod.id}">${press.val}</span>
                        <span class="unit-psi">${press.unit}</span>
                    </div>
                    <div class="pressure-sec" id="sub-${mod.id}">${press.sub}</div>
                </div>

                <div class="metrics-row">
                    <div class="metric-item">
                        <span class="metric-lbl">Temp</span>
                        <span class="metric-val" id="temp-${mod.id}">${tempStr}</span>
                    </div>
                    <div class="metric-item">
                        <span class="metric-lbl">Battery</span>
                        <span class="metric-val" id="batt-${mod.id}">
                            ${battVal != null ? `
                                <span class="battery-badge">
                                    <span class="batt-icon-bar ${isBattLow ? 'low' : ''}" style="--b-width: ${battBarWidth}"></span>
                                    ${battVal}%
                                </span>` : 'N/A'}
                        </span>
                    </div>
                    <div class="metric-item">
                        <span class="metric-lbl">Mode</span>
                        <span class="metric-val" id="mode-${mod.id}">${tele ? tele.mode : '--'}</span>
                    </div>
                    <div class="metric-item">
                        <span class="metric-lbl">Signal</span>
                        <span class="metric-val" id="rssi-${mod.id}">${tele && tele.rssi ? tele.rssi + ' dBm' : '--'}</span>
                    </div>
                </div>

                <div class="card-footer">
                    <div class="sensor-id-info">
                        <span>MAC: <strong>${escapeHtml(mod.mac || 'Unset')}</strong></span>
                    </div>
                    <div class="card-actions">
                        <span id="age-${mod.id}" style="margin-right: 4px;">Seen: ${ageStr}</span>
                        <button class="card-action-btn" title="Edit Sensor" onclick="window.TreelApp.openEditModal('${mod.id}')">✏️ Edit</button>
                        <button class="card-action-btn del" title="Delete Sensor" onclick="window.TreelApp.deleteModule('${mod.id}')">🗑️</button>
                    </div>
                </div>
            </div>`;
        });

        stack.innerHTML = html;
    }

    function updateAgeTimers() {
        const now = Date.now();
        modules.forEach(mod => {
            const ageEl = document.getElementById(`age-${mod.id}`);
            if (!ageEl) return;
            const tele = telemetryMap[mod.id];
            if (tele && tele.lastSeenMs) {
                const s = Math.floor((now - tele.lastSeenMs) / 1000);
                ageEl.innerText = 'Seen: ' + formatAge(s);
            } else {
                ageEl.innerText = 'Seen: Never';
            }
        });
    }

    function formatAge(seconds) {
        if (seconds < 0) return 'Never';
        if (seconds < 5) return 'Just now';
        if (seconds < 60) return `${seconds}s ago`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        return `${Math.floor(seconds / 3600)}h ago`;
    }

    function updateSummaryHeader() {
        const totalMod = modules.length;
        let activeMod = 0;
        const now = Date.now();
        modules.forEach(m => {
            const t = telemetryMap[m.id];
            if (t && t.lastSeenMs && (now - t.lastSeenMs) < 180000) { // active within 3 minutes
                activeMod++;
            }
        });

        const activeEl = document.getElementById('activeSensorsCount');
        if (activeEl) activeEl.innerText = `${activeMod}/${totalMod}`;

        const pkEl = document.getElementById('packetCounters');
        if (pkEl) pkEl.innerText = `${totalTpmsPackets}/${totalBlePackets}`;
    }

    // -------------------------------------------------------------------------
    // Telemetry Update Handler
    // -------------------------------------------------------------------------

    function handleDecodedTelemetry(mod, data, rssi) {
        totalTpmsPackets++;
        const now = Date.now();

        telemetryMap[mod.id] = {
            psi: data.pressurePsi,
            pressurePsi: data.pressurePsi,
            tempC: data.tempC,
            battery: data.battery,
            mode: data.mode,
            rssi: rssi || -60,
            lastSeenMs: now,
            sensorId: data.sensorId || ''
        };

        const card = document.getElementById(`card-${mod.id}`);
        if (!card) {
            renderTireCards();
            return;
        }

        const press = getFormattedPressure(data.pressurePsi);
        const tempStr = getFormattedTemperature(data.tempC);
        const alertStr = evaluateAlertState(data);

        const psiEl = document.getElementById(`psi-${mod.id}`);
        if (psiEl) psiEl.innerText = press.val;

        const subEl = document.getElementById(`sub-${mod.id}`);
        if (subEl) subEl.innerText = press.sub;

        const tempEl = document.getElementById(`temp-${mod.id}`);
        if (tempEl) tempEl.innerText = tempStr;

        const battEl = document.getElementById(`batt-${mod.id}`);
        if (battEl) {
            const battVal = data.battery >= 0 ? data.battery : null;
            const isBattLow = battVal != null && battVal < config.minBatt;
            battEl.innerHTML = battVal != null ? `
                <span class="battery-badge">
                    <span class="batt-icon-bar ${isBattLow ? 'low' : ''}" style="--b-width: ${battVal}%"></span>
                    ${battVal}%
                </span>` : 'N/A';
        }

        const modeEl = document.getElementById(`mode-${mod.id}`);
        if (modeEl) modeEl.innerText = data.mode + (data.sensorId ? ` (${data.sensorId})` : '');

        const rssiEl = document.getElementById(`rssi-${mod.id}`);
        if (rssiEl) rssiEl.innerText = (rssi ? rssi + ' dBm' : '--');

        const ageEl = document.getElementById(`age-${mod.id}`);
        if (ageEl) ageEl.innerText = 'Seen: Just now';

        const badgeEl = document.getElementById(`badge-${mod.id}`);
        if (badgeEl) {
            badgeEl.innerText = alertStr;
            badgeEl.className = 'status-badge ' + (
                alertStr === 'NORMAL' ? 'ok' :
                (alertStr === 'LOW BATTERY' ? 'warn' :
                (alertStr === 'WAITING' ? '' : 'danger'))
            );
        }

        card.className = 'tire-card ' + (
            alertStr === 'NORMAL' ? 'alert-normal' :
            (alertStr === 'LOW BATTERY' ? 'alert-warning' :
            (alertStr === 'WAITING' ? '' : 'alert-danger'))
        );

        updateSummaryHeader();

        logTerminal(`[${mod.label}] ${data.pressurePsi.toFixed(1)} PSI | ${data.tempC.toFixed(1)}°C | Batt:${data.battery >= 0 ? data.battery + '%' : 'N/A'} | ${data.mode} (${rssi || -60} dBm)`, 'success');
    }

    // -------------------------------------------------------------------------
    // Background & Screen Keep-Alive Helpers
    // -------------------------------------------------------------------------

    async function acquireWakeLock() {
        if ('wakeLock' in navigator && config.preventSleep) {
            try {
                wakeLockSentinel = await navigator.wakeLock.request('screen');
                logTerminal('Screen Wake Lock active (prevents screen sleep)', 'meta');
                wakeLockSentinel.addEventListener('release', () => {
                    wakeLockSentinel = null;
                });
            } catch (err) {
                console.warn('Wake Lock request failed:', err);
            }
        }
    }

    function releaseWakeLock() {
        if (wakeLockSentinel) {
            try {
                wakeLockSentinel.release();
            } catch (e) {}
            wakeLockSentinel = null;
        }
    }

    function startSilentAudioKeepalive() {
        if (!config.backgroundAudio) return;
        try {
            if (!silentAudioElement) {
                // 1-second inaudible silent MP3 loop
                // Keeps mobile browser audio session active so tab isn't killed in background
                silentAudioElement = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=');
                silentAudioElement.loop = true;
                silentAudioElement.volume = 0.01;
            }
            silentAudioElement.play().catch(() => {});
        } catch (e) {}
    }

    function stopSilentAudioKeepalive() {
        if (silentAudioElement) {
            try {
                silentAudioElement.pause();
            } catch (e) {}
            silentAudioElement = null;
        }
    }

    function handleVisibilityChange() {
        if (document.visibilityState === 'visible' && isScanning) {
            // Re-acquire WakeLock if dropped
            acquireWakeLock();
            logTerminal('App resumed in foreground.', 'meta');
        }
    }

    // -------------------------------------------------------------------------
    // Web Bluetooth Scanning Engine
    // -------------------------------------------------------------------------

    function checkBluetoothSupport() {
        const banner = document.getElementById('btSupportBanner');
        if (!navigator.bluetooth) {
            if (banner) banner.style.display = 'flex';
            logTerminal('Web Bluetooth API is not supported in this browser.', 'warn');
            logTerminal('Use Chrome on Android or the free Bluefy browser on iOS.', 'meta');
        } else {
            if (banner) banner.style.display = 'none';
        }
    }

    async function toggleBleScan() {
        if (isScanning) {
            stopBleScan();
        } else {
            startBleScan();
        }
    }

    async function startBleScan() {
        if (!navigator.bluetooth) {
            showToast('Web Bluetooth not supported. Use Chrome on Android or Bluefy on iOS!');
            return;
        }

        try {
            updateBleStatusUI('scanning', 'Requesting Scan...');
            logTerminal('Requesting BLE Advertisement scan...', 'meta');

            if (navigator.bluetooth.requestLEScan) {
                // Attach event listener immediately so no incoming packets are missed
                navigator.bluetooth.addEventListener('advertisementreceived', handleAdvertisementReceived);

                // Start scan with race timeout for Desktop Windows Chrome (where promise can hang after Allow)
                const scanPromise = navigator.bluetooth.requestLEScan({
                    acceptAllAdvertisements: true,
                    keepRepeatedDevices: true
                });

                const timeoutPromise = new Promise(resolve => setTimeout(() => resolve('timeout_fallback'), 3500));
                const outcome = await Promise.race([scanPromise, timeoutPromise]);

                if (outcome && outcome !== 'timeout_fallback') {
                    bleScanInstance = outcome;
                } else if (outcome === 'timeout_fallback') {
                    logTerminal('Desktop note: Prompt confirmed. Active listener attached.', 'meta');
                }

                isScanning = true;
                updateBleStatusUI('scanning', 'Scanning Continuously');
                const btn = document.getElementById('btnScanToggle');
                if (btn) {
                    btn.classList.add('scanning');
                    btn.innerHTML = '⏹ Stop Continuous BLE Scan';
                }

                // Enable screen keep-awake and background keep-alive
                acquireWakeLock();
                startSilentAudioKeepalive();

                logTerminal('Continuous BLE scan running. Waiting for TPMS broadcasts...', 'success');
                showToast('Continuous BLE scan started!');
            } else {
                startDevicePickerScan();
            }
        } catch (err) {
            console.error('BLE Scan Error:', err);
            isScanning = false;
            updateBleStatusUI('idle', 'Disconnected');
            const btn = document.getElementById('btnScanToggle');
            if (btn) {
                btn.classList.remove('scanning');
                btn.innerHTML = '📡 Start Continuous BLE Scan';
            }
            releaseWakeLock();
            stopSilentAudioKeepalive();

            if (err.name === 'NotFoundError') {
                logTerminal('Scan request cancelled.', 'meta');
            } else {
                logTerminal(`BLE Error: ${err.message}`, 'error');
                showToast(`Scan error: ${err.message}`);
            }
        }
    }

    async function startDevicePickerScan() {
        if (!navigator.bluetooth) {
            showToast('Web Bluetooth not supported in this browser.');
            return;
        }
        try {
            logTerminal('Opening Bluetooth Device Picker...', 'meta');
            const device = await navigator.bluetooth.requestDevice({
                acceptAllDevices: true,
                optionalServices: ['0000ffe0-0000-1000-8000-00805f9b34fb']
            });

            logTerminal(`Selected Device: "${device.name || 'Unnamed'}" (ID: ${device.id})`, 'success');
            showToast(`Selected: ${device.name || device.id}`);

            // Listen for advertisement events on selected device if supported
            if (device.addEventListener) {
                device.addEventListener('advertisementreceived', handleAdvertisementReceived);
                if (device.watchAdvertisements) {
                    await device.watchAdvertisements();
                    logTerminal(`Watching advertisements for ${device.name || device.id}...`, 'success');
                }
            }

            // Also check if device name contains sensor MAC or ID
            if (device.name) {
                const parsed = window.TreelDecoder.parseTreelQrCode(device.name);
                if (parsed && parsed.mac) {
                    logTerminal(`Extracted Sensor MAC from Device Name: ${parsed.mac}`, 'success');
                }
            }
        } catch (err) {
            if (err.name !== 'NotFoundError') {
                logTerminal(`Device Picker Error: ${err.message}`, 'error');
            }
        }
    }

    function stopBleScan() {
        try {
            if (bleScanInstance && bleScanInstance.stop) {
                bleScanInstance.stop();
            }
            if (navigator.bluetooth) {
                navigator.bluetooth.removeEventListener('advertisementreceived', handleAdvertisementReceived);
            }
        } catch (e) {
            console.warn('Error stopping scan:', e);
        }

        bleScanInstance = null;
        isScanning = false;
        releaseWakeLock();
        stopSilentAudioKeepalive();

        updateBleStatusUI('idle', 'Disconnected');
        const btn = document.getElementById('btnScanToggle');
        if (btn) {
            btn.classList.remove('scanning');
            btn.innerHTML = '📡 Start Continuous BLE Scan';
        }
        logTerminal('BLE scan stopped.', 'meta');
        showToast('BLE scan stopped.');
    }

    function handleAdvertisementReceived(event) {
        totalBlePackets++;
        const rawPacket = {
            deviceId: event.device ? event.device.id : '',
            deviceName: event.device ? event.device.name : '',
            rssi: event.rssi,
            manufacturerData: event.manufacturerData,
            serviceData: event.serviceData
        };

        const result = window.TreelDecoder.processBlePacket(rawPacket, modules);

        const verbose = document.getElementById('chkVerboseLog')?.checked;
        if (verbose && result && result.debugEntries) {
            result.debugEntries.forEach(entry => {
                logTerminal(`[RAW] Dev:${rawPacket.deviceName || 'anon'} (${rawPacket.rssi}dBm) ${entry}`, 'meta');
            });
        }

        if (result && result.data) {
            if (result.matchedModule) {
                handleDecodedTelemetry(result.matchedModule, result.data, result.rssi);
            } else {
                totalTpmsPackets++;
                logTerminal(`[UNMATCHED TPMS] ${result.data.pressurePsi} PSI | ${result.data.tempC}°C | ${result.data.mode}`, 'warn');
                showUnassignedSensorBanner(result);
            }
        }
        updateSummaryHeader();
    }

    let lastDetectedResult = null;
    function showUnassignedSensorBanner(result) {
        lastDetectedResult = result;
        const banner = document.getElementById('unassignedBanner');
        const text = document.getElementById('unassignedText');
        const actions = document.getElementById('unassignedActions');
        if (!banner || !text || !actions) return;

        text.innerHTML = `🚗 <strong>Detected Active Treel Sensor:</strong> ${result.data.pressurePsi} PSI | ${result.data.tempC}°C | ${result.data.mode} (RSSI: ${result.rssi} dBm). Tap to link to your tire:`;

        let btnHtml = '';
        modules.forEach(m => {
            btnHtml += `<button class="btn btn-secondary btn-sm" onclick="window.TreelApp.assignDetectedToTire('${m.id}')">➡️ Assign to ${escapeHtml(m.label)}</button>`;
        });
        actions.innerHTML = btnHtml;
        banner.style.display = 'flex';
    }

    function assignDetectedToTire(moduleId) {
        if (!lastDetectedResult) return;
        const mod = modules.find(m => m.id === moduleId);
        if (!mod) return;

        // Try extracting MAC or Sensor ID from detected packet
        let newMac = '';
        if (lastDetectedResult.deviceId && lastDetectedResult.deviceId.length >= 12) {
            newMac = lastDetectedResult.deviceId;
        } else if (lastDetectedResult.data.sensorId) {
            newMac = lastDetectedResult.data.sensorId.replace(/[^0-9A-F]/g, '');
        }

        if (newMac) {
            mod.mac = window.TreelDecoder.normalizeMac(newMac);
            saveModules();
            renderTireCards();
            showToast(`Linked sensor to ${mod.label}!`);
            logTerminal(`Sensor ${mod.mac} successfully linked to ${mod.label}`, 'success');
        }

        // Immediately update telemetry
        handleDecodedTelemetry(mod, lastDetectedResult.data, lastDetectedResult.rssi);

        const banner = document.getElementById('unassignedBanner');
        if (banner) banner.style.display = 'none';
        lastDetectedResult = null;
    }

    function updateBleStatusUI(status, label) {
        const pill = document.getElementById('bleStatusPill');
        const text = document.getElementById('bleStatusText');
        if (!pill || !text) return;

        pill.className = 'ble-pill ' + status;
        text.innerText = label;
    }

    // -------------------------------------------------------------------------
    // Sensor Module Management (CRUD)
    // -------------------------------------------------------------------------

    function openAddModal() {
        currentEditingModuleId = null;
        document.getElementById('modalTitle').innerText = 'Add TPMS Module';
        document.getElementById('inputLabel').value = '';
        document.getElementById('inputMac').value = '';
        document.getElementById('inputPos').value = 'FL';
        updatePillSelection('FL');
        openModal('moduleModal');
    }

    function openEditModal(moduleId) {
        const mod = modules.find(m => m.id === moduleId);
        if (!mod) return;

        currentEditingModuleId = moduleId;
        document.getElementById('modalTitle').innerText = 'Edit TPMS Module';
        document.getElementById('inputLabel').value = mod.label || '';
        document.getElementById('inputMac').value = mod.mac || '';
        document.getElementById('inputPos').value = mod.pos || 'FL';
        updatePillSelection(mod.pos || 'FL');
        openModal('moduleModal');
    }

    function saveModuleForm(e) {
        if (e) e.preventDefault();

        const label = document.getElementById('inputLabel').value.trim() || 'Tire';
        let mac = document.getElementById('inputMac').value.trim();
        const pos = document.getElementById('inputPos').value.trim() || 'FL';

        if (!mac) {
            showToast('Please enter a MAC Address or Sensor ID');
            return;
        }

        mac = window.TreelDecoder.normalizeMac(mac);

        if (currentEditingModuleId) {
            const idx = modules.findIndex(m => m.id === currentEditingModuleId);
            if (idx >= 0) {
                modules[idx].label = label;
                modules[idx].mac = mac;
                modules[idx].pos = pos;
                showToast(`Updated ${label}`);
            }
        } else {
            const newId = 'mod_' + Date.now().toString(36);
            modules.push({
                id: newId,
                label: label,
                mac: mac,
                pos: pos
            });
            showToast(`Added ${label}`);
        }

        saveModules();
        renderTireCards();
        updateSummaryHeader();
        closeModal('moduleModal');
    }

    function deleteModule(moduleId) {
        const mod = modules.find(m => m.id === moduleId);
        if (!mod) return;

        if (confirm(`Delete sensor "${mod.label}" (${mod.mac})?`)) {
            modules = modules.filter(m => m.id !== moduleId);
            delete telemetryMap[moduleId];
            saveModules();
            renderTireCards();
            updateSummaryHeader();
            showToast(`Deleted ${mod.label}`);
        }
    }

    function selectPresetPill(posCode, defaultLabel) {
        document.getElementById('inputPos').value = posCode;
        document.getElementById('inputLabel').value = defaultLabel;
        updatePillSelection(posCode);
    }

    function updatePillSelection(posCode) {
        document.querySelectorAll('.preset-pill').forEach(btn => {
            if (btn.dataset.pos === posCode) {
                btn.classList.add('selected');
            } else {
                btn.classList.remove('selected');
            }
        });
    }

    // -------------------------------------------------------------------------
    // Camera QR Code Scanner (Extracts MAC)
    // -------------------------------------------------------------------------

    async function openCameraScanner() {
        openModal('scannerModal');
        const video = document.getElementById('qrVideo');
        const scannerMsg = document.getElementById('scannerStatus');

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            scannerMsg.innerText = 'Camera access not supported. Use file upload or enter MAC manually.';
            return;
        }

        try {
            qrVideoStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment' }
            });
            video.srcObject = qrVideoStream;
            video.setAttribute('playsinline', true);
            await video.play();
            scannerMsg.innerText = 'Aim camera at QR code on sensor sticker or box...';

            startQrVideoScanLoop(video);
        } catch (err) {
            console.warn('Camera access denied:', err);
            scannerMsg.innerText = 'Unable to access camera: ' + err.message;
        }
    }

    function closeCameraScanner() {
        if (qrVideoStream) {
            qrVideoStream.getTracks().forEach(track => track.stop());
            qrVideoStream = null;
        }
        closeModal('scannerModal');
    }

    async function startQrVideoScanLoop(video) {
        if (!window.BarcodeDetector) {
            document.getElementById('scannerStatus').innerText = 'Upload QR image or enter MAC manually.';
            return;
        }

        try {
            const barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code', 'data_matrix', 'code_128'] });

            const scanInterval = setInterval(async () => {
                if (!qrVideoStream || video.readyState !== video.HAVE_ENOUGH_DATA) return;

                try {
                    const barcodes = await barcodeDetector.detect(video);
                    if (barcodes.length > 0) {
                        const rawVal = barcodes[0].rawValue;
                        clearInterval(scanInterval);
                        handleScannedQrResult(rawVal);
                        closeCameraScanner();
                    }
                } catch (e) {}
            }, 300);
        } catch (e) {
            console.warn('BarcodeDetector error:', e);
        }
    }

    function handleQrImageUpload(e) {
        const file = e.target.files[0];
        if (!file) return;

        if (window.BarcodeDetector) {
            const img = new Image();
            img.onload = async () => {
                try {
                    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
                    const codes = await detector.detect(img);
                    if (codes.length > 0) {
                        handleScannedQrResult(codes[0].rawValue);
                        closeCameraScanner();
                    } else {
                        showToast('No QR code detected in image.');
                    }
                } catch (err) {
                    showToast('Failed to process image QR');
                }
            };
            img.src = URL.createObjectURL(file);
        } else {
            showToast('QR Image decoding not supported natively by this browser. Enter MAC manually.');
        }
    }

    function handleScannedQrResult(qrText) {
        logTerminal(`Scanned QR Code: ${qrText}`, 'meta');
        const parsed = window.TreelDecoder.parseTreelQrCode(qrText);
        if (parsed && parsed.mac) {
            document.getElementById('inputMac').value = parsed.mac;
            showToast(`Extracted MAC: ${parsed.mac}`);
        } else {
            // Fallback: put raw string if it looks like a MAC
            const clean = qrText.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
            if (clean.length === 12 || clean.length === 6) {
                document.getElementById('inputMac').value = window.TreelDecoder.normalizeMac(clean);
                showToast(`Extracted MAC: ${document.getElementById('inputMac').value}`);
            } else {
                showToast('Could not extract MAC from QR code.');
            }
        }
    }

    // -------------------------------------------------------------------------
    // Settings & Unit Switching
    // -------------------------------------------------------------------------

    function setPressureUnit(unit) {
        config.pressUnit = unit;
        saveSettings();
        applyUnitTogglesUI();
        renderTireCards();
    }

    function setTemperatureUnit(unit) {
        config.tempUnit = unit;
        saveSettings();
        applyUnitTogglesUI();
        renderTireCards();
    }

    function applyUnitTogglesUI() {
        ['psi', 'bar', 'kpa'].forEach(u => {
            const btn = document.getElementById(`btn-unit-${u}`);
            if (btn) btn.className = 'seg-btn ' + (config.pressUnit === u ? 'active' : '');
        });

        ['c', 'f'].forEach(u => {
            const btn = document.getElementById(`btn-temp-${u}`);
            if (btn) btn.className = 'seg-btn ' + (config.tempUnit === u ? 'active' : '');
        });
    }

    function openSettingsModal() {
        document.getElementById('cfgMinPsi').value = config.minPsi;
        document.getElementById('cfgMaxPsi').value = config.maxPsi;
        document.getElementById('cfgMaxTemp').value = config.maxTempC;
        document.getElementById('cfgMinBatt').value = config.minBatt;
        document.getElementById('cfgPreventSleep').checked = !!config.preventSleep;
        document.getElementById('cfgBackgroundAudio').checked = !!config.backgroundAudio;
        openModal('settingsModal');
    }

    function saveSettingsForm(e) {
        if (e) e.preventDefault();
        config.minPsi = parseFloat(document.getElementById('cfgMinPsi').value) || 26.0;
        config.maxPsi = parseFloat(document.getElementById('cfgMaxPsi').value) || 42.0;
        config.maxTempC = parseFloat(document.getElementById('cfgMaxTemp').value) || 70.0;
        config.minBatt = parseInt(document.getElementById('cfgMinBatt').value, 10) || 15;
        config.preventSleep = document.getElementById('cfgPreventSleep').checked;
        config.backgroundAudio = document.getElementById('cfgBackgroundAudio').checked;

        if (isScanning) {
            if (config.preventSleep) acquireWakeLock();
            else releaseWakeLock();
        }

        saveSettings();
        renderTireCards();
        closeModal('settingsModal');
        showToast('Settings saved!');
    }

    function loadPreset(type) {
        if (!confirm(`Replace current sensors with ${type === 'car' ? '4 Car Wheels' : '2 Motorcycle Wheels'} preset?`)) return;

        if (type === 'car') {
            modules = JSON.parse(JSON.stringify(DEFAULT_MODULES));
        } else if (type === 'bike') {
            modules = [
                { id: 'bike_f', label: 'Front Wheel', pos: 'FW', mac: 'D2:58:6D:8F:16:10' },
                { id: 'bike_r', label: 'Rear Wheel',  pos: 'RW', mac: 'CA:E8:6C:2D:92:15' }
            ];
        }

        telemetryMap = {};
        saveModules();
        renderTireCards();
        updateSummaryHeader();
        closeModal('settingsModal');
        showToast('Preset loaded.');
    }

    function clearAllStorageData() {
        if (confirm('Clear all configured sensors and telemetry from localStorage?')) {
            localStorage.removeItem(LS_MODULES_KEY);
            localStorage.removeItem(LS_CONFIG_KEY);
            modules = [];
            telemetryMap = {};
            config = { ...DEFAULT_CONFIG };
            renderTireCards();
            updateSummaryHeader();
            closeModal('settingsModal');
            showToast('All local data cleared.');
        }
    }

    // -------------------------------------------------------------------------
    // Modal Helpers & UI Utilities
    // -------------------------------------------------------------------------

    function openModal(id) {
        const el = document.getElementById(id);
        if (el) el.classList.add('open');
    }

    function closeModal(id) {
        const el = document.getElementById(id);
        if (el) el.classList.remove('open');
    }

    function showToast(msg) {
        const toast = document.getElementById('toast');
        if (!toast) return;
        toast.innerText = msg;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2600);
    }

    function logTerminal(msg, type = 'meta') {
        const term = document.getElementById('terminalBody');
        if (!term) return;

        const timeStr = new Date().toTimeString().split(' ')[0];
        const line = document.createElement('div');
        line.className = `terminal-line ${type}`;
        line.innerText = `[${timeStr}] ${msg}`;
        term.appendChild(line);

        while (term.children.length > 100) {
            term.removeChild(term.firstChild);
        }
        term.scrollTop = term.scrollHeight;
    }

    function clearTerminal() {
        const term = document.getElementById('terminalBody');
        if (term) term.innerHTML = '';
        logTerminal('Terminal buffer cleared.', 'meta');
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>'"]/g, tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag] || tag));
    }

    // -------------------------------------------------------------------------
    // Event Listeners
    // -------------------------------------------------------------------------

    function setupEventListeners() {
        document.getElementById('btnScanToggle')?.addEventListener('click', toggleBleScan);
        document.getElementById('btnDevicePicker')?.addEventListener('click', startDevicePickerScan);
        document.getElementById('btnAddSensor')?.addEventListener('click', openAddModal);
        document.getElementById('btnSettings')?.addEventListener('click', openSettingsModal);
        document.getElementById('btnClearTerminal')?.addEventListener('click', clearTerminal);

        document.getElementById('btn-unit-psi')?.addEventListener('click', () => setPressureUnit('psi'));
        document.getElementById('btn-unit-bar')?.addEventListener('click', () => setPressureUnit('bar'));
        document.getElementById('btn-unit-kpa')?.addEventListener('click', () => setPressureUnit('kpa'));
        document.getElementById('btn-temp-c')?.addEventListener('click', () => setTemperatureUnit('c'));
        document.getElementById('btn-temp-f')?.addEventListener('click', () => setTemperatureUnit('f'));

        document.getElementById('moduleForm')?.addEventListener('submit', saveModuleForm);
        document.getElementById('settingsForm')?.addEventListener('submit', saveSettingsForm);

        document.getElementById('btnScanCamera')?.addEventListener('click', openCameraScanner);
        document.getElementById('btnCloseScanner')?.addEventListener('click', closeCameraScanner);
        document.getElementById('qrFileInput')?.addEventListener('change', handleQrImageUpload);

        // Preset Pills
        document.querySelectorAll('.preset-pill').forEach(btn => {
            btn.addEventListener('click', () => {
                selectPresetPill(btn.dataset.pos, btn.dataset.label);
            });
        });

        // Close modal on click outside sheet
        document.querySelectorAll('.modal-backdrop').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.remove('open');
                    if (modal.id === 'scannerModal') closeCameraScanner();
                }
            });
        });

        // Terminal toggle collapse
        document.getElementById('terminalHead')?.addEventListener('click', (e) => {
            if (e.target.tagName.toLowerCase() === 'button') return;
            const body = document.getElementById('terminalBody');
            if (body) {
                body.style.display = (body.style.display === 'none') ? 'block' : 'none';
            }
        });
    }

    // Expose global methods for inline HTML onclick attributes
    window.TreelApp = {
        init,
        openAddModal,
        openEditModal,
        deleteModule,
        closeModal,
        closeCameraScanner,
        loadPreset,
        clearAllStorageData,
        assignDetectedToTire
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
