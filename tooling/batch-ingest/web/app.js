import { parseBlob } from 'music-metadata';
import { AUDIO_TYPES, COVER_TYPES, WORKER_MAX_BYTES, catalogDuplicateMatches, catalogSaveApplied, duplicateMatches, fileIdentity, folderLanguage, replacementSongBody } from '../core.mjs';
import { suggestSongLanguage } from '../../../client/src/utils/songLanguageSuggestion.js';
import { catalogSongBody } from '../../../client/src/utils/catalogSongDraft.js';
import { compareSongIdentity, duplicateReviewSignature } from '../../../client/src/utils/songDuplicateCheck.js';

const $ = (id) => document.getElementById(id);
const LANGUAGES = [['', '未设置'], ['zh', '中文'], ['ja', '日语'], ['en', '英语'], ['ko', '韩语'],
  ['instrumental', '纯音乐'], ['yue', '粤语'], ['ru', '俄语'], ['es', '西班牙语'], ['fr', '法语'],
  ['de', '德语'], ['sv', '瑞典语'], ['vi', '越南语'], ['it', '意大利语'], ['th', '泰语'],
  ['pt', '葡萄牙语'], ['other', '其他']];
const state = { csrf: '', baseUrl: '', profileId: '', account: null, profiles: [], catalog: [], catalogDuplicates: new Map(), expandedDuplicateIds: new Set(), entries: [], mappings: {}, reviewIndex: -1, reviewAudioUrl: '',
  running: false, scanning: false, scanGeneration: 0, pause: false, r2Ready: false, mode: 'worker', view: 'catalog', catalogPage: 1, editing: null, deleteImpact: null, deleteGeneration: 0 };
