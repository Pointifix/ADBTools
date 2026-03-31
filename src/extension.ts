import * as vscode from 'vscode';
import { AdbListener } from './adbListener';
import { FileSystemHandler } from './handlers/fileSystemHandler';
import { LogHandler } from './handlers/logHandler';
import { TerminalHandler } from './handlers/terminalHandler';
import { DashboardHandler } from './handlers/dashboardHandler';
import { AdbFileSystemProvider } from './adbFileSystemProvider';

let adbListener: AdbListener | undefined;

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('ADB Tools');
    context.subscriptions.push(outputChannel);

    adbListener = new AdbListener(outputChannel);

    adbListener.addHandler(new FileSystemHandler());
    adbListener.addHandler(new LogHandler());
    adbListener.addHandler(new TerminalHandler());
    adbListener.addHandler(new DashboardHandler(context));

    adbListener.start();

    context.subscriptions.push({ dispose: () => adbListener?.dispose() });

    const adbFileSystemProvider = new AdbFileSystemProvider();
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('adb', adbFileSystemProvider, { isCaseSensitive: true }));
}

export function deactivate() {
    if (adbListener) {
        adbListener.dispose();
    }
}
