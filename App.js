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

// ---------- DOT UUIDs ----------
const U = (short) => `1517${short}-4947-11e9-8646-d663bd873d93`;

// Names seen on different firmwares
const TARGET_NAME_PREFIXES = ['Movella DOT', 'Xsens DOT', 'XS-DOT', 'DOT-'];

// Services
const CONFIG_SERVICE = U('1000');     // (not used here)
const MEAS_SERVICE   = U('2000');     // Measurement (stream)

// Characteristics (measurement)
const MEAS_CONTROL  = U('2001');      // write/read: start/stop + payload
const PAYLOAD_LONG  = U('2002');      // notify: long
const PAYLOAD_MED   = U('2003');      // notify: medium
const PAYLOAD_SHORT = U('2004');      // notify: short

// Payload modes we commonly use on short payload char (0x2004)
const PAYLOAD_EULER      = 0x04; // Euler angles (deg)
const PAYLOAD_QUATERNION = 0x05; // Quaternion (w,x,y,z)
const PAYLOAD_FREEACC    = 0x06; // Free acceleration (m/s^2)

// ---- SELECT YOUR MODE HERE (kept as before) ----
const SELECTED_PAYLOAD_MODE = PAYLOAD_EULER; // default Euler
// const SELECTED_PAYLOAD_MODE = PAYLOAD_QUATERNION;
// const SELECTED_PAYLOAD_MODE = PAYLOAD_FREEACC;

// Map payload mode -> which notify characteristic to monitor
const payloadModeToChar = (mode) => {
  if (mode === 0x04 || mode === 0x05 || mode === 0x06) return PAYLOAD_SHORT;
  return PAYLOAD_MED; // safe default for other modes
};

const MAX_SAMPLES = 25;

if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}

// ---------- helpers ----------
const toTimeLabel = (timestamp) => {
  const date = new Date(timestamp);
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
};

const toHex = (buffer) => Array.from(buffer)
  .map((b) => b.toString(16).padStart(2, '0'))
  .join(' ');

// ---- CORRECT DECODER: skip 4B timestamp, then read floats by mode ----
const parseDotPayload = (buf, mode) => {
  if (!buf || buf.length < 4) {
    return { dotTimestampUs: 0, floats: [] };
  }
  const dotTimestampUs = buf.readUInt32LE(0); // sensor timestamp (µs)
  const payload = buf.slice(4);

  let count = 0;
  if (mode === PAYLOAD_EULER) count = 3;          // X,Y,Z (deg)
  else if (mode === PAYLOAD_QUATERNION) count = 4; // w,x,y,z
  else if (mode === PAYLOAD_FREEACC) count = 3;    // X,Y,Z (m/s^2)
  else count = Math.floor(payload.length / 4);     // fallback

  const floats = [];
  for (let i = 0; i < count && (i * 4 + 3) < payload.length; i++) {
    const v = payload.readFloatLE(i * 4);
    floats.push(Number.isFinite(v) ? Number(v.toFixed(4)) : 0);
  }
  return { dotTimestampUs, floats };
};

