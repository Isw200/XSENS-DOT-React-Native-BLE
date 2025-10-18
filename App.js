// App.js
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BleManager } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import {
  PermissionsAndroid,
  Platform,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  FlatList,
} from 'react-native';

// ---------- DOT UUID helpers ----------
const U = (short) => `1517${short}-4947-11e9-8646-d663bd873d93`;

// Names seen on different firmwares
const TARGET_NAME_PREFIXES = ['Movella DOT', 'Xsens DOT', 'XS-DOT', 'DOT-'];

// Services
const MEAS_SERVICE   = U('2000'); // Measurement (stream)

// Characteristics (measurement)
const MEAS_CONTROL  = U('2001');  // write: select payload + start/stop
const PAYLOAD_LONG  = U('2002');  // notify: long   (not used here)
const PAYLOAD_MED   = U('2003');  // notify: medium (we use this)
const PAYLOAD_SHORT = U('2004');  // notify: short  (not used here)

// --------- Payload modes (per spec) ---------
// We want both Euler + Free Accel together → "Complete (Euler)" = mode 16 (0x10)
// Structure (total 28 bytes): Timestamp(4) + Euler(12) + FreeAcc(12)
// Ref: Movella DOT BLE Services Spec, Table 15 & list (modes 4,5,6,7,16 etc).
// https://www.xsens.com/hubfs/Downloads/Manuals/Xsens%20DOT%20BLE%20Services%20Specifications.pdf
const MODE_ORI_EULER          = 0x04; // short
const MODE_ORI_QUAT           = 0x05; // short
const MODE_FREEACC            = 0x06; // short
const MODE_EXT_EULER          = 0x07; // medium (euler + freeacc + status + clip)
const MODE_COMPLETE_EULER     = 0x10; // medium (euler + freeacc)  <-- we use this
const MODE_COMPLETE_QUAT      = 0x03; // medium (quat + freeacc)

// We will hard-select COMPLETE_EULER to show angles + acceleration together
const SELECTED_PAYLOAD_MODE = MODE_COMPLETE_EULER;

const MAX_SAMPLES = 25;

if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}

// ---------- helpers ----------
const toTimeLabel = (timestamp) => {
  const d = new Date(timestamp);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
};

const toHex = (buffer) => Array.from(buffer).map((b) => b.toString(16).padStart(2, '0')).join(' ');

// ---- Decoder for COMPLETE_EULER (mode 0x10): TS + Euler(xyz) + FreeAcc(xyz) ----
const parseCompleteEuler = (buf) => {
  // Expect at least 4 + 12 + 12 = 28 bytes
  if (!buf || buf.length < 28) {
    return { dotTimestampUs: 0, euler: [0, 0, 0], acc: [0, 0, 0] };
  }
  const ts = buf.readUInt32LE(0);
  const payload = buf.slice(4); // Now 24 bytes (6 floats)

  const floats = [];
  for (let i = 0; i < 6; i++) {
    const v = payload.readFloatLE(i * 4);
    floats.push(Number.isFinite(v) ? v : 0);
  }
  const euler = floats.slice(0, 3); // degrees
  const acc   = floats.slice(3, 6); // m/s^2 (free acceleration)
  return { dotTimestampUs: ts, euler, acc };
};

const getErrorMessage = (e) => {
  if (!e) return '';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  return 'Unexpected error';
};

