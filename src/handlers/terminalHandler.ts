import * as vscode from 'vscode';
import { DeviceHandler } from '../deviceHandler';

export class TerminalHandler implements DeviceHandler, vscode.TerminalProfileProvider {
    private connectedDevices: Set<string> = new Set();
    private disposable: vscode.Disposable;

    constructor() {
        this.disposable = vscode.window.registerTerminalProfileProvider('adbtools.terminalProfile', this);
    }

    public onDeviceConnected(deviceId: string): void {
        this.connectedDevices.add(deviceId);
    }

    public onDeviceDisconnected(deviceId: string): void {
        this.connectedDevices.delete(deviceId);
    }

    public dispose(): void {
        this.connectedDevices.clear();
        this.disposable.dispose();
    }

    public async provideTerminalProfile(
        token: vscode.CancellationToken
    ): Promise<vscode.TerminalProfile | undefined> {
        if (this.connectedDevices.size === 0) {
            vscode.window.showErrorMessage('No ADB devices connected.');
            return undefined;
        }

        let deviceId = Array.from(this.connectedDevices)[0];

        if (this.connectedDevices.size > 1) {
            const selected = await vscode.window.showQuickPick(Array.from(this.connectedDevices), {
                placeHolder: 'Select a device for the ADB shell',
            });
            if (!selected) {
                return undefined;
            }
            deviceId = selected;
        }

        return new vscode.TerminalProfile({
            name: `ADB: ${deviceId}`,
            shellPath: 'adb',
            shellArgs: ['-s', deviceId, 'shell']
        });
    }
}
