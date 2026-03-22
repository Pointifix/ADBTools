import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as util from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execFile = util.promisify(child_process.execFile);

export class AdbFileSystemProvider implements vscode.FileSystemProvider {

    private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._onDidChangeFile.event;

    private deviceIdCache = new Map<string, string>();

    private async getRealDeviceId(lowerId: string): Promise<string> {
        if (this.deviceIdCache.has(lowerId)) return this.deviceIdCache.get(lowerId)!;

        try {
            const { stdout } = await execFile('adb', ['devices']);
            const lines = stdout.split('\n');
            for (const line of lines) {
                const parts = line.split('\t');
                if (parts.length >= 2) {
                    const id = parts[0].trim();
                    const ln = id.toLowerCase();
                    this.deviceIdCache.set(ln, id);
                    if (ln === lowerId) {
                        return id;
                    }
                }
            }
        } catch (e) {}
        
        return lowerId;
    }

    private escapePath(p: string): string {
        return `'${p.replace(/'/g, "'\\''")}'`;
    }

    watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
        // Ignoring watch for now as ADB doesn't easily support file watching without a long-running process
        return new vscode.Disposable(() => { });
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const deviceId = await this.getRealDeviceId(uri.authority);
        const targetPath = uri.path || '/';

        try {
            // using ls -ldL to get stat info of the target if it's a symlink
            // expected output format:
            // drwxr-xr-x 2 root root 4096 2023-11-01 12:00 /path/to/dir
            // For older androids, might be different, but toybox ls is pretty standard now
            const { stdout } = await execFile('adb', ['-s', deviceId, 'shell', 'ls', '-ldL', this.escapePath(targetPath)]);
            const lines = stdout.trim().split('\n');
            if (lines.length === 0 || stdout.includes('No such file or directory')) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }

            const line = lines[lines.length - 1].trim(); // Get last line in case of warnings
            
            // basic parsing for ls -ld
            const isDir = line.startsWith('d');
            let type = isDir ? vscode.FileType.Directory : vscode.FileType.File;
            if (line.startsWith('l')) {
                type = vscode.FileType.SymbolicLink;
            }

            // Approximate size (token 4 or 5 depending on format)
            const parts = line.split(/\s+/);
            let size = 0;
            // The size usually is before the date.
            // permissions links owner group size date time name
            // e.g. -rw-r--r-- 1 root root 1234 2023-11-01 12:00 file.txt
            if (parts.length >= 6) {
                const possibleSize = parseInt(parts[4], 10);
                if (!isNaN(possibleSize)) {
                    size = possibleSize;
                } else {
                    const altSize = parseInt(parts[3], 10); // sometimes no links count
                    if (!isNaN(altSize)) {
                        size = altSize;
                    }
                }
            }

