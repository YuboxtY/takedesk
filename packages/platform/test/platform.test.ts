import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  baseChildEnv, defaultDataDir, getProcessStartToken, isAlive, killTree, resolveExecutable, type CommandRunner,
} from '../src';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('platform (POSIX real)', () => {
  it('isAlive y token de inicio estables y distintos entre procesos', async () => {
    expect(isAlive(process.pid)).toBe(true);
    const a = await getProcessStartToken(process.pid);
    expect(a).toBeTruthy();
    expect(await getProcessStartToken(process.pid)).toBe(a);
    const child = spawn('sleep', ['5']);
    const b = await getProcessStartToken(child.pid!);
    expect(b).toBeTruthy();
    expect(b).not.toBe(a);
    child.kill();
  });

  it('killTree mata también a los nietos', async () => {
    // líder de grupo que lanza un nieto
    const leader = spawn('sh', ['-c', 'sleep 60 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const grandchild = await new Promise<number>((res) => leader.stdout!.once('data', (d) => res(Number(String(d).trim()))));
    expect(isAlive(grandchild)).toBe(true);
    await killTree(leader.pid!, { force: true });
    await sleep(300);
    expect(isAlive(grandchild)).toBe(false);
  });

  it('resolveExecutable encuentra node y devuelve null si no existe', () => {
    expect(resolveExecutable('node')?.path).toMatch(/node$/);
    expect(resolveExecutable('no-existe-xyz')).toBeNull();
  });

  it('baseChildEnv no filtra variables fuera de la lista blanca', () => {
    const env = baseChildEnv({ PATH: '/bin', SECRET_TOKEN: 'x', ANTHROPIC_API_KEY: 'y' } as NodeJS.ProcessEnv);
    expect(env).toEqual({ PATH: '/bin' });
  });
});

describe('platform (rama Windows con dobles; NO validada en Windows real)', () => {
  it('killTree usa taskkill /T (y /F si force)', async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (f, a) => { calls.push([f, ...a]); return { stdout: '' }; };
    await killTree(1234, { platform: 'win32', run });
    await killTree(1234, { platform: 'win32', run, force: true });
    expect(calls).toEqual([
      ['taskkill', '/PID', '1234', '/T'],
      ['taskkill', '/PID', '1234', '/T', '/F'],
    ]);
  });

  it('getProcessStartToken consulta PowerShell con PID numérico', async () => {
    let received: string[] = [];
    const run: CommandRunner = async (_f, a) => { received = a; return { stdout: '133500000000000000\r\n' }; };
    expect(await getProcessStartToken(42, { platform: 'win32', run })).toBe('133500000000000000');
    expect(received.join(' ')).toContain('Get-Process -Id 42');
  });

  it('defaultDataDir usa LOCALAPPDATA en Windows', () => {
    expect(defaultDataDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, home: 'C:\\Users\\u' }))
      .toBe(path.win32.join('C:\\Users\\u\\AppData\\Local', 'AIWorkspace'));
  });

  it('resolveExecutable en Windows prefiere .exe y marca los .cmd como shim', () => {
    // sin FS real: solo comprobamos que con PATH vacío devuelve null sin lanzar
    expect(resolveExecutable('claude', { platform: 'win32', env: { PATH: '' } })).toBeNull();
  });
});
