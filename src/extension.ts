import * as vscode from 'vscode';
import * as child_process from 'child_process';
import { Document } from 'flexsearch';
import { AdbFileSystemProvider } from './adbFileSystemProvider';

// A simple utility class to monitor ADB devices with `adb track-devices`
class AdbMonitor {
    private adbProcess: child_process.ChildProcessWithoutNullStreams | undefined;
    private knownDevices: Map<string, string> = new Map();
    private deviceChannels: Map<string, vscode.OutputChannel> = new Map();
    private deviceLogProcesses: Map<string, child_process.ChildProcessWithoutNullStreams> = new Map();

    // FlexSearch State
    private deviceIndices: Map<string, Document<{ id: number, log: string }>> = new Map();
    private deviceLogCounts: Map<string, number> = new Map();
    private deviceFirstLogId: Map<string, number> = new Map();
    private deviceFilters: Map<string, string> = new Map();
    private startingDevices: Set<string> = new Set();
    private maxLogLines: number = 10000;
    private buffer = '';
    private isDisposed = false;

    constructor(private outputChannel: vscode.OutputChannel) {
        this.updateConfig();
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('adbtools.maxLogLines')) {
                this.updateConfig();
            }
        });
    }

    private updateConfig() {
        const config = vscode.workspace.getConfiguration('adbtools');
        this.maxLogLines = config.get<number>('maxLogLines') || 10000;
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

        // Check for removed devices
        for (const [id, state] of this.knownDevices) {
            const newState = currentDevices.get(id);
            if (!newState) {
                this.outputChannel.appendLine(`Device disconnected: ${id} (was ${state})`);
                this.showStatusNotification(`ADB Disconnected: ${id}`, '$(debug-disconnect)');
                this.stopLogProcess(id);
                this.removeWorkspaceFolder(id);
            } else if (state === 'device' && newState !== 'device') {
                this.outputChannel.appendLine(`Device state changed to ${newState}: ${id}`);
                this.showStatusNotification(`ADB Disconnected: ${id} (${newState})`, '$(debug-disconnect)');
                this.stopLogProcess(id);
                this.removeWorkspaceFolder(id);
            }
        }

        // Check for new devices or state changes
        for (const [id, state] of currentDevices) {
            const oldState = this.knownDevices.get(id);
            if (!oldState) {
                this.outputChannel.appendLine(`Device connected: ${id} (state: ${state})`);
                if (state === 'device') {
                    this.showStatusNotification(`ADB Connected: ${id}`, '$(device-mobile)');
                    this.ensureLogProcess(id);
                    this.addWorkspaceFolder(id);
                } else {
                    this.showStatusNotification(`ADB Connected: ${id} (${state})`, '$(device-mobile)');
                }
            } else if (oldState !== state) {
                this.outputChannel.appendLine(`Device state changed: ${id} from ${oldState} to ${state}`);
                if (state === 'device') {
                    this.showStatusNotification(`ADB Connected: ${id}`, '$(device-mobile)');
                    this.ensureLogProcess(id);
                    this.addWorkspaceFolder(id);
                }
            }
        }

        this.knownDevices = currentDevices;
    }

    private showStatusNotification(message: string, icon: string) {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        item.text = `${icon} ${message}`;
        item.show();
        setTimeout(() => item.dispose(), 5000);
    }

    private addWorkspaceFolder(id: string) {
        const uri = vscode.Uri.parse(`adb://${id}/`);
        const folders = vscode.workspace.workspaceFolders || [];
        if (folders.some(f => f.uri.toString() === uri.toString())) {
            return;
        }
        vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri, name: `ADB: ${id}` });
    }

    private removeWorkspaceFolder(id: string) {
        const uriString = vscode.Uri.parse(`adb://${id}/`).toString();
        const folders = vscode.workspace.workspaceFolders || [];
        const index = folders.findIndex(f => f.uri.toString() === uriString);
        if (index !== -1) {
            vscode.workspace.updateWorkspaceFolders(index, 1);
        }
    }

    private async ensureLogProcess(id: string) {
        let channel = this.deviceChannels.get(id);
        let index = this.deviceIndices.get(id);

        if (!channel || !index) {
            channel = vscode.window.createOutputChannel(`Device Log: ${id}`);
            this.deviceChannels.set(id, channel);

            // Initialize FlexSearch Document (acts as both search index and log storage)
            index = new Document<{ id: number, log: string }>({
                document: {
                    id: 'id',
                    index: ['log'],
                    store: true
                }
            });
            this.deviceIndices.set(id, index);
            this.deviceLogCounts.set(id, 0);
            this.deviceFilters.set(id, '');
        }

        if (this.deviceLogProcesses.has(id) || this.startingDevices.has(id)) {
            return;
        }

        this.startingDevices.add(id);

        try {
            const config = vscode.workspace.getConfiguration('adbtools');
            let logSource = config.get<string>('logSource') || 'auto';

            if (logSource === 'auto') {
                channel.appendLine(`[Auto-detecting log source...]`);
                logSource = await this.detectLogSource(id);
            }

            // double check to prevent racing
            if (this.deviceLogProcesses.has(id)) { return; }

            let logProcess: child_process.ChildProcessWithoutNullStreams;
            if (logSource === 'journalctl') {
                logProcess = child_process.spawn('adb', ['-s', id, 'shell', 'journalctl', '-f']);
            } else {
                logProcess = child_process.spawn('adb', ['-s', id, 'logcat']);
            }

            this.deviceLogProcesses.set(id, logProcess);
            channel.appendLine(`\n[Log source: ${logSource} started for ${id}]`);

            const handleLogData = (data: string) => {
                const lines = data.split('\n');
                for (let line of lines) {
                    line = line.trim();
                    if (!line) continue;

                    let count = this.deviceLogCounts.get(id) || 0;
                    index!.add({ id: count, log: line });
                    this.deviceLogCounts.set(id, count + 1);

                    if (count >= this.maxLogLines) {
                        const idToRemove = count - this.maxLogLines;
                        index!.remove(idToRemove);
                        this.deviceFirstLogId.set(id, idToRemove + 1);
                    }

                    const filter = this.deviceFilters.get(id);
                    // If filter is empty, or the line matches the filter string, append it to the UI
                    if (!filter || line.toLowerCase().includes(filter.toLowerCase())) {
                        channel!.appendLine(line);
                    }
                }
            };

            logProcess.stdout.on('data', (data) => {
                handleLogData(data.toString());
            });

            logProcess.stderr.on('data', (data) => {
                handleLogData(data.toString());
            });

            logProcess.on('close', (code) => {
                if (this.deviceLogProcesses.get(id) === logProcess) {
                    this.deviceLogProcesses.delete(id);
                }
                channel!.appendLine(`\n[Process exited with code ${code}]`);
            });
        } finally {
            this.startingDevices.delete(id);
        }
    }

    private async detectLogSource(id: string): Promise<string> {
        return new Promise((resolve) => {
            const cp = child_process.spawn('adb', ['-s', id, 'shell', 'which', 'journalctl']);
            let output = '';
            cp.stdout.on('data', (d) => output += d.toString());
            cp.on('close', (code) => {
                if (code === 0 && output.trim().length > 0) {
                    resolve('journalctl');
                } else {
                    resolve('logcat');
                }
            });
            cp.on('error', () => resolve('logcat'));

            // Timeout after 3 seconds
            setTimeout(() => {
                cp.kill();
                resolve('logcat');
            }, 3000);
        });
    }

    public async applyFilter() {
        if (this.deviceChannels.size === 0) {
            vscode.window.showInformationMessage('No active device log channels.');
            return;
        }

        const devices = Array.from(this.deviceChannels.keys());
        const selectedDevice = devices.length === 1
            ? devices[0]
            : await vscode.window.showQuickPick(devices, { placeHolder: 'Select a device to filter logs' });

        if (!selectedDevice) { return; }

        const query = await vscode.window.showInputBox({
            prompt: `Enter FlexSearch query for ${selectedDevice} (leave empty to clear filter)`,
            value: this.deviceFilters.get(selectedDevice) || ''
        });

        if (query === undefined) { return; } // cancelled

        this.deviceFilters.set(selectedDevice, query);
        const channel = this.deviceChannels.get(selectedDevice);
        const index = this.deviceIndices.get(selectedDevice);
        const count = this.deviceLogCounts.get(selectedDevice) || 0;

        if (!channel || !index) { return; }

        channel.clear();

        if (query === '') {
            const firstId = this.deviceFirstLogId.get(selectedDevice) || 0;
            // Restore all logs from the FlexSearch store
            for (let i = firstId; i < count; i++) {
                const doc = index.get(i) as { log: string } | null;
                if (doc) {
                    channel.appendLine(doc.log);
                }
            }
            channel.appendLine(`[Filter cleared. Showing last ${count - firstId} logs]`);
        } else {
            const firstId = this.deviceFirstLogId.get(selectedDevice) || 0;
            const lowerQuery = query.toLowerCase();
            let matchCount = 0;

            for (let i = firstId; i < count; i++) {
                const doc = index.get(i) as { log: string } | null;
                if (doc && doc.log.toLowerCase().includes(lowerQuery)) {
                    channel.appendLine(doc.log);
                    matchCount++;
                }
            }
            channel.appendLine(`[Showing ${matchCount} matches for "${query}"]`);
        }
    }

    private stopLogProcess(id: string) {
        const process = this.deviceLogProcesses.get(id);
        if (process) {
            process.kill();
            this.deviceLogProcesses.delete(id);
        }

        const channel = this.deviceChannels.get(id);
        if (channel) {
            channel.appendLine(`\n[Device disconnected: ${id}]`);
        }
    }

    public dispose() {
        this.isDisposed = true;
        if (this.adbProcess) {
            this.adbProcess.kill();
        }
        for (const process of this.deviceLogProcesses.values()) {
            process.kill();
        }
        for (const channel of this.deviceChannels.values()) {
            channel.dispose();
        }
        this.deviceLogProcesses.clear();
        this.deviceChannels.clear();
        this.deviceIndices.clear();
        this.deviceLogCounts.clear();
        this.deviceFirstLogId.clear();
        this.knownDevices.clear();
    }

    public getActiveDevices(): string[] {
        // Return only devices that are currently in 'device' state
        return Array.from(this.knownDevices.entries())
            .filter(([id, state]) => state === 'device')
            .map(([id, state]) => id);
    }
}

let adbMonitor: AdbMonitor | undefined;

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('ADB Tools');
    context.subscriptions.push(outputChannel);

    adbMonitor = new AdbMonitor(outputChannel);
    adbMonitor.start();

    // Register adbMonitor to be cleaned up on deactivate
    context.subscriptions.push({ dispose: () => adbMonitor?.dispose() });

    let searchCmd = vscode.commands.registerCommand('adbtools.filterLogs', () => {
        if (adbMonitor) {
            adbMonitor.applyFilter();
        }
    });

    const adbFileSystemProvider = new AdbFileSystemProvider();
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('adb', adbFileSystemProvider, { isCaseSensitive: true }));

    context.subscriptions.push(searchCmd);
}

export function deactivate() {
    if (adbMonitor) {
        adbMonitor.dispose();
    }
}
