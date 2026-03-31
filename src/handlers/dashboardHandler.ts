import * as vscode from 'vscode';
import * as child_process from 'child_process';
import { DeviceHandler } from '../deviceHandler';

export class DashboardHandler implements DeviceHandler {
    private connectedDevices: Set<string> = new Set();
    private disposable: vscode.Disposable;

    constructor(private context: vscode.ExtensionContext) {
        this.disposable = vscode.commands.registerCommand('adbtools.openDashboard', async () => {
            await this.openDashboard();
        });
    }

    public onDeviceConnected(deviceId: string): void {
        this.connectedDevices.add(deviceId);
    }

    public onDeviceDisconnected(deviceId: string): void {
        this.connectedDevices.delete(deviceId);
        // We could also close the webview if it's open for this device, but we'll leave it as is for now.
    }

    public dispose(): void {
        this.connectedDevices.clear();
        this.disposable.dispose();
    }

    private async openDashboard() {
        if (this.connectedDevices.size === 0) {
            vscode.window.showErrorMessage('No ADB devices connected.');
            return;
        }

        let deviceId = Array.from(this.connectedDevices)[0];

        if (this.connectedDevices.size > 1) {
            const selected = await vscode.window.showQuickPick(Array.from(this.connectedDevices), {
                placeHolder: 'Select a device for the Dashboard',
            });
            if (!selected) {
                return;
            }
            deviceId = selected;
        }

        const panel = vscode.window.createWebviewPanel(
            'adbDashboard',
            `ADB Dashboard: ${deviceId}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true
            }
        );

        const config = vscode.workspace.getConfiguration('adbtools');
        const commands: Array<{ name: string, command: string }> = config.get('dashboardCommands') || [];

        panel.webview.html = this.getWebviewContent(deviceId, commands);

        panel.webview.onDidReceiveMessage(
            message => {
                switch (message.action) {
                    case 'runCommand':
                        this.runAdbCommand(deviceId, message.command);
                        return;
                }
            },
            undefined,
            this.context.subscriptions
        );
    }

    private runAdbCommand(deviceId: string, command: string) {
        const fullCmd = `adb -s ${deviceId} shell ${command}`;
        child_process.exec(fullCmd, (error, stdout, stderr) => {
            if (error) {
                vscode.window.showErrorMessage(`Error running command: ${error.message}`);
                return;
            }
            if (stderr) {
                vscode.window.showInformationMessage(`Command finished with stderr: ${stderr}`);
                return;
            }
            vscode.window.showInformationMessage(`Command executed successfully.\nOutput: ${stdout}`);
        });
    }

    private getWebviewContent(deviceId: string, commands: Array<{ name: string, command: string }>) {
        const buttonsHtml = commands.map(cmd => 
            `<button class="btn" onclick="runCommand('${cmd.command}')">${cmd.name}</button>`
        ).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ADB Dashboard</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-editor-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
        }
        .btn {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 10px 20px;
            margin: 5px;
            cursor: pointer;
            border-radius: 2px;
            font-size: 14px;
        }
        .btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
    </style>
</head>
<body>
    <h1>Dashboard for ${deviceId}</h1>
    <p>Select a command to execute on the device:</p>
    <div>
        ${buttonsHtml}
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        function runCommand(cmdString) {
            vscode.postMessage({
                action: 'runCommand',
                command: cmdString
            });
        }
    </script>
</body>
</html>`;
    }
}
