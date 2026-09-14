import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { SSHInfo, FileItem } from '../types';
import { apiFetch, apiUrl } from '../api';
import { SftpWSClient } from '../sftpClient';
import {
  Folder,
  File,
  FileCode,
  FileText,
  FileArchive,
  Image,
  Upload,
  FolderPlus,
  RefreshCw,
  Loader2,
  Download,
  Trash2,
  ChevronRight,
  Home,
  Search,
  Check,
  X,
  AlertCircle,
  FileUp,
  TextCursorInput,
  FolderInput,
  Copy,
  EllipsisVertical,
  ArrowUp,
} from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';

interface SFTPViewProps {
  sshInfo: SSHInfo;
  sessionId?: string;
  initialPath?: string;
  onPathChange?: (path: string) => void;
  theme?: string;
  isVisible?: boolean;
}

type PathActionMode = 'rename' | 'move' | 'copy';
type DirPickerMode = 'move' | 'copy';
// 表格按容器宽度分档：compact 只留 Name + ⋮，medium（手机全屏）加 Size，wide（PC）再加 Modified
type TableLayout = 'compact' | 'medium' | 'wide';

const PATH_ACTION_LABEL: Record<PathActionMode, string> = {
  rename: 'Rename',
  move: 'Move to…',
  copy: 'Copy to…',
};

const parentPathOf = (p: string) => p.substring(0, p.lastIndexOf('/')) || '/';

