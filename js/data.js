/**
 * MusicBox - 数据管理模块 v2
 * 支持 MP3 文件存储、WAV 编码、歌单管理、本地持久化
 */

// ==================== 文件存储（内存 + IndexedDB 持久化） ====================

const FileStorage = {
    _files: new Map(),
    _db: null,

    /** 初始化 IndexedDB（带超时保护，避免卡死） */
    async _initDB() {
        if (this._db) return;
        return new Promise((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => {
                if (!settled) { settled = true; resolve(); } // 超时也放行，走内存模式
            }, 3000);

            let req;
            try {
                req = indexedDB.open('musicbox_audio', 1);
            } catch (e) {
                clearTimeout(timeout);
                resolve(); // IndexedDB 不可用，纯内存模式
                return;
            }

            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('files')) {
                    db.createObjectStore('files', { keyPath: 'songId' });
                }
            };
            req.onsuccess = () => {
                clearTimeout(timeout);
                if (!settled) { settled = true; this._db = req.result; resolve(); }
            };
            req.onerror = () => {
                clearTimeout(timeout);
                if (!settled) { settled = true; resolve(); } // 出错也放行
            };
            req.onblocked = () => {
                clearTimeout(timeout);
                if (!settled) { settled = true; resolve(); }
            };
        });
    },

    set(songId, arrayBuffer, fileName = '', mimeType = 'audio/mpeg') {
        this._files.set(songId, { arrayBuffer, mimeType, fileName });
        this._saveToDB(songId, arrayBuffer, fileName, mimeType);
    },

    async _saveToDB(songId, arrayBuffer, fileName, mimeType) {
        try {
            await this._initDB();
            if (!this._db) return;
            const tx = this._db.transaction('files', 'readwrite');
            tx.objectStore('files').put({ songId, arrayBuffer, fileName, mimeType });
        } catch (e) { /* IndexedDB may not be available */ }
    },

    get(songId) {
        return this._files.get(songId) || null;
    },

    getBlobUrl(songId) {
        const file = this._files.get(songId);
        if (!file) return null;
        if (file._blobUrl) URL.revokeObjectURL(file._blobUrl);
        const blob = new Blob([file.arrayBuffer], { type: file.mimeType });
        file._blobUrl = URL.createObjectURL(blob);
        return file._blobUrl;
    },

    getBuffer(songId) {
        const file = this._files.get(songId);
        return file ? file.arrayBuffer.slice(0) : null;
    },

    delete(songId) {
        const file = this._files.get(songId);
        if (file && file._blobUrl) URL.revokeObjectURL(file._blobUrl);
        this._files.delete(songId);
        this._deleteFromDB(songId);
    },

    async _deleteFromDB(songId) {
        try {
            await this._initDB();
            if (!this._db) return;
            const tx = this._db.transaction('files', 'readwrite');
            tx.objectStore('files').delete(songId);
        } catch (e) { /* ignore */ }
    },

    has(songId) { return this._files.has(songId); },
    get size() { return this._files.size; },

    clear() {
        for (const [, file] of this._files) {
            if (file._blobUrl) URL.revokeObjectURL(file._blobUrl);
        }
        this._files.clear();
    },

    /** 从 IndexedDB 恢复所有文件到内存 */
    async restoreFromDB() {
        try {
            await this._initDB();
            if (!this._db) return 0; // IndexedDB 不可用
            return new Promise((resolve) => {
                const tx = this._db.transaction('files', 'readonly');
                const req = tx.objectStore('files').getAll();
                req.onsuccess = () => {
                    const entries = req.result || [];
                    for (const entry of entries) {
                        if (!this._files.has(entry.songId)) {
                            this._files.set(entry.songId, {
                                arrayBuffer: entry.arrayBuffer,
                                mimeType: entry.mimeType,
                                fileName: entry.fileName,
                            });
                        }
                    }
                    resolve(entries.length);
                };
                req.onerror = () => resolve(0);
            });
        } catch (e) { return 0; }
    },
};

