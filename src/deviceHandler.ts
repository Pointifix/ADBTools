import * as vscode from 'vscode';

export interface DeviceHandler {
    /**
     * Called when a new device is connected.
     * @param deviceId The ID of the connected device.
     */
    onDeviceConnected(deviceId: string): Promise<void> | void;

    /**
     * Called when a device is disconnected.
     * @param deviceId The ID of the disconnected device.
     */
    onDeviceDisconnected(deviceId: string): Promise<void> | void;

    /**
     * Called when the extension is deactivated. Clean up resources here.
     */
    dispose(): void;
}