const escape = (value) => String(value ?? '').replace(/[&<>"']/g,
  (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const manifestKey = 'flaretune-batch-ingest-v1';
const mediaId = () => [...crypto.getRandomValues(new Uint8Array(8))]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');
const manifest = (() => { try { return JSON.parse(localStorage.getItem(manifestKey) || '{}'); } catch { return {}; } })();
function loadMappings() {
  try { state.mappings = JSON.parse(localStorage.getItem(`flaretune-folder-mappings-v1:${state.profileId}`) || '{}'); }
  catch { state.mappings = {}; }
}
function saveMappings() {
  localStorage.setItem(`flaretune-folder-mappings-v1:${state.profileId}`, JSON.stringify(state.mappings));
}
const persist = (entry) => {
  manifest[entry.identity] = { id: entry.draft.id, draft: entry.draft, languageMode: entry.languageMode,
    audioId: entry.audioId, coverId: entry.coverId,
    audioUrl: entry.audioUrl || '', coverUrl: entry.coverUrl || '', saved: entry.status === 'saved', savedSongId: entry.savedSongId || '' };
  localStorage.setItem(manifestKey, JSON.stringify(manifest));
};
const notice = (text, error = false) => {
  $('notice').textContent = text;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = !text;
};

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { 'X-Requested-With': 'FlareTuneIngest',
      ...(state.csrf ? { 'X-Ingest-CSRF': state.csrf } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `请求失败（${response.status}）`);
  return value;
}

async function loadCatalog() {
  const generation = state.scanGeneration;
  const data = await api('/api/catalog');
  if (generation !== state.scanGeneration) return false;
  state.catalog = data.songs;
  state.catalogDuplicates = catalogDuplicateMatches(state.catalog);
  recomputeMatches();
  renderCatalog();
  render();
  return true;
}

function renderProfiles() {
  $('profiles').innerHTML = state.profiles.length ? state.profiles.map((profile) =>
    `<div class="profile" data-id="${escape(profile.id)}"><div><strong>${escape(profile.name)}</strong><p class="hint">${escape(profile.baseUrl)} · ${escape(profile.username)} · ${profile.savedPassword ? '密码已保存' : '连接时输入密码'}</p></div>
      <div class="actions"><button data-profile-action="connect">连接</button><button data-profile-action="remove">删除配置</button></div></div>`).join('') : '<p class="hint">还没有保存的实例。</p>';
}
async function loadProfiles() {
  state.profiles = (await api('/api/profiles')).profiles;
  renderProfiles();
}
function setView(view) {
  state.view = view;
  $('catalog-view').hidden = view !== 'catalog';
  $('ingest-view').hidden = view !== 'ingest';
  document.querySelectorAll('.tool-nav button').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
}
function catalogFiltered() {
  const query = $('catalog-search').value.trim().toLocaleLowerCase();
  return state.catalog.filter((song) => (!query || `${song.title} ${song.artist || ''} ${song.album || ''}`.toLocaleLowerCase().includes(query))
    && (!$('catalog-only-duplicates').checked || state.catalogDuplicates.has(song.id)));
}
function catalogCoverSrc(value) {
  const path = /^(?:\/media\/)?cover\/([0-9a-f]{16})\.(jpg|jpeg|png|webp)$/.exec(String(value || ''));
  if (path && state.profileId) return `/api/cover/${encodeURIComponent(state.profileId)}/${path[1]}.${path[2]}`;
  try {
    const external = new URL(value);
    return external.protocol === 'https:' && !external.username && !external.password ? external.href : '';
  } catch { return ''; }
}
function catalogAudioSrc(value) {
  const path = /^(?:\/media\/)?audio\/([0-9a-f]{16})\.(mp3|flac|wav|ogg|m4a|aac|wma)$/.exec(String(value || ''));
  if (path && state.profileId) return `/api/audio/${encodeURIComponent(state.profileId)}/${path[1]}.${path[2]}`;
  try {
    const external = new URL(value);
    return external.protocol === 'https:' && !external.username && !external.password ? external.href : '';
  } catch { return ''; }
}

function renderDeleteImpact(impact) {
  const playlists = impact.affected_playlists || [];
  const relations = impact.playlist_relations || [];
  const play = (impact.play_records || []).reduce((sum, item) => ({
    stats: sum.stats + Number(item.play_stats || 0), events: sum.events + Number(item.play_events || 0),
  }), { stats: 0, events: 0 });
  const translations = (impact.lyric_translations || []).reduce((sum, item) => sum + Number(item.count || 0), 0);
  const media = (impact.media || []).filter((item) => item.path);
  $('delete-impact').innerHTML = `<p>将移除：${playlists.length} 个歌单中的 ${relations.length} 条关联、${play.stats} 条播放统计、${play.events} 条播放事件、${translations} 条歌词翻译记录。</p>
    ${playlists.length ? `<p>受影响歌单：${playlists.map((item) => escape(item.name || item.id)).join('、')}</p>` : ''}
    <p>关联文件：</p><ul>${media.length ? media.map((item) => `<li>${item.field === 'audio_url' ? '音频' : '封面'}：${escape(item.path)} · ${item.can_delete ? '可选择删除' : '保留（共用或不属于本实例）'}</li>`).join('') : '<li>没有可识别的关联文件</li>'}</ul>`;
}

async function refreshDeleteImpact(song) {
  const generation = state.deleteGeneration;
  const impact = await api(`/api/song/${encodeURIComponent(song.id)}/delete-preview`, { method: 'POST', body: {} });
  if (generation !== state.deleteGeneration || !($('delete-dialog').open) || state.editing?.id !== song.id) return;
  if (!impact.songs?.some((item) => item.id === song.id) || !impact.impact_digest) {
    throw new Error('歌曲已不存在，请刷新曲库。');
  }
  state.deleteImpact = impact;
  renderDeleteImpact(impact);
  $('delete-confirm').disabled = false;
}
const durationLabel = (value) => Number.isFinite(Number(value)) && Number(value) > 0
  ? `${Math.floor(Number(value) / 60)}:${String(Math.floor(Number(value) % 60)).padStart(2, '0')}` : '时长未知';
function renderCatalog() {
  const filtered = catalogFiltered();
  const pageCount = Math.max(1, Math.ceil(filtered.length / 40));
  state.catalogPage = Math.min(state.catalogPage, pageCount);
  const page = filtered.slice((state.catalogPage - 1) * 40, state.catalogPage * 40);
  $('catalog-summary').textContent = `${state.catalog.length} 首歌曲 · ${state.catalogDuplicates.size} 首疑似重复${filtered.length !== state.catalog.length ? ` · 当前显示 ${filtered.length} 首` : ''}`;
  $('catalog-songs').innerHTML = page.length ? page.map((song) => {
    const cover = catalogCoverSrc(song.cover_url);
    const matches = state.catalogDuplicates.get(song.id) || [];
    const expanded = state.expandedDuplicateIds.has(song.id);
    return `<article class="catalog-song" data-id="${escape(song.id)}">
      <div class="catalog-cover">${cover ? `<img src="${escape(cover)}" alt="" loading="lazy" />` : ''}<span ${cover ? 'hidden' : ''} aria-label="无封面">♫</span></div>
      <div class="catalog-song-info"><strong>${escape(song.title)}</strong><p>${escape(song.artist || '未知歌手')} · ${escape(song.album || '未知专辑')}</p>
        <p>${escape(durationLabel(song.duration))} · ${escape(LANGUAGES.find(([code]) => code === song.language)?.[1] || '未设置语言')}${matches.length ? ` · <span class="duplicate-badge">疑似重复 ${matches.length}</span>` : ''}</p></div>
      <div class="actions">${matches.length ? `<button data-catalog-action="matches" aria-expanded="${expanded}">${expanded ? '收起匹配' : '查看匹配'}</button>` : ''}<button data-catalog-action="edit">编辑</button><button data-catalog-action="delete">删除</button></div>
      ${expanded ? `<div class="catalog-matches"><strong>疑似相同的歌曲</strong>${matches.map(({ song: other, strength }) => `<p>${escape(strength === 'strong' ? '高度相似' : '可能相似')} · ${escape(other.title)} · ${escape(other.artist || '未知歌手')} · ${escape(other.album || '未知专辑')} · ${escape(durationLabel(other.duration))} · ID ${escape(other.id)}</p>`).join('')}</div>` : ''}
      </article>`;
  }).join('') : `<p class="empty">${$('catalog-only-duplicates').checked ? '当前没有符合条件的疑似重复歌曲。' : '没有匹配的歌曲。'}</p>`;
  $('catalog-page').textContent = `${state.catalogPage} / ${pageCount}`;
  $('catalog-prev').disabled = state.catalogPage <= 1;
  $('catalog-next').disabled = state.catalogPage >= pageCount;
}

function recomputeMatches() {
  state.entries.forEach((entry, index) => {
    entry.matches = duplicateMatches(entry.draft,
      state.catalog.filter((song) => song.id !== entry.draft.id),
      state.entries.slice(0, index).filter((item) => !item.skip).map((item) => item.draft));
    const key = duplicateReviewSignature(entry.matches);
    if (entry.status !== 'saved' && entry.allowDuplicate && entry.reviewKey !== key) {
      entry.allowDuplicate = false; entry.replaceTarget = null;
      entry.reviewStale = true;
      entry.message = '匹配结果有变化，请重新核对。';
    }
    entry.currentMatchKey = key;
  });
}

function closeDuplicateReview() {
  $('duplicate-dialog').close();
  if (state.reviewAudioUrl) URL.revokeObjectURL(state.reviewAudioUrl);
  state.reviewAudioUrl = ''; state.reviewIndex = -1;
}
function openDuplicateReview(index) {
  const entry = state.entries[index];
  if (!entry || state.running) return;
  recomputeMatches();
  if (!entry.matches.length && !entry.reviewStale) { render(); return; }
  state.reviewIndex = index;
  state.reviewAudioUrl = URL.createObjectURL(entry.file);
  const selected = entry.replaceTarget ? `replace:${entry.replaceTarget.id}` : entry.allowDuplicate ? 'add' : 'skip';
  $('duplicate-review').innerHTML = `<div class="review-card"><strong>本次文件：${escape(entry.draft.title)}</strong>
    <p>${escape(entry.draft.artist || '歌手未设置')} · ${escape(entry.draft.album || '专辑未设置')} · ${escape(durationLabel(entry.draft.duration))} · ${escape(LANGUAGES.find(([code]) => code === entry.draft.language)?.[1] || '未设置语言')}</p>
    <p class="hint">${escape(entry.path)}</p>${entry.coverPreview ? `<img class="review-cover" src="${escape(entry.coverPreview)}" alt="本次封面" />` : '<p class="hint">本次无封面；替换时保留旧封面。</p>'}
    <audio controls preload="none" src="${escape(state.reviewAudioUrl)}" aria-label="试听本次文件"></audio></div>
    <label class="review-choice"><input type="radio" name="duplicate-choice" value="skip" ${selected === 'skip' ? 'checked' : ''} /> 跳过此首（默认）</label>
    <label class="review-choice"><input type="radio" name="duplicate-choice" value="add" ${selected === 'add' ? 'checked' : ''} /> 新增另一版本（新歌曲 ID）</label>
    ${!entry.matches.length ? '<p class="hint">原匹配项已不存在。请明确新增，或继续跳过。</p>' : ''}
    ${entry.matches.map((match) => {
      const song = match.song;
      const replacement = match.source === 'catalog' && song.version;
      const cover = replacement ? catalogCoverSrc(song.cover_url) : '';
      const audio = replacement ? catalogAudioSrc(song.audio_url) : '';
      return `<div class="review-card">${replacement ? `<label class="review-choice"><input type="radio" name="duplicate-choice" value="replace:${escape(song.id)}" ${selected === `replace:${song.id}` ? 'checked' : ''} /> 替换这首曲库歌曲</label>` : '<strong>本次清单匹配（尚不能替换）</strong>'}
        <p>${escape(song.title)} · ${escape(song.artist || '歌手未设置')} · ${escape(song.album || '专辑未设置')}</p>
        <p class="hint">${escape(durationLabel(song.duration))} · ${escape(LANGUAGES.find(([code]) => code === song.language)?.[1] || '未设置语言')} · ${match.strength === 'strong' ? '高度相似' : '可能不同版本'}${replacement ? ` · ID ${escape(song.id)}` : ''}</p>
        ${cover ? `<img class="review-cover" src="${escape(cover)}" alt="现有封面" />` : replacement ? '<p class="hint">现有歌曲无可预览封面。</p>' : ''}
        ${audio ? `<audio controls preload="none" src="${escape(audio)}" aria-label="试听曲库歌曲 ${escape(song.title)}"></audio>` : replacement ? '<p class="hint">现有音频无法在工具内试听。</p>' : ''}</div>`;
    }).join('')}`;
  $('duplicate-dialog').showModal();
}

function summary() {
  const all = state.entries;
  const saved = all.filter((entry) => entry.status === 'saved').length;
  const dup = all.filter((entry) => (entry.reviewStale || entry.matches.length && !entry.allowDuplicate)
    && !entry.skip && entry.status !== 'saved').length;
  const failed = all.filter((entry) => entry.status === 'error').length;
  $('summary').textContent = all.length
    ? `${all.length} 首音频 · 已入库 ${saved} · 疑似重复 ${dup} · 失败 ${failed}`
    : '尚未选择文件夹。';
  $('start').disabled = !all.length || state.running || state.scanning || (state.mode === 'direct' && !state.r2Ready);
  $('pause').hidden = !state.running;
}

function syncR2Form() {
  const form = $('r2-form');
  form.querySelectorAll('input, select').forEach((field) => { field.disabled = state.running || state.r2Ready; });
  const button = form.querySelector('button');
  button.disabled = state.running;
  button.textContent = state.r2Ready ? '修改 R2 配置' : '验证 bucket 与播放器实例';
  render();
}

const languageOptions = (selected) => LANGUAGES.map(([code, label]) =>
  `<option value="${code}" ${code === selected ? 'selected' : ''}>${label}</option>`).join('');
const visibleEntries = () => {
  const query = $('search').value.trim().toLocaleLowerCase();
  return state.entries.filter((entry) => !query ||
    `${entry.draft.title} ${entry.draft.artist} ${entry.path}`.toLocaleLowerCase().includes(query));
};
function renderSelection() {
  const selected = state.entries.filter((entry) => entry.selected && entry.status !== 'saved');
  $('selected-count').textContent = `已选 ${selected.length} 首`;
  $('apply-language').disabled = !selected.length || !state.running && !$('bulk-language').value || state.running;
  $('restore-language').disabled = !selected.length || state.running;
  const selectable = visibleEntries().filter((entry) => entry.status !== 'saved');
  $('select-visible').checked = selectable.length > 0 && selectable.every((entry) => entry.selected);
  $('select-visible').indeterminate = selectable.some((entry) => entry.selected) && !$('select-visible').checked;
}

function render() {
  summary();
  const visible = visibleEntries();
  $('songs').innerHTML = visible.length ? visible.map((entry) => {
    const index = state.entries.indexOf(entry);
    const match = entry.matches[0];
    const status = entry.status === 'saved' ? '已入库' : entry.status === 'uploading' ? '上传中'
      : entry.status === 'error' ? '失败' : entry.skip ? '已跳过'
        : entry.reviewStale ? '匹配变化 · 待核对' : match && !entry.allowDuplicate ? '疑似重复 · 默认跳过'
          : entry.replaceTarget ? '将替换曲库歌曲' : entry.allowDuplicate ? '将新增另一版本' : '待入库';
    const disabled = state.running || entry.status === 'saved';
    return `<article class="song" data-index="${index}">
      <div class="song-leading"><input type="checkbox" data-select="1" aria-label="选中 ${escape(entry.draft.title)}" ${entry.selected ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
      ${entry.coverPreview ? `<img class="cover" src="${escape(entry.coverPreview)}" alt="" />`
        : '<div class="cover missing" aria-hidden="true">♫</div>'}</div>
      <div><div class="song-title">${index + 1}. ${escape(entry.draft.title)}</div>
        <div class="song-path">${escape(entry.path)} · ${Math.round(entry.file.size / 1024 / 1024 * 10) / 10} MB</div>
        <div class="song-meta">${escape(entry.draft.artist || '未知歌手')} · ${escape(entry.draft.album || '未知专辑')} · ${escape(LANGUAGES.find(([code]) => code === entry.draft.language)?.[1] || '未设置语言')}</div>
        ${entry.editorOpen ? `<div class="song-fields">
          <label>歌名<input data-field="title" value="${escape(entry.draft.title)}" ${disabled ? 'disabled' : ''} /></label>
          <label>歌手<input data-field="artist" value="${escape(entry.draft.artist)}" ${disabled ? 'disabled' : ''} /></label>
          <label>专辑<input data-field="album" value="${escape(entry.draft.album)}" ${disabled ? 'disabled' : ''} /></label>
          <label>时长（秒）<input data-field="duration" type="number" min="0" max="86400" value="${escape(entry.draft.duration)}" ${disabled ? 'disabled' : ''} /></label>
          <label>语言<select data-field="language" ${disabled ? 'disabled' : ''}>${languageOptions(entry.draft.language)}</select></label>
        </div>` : ''}${match && entry.status !== 'saved' ? `<div class="match">发现 ${entry.matches.length} 项疑似重复 · ${escape(match.source === 'catalog' ? '曲库已有' : '本次清单')}：${escape(match.song.title)} · ${escape(match.song.artist || '未知歌手')}${match.strength === 'possible' ? ' · 可能不同版本' : ''}</div>` : ''}
        ${entry.languageSource ? `<span class="tag">语言：${escape(entry.languageSource)}</span>` : ''}</div>
      <div class="song-state ${entry.status === 'error' ? 'error' : match && !entry.allowDuplicate ? 'duplicate' : ''}">
        <strong>${status}</strong>${entry.message ? `<div>${escape(entry.message)}</div>` : ''}
        ${!disabled ? `<button data-action="edit">${entry.editorOpen ? '收起编辑' : '编辑'}</button>` : ''}
        ${entry.status !== 'saved' && !state.running ? `<button data-action="skip">${entry.skip ? '恢复' : '跳过'}</button>` : ''}
        ${(match || entry.reviewStale) && entry.status !== 'saved' && !entry.skip && !state.running ? '<button data-action="review">核对并选择</button>' : ''}
      </div></article>`;
  }).join('') : `<p class="empty">${state.entries.length ? '没有匹配的歌曲。' : '请选择音乐文件夹。'}</p>`;
  renderSelection();
}

function renderMappings() {
  const folders = [...new Set(state.entries.map((entry) => {
    const parts = entry.path.replaceAll('\\', '/').split('/');
    return parts.length >= 3 ? parts[1] : '';
  })
    .filter(Boolean))].sort();
  $('mappings').innerHTML = folders.length ? `<span class="hint">文件夹语言（可选）：</span>${folders.map((folder) => {
    const selected = state.mappings[folder.toLowerCase()] ?? folderLanguage(`root/${folder}/song.mp3`) ?? '';
    return `<label>${escape(folder)}<select data-folder="${escape(folder)}"><option value="__auto__" ${!selected ? 'selected' : ''}>自动判断</option>${LANGUAGES.filter(([code]) => code).map(([code, label]) => `<option value="${code}" ${selected === code ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`;
  }).join('')}` : '';
}

async function readEntry(file) {
  const { profileId, baseUrl, catalog } = state;
  const mappings = { ...state.mappings };
  const path = file.webkitRelativePath || file.name;
  const identity = fileIdentity(profileId || baseUrl, file);
  const old = manifest[identity] || {};
  let common = {}, duration = '';
  try {
    const data = await parseBlob(file, { duration: true });
    common = data.common || {};
    duration = Number.isFinite(data.format?.duration) ? String(Math.round(data.format.duration)) : '';
  } catch { /* Filename remains available for manual editing. */ }
  const picture = common.picture?.find((item) => COVER_TYPES[(item.format || '').split('/')[1]]);
  const ext = picture?.format?.split('/')[1];
  const coverFile = picture && ext ? new File([picture.data], `cover.${ext}`, { type: picture.format }) : null;
  const folder = folderLanguage(path, mappings);
  const suggested = suggestSongLanguage(common);
  const languageMode = old.languageMode || (old.draft ? 'manual' : folder ? 'folder' : 'suggested');
  const language = languageMode === 'folder' ? folder || suggested.code : suggested.code;
  const draft = old.draft || {
    id: `song_${crypto.randomUUID()}`, title: common.title?.trim() || file.name.replace(/\.[^.]+$/, ''),
    artist: common.artist?.trim() || common.artists?.join('、') || '', album: common.album?.trim() || '',
    duration, language,
  };
  if (old.draft && languageMode !== 'manual') draft.language = language;
  const entry = { file, path, identity, draft, coverFile, languageMode, suggestedLanguage: suggested.code,
    coverPreview: coverFile ? URL.createObjectURL(coverFile) : '',
    audioId: old.audioId || old.audioUrl?.match(/\/([0-9a-f]{16})\.[a-z0-9]+$/)?.[1] || mediaId(),
    coverId: old.coverId || old.coverUrl?.match(/\/([0-9a-f]{16})\.[a-z0-9]+$/)?.[1] || mediaId(),
    audioUrl: old.audioUrl || '', coverUrl: old.coverUrl || '',
    status: old.saved && catalog.some((song) => song.id === (old.savedSongId || draft.id)) ? 'saved' : 'ready',
    savedSongId: old.savedSongId || '', skip: false, selected: false, allowDuplicate: false, replaceTarget: null, reviewStale: false,
    reviewKey: '', currentMatchKey: '', matches: [], message: '', editorOpen: false,
    languageSource: languageMode === 'manual' ? '人工指定' : folder && languageMode === 'folder' ? '文件夹' : suggested.source === 'tag' ? '标签'
      : suggested.source === 'text' ? '文字推测' : '待确认',
  };
  return entry;
}

function upload(file, kind, id, mode, onProgress) {
  return new Promise((resolve, reject) => {
    const extension = file.name.split('.').at(-1)?.toLowerCase();
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/media/${kind}/${id}.${extension}?mode=${mode}`);
    xhr.setRequestHeader('X-Requested-With', 'FlareTuneIngest');
    xhr.setRequestHeader('X-Ingest-CSRF', state.csrf);
    xhr.setRequestHeader('Content-Type', (kind === 'audio' ? AUDIO_TYPES : COVER_TYPES)[extension]);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded, event.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* handled below */ }
      if (xhr.status < 200 || xhr.status >= 300) reject(new Error(data.error || `上传失败（${xhr.status}）`));
      else resolve(data);
    };
    xhr.onerror = () => reject(new Error('本地工具连接中断。'));
    xhr.send(file);
  });
}

