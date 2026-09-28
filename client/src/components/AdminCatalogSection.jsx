import React from 'react';
import { createPortal } from 'react-dom';
import {
  Music,
  Search,
  X,
  Edit3,
  Trash2,
  Upload,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Check,
  Disc,
} from 'lucide-react';
import { ALL_LANGUAGES, getLanguageLabel } from '../constants/language.js';
import { createLatestRequest } from '../utils/latestRequest.js';
import { formatDuration, resolveCoverUrl } from '../utils.js';
import { catalogSongBody } from '../utils/catalogSongDraft.js';
import {
  deleteCatalogSong,
  getCatalogSong,
  listCatalogSongs,
  updateCatalogSong,
  uploadCatalogMedia,
} from '../services/catalogAdminApi.js';

const blankSong = { id: '', title: '', artist: '', album: '', duration: '', language: '', audio_url: '', cover_url: '' };

export default function AdminCatalogSection() {
  const [page, setPage] = React.useState(1);
  const [query, setQuery] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [list, setList] = React.useState({ songs: [], total: 0, limit: 30 });
  const [editor, setEditor] = React.useState(null); // { version, draft }
  const [itemToDelete, setItemToDelete] = React.useState(null); // song
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [uploadNotice, setUploadNotice] = React.useState('');

  const listRequest = React.useRef(createLatestRequest());
  const editRequest = React.useRef(createLatestRequest());
  const editorRef = React.useRef(null);
  const busyRef = React.useRef(busy);
  busyRef.current = busy;
  const emptyList = () => ({ songs: [], total: 0, limit: 30 });

  function invalidateList() {
    listRequest.current.invalidate();
    setList(emptyList());
    setLoading(true);
  }

  const load = React.useCallback(async () => {
    const isCurrent = listRequest.current.begin();
    setLoading(true);
    try {
      const result = await listCatalogSongs({ page, q: search });
      if (isCurrent()) setList(result);
    } catch (error) {
      if (isCurrent()) setMessage(error.message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [page, search]);

  React.useEffect(() => {
    void load();
    return () => { listRequest.current.invalidate(); };
  }, [load]);

  React.useEffect(() => () => { editRequest.current.invalidate(); }, []);

  // Escape key closes editor drawer
  React.useEffect(() => {
    if (!editor) return undefined;
    const focusFrame = requestAnimationFrame(() => editorRef.current?.querySelector('input:not([type="file"])')?.focus());
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !busyRef.current) {
        editRequest.current.invalidate();
        setEditor(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => { cancelAnimationFrame(focusFrame); window.removeEventListener('keydown', handleKeyDown); };
  }, [Boolean(editor)]);

  async function openEdit(item) {
    const isCurrent = editRequest.current.begin();
    setBusy(true);
    setMessage('');
    setUploadNotice('');
    try {
      const detail = (await getCatalogSong(item.id)).song;
      if (!isCurrent()) return;
      setEditor({
        version: detail.version,
        draft: Object.fromEntries(Object.entries(blankSong).map(([key]) => [key, detail[key] ?? ''])),
      });
    } catch (error) {
      if (isCurrent()) setMessage(error.message);
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  async function handleSave(event) {
    event.preventDefault();
    if (!editor) return;
    setBusy(true);
    setMessage('');
    try {
      const { draft } = editor;
      const value = catalogSongBody(draft, false);
      await updateCatalogSong(draft.id, { ...value, expectedVersion: editor.version });
      setEditor(null);
      setMessage('歌曲已成功保存到曲库。');
      await load();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!itemToDelete) return;
    const item = itemToDelete;
    const label = `歌曲「${item.title}」`;
    setBusy(true);
    setMessage('');
    try {
      await deleteCatalogSong(item.id, item.version);
      setMessage(`${label}元数据已删除；关联媒体文件已安全保留。`);
      setItemToDelete(null);
      await load();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleUpload(kindToUpload, file) {
    if (!file) return;
    setBusy(true);
    setUploadNotice('正在上传媒体资源…');
    try {
      const result = await uploadCatalogMedia(kindToUpload, file);
      setEditor((current) => current && ({
        ...current,
        draft: {
          ...current.draft,
          [kindToUpload === 'audio' ? 'audio_url' : 'cover_url']: result.url,
        },
      }));
      setUploadNotice(`文件上传成功！请点击底部「保存」以写入曲库。`);
    } catch (error) {
      setUploadNotice(`上传失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  const items = list.songs || [];
  const pages = Math.max(1, Math.ceil((list.total || 0) / (list.limit || 30)));
  const setDraft = (key, value) => setEditor((current) => current && ({ ...current, draft: { ...current.draft, [key]: value } }));

  return (
    <div className="admin-catalog space-y-6">
      {/* 顶部标题 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-[var(--ink)] flex items-center gap-2">
            <Disc className="text-[var(--accent)]" size={20} />
            <span>曲库数据管理</span>
          </h2>
        </div>

      </div>

      {/* 分类切换与搜索栏 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <span className="text-xs font-semibold text-[var(--muted)]">单曲 ({list.total || 0})</span>

        {/* 搜索框 */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            invalidateList();
            setPage(1);
            setSearch(query.trim());
            if (page === 1 && search === query.trim()) void load();
          }}
          className="relative flex-1 max-w-xs"
        >
          <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--muted)] pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题、歌手或专辑…"
            className="w-full pl-9 pr-8 py-2 rounded-xl border border-[var(--line)] bg-[var(--surface)] text-xs text-[var(--ink)] placeholder:text-[var(--muted)] focus:outline-none focus:border-[var(--accent)]"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setSearch('');
                invalidateList();
                setPage(1);
              }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer"
            >
              <X size={13} />
            </button>
          )}
        </form>
      </div>

      {/* 消息提示 */}
      {message && (
        <div
          role="status"
          className="rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] p-4 text-xs text-[var(--ink)] flex items-center justify-between gap-3"
        >
          <span>{message}</span>
          <button type="button" onClick={() => setMessage('')} className="text-[var(--muted)] hover:text-[var(--ink)]">
            <X size={14} />
          </button>
        </div>
      )}

      {/* 内联删除确认卡片（替代原生 window.confirm 弹窗） */}
      {itemToDelete && (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-rose-600 dark:text-rose-400">
          <div className="flex items-center gap-2.5">
            <AlertTriangle size={16} className="shrink-0" />
            <span>
              确定删除<strong>「{itemToDelete.title}」</strong>的元数据？媒体文件会保留，存在引用时删除会被拒绝。
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
            <button
              type="button"
              onClick={() => setItemToDelete(null)}
              className="px-3 py-1.5 rounded-xl border border-[var(--line)] text-xs text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer bg-[var(--surface)]"
            >
              取消
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={confirmDelete}
              className="px-3.5 py-1.5 rounded-xl bg-rose-600 text-white text-xs font-semibold hover:bg-rose-500 cursor-pointer shadow-xs"
            >
              {busy ? '正在删除…' : '确认删除'}
            </button>
          </div>
        </div>
      )}

      {/* 数据列表 */}
      <div className="wallpaper-content-surface rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] overflow-hidden shadow-xs">
        {loading ? (
          <div className="py-16 text-center text-xs text-[var(--muted)]">正在加载曲库数据…</div>
        ) : items.length === 0 ? (
          <div className="py-16 text-center text-xs text-[var(--muted)] space-y-2">
            <p>暂无符合条件的歌曲</p>
            {search && (
              <button
                type="button"
                onClick={() => { setQuery(''); setSearch(''); invalidateList(); }}
                className="text-[var(--accent)] underline hover:opacity-80"
              >
                清除搜索条件
              </button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-[var(--line)]">
            {items.map((item) => {
              const cover = resolveCoverUrl(item.cover_url);
              return (
                <div
                  key={item.id}
                  className="flex items-center justify-between p-3.5 sm:p-4 hover:bg-current/3 transition-colors gap-3"
                >
                  {/* 左侧：封面与元信息 */}
                  <div className="flex items-center gap-3.5 min-w-0">
                    <div className="w-10 h-10 rounded-xl overflow-hidden bg-[var(--surface)] border border-[var(--line)] shrink-0 flex items-center justify-center">
                      {cover ? (
                        <img src={cover} alt="" className="w-full h-full object-cover" loading="lazy" />
                      ) : (
                        <Music size={16} className="text-[var(--muted)]" />
                      )}
                    </div>
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <strong className="text-xs font-bold text-[var(--ink)] truncate max-w-[200px] sm:max-w-xs">
                          {item.title}
                        </strong>
                        {item.language && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-purple-500/10 text-purple-600 dark:text-purple-400 font-medium">
                            {getLanguageLabel(item.language)}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-[var(--muted)] truncate">
                        {`${item.artist || '未知歌手'} · ${item.album || '无专辑'} · ${formatDuration(item.duration) || '时长未知'}`}
                      </p>
                    </div>
                  </div>

                  {/* 右侧：管理操作 */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void openEdit(item)}
                      className="p-2 text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface)] rounded-xl transition-colors cursor-pointer"
                      title="编辑"
                      aria-label="编辑"
                    >
                      <Edit3 size={15} />
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setItemToDelete(item)}
                      className="p-2 text-[var(--muted)] hover:text-rose-500 hover:bg-rose-500/10 rounded-xl transition-colors cursor-pointer"
                      title="删除"
                      aria-label="删除"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 分页控制栏 */}
      {items.length > 0 && (
        <div className="flex items-center justify-between text-xs text-[var(--muted)] pt-1">
          <span>共 {list.total || 0} 项 · 第 {page} / {pages} 页</span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={page <= 1 || loading || busy}
              onClick={() => { invalidateList(); setPage(page - 1); }}
              className="p-1.5 rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] hover:bg-[var(--surface)] disabled:opacity-30 cursor-pointer"
              title="上一页"
            >
              <ChevronLeft size={15} />
            </button>
            <span className="px-2 font-mono text-[var(--ink)]">{page}</span>
            <button
              type="button"
              disabled={page >= pages || loading || busy}
              onClick={() => { invalidateList(); setPage(page + 1); }}
              className="p-1.5 rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] hover:bg-[var(--surface)] disabled:opacity-30 cursor-pointer"
              title="下一页"
            >
              <ChevronRight size={15} />
            </button>
          </div>
        </div>
      )}

      {/* 编辑歌曲弹窗 */}
      {editor && createPortal(
        <>
          {/* 背景半透明浅遮罩 */}
          <div
            className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-xs transition-opacity animate-[fade-in_0.2s_ease-out]"
            onClick={() => { if (!busy) { editRequest.current.invalidate(); setEditor(null); } }}
          />

          <section
            ref={editorRef}
            className="fixed left-1/2 top-1/2 z-[101] flex max-h-[min(88dvh,760px)] w-[min(92vw,620px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="编辑歌曲"
          >
          {/* 弹窗顶栏 */}
            <div className="p-5 border-b border-[var(--line)] flex items-center justify-between shrink-0 bg-[var(--surface-raised)]">
              <div>
                <h3 className="text-base font-bold text-[var(--ink)]">
                  编辑歌曲
                </h3>
                <p className="text-[11px] text-[var(--muted)] mt-0.5">
                  修改后点击下方「保存到曲库」即可同步。
                </p>
              </div>
              <button
                type="button"
                onClick={() => { editRequest.current.invalidate(); setEditor(null); }}
                disabled={busy}
                className="p-2 text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface)] rounded-xl transition-colors cursor-pointer"
                aria-label="关闭编辑"
              >
                <X size={18} />
              </button>
            </div>

            {/* 弹窗表单主体 */}
            <form onSubmit={handleSave} className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-5 custom-scrollbar">
              {/* 歌曲特有字段 */}
              {(
                <>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-[var(--ink)]">
                      歌曲标题<span className="text-rose-500 ml-1">*</span>
                    </label>
                    <input
                      type="text"
                      required
                      value={editor.draft.title || ''}
                      onChange={(e) => setDraft('title', e.target.value)}
                      placeholder="歌曲名称"
                      className="w-full px-3.5 py-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface)] text-xs text-[var(--ink)] placeholder:text-[var(--muted)] focus:outline-none focus:border-[var(--accent)]"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3.5">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-[var(--ink)]">歌手</label>
                      <input
                        type="text"
                        value={editor.draft.artist || ''}
                        onChange={(e) => setDraft('artist', e.target.value)}
                        placeholder="主要艺术家"
                        className="w-full px-3.5 py-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface)] text-xs text-[var(--ink)] placeholder:text-[var(--muted)] focus:outline-none focus:border-[var(--accent)]"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-[var(--ink)]">专辑</label>
                      <input
                        type="text"
                        value={editor.draft.album || ''}
                        onChange={(e) => setDraft('album', e.target.value)}
                        placeholder="所属专辑名称"
                        className="w-full px-3.5 py-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface)] text-xs text-[var(--ink)] placeholder:text-[var(--muted)] focus:outline-none focus:border-[var(--accent)]"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3.5">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-[var(--ink)]">时长（秒）</label>
                      <input
                        type="number"
                        min="0"
                        value={editor.draft.duration || ''}
                        onChange={(e) => setDraft('duration', e.target.value)}
                        placeholder="如 215"
                        className="w-full px-3.5 py-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface)] text-xs text-[var(--ink)] placeholder:text-[var(--muted)] focus:outline-none focus:border-[var(--accent)] font-mono"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-[var(--ink)]">歌曲语言</label>
                      <select
                        value={editor.draft.language || ''}
                        onChange={(e) => setDraft('language', e.target.value)}
                        className="w-full px-3.5 py-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface)] text-xs text-[var(--ink)] focus:outline-none focus:border-[var(--accent)]"
                      >
                        <option value="">未设置</option>
                        {ALL_LANGUAGES.map(({ code, label }) => (
                          <option key={code} value={code}>{label}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                </>
              )}

              {/* 封面地址与上传 */}
              <div className="space-y-2 pt-2 border-t border-[var(--line)]">
                <label className="block text-xs font-semibold text-[var(--ink)]">封面图片</label>
                <div className="flex items-start gap-3">
                  {editor.draft.cover_url ? (
                    <img
                      src={resolveCoverUrl(editor.draft.cover_url)}
                      alt="预览"
                      className="w-14 h-14 rounded-xl object-cover border border-[var(--line)] shrink-0 bg-[var(--surface)]"
                    />
                  ) : (
                    <div className="w-14 h-14 rounded-xl border border-dashed border-[var(--line)] flex items-center justify-center shrink-0 text-[var(--muted)] bg-[var(--surface)]">
                      <Disc size={20} />
                    </div>
                  )}
                  <div className="flex-1 space-y-2">
                    <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-[var(--line)] bg-[var(--surface)] text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer transition-colors">
                      <Upload size={13} />
                      <span>{editor.draft.cover_url ? '替换封面' : '上传封面'}</span>
                      <input
                        type="file"
                        accept=".jpg,.jpeg,.png,.webp"
                        disabled={busy}
                        className="hidden"
                        onChange={(e) => {
                          void handleUpload('cover', e.target.files?.[0]);
                          e.target.value = '';
                        }}
                      />
                    </label>
                  </div>
                </div>
              </div>

              {/* 上传反馈 */}
              {uploadNotice && (
                <div className="text-[11px] px-3 py-2 rounded-xl bg-[var(--surface)] border border-[var(--line)] text-[var(--accent)]">
                  {uploadNotice}
                </div>
              )}
              {message && <div role="alert" className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--ink)]">{message}</div>}

              {/* 底部提交栏 */}
              <div className="pt-4 border-t border-[var(--line)] flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => { editRequest.current.invalidate(); setEditor(null); }}
                  disabled={busy}
                  className="px-4 py-2 rounded-xl border border-[var(--line)] text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="primary-button px-5 py-2 rounded-xl text-xs font-semibold cursor-pointer shadow-xs"
                >
                  {busy ? '正在处理…' : '保存到曲库'}
                </button>
              </div>
            </form>
          </section>
        </>, document.body
      )}
    </div>
  );
}