// ==================== WAV 编码器 ====================

const WavEncoder = {
    encode(audioBuffer) {
        const numChannels = audioBuffer.numberOfChannels;
        const sampleRate = audioBuffer.sampleRate;
        const bitsPerSample = 16;
        const bytesPerSample = bitsPerSample / 8;

        const channels = [];
        for (let c = 0; c < numChannels; c++) {
            channels.push(audioBuffer.getChannelData(c));
        }
        const length = channels[0].length;
        const dataLength = length * numChannels * bytesPerSample;
        const totalLength = 44 + dataLength;

        const buffer = new ArrayBuffer(totalLength);
        const view = new DataView(buffer);

        writeStr(view, 0, 'RIFF');
        view.setUint32(4, totalLength - 8, true);
        writeStr(view, 8, 'WAVE');
        writeStr(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
        view.setUint16(32, numChannels * bytesPerSample, true);
        view.setUint16(34, bitsPerSample, true);
        writeStr(view, 36, 'data');
        view.setUint32(40, dataLength, true);

        let offset = 44;
        for (let i = 0; i < length; i++) {
            for (let c = 0; c < numChannels; c++) {
                const s = Math.max(-1, Math.min(1, channels[c][i]));
                view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
                offset += 2;
            }
        }
        return buffer;
    },
};

function writeStr(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

// ==================== MP3 编码器 ====================

const Mp3Encoder = {
    _lameReady: false,
    _lamePromise: null,

    /** 加载 lamejs 库（CDN，首次调用时加载） */
    _loadLame() {
        if (this._lamePromise) return this._lamePromise;
        this._lamePromise = new Promise((resolve, reject) => {
            if (typeof lamejs !== 'undefined') {
                this._lameReady = true;
                resolve();
                return;
            }
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
            s.onload = () => { this._lameReady = true; resolve(); };
            s.onerror = () => reject(new Error('无法加载 lamejs'));
            document.head.appendChild(s);
        });
        return this._lamePromise;
    },

    /** 将 AudioBuffer 编码为 MP3 ArrayBuffer */
    async encode(audioBuffer, bitRate = 128) {
        await this._loadLame();

        const sampleRate = audioBuffer.sampleRate;
        const numChannels = audioBuffer.numberOfChannels;
        const left = audioBuffer.getChannelData(0);
        const right = numChannels > 1 ? audioBuffer.getChannelData(1) : left;
        const length = left.length;

        // 转为 Int16 PCM
        const leftPCM = new Int16Array(length);
        const rightPCM = new Int16Array(length);
        for (let i = 0; i < length; i++) {
            leftPCM[i] = Math.max(-32768, Math.min(32767, left[i] * 32767));
            rightPCM[i] = Math.max(-32768, Math.min(32767, right[i] * 32767));
        }

        // LAME 编码
        const encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, bitRate);
        const blockSize = 1152;
        const mp3Chunks = [];

        for (let i = 0; i < length; i += blockSize) {
            const leftChunk = leftPCM.subarray(i, i + blockSize);
            const rightChunk = numChannels > 1 ? rightPCM.subarray(i, i + blockSize) : null;
            const mp3buf = encoder.encodeBuffer(leftChunk, rightChunk);
            if (mp3buf.length > 0) mp3Chunks.push(mp3buf);
        }

        const finalBuf = encoder.flush();
        if (finalBuf.length > 0) mp3Chunks.push(finalBuf);

        // 合并所有 MP3 数据块
        const totalLength = mp3Chunks.reduce((sum, b) => sum + b.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of mp3Chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result.buffer;
    },
};

// ==================== 音乐库数据管理 ====================

const MusicData = {
    _songs: [],

    async loadDefaultLibrary() {
        // 优先恢复本地曲库。上传、删除、重命名等操作都会保存完整曲库快照。
        // 这样刷新页面后不会被 HTML 内嵌的初始数据覆盖。
        if (this._loadFromLocal()) {
            // 为已经使用过网页的浏览器补入本次新增的 Z&Z 仪式曲目。
            // 标记只执行一次，之后用户自行删除的歌曲不会在每次刷新时被重新加回。
            this._seedZzCeremonySongs();
            console.log(`从本地恢复了 ${this._songs.length} 首歌曲`);
            this._preloadAudioFiles();
            return true;
        }

        // 1. 尝试从内嵌数据加载（file:// 兼容）
        try {
            const el = document.getElementById('preset-songs');
            if (el && el.textContent.trim()) {
                const data = JSON.parse(el.textContent.trim());
                this._songs = data.map((s, i) => this._normalizeSong(s, i));
                console.log(`从内嵌数据加载了 ${this._songs.length} 首歌曲`);
                this._preloadAudioFiles();
                return true;
            }
        } catch (e) { console.warn('内嵌数据解析失败:', e.message); }

        // 2. 尝试从 data/songs-v2.json 加载（HTTP 服务器模式）
        try {
            const resp = await fetch('data/songs-v2.json');
            if (resp.ok) {
                const data = await resp.json();
                this._songs = data.map((s, i) => this._normalizeSong(s, i));
                this._preloadAudioFiles();
                return true;
            }
        } catch (e) { console.warn('加载音乐库失败:', e.message); }

        this._songs = [];
        return false;
    },

    async _preloadAudioFiles() {
        for (const song of this._songs) {
            if (!song.audioUrl || FileStorage.has(song.id)) continue;
            const buf = await this._fetchAudio(song.audioUrl);
            if (buf) {
                FileStorage.set(song.id, buf, song.audioUrl.split('/').pop(), 'audio/mpeg');
                await this._detectDuration(song.id);
            }
        }
    },

    /** 通用的音频加载：优先 fetch，失败回退 XHR（兼容 file:// 协议） */
    async _fetchAudio(url) {
        return this._fetchAudioWithProgress(url, null);
    },

    /** 带进度回调的音频下载：优先 fetch 流式读取，回退 XHR progress */
    async _fetchAudioWithProgress(url, onProgress) {
        // 编码 URL 中的特殊字符（#、空格等），防止被浏览器解析为锚点
        const safeUrl = url.split('/').map((part, i, arr) =>
            i === arr.length - 1 ? encodeURIComponent(part) : part
        ).join('/');

        // 方式 1：fetch + ReadableStream 获取下载进度
        try {
            const resp = await fetch(safeUrl);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const total = Number(resp.headers.get('Content-Length')) || 0;
            if (resp.body && total > 0) {
                const reader = resp.body.getReader();
                const chunks = [];
                let received = 0;
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    received += value.length;
                    if (onProgress) onProgress(Math.min(100, Math.round(received / total * 100)));
                }
                const buf = new Uint8Array(received);
                let offset = 0;
                for (const c of chunks) { buf.set(c, offset); offset += c.length; }
                if (onProgress) onProgress(100);
                return buf.buffer;
            }
            const buf = await resp.arrayBuffer();
            if (onProgress) onProgress(100);
            return buf;
        } catch (e) { /* fetch 失败回退 XHR */ }

        // 方式 2：XMLHttpRequest + progress 事件
        try {
            return await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('GET', safeUrl, true);
                xhr.responseType = 'arraybuffer';
                xhr.onprogress = (e) => {
                    if (e.lengthComputable && onProgress) {
                        onProgress(Math.min(100, Math.round(e.loaded / e.total * 100)));
                    }
                };
                xhr.onload = () => {
                    if (xhr.status === 200 || xhr.status === 0) {
                        if (onProgress) onProgress(100);
                        resolve(xhr.response);
                    } else resolve(null);
                };
                xhr.onerror = () => resolve(null);
                xhr.send();
            });
        } catch (e) { return null; }
    },

    async _detectDuration(songId) {
        const buffer = FileStorage.getBuffer(songId);
        if (!buffer) return;
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const ab = await ctx.decodeAudioData(buffer);
            const song = this._songs.find(s => s.id === songId);
            if (song) {
                song.duration = ab.duration;
                song.durationStr = this._formatDuration(ab.duration);
                song._sampleRate = ab.sampleRate;
                song._channels = ab.numberOfChannels;
            }
            ctx.close();
        } catch (e) { /* skip */ }
    },

    async importFiles(fileList, targetFolder = '') {
        const newSongs = [];
        for (const file of fileList) {
            const fname = file.name.toLowerCase();
            if (!fname.endsWith('.mp3')) continue;

            const buf = await file.arrayBuffer();

            // 尝试匹配预设歌曲（通过文件名中的 cue 字母）
            let matched = null;
            const cueMatch = file.name.match(/^([a-z])_/i);
            if (cueMatch) {
                const cue = cueMatch[1].toLowerCase();
                if (cue === 'j') {
                    if (fname.includes('卡点') || fname.includes('come alive')) {
                        matched = this._songs.find(s => s.cue === 'J-1');
                    } else {
                        matched = this._songs.find(s => s.cue === 'J-2');
                    }
                } else {
                    const cueUpper = cue.toUpperCase();
                    matched = this._songs.find(s => s.cue === cueUpper);
                }
            }

            if (matched) {
                FileStorage.set(matched.id, buf, file.name, 'audio/mpeg');
                matched._isUploaded = true;
                matched._fileName = file.name;
                await this._detectDuration(matched.id);
            } else {
                // 创建新歌曲条目
                const id = 'file_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                FileStorage.set(id, buf, file.name, 'audio/mpeg');
                const nameNoExt = file.name.replace(/\.mp3$/i, '');
                const title = nameNoExt.replace(/^[a-z]_/i, '').slice(0, 50);
                const folderPath = targetFolder ? `data/audio2/${targetFolder}/${file.name}` : '';
                const song = this._normalizeSong({ id, title, artist: '', audioUrl: folderPath });
                song._isUploaded = true;
                song._fileName = file.name;
                newSongs.push(song);
            }
        }

        if (newSongs.length > 0) {
            this._songs.push(...newSongs);
            for (const s of newSongs) await this._detectDuration(s.id);
        }
        this._saveToLocal();
        return newSongs;
    },

    async addTrimmedSong(originalSong, trimmedBuffer, newTitle, trimStart, trimEnd) {
        const id = 'trim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const mp3Buf = await Mp3Encoder.encode(trimmedBuffer);
        const duration = trimEnd - trimStart;
        FileStorage.set(id, mp3Buf, newTitle + '.mp3', 'audio/mpeg');
        const song = this._normalizeSong({
            id, title: newTitle, artist: originalSong.artist || '', duration,
        });
        song._isTrimmed = true;
        song._originalId = originalSong.id;
        song._originalTitle = originalSong.title;
        song._trimStart = trimStart;
        song._trimEnd = trimEnd;
        song._sampleRate = trimmedBuffer.sampleRate;
        song._channels = trimmedBuffer.numberOfChannels;
        this._songs.push(song);
        this._saveToLocal();
        return song;
    },

    renameSong(songId, newTitle) {
        const song = this._songs.find(s => s.id === songId);
        if (song) { song.title = newTitle; this._saveToLocal(); }
    },

    deleteSong(songId) {
        FileStorage.delete(songId);
        this._songs = this._songs.filter(s => s.id !== songId);
        this._saveToLocal();
    },

    _normalizeSong(song, index) {
        return {
            id: song.id || `song_${Date.now()}_${index}`,
            title: String(song.title || '未知歌曲').trim(),
            artist: String(song.artist || '').trim(),
            album: String(song.album || '').trim(),
            genre: String(song.genre || '').trim(),
            scene: String(song.scene || '').trim(),
            cue: String(song.cue || '').trim(),
            originalTitle: String(song.originalTitle || '').trim(),
            note: String(song.note || '').trim(),
            duration: song.duration || 0,
            durationStr: song.durationStr || '--:--',
            cover: song.cover || '',
            audioUrl: song.audioUrl || '',
            year: song.year || '',
            _isUploaded: !!song._isUploaded,
            _isTrimmed: !!song._isTrimmed,
            _originalId: song._originalId || null,
            _originalTitle: song._originalTitle || '',
            _trimStart: song._trimStart || 0,
            _trimEnd: song._trimEnd || 0,
            _sampleRate: song._sampleRate || 44100,
            _channels: song._channels || 2,
            _fileName: song._fileName || '',
        };
    },

    _formatDuration(seconds) {
        if (!seconds || seconds <= 0 || !isFinite(seconds)) return '--:--';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${String(s).padStart(2, '0')}`;
    },

    getAllSongs() { return [...this._songs]; },

    getGenres() { return [...new Set(this._songs.map(s => s.genre).filter(Boolean))].sort(); },
    getArtists() { return [...new Set(this._songs.map(s => s.artist).filter(Boolean))].sort(); },
    getScenes() { return [...new Set(this._songs.map(s => s.scene).filter(Boolean))].sort(); },

    getSongById(id) { return this._songs.find(s => s.id === id) || null; },

    search({ query = '', genre = '', artist = '', scene = '' } = {}) {
        let results = [...this._songs];
        const q = query.toLowerCase().trim();
        if (q) {
            results = results.filter(s =>
                s.title.toLowerCase().includes(q) ||
                s.artist.toLowerCase().includes(q) ||
                s.scene.toLowerCase().includes(q) ||
                (s.originalTitle && s.originalTitle.toLowerCase().includes(q)) ||
                (s.note && s.note.toLowerCase().includes(q))
            );
        }
        if (genre) results = results.filter(s => s.genre === genre);
        if (artist) results = results.filter(s => s.artist === artist);
        if (scene) results = results.filter(s => s.scene === scene);
        return results;
    },

    get count() { return this._songs.length; },

    getSongsWithFiles() {
        return this._songs.filter(s => FileStorage.has(s.id));
    },

    _saveToLocal() {
        try {
            const meta = this._songs.map(s => ({
                id: s.id, title: s.title, artist: s.artist, album: s.album,
                genre: s.genre, scene: s.scene, cue: s.cue,
                originalTitle: s.originalTitle, note: s.note,
                duration: s.duration, durationStr: s.durationStr,
                cover: s.cover, audioUrl: s.audioUrl, year: s.year,
                _isUploaded: s._isUploaded, _isTrimmed: s._isTrimmed,
                _originalId: s._originalId, _originalTitle: s._originalTitle,
                _trimStart: s._trimStart, _trimEnd: s._trimEnd,
                _fileName: s._fileName,
            }));
            localStorage.setItem('musicbox_library_v2', JSON.stringify(meta));
        } catch (e) { /* ignore */ }
    },

    _loadFromLocal() {
        try {
            const data = localStorage.getItem('musicbox_library_v2');
            if (data) {
                this._songs = JSON.parse(data).map((s, i) => this._normalizeSong(s, i));
                return true;
            }
        } catch (e) { /* ignore */ }
        return false;
    },

    _seedZzCeremonySongs() {
        try {
            const text = document.getElementById('preset-songs')?.textContent?.trim();
            const presets = text ? JSON.parse(text) : [];
            const expectedZzSongs = presets.filter(song => song.audioUrl?.startsWith('data/audio2/Z&Z/'));
            const previousZzSongs = this._songs.filter(song => song.audioUrl?.startsWith('data/audio2/Z&Z/'));
            const currentIds = new Set(previousZzSongs.map(song => song.id));
            const isCurrent = expectedZzSongs.length === previousZzSongs.length
                && expectedZzSongs.every(song => currentIds.has(song.id));

            // 没有 Z&Z、数量不对或仍是旧编号时，均自动修复本地曲库。
            // 这样即使浏览器曾写入旧缓存，也能正常补齐这 16 首歌曲。
            if (isCurrent) return;

            previousZzSongs.forEach(song => FileStorage.delete(song.id));
            this._songs = this._songs.filter(song => !song.audioUrl?.startsWith('data/audio2/Z&Z/'));

            const additions = expectedZzSongs
                .map((song, index) => this._normalizeSong(song, this._songs.length + index));

            if (additions.length > 0) {
                this._songs.push(...additions);
                this._saveToLocal();
            }
        } catch (e) { /* 下次启动时可再次尝试 */ }
    },

    exportLibrary() {
        return JSON.stringify(this._songs.map(s => ({
            id: s.id, title: s.title, artist: s.artist, scene: s.scene,
            cue: s.cue, originalTitle: s.originalTitle, note: s.note,
            duration: s.duration, durationStr: s.durationStr,
        })), null, 2);
    },
};

// ==================== 个人工作区（用户独立编辑空间） ====================

const Workspace = {
    STORAGE_KEY: 'musicbox_workspace_v2',
    _items: [], // { id, sourceId, title, artist, scene, cue, duration, durationStr, isTrimmed, trimStart, trimEnd, trimFileId, order }

    /** 从曲库添加歌曲到工作区 */
    addFromLibrary(librarySong) {
        if (this._items.find(item => item.sourceId === librarySong.id && !item.isTrimmed)) {
            return null; // 已存在
        }
        const item = {
            id: 'ws_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            sourceId: librarySong.id,
            title: librarySong.title,
            artist: librarySong.artist || '',
            scene: librarySong.scene || '',
            cue: librarySong.cue || '',
            duration: librarySong.duration || 0,
            durationStr: librarySong.durationStr || '--:--',
            isTrimmed: false,
            trimStart: 0,
            trimEnd: librarySong.duration || 0,
            trimFileId: null,
            order: this._items.length,
        };
        this._items.push(item);
        this._save();
        return item;
    },

    /** 工作区中重命名 */
    rename(id, newTitle) {
        const item = this._items.find(i => i.id === id);
        if (item) { item.title = newTitle; this._save(); }
    },

    /** 从工作区移除 */
    remove(id) {
        const item = this._items.find(i => i.id === id);
        if (item && item.trimFileId) {
            FileStorage.delete(item.trimFileId);
        }
        this._items = this._items.filter(i => i.id !== id);
        this._save();
    },

    /** 在工作区中保存剪辑版本 */
    async addTrimmed(wsItem, audioBuffer, newTitle, trimStart, trimEnd) {
        const trimFileId = 'trim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        const mp3Buf = await Mp3Encoder.encode(audioBuffer);
        FileStorage.set(trimFileId, mp3Buf, newTitle + '.mp3', 'audio/mpeg');
        const duration = trimEnd - trimStart;

        const newItem = {
            id: 'ws_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            sourceId: wsItem.sourceId,
            title: newTitle,
            artist: wsItem.artist,
            scene: wsItem.scene,
            cue: wsItem.cue,
            duration,
            durationStr: MusicData._formatDuration(duration),
            isTrimmed: true,
            trimStart,
            trimEnd,
            trimFileId,
            order: this._items.length,
        };
        this._items.push(newItem);
        this._save();
        return newItem;
    },

    /** 重排序 */
    reorder(fromIdx, toIdx) {
        const [moved] = this._items.splice(fromIdx, 1);
        this._items.splice(toIdx, 0, moved);
        this._save();
    },

    /** 获取工作区音频的 Blob URL */
    getAudioUrl(wsItem) {
        if (wsItem.isTrimmed && wsItem.trimFileId) {
            return FileStorage.getBlobUrl(wsItem.trimFileId);
        }
        return FileStorage.getBlobUrl(wsItem.sourceId);
    },

    /** 获取工作区音频的 ArrayBuffer */
    getAudioBuffer(wsItem) {
        if (wsItem.isTrimmed && wsItem.trimFileId) {
            return FileStorage.getBuffer(wsItem.trimFileId);
        }
        return FileStorage.getBuffer(wsItem.sourceId);
    },

    /** 是否有音频（内存中有，或曲库中有 audioUrl） */
    hasAudio(wsItem) {
        if (wsItem.isTrimmed && wsItem.trimFileId) {
            return FileStorage.has(wsItem.trimFileId);
        }
        if (FileStorage.has(wsItem.sourceId)) return true;
        // 服务器上有音频文件可拉取
        const src = MusicData.getSongById(wsItem.sourceId);
        return !!(src && src.audioUrl);
    },

    getAll() { return [...this._items]; },
    get count() { return this._items.length; },
    getById(id) { return this._items.find(i => i.id === id) || null; },

    /** 获取总时长 */
    getTotalDuration() {
        return this._items.reduce((sum, i) => sum + (i.duration || 0), 0);
    },

    /** 清空工作区 */
    clear() {
        for (const item of this._items) {
            if (item.trimFileId) FileStorage.delete(item.trimFileId);
        }
        this._items = [];
        this._save();
    },

    _save() {
        try {
            const data = this._items.map(i => ({
                id: i.id, sourceId: i.sourceId, title: i.title,
                artist: i.artist, scene: i.scene, cue: i.cue,
                duration: i.duration, durationStr: i.durationStr,
                isTrimmed: i.isTrimmed, trimStart: i.trimStart,
                trimEnd: i.trimEnd, trimFileId: i.trimFileId,
            }));
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
        } catch (e) { /* ignore */ }
    },

    _load() {
        try {
            const data = JSON.parse(localStorage.getItem(this.STORAGE_KEY));
            if (data && data.length > 0) {
                this._items = data;
                return true;
            }
        } catch (e) { /* ignore */ }
        return false;
    },
};

// ==================== 歌单管理（保存工作区快照） ====================

const PlaylistManager = {
    STORAGE_KEY: 'musicbox_playlists_v3',

    getAll() {
        try { return JSON.parse(localStorage.getItem(this.STORAGE_KEY)) || []; }
        catch (e) { return []; }
    },

    /** 保存工作区快照 */
    save(name) {
        const playlists = this.getAll();
        const idx = playlists.findIndex(p => p.name === name);
        const snapshot = Workspace.getAll().map(i => ({
            id: i.id, sourceId: i.sourceId, title: i.title,
            artist: i.artist, scene: i.scene, cue: i.cue,
            duration: i.duration, durationStr: i.durationStr,
            isTrimmed: i.isTrimmed, trimStart: i.trimStart,
            trimEnd: i.trimEnd, trimFileId: i.trimFileId,
        }));
        const entry = { name, items: snapshot, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        if (idx >= 0) playlists[idx] = entry;
        else playlists.push(entry);
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(playlists));
    },

    delete(name) {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.getAll().filter(p => p.name !== name)));
    },

    get(name) { return this.getAll().find(p => p.name === name) || null; },

    /** 加载歌单到工作区（替换当前工作区） */
    loadToWorkspace(name) {
        const playlist = this.get(name);
        if (!playlist) return false;
        Workspace.clear();
        Workspace._items = playlist.items.map(i => ({ ...i }));
        Workspace._save();
        return true;
    },

    exportJson(name) {
        const items = Workspace.getAll();
        const songs = items.map(i => ({
            title: i.title, artist: i.artist, scene: i.scene,
            cue: i.cue, duration: i.durationStr,
            isTrimmed: i.isTrimmed,
        }));
        return JSON.stringify({ playlistName: name, exportedAt: new Date().toISOString(), songs }, null, 2);
    },
};
