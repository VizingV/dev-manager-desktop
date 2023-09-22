import {Injectable, NgZone} from "@angular/core";
import {BehaviorSubject, from, Observable, Subject} from "rxjs";
import {CrashReportEntry, Device, DeviceLike, FileItem, FileSession, NewDevice, StorageInfo} from '../../types';
import {BackendClient} from "./backend-client";
import {FileSessionImpl} from "./file.session";
import {HomebrewChannelConfiguration, SystemInfo} from "../../types/luna-apis";
import {LunaResponseError, RemoteLunaService} from "./remote-luna.service";
import {RemoteCommandService} from "./remote-command.service";
import {RemoteFileService} from "./remote-file.service";
import {DevModeService} from "./dev-mode.service";

export type ScreenshotMethod = 'DISPLAY' | 'VIDEO' | 'GRAPHIC';

@Injectable({
    providedIn: 'root'
})
export class DeviceManagerService extends BackendClient {

    private devicesSubject: Subject<Device[] | null>;
    private selectedSubject: Subject<Device | null>;

    constructor(zone: NgZone, private cmd: RemoteCommandService, private file: RemoteFileService,
                private luna: RemoteLunaService, private devMode: DevModeService) {
        super(zone, 'device-manager');
        this.devicesSubject = new BehaviorSubject<Device[] | null>(null);
        this.selectedSubject = new BehaviorSubject<Device | null>(null);
        this.on('devicesUpdated', (devices: Device[]) => this.onDevicesUpdated(devices));
    }

    get devices$(): Observable<Device[] | null> {
        return this.devicesSubject.asObservable();
    }

    get selected$(): Observable<Device | null> {
        return this.selectedSubject.asObservable();
    }


    load(): void {
        this.list().then(devices => this.onDevicesUpdated(devices));
    }

    async list(): Promise<Device[]> {
        return await this.invoke('list');
    }

    async setDefault(name: string): Promise<Device> {
        const device = await this.invoke<Device>('set_default', {name});
        this.load();
        return device;
    }

    async removeDevice(name: string, removeKey: boolean): Promise<void> {
        return await this.invoke('remove', {name, removeKey}).then(() => this.load());
    }

    async addDevice(device: NewDevice): Promise<Device> {
        return await this.invoke('add', {device});
    }

    async readPrivKey(device: Device): Promise<string> {
        return await this.invoke('privkey_read', {device});
    }

    async novacomGetKey(address: string, passphrase?: string): Promise<string> {
        return await this.invoke('novacom_getkey', {address, passphrase});
    }

    async verifyLocalPrivateKey(name: string, passphrase?: string): Promise<void> {
        await this.invoke('localkey_verify', {name, passphrase});
    }

    async devModeToken(device: Device): Promise<string> {
        return await this.devMode.token(device);
    }

    async listCrashReports(device: Device): Promise<CrashReport[]> {
        const dir = '/tmp/faultmanager/crash/';
        return this.file.ls(device, dir)
            .then(list => list.map(l => CrashReport.obtain(this.file, device, dir, l)));
    }

    async extendDevMode(device: Device): Promise<any> {
        return await this.luna.call(device, 'luna://com.webos.applicationManager/launch', {
            id: 'com.palmdts.devmode',
            subscribe: false,
            params: {extend: true}
        }, true);
    }

    async getSystemInfo(device: DeviceLike): Promise<Partial<SystemInfo>> {
        return await this.luna.call(device, 'luna://com.webos.service.tv.systemproperty/getSystemInfo', {
            keys: ['firmwareVersion', 'modelName', 'sdkVersion']
        });
    }

    async getStorageInfo(device: DeviceLike, mountPoint?: string): Promise<StorageInfo | null> {
        if (!mountPoint) {
            mountPoint = '/media/developer';
        }
        return await this.cmd.exec(device, `df ${mountPoint}`, 'utf-8').then((output) => {
            const lines = output.trim().split('\n');
            if (lines.length < 2) {
                return null;
            }
            const segs = lines[1].split(/\s+/);
            return {total: parseInt(segs[1]), used: parseInt(segs[2]), available: parseInt(segs[3])};
        })
    }