// ---------- App ----------
export default function App() {
  const manager = useMemo(() => new BleManager(), []);
  const [isScanning, setIsScanning] = useState(false);
  const [connectedDevice, setConnectedDevice] = useState(null);
  const [devices, setDevices] = useState([]);
  const [samples, setSamples] = useState([]); // each sample: {timestamp, dotTimestampUs, euler[3], acc[3], hex}
  const [error, setError] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  const scanTimeoutRef = useRef(null);
  const monitorRef = useRef(null);
  const devicesRef = useRef(new Map());

  // global error handler
  useEffect(() => {
    const handleError = (err) => setError(getErrorMessage(err));
    const prev = global.ErrorUtils?.setGlobalHandler?.(handleError);
    return () => { if (prev) global.ErrorUtils?.setGlobalHandler?.(prev); };
  }, []);

  // init & cleanup BLE
  useEffect(() => {
    const initBLE = async () => {
      const state = await manager.state();
      if (state !== 'PoweredOn') {
        const sub = manager.onStateChange((newState) => {
          if (newState === 'PoweredOn') sub.remove();
        }, true);
      }
    };
    initBLE();
    return () => {
      manager.stopDeviceScan();
      monitorRef.current?.remove?.();
      manager.destroy();
    };
  }, [manager]);

  // auto cleanup on disconnect
  useEffect(() => {
    if (!connectedDevice) return;
    const sub = manager.onDeviceDisconnected(connectedDevice.id, () => {
      monitorRef.current?.remove?.();
      setConnectedDevice(null);
      setIsStreaming(false);
      setSamples([]);
    });
    return () => sub.remove();
  }, [connectedDevice, manager]);

  const requestPermissions = useCallback(async () => {
    if (Platform.OS !== 'android') return true;
    const perms = [];
    if (Platform.Version >= 31) {
      perms.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN);
      perms.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
    } else {
      perms.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH);
      perms.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADMIN);
    }
    perms.push(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
    perms.push(PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION);
    const statuses = await PermissionsAndroid.requestMultiple(perms);
    const denied = Object.values(statuses).some((s) => s !== PermissionsAndroid.RESULTS.GRANTED);
    if (denied) { setError('Bluetooth permissions are required.'); return false; }
    return true;
  }, []);

  const stopScan = useCallback(() => {
    manager.stopDeviceScan();
    if (scanTimeoutRef.current) {
      clearTimeout(scanTimeoutRef.current);
      scanTimeoutRef.current = null;
    }
    setIsScanning(false);
  }, [manager]);

  const startScan = useCallback(async () => {
    setError('');
    const allowed = await requestPermissions();
    if (!allowed) return;

    devicesRef.current.clear();
    setDevices([]);
    setIsScanning(true);

    manager.startDeviceScan(null, null, (scanError, device) => {
      if (scanError) {
        setError(getErrorMessage(scanError));
        stopScan();
        return;
      }
      if (!device?.name) return;
      const match = TARGET_NAME_PREFIXES.some((p) => device.name.startsWith(p));
      if (!match) return;
      if (!devicesRef.current.has(device.id)) {
        devicesRef.current.set(device.id, device);
        setDevices(Array.from(devicesRef.current.values()));
      }
    });

    scanTimeoutRef.current = setTimeout(stopScan, 15000);
  }, [manager, requestPermissions, stopScan]);

  const writeControl = async (device, bytes) => {
    const v = Buffer.from(bytes).toString('base64');
    try {
      await device.writeCharacteristicWithResponseForService(MEAS_SERVICE, MEAS_CONTROL, v);
    } catch {
      await device.writeCharacteristicWithoutResponseForService(MEAS_SERVICE, MEAS_CONTROL, v);
    }
  };

  const handleDisconnect = useCallback(async () => {
    setError('');
    if (!connectedDevice) return;
    try {
      if (isStreaming) {
        await writeControl(connectedDevice, [0x01, 0x00, 0x00]); // stop
      }
    } catch {}
    monitorRef.current?.remove?.();
    monitorRef.current = null;
    try { await manager.cancelDeviceConnection(connectedDevice.id); } catch {}
    setConnectedDevice(null);
    setIsStreaming(false);
    setSamples([]);
  }, [connectedDevice, isStreaming, manager]);

  const bindMonitorCompleteEuler = useCallback(async (device) => {
    // Complete(Euler) is a MEDIUM payload → notify on 0x2003
    monitorRef.current?.remove?.();
    monitorRef.current = device.monitorCharacteristicForService(
      MEAS_SERVICE,
      PAYLOAD_MED,
      (monitorError, characteristic) => {
        try {
          if (monitorError) { setError(getErrorMessage(monitorError)); return; }
          if (!characteristic?.value) return;

          const buf = Buffer.from(characteristic.value, 'base64');
          const { dotTimestampUs, euler, acc } = parseCompleteEuler(buf);

          setSamples((prev) => {
            const next = [{
              id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
              timestamp: Date.now(), // host time
              dotTimestampUs,
              euler, // [x,y,z] degrees
              acc,   // [ax,ay,az] m/s^2
              hex: toHex(buf),
            }, ...prev];
            if (next.length > MAX_SAMPLES) next.length = MAX_SAMPLES;
            return next;
          });
        } catch (e) {
          setError(getErrorMessage(e));
        }
      }
    );
  }, [setSamples]);

  const handleConnect = useCallback(async (deviceId) => {
    await handleDisconnect();
    setError('');
    stopScan();
    try {
      const device = await manager.connectToDevice(deviceId, { autoConnect: false, requestMTU: 247 });
      await device.discoverAllServicesAndCharacteristics();
      setConnectedDevice(device);

      // bind monitor for medium payload stream (Complete Euler)
      await bindMonitorCompleteEuler(device);
    } catch (e) {
      setConnectedDevice(null);
      setError(getErrorMessage(e));
    }
  }, [bindMonitorCompleteEuler, handleDisconnect, manager, stopScan]);

  const handleStartStream = useCallback(async () => {
    if (!connectedDevice) return;
    setError('');
    try {
      // Start measurement in "Complete (Euler)" mode (0x10)
      await writeControl(connectedDevice, [0x01, 0x01, SELECTED_PAYLOAD_MODE]);
      setIsStreaming(true);
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }, [connectedDevice]);

  const handleStopStream = useCallback(async () => {
    if (!connectedDevice) return;
    setError('');
    try {
      await writeControl(connectedDevice, [0x01, 0x00, 0x00]); // stop
      setIsStreaming(false);
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }, [connectedDevice]);

  // UI rows
  const renderDevice = ({ item }) => (
    <TouchableOpacity style={styles.deviceRow} onPress={() => handleConnect(item.id)}>
      <View>
        <Text style={styles.deviceName}>{item.name || 'Unknown device'}</Text>
        <Text style={styles.deviceId}>{item.id}</Text>
      </View>
      <Text style={styles.deviceAction}>Connect</Text>
    </TouchableOpacity>
  );

  const renderSample = ({ item }) => (
    <View style={styles.sampleRow}>
      <Text style={styles.sampleTime}>{toTimeLabel(item.timestamp)}</Text>
      <Text style={styles.sampleFloats}>
        Euler (deg) — X: {item.euler?.[0]?.toFixed?.(3) ?? '0.000'} | Y: {item.euler?.[1]?.toFixed?.(3) ?? '0.000'} | Z: {item.euler?.[2]?.toFixed?.(3) ?? '0.000'}
      </Text>
      <Text style={styles.sampleFloats}>
        Acc (m/s²) — X: {item.acc?.[0]?.toFixed?.(3) ?? '0.000'} | Y: {item.acc?.[1]?.toFixed?.(3) ?? '0.000'} | Z: {item.acc?.[2]?.toFixed?.(3) ?? '0.000'}
      </Text>
    </View>
  );

  // Current panel
  const current = samples[0];

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        <Text style={styles.title}>XSENS / Movella DOT Monitor</Text>
        <Text style={[styles.status, connectedDevice ? styles.statusOnline : styles.statusOffline]}>
          {connectedDevice ? 'Connected' : 'Disconnected'}
        </Text>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.actions}>
        <TouchableOpacity
          onPress={isScanning ? stopScan : startScan}
          style={[styles.button, isScanning ? styles.buttonActive : null]}
        >
          <Text style={styles.buttonText}>{isScanning ? 'Stop scan' : 'Scan for sensors'}</Text>
        </TouchableOpacity>
        {connectedDevice ? (
          <TouchableOpacity onPress={handleDisconnect} style={styles.buttonSecondary}>
            <Text style={styles.buttonText}>Disconnect</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* CURRENT DATA (Angles + Acceleration together) */}
      {connectedDevice ? (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.sectionTitle}>Current Data</Text>
            <View style={styles.streamingActions}>
              <TouchableOpacity
                onPress={handleStartStream}
                disabled={isStreaming}
                style={[styles.smallButton, isStreaming && styles.buttonDisabled]}
              >
                <Text style={styles.smallButtonText}>Start</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleStopStream}
                disabled={!isStreaming}
                style={[styles.smallButton, !isStreaming && styles.buttonDisabled]}
              >
                <Text style={styles.smallButtonText}>Stop</Text>
              </TouchableOpacity>
            </View>
          </View>

          {current ? (
            <View style={styles.grid}>
              <View style={styles.kv}>
                <Text style={styles.kLabel}>Rotation X (deg)</Text>
                <Text style={styles.kValue}>{current.euler[0].toFixed(3)}</Text>
              </View>
              <View style={styles.kv}>
                <Text style={styles.kLabel}>Rotation Y (deg)</Text>
                <Text style={styles.kValue}>{current.euler[1].toFixed(3)}</Text>
              </View>
              <View style={styles.kv}>
                <Text style={styles.kLabel}>Rotation Z (deg)</Text>
                <Text style={styles.kValue}>{current.euler[2].toFixed(3)}</Text>
              </View>

              <View style={styles.kv}>
                <Text style={styles.kLabel}>Accel X (m/s²)</Text>
                <Text style={styles.kValue}>{current.acc[0].toFixed(3)}</Text>
              </View>
              <View style={styles.kv}>
                <Text style={styles.kLabel}>Accel Y (m/s²)</Text>
                <Text style={styles.kValue}>{current.acc[1].toFixed(3)}</Text>
              </View>
              <View style={styles.kv}>
                <Text style={styles.kLabel}>Accel Z (m/s²)</Text>
                <Text style={styles.kValue}>{current.acc[2].toFixed(3)}</Text>
              </View>

              <View style={styles.kv}>
                <Text style={styles.kLabel}>DOT Timestamp (µs)</Text>
                <Text style={styles.kValue}>{String(current.dotTimestampUs)}</Text>
              </View>
              <View style={styles.kv}>
                <Text style={styles.kLabel}>Host Time</Text>
                <Text style={styles.kValue}>{toTimeLabel(current.timestamp)}</Text>
              </View>
            </View>
          ) : (
            <Text style={styles.placeholder}>Waiting for data…</Text>
          )}
        </View>
      ) : null}

      {/* DEVICES */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Available sensors</Text>
        <FlatList
          data={devices}
          keyExtractor={(item) => item.id}
          renderItem={renderDevice}
          ListEmptyComponent={!connectedDevice ? <Text style={styles.placeholder}>No devices yet</Text> : null}
          contentContainerStyle={devices.length === 0 ? styles.listEmpty : undefined}
        />
      </View>

      {/* RAW STREAM LIST */}
      {connectedDevice ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Raw Stream</Text>
          <FlatList
            data={samples}
            keyExtractor={(item) => item.id}
            renderItem={renderSample}
            contentContainerStyle={samples.length === 0 ? styles.listEmpty : undefined}
            ListEmptyComponent={<Text style={styles.placeholder}>Waiting for data…</Text>}
          />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

// ---------- styles ----------
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050608', paddingHorizontal: 16, paddingTop: 12 },
  header: { alignItems: 'center', marginBottom: 12 },
  title: { fontSize: 24, fontWeight: '600', color: '#f4f6fb' },
  status: { marginTop: 6, fontSize: 14 },
  statusOnline: { color: '#4cc38a' },
  statusOffline: { color: '#ff6b6b' },
  error: { color: '#ff6b6b', textAlign: 'center', marginBottom: 12 },

  actions: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 },
  button: { flex: 1, backgroundColor: '#137bf4', paddingVertical: 14, borderRadius: 8, alignItems: 'center', marginRight: 8 },
  buttonSecondary: { flex: 1, backgroundColor: '#2b2f36', paddingVertical: 14, borderRadius: 8, alignItems: 'center', marginLeft: 8 },
  buttonActive: { backgroundColor: '#0f5ec0' },
  buttonText: { color: '#f4f6fb', fontSize: 16, fontWeight: '500' },

  section: { flex: 1, marginBottom: 16 },
  sectionTitle: { color: '#f4f6fb', fontSize: 18, fontWeight: '600', marginBottom: 8 },
  listEmpty: { flexGrow: 1, justifyContent: 'center', alignItems: 'center' },
  placeholder: { color: '#98a1b3' },

  deviceRow: { backgroundColor: '#11141a', borderRadius: 10, padding: 16, marginBottom: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  deviceName: { color: '#f4f6fb', fontSize: 16, fontWeight: '500' },
  deviceId: { color: '#768098', fontSize: 12, marginTop: 4 },
  deviceAction: { color: '#137bf4', fontSize: 14, fontWeight: '500' },

  // Current data card
  card: { backgroundColor: '#0b0d12', borderRadius: 12, padding: 14, marginBottom: 14 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },

  streamingActions: { flexDirection: 'row' },
  smallButton: { backgroundColor: '#2b2f36', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, marginLeft: 8 },
  smallButtonText: { color: '#f4f6fb', fontSize: 14, fontWeight: '500' },
  buttonDisabled: { opacity: 0.5 },

  // Grid for labeled values
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  kv: { width: '50%', paddingVertical: 6, paddingRight: 8 },
  kLabel: { color: '#98a1b3', fontSize: 12 },
  kValue: { color: '#f4f6fb', fontSize: 16, fontWeight: '600', marginTop: 2 },

  // Raw stream row
  sampleRow: { backgroundColor: '#0b0d12', borderRadius: 10, padding: 14, marginBottom: 10 },
  sampleTime: { color: '#98a1b3', fontSize: 12, marginBottom: 6 },
  sampleFloats: { color: '#ffb86b', fontSize: 12 },
});