async function existingMediaUrl(file, kind, id) {
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  const path = `/media/${kind}/${id}.${extension}`;
  const response = await fetch(`/api${path}`, { method: 'HEAD', credentials: 'same-origin' });
  if (response.status === 204) return '';
  if (!response.ok) throw new Error(`核对已上传媒体失败（${response.status}）。`);
  if (Number(response.headers.get('content-length')) !== file.size) {
    throw new Error('已上传媒体大小与当前文件不一致，请重新选择文件。');
  }
  return path;
}

function showProgress(entry, current, total) {
  $('progress').hidden = false;
  $('progress-text').textContent = `${entry.draft.title} · ${entry.message}`;
  $('progress-number').textContent = `${Math.round(current / total * 100)}%`;
  $('progress-fill').style.width = `${Math.min(100, current / total * 100)}%`;
}

async function runQueue() {
  if (state.running) return;
  state.running = true;
  const queueProfileId = state.profileId;
  const queueCsrf = state.csrf;
  const assertQueueSession = () => {
    if (state.profileId !== queueProfileId || state.csrf !== queueCsrf) throw new Error('实例会话已变化，当前批次已停止。');
  };
  const mode = state.mode;
  state.pause = false;
  $('pause').disabled = false;
  $('pause').textContent = '暂停';
  $('folder').disabled = true;
  $('logout').disabled = true;
  document.querySelectorAll('input[name=mode]').forEach((radio) => { radio.disabled = true; });
  syncR2Form();
  render();
  let completed = 0, failed = 0, skipped = 0;
  try {
    await loadCatalog(); assertQueueSession();
    for (const entry of state.entries) {
      assertQueueSession();
      if (state.pause) break;
      if (entry.status === 'saved' || entry.skip) { skipped += 1; continue; }
      recomputeMatches();
      if (entry.reviewStale || entry.matches.length && !entry.allowDuplicate) {
        entry.message = entry.reviewStale ? '匹配结果已变化，请重新核对。' : '疑似重复，未上传。';
        skipped += 1; render(); continue;
      }
      if (!entry.draft.title.trim()) { entry.status = 'error'; entry.message = '请填写歌名。'; failed += 1; render(); continue; }
      try {
        let replaceTarget = null;
        if (entry.replaceTarget) {
          const match = entry.matches.find((item) => item.source === 'catalog'
            && item.song.id === entry.replaceTarget.id && item.song.version === entry.replaceTarget.version);
          if (!match) throw new Error('替换目标已变化，请重新核对。');
          replaceTarget = (await api(`/api/song/${encodeURIComponent(match.song.id)}`)).song;
          assertQueueSession();
          if (catalogSaveApplied(entry.draft, replaceTarget, { audioUrl: entry.audioUrl,
            coverUrl: entry.coverUrl, hasNewCover: Boolean(entry.coverFile), keepExistingCover: true })) {
            entry.status = 'saved'; entry.savedSongId = replaceTarget.id; entry.message = '已替换曲库歌曲。';
            completed += 1; persist(entry); render(); continue;
          }
          if (!replaceTarget || replaceTarget.version !== match.song.version
            || !compareSongIdentity(entry.draft, replaceTarget)) throw new Error('替换目标已变化，请重新核对。');
        } else {
          const existing = await api(`/api/song/${encodeURIComponent(entry.draft.id)}`);
          assertQueueSession();
          if (existing.song) { entry.status = 'saved'; entry.savedSongId = entry.draft.id;
            entry.message = '已在曲库中。'; completed += 1; persist(entry); render(); continue; }
        }
        if (mode === 'worker' && (entry.file.size > WORKER_MAX_BYTES || entry.coverFile?.size > WORKER_MAX_BYTES)) {
          throw new Error('单文件超过 100 MB，请切换 R2 直传。');
        }
        entry.status = 'uploading'; entry.message = '正在上传音频'; render();
        showProgress(entry, 0, entry.file.size);
        entry.audioUrl = await existingMediaUrl(entry.file, 'audio', entry.audioId);
        assertQueueSession();
        if (!entry.audioUrl) entry.audioUrl = (await upload(entry.file, 'audio', entry.audioId, mode,
          (loaded, total) => showProgress(entry, loaded, total))).url;
        assertQueueSession();
        persist(entry);
        if (entry.coverFile) {
          entry.message = '正在上传封面'; render();
          showProgress(entry, 0, entry.coverFile.size);
          entry.coverUrl = await existingMediaUrl(entry.coverFile, 'cover', entry.coverId);
          assertQueueSession();
          if (!entry.coverUrl) entry.coverUrl = (await upload(entry.coverFile, 'cover', entry.coverId, mode,
            (loaded, total) => showProgress(entry, loaded, total))).url;
          assertQueueSession();
          persist(entry);
        }
        entry.message = '正在保存歌曲信息'; render();
        assertQueueSession();
        const saved = replaceTarget
          ? await api(`/api/song/${encodeURIComponent(replaceTarget.id)}`, { method: 'PUT',
            body: replacementSongBody(entry.draft, replaceTarget, { audioUrl: entry.audioUrl,
              coverUrl: entry.coverUrl, hasNewCover: Boolean(entry.coverFile), keepExistingCover: true }) })
          : await api('/api/song', { method: 'POST', body: catalogSongBody({ ...entry.draft,
            audio_url: entry.audioUrl, cover_url: entry.coverUrl }, true) });
        assertQueueSession();
        entry.status = 'saved'; entry.savedSongId = replaceTarget?.id || entry.draft.id;
        entry.message = replaceTarget ? '已替换曲库歌曲。' : '已加入曲库。'; completed += 1; persist(entry);
        const savedSong = saved.song || { ...entry.draft, id: entry.savedSongId, audio_url: entry.audioUrl,
          cover_url: entry.coverFile ? entry.coverUrl : replaceTarget?.cover_url || entry.coverUrl };
        if (replaceTarget) state.catalog = state.catalog.map((song) => song.id === replaceTarget.id ? savedSong : song);
        else state.catalog.push(savedSong);
        state.catalogDuplicates = catalogDuplicateMatches(state.catalog);
        renderCatalog();
      } catch (error) {
        if (state.profileId !== queueProfileId || state.csrf !== queueCsrf) throw error;
        const recoveryId = entry.replaceTarget?.id || entry.draft.id;
        const existing = await api(`/api/song/${encodeURIComponent(recoveryId)}`).catch(() => null);
        const recovered = entry.replaceTarget
          ? catalogSaveApplied(entry.draft, existing?.song, { audioUrl: entry.audioUrl,
            coverUrl: entry.coverUrl, hasNewCover: Boolean(entry.coverFile), keepExistingCover: true })
          : Boolean(existing?.song);
        if (recovered) { entry.status = 'saved'; entry.savedSongId = recoveryId;
          entry.message = entry.replaceTarget ? '已替换曲库歌曲。' : '已在曲库中。'; completed += 1;
          if (entry.replaceTarget) state.catalog = state.catalog.map((song) => song.id === recoveryId ? existing.song : song);
          state.catalogDuplicates = catalogDuplicateMatches(state.catalog); renderCatalog(); }
        else { entry.status = 'error'; entry.message = error.message; failed += 1;
          if (error.message.includes('替换目标已变化') || error.message.includes('修改')) {
            entry.allowDuplicate = false; entry.replaceTarget = null; entry.reviewStale = true;
          } }
        persist(entry);
      }
      recomputeMatches(); render();
    }
    notice(`本次已入库 ${completed} 首，跳过 ${skipped} 首，失败 ${failed} 首。`);
  } catch (error) { notice(error.message, true); }
  finally {
    state.running = false; $('folder').disabled = false; $('logout').disabled = false; $('progress').hidden = true;
    document.querySelectorAll('input[name=mode]').forEach((radio) => { radio.disabled = false; });
    syncR2Form();
  }
}