    async takeScreenshot(device: DeviceLike, method: ScreenshotMethod = 'DISPLAY'): Promise<string> {
        const tmpPath = `/tmp/devman_shot_${Date.now()}.png`
        const param: Record<string, any> = {
            path: tmpPath,
            method: method,
            format: "PNG"
        };
        await (this.luna.call(device, 'luna://com.webos.service.capture/executeOneShot', param, false)
            .catch((e) => {
                if (LunaResponseError.isCompatible(e) && e['errorText']?.includes('Service does not exist')) {
                    return this.luna.call(device, 'luna://com.webos.service.tv.capture/executeOneShot', param, false);
                }
                throw e;
            }));
        return tmpPath;
    }

    async getHbChannelConfig(device: Device): Promise<Partial<HomebrewChannelConfiguration>> {
        return await this.luna.call(device, 'luna://org.webosbrew.hbchannel.service/getConfiguration', {});
    }

    fileSession(device: Device): FileSession {
        return new FileSessionImpl(this.cmd, this.file, device);
    }

    private onDevicesUpdated(devices: Device[]) {
        this.devicesSubject.next(devices);
        this.selectedSubject.next(devices.find((device) => device.default) ?? devices[0]);
    }
}

export class CrashReport implements CrashReportEntry {

    constructor(public device: Device, public dir: string, public file: FileItem, public title: string,
                public summary: string, public saveName: string, public content: Observable<string>) {
    }

    get path(): string {
        return `${this.dir}/${this.file.filename}`;
    }

    static obtain(fs: RemoteFileService, device: Device, dir: string, info: FileItem) {
        const {title, summary, saveName} = CrashReport.parseTitle(info.filename);
        const path = `${dir}/${info.filename}`;
        const content = from(fs.read(device, path, 'gzip', 'utf-8')
            .then(s => s.trim()));
        return new CrashReport(device, dir, info, title, summary, saveName, content);
    }

    private static parseTitle(filename: string): { title: string, summary: string; saveName: string; } {
        const name = filename.replace(/[\x00-\x1f]/g, '/').replace(/.gz$/, '');
        let appDirIdx = -1, appDirPrefix = '';
        for (const prefix of ['/usr/palm/applications/', '/var/palm/jail/']) {
            appDirIdx = name.indexOf(prefix);
            if (appDirIdx >= 0) {
                appDirPrefix = prefix;
                break;
            }
        }
        let processName = '', processId = '', summary = '', saveName = name.replace(/\//g, '_');
        let match = name.match(/.*____(.+)\.(\d+)\..+$/);
        if (match) {
            const startIdx = name.indexOf('/'), endIdx = name.lastIndexOf('____');
            processName = match[1];
            processId = match[2];
            summary = name.substring(startIdx, endIdx);
            saveName = summary.replace(/\//g, '_');
        }
        if (appDirIdx < 0) {
            if (processName && processId && summary) {
                return {title: `${processName} (${processId})`, summary, saveName};
            }
            return {title: 'Unknown crash', summary: name, saveName}
        }
        const substr = name.substring(appDirIdx + appDirPrefix.length);
        const firstSlash = substr.indexOf('/'), lastSlash = substr.lastIndexOf('/');
        const appId = substr.substring(0, firstSlash > 0 ? firstSlash : undefined);
        if (lastSlash > 0) {
            const lastUnderscoreIdx = substr.lastIndexOf('____');
            if (lastUnderscoreIdx > 0) {
                summary = substr.substring(lastSlash + 1, lastUnderscoreIdx);
            }
        }
        const title = processId ? `${appId} (${processId})` : appId;
        return {title, summary, saveName};
    }

}
