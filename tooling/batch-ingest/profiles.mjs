import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { secrets } from 'just-secrets';
import { targetUrl } from './core.mjs';

const service = 'FlareTune.batch-ingest';
export function defaultProfilesPath() {
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'FlareTune', 'batch-ingest', 'profiles.json');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'FlareTune', 'batch-ingest', 'profiles.json');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'flaretune', 'batch-ingest', 'profiles.json');
}

export class ProfileStore {
  constructor({ path = defaultProfilesPath(), vault = secrets } = {}) {
    this.path = path;
    this.vault = vault;
  }
  async list() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === 'string') : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  async write(profiles) {
    await mkdir(join(this.path, '..'), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(profiles, null, 2), { mode: 0o600 });
    await rename(temporary, this.path);
  }
  async password(id) {
    return this.vault.get({ service, name: id });
  }
  async save({ id, name, baseUrl, username, password, rememberPassword }) {
    const profiles = await this.list();
    const previous = id ? profiles.find((profile) => profile.id === id) : null;
    if (id && !previous) throw new Error('实例配置不存在。');
    const profile = {
      id: previous?.id || randomUUID(),
      name: String(name || '').trim().slice(0, 60),
      baseUrl: targetUrl(baseUrl),
      username: String(username || '').trim().slice(0, 100),
      savedPassword: previous?.savedPassword || false,
    };
    if (!profile.name || !profile.username) throw new Error('请填写实例名称和管理员用户名。');
    let warning = '';
    let wrotePassword = false;
    let priorPassword = null;
    if (previous?.savedPassword && rememberPassword) {
      try { priorPassword = await this.vault.get({ service, name: profile.id }); }
      catch { return { profile: previous, warning: '系统凭据库暂不可用；本次已登录，保存的密码未更新。' }; }
    }
    if (rememberPassword) {
      try {
        await this.vault.set({ service, name: profile.id, value: password });
        wrotePassword = true;
        profile.savedPassword = true;
      } catch {
        if (previous?.savedPassword) return { profile: previous,
          warning: '系统凭据库未能更新密码；本次已登录，旧凭据仍保留。' };
        profile.savedPassword = false;
        warning = '当前系统凭据库不可用，密码未保存；下次连接需要重新输入。';
      }
    } else if (previous?.savedPassword) {
      try { await this.vault.delete({ service, name: profile.id }); }
      catch { return { profile: previous, warning: '系统凭据库暂不可用；本次已登录，旧密码尚未清除。' }; }
      profile.savedPassword = false;
    }
    const next = profiles.filter((item) => item.id !== profile.id);
    next.push(profile);
    try { await this.write(next); }
    catch (error) {
      if (wrotePassword) {
        if (previous?.savedPassword && priorPassword !== null) {
          await this.vault.set({ service, name: profile.id, value: priorPassword }).catch(() => {});
        } else if (!previous?.savedPassword) {
          await this.vault.delete({ service, name: profile.id }).catch(() => {});
        }
      }
      throw error;
    }
    return { profile, warning };
  }
  async remove(id) {
    const profiles = await this.list();
    const profile = profiles.find((item) => item.id === id);
    if (!profile) throw new Error('实例配置不存在。');
    if (profile.savedPassword) await this.vault.delete({ service, name: id });
    await this.write(profiles.filter((item) => item.id !== id));
  }
}