function clearWorkspace() {
  if ($('duplicate-dialog').open) closeDuplicateReview();
  state.scanGeneration += 1; state.scanning = false; $('folder').disabled = false;
  state.entries.forEach((entry) => { if (entry.coverPreview) URL.revokeObjectURL(entry.coverPreview); });
  state.entries = []; state.catalog = []; state.catalogDuplicates = new Map(); state.expandedDuplicateIds.clear(); state.mappings = {}; state.r2Ready = false;
  $('r2-state').textContent = ''; $('songs').innerHTML = '<p class="empty">请选择音乐文件夹。</p>';
  $('mappings').innerHTML = ''; $('catalog-search').value = ''; $('catalog-only-duplicates').checked = false; $('search').value = '';
  renderCatalog(); render();
}
async function connectProfile(data) {
  if (state.running) throw new Error('请先等待当前歌曲上传完成并暂停入库。');
  const result = await api('/api/login', { method: 'POST', body: data });
  clearWorkspace();
  state.csrf = result.csrf; state.account = result.account; state.baseUrl = result.profile.baseUrl;
  state.profileId = result.profile.id;
  loadMappings();
  $('current-instance').textContent = `${result.profile.name} · ${result.profile.baseUrl} · ${result.account.username}`;
  $('login-form').elements.password.value = '';
  $('login-panel').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
  setView('catalog'); syncR2Form();
  await loadProfiles(); await loadCatalog();
  notice(result.warning || `已连接 ${result.profile.name}。`, Boolean(result.warning));
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(form));
    data.rememberPassword = form.elements.rememberPassword.checked;
    await connectProfile(data);
  } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
});

