import * as vscode from 'vscode';
import { DeviceHandler } from '../deviceHandler';

export class FileSystemHandler implements DeviceHandler {
    
    public onDeviceConnected(deviceId: string): void {
        const uri = vscode.Uri.parse(`adb://${deviceId}/`);
        const folders = vscode.workspace.workspaceFolders || [];
        if (folders.some(f => f.uri.toString() === uri.toString())) {
            return;
        }
        vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri, name: `ADB: ${deviceId}` });
    }

    public onDeviceDisconnected(deviceId: string): void {
        const uriString = vscode.Uri.parse(`adb://${deviceId}/`).toString();
        const folders = vscode.workspace.workspaceFolders || [];
        const index = folders.findIndex(f => f.uri.toString() === uriString);
        if (index !== -1) {
            vscode.workspace.updateWorkspaceFolders(index, 1);
        }
    }

    public dispose(): void {
        // Workspace folders will remain until disconnected or VSCode is closed, nothing needed here.
    }
}
