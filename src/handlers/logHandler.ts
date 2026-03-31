import * as vscode from 'vscode';
import * as child_process from 'child_process';
import { Document } from 'flexsearch';
import { DeviceHandler } from '../deviceHandler';

export class LogHandler implements DeviceHandler {
    private deviceChannels: Map<string, vscode.OutputChannel> = new Map();
    private deviceLogProcesses: Map<string, child_process.ChildProcessWithoutNullStreams> = new Map();

    // FlexSearch State
    private deviceIndices: Map<string, Document<{ id: number, log: string }>> = new Map();
    private deviceLogCounts: Map<string, number> = new Map();
    private deviceFirstLogId: Map<string, number> = new Map();
    private deviceFilters: Map<string, string> = new Map();
    private startingDevices: Set<string> = new Set();

    private maxLogLines: number = 10000;

    constructor() {
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

    public async onDeviceConnected(deviceId: string): Promise<void> {
        await this.ensureLogProcess(deviceId);
    }

    public onDeviceDisconnected(deviceId: string): void {
        this.stopLogProcess(deviceId);
    }

    public dispose(): void {
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
            channel.appendLine(`[Auto-detecting log source...]`);
            const logSource = await this.detectLogSource(id);

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

    private stopLogProcess(id: string) {
        const process = this.deviceLogProcesses.get(id);
        if (process) {
            process.kill();
            this.deviceLogProcesses.delete(id);
        }

        const channel = this.deviceChannels.get(id);
        if (channel) {
            channel.appendLine(`\n[Device logging paused: ${id}]`);
        }
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
}