$('profiles').addEventListener('click', async (event) => {
  const action = event.target.dataset.profileAction;
  const id = event.target.closest('.profile')?.dataset.id;
  if (!action || !id) return;
  const profile = state.profiles.find((item) => item.id === id);
  if (!profile) return;
  if (action === 'remove') {
    if (!confirm(`删除本机保存的“${profile.name}”配置？不会删除实例中的歌曲。`)) return;
    try { await api(`/api/profiles/${id}`, { method: 'DELETE' }); await loadProfiles(); notice('已删除本机实例配置。'); }
    catch (error) { notice(error.message, true); }
    return;
  }
  $('profile-connect-form').dataset.profileId = id;
  $('profile-connect-form').reset();
  $('profile-connect-form').elements.rememberPassword.checked = profile.savedPassword;
  $('profile-connect-form').elements.password.required = !profile.savedPassword;
  $('profile-connect-summary').textContent = `${profile.name} · ${profile.baseUrl} · ${profile.username}`;
  $('profile-password-hint').textContent = profile.savedPassword
    ? '留空使用已保存的密码；管理员改密后可在这里输入新密码并更新。'
    : '此实例没有保存密码，请输入管理员密码。';
  $('profile-connect-error').hidden = true;
  $('profile-dialog').showModal();
});
$('profile-connect-cancel').addEventListener('click', () => $('profile-dialog').close());
$('profile-connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    await connectProfile({ profileId: form.dataset.profileId, password: form.elements.password.value,
      rememberPassword: form.elements.rememberPassword.checked });
    $('profile-dialog').close();
  } catch (error) {
    $('profile-connect-error').textContent = error.message;
    $('profile-connect-error').hidden = false;
  } finally { button.disabled = false; }
});