// Build display fields based on selected mode
const getLabeledFields = (sample, mode) => {
  if (!sample) return [];
  const f = sample.floats || [];
  const fields = [];

  if (mode === PAYLOAD_EULER) {
    const [x = 0, y = 0, z = 0] = f;
    fields.push({ label: 'Rotation X (deg)', value: x.toFixed(3) });
    fields.push({ label: 'Rotation Y (deg)', value: y.toFixed(3) });
    fields.push({ label: 'Rotation Z (deg)', value: z.toFixed(3) });
  } else if (mode === PAYLOAD_QUATERNION) {
    const [w = 0, x = 0, y = 0, z = 0] = f;
    fields.push({ label: 'qW', value: w.toFixed(4) });
    fields.push({ label: 'qX', value: x.toFixed(4) });
    fields.push({ label: 'qY', value: y.toFixed(4) });
    fields.push({ label: 'qZ', value: z.toFixed(4) });
  } else if (mode === PAYLOAD_FREEACC) {
    const [ax = 0, ay = 0, az = 0] = f;
    fields.push({ label: 'Accel X (m/s²)', value: ax.toFixed(3) });
    fields.push({ label: 'Accel Y (m/s²)', value: ay.toFixed(3) });
    fields.push({ label: 'Accel Z (m/s²)', value: az.toFixed(3) });
  } else {
    f.slice(0, 6).forEach((v, i) => fields.push({ label: `Float ${i}`, value: v.toFixed(3) }));
  }

  fields.push({ label: 'DOT Timestamp (µs)', value: String(sample.dotTimestampUs || 0) });
  fields.push({ label: 'Host Time', value: toTimeLabel(sample.timestamp) });
  return fields;
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
  const [samples, setSamples] = useState([]);
  const [error, setError] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  const scanTimeoutRef = useRef(null);
  const monitorRef = useRef(null);
  const devicesRef = useRef(new Map());

  useEffect(() => {
    const handleError = (err) => setError(getErrorMessage(err));
    const prev = global.ErrorUtils?.setGlobalHandler?.(handleError);
    return () => { if (prev) global.ErrorUtils?.setGlobalHandler?.(prev); };
  }, []);

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

  const handleDisconnect = useCallback(async () => {
    setError('');
    if (!connectedDevice) return;
    try {
      if (isStreaming) {
        const stopCmd = Buffer.from([0x01, 0x00, 0x00]).toString('base64');
        try {
          await connectedDevice.writeCharacteristicWithResponseForService(MEAS_SERVICE, MEAS_CONTROL, stopCmd);
        } catch {
          await connectedDevice.writeCharacteristicWithoutResponseForService(MEAS_SERVICE, MEAS_CONTROL, stopCmd);
        }
      }
    } catch {}
    monitorRef.current?.remove?.();
    monitorRef.current = null;
    try { await manager.cancelDeviceConnection(connectedDevice.id); } catch {}
    setConnectedDevice(null);
    setIsStreaming(false);
    setSamples([]);
  }, [connectedDevice, isStreaming, manager]);

  const handleConnect = useCallback(async (deviceId) => {
    await handleDisconnect();
    setError('');
    stopScan();
    try {
      const device = await manager.connectToDevice(deviceId, { autoConnect: false, requestMTU: 247 });
      await device.discoverAllServicesAndCharacteristics();
      setConnectedDevice(device);

      const measSvc = (await device.services()).find((s) => s.uuid.toLowerCase() === MEAS_SERVICE.toLowerCase());
      if (!measSvc) throw new Error('Measurement service not found');

      const desiredCharUUID = payloadModeToChar(SELECTED_PAYLOAD_MODE).toLowerCase();
      const measChars = await device.characteristicsForService(measSvc.uuid);
      const measChar = measChars.find((c) => c.isNotifiable && c.uuid.toLowerCase() === desiredCharUUID);
      if (!measChar) throw new Error('Notifiable measurement characteristic not found');

      monitorRef.current?.remove?.();
      monitorRef.current = device.monitorCharacteristicForService(
        measSvc.uuid,
        measChar.uuid,
        (monitorError, characteristic) => {
          if (monitorError) { setError(getErrorMessage(monitorError)); return; }
          if (!characteristic?.value) return;

          // ---- decode with correct offset & mode ----
          const buf = Buffer.from(characteristic.value, 'base64');
          const { dotTimestampUs, floats } = parseDotPayload(buf, SELECTED_PAYLOAD_MODE);

          setSamples((prev) => {
            const next = [{
              id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
              timestamp: Date.now(),         // host time
              dotTimestampUs,                // sensor timestamp
              hex: toHex(buf),               // raw helper
              floats,
            }, ...prev];
            if (next.length > MAX_SAMPLES) next.length = MAX_SAMPLES;
            return next;
          });
        }
      );
    } catch (e) {
      setConnectedDevice(null);
      setError(getErrorMessage(e));
    }
  }, [handleDisconnect, manager, stopScan]);

  const handleStartStream = useCallback(async () => {
    if (!connectedDevice) return;
    setError('');
    try {
      const cmd = Buffer.from([0x01, 0x01, SELECTED_PAYLOAD_MODE]).toString('base64'); // [Type=1, Start=1, Mode]
      try {
        await connectedDevice.writeCharacteristicWithResponseForService(MEAS_SERVICE, MEAS_CONTROL, cmd);
      } catch {
        await connectedDevice.writeCharacteristicWithoutResponseForService(MEAS_SERVICE, MEAS_CONTROL, cmd);
      }
      setIsStreaming(true);
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }, [connectedDevice]);

  const handleStopStream = useCallback(async () => {
    if (!connectedDevice) return;
    setError('');
    try {
      const cmd = Buffer.from([0x01, 0x00, 0x00]).toString('base64'); // stop
      try {
        await connectedDevice.writeCharacteristicWithResponseForService(MEAS_SERVICE, MEAS_CONTROL, cmd);
      } catch {
        await connectedDevice.writeCharacteristicWithoutResponseForService(MEAS_SERVICE, MEAS_CONTROL, cmd);
      }
      setIsStreaming(false);
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }, [connectedDevice]);

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
      {item.hex ? <Text style={styles.sampleHex}>{item.hex}</Text> : null}
      {item.floats?.length ? <Text style={styles.sampleFloats}>{item.floats.join(' ')}</Text> : null}
    </View>
  );

  // ------ CURRENT DATA PANEL (labels) ------
  const current = samples.length ? samples[0] : null;
  const labeled = current ? getLabeledFields(current, SELECTED_PAYLOAD_MODE) : [];

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

      {/* CURRENT DATA */}
      {connectedDevice ? (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.sectionTitle}>Current Data</Text>
            <View style={styles.streamingActions}>
              <TouchableOpacity
                onPress={handleStartStream}
                disabled={isStreaming}
                style={[styles.smallButton, isStreaming ? styles.buttonDisabled : null]}
              >
                <Text style={styles.smallButtonText}>Start</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleStopStream}
                disabled={!isStreaming}
                style={[styles.smallButton, !isStreaming ? styles.buttonDisabled : null]}
              >
                <Text style={styles.smallButtonText}>Stop</Text>
              </TouchableOpacity>
            </View>
          </View>

          {current ? (
            <View style={styles.grid}>
              {labeled.map((row) => (
                <View key={row.label} style={styles.kv}>
                  <Text style={styles.kLabel}>{row.label}</Text>
                  <Text style={styles.kValue}>{row.value}</Text>
                </View>
              ))}
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
  sampleHex: { color: '#f4f6fb', fontSize: 14, marginBottom: 6 },
  sampleFloats: { color: '#ffb86b', fontSize: 12 },
});