export const SFTPView: React.FC<SFTPViewProps> = ({ sshInfo, sessionId, initialPath, onPathChange, theme, isVisible = true }) => {
  const isLight = theme === 'light';
  const defaultHome = sshInfo.username && sshInfo.username !== 'root' ? `/home/${sshInfo.username}` : '/root';
  const [currentPath, setCurrentPath] = useState<string>(initialPath || defaultHome);
  const [pathInput, setPathInput] = useState<string>(initialPath || defaultHome);
  const [fileList, setFileList] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  // 正在打开的目标目录：用来在那行显示转圈，并挡住重复点击
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  // loading 持续超过 150ms 才铺遮罩 —— 局域网里 list 常常几十毫秒，不然会闪一下
  const [busy, setBusy] = useState<boolean>(false);
  const loadingRef = useRef<boolean>(false);
  // 「刚加载过哪个目录」的账本，key = sessionId + path，用来掐掉一次自触发回环：
  // fetchFileList 成功后会 onPathChange 把路径写回父组件，父组件又把 initialPath 传回来，
  // 于是下面那个依赖 initialPath 的 effect 会再拉一次列表 —— 进一次目录发两次 list 请求，
  // 遮罩和刷新图标就闪两下。key 里带上 sessionId，换连接时即使路径没变也必须重新拉。
  const lastListKeyRef = useRef<string | null>(null);
  // 已经上报给父组件的路径：值没变就不再回调，省掉父组件整棵树的无效重渲染
  const reportedPathRef = useRef<string | null>(initialPath ?? null);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState<string>('');

  // Modals state
  const [mkdirModalOpen, setMkdirModalOpen] = useState<boolean>(false);
  const [newDirName, setNewDirName] = useState<string>('');

  const [editorModalOpen, setEditorModalOpen] = useState<boolean>(false);
  const [editingFilePath, setEditingFilePath] = useState<string>('');
  const [editingContent, setEditingContent] = useState<string>('');
  const [savingFile, setSavingFile] = useState<boolean>(false);

  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [pendingDeleteItem, setPendingDeleteItem] = useState<FileItem | null>(null);

  // 行内「⋮」菜单：Rename / Move to… / Copy to… / Delete 都收在这里
  const [menuItem, setMenuItem] = useState<FileItem | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  // 重命名：不弹窗，直接在列表行下方展开输入框
  const [renaming, setRenaming] = useState<FileItem | null>(null);
  const [renameInput, setRenameInput] = useState<string>('');
  const [renameBusy, setRenameBusy] = useState<boolean>(false);

  // 移动 / 复制：弹窗选目标目录
  const [dirPicker, setDirPicker] = useState<{ mode: DirPickerMode; item: FileItem } | null>(null);
  const [pickerPath, setPickerPath] = useState<string>('');
  const [pickerPathInput, setPickerPathInput] = useState<string>('');
  const [pickerDirs, setPickerDirs] = useState<FileItem[]>([]);
  const [pickerLoading, setPickerLoading] = useState<boolean>(false);
  const [pickerBusy, setPickerBusy] = useState<boolean>(false);
  const [pickerError, setPickerError] = useState<string | null>(null);

  const sftpRef = useRef<SftpWSClient | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const SFTP_CLOSE_DELAY_MS = 30000;

  // 表格列数由**容器实际宽度**决定，而不是视口断点。
  // 这个面板在 split view 下只占半屏：768px 的窗口里面板可能只有 ~384px，
  // 手机分屏时甚至不到 200px —— 用 `sm:` 这类视口断点会误判成「够宽」，
  // 照样渲染 Size / Modified 列，把 Name 挤到 0 宽：单元格只剩 padding，
  // 内部 flex 里的 <span> 因 min-width:auto 不肯收缩，文件名会直接画到 Size 列上（重叠）。
  //
  // 所以分三档，阈值取容器宽度而非视口：
  //   compact  < 360px : Name + ⋮ —— 手机半屏，行内不显示大小与时间
  //   medium   < 512px : Name + Size + ⋮ —— 手机全屏，能看大小，但不放「时间」这种固定宽列
  //   wide    >= 512px : Name + Size + Modified + ⋮ —— PC 正常显示
  // 「时间」列只在 PC 出现：430px 的容器里时间(144)+大小(80)+⋮(44) 会把文件名压到只剩几十像素。
  // 手机端要看时间/大小的完整值，去 ⋮ 菜单头部（两行分列）。
  // 另外 colSpan 必须与真实列数一致 —— 否则 <td colSpan={tableCols}> 会在表格里凭空多出
  // 一个「幽灵列」，table-fixed 下它会和 Name 平分剩余宽度（实测白吃 92px）。
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const [tableLayout, setTableLayout] = useState<TableLayout>('medium');
  useLayoutEffect(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    const sync = () => {
      const w = el.clientWidth;
      setTableLayout(w < 360 ? 'compact' : w < 512 ? 'medium' : 'wide');
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const isWide = tableLayout === 'wide';
  const showSize = tableLayout !== 'compact';
  const showModified = isWide;
  const tableCols = 2 + (showSize ? 1 : 0) + (showModified ? 1 : 0);
  const ensureSftp = async () => {
    if (!sessionId) throw new Error('No sessionId');
    // 切回可见时取消延迟关闭
    if (closeTimerRef.current !== null) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
    if (sftpRef.current) {
      try { await sftpRef.current.connect(); return sftpRef.current; } catch {}
    }
    const c = new SftpWSClient(sessionId);
    await c.connect();
    sftpRef.current = c;
    return c;
  };
  useEffect(() => {
    // sessionId 变化或卸载立即关闭，清理延迟定时器
    return () => {
      if (closeTimerRef.current !== null) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
      sftpRef.current?.close(); sftpRef.current = null;
    };
  }, [sessionId]);
  useEffect(() => {
    if (!isVisible) {
      // 延迟关闭，避免频繁切换时重建
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = window.setTimeout(() => {
        sftpRef.current?.close(); sftpRef.current = null; closeTimerRef.current = null;
      }, SFTP_CLOSE_DELAY_MS);
    } else {
      if (closeTimerRef.current !== null) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
    }
    return () => { if (closeTimerRef.current !== null) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null; } };
  }, [isVisible]);

  const listKey = (p: string) => `${sessionId ?? ''}\u0000${p}`;
  // 请求序号：交叠的 list 只认最后一次 —— 否则旧请求先回来会把新请求的 loading 提前关掉，
  // 遮罩就「灭一下又亮」再灭，看着就是闪；也可能用过期列表盖掉新目录。
  const reqSeqRef = useRef(0);

  const fetchFileList = async (dirPath: string) => {
    const reqId = ++reqSeqRef.current;
    // 先记账再发请求：StrictMode 下 effect 会连着跑两遍，第二遍会被 effect 里的
    // 「同一个 key 就跳过」挡掉，dev 里不会再重复拉一次。
    lastListKeyRef.current = listKey(dirPath);
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const c = await ensureSftp();
      const data = await c.request('list', { path: dirPath });
      if (reqId !== reqSeqRef.current) return; // 已被更新的请求取代，丢弃
      // 服务端可能把路径规范化（相对路径 / 结尾斜杠），以返回值为准记账
      lastListKeyRef.current = listKey(data.path);
      setCurrentPath(data.path);
      setPathInput(data.path);
      setFileList(data.list || []);
      if (reportedPathRef.current !== data.path) {
        reportedPathRef.current = data.path;
        onPathChange?.(data.path);
      }
    } catch (err: any) {
      if (reqId !== reqSeqRef.current) return;
      setError(err.message || 'Error connecting to SFTP server');
    } finally {
      // 只有最后一次请求才有资格收尾，否则会提前把遮罩收掉
      if (reqId === reqSeqRef.current) {
        loadingRef.current = false;
        setLoading(false);
        setOpeningPath(null);
      }
    }
  };

  // 遮罩延迟出现：loading 一结束就取消定时器，短请求不会闪
  useEffect(() => {
    if (!loading) {
      setBusy(false);
      return;
    }
    const t = window.setTimeout(() => setBusy(true), 150);
    return () => window.clearTimeout(t);
  }, [loading]);

  useEffect(() => {
    const target = initialPath || '';
    // 这个 effect 只负责「外部要求换目录」（首挂载 / 换连接 / 父组件指定路径）。
    // 我们自己刚加载过的路径要跳过 —— 否则进目录会连发两次 list，页面闪两下。
    if (lastListKeyRef.current === listKey(target)) return;
    fetchFileList(target);
  }, [sshInfo, sessionId, initialPath]);

  const handleNavigate = (path: string) => {
    // 同步挡重复点击：setState 是异步的，连点两下时 loading 状态还没更新，
    // 光靠 disabled 挡不住，会把同一个 list 请求叠发出两次。
    if (loadingRef.current) return;
    setOpeningPath(path);
    fetchFileList(path);
  };

  const handleItemClick = (item: FileItem) => {
    if (loadingRef.current) return;
    if (item.isDir) {
      const nextPath = currentPath.endsWith('/')
        ? `${currentPath}${item.name}`
        : `${currentPath}/${item.name}`;
      handleNavigate(nextPath);
    } else {
      // Open editor for text files
      openEditor(item.name);
    }
  };

  const handleDownload = (item: FileItem) => {
    const filePath = currentPath.endsWith('/')
      ? `${currentPath}${item.name}`
      : `${currentPath}/${item.name}`;
    const downloadUrl = apiUrl(`/file/download?sessionId=${encodeURIComponent(sessionId || '')}&path=${encodeURIComponent(filePath)}`);
    window.open(downloadUrl, '_blank');
  };

  const executeDelete = async (item: FileItem) => {
    const itemPath = currentPath.endsWith('/') ? `${currentPath}${item.name}` : `${currentPath}/${item.name}`;
    try {
      const c = await ensureSftp();
      await c.request('delete', { path: itemPath, isDir: item.isDir });
      fetchFileList(currentPath);
    } catch (err: any) {
      alert('Delete failed: ' + (err.message || 'unknown error'));
    }
  };

  const handleDelete = (item: FileItem) => {
    setPendingDeleteItem(item);
  };

  const confirmDelete = () => {
    if (!pendingDeleteItem) return;
    const item = pendingDeleteItem;
    setPendingDeleteItem(null);
    executeDelete(item);
  };

  const itemFullPath = (item: FileItem) =>
    currentPath.endsWith('/') ? `${currentPath}${item.name}` : `${currentPath}/${item.name}`;

  // 把用户输入的 `~` 展开成家目录，跟本文件其它地方对 `~` 的处理保持一致
  const expandHome = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '~') return defaultHome;
    if (trimmed.startsWith('~/')) return `${defaultHome}${trimmed.slice(1)}`;
    return trimmed;
  };

  // 重命名目标：同目录换名
  const resolveRenameTarget = (item: FileItem, source: string) => {
    const parent = source.substring(0, source.lastIndexOf('/'));
    return `${parent}/${renameInput.trim().replace(/^\/+/, '')}`;
  };

  // ---- 行内「⋮」菜单 ----
  const closeMenu = () => {
    setMenuItem(null);
    setMenuPos(null);
  };

  const openMenu = (e: React.MouseEvent<HTMLButtonElement>, item: FileItem) => {
    e.stopPropagation();
    if (menuItem === item) return closeMenu();
    // 菜单用 fixed 定位：表格容器是 overflow-y-auto，absolute 会被裁切
    const rect = e.currentTarget.getBoundingClientRect();
    const MENU_W = 176;
    // 菜单项：名称 + 大小/时间两行的头部 + Download(文件) + Rename/Move/Copy/分隔线/Delete
    const MENU_H = 236;
    const left = Math.max(8, Math.min(rect.right - MENU_W, window.innerWidth - MENU_W - 8));
    const below = rect.bottom + 4;
    const top = below + MENU_H > window.innerHeight - 8 ? Math.max(8, rect.top - MENU_H - 4) : below;
    setMenuPos({ top, left });
    setMenuItem(item);
  };

  // 菜单开着时，滚动 / 缩放 / Esc 都收起
  useEffect(() => {
    if (!menuItem) return;
    const onScrollOrResize = () => closeMenu();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuItem]);

  const startRename = (item: FileItem) => {
    closeMenu();
    setRenameInput(item.name);
    setRenaming(item);
  };

  const submitRename = async () => {
    if (!renaming || renameBusy) return;
    const name = renameInput.trim();
    if (!name) return;
    if (name.includes('/')) {
      alert('A file name cannot contain "/".');
      return;
    }
    const source = itemFullPath(renaming);
    const target = resolveRenameTarget(renaming, source);
    if (target === source) {
      setRenaming(null);
      return;
    }
    setRenameBusy(true);
    try {
      const c = await ensureSftp();
      await c.request('rename', { path: source, to: target, isDir: renaming.isDir });
      setRenaming(null);
      fetchFileList(currentPath);
    } catch (err: any) {
      alert(`${PATH_ACTION_LABEL.rename} failed: ${err.message || 'unknown error'}`);
    } finally {
      setRenameBusy(false);
    }
  };

  // ---- 移动 / 复制：目录选择弹窗 ----
  const loadPickerDir = async (path: string) => {
    setPickerLoading(true);
    setPickerError(null);
    try {
      const c = await ensureSftp();
      const data = await c.request('list', { path: expandHome(path) });
      setPickerPath(data.path);
      setPickerPathInput(data.path);
      setPickerDirs(((data.list || []) as FileItem[]).filter((it) => it.isDir));
    } catch (err: any) {
      setPickerError(err.message || 'Failed to list directory');
    } finally {
      setPickerLoading(false);
    }
  };

  const openDirPicker = (mode: DirPickerMode, item: FileItem) => {
    closeMenu();
    setDirPicker({ mode, item });
    setPickerDirs([]);
    setPickerError(null);
    loadPickerDir(currentPath);
  };

  // 目录不能移进/复制进自己或自己的子目录
  const pickerDirIsInvalid = (dir: string) => {
    if (!dirPicker?.item.isDir) return false;
    const source = itemFullPath(dirPicker.item).replace(/\/+$/, '');
    const clean = dir.replace(/\/+$/, '') || '/';
    return clean === source || clean.startsWith(`${source}/`);
  };

  const joinPath = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`;

  const pickerTarget = () => (dirPicker ? joinPath(pickerPath, dirPicker.item.name) : '');

  const pickerTargetInvalid = dirPicker ? pickerDirIsInvalid(pickerPath) : false;

  // Esc 关闭目录选择弹窗
  useEffect(() => {
    if (!dirPicker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDirPicker(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirPicker]);

  const submitDirPicker = async () => {
    if (!dirPicker || pickerBusy) return;
    const { mode, item } = dirPicker;
    const source = itemFullPath(item);
    const target = pickerTarget();
    if (target === source) {
      setDirPicker(null);
      return;
    }
    if (pickerTargetInvalid) {
      setPickerError('Cannot place an item inside itself.');
      return;
    }
    setPickerBusy(true);
    setPickerError(null);
    try {
      const c = await ensureSftp();
      await c.request(mode, { path: source, to: target, isDir: item.isDir });
      setDirPicker(null);
      fetchFileList(currentPath);
    } catch (err: any) {
      setPickerError(`${PATH_ACTION_LABEL[mode]} failed: ${err.message || 'unknown error'}`);
    } finally {
      setPickerBusy(false);
    }
  };

  const handleMkdir = async () => {
    if (!newDirName.trim()) return;
    const dirPath = currentPath.endsWith('/') ? `${currentPath}${newDirName.trim()}` : `${currentPath}/${newDirName.trim()}`;
    try {
      const c = await ensureSftp();
      await c.request('mkdir', { path: dirPath });
      setMkdirModalOpen(false); setNewDirName(''); fetchFileList(currentPath);
    } catch (err: any) {
      alert('Create directory failed: ' + (err.message || 'unknown error'));
    }
  };

  const openEditor = async (fileName: string) => {
    const filePath = currentPath.endsWith('/') ? `${currentPath}${fileName}` : `${currentPath}/${fileName}`;
    setEditingFilePath(filePath); setEditingContent('Loading file content...'); setEditorModalOpen(true);
    try {
      const c = await ensureSftp();
      const data = await c.request('read', { path: filePath });
      setEditingContent(data.content);
    } catch (err: any) {
      setEditingContent(`[Error loading file: ${err.message || 'unknown error'}]`);
    }
  };

  const handleSaveFileContent = async () => {
    setSavingFile(true);
    try {
      const c = await ensureSftp();
      await c.request('write', { path: editingFilePath, content: editingContent });
      setEditorModalOpen(false); fetchFileList(currentPath);
    } catch (err: any) {
      alert('Save failed: ' + (err.message || 'unknown error'));
    } finally { setSavingFile(false); }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    setUploading(true);
    setUploadStatus(`Uploading ${file.name}...`);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('sessionId', sessionId || '');
    formData.append('path', currentPath);

    try {
      const res = await apiFetch(apiUrl('/file/upload'), {
        method: 'POST',
        body: formData,
      });
      const json = await res.json();
      if (json.msg === 'success') {
        setUploadStatus('Upload completed successfully!');
        fetchFileList(currentPath);
      } else {
        setUploadStatus('Upload failed: ' + json.msg);
      }
    } catch (err: any) {
      setUploadStatus('Upload error: ' + err.message);
    } finally {
      setUploading(false);
      setTimeout(() => setUploadStatus(null), 3000);
      e.target.value = '';
    }
  };

  const renderFileIcon = (item: FileItem) => {
    if (item.isDir) {
      // 正在打开的就是这一行：图标原地转圈，明确告诉用户「点的是它，正在进去」
      if (openingPath === itemFullPath(item)) {
        return <Loader2 className="w-4 h-4 text-emerald-500 animate-spin shrink-0" />;
      }
      return <Folder className="w-4 h-4 text-amber-400 shrink-0" />;
    }
    const ext = item.name.split('.').pop()?.toLowerCase() || '';
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) {
      return <Image className="w-4 h-4 text-emerald-400 shrink-0" />;
    }
    if (['zip', 'tar', 'gz', 'bz2', '7z', 'rar'].includes(ext)) {
      return <FileArchive className="w-4 h-4 text-purple-400 shrink-0" />;
    }
    if (['js', 'ts', 'jsx', 'tsx', 'py', 'go', 'json', 'sh', 'html', 'css', 'yml', 'yaml'].includes(ext)) {
      return <FileCode className="w-4 h-4 text-blue-400 shrink-0" />;
    }
    return <FileText className="w-4 h-4 text-slate-400 shrink-0" />;
  };

  // Breadcrumb path parts
  const pathParts = currentPath.split('/').filter(Boolean);

  const filteredList = fileList.filter((item) =>
    item.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // 表头单元格：背景必须放在 <th> 上且**不透明**，并且要和列表自身底色一致 ——
  // 之前用 bg-slate-950 而面板底色是 bg-slate-900，表头就变成了一条比列表更深的
  // 「粗横线」（默认暗色主题下特别扎眼）。分隔线也放到 <th> 上，这样它跟着表头一起 sticky。
  // 另外表格必须用 border-separate：border-collapse + sticky 在 Chrome/Safari 下会把
  // 上滑的行内容画进表头（半截字「幻影」），折叠边框也不会跟着表头走。
  const theadCellClass = isLight
    ? 'bg-white border-b border-slate-200 shadow-[0_1px_2px_rgba(15,23,42,0.06)]'
    : 'bg-slate-900 border-b border-slate-800 shadow-[0_1px_2px_rgba(0,0,0,0.35)]';
  // 行分隔线：border-separate 下 <tr> 上的 border 会被忽略，必须落到每个 <td> 上
  const rowBorderClass = isLight ? 'border-b border-slate-200' : 'border-b border-slate-800/60';

  // 修改时间优先用服务端给的 epoch 秒在**浏览器本地时区**格式化。
  // 旧的 modifyTime 是服务端 toISOString() 的结果（UTC），在 UTC+8 会整整差 8 小时。
  const formatMtime = (item: FileItem) => {
    if (typeof item.mtimeSec === 'number' && Number.isFinite(item.mtimeSec)) {
      const d = new Date(item.mtimeSec * 1000);
      const p = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
    return item.modifyTime;
  };

  // 行内重命名行的输入框 / 按钮
  const inlineInputClass = `rounded px-2 py-1 text-xs focus:outline-none font-mono border flex-1 min-w-[140px] ${
    isLight ? 'bg-white border-slate-300 text-slate-800 focus:border-slate-500' : 'bg-slate-950 border-slate-800 text-slate-200 focus:border-slate-700'
  }`;
  const inlineCancelClass = `px-2.5 py-1 rounded text-xs font-medium transition shrink-0 ${
    isLight ? 'bg-slate-100 hover:bg-slate-200 text-slate-700' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
  }`;
  const menuItemClass = (tone: 'default' | 'danger' = 'default') =>
    `w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs font-medium transition cursor-pointer ${
      tone === 'danger'
        ? isLight ? 'text-rose-600 hover:bg-rose-50' : 'text-rose-400 hover:bg-rose-500/10'
        : isLight ? 'text-slate-700 hover:bg-slate-100' : 'text-slate-200 hover:bg-slate-800'
    }`;
  const pickerDirClass = (invalid: boolean) =>
    `w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs font-mono transition ${
      invalid
        ? 'opacity-35 cursor-not-allowed'
        : isLight ? 'text-slate-700 hover:bg-slate-100 cursor-pointer' : 'text-slate-200 hover:bg-slate-800 cursor-pointer'
    }`;
  const pickerActiveDirClass = isLight ? 'bg-emerald-50 text-emerald-700' : 'bg-emerald-500/15 text-emerald-300';

  return (
    <div
      className={`flex flex-col h-full select-none border-l transition-colors ${
        isLight
          ? 'bg-white text-slate-800 border-slate-200'
          : 'bg-slate-900 text-slate-200 border-slate-800'
      }`}
    >
      {/* SFTP Toolbar */}
      <div
        className={`px-3 py-2 border-b flex flex-wrap items-center justify-between gap-2 transition-colors ${
          isLight ? 'bg-slate-100 border-slate-200' : 'bg-slate-950 border-slate-800'
        }`}
      >
        {/* Breadcrumb Path Bar —— min-w 收小，好让右侧图标按钮留在同一行（240px 时窄屏会挤到第二行） */}
        <div
          className={`flex items-center gap-1 border rounded px-2 py-1 text-xs font-mono flex-1 min-w-[96px] overflow-hidden ${
            isLight ? 'bg-white border-slate-300 text-slate-800' : 'bg-slate-900 border-slate-800 text-slate-200'
          }`}
        >
          <button
            onClick={() => handleNavigate('~')}
            className="hover:text-emerald-500 text-slate-400 transition"
            title="Home Directory"
          >
            <Home className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => handleNavigate('/')}
            className="hover:text-emerald-500 text-slate-400 transition font-mono font-bold text-xs px-0.5"
            title="Root Directory (/)"
          >
            /
          </button>
          <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
          {pathParts.map((part, index) => {
            const subPath = '/' + pathParts.slice(0, index + 1).join('/');
            return (
              <React.Fragment key={index}>
                <button
                  onClick={() => handleNavigate(subPath)}
                  className={`hover:text-emerald-500 font-medium transition max-w-[120px] truncate ${
                    isLight ? 'text-slate-700' : 'text-slate-300'
                  }`}
                >
                  {part}
                </button>
                {index < pathParts.length - 1 && (
                  <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* Action Buttons —— 图标按钮，文字说明走 title（窄屏放不下文字） */}
        <div className="flex items-center gap-1.5 shrink-0">
          <label
            title="Upload File"
            className={`flex items-center p-1.5 rounded cursor-pointer transition border ${
              isLight
                ? 'bg-white hover:bg-slate-200 border-slate-300 text-slate-700'
                : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'
            }`}
          >
            <Upload className="w-3.5 h-3.5 text-emerald-500" />
            <input type="file" onChange={handleFileUpload} className="hidden" />
          </label>

          <button
            onClick={() => setMkdirModalOpen(true)}
            title="New Folder"
            className={`flex items-center p-1.5 rounded cursor-pointer transition border ${
              isLight
                ? 'bg-white hover:bg-slate-200 border-slate-300 text-slate-700'
                : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'
            }`}
          >
            <FolderPlus className="w-3.5 h-3.5 text-blue-500" />
          </button>

          <button
            onClick={() => {
              // 同一次加载没回来之前不再发第二个请求（连点刷新也一样）
              if (!loadingRef.current) fetchFileList(currentPath);
            }}
            className={`p-1.5 rounded transition cursor-pointer border ${
              isLight
                ? 'bg-white hover:bg-slate-200 border-slate-300 text-slate-700'
                : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300'
            } ${loading ? 'animate-spin' : ''}`}
            title="Refresh Directory"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Filter / Search Bar —— 只有图标没有文字提示；整条压到 ~28px，别白占列表高度 */}
      <div
        className={`px-2 py-0.5 border-b flex items-center justify-between gap-2 ${
          isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-900 border-slate-800'
        }`}
      >
        <div className="relative shrink-0">
          <Search className="w-3 h-3 text-slate-400 absolute left-1.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            title="Filter files"
            aria-label="Filter files"
            className={`h-5 leading-5 rounded pl-5 pr-1.5 text-[11px] focus:outline-none font-mono transition-[width] w-20 sm:w-28 focus:w-40 sm:focus:w-56 ${
              isLight
                ? 'bg-white border border-slate-300 text-slate-800 focus:border-slate-500'
                : 'bg-slate-950 border border-slate-800 text-slate-200 focus:border-slate-700'
            }`}
          />
        </div>

        <div className={`text-[10px] font-mono shrink-0 ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
          Items: {filteredList.length}
        </div>
      </div>

      {/* Status banner for uploads */}
      {uploadStatus && (
        <div className="bg-emerald-500/15 border-b border-emerald-500/30 text-emerald-300 px-3 py-1.5 text-xs font-mono flex items-center gap-2">
          <FileUp className="w-4 h-4 shrink-0 animate-bounce" />
          <span>{uploadStatus}</span>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="m-3 p-3 bg-rose-500/10 border border-rose-500/20 text-rose-300 rounded text-xs font-mono flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Files Table —— 外面再包一层 relative 才能把遮罩钉在可视区上：
          直接在滚动容器里 absolute inset-0 的话，遮罩会跟着内容滚走 */}
      <div className="relative flex-1 min-h-0 flex flex-col">
      <div className="flex-1 overflow-y-auto" ref={tableScrollRef}>
        <table className="w-full table-fixed text-left text-xs font-mono border-separate border-spacing-0">
          {/* 表头要 sticky 住，三个坑：
              1) 不能在 <thead> 上 sticky —— Safari 不支持，必须落到每个 <th> 上；
              2) 背景必须放在 <th> 且**完全不透明**，还要与列表底色一致（详见 theadCellClass）；
              3) 不能用 border-collapse —— 折叠边框 + sticky 会把行内容画进表头，改用
                 border-separate + border-spacing-0，线放到 <th> 自己身上才跟着表头走。
              z-10 保证表头压在行内容之上。 */}
          <thead
            className={`text-[11px] ${isLight ? 'text-slate-600' : 'text-slate-400'}`}
          >
            <tr>
              <th className={`sticky top-0 z-10 py-2 px-3 font-semibold ${theadCellClass}`}>Name</th>
              {showSize && (
                <th className={`sticky top-0 z-10 py-2 px-2 font-semibold ${isWide ? 'w-24' : 'w-20'} ${theadCellClass}`}>Size</th>
              )}
              {showModified && (
                <th className={`sticky top-0 z-10 py-2 px-2 font-semibold w-36 ${theadCellClass}`}>Modified</th>
              )}
              {/* 行内操作已全部收进 ⋮，这列只需要一个图标位，宽度压到 44px，把省下的宽度让给 Name */}
              <th className={`sticky top-0 z-10 py-2 pr-2 w-11 ${theadCellClass}`} />
            </tr>
          </thead>
          <tbody>
            {currentPath !== '/' && currentPath !== '' && (
              <tr
                onClick={() => {
                  handleNavigate(parentPathOf(currentPath));
                }}
                className={`cursor-pointer transition ${
                  isLight ? 'hover:bg-slate-100 text-slate-600' : 'hover:bg-slate-800/50 text-slate-400'
                }`}
              >
                <td className={`py-2 px-3 align-middle ${rowBorderClass}`} colSpan={tableCols}>
                  <div className="flex items-center gap-2 min-w-0 overflow-hidden">
                    {openingPath === parentPathOf(currentPath) ? (
                      <Loader2 className="w-4 h-4 text-emerald-500 animate-spin shrink-0" />
                    ) : (
                      <Folder className="w-4 h-4 text-amber-500/70 shrink-0" />
                    )}
                    <span className="font-bold truncate min-w-0">.. (Parent Directory)</span>
                  </div>
                </td>
              </tr>
            )}

            {filteredList.flatMap((item, index) => [
              <tr
                key={`row-${index}`}
                className={`group transition cursor-pointer ${
                  isLight ? 'hover:bg-slate-100' : 'hover:bg-slate-800/60'
                }`}
              >
                <td
                  onClick={() => handleItemClick(item)}
                  className={`py-2 px-3 align-middle font-medium ${rowBorderClass} ${
                    isLight ? 'text-slate-800 hover:text-emerald-600' : 'text-slate-200 hover:text-emerald-300'
                  }`}
                >
                  {/* flex 不能直接放在 <td> 上（会脱离表格单元格布局、把列宽算歪），必须包一层。
                      span 上的 min-w-0 是防重叠的关键：flex 项默认 min-width:auto，不收缩就会把
                      文件名画到相邻列上；overflow-hidden 再兜一层底。
                      手机半屏（compact）只有 Name + ⋮；手机上想看大小/时间的完整值去 ⋮ 菜单头部。 */}
                  <div className="flex items-center gap-2 min-w-0 overflow-hidden">
                    {renderFileIcon(item)}
                    <span className="truncate min-w-0" title={item.name}>
                      {item.name}
                    </span>
                  </div>
                </td>
                {showSize && (
                  <td className={`py-2 px-2 align-middle truncate ${rowBorderClass} ${isLight ? 'text-slate-600' : 'text-slate-400'}`}>
                    {item.isDir ? '-' : item.size}
                  </td>
                )}
                {showModified && (
                  <td className={`py-2 px-2 align-middle text-[11px] truncate ${rowBorderClass} ${isLight ? 'text-slate-500' : 'text-slate-500'}`}>
                    {formatMtime(item)}
                  </td>
                )}
                <td className={`py-2 pr-2 align-middle text-right ${rowBorderClass}`}>
                  {/* 只有一个 ⋮：编辑靠点击文件名进入，下载/Rename/Move/Copy/Delete 全在菜单里 */}
                  <div className="flex items-center justify-end opacity-80 group-hover:opacity-100">
                    <button
                      onClick={(e) => openMenu(e, item)}
                      className={`p-1.5 rounded transition cursor-pointer ${
                        menuItem === item
                          ? isLight ? 'bg-slate-200 text-slate-900' : 'bg-slate-700 text-slate-100'
                          : isLight ? 'hover:bg-slate-200 text-slate-600 hover:text-slate-900' : 'hover:bg-slate-700 text-slate-400 hover:text-slate-100'
                      }`}
                      title="More actions"
                      aria-label="More actions"
                    >
                      <EllipsisVertical className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>,

              /* 重命名：就地展开一行输入框，不用弹层 */
              renaming === item ? (
                <tr key={`op-${index}`} className={isLight ? 'bg-slate-50' : 'bg-slate-950/60'}>
                  <td colSpan={tableCols} className={`py-2 px-3 ${rowBorderClass}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`text-[11px] font-medium shrink-0 ${isLight ? 'text-slate-600' : 'text-slate-400'}`}>
                        {PATH_ACTION_LABEL.rename}
                      </span>
                      <input
                        type="text"
                        value={renameInput}
                        onChange={(e) => setRenameInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !renameBusy) submitRename();
                          if (e.key === 'Escape') setRenaming(null);
                        }}
                        placeholder="New name…"
                        autoFocus
                        className={inlineInputClass}
                      />
                      <span className={`text-[11px] font-mono truncate min-w-0 ${isLight ? 'text-emerald-700' : 'text-emerald-300'}`}>
                        → {resolveRenameTarget(renaming, itemFullPath(renaming))}
                      </span>
                      <div className="flex items-center gap-2 ml-auto shrink-0">
                        <button onClick={() => setRenaming(null)} className={inlineCancelClass}>
                          Cancel
                        </button>
                        <button
                          onClick={submitRename}
                          disabled={renameBusy || !renameInput.trim()}
                          className="flex items-center justify-center gap-1.5 min-w-[76px] px-3 py-1 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-500 transition disabled:opacity-50 cursor-pointer"
                        >
                          {renameBusy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                          <span>Confirm</span>
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : null,
            ])}

            {filteredList.length === 0 && !loading && (
              <tr>
                <td colSpan={tableCols} className={`py-8 text-center text-xs font-mono ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>
                  Directory is empty.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

        {/* 加载遮罩：盖住整个列表，顺便把点击也吃掉 —— 用户就不会连点目录了。
            只在请求超过 150ms 时出现，快请求不闪；文案带上目标目录名，让人知道在等什么。 */}
        {busy && (
          <div
            className={`absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 ${
              isLight ? 'bg-white/70' : 'bg-slate-950/60'
            }`}
          >
            <Loader2 className="w-5 h-5 text-emerald-500 animate-spin" />
            <div className={`text-[11px] font-mono max-w-[80%] truncate ${isLight ? 'text-slate-600' : 'text-slate-300'}`}>
              {openingPath ? `Loading ${openingPath} …` : 'Loading …'}
            </div>
          </div>
        )}
      </div>

      {/* New Folder Modal */}
      {mkdirModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 select-none">
          <div className={`border rounded-lg p-4 w-full max-w-sm shadow-xl ${isLight ? 'bg-white border-slate-200 text-slate-800' : 'bg-slate-900 border-slate-800 text-slate-100'}`}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-sm">Create New Directory</h3>
              <button
                onClick={() => setMkdirModalOpen(false)}
                className={`p-1 ${isLight ? 'text-slate-400 hover:text-slate-700' : 'text-slate-400 hover:text-slate-200'}`}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <input
              type="text"
              value={newDirName}
              onChange={(e) => setNewDirName(e.target.value)}
              placeholder="Folder Name..."
              autoFocus
              className={`w-full rounded px-3 py-1.5 text-xs focus:outline-none font-mono mb-4 border ${
                isLight ? 'bg-white border-slate-300 text-slate-800 focus:border-slate-500' : 'bg-slate-950 border-slate-800 text-slate-200 focus:border-slate-700'
              }`}
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setMkdirModalOpen(false)}
                className={`px-3 py-1.5 rounded text-xs font-medium transition ${
                  isLight ? 'bg-slate-100 hover:bg-slate-200 text-slate-700' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                }`}
              >
                Cancel
              </button>
              <button
                onClick={handleMkdir}
                className="px-3 py-1.5 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-500 transition"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* In-App Text File Editor Modal */}
      {editorModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 select-none">
          <div className={`border rounded-lg w-full max-w-3xl h-[80vh] flex flex-col shadow-2xl ${
            isLight ? 'bg-white border-slate-200 text-slate-800' : 'bg-slate-900 border-slate-800 text-slate-100'
          }`}>
            <div className={`px-4 py-2.5 border-b flex items-center justify-between ${
              isLight ? 'bg-slate-100 border-slate-200' : 'bg-slate-950 border-slate-800'
            }`}>
              <div className="flex items-center gap-2 text-xs font-mono truncate">
                <FileCode className="w-4 h-4 text-blue-500 shrink-0" />
                <span className="truncate">{editingFilePath}</span>
              </div>
              <button
                onClick={() => setEditorModalOpen(false)}
                className={`p-1 ${isLight ? 'text-slate-400 hover:text-slate-700' : 'text-slate-400 hover:text-slate-200'}`}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className={`flex-1 p-2 ${isLight ? 'bg-slate-50' : 'bg-slate-950'}`}>
              <textarea
                value={editingContent}
                onChange={(e) => setEditingContent(e.target.value)}
                className={`w-full h-full bg-transparent font-mono text-base sm:text-xs p-2 focus:outline-none resize-none leading-relaxed ${
                  isLight ? 'text-slate-900' : 'text-slate-200'
                }`}
                spellCheck={false}
              />
            </div>

            <div className={`px-4 py-2 border-t flex items-center justify-between ${
              isLight ? 'bg-slate-100 border-slate-200' : 'bg-slate-900 border-slate-800'
            }`}>
              <span className={`text-[11px] font-mono ${isLight ? 'text-slate-500' : 'text-slate-500'}`}>
                UTF-8 • Remote File
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setEditorModalOpen(false)}
                  className={`min-w-[72px] px-3 py-2 rounded-lg text-xs font-medium transition ${
                    isLight ? 'bg-slate-200 hover:bg-slate-300 text-slate-700' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                  }`}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveFileContent}
                  disabled={savingFile}
                  className="flex items-center justify-center gap-1.5 min-w-[72px] px-3 py-2 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-500 transition disabled:opacity-50"
                >
                  {savingFile ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  <span>Save</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 行内「⋮」操作菜单（fixed 定位，避免被表格滚动容器裁切） */}
      {menuItem && menuPos && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={closeMenu} />
          <div
            style={{ top: menuPos.top, left: menuPos.left }}
            className={`fixed z-[61] w-[176px] py-1 rounded-lg border shadow-2xl overflow-hidden ${
              isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-700'
            }`}
          >
            <div
              className={`px-2.5 py-2 border-b ${
                isLight ? 'border-slate-100' : 'border-slate-800'
              }`}
            >
              <div className={`text-[11px] font-mono font-semibold truncate ${isLight ? 'text-slate-700' : 'text-slate-200'}`} title={menuItem.name}>
                {menuItem.name}
              </div>
              {/* 手机端行内没有 Size / Modified 列，所以这里把大小和时间拆成两行完整给出 */}
              <div className={`mt-1 text-[10px] font-mono leading-4 ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                <div>{menuItem.isDir ? 'Folder' : menuItem.size}</div>
                <div>{formatMtime(menuItem)}</div>
              </div>
            </div>
            {/* 编辑不在这里 —— 直接点文件名就进编辑器；下载收进菜单（所有档位一致） */}
            {!menuItem.isDir && (
              <button
                onClick={() => {
                  const item = menuItem;
                  closeMenu();
                  handleDownload(item);
                }}
                className={menuItemClass()}
              >
                <Download className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                <span>Download</span>
              </button>
            )}
            <button onClick={() => startRename(menuItem)} className={menuItemClass()}>
              <TextCursorInput className="w-3.5 h-3.5 text-amber-500 shrink-0" />
              <span>Rename</span>
            </button>
            <button onClick={() => openDirPicker('move', menuItem)} className={menuItemClass()}>
              <FolderInput className="w-3.5 h-3.5 text-blue-500 shrink-0" />
              <span>Move to…</span>
            </button>
            <button onClick={() => openDirPicker('copy', menuItem)} className={menuItemClass()}>
              <Copy className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
              <span>Copy to…</span>
            </button>
            <div className={`my-1 border-t ${isLight ? 'border-slate-100' : 'border-slate-800'}`} />
            <button
              onClick={() => {
                const item = menuItem;
                closeMenu();
                handleDelete(item);
              }}
              className={menuItemClass('danger')}
            >
              <Trash2 className="w-3.5 h-3.5 shrink-0" />
              <span>Delete</span>
            </button>
          </div>
        </>
      )}

      {/* Move / Copy 目录选择弹窗 */}
      {dirPicker && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[70] select-none"
          onClick={() => setDirPicker(null)}
        >
          <div
            className={`border rounded-xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col max-h-full ${
              isLight ? 'bg-white border-slate-200 text-slate-800' : 'bg-slate-900 border-slate-700 text-slate-100'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={`px-4 py-3 border-b flex items-center gap-2 ${isLight ? 'border-slate-200' : 'border-slate-800'}`}>
              {dirPicker.mode === 'move' ? (
                <FolderInput className="w-4 h-4 text-blue-500 shrink-0" />
              ) : (
                <Copy className="w-4 h-4 text-emerald-500 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <h3 className={`font-bold text-sm ${isLight ? 'text-slate-900' : 'text-slate-100'}`}>
                  {dirPicker.mode === 'move' ? 'Move to folder' : 'Copy to folder'}
                </h3>
                <p className={`text-[11px] font-mono truncate ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                  {dirPicker.item.isDir ? '📁' : '📄'} {dirPicker.item.name}
                </p>
              </div>
              <button
                onClick={() => setDirPicker(null)}
                className={`p-1 shrink-0 cursor-pointer ${isLight ? 'text-slate-400 hover:text-slate-700' : 'text-slate-400 hover:text-slate-200'}`}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 路径导航：家目录 / 根 / 上级 + 可编辑路径 */}
            <div className={`px-3 py-2 border-b flex items-center gap-1.5 ${isLight ? 'border-slate-200 bg-slate-50' : 'border-slate-800 bg-slate-950'}`}>
              <button
                onClick={() => loadPickerDir('~')}
                title="Home Directory"
                className="p-1 rounded text-slate-400 hover:text-emerald-500 transition cursor-pointer shrink-0"
              >
                <Home className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => loadPickerDir('/')}
                title="Root Directory"
                className={`p-1 rounded font-mono font-bold text-xs transition cursor-pointer shrink-0 ${
                  isLight ? 'text-slate-500 hover:text-emerald-600' : 'text-slate-400 hover:text-emerald-400'
                }`}
              >
                /
              </button>
              <button
                onClick={() => loadPickerDir(pickerPath.substring(0, pickerPath.lastIndexOf('/')) || '/')}
                title="Parent Directory"
                className="p-1 rounded text-slate-400 hover:text-emerald-500 transition cursor-pointer shrink-0"
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
              <input
                type="text"
                value={pickerPathInput}
                onChange={(e) => setPickerPathInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') loadPickerDir(pickerPathInput);
                }}
                spellCheck={false}
                className={`flex-1 min-w-0 rounded px-2 py-1 text-xs font-mono border focus:outline-none ${
                  isLight
                    ? 'bg-white border-slate-300 text-slate-800 focus:border-slate-500'
                    : 'bg-slate-900 border-slate-800 text-slate-200 focus:border-slate-700'
                }`}
              />
              <button
                onClick={() => loadPickerDir(pickerPathInput)}
                className={`px-2 py-1 rounded text-xs font-medium transition cursor-pointer shrink-0 ${
                  isLight ? 'bg-slate-200 hover:bg-slate-300 text-slate-700' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                }`}
              >
                Go
              </button>
            </div>

            {/* 子目录列表：高度钉死，避免目录内容多少导致弹窗高度跳动 */}
            <div className="flex-none overflow-y-auto py-1" style={{ height: 'min(272px, 38vh)' }}>
              {pickerLoading && (
                <div className={`h-full text-xs font-mono flex flex-col items-center justify-center gap-2 ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Loading…</span>
                </div>
              )}
              {!pickerLoading && pickerError && (
                <div className="h-full px-4 text-xs font-mono text-rose-500 flex flex-col items-center justify-center gap-2 text-center">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span className="break-all">{pickerError}</span>
                </div>
              )}
              {!pickerLoading && !pickerError && pickerDirs.length === 0 && (
                <div className={`h-full text-xs font-mono flex items-center justify-center ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>
                  No sub-directories here.
                </div>
              )}
              {!pickerLoading &&
                pickerDirs.map((dir, i) => {
                  const child = joinPath(pickerPath, dir.name);
                  const invalid = pickerDirIsInvalid(child);
                  return (
                    <button
                      key={i}
                      disabled={invalid}
                      onClick={() => loadPickerDir(child)}
                      title={invalid ? 'Cannot move a folder into itself' : child}
                      className={pickerDirClass(invalid)}
                    >
                      <Folder className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                      <span className="truncate">{dir.name}</span>
                      <ChevronRight className="w-3.5 h-3.5 ml-auto shrink-0 opacity-50" />
                    </button>
                  );
                })}
            </div>

            {/* 当前选中的目录即为目标目录 */}
            <div
              className={`px-3 py-1.5 text-[11px] font-mono border-t truncate ${
                isLight ? 'text-slate-500 border-slate-200 bg-slate-50' : 'text-slate-400 border-slate-800 bg-slate-950'
              }`}
            >
              Destination:{' '}
              <span className={pickerTargetInvalid ? 'text-rose-500' : isLight ? 'text-emerald-700' : 'text-emerald-300'}>
                {pickerTarget()}
              </span>
            </div>

            <div className={`px-4 py-3 border-t flex justify-end gap-2 ${isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950 border-slate-800'}`}>
              <button onClick={() => setDirPicker(null)} className={`${inlineCancelClass} cursor-pointer px-3 py-1.5`}>
                Cancel
              </button>
              <button
                onClick={submitDirPicker}
                disabled={pickerBusy || pickerTargetInvalid}
                className="flex items-center justify-center gap-1.5 min-w-[104px] px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition disabled:opacity-50 cursor-pointer"
              >
                {pickerBusy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                <span>{dirPicker.mode === 'move' ? 'Move here' : 'Copy here'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={!!pendingDeleteItem}
        title="Delete file"
        message={
          <>
            Delete <span className="font-mono font-bold">{pendingDeleteItem?.name}</span>
            {pendingDeleteItem?.isDir ? ' and its contents' : ''}? This cannot be undone.
          </>
        }
        theme={theme}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDeleteItem(null)}
      />
    </div>
  );
};
