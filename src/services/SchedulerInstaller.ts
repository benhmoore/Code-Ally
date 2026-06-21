/**
 * SchedulerInstaller - per-user OS integration for `ally scheduler tick`
 *
 * The installed OS job is deliberately small: wake Code Ally every minute and
 * let the shared scheduler core decide what is due.
 */

import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { homedir } from 'os';
import { dirname, join } from 'path';

export type SchedulerInstallPlatform = 'darwin' | 'linux-systemd' | 'linux-cron' | 'windows' | 'unsupported';

export interface SchedulerInstallStatus {
  platform: SchedulerInstallPlatform;
  installed: boolean;
  detail: string;
}

const MAC_LABEL = 'com.code-ally.scheduler';
const SYSTEMD_UNIT = 'code-ally-scheduler';
const WINDOWS_TASK = 'CodeAllyScheduler';
const CRON_MARKER = '# code-ally-scheduler';

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function execFileAsync(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function commandExists(command: string): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      await execFileAsync('where', [command]);
    } else {
      await execFileAsync('/bin/sh', ['-lc', `command -v ${shellQuote(command)}`]);
    }
    return true;
  } catch {
    return false;
  }
}

export class SchedulerInstaller {
  constructor(
    private readonly nodePath: string = process.execPath,
    private readonly scriptPath: string = process.argv[1] || 'ally',
  ) {}

  getTickCommand(): { command: string; args: string[] } {
    return { command: this.nodePath, args: [this.scriptPath, 'scheduler', 'tick'] };
  }

  async install(): Promise<SchedulerInstallStatus> {
    if (process.platform === 'darwin') return this.installMac();
    if (process.platform === 'linux') return this.installLinux();
    if (process.platform === 'win32') return this.installWindows();
    return { platform: 'unsupported', installed: false, detail: `Unsupported platform: ${process.platform}` };
  }

  async uninstall(): Promise<SchedulerInstallStatus> {
    if (process.platform === 'darwin') return this.uninstallMac();
    if (process.platform === 'linux') return this.uninstallLinux();
    if (process.platform === 'win32') return this.uninstallWindows();
    return { platform: 'unsupported', installed: false, detail: `Unsupported platform: ${process.platform}` };
  }

  async status(): Promise<SchedulerInstallStatus> {
    if (process.platform === 'darwin') {
      const plist = this.macPlistPath();
      return {
        platform: 'darwin',
        installed: await this.exists(plist),
        detail: plist,
      };
    }
    if (process.platform === 'linux') {
      const timer = this.systemdTimerPath();
      if (await this.exists(timer)) return { platform: 'linux-systemd', installed: true, detail: timer };
      const cronInstalled = await this.cronContainsMarker();
      return { platform: 'linux-cron', installed: cronInstalled, detail: cronInstalled ? 'crontab entry installed' : 'not installed' };
    }
    if (process.platform === 'win32') {
      try {
        await execFileAsync('schtasks', ['/Query', '/TN', WINDOWS_TASK]);
        return { platform: 'windows', installed: true, detail: WINDOWS_TASK };
      } catch {
        return { platform: 'windows', installed: false, detail: WINDOWS_TASK };
      }
    }
    return { platform: 'unsupported', installed: false, detail: `Unsupported platform: ${process.platform}` };
  }

