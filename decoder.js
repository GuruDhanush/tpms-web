/**
 * Treel TPMS BLE Protocol Decoder & Decryptor
 * Ported and enhanced from pankajsammal/jktyre_treel_esp32_oled
 * 
 * Supports:
 * - Mode 1: Apple iBeacon Format (UUID: FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFE0)
 * - Mode 2: SmartTyre Encrypted GATT Format (AES-128-ECB, Header 0x16)
 * - Dual-Endian MAC Matching (Forward & Reversed)
 * - 3-Byte Signature Matching (whitelistedSigs)
 * - Universal Factory AES Key: '#@Trl2018-lespl$' (identical across all Treel TPMS sensors)
 */

const TREEL_AES_KEY = '#@Trl2018-lespl$';

const TREEL_BEACON_UUID_HEX = 'ffffffffffffffffffffffffffffffe0';

/**
 * Normalizes a MAC string to uppercase colon-separated hex, e.g. "D2:58:6D:8F:16:10"
 */
function normalizeMac(macStr) {
    if (!macStr) return '';
    const clean = macStr.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (clean.length === 12) {
        return clean.match(/.{2}/g).join(':');
    }
    if (clean.length === 6) {
        // Short 6-char hex ID (e.g. 8F1610)
        return clean;
    }
    return macStr.trim().toUpperCase();
}

/**
 * Converts MAC string to 6-byte Uint8Array
 */