$('switch-instance').addEventListener('click', async () => {
  if (state.running) { notice('请先等待当前歌曲上传完成并暂停入库。', true); return; }
  $('login-panel').hidden = false;
  await loadProfiles().catch((error) => notice(error.message, true));
  $('login-panel').scrollIntoView({ behavior: 'smooth' });
});

$('logout').addEventListener('click', async () => {
  if (state.running) { notice('请先等待当前歌曲上传完成并暂停入库。', true); return; }
  try { await api('/api/logout', { method: 'POST' }); }
  catch (error) { notice(`退出失败：${error.message}`, true); return; }
  clearWorkspace(); state.csrf = (await api('/api/state')).csrf; state.account = null; state.profileId = '';
  $('workspace').hidden = true; $('login-panel').hidden = false; $('logout').hidden = true;
  await loadProfiles();
  notice('已退出本地工具。');
});

$('folder').addEventListener('change', async (event) => {
  const files = [...event.target.files].filter((file) => AUDIO_TYPES[file.name.split('.').at(-1)?.toLowerCase()] && file.size);
  if (!files.length) { notice('所选文件夹没有受支持的音频。', true); return; }
  const generation = ++state.scanGeneration;
  state.scanning = true; $('folder').disabled = true;
  state.entries.forEach((entry) => { if (entry.coverPreview) URL.revokeObjectURL(entry.coverPreview); });
  state.entries = [];
  notice(`正在读取 ${files.length} 首音频的标签…`);
  try {
    if (!await loadCatalog() || generation !== state.scanGeneration) return;
    for (const file of files) {
      const entry = await readEntry(file);
      if (generation !== state.scanGeneration) {
        if (entry.coverPreview) URL.revokeObjectURL(entry.coverPreview);
        return;
      }
      state.entries.push(entry); persist(entry);
      if (state.entries.length % 10 === 0) { recomputeMatches(); render(); await new Promise((resolve) => setTimeout(resolve, 0)); }
    }
    if (generation !== state.scanGeneration) return;
    state.scanning = false; recomputeMatches(); renderMappings(); render();
    notice(`已读取 ${files.length} 首音频。请核对语言和疑似重复，再开始入库。`);
  } catch (error) { if (generation === state.scanGeneration) notice(error.message, true); }
  finally {
    if (generation === state.scanGeneration) { state.scanning = false; $('folder').disabled = false; render(); }
    event.target.value = '';
  }
});