            return {
                type: type,
                ctime: 0,
                mtime: Date.now(), // Approximate as 'ls' parsing for time is complex across locales/versions
                size: size
            };
        } catch (e) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const deviceId = await this.getRealDeviceId(uri.authority);
        const targetPath = uri.path || '/';

        try {
            const { stdout } = await execFile('adb', ['-s', deviceId, 'shell', 'ls', '-lqL', this.escapePath(targetPath)]);
            const lines = stdout.split('\n');
            const result: [string, vscode.FileType][] = [];

            for (let line of lines) {
                line = line.trim();
                if (!line || line.startsWith('total ')) continue;

                // -rw-r--r-- 1 root root 1234 2023-11-01 12:00 filename
                const isDir = line.startsWith('d');
                let type = isDir ? vscode.FileType.Directory : vscode.FileType.File;
                if (line.startsWith('l')) {
                    type = type | vscode.FileType.SymbolicLink;
                }

                const parts = line.split(/\s+/);
                // filename is everything after the time. Usually parts 0-6 are metadata
                // Since filename can have spaces, but we use -q in ls, non-printable characters are ?
                // A better approach is to take everything after the time part (which contains ':')
                let nameIdx = -1;
                for (let i = 4; i < parts.length; i++) {
                    if (parts[i].includes(':') || parts[i].match(/^\d{4}-\d{2}-\d{2}$/)) {
                        nameIdx = i + 1;
                        if (!parts[i].includes(':')) nameIdx++; // if date, then time is the next token
                        break;
                    }
                }
                
                if (nameIdx !== -1 && nameIdx < parts.length) {
                    let name = parts.slice(nameIdx).join(' ');
                    // Handle symbolic links (name -> target)
                    if (type & vscode.FileType.SymbolicLink) {
                        const arrowIdx = name.indexOf(' -> ');
                        if (arrowIdx !== -1) {
                            name = name.substring(0, arrowIdx);
                        }
                    }
                    if (name !== '.' && name !== '..') {
                        result.push([name, type]);
                    }
                } else if (parts.length > 3) {
                    // Fallback just grab the last part
                    const name = parts[parts.length - 1];
                    if (name !== '.' && name !== '..') {
                        result.push([name, type]);
                    }
                }
            }

            return result;
        } catch (e) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    async createDirectory(uri: vscode.Uri): Promise<void> {
        const deviceId = await this.getRealDeviceId(uri.authority);
        const targetPath = uri.path || '/';

        try {
            await execFile('adb', ['-s', deviceId, 'shell', 'mkdir', '-p', this.escapePath(targetPath)]);
            this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Created, uri }]);
        } catch (e) {
            throw vscode.FileSystemError.NoPermissions(uri);
        }
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const deviceId = await this.getRealDeviceId(uri.authority);
        const targetPath = uri.path || '/';

        // Use adb pull to a temp file, then read it
        const tempPath = path.join(os.tmpdir(), `adb_pull_${Date.now()}_${path.basename(targetPath)}`);
        
        try {
            await execFile('adb', ['-s', deviceId, 'pull', targetPath, tempPath]);
            const data = await fs.promises.readFile(tempPath);
            await fs.promises.unlink(tempPath);
            return data;
        } catch (e) {
            // Cleanup just in case
            fs.promises.unlink(tempPath).catch(() => {});
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Promise<void> {
        const deviceId = await this.getRealDeviceId(uri.authority);
        const targetPath = uri.path || '/';

        const tempPath = path.join(os.tmpdir(), `adb_push_${Date.now()}_${path.basename(targetPath)}`);
        
        try {
            await fs.promises.writeFile(tempPath, content);
            await execFile('adb', ['-s', deviceId, 'push', tempPath, targetPath]);
            await fs.promises.unlink(tempPath);
            this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        } catch (e) {
            fs.promises.unlink(tempPath).catch(() => {});
            throw vscode.FileSystemError.NoPermissions(uri);
        }
    }

    async delete(uri: vscode.Uri, options: { recursive: boolean; }): Promise<void> {
        const deviceId = await this.getRealDeviceId(uri.authority);
        const targetPath = uri.path || '/';
        
        try {
            const rmArgs = ['-s', deviceId, 'shell', 'rm'];
            if (options.recursive) {
                rmArgs.push('-r');
            }
            rmArgs.push('-f', this.escapePath(targetPath));
            await execFile('adb', rmArgs);
            this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
        } catch (e) {
            throw vscode.FileSystemError.NoPermissions(uri);
        }
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }): Promise<void> {
        if (oldUri.authority !== newUri.authority) {
            throw vscode.FileSystemError.Unavailable('Cannot move between different devices');
        }

        const deviceId = await this.getRealDeviceId(oldUri.authority);
        try {
            await execFile('adb', ['-s', deviceId, 'shell', 'mv', this.escapePath(oldUri.path), this.escapePath(newUri.path)]);
            this._onDidChangeFile.fire([
                { type: vscode.FileChangeType.Deleted, uri: oldUri },
                { type: vscode.FileChangeType.Created, uri: newUri }
            ]);
        } catch (e) {
            throw vscode.FileSystemError.NoPermissions(oldUri);
        }
    }
}