  private async installMac(): Promise<SchedulerInstallStatus> {
    const plist = this.macPlistPath();
    const { command, args } = this.getTickCommand();
    const programArgs = [command, ...args]
      .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
      .join('\n');
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(homedir(), '.ally', 'scheduler.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(homedir(), '.ally', 'scheduler.err.log'))}</string>
</dict>
</plist>
`;
    await fs.mkdir(dirname(plist), { recursive: true });
    await fs.writeFile(plist, content, 'utf-8');
    const uid = process.getuid?.();
    if (uid != null) {
      await execFileAsync('launchctl', ['bootout', `gui/${uid}`, plist]).catch(() => {});
      await execFileAsync('launchctl', ['bootstrap', `gui/${uid}`, plist]).catch(() => {});
      await execFileAsync('launchctl', ['enable', `gui/${uid}/${MAC_LABEL}`]).catch(() => {});
    }
    return { platform: 'darwin', installed: true, detail: plist };
  }

  private async uninstallMac(): Promise<SchedulerInstallStatus> {
    const plist = this.macPlistPath();
    const uid = process.getuid?.();
    if (uid != null) {
      await execFileAsync('launchctl', ['bootout', `gui/${uid}`, plist]).catch(() => {});
    }
    await fs.unlink(plist).catch(() => {});
    return { platform: 'darwin', installed: false, detail: plist };
  }

  private async installLinux(): Promise<SchedulerInstallStatus> {
    if (await commandExists('systemctl')) {
      const service = this.systemdServicePath();
      const timer = this.systemdTimerPath();
      const { command, args } = this.getTickCommand();
      await fs.mkdir(dirname(service), { recursive: true });
      await fs.writeFile(service, `[Unit]
Description=Code Ally scheduled task tick

[Service]
Type=oneshot
ExecStart=${[command, ...args].map(shellQuote).join(' ')}
`, 'utf-8');
      await fs.writeFile(timer, `[Unit]
Description=Run Code Ally scheduled task tick every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
Persistent=false

[Install]
WantedBy=timers.target
`, 'utf-8');
      await execFileAsync('systemctl', ['--user', 'daemon-reload']).catch(() => {});
      await execFileAsync('systemctl', ['--user', 'enable', '--now', `${SYSTEMD_UNIT}.timer`]).catch(() => {});
      return { platform: 'linux-systemd', installed: true, detail: timer };
    }

    await this.installCron();
    return { platform: 'linux-cron', installed: true, detail: 'crontab entry installed' };
  }

  private async uninstallLinux(): Promise<SchedulerInstallStatus> {
    const timer = this.systemdTimerPath();
    const service = this.systemdServicePath();
    if (await this.exists(timer)) {
      await execFileAsync('systemctl', ['--user', 'disable', '--now', `${SYSTEMD_UNIT}.timer`]).catch(() => {});
      await fs.unlink(timer).catch(() => {});
      await fs.unlink(service).catch(() => {});
      await execFileAsync('systemctl', ['--user', 'daemon-reload']).catch(() => {});
      return { platform: 'linux-systemd', installed: false, detail: timer };
    }
    await this.uninstallCron();
    return { platform: 'linux-cron', installed: false, detail: 'crontab entry removed' };
  }

  private async installWindows(): Promise<SchedulerInstallStatus> {
    const { command, args } = this.getTickCommand();
    const taskRun = [`"${command}"`, ...args.map((arg) => `"${arg}"`)].join(' ');
    await execFileAsync('schtasks', [
      '/Create',
      '/SC', 'MINUTE',
      '/MO', '1',
      '/TN', WINDOWS_TASK,
      '/TR', taskRun,
      '/F',
    ]);
    return { platform: 'windows', installed: true, detail: WINDOWS_TASK };
  }

  private async uninstallWindows(): Promise<SchedulerInstallStatus> {
    await execFileAsync('schtasks', ['/Delete', '/TN', WINDOWS_TASK, '/F']).catch(() => {});
    return { platform: 'windows', installed: false, detail: WINDOWS_TASK };
  }

  private async installCron(): Promise<void> {
    const existing = await this.readCrontab();
    const withoutOld = existing.split('\n').filter((line) => !line.includes(CRON_MARKER)).join('\n').trim();
    const { command, args } = this.getTickCommand();
    const line = `* * * * * ${[command, ...args].map(shellQuote).join(' ')} >> ${shellQuote(join(homedir(), '.ally', 'scheduler.cron.log'))} 2>&1 ${CRON_MARKER}`;
    await this.writeCrontab(`${withoutOld ? `${withoutOld}\n` : ''}${line}\n`);
  }

  private async uninstallCron(): Promise<void> {
    const existing = await this.readCrontab();
    const next = existing.split('\n').filter((line) => !line.includes(CRON_MARKER)).join('\n').trim();
    await this.writeCrontab(next ? `${next}\n` : '');
  }

  private async readCrontab(): Promise<string> {
    try {
      const { stdout } = await execFileAsync('crontab', ['-l']);
      return stdout;
    } catch {
      return '';
    }
  }

  private async writeCrontab(content: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = execFile('crontab', ['-'], (error) => {
        if (error) reject(error);
        else resolve();
      });
      child.stdin?.end(content);
    });
  }

  private async cronContainsMarker(): Promise<boolean> {
    return (await this.readCrontab()).includes(CRON_MARKER);
  }

  private macPlistPath(): string {
    return join(homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);
  }

  private systemdServicePath(): string {
    return join(homedir(), '.config', 'systemd', 'user', `${SYSTEMD_UNIT}.service`);
  }

  private systemdTimerPath(): string {
    return join(homedir(), '.config', 'systemd', 'user', `${SYSTEMD_UNIT}.timer`);
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }
}
