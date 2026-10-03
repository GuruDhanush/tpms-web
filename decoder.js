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

// Universal factory encryption key used by all Treel TPMS sensors
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
        console.warn('AES decrypt error:', err);
        return null;
    }
}

/**
 * Decodes encrypted Treel TPMS GATT payload (Mode 2)
 * Decrypted byte layout:
 * [0]     : 0x16 (Tag type)
 * [1..2]  : Surface Temp (°C * 100, Little-Endian)
 * [3..4]  : Pressure (PSI * 100, Little-Endian)
 * [5]     : Battery % (0..100)
 * [6]     : Flags
 * [7]     : Tire Temp Count
 * [8]     : Tag Count
 * [9]     : Impact Count
 * [10..11]: VibX (g-force * 1000, signed LE)
 * [12..13]: VibZ (g-force * 1000, signed LE)
 */
function decodeGattMode(payload) {
    if (!payload || payload.length < 16) return null;

    // Scan through all 16-byte blocks
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

        // Plausibility check
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
function matchModuleForPacket(packet, modules) {
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

        // 4. In case the MAC string itself appears in ASCII in advertisement
        if (packet.asciiDump && (packet.asciiDump.includes(shortId) || packet.asciiDump.includes(cleanMac))) {
            return mod;
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

    // Try parsing JSON if formatted that way
    if (text.startsWith('{') && text.endsWith('}')) {
        try {
            const parsed = JSON.parse(text);
            if (parsed.mac) result.mac = normalizeMac(parsed.mac);
            if (parsed.id) result.shortId = parsed.id;
            return result;
        } catch (e) {}
    }

    // Match 6 pairs of hex digits (MAC address: XX:XX:XX:XX:XX:XX or XX-XX-XX-XX-XX-XX), with optional MAC: prefix
    const macRegex = /(?:MAC[:=\s]*)?([0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5})/i;
    const macMatch = text.match(macRegex);
    if (macMatch) {
        result.mac = normalizeMac(macMatch[1]);
    } else {
        // Look for 12 contiguous hex characters
        const hex12 = text.match(/(?:^|[^0-9A-Fa-f])([0-9A-Fa-f]{12})(?:$|[^0-9A-Fa-f])/);
        if (hex12) {
            result.mac = normalizeMac(hex12[1]);
        }
    }

    // Look for 6-char short ID if no full MAC found
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
 * Master parser for any BLE advertisement packet
 */
function processBlePacket(rawPacket, modules) {
    let allBytes = [];

    if (rawPacket.manufacturerData) {
        for (const [mfgId, dataView] of Object.entries(rawPacket.manufacturerData)) {
            const arr = new Uint8Array(dataView.buffer || dataView);
            allBytes.push(...arr);
        }
    }

    if (rawPacket.serviceData) {
        for (const [uuid, dataView] of Object.entries(rawPacket.serviceData)) {
            const arr = new Uint8Array(dataView.buffer || dataView);
            allBytes.push(...arr);
        }
    }

    if (rawPacket.rawBytes) {
        allBytes.push(...rawPacket.rawBytes);
    }

    const packet = {
        deviceId: rawPacket.deviceId || '',
        deviceName: rawPacket.deviceName || '',
        rssi: rawPacket.rssi || -100,
        allBytes: new Uint8Array(allBytes),
        timestamp: Date.now()
    };

    let matchedModule = matchModuleForPacket(packet, modules);

    // 1. Try iBeacon decode
    let decoded = decodeBeaconMode(packet.allBytes);

    // 2. Try GATT Encrypted decode with universal key
    if (!decoded) {
        decoded = decodeGattMode(packet.allBytes);
    }

    if (decoded) {
        if (!matchedModule && decoded.sensorId && modules && modules.length) {
            const cleanSensorId = decoded.sensorId.replace(/[^0-9A-F]/g, '');
            matchedModule = modules.find(m => {
                const cleanM = (m.mac || '').replace(/[^0-9A-F]/g, '').toUpperCase();
                return cleanM.includes(cleanSensorId) || cleanSensorId.includes(cleanM);
            });
        }

        return {
            matchedModule: matchedModule,
            data: decoded,
            rssi: packet.rssi,
            timestamp: packet.timestamp,
            rawBytesHex: Array.from(packet.allBytes).map(b => b.toString(16).padStart(2, '0')).join(' ')
        };
    }

    return null;
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
        processBlePacket
    };
}