$('mappings').addEventListener('change', (event) => {
  const folder = event.target.dataset.folder?.toLowerCase();
  if (!folder) return;
  state.mappings[folder] = event.target.value === '__auto__' ? '' : event.target.value;
  saveMappings();
  for (const entry of state.entries) {
    if (entry.path.replaceAll('\\', '/').split('/')[1]?.toLowerCase() !== folder || entry.status === 'saved' || entry.languageMode === 'manual') continue;
    entry.draft.language = state.mappings[folder] || entry.suggestedLanguage;
    entry.languageMode = state.mappings[folder] ? 'folder' : 'suggested';
    entry.languageSource = state.mappings[folder] ? '文件夹' : '自动判断'; persist(entry);
  }
  render();
});

$('songs').addEventListener('change', (event) => {
  const row = event.target.closest('.song');
  if (!row) return;
  const entry = state.entries[Number(row.dataset.index)];
  if (event.target.dataset.select) { entry.selected = event.target.checked; renderSelection(); return; }
  if (!event.target.dataset.field) return;
  entry.draft[event.target.dataset.field] = event.target.value;
  if (event.target.dataset.field !== 'language') {
    entry.allowDuplicate = false; entry.replaceTarget = null; entry.reviewStale = false;
  }
  else { entry.languageSource = '人工修改'; entry.languageMode = 'manual'; }
  entry.message = ''; persist(entry); recomputeMatches(); render();
});
$('songs').addEventListener('click', (event) => {
  const action = event.target.dataset.action;
  const row = event.target.closest('.song');
  if (!action || !row) return;
  const entry = state.entries[Number(row.dataset.index)];
  if (action === 'edit') entry.editorOpen = !entry.editorOpen;
  if (action === 'skip') entry.skip = !entry.skip;
  if (action === 'review') { openDuplicateReview(Number(row.dataset.index)); return; }
  recomputeMatches(); render();
});
$('duplicate-cancel').addEventListener('click', closeDuplicateReview);
$('duplicate-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeDuplicateReview(); });
$('duplicate-confirm').addEventListener('click', () => {
  const entry = state.entries[state.reviewIndex];
  if (!entry) return;
  const choice = $('duplicate-review').querySelector('input[name="duplicate-choice"]:checked')?.value || 'skip';
  const selected = choice.startsWith('replace:') ? entry.matches.find((match) =>
    match.source === 'catalog' && match.song.id === choice.slice(8) && match.song.version) : null;
  if (choice.startsWith('replace:') && !selected) { notice('替换目标已变化，请重新核对。', true); closeDuplicateReview(); return; }
  entry.allowDuplicate = choice !== 'skip';
  entry.replaceTarget = selected?.song || null;
  entry.reviewStale = choice === 'skip' && !entry.matches.length;
  entry.reviewKey = entry.currentMatchKey;
  entry.message = selected ? `将替换曲库歌曲《${selected.song.title}》。`
    : choice === 'add' ? '将新增另一版本。' : '疑似重复，默认跳过。';
  closeDuplicateReview(); render();
});
$('search').addEventListener('input', render);
$('select-visible').addEventListener('change', (event) => {
  visibleEntries().forEach((entry) => { if (entry.status !== 'saved') entry.selected = event.target.checked; });
  render();
});
$('bulk-language').innerHTML += LANGUAGES.filter(([code]) => code).map(([code, label]) => `<option value="${code}">${label}</option>`).join('');
$('bulk-language').addEventListener('change', renderSelection);
$('apply-language').addEventListener('click', () => {
  const language = $('bulk-language').value;
  if (!language || state.running) return;
  state.entries.filter((entry) => entry.selected && entry.status !== 'saved').forEach((entry) => {
    entry.draft.language = language; entry.languageMode = 'manual'; entry.languageSource = '批量指定'; persist(entry);
  });
  render();
});
$('restore-language').addEventListener('click', () => {
  if (state.running) return;
  state.entries.filter((entry) => entry.selected && entry.status !== 'saved').forEach((entry) => {
    entry.draft.language = entry.suggestedLanguage; entry.languageMode = 'suggested'; entry.languageSource = '自动判断'; persist(entry);
  });
  render();
});
$('start').addEventListener('click', () => void runQueue());
$('pause').addEventListener('click', () => { state.pause = true; $('pause').disabled = true; $('pause').textContent = '当前歌曲完成后暂停'; });
document.querySelectorAll('input[name=mode]').forEach((radio) => radio.addEventListener('change', (event) => {
  state.mode = event.target.value; $('r2-form').hidden = state.mode !== 'direct'; render();
}));
$('r2-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button'); button.disabled = true;
  try {
    if (state.r2Ready) {
      state.r2Ready = false;
      render();
      await api('/api/r2/clear', { method: 'POST' });
      $('r2-state').textContent = '';
      notice('已清除 R2 配置，请重新填写并验证。');
      syncR2Form();
      return;
    }
    const result = await api('/api/r2/config', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
    state.r2Ready = true;
    form.elements.accessKeyId.value = '';
    form.elements.secretAccessKey.value = '';
    $('r2-state').textContent = `已验证 ${result.bucket}/${result.prefix}`;
    notice('R2 直传目标已与播放器实例核对。'); syncR2Form();
  } catch (error) { state.r2Ready = false; $('r2-state').textContent = ''; notice(error.message, true); syncR2Form(); }
  finally { button.disabled = false; }
});

