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
    private deviceFilters: Map<string, string> = new Map();

    private buffer = '';

    constructor(private outputChannel: vscode.OutputChannel) { }

    public start() {
        this.outputChannel.appendLine('[ADB Monitor] Starting device monitoring...');
        // adb track-devices sends the state of all devices whenever a device connects/disconnects
        this.adbProcess = child_process.spawn('adb', ['track-devices']);

        this.adbProcess.stdout.on('data', (data) => {
            this.buffer += data.toString();
            this.processBuffer();
        });

        this.adbProcess.stderr.on('data', (data) => {
            this.outputChannel.appendLine(`[ADB Error] ${data.toString().trim()}`);
        });

        this.adbProcess.on('close', (code) => {
            this.outputChannel.appendLine(`[ADB Monitor] Process exited with code ${code}`);
            // Restart if it crashes
            setTimeout(() => this.start(), 5000);
        });
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
                this.removeLogChannel(id);
                this.removeWorkspaceFolder(id);
            } else if (state === 'device' && newState !== 'device') {
                this.outputChannel.appendLine(`Device state changed to ${newState}: ${id}`);
                this.removeLogChannel(id);
                this.removeWorkspaceFolder(id);
            }
        }

        // Check for new devices or state changes
        for (const [id, state] of currentDevices) {
            const oldState = this.knownDevices.get(id);
            if (!oldState) {
                this.outputChannel.appendLine(`Device connected: ${id} (state: ${state})`);
                if (state === 'device') {
                    this.createLogChannel(id);
                    this.addWorkspaceFolder(id);
                }
            } else if (oldState !== state) {
                this.outputChannel.appendLine(`Device state changed: ${id} from ${oldState} to ${state}`);
                if (state === 'device') {
                    this.createLogChannel(id);
                    this.addWorkspaceFolder(id);
                }
            }
        }

        this.knownDevices = currentDevices;
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

    private createLogChannel(id: string) {
        if (this.deviceChannels.has(id)) { return; }

        const channel = vscode.window.createOutputChannel(`Logcat: ${id}`);
        this.deviceChannels.set(id, channel);

        // Initialize FlexSearch Document (acts as both search index and log storage)
        const index = new Document<{ id: number, log: string }>({
            document: {
                id: 'id',
                index: ['log'],
                store: true
            }
        });
        this.deviceIndices.set(id, index);
        this.deviceLogCounts.set(id, 0);
        this.deviceFilters.set(id, '');

        const logProcess = child_process.spawn('adb', ['-s', id, 'logcat']);
        this.deviceLogProcesses.set(id, logProcess);

        const handleLogData = (data: string) => {
            const lines = data.split('\n');
            for (let line of lines) {
                line = line.trim();
                if (!line) continue;

                let count = this.deviceLogCounts.get(id) || 0;
                index.add({ id: count, log: line });
                this.deviceLogCounts.set(id, count + 1);

                const filter = this.deviceFilters.get(id);
                // If filter is empty, or the line matches the filter string, append it to the UI
                if (!filter || line.toLowerCase().includes(filter.toLowerCase())) {
                    channel.appendLine(line);
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
            channel.appendLine(`\n[Process exited with code ${code}]`);
        });

        channel.show(true);
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
            // Restore all logs from the FlexSearch store
            for (let i = 0; i < count; i++) {
                const doc = index.get(i) as { log: string } | null;
                if (doc) {
                    channel.appendLine(doc.log);
                }
            }
            channel.appendLine(`[Filter cleared. Showing all ${count} logs]`);
        } else {
            // Perform FlexSearch query
            const results = await index.search(query, { enrich: true });
            let matchCount = 0;
            
            if (results && results.length > 0 && results[0].result) {
                const matchedDocs = results[0].result as Array<{ doc: { log: string } }>;
                for (const match of matchedDocs) {
                    channel.appendLine(match.doc.log);
                    matchCount++;
                }
            }
            channel.appendLine(`[Showing ${matchCount} matches for "${query}"]`);
        }
    }

    private removeLogChannel(id: string) {
        const process = this.deviceLogProcesses.get(id);
        if (process) {
            process.kill();
            this.deviceLogProcesses.delete(id);
        }

        const channel = this.deviceChannels.get(id);
        if (channel) {
            channel.dispose();
            this.deviceChannels.delete(id);
        }

        this.deviceIndices.delete(id);
        this.deviceLogCounts.delete(id);
        this.deviceFilters.delete(id);
    }

    public dispose() {
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
        this.knownDevices.clear();
    }

    public getActiveDevices(): string[] {
        return Array.from(this.deviceChannels.keys());
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

    let helloCmd = vscode.commands.registerCommand('adbtools.helloWorld', () => {
        vscode.window.showInformationMessage('ADBTools tracking is active. Check the Output Channel!');
    });

    let searchCmd = vscode.commands.registerCommand('adbtools.filterLogs', () => {
        if (adbMonitor) {
            adbMonitor.applyFilter();
        }
    });

    const adbFileSystemProvider = new AdbFileSystemProvider();
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('adb', adbFileSystemProvider, { isCaseSensitive: true }));

    let openFsCmd = vscode.commands.registerCommand('adbtools.openDeviceFs', async () => {
        if (!adbMonitor) {
            vscode.window.showErrorMessage('ADB Monitor not initialized.');
            return;
        }

        const devices = adbMonitor.getActiveDevices();
        if (devices.length === 0) {
            vscode.window.showInformationMessage('No active ADB devices found.');
            return;
        }

        const selectedDevice = await vscode.window.showQuickPick(devices, { placeHolder: 'Select a device to open its file system' });

        if (!selectedDevice) { return; }

        // Add the device to the current workspace instead of opening a new window
        // This ensures the Extension Development Host keeps the extension active!
        const uri = vscode.Uri.parse(`adb://${selectedDevice}/`);
        const folderCount = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0;
        vscode.workspace.updateWorkspaceFolders(folderCount, 0, { uri: uri, name: `ADB: ${selectedDevice}` });
    });

    context.subscriptions.push(helloCmd, searchCmd, openFsCmd);
}

export function deactivate() {
    if (adbMonitor) {
        adbMonitor.dispose();
    }
}
