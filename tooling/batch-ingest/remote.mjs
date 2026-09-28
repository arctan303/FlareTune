import { targetUrl } from './core.mjs';

function upstreamError(response, message) {
  const error = new Error(message);
  error.upstreamStatus = response.status;
  return error;
}

export class RemoteCatalog {
  constructor(baseUrl, fetchImpl = fetch) {
    this.base = targetUrl(baseUrl);
    this.fetch = fetchImpl;
    this.cookie = '';
    this.csrf = '';
    this.account = null;
  }

  async request(path, { method = 'GET', body, headers = {}, signal } = {}) {
    const response = await this.fetch(this.base + path, {
      method, body, signal, redirect: 'error', duplex: body && typeof body !== 'string' ? 'half' : undefined,
      headers: {
        'X-Requested-With': 'FlareTune',
        ...(method !== 'GET' && method !== 'HEAD' ? { Origin: this.base } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(this.csrf && method !== 'GET' && method !== 'HEAD' ? {
          'X-CSRF-Token': this.csrf,
          'X-FlareTune-Expected-Account': this.account.accountId,
        } : {}),
        ...headers,
      },
    });
    return response;
  }

  async login(username, password) {
    const response = await this.request('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ username, password }),
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.authenticated || data.user?.role !== 'admin' || data.mustChangePassword) {
      throw new Error(data.mustChangePassword ? 'Change the administrator password in the web app first.' : 'Administrator sign-in failed.');
    }
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] || '';
    if (!/^__Host-ft_session=/.test(cookie) || !data.csrfToken) throw new Error('The instance did not return a usable administrator session.');
    this.cookie = cookie;
    this.csrf = data.csrfToken;
    this.account = data.user;
    return { username: data.user.username, accountId: data.user.accountId };
  }

  async json(path, options = {}) {
    const response = await this.request(path, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw upstreamError(response, payload.message || payload.error || `Instance request failed (${response.status}).`);
    }
    return payload.data ?? payload;
  }

  async listSongs() {
    const all = [];
    for (let page = 1; ; page += 1) {
      const result = await this.json(`/api/admin/catalog/songs?page=${page}&limit=100`);
      all.push(...result.songs);
      if (all.length >= result.total || !result.songs.length) return all;
    }
  }

  async getSong(id) {
    const response = await this.request(`/api/admin/catalog/songs/${encodeURIComponent(id)}`);
    if (response.status === 404) return null;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw upstreamError(response, payload.message || `Could not read the song (${response.status}).`);
    return payload.data?.song || null;
  }

  async createSong(song) {
    return this.json('/api/admin/catalog/songs', {
      method: 'POST', body: JSON.stringify(song), headers: { 'Content-Type': 'application/json' },
    });
  }

  async updateSong(id, song) {
    return this.json(`/api/admin/catalog/songs/${encodeURIComponent(id)}`, {
      method: 'PUT', body: JSON.stringify(song), headers: { 'Content-Type': 'application/json' },
    });
  }

  async deleteSong(id, expectedVersion) {
    return this.json(`/api/admin/catalog/songs/${encodeURIComponent(id)}`, {
      method: 'DELETE', body: JSON.stringify({ expectedVersion, confirmDelete: true }),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async previewSongDeletion(id) {
    return this.json('/api/admin/catalog/delete-preview', {
      method: 'POST', body: JSON.stringify({ ids: [id] }),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async deleteSongWithImpact(id, impactDigest, deleteMedia) {
    const response = await this.request('/api/admin/catalog/delete', {
      method: 'POST', body: JSON.stringify({ ids: [id], delete_media: deleteMedia, impact_digest: impactDigest }),
      headers: { 'Content-Type': 'application/json' },
    });
    const payload = await response.json().catch(() => ({}));
    return { status: response.status, ...payload };
  }

  async uploadWorker(kind, id, extension, contentType, length, body, signal) {
    const response = await this.request(`/api/admin/catalog/media/${kind}/${id}.${extension}`, {
      method: 'PUT', body, signal,
      headers: { 'Content-Type': contentType, 'Content-Length': String(length), 'X-FlareTune-Media-Size': String(length) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true) throw upstreamError(response,
      payload.message || `Worker upload failed (${response.status}).`);
    return payload.data;
  }

  async mediaHead(kind, id, extension) {
    return this.request(`/media/${kind}/${id}.${extension}`, { method: 'HEAD' });
  }

  async logout() {
    await this.request('/api/auth/logout', { method: 'POST' });
    this.cookie = '';
    this.csrf = '';
  }
}
