import React, { useState, useEffect, useRef } from 'react';
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
  Download,
  Trash2,
  Edit3,
  ChevronRight,
  Home,
  Search,
  Check,
  X,
  AlertCircle,
  FileUp,
} from 'lucide-react';

interface SFTPViewProps {
  sshInfo: SSHInfo;
  sessionId?: string;
  initialPath?: string;
  onPathChange?: (path: string) => void;
  theme?: string;
  isVisible?: boolean;
}

export const SFTPView: React.FC<SFTPViewProps> = ({ sshInfo, sessionId, initialPath, onPathChange, theme, isVisible = true }) => {
  const isLight = theme === 'light';
  const defaultHome = sshInfo.username && sshInfo.username !== 'root' ? `/home/${sshInfo.username}` : '/root';
  const [currentPath, setCurrentPath] = useState<string>(initialPath || defaultHome);
  const [pathInput, setPathInput] = useState<string>(initialPath || defaultHome);
  const [fileList, setFileList] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
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

  const sftpRef = useRef<SftpWSClient | null>(null);
  const ensureSftp = async () => {
    if (!sessionId) throw new Error('No sessionId');
    if (sftpRef.current) {
      try { await sftpRef.current.connect(); return sftpRef.current; } catch {}
    }
    const c = new SftpWSClient(sessionId);
    await c.connect();
    sftpRef.current = c;
    return c;
  };
  useEffect(() => {
    // sessionId 变化重建，组件卸载主动关闭 WS
    return () => { sftpRef.current?.close(); sftpRef.current = null; };
  }, [sessionId]);
  useEffect(() => {
    if (!isVisible) { sftpRef.current?.close(); sftpRef.current = null; }
  }, [isVisible]);

  const fetchFileList = async (dirPath: string) => {
    setLoading(true);
    setError(null);
    try {
      if (sessionId) {
        const c = await ensureSftp();
        const data = await c.request('list', { path: dirPath });
        setCurrentPath(data.path);
        setPathInput(data.path);
        setFileList(data.list || []);
        onPathChange?.(data.path);
      } else {
        const res = await apiFetch(apiUrl(`/file/list?sessionId=&path=${encodeURIComponent(dirPath)}`));
        const json = await res.json();
        if (json.msg === 'success' && json.data) {
          setCurrentPath(json.data.path);
          setPathInput(json.data.path);
          setFileList(json.data.list || []);
          onPathChange?.(json.data.path);
        } else setError(json.msg || 'Failed');
      }
    } catch (err: any) {
      setError(err.message || 'Error connecting to SFTP server');
      // 失败回退 HTTP
      try {
        const res = await apiFetch(apiUrl(`/file/list?sessionId=${encodeURIComponent(sessionId || '')}&path=${encodeURIComponent(dirPath)}`));
        const json = await res.json();
        if (json.msg === 'success' && json.data) {
          setCurrentPath(json.data.path);
          setPathInput(json.data.path);
          setFileList(json.data.list || []);
          onPathChange?.(json.data.path);
          setError(null);
        }
      } catch {}
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFileList(initialPath || '');
  }, [sshInfo, sessionId, initialPath]);

  const handleNavigate = (path: string) => {
    fetchFileList(path);
  };

  const handleItemClick = (item: FileItem) => {
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

  const handleDelete = async (item: FileItem) => {
    if (!window.confirm(`Are you sure you want to delete "${item.name}"?`)) return;
    const itemPath = currentPath.endsWith('/') ? `${currentPath}${item.name}` : `${currentPath}/${item.name}`;
    try {
      if (sessionId) {
        const c = await ensureSftp();
        await c.request('delete', { path: itemPath, isDir: item.isDir });
        fetchFileList(currentPath);
      } else throw new Error('no session');
    } catch (err: any) {
      try {
        const res = await apiFetch(apiUrl('/file/delete'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, path: itemPath, isDir: item.isDir }) });
        const json = await res.json();
        if (json.msg === 'success') fetchFileList(currentPath); else alert('Delete failed: ' + json.msg);
      } catch (e2: any) { alert('Delete error: ' + (e2.message || err.message)); }
    }
  };

  const handleMkdir = async () => {
    if (!newDirName.trim()) return;
    const dirPath = currentPath.endsWith('/') ? `${currentPath}${newDirName.trim()}` : `${currentPath}/${newDirName.trim()}`;
    try {
      if (sessionId) {
        const c = await ensureSftp();
        await c.request('mkdir', { path: dirPath });
        setMkdirModalOpen(false); setNewDirName(''); fetchFileList(currentPath);
      } else throw new Error('no session');
    } catch (err: any) {
      try {
        const res = await apiFetch(apiUrl('/file/mkdir'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, path: dirPath }) });
        const json = await res.json();
        if (json.msg === 'success') { setMkdirModalOpen(false); setNewDirName(''); fetchFileList(currentPath); } else alert('Create directory failed: ' + json.msg);
      } catch (e2: any) { alert('Error creating directory: ' + (e2.message || err.message)); }
    }
  };

  const openEditor = async (fileName: string) => {
    const filePath = currentPath.endsWith('/') ? `${currentPath}${fileName}` : `${currentPath}/${fileName}`;
    setEditingFilePath(filePath); setEditingContent('Loading file content...'); setEditorModalOpen(true);
    try {
      if (sessionId) {
        const c = await ensureSftp();
        const data = await c.request('read', { path: filePath });
        setEditingContent(data.content);
      } else throw new Error('no session');
    } catch (err: any) {
      try {
        const res = await apiFetch(apiUrl(`/file/read?sessionId=${encodeURIComponent(sessionId || '')}&path=${encodeURIComponent(filePath)}`));
        const json = await res.json();
        if (json.msg === 'success' && json.data) setEditingContent(json.data.content); else setEditingContent(`[Error loading file: ${json.msg}]`);
      } catch (e2: any) { setEditingContent(`[Error: ${e2.message || err.message}]`); }
    }
  };

  const handleSaveFileContent = async () => {
    setSavingFile(true);
    try {
      if (sessionId) {
        const c = await ensureSftp();
        await c.request('write', { path: editingFilePath, content: editingContent });
        setEditorModalOpen(false); fetchFileList(currentPath);
      } else throw new Error('no session');
    } catch (err: any) {
      try {
        const res = await apiFetch(apiUrl('/file/write'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, path: editingFilePath, content: editingContent }) });
        const json = await res.json();
        if (json.msg === 'success') { setEditorModalOpen(false); fetchFileList(currentPath); } else alert('Save failed: ' + json.msg);
      } catch (e2: any) { alert('Error saving file: ' + (e2.message || err.message)); }
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
        {/* Breadcrumb Path Bar */}
        <div
          className={`flex items-center gap-1 border rounded px-2 py-1 text-xs font-mono flex-1 min-w-[240px] ${
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

        {/* Action Buttons */}
        <div className="flex items-center gap-1.5">
          <label
            className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium cursor-pointer transition border ${
              isLight
                ? 'bg-white hover:bg-slate-200 border-slate-300 text-slate-700'
                : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'
            }`}
          >
            <Upload className="w-3.5 h-3.5 text-emerald-500" />
            <span>Upload</span>
            <input type="file" onChange={handleFileUpload} className="hidden" />
          </label>

          <button
            onClick={() => setMkdirModalOpen(true)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium cursor-pointer transition border ${
              isLight
                ? 'bg-white hover:bg-slate-200 border-slate-300 text-slate-700'
                : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'
            }`}
          >
            <FolderPlus className="w-3.5 h-3.5 text-blue-500" />
            <span>New Folder</span>
          </button>

          <button
            onClick={() => fetchFileList(currentPath)}
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

      {/* Filter / Search Bar */}
      <div
        className={`px-3 py-1.5 border-b flex items-center justify-between text-xs gap-2 ${
          isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-900 border-slate-800'
        }`}
      >
        <div className="relative flex-1 max-w-xs">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Filter files..."
            className={`w-full rounded pl-8 pr-3 py-1 text-xs focus:outline-none font-mono ${
              isLight
                ? 'bg-white border border-slate-300 text-slate-800 focus:border-slate-500'
                : 'bg-slate-950 border border-slate-800 text-slate-200 focus:border-slate-700'
            }`}
          />
        </div>

        <div className={`text-[11px] font-mono ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
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

      {/* Files Table */}
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-left text-xs font-mono border-collapse">
          <thead
            className={`sticky top-0 border-b text-[11px] ${
              isLight ? 'bg-slate-100 text-slate-600 border-slate-200' : 'bg-slate-950/80 text-slate-400 border-slate-800'
            }`}
          >
            <tr>
              <th className="py-2 px-3 font-semibold">Name</th>
              <th className="py-2 px-3 font-semibold w-24">Size</th>
              <th className="py-2 px-3 font-semibold w-36 hidden sm:table-cell">Modified</th>
              <th className="py-2 px-3 font-semibold w-20 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className={`divide-y ${isLight ? 'divide-slate-200' : 'divide-slate-800/60'}`}>
            {currentPath !== '/' && currentPath !== '' && (
              <tr
                onClick={() => {
                  const parent = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
                  handleNavigate(parent);
                }}
                className={`cursor-pointer transition ${
                  isLight ? 'hover:bg-slate-100 text-slate-600' : 'hover:bg-slate-800/50 text-slate-400'
                }`}
              >
                <td className="py-2 px-3 flex items-center gap-2" colSpan={4}>
                  <Folder className="w-4 h-4 text-amber-500/70" />
                  <span className="font-bold">.. (Parent Directory)</span>
                </td>
              </tr>
            )}

            {filteredList.map((item, index) => (
              <tr
                key={index}
                className={`group transition cursor-pointer ${
                  isLight ? 'hover:bg-slate-100' : 'hover:bg-slate-800/60'
                }`}
              >
                <td
                  onClick={() => handleItemClick(item)}
                  className={`py-2 px-3 flex items-center gap-2 font-medium truncate ${
                    isLight ? 'text-slate-800 hover:text-emerald-600' : 'text-slate-200 hover:text-emerald-300'
                  }`}
                >
                  {renderFileIcon(item)}
                  <span className="truncate">{item.name}</span>
                </td>
                <td className={`py-2 px-3 ${isLight ? 'text-slate-600' : 'text-slate-400'}`}>{item.isDir ? '-' : item.size}</td>
                <td className={`py-2 px-3 text-[11px] hidden sm:table-cell ${isLight ? 'text-slate-500' : 'text-slate-500'}`}>
                  {item.modifyTime}
                </td>
                <td className="py-2 px-3 text-right">
                  <div className="flex items-center justify-end gap-1 opacity-80 group-hover:opacity-100">
                    {!item.isDir && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditor(item.name);
                        }}
                        className={`p-1 rounded transition ${
                          isLight ? 'hover:bg-slate-200 text-slate-600 hover:text-blue-600' : 'hover:bg-slate-700 text-slate-400 hover:text-blue-300'
                        }`}
                        title="View / Edit Text File"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {!item.isDir && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDownload(item);
                        }}
                        className={`p-1 rounded transition ${
                          isLight ? 'hover:bg-slate-200 text-slate-600 hover:text-emerald-600' : 'hover:bg-slate-700 text-slate-400 hover:text-emerald-300'
                        }`}
                        title="Download File"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(item);
                      }}
                      className={`p-1 rounded transition ${
                        isLight ? 'hover:bg-slate-200 text-slate-600 hover:text-rose-600' : 'hover:bg-slate-700 text-slate-400 hover:text-rose-400'
                      }`}
                      title="Delete Item"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}

            {filteredList.length === 0 && !loading && (
              <tr>
                <td colSpan={4} className={`py-8 text-center text-xs font-mono ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>
                  Directory is empty.
                </td>
              </tr>
            )}
          </tbody>
        </table>
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
    </div>
  );
};