document.querySelectorAll('.tool-nav button').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$('catalog-search').addEventListener('input', () => { state.catalogPage = 1; renderCatalog(); });
$('catalog-only-duplicates').addEventListener('change', () => { state.catalogPage = 1; renderCatalog(); });
$('catalog-refresh').addEventListener('click', () => loadCatalog().catch((error) => notice(error.message, true)));
$('catalog-prev').addEventListener('click', () => { state.catalogPage -= 1; renderCatalog(); });
$('catalog-next').addEventListener('click', () => { state.catalogPage += 1; renderCatalog(); });
$('catalog-form').elements.language.innerHTML = languageOptions('');
$('catalog-songs').addEventListener('click', (event) => {
  const action = event.target.closest('[data-catalog-action]')?.dataset.catalogAction;
  const id = event.target.closest('.catalog-song')?.dataset.id;
  const song = state.catalog.find((item) => item.id === id);
  if (!action || !song) return;
  if (action === 'matches') {
    if (state.expandedDuplicateIds.has(id)) state.expandedDuplicateIds.delete(id);
    else state.expandedDuplicateIds.add(id);
    renderCatalog();
    return;
  }
  state.editing = song;
  if (action === 'edit') {
    $('catalog-id').textContent = `ID: ${song.id}`;
    for (const key of ['title', 'artist', 'album', 'duration', 'language', 'audio_url', 'cover_url']) {
      $('catalog-form').elements[key].value = song[key] ?? '';
    }
    $('catalog-dialog').showModal();
  } else if (action === 'delete') {
    state.deleteGeneration += 1;
    $('delete-summary').textContent = `${song.title} · ${song.artist || '未知歌手'}`;
    $('delete-media').checked = false;
    $('delete-impact').textContent = '正在检查歌单、播放记录和文件引用…';
    $('delete-confirm').disabled = true;
    state.deleteImpact = null;
    $('delete-dialog').showModal();
    refreshDeleteImpact(song).catch((error) => { $('delete-impact').textContent = error.message; notice(error.message, true); });
  }
});
$('catalog-songs').addEventListener('error', (event) => {
  if (event.target.tagName !== 'IMG') return;
  event.target.hidden = true;
  event.target.nextElementSibling.hidden = false;
}, true);
$('catalog-cancel').addEventListener('click', () => $('catalog-dialog').close());
$('delete-cancel').addEventListener('click', () => $('delete-dialog').close());
$('delete-dialog').addEventListener('close', () => { state.deleteGeneration += 1; state.deleteImpact = null; });
$('catalog-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const song = state.editing;
  if (!song) return;
  const form = event.currentTarget;
  const button = form.querySelector('button[type=submit], button.primary');
  button.disabled = true;
  try {
    const draft = Object.fromEntries(new FormData(form));
    const payload = { ...catalogSongBody(draft, false), audio_url: draft.audio_url.trim() || null,
      expectedVersion: song.version };
    await api(`/api/song/${encodeURIComponent(song.id)}`, { method: 'PUT', body: payload });
    $('catalog-dialog').close();
    await loadCatalog(); notice(`已更新《${draft.title}》。`);
  } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
});
$('delete-confirm').addEventListener('click', async () => {
  const song = state.editing;
  const impact = state.deleteImpact;
  if (!song || !impact) return;
  $('delete-confirm').disabled = true;
  const deleteMedia = $('delete-media').checked;
  try {
    const result = await api(`/api/song/${encodeURIComponent(song.id)}/delete-with-impact`, {
      method: 'POST', body: { impactDigest: impact.impact_digest, deleteMedia },
    });
    if (result.status === 409) {
      state.deleteImpact = null;
      $('delete-confirm').disabled = true;
      await refreshDeleteImpact(song);
      notice('删除影响已变化，请重新核对后再确认。', true);
      return;
    }
    if (result.data?.deleted_ids?.includes(song.id)) {
      $('delete-dialog').close();
      state.deleteImpact = null;
      await loadCatalog();
      const failures = result.data.media?.failures || [];
      const failed = failures.length;
      const pendingLyricIds = result.data.lyric_cleanup?.pending_song_ids || [];
      const pendingLyricObjects = result.data.lyric_cleanup?.pending_objects || [];
      const pendingLyrics = pendingLyricIds.length;
      notice(failed || pendingLyrics
        ? `《${song.title}》已从曲库和关联记录中删除；${failed ? `文件清理失败：${failures.map((item) => item.path).join('、')}` : ''}${pendingLyrics ? `；歌词文件清理待重试：${pendingLyricObjects.map((item) => item.object_key).join('、') || pendingLyricIds.join('、')}` : ''}。`
        : `已删除《${song.title}》及其关联记录。${deleteMedia ? `清理了 ${result.data.media?.deleted?.length || 0} 个专属文件。` : '音频和封面文件已保留。'}`,
      Boolean(failed || pendingLyrics));
      return;
    }
    throw new Error(result.message || `删除失败（${result.status}）。`);
  } catch (error) {
    try {
      const current = await api(`/api/song/${encodeURIComponent(song.id)}`);
      if (!current.song) {
        $('delete-dialog').close();
        state.deleteImpact = null;
        await loadCatalog();
        const paths = deleteMedia ? (impact.media || []).filter((item) => item.can_delete).map((item) => item.path) : [];
        notice(`《${song.title}》已不在曲库中，但删除回执未能确认；文件清理状态未知${paths.length ? `，请核对：${paths.join('、')}` : ''}。`, true);
        return;
      }
    } catch { /* Keep the previous preview available when the instance cannot be checked. */ }
    notice(error.message, true);
  }
  finally { if (state.deleteImpact) $('delete-confirm').disabled = false; }
});

api('/api/state').then(async (result) => {
  state.csrf = result.csrf;
  await loadProfiles();
  if (!result.loggedIn) return;
  state.account = result.account; state.baseUrl = result.baseUrl; state.profileId = result.profileId;
  loadMappings();
  if (result.r2Ready) await api('/api/r2/clear', { method: 'POST' });
  state.r2Ready = false;
  const profile = state.profiles.find((item) => item.id === result.profileId);
  $('current-instance').textContent = `${profile?.name || '当前实例'} · ${result.baseUrl} · ${result.account.username}`;
  $('login-panel').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
  $('r2-state').textContent = '';
  setView('catalog');
  syncR2Form();
  await loadCatalog();
}).catch((error) => notice(error.message, true));
