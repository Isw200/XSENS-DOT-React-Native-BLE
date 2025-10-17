# XSENS DOT BLE React Native App

A cross-platform React Native app (Expo) for connecting to XSENS DOT sensors via Bluetooth LE, streaming real-time sensor data, and displaying it live. Supports iOS and Android.

## Features
- Scan for XSENS DOT sensors via BLE
- Connect and send start/stop commands
- Monitor and display real-time sensor data
- Handles BLE permissions and errors

## Setup
1. Clone the repository:
   ```sh
   git clone <your-repo-url>
   cd app
   ```
2. Install dependencies:
   ```sh
   npm install
   ```
3. Prebuild native projects:
   ```sh
   npx expo prebuild
   ```
4. Run on device/emulator:
   ```sh
   npx expo run:ios
   npx expo run:android
   ```

## BLE Details
- Control Service: `15171000-4947-11e9-8646-d663bd873d93`
- Control Characteristic (writable): `15171002-4947-11e9-8646-d663bd873d93`
- Measurement Service: `15173000-4947-11e9-8646-d663bd873d93`
- Measurement Characteristic (notifiable): auto-detected

## Permissions
- Android: Bluetooth, Location
- iOS: Bluetooth usage

## Publishing
1. Update `app.json` with your app details.
2. Commit and push to GitHub:
   ```sh
   git add .
   git commit -m "Initial BLE app for XSENS DOT"
   git push
   ```

## Troubleshooting
- Ensure the sensor is powered and advertising.
- If no data appears, check BLE permissions and sensor firmware.
- Use device logs for debugging BLE issues.

## License
MIT
# XSENS-DOT-React-Native-BLE
