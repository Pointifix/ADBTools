import * as vscode from 'vscode';
import * as child_process from 'child_process';
import { DeviceHandler } from './deviceHandler';

export class AdbListener {
    private adbProcess: child_process.ChildProcessWithoutNullStreams | undefined;
    private buffer = '';
    private isDisposed = false;

    // Map of device ID to state (e.g. 'device', 'offline', 'unauthorized')
    private knownDevices: Map<string, string> = new Map();

    private handlers: DeviceHandler[] = [];

    constructor(private outputChannel: vscode.OutputChannel) { }

    public addHandler(handler: DeviceHandler) {
        this.handlers.push(handler);
    }

    public start() {
        if (this.isDisposed) return;
        this.buffer = '';
        this.outputChannel.appendLine('[ADB Monitor] Starting device monitoring...');

        try {
            this.adbProcess = child_process.spawn('adb', ['track-devices']);

            this.adbProcess.on('error', (err) => {
                this.outputChannel.appendLine(`[ADB Error] Failed to start track-devices: ${err.message}`);
                this.adbProcess = undefined;
            });

            this.adbProcess.stdout.on('data', (data) => {
                this.buffer += data.toString();
                this.processBuffer();
            });

            this.adbProcess.stderr.on('data', (data) => {
                this.outputChannel.appendLine(`[ADB Error] ${data.toString().trim()}`);
            });

            this.adbProcess.on('close', (code) => {
                this.outputChannel.appendLine(`[ADB Monitor] Process exited with code ${code}`);
                this.adbProcess = undefined;
                if (!this.isDisposed) {
                    setTimeout(() => this.start(), 5000);
                }
            });
        } catch (err: any) {
            this.outputChannel.appendLine(`[ADB Error] Critical failure spawning adb: ${err.message}`);
            if (!this.isDisposed) {
                setTimeout(() => this.start(), 10000);
            }
        }
    }

    private processBuffer() {
        // ADB protocol: 4 hex bytes for length, followed by payload
        while (this.buffer.length >= 4) {
            const lengthHex = this.buffer.substring(0, 4);
            const payloadLength = parseInt(lengthHex, 16);

            if (isNaN(payloadLength)) {
                // Invalid state, clear buffer
                this.buffer = '';
                return;
            }

            if (this.buffer.length >= 4 + payloadLength) {
                const payload = this.buffer.substring(4, 4 + payloadLength);
                this.buffer = this.buffer.substring(4 + payloadLength);

                this.handleDeviceListPayload(payload);
            } else {
                // Not enough data yet
                break;
            }
        }
    }

    private handleDeviceListPayload(payload: string) {
        const lines = payload.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const currentDevices = new Map<string, string>();

        for (const line of lines) {
            const parts = line.split('\t');
            if (parts.length >= 2) {
                currentDevices.set(parts[0], parts[1]);
            }
        }

        // Check for removed/changed devices
        for (const [id, state] of this.knownDevices) {
            const newState = currentDevices.get(id);
            if (!newState) {
                this.outputChannel.appendLine(`Device disconnected: ${id} (was ${state})`);
                this.showStatusNotification(`ADB Disconnected: ${id}`, '$(debug-disconnect)');
                this.notifyDeviceDisconnected(id);
            } else if (state === 'device' && newState !== 'device') {
                this.outputChannel.appendLine(`Device state changed to ${newState}: ${id}`);
                this.showStatusNotification(`ADB Disconnected: ${id} (${newState})`, '$(debug-disconnect)');
                this.notifyDeviceDisconnected(id);
            }
        }

        // Check for new devices or state changes
        for (const [id, state] of currentDevices) {
            const oldState = this.knownDevices.get(id);
            if (!oldState) {
                this.outputChannel.appendLine(`Device connected: ${id} (state: ${state})`);
                this.showStatusNotification(`ADB Connected: ${id}${state !== 'device' ? ` (${state})` : ''}`, '$(device-mobile)');
                if (state === 'device') {
                    this.notifyDeviceConnected(id);
                }
            } else if (oldState !== state) {
                this.outputChannel.appendLine(`Device state changed: ${id} from ${oldState} to ${state}`);
                this.showStatusNotification(`ADB Connected: ${id}${state !== 'device' ? ` (${state})` : ''}`, '$(device-mobile)');
                if (state === 'device') {
                    this.notifyDeviceConnected(id);
                }
            }
        }

        this.knownDevices = currentDevices;
    }

    private notifyDeviceConnected(id: string) {
        for (const handler of this.handlers) {
            try {
                handler.onDeviceConnected(id);
            } catch (err) {
                console.error(`Handler failed on connect for ${id}:`, err);
            }
        }
    }

    private notifyDeviceDisconnected(id: string) {
        for (const handler of this.handlers) {
            try {
                handler.onDeviceDisconnected(id);
            } catch (err) {
                console.error(`Handler failed on disconnect for ${id}:`, err);
            }
        }
    }

    private showStatusNotification(message: string, icon: string) {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        item.text = `${icon} ${message}`;
        item.show();
        setTimeout(() => item.dispose(), 5000);
    }

    public getActiveDevices(): string[] {
        return Array.from(this.knownDevices.entries())
            .filter(([id, state]) => state === 'device')
            .map(([id, state]) => id);
    }

    public dispose() {
        this.isDisposed = true;
        if (this.adbProcess) {
            this.adbProcess.kill();
        }
        for (const handler of this.handlers) {
            try {
                handler.dispose();
            } catch (err) {
                console.error("Handler error on dispose:", err);
            }
        }
        this.handlers = [];
        this.knownDevices.clear();
    }
}
