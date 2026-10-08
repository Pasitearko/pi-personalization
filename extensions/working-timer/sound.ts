import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SOUND_PATH = fileURLToPath(new URL("./assets/completion.wav", import.meta.url));
export const MAX_PLAYBACK_MS = 30_000;
export const SOUND_VOLUME_PERCENT = 70;

/** MCI decodes audio through Windows itself; no player window, downloads or global volume changes. */
export function playbackScript(path: string, volumePercent: number = SOUND_VOLUME_PERCENT): string {
  if (!Number.isFinite(volumePercent) || volumePercent < 0 || volumePercent > 100) {
    throw new RangeError("Sound volume must be between 0 and 100 percent");
  }
  const volume = Math.round(volumePercent * 10); // MCI's per-player volume range is 0..1000.
  const literal = path.replace(/'/g, "''");
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$path = '${literal}'
if (!(Test-Path -LiteralPath $path -PathType Leaf)) { exit 2 }
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PiRoundAudio {
  [DllImport("winmm.dll", CharSet = CharSet.Unicode, EntryPoint = "mciSendStringW")]
  public static extern int Send(string command, StringBuilder output, int size, IntPtr callback);
}
'@
$alias = 'pi_round_audio'
$opened = $false
$exitCode = 0
try {
  $command = 'open "' + $path + '" type mpegvideo alias ' + $alias
  if ([PiRoundAudio]::Send($command, $null, 0, [IntPtr]::Zero) -ne 0) { throw 'open' }
  $opened = $true
  if ([PiRoundAudio]::Send(('setaudio ' + $alias + ' volume to ${volume}'), $null, 0, [IntPtr]::Zero) -ne 0) { throw 'volume' }
  if ([PiRoundAudio]::Send(('play ' + $alias + ' wait'), $null, 0, [IntPtr]::Zero) -ne 0) { throw 'play' }
} catch {
  $exitCode = 1
} finally {
  if ($opened) { [void][PiRoundAudio]::Send(('close ' + $alias), $null, 0, [IntPtr]::Zero) }
}
exit $exitCode
`;
}

export interface SoundPlayer {
  play(onFailure?: () => void): void;
  dispose(): void;
}
interface Options {
  path?: string;
  volumePercent?: number;
  platform?: string;
  spawnProcess?: typeof spawn;
}

/** Playback is fire-and-forget; kill an earlier sound rather than stacking multiple players. */
export function createSoundPlayer(options: Options = {}): SoundPlayer {
  const platform = options.platform ?? process.platform;
  const launch = options.spawnProcess ?? spawn;
  const encoded = Buffer.from(playbackScript(options.path ?? SOUND_PATH, options.volumePercent ?? SOUND_VOLUME_PERCENT), "utf16le").toString("base64");
  let stopCurrent: (() => void) | undefined;
  let disposed = false;
  return {
    play(onFailure) {
      if (disposed || platform !== "win32") return;
      stopCurrent?.();
      const report = () => { try { onFailure?.(); } catch { /* Audio cannot break the round. */ } };
      let child: ChildProcess;
      try {
        child = launch("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
          { windowsHide: true, stdio: "ignore", shell: false });
      } catch { report(); return; }
      let settled = false;
      const deadline = setTimeout(() => { if (!settled) { cancel(); report(); } }, MAX_PLAYBACK_MS);
      deadline.unref?.();
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
      };
      const cancel = () => {
        if (settled) return;
        cleanup();
        try { child.kill(); } catch { /* Already exited. */ }
      };
      stopCurrent = cancel;
      child.once("error", () => { if (!settled) { cleanup(); report(); } });
      child.once("close", code => {
        if (settled) return;
        cleanup();
        if (code !== 0) report();
      });
      child.unref();
    },
    dispose() {
      disposed = true;
      stopCurrent?.();
      stopCurrent = undefined;
    },
  };
}