function macStringToBytes(macStr) {
    if (!macStr) return null;
    const clean = macStr.replace(/[^0-9a-fA-F]/g, '');
    if (clean.length !== 12) return null;
    const bytes = new Uint8Array(6);
    for (let i = 0; i < 6; i++) {
        bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return bytes;
}

/**
 * Reverses a 6-byte MAC string: "D2:58:6D:8F:16:10" -> "10:16:8F:6D:58:D2"
 */
function reverseMacString(macStr) {
    const bytes = macStringToBytes(macStr);
    if (!bytes) return '';
    const rev = Array.from(bytes).reverse().map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
    return rev;
}

/**
 * Extracts 3-byte signature from MAC (bytes 3, 4, 5) or short 6-char hex ID
 */
function getMacSignature(macStr) {
    const clean = (macStr || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (clean.length === 12) {
        const sigHex = clean.substr(6, 6);
        return [
            parseInt(sigHex.substr(0, 2), 16),
            parseInt(sigHex.substr(2, 2), 16),
            parseInt(sigHex.substr(4, 2), 16)
        ];
    } else if (clean.length === 6) {
        return [
            parseInt(clean.substr(0, 2), 16),
            parseInt(clean.substr(2, 2), 16),
            parseInt(clean.substr(4, 2), 16)
        ];
    }
    return null;
}

/**
 * Decrypts a 16-byte block using AES-128-ECB with the universal Treel key
 */
function decryptAesEcbBlock(cipherBytes) {
    if (!cipherBytes || cipherBytes.length < 16) return null;
    try {
        const key = new Uint8Array(16);
        for (let i = 0; i < 16; i++) {
            key[i] = TREEL_AES_KEY.charCodeAt(i) || 0;
        }

        let aes = null;
        if (typeof aesjs !== 'undefined') {
            aes = aesjs;
        } else if (typeof window !== 'undefined' && window.aesjs) {
            aes = window.aesjs;
        } else if (typeof require !== 'undefined') {
            try { aes = require('./aes-js.js'); } catch (e) {}
        }
        if (!aes) {
            console.error('aes-js library not loaded');
            return null;
        }

        const ecb = new aes.ModeOfOperation.ecb(key);
        const slice = cipherBytes.subarray ? cipherBytes.subarray(0, 16) : cipherBytes.slice(0, 16);
        const decrypted = ecb.decrypt(slice);
        return decrypted;
    } catch (err) {
        return null;
    }
}

/**
 * Decodes encrypted Treel TPMS GATT payload (Mode 2)
 */
function decodeGattMode(payload) {
    if (!payload || payload.length < 16) return null;

    for (let offset = 0; offset <= payload.length - 16; offset++) {
        const block = payload.slice(offset, offset + 16);
        const dec = decryptAesEcbBlock(block);
        if (!dec || dec[0] !== 0x16) continue;

        const rawTemp = dec[1] | (dec[2] << 8);
        if (rawTemp === 65535) continue;
        const tempC = (rawTemp <= 32768) ? (rawTemp / 100.0) : -((rawTemp - 32768) / 100.0);

        const rawPress = dec[3] | (dec[4] << 8);
        if (rawPress === 65535) continue;
        const pressurePsi = rawPress / 100.0;

        const battery = dec[5] & 0xFF;

        if (tempC >= -40 && tempC <= 125 && pressurePsi >= 0 && pressurePsi <= 217 && battery <= 100) {
            const rawVibX = (dec[10] | (dec[11] << 8)) << 16 >> 16;
            const rawVibZ = (dec[12] | (dec[13] << 8)) << 16 >> 16;

            return {
                mode: 'GATT/AES',
                pressurePsi: parseFloat(pressurePsi.toFixed(2)),
                tempC: parseFloat(tempC.toFixed(2)),
                battery: battery,
                vibX: parseFloat((rawVibX / 1000.0).toFixed(3)),
                vibZ: parseFloat((rawVibZ / 1000.0).toFixed(3)),
                tagCount: dec[8],
                impactCount: dec[9],
                rawDecryptedHex: Array.from(dec).map(b => b.toString(16).padStart(2, '0')).join('')
            };
        }
    }
    return null;
}

/**
 * Decodes Apple iBeacon Treel TPMS payload (Mode 1)
 */
function decodeBeaconMode(payload) {
    if (!payload || payload.length < 23) return null;

    const TREEL_UUID = [
        0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xE0
    ];

    for (let offset = 0; offset <= payload.length - 23; offset++) {
        if (payload[offset] === 0x02 && payload[offset + 1] === 0x15) {
            let uuidMatch = true;
            for (let i = 0; i < 16; i++) {
                if (payload[offset + 2 + i] !== TREEL_UUID[i]) {
                    uuidMatch = false;
                    break;
                }
            }
            if (!uuidMatch) continue;

            const major = (payload[offset + 18] << 8) | payload[offset + 19];
            const minor = (payload[offset + 20] << 8) | payload[offset + 21];
            const txTemp = payload[offset + 22];

            const pressPsi = (minor & 0xFF);
            const tempC = (txTemp > 65) ? (txTemp - 110) : 0;

            if (pressPsi >= 0 && pressPsi <= 217 && tempC >= -40 && tempC <= 125) {
                const sensorId = major.toString(16).toUpperCase().padStart(4, '0') + '-' +
                                 minor.toString(16).toUpperCase().padStart(4, '0');
                return {
                    mode: 'iBeacon',
                    pressurePsi: parseFloat(pressPsi.toFixed(1)),
                    tempC: parseFloat(tempC.toFixed(1)),
                    battery: -1,
                    sensorId: sensorId,
                    major: major,
                    minor: minor
                };
            }
        }
    }
    return null;
}

function bufferContainsSignature(buf, sig) {
    if (!buf || !sig || buf.length < 3) return false;
    for (let i = 0; i <= buf.length - 3; i++) {
        if (buf[i] === sig[0] && buf[i + 1] === sig[1] && buf[i + 2] === sig[2]) {
            return true;
        }
    }
    return false;
}

function bufferContainsReversedSignature(buf, sig) {
    if (!buf || !sig || buf.length < 3) return false;
    for (let i = 0; i <= buf.length - 3; i++) {
        if (buf[i] === sig[2] && buf[i + 1] === sig[1] && buf[i + 2] === sig[0]) {
            return true;
        }
    }
    return false;
}

/**
 * Matches an incoming BLE packet against configured TPMS modules
 */
function matchModuleForPacket(packet, modules, decoded) {
    if (!modules || !modules.length) return null;

    const deviceId = (packet.deviceId || '').toUpperCase();
    const deviceName = (packet.deviceName || '').toUpperCase();
    const combinedBytes = packet.allBytes || [];

    for (const mod of modules) {
        if (!mod.mac) continue;
        const normMac = normalizeMac(mod.mac);
        const cleanMac = normMac.replace(/[^0-9A-F]/g, '');
        const revMac = reverseMacString(normMac);
        const cleanRevMac = revMac.replace(/[^0-9A-F]/g, '');
        const sig = getMacSignature(mod.mac);
        const shortId = cleanMac.length >= 6 ? cleanMac.substr(cleanMac.length - 6) : cleanMac;

        // 1. Direct device ID match (Forward or Reversed)
        if (deviceId && (deviceId === normMac || deviceId.replace(/[^0-9A-F]/g, '') === cleanMac)) {
            return mod;
        }
        if (deviceId && (deviceId === revMac || deviceId.replace(/[^0-9A-F]/g, '') === cleanRevMac)) {
            return mod;
        }

        // 2. Device Name match
        if (deviceName && (deviceName.includes(shortId) || deviceName.includes(cleanMac))) {
            return mod;
        }

        // 3. Payload 3-byte signature matching
        if (sig && combinedBytes.length >= 3) {
            if (bufferContainsSignature(combinedBytes, sig) || bufferContainsReversedSignature(combinedBytes, sig)) {
                return mod;
            }
        }

        // 4. Decoded sensor ID match
        if (decoded && decoded.sensorId) {
            const cleanSensorId = decoded.sensorId.replace(/[^0-9A-F]/g, '');
            if (cleanMac.includes(cleanSensorId) || cleanSensorId.includes(cleanMac) ||
                cleanSensorId.includes(shortId)) {
                return mod;
            }
        }
    }

    return null;
}

/**
 * Extracts MAC address from scanned QR text or barcode
 */
function parseTreelQrCode(qrText) {
    if (!qrText || typeof qrText !== 'string') return null;
    const text = qrText.trim();
    const result = {
        raw: text,
        mac: '',
        shortId: ''
    };

    if (text.startsWith('{') && text.endsWith('}')) {
        try {
            const parsed = JSON.parse(text);
            if (parsed.mac) result.mac = normalizeMac(parsed.mac);
            if (parsed.id) result.shortId = parsed.id;
            return result;
        } catch (e) {}
    }

    const macRegex = /(?:MAC[:=\s]*)?([0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5})/i;
    const macMatch = text.match(macRegex);
    if (macMatch) {
        result.mac = normalizeMac(macMatch[1]);
    } else {
        const hex12 = text.match(/(?:^|[^0-9A-Fa-f])([0-9A-Fa-f]{12})(?:$|[^0-9A-Fa-f])/);
        if (hex12) {
            result.mac = normalizeMac(hex12[1]);
        }
    }

    if (!result.mac) {
        const hex6 = text.match(/\b([0-9A-Fa-f]{6})\b/);
        if (hex6) {
            result.shortId = hex6[1].toUpperCase();
            result.mac = result.shortId;
        }
    }

    return result;
}

/**
 * Extracts raw byte buffers and debug info from Web Bluetooth advertisement
 */
function extractAdvertisementBuffers(rawPacket) {
    const buffers = [];
    const allBytes = [];
    const debugEntries = [];

    // 1. Process BluetoothManufacturerDataMap (Map object)
    if (rawPacket.manufacturerData) {
        const handleMfgEntry = (dataView, companyId) => {
            if (!dataView) return;
            const offset = dataView.byteOffset || 0;
            const length = dataView.byteLength != null ? dataView.byteLength : dataView.buffer.byteLength;
            const bytes = new Uint8Array(dataView.buffer, offset, length);

            // Raw manufacturer data payload
            buffers.push(bytes);

            // Also create full packet with 2-byte Company ID header
            const cId = Number(companyId) || 0;
            const withCompanyId = new Uint8Array(2 + bytes.length);
            withCompanyId[0] = cId & 0xff;
            withCompanyId[1] = (cId >> 8) & 0xff;
            withCompanyId.set(bytes, 2);
            buffers.push(withCompanyId);

            allBytes.push(...withCompanyId);

            const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
            debugEntries.push(`Mfg 0x${cId.toString(16).padStart(4, '0')} (${bytes.length}B): ${hex}`);
        };

        if (typeof rawPacket.manufacturerData.forEach === 'function') {
            rawPacket.manufacturerData.forEach(handleMfgEntry);
        } else if (rawPacket.manufacturerData.entries) {
            for (const [id, dv] of rawPacket.manufacturerData.entries()) {
                handleMfgEntry(dv, id);
            }
        } else if (typeof rawPacket.manufacturerData === 'object') {
            for (const [id, dv] of Object.entries(rawPacket.manufacturerData)) {
                handleMfgEntry(dv, id);
            }
        }
    }

    // 2. Process BluetoothServiceDataMap (Map object)
    if (rawPacket.serviceData) {
        const handleServiceEntry = (dataView, uuid) => {
            if (!dataView) return;
            const offset = dataView.byteOffset || 0;
            const length = dataView.byteLength != null ? dataView.byteLength : dataView.buffer.byteLength;
            const bytes = new Uint8Array(dataView.buffer, offset, length);

            buffers.push(bytes);
            allBytes.push(...bytes);

            const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
            debugEntries.push(`Service ${uuid} (${bytes.length}B): ${hex}`);
        };

        if (typeof rawPacket.serviceData.forEach === 'function') {
            rawPacket.serviceData.forEach(handleServiceEntry);
        } else if (rawPacket.serviceData.entries) {
            for (const [uuid, dv] of rawPacket.serviceData.entries()) {
                handleServiceEntry(dv, uuid);
            }
        } else if (typeof rawPacket.serviceData === 'object') {
            for (const [uuid, dv] of Object.entries(rawPacket.serviceData)) {
                handleServiceEntry(dv, uuid);
            }
        }
    }

    // 3. Fallback for rawBytes array
    if (rawPacket.rawBytes) {
        const bytes = new Uint8Array(rawPacket.rawBytes);
        buffers.push(bytes);
        allBytes.push(...bytes);
        debugEntries.push(`Raw (${bytes.length}B): ${Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')}`);
    }

    return {
        buffers,
        allBytes: new Uint8Array(allBytes),
        debugEntries
    };
}

/**
 * Master parser for any BLE advertisement packet
 */
function processBlePacket(rawPacket, modules) {
    const extracted = extractAdvertisementBuffers(rawPacket);

    const packet = {
        deviceId: rawPacket.deviceId || '',
        deviceName: rawPacket.deviceName || '',
        rssi: rawPacket.rssi || -100,
        allBytes: extracted.allBytes,
        buffers: extracted.buffers,
        debugEntries: extracted.debugEntries,
        timestamp: Date.now()
    };

    let decoded = null;

    // Scan all individual buffers and the combined buffer
    const candidateBuffers = [extracted.allBytes, ...extracted.buffers];

    for (const buf of candidateBuffers) {
        if (!buf || buf.length < 16) continue;

        // Mode 1: iBeacon
        decoded = decodeBeaconMode(buf);
        if (decoded) break;

        // Mode 2: GATT Encrypted
        decoded = decodeGattMode(buf);
        if (decoded) break;
    }

    if (decoded) {
        let matchedModule = matchModuleForPacket(packet, modules, decoded);

        // If only 1 module is configured and no specific match, match it directly
        if (!matchedModule && modules && modules.length === 1) {
            matchedModule = modules[0];
        }

        return {
            matchedModule: matchedModule,
            data: decoded,
            rssi: packet.rssi,
            deviceName: packet.deviceName,
            deviceId: packet.deviceId,
            timestamp: packet.timestamp,
            rawBytesHex: Array.from(extracted.allBytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
            debugEntries: extracted.debugEntries
        };
    }

    return {
        matchedModule: null,
        data: null,
        rssi: packet.rssi,
        deviceName: packet.deviceName,
        deviceId: packet.deviceId,
        timestamp: packet.timestamp,
        debugEntries: extracted.debugEntries
    };
}

// Export for browser and node
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        TREEL_AES_KEY,
        normalizeMac,
        macStringToBytes,
        reverseMacString,
        getMacSignature,
        decryptAesEcbBlock,
        decodeGattMode,
        decodeBeaconMode,
        matchModuleForPacket,
        parseTreelQrCode,
        extractAdvertisementBuffers,
        processBlePacket
    };
} else {
    window.TreelDecoder = {
        TREEL_AES_KEY,
        normalizeMac,
        macStringToBytes,
        reverseMacString,
        getMacSignature,
        decryptAesEcbBlock,
        decodeGattMode,
        decodeBeaconMode,
        matchModuleForPacket,
        parseTreelQrCode,
        extractAdvertisementBuffers,
        processBlePacket
    };
}
