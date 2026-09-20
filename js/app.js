/**
 * MusicBox v2 - 婚礼音乐库 & 歌单制作
 * 音频剪辑器、ZIP 导出、拖拽上传、重命名
 */

// ==================== 音频编辑器 ====================

const AudioEditor = {
    _audioCtx: null,
    _audioBuffer: null,
    _song: null,
    _trimStart: 0,
    _trimEnd: 0,
    _duration: 0,
    _isPlaying: false,
    _playSource: null,
    _playStartTime: 0,
    _rafId: null,
    _canvasWidth: 0,
    _canvasHeight: 0,
    _peaks: [],
    _dragging: null, // 'start' | 'end' | 'playhead' | null

    /** 打开编辑器，externalBuffer 可选，传入则直接使用而不从 FileStorage 读取 */
    async open(song, externalBuffer = null) {
        const buf = externalBuffer || FileStorage.getBuffer(song.id);
        if (!buf) { App._toast('无法加载音频文件', 'error'); return; }

        this._song = song;
        this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        try {
            this._audioBuffer = await this._audioCtx.decodeAudioData(buf.slice(0));
        } catch (e) {
            App._toast('音频解码失败', 'error');
            this._audioCtx.close();
            return;
        }

        this._duration = this._audioBuffer.duration;
        this._trimStart = 0;
        this._trimEnd = this._duration;
        this._peaks = this._computePeaks(800);

        document.getElementById('editorOriginalName').textContent = song.title;
        document.getElementById('editorNewName').value = song._isTrimmed ? song.title : song.title + ' (剪辑)';
        document.getElementById('editorDuration').textContent = MusicData._formatDuration(this._duration);
        document.getElementById('editorTrimStart').value = '0:00';
        document.getElementById('editorTrimEnd').value = MusicData._formatDuration(this._duration);
        document.getElementById('editorClipDuration').textContent = MusicData._formatDuration(this._duration);

        document.getElementById('editorOverlay').style.display = 'flex';
        document.getElementById('audioEditorModal').style.display = 'flex';
        this._drawWaveform();
        this._updateTrimDisplay();
        this._bindCanvasEvents();
    },

    /** 关闭编辑器 */
    close() {
        this._stopPlayback();
        if (this._audioCtx) { this._audioCtx.close(); this._audioCtx = null; }
        this._audioBuffer = null;
        this._song = null;
        document.getElementById('editorOverlay').style.display = 'none';
        document.getElementById('audioEditorModal').style.display = 'none';
    },

    /** 计算波形峰值 */
    _computePeaks(numPeaks) {
        const data = this._audioBuffer.getChannelData(0);
        const step = Math.floor(data.length / numPeaks);
        const peaks = [];
        for (let i = 0; i < numPeaks; i++) {
            let max = 0;
            const start = i * step;
            const end = Math.min(start + step, data.length);
            for (let j = start; j < end; j++) {
                const abs = Math.abs(data[j]);
                if (abs > max) max = abs;
            }
            peaks.push(max);
        }
        return peaks;
    },

    /** 绘制波形图 */
    _drawWaveform(playheadPos = -1) {
        const canvas = document.getElementById('editorCanvas');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.parentElement.getBoundingClientRect();
        this._canvasWidth = rect.width - 32;
        this._canvasHeight = 160;
        canvas.style.width = this._canvasWidth + 'px';
        canvas.style.height = this._canvasHeight + 'px';
        canvas.width = this._canvasWidth * dpr;
        canvas.height = this._canvasHeight * dpr;

        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        const W = this._canvasWidth;
        const H = this._canvasHeight;
        const dur = this._duration;

        const theme = getComputedStyle(document.body);
        const color = (name) => theme.getPropertyValue(name).trim();
        // 编辑器与页面主题保持一致。
        ctx.fillStyle = color('--bg-input');
        ctx.fillRect(0, 0, W, H);

        // 网格线
        ctx.strokeStyle = color('--border');
        ctx.lineWidth = 0.5;
        for (let t = 0; t <= dur; t += Math.max(1, Math.floor(dur / 10))) {
            const x = (t / dur) * W;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, H);
            ctx.stroke();
        }

        // 中轴线
        ctx.strokeStyle = color('--border-light');
        ctx.beginPath();
        ctx.moveTo(0, H / 2);
        ctx.lineTo(W, H / 2);
        ctx.stroke();

        const startX = (this._trimStart / dur) * W;
        const endX = (this._trimEnd / dur) * W;

        // 未选中区域波形（灰色）
        this._drawPeaksRegion(ctx, 0, startX, color('--text-muted'), W, H);
        this._drawPeaksRegion(ctx, endX, W, color('--text-muted'), W, H);

        // 选中区域背景
        ctx.fillStyle = color('--accent-glow');
        ctx.fillRect(startX, 0, endX - startX, H);

        // 选中区域波形（亮色）
        this._drawPeaksRegion(ctx, startX, endX, color('--accent-dark'), W, H);

        // 播放头
        if (playheadPos >= 0) {
            const px = (playheadPos / dur) * W;
            ctx.strokeStyle = '#f87171';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(px, 0);
            ctx.lineTo(px, H);
            ctx.stroke();
        }

        // 边界线 + 拖拽手柄
        this._drawHandle(ctx, startX, H, '#34d399', '▶');
        this._drawHandle(ctx, endX, H, '#f87171', '⏹');

        // 时间刻度
        ctx.fillStyle = color('--text-muted');
        ctx.font = '10px system-ui';
        for (let t = 0; t <= dur; t += Math.max(1, Math.floor(dur / 8))) {
            const x = (t / dur) * W;
            ctx.fillText(MusicData._formatDuration(t), x + 2, H - 6);
        }
    },

    _drawPeaksRegion(ctx, xStart, xEnd, color, W, H) {
        if (xStart >= xEnd) return;
        const peaks = this._peaks;
        const xMin = Math.max(0, Math.floor((xStart / W) * peaks.length));
        const xMax = Math.min(peaks.length, Math.ceil((xEnd / W) * peaks.length));

        ctx.fillStyle = color;
        const barW = Math.max(1, W / peaks.length);
        for (let i = xMin; i < xMax; i++) {
            const h = peaks[i] * (H / 2 - 8);
            const x = (i / peaks.length) * W;
            ctx.fillRect(x, H / 2 - h, barW + 0.5, h * 2);
        }
    },

    _drawHandle(ctx, x, H, color, label) {
        // 竖线
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
        ctx.setLineDash([]);

        // 拖拽三角
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, H - 4);
        ctx.lineTo(x - 8, H - 18);
        ctx.lineTo(x + 8, H - 18);
        ctx.closePath();
        ctx.fill();
    },

    _bindCanvasEvents() {
        const canvas = document.getElementById('editorCanvas');
        canvas.onmousedown = (e) => this._onCanvasMouseDown(e);
        canvas.onmousemove = (e) => this._onCanvasMouseMove(e);
        canvas.onmouseup = () => { this._dragging = null; };
        canvas.onmouseleave = () => { this._dragging = null; };
        canvas.addEventListener('wheel', (e) => { e.preventDefault(); });
    },

    _onCanvasMouseDown(e) {
        const rect = e.target.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const dur = this._duration;
        const W = this._canvasWidth;
        const pos = (x / W) * dur;

        const startX = (this._trimStart / dur) * W;
        const endX = (this._trimEnd / dur) * W;
        const threshold = 12;

        if (Math.abs(x - startX) < threshold) {
            this._dragging = 'start';
        } else if (Math.abs(x - endX) < threshold) {
            this._dragging = 'end';
        } else if (pos >= this._trimStart && pos <= this._trimEnd) {
            // 点击选中区域 → 跳转播放头
            this._previewAt(pos);
        }
    },

    _onCanvasMouseMove(e) {
        if (!this._dragging) return;
        const rect = e.target.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const dur = this._duration;
        const W = this._canvasWidth;
        const pos = Math.max(0, Math.min(dur, (x / W) * dur));

        if (this._dragging === 'start') {
            this._trimStart = Math.min(pos, this._trimEnd - 0.1);
        } else if (this._dragging === 'end') {
            this._trimEnd = Math.max(pos, this._trimStart + 0.1);
        }
        this._drawWaveform();
        this._updateTrimDisplay();
    },

    _updateTrimDisplay() {
        document.getElementById('editorTrimStart').value = MusicData._formatDuration(this._trimStart);
        document.getElementById('editorTrimEnd').value = MusicData._formatDuration(this._trimEnd);
        const clipDur = this._trimEnd - this._trimStart;
        document.getElementById('editorClipDuration').textContent = MusicData._formatDuration(clipDur);
    },

    /** 手动输入时间 */
    applyTimeInputs() {
        const startStr = document.getElementById('editorTrimStart').value;
        const endStr = document.getElementById('editorTrimEnd').value;
        const start = this._parseTime(startStr);
        const end = this._parseTime(endStr);
        if (start !== null && end !== null && start < end && end <= this._duration) {
            this._trimStart = start;
            this._trimEnd = end;
            this._drawWaveform();
            this._updateTrimDisplay();
        } else {
            App._toast('时间格式无效', 'error');
            this._updateTrimDisplay();
        }
    },

    _parseTime(str) {
        const parts = str.split(':');
        if (parts.length === 2) {
            const m = parseInt(parts[0]), s = parseFloat(parts[1]);
            if (!isNaN(m) && !isNaN(s)) return m * 60 + s;
        }
        if (parts.length === 1) {
            const s = parseFloat(parts[0]);
            if (!isNaN(s)) return s;
        }
        return null;
    },

    /** 预览剪辑片段 */
    async togglePreview() {
        if (this._isPlaying) {
            this._stopPlayback();
            document.getElementById('btnEditorPlay').textContent = '▶ 预览剪辑';
            return;
        }
        this._isPlaying = true;
        document.getElementById('btnEditorPlay').textContent = '⏸ 停止';

        const source = this._audioCtx.createBufferSource();
        source.buffer = this._audioBuffer;
        source.connect(this._audioCtx.destination);
        source.start(0, this._trimStart, this._trimEnd - this._trimStart);
        this._playSource = source;
        this._playStartTime = this._audioCtx.currentTime;

        source.onended = () => {
            this._isPlaying = false;
            document.getElementById('btnEditorPlay').textContent = '▶ 预览剪辑';
            this._playSource = null;
            cancelAnimationFrame(this._rafId);
            this._drawWaveform();
        };

        this._updatePlayhead();
    },

    _previewAt(time) {
        this._stopPlayback();
        this._isPlaying = true;
        document.getElementById('btnEditorPlay').textContent = '⏸ 停止';

        const source = this._audioCtx.createBufferSource();
        source.buffer = this._audioBuffer;
        source.connect(this._audioCtx.destination);
        const startOffset = Math.max(this._trimStart, time);
        source.start(0, startOffset, this._trimEnd - startOffset);
        this._playSource = source;
        this._playStartTime = this._audioCtx.currentTime - (time - startOffset);

        source.onended = () => {
            this._isPlaying = false;
            document.getElementById('btnEditorPlay').textContent = '▶ 预览剪辑';
            this._playSource = null;
            cancelAnimationFrame(this._rafId);
            this._drawWaveform();
        };
        this._updatePlayhead();
    },

    _updatePlayhead() {
        if (!this._isPlaying) return;
        const elapsed = this._audioCtx.currentTime - this._playStartTime;
        const pos = this._trimStart + elapsed;
        this._drawWaveform(pos);
        if (pos < this._trimEnd) {
            this._rafId = requestAnimationFrame(() => this._updatePlayhead());
        }
    },

    _stopPlayback() {
        this._isPlaying = false;
        if (this._playSource) {
            try { this._playSource.stop(); } catch (e) { /* already stopped */ }
            this._playSource = null;
        }
        cancelAnimationFrame(this._rafId);
    },

    /** 保存剪辑 → 工作区 */
    async saveTrimmed() {
        const newTitle = document.getElementById('editorNewName').value.trim() || (this._song.title + ' (剪辑)');
        const clipDur = this._trimEnd - this._trimStart;
        if (clipDur < 0.5) { App._toast('剪辑片段太短（至少0.5秒）', 'error'); return; }

        const sampleRate = this._audioBuffer.sampleRate;
        const channels = this._audioBuffer.numberOfChannels;
        const length = Math.floor(clipDur * sampleRate);

        const offlineCtx = new OfflineAudioContext(channels, length, sampleRate);
        const source = offlineCtx.createBufferSource();
        source.buffer = this._audioBuffer;
        source.connect(offlineCtx.destination);
        source.start(0, this._trimStart, clipDur);

        const rendered = await offlineCtx.startRendering();

        // 保存到工作区
        const wsItem = App._editingWsItem;
        if (wsItem) {
            App._toast('正在编码 MP3...', '');
            await Workspace.addTrimmed(wsItem, rendered, newTitle, this._trimStart, this._trimEnd);
            App._editingWsItem = null;
        } else {
            // 向后兼容：如果没有工作区上下文，添加到曲库
            App._toast('正在编码 MP3...', '');
            await MusicData.addTrimmedSong(this._song, rendered, newTitle, this._trimStart, this._trimEnd);
        }

        this.close();
        App.renderWorkspace();
        App._toast(`剪辑已保存到工作区：${newTitle}`, 'success');
    },
};

// ==================== 浮动音符生成器 ====================

const FloatingNotes = {
    _container: null,
    _notes: ['🎵', '🎶', '🎼', '♫', '♪', '🎤', '🎹', '🎸', '🎺', '🥁', '🎻', '🎷'],
    _timer: null,

    start() {
        if (this._timer) return;
        this._container = document.querySelector('.floating-notes');
        if (!this._container) return;
        this._container.innerHTML = '';
        this._spawn();
    },

    _spawn() {
        const note = document.createElement('span');
        note.className = 'note-dynamic';
        note.textContent = this._notes[Math.floor(Math.random() * this._notes.length)];

        // 随机属性
        const left = Math.random() * 90;
        const size = 1.4 + Math.random() * 3.2;
        const duration = 5 + Math.random() * 10;
        const delay = Math.random() * 6;
        const sway = (Math.random() - 0.5) * 100;

        note.style.cssText = `
            position: absolute;
            left: ${left}%;
            bottom: -30px;
            font-size: ${size}rem;
            opacity: 0;
            pointer-events: none;
            animation: floatRandom ${duration}s ease-in ${delay}s;
            --sway: ${sway}px;
        `;

        note.addEventListener('animationend', () => note.remove());
        this._container.appendChild(note);

        // 随机间隔再生成下一个
        const next = 600 + Math.random() * 2500;
        this._timer = setTimeout(() => this._spawn(), next);
    },
};

// ==================== 网页宠物 ====================

const WebPet = {
    _dragging: false,
    _offsetX: 0,
    _offsetY: 0,

    start() {
        const pet = document.getElementById('webPet');
        if (!pet) return;

        const closeButton = document.getElementById('webPetClose');
        if (closeButton) {
            closeButton.addEventListener('click', (event) => {
                event.stopPropagation();
                pet.style.display = 'none';
            });
        }

        pet.addEventListener('pointerdown', (event) => {
            if (event.target.closest('.web-pet-close')) return;
            const rect = pet.getBoundingClientRect();
            this._dragging = true;
            this._offsetX = event.clientX - rect.left;
            this._offsetY = event.clientY - rect.top;
            pet.classList.add('dragging');
            pet.setPointerCapture(event.pointerId);
        });

        pet.addEventListener('pointermove', (event) => {
            if (!this._dragging) return;
            const maxLeft = Math.max(0, window.innerWidth - pet.offsetWidth);
            const maxTop = Math.max(0, window.innerHeight - pet.offsetHeight);
            const left = Math.max(0, Math.min(maxLeft, event.clientX - this._offsetX));
            const top = Math.max(0, Math.min(maxTop, event.clientY - this._offsetY));
            pet.style.left = `${left}px`;
            pet.style.top = `${top}px`;
            pet.style.right = 'auto';
            pet.style.bottom = 'auto';
        });

        const stopDragging = (event) => {
            if (!this._dragging) return;
            this._dragging = false;
            pet.classList.remove('dragging');
            if (event && pet.hasPointerCapture(event.pointerId)) {
                pet.releasePointerCapture(event.pointerId);
            }
        };
        pet.addEventListener('pointerup', stopDragging);
        pet.addEventListener('pointercancel', stopDragging);

        window.addEventListener('pointermove', (event) => {
            if (this._dragging) return;
            const rect = pet.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height * 0.36;
            const x = Math.max(-5, Math.min(5, (event.clientX - centerX) / 90));
            const y = Math.max(-4, Math.min(4, (event.clientY - centerY) / 90));
            pet.style.setProperty('--look-x', `${x}px`);
            pet.style.setProperty('--look-y', `${y}px`);
        }, { passive: true });
    },
};

// ==================== 背景粒子动画 ====================

const ParticleBg = {
    _canvas: null,
    _ctx: null,
    _particles: [],
    _animId: null,
    _onResize: null,
    _motionQuery: null,
    _onMotionChange: null,
    _lastFrame: null,

    start() {
        // 页面热更新或重复初始化时，停止旧实例，避免叠加多个 canvas 和粒子群。
        if (this._canvas) return;
        if (window.__musicParticleBgStop) window.__musicParticleBgStop();
        window.__musicParticleBgStop = () => this.stop();
        const existingCanvas = document.getElementById('particleCanvas');
        if (existingCanvas) existingCanvas.remove();
        this._canvas = document.createElement('canvas');
        this._canvas.id = 'particleCanvas';
        Object.assign(this._canvas.style, {
            position: 'fixed', inset: '0', zIndex: '2',
            pointerEvents: 'none',
        });
        document.body.prepend(this._canvas);
        this._ctx = this._canvas.getContext('2d');
        this._resize();
        this._onResize = () => {
            this._resize();
            if (this._motionQuery && this._motionQuery.matches) this._animate();
        };
        window.addEventListener('resize', this._onResize);

        // 浅香槟底上的金色与灰玉色细点。
        this._particles = [];
        const count = window.innerWidth < 768 ? 16 : 36;
        const colors = [
            '173, 133, 65',
            '197, 165, 105',
            '214, 187, 133',
            '152, 170, 151',
        ];
        for (let i = 0; i < count; i++) {
            const isLarge = Math.random() < 0.16;
            this._particles.push({
                x: Math.random() * this._canvas.width,
                y: Math.random() * this._canvas.height,
                r: isLarge ? Math.random() * 2.1 + 2.1 : Math.random() * 1.55 + 0.55,
                vy: -(Math.random() * (isLarge ? 0.065 : 0.11) + 0.035),
                alpha: isLarge ? Math.random() * 0.2 + 0.36 : Math.random() * 0.25 + 0.24,
                pulse: Math.random() * Math.PI * 2,
                pulseSpeed: Math.random() * 0.014 + 0.006,
                color: colors[Math.floor(Math.random() * colors.length)],
            });
        }
        this._motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        this._onMotionChange = () => {
            if (this._animId) cancelAnimationFrame(this._animId);
            this._animId = null;
            this._lastFrame = null;
            this._animate();
        };
        this._motionQuery.addEventListener('change', this._onMotionChange);
        this._animate();
    },

    _resize() {
        this._canvas.width = window.innerWidth;
        this._canvas.height = window.innerHeight;
    },

    _animate(timestamp = performance.now()) {
        const reduced = this._motionQuery.matches;
        const elapsed = this._lastFrame === null ? 0 : Math.min(50, timestamp - this._lastFrame);
        this._lastFrame = timestamp;
        const step = reduced || document.body.classList.contains('ambient-muted') ? 0 : elapsed / (1000 / 60);
        if (!reduced) this._animId = requestAnimationFrame(time => this._animate(time));
        const ctx = this._ctx;
        const W = this._canvas.width;
        const H = this._canvas.height;
        ctx.clearRect(0, 0, W, H);

        for (const p of this._particles) {
            p.y += p.vy * step;
            p.pulse += p.pulseSpeed * step;
            if (p.y < -18) {
                p.y = H + 18;
                p.x = Math.random() * W;
            }

            const breathe = 0.65 + Math.sin(p.pulse) * 0.35;
            const alpha = p.alpha * breathe;

            // 清晰的实体亮点，不使用模糊光晕。
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${p.color}, ${Math.min(0.82, alpha)})`;
            ctx.fill();
        }
    },

    stop() {
        if (this._animId) cancelAnimationFrame(this._animId);
        if (this._motionQuery && this._onMotionChange) this._motionQuery.removeEventListener('change', this._onMotionChange);
        if (this._onResize) window.removeEventListener('resize', this._onResize);
        if (this._canvas) this._canvas.remove();
        this._animId = null;
        this._canvas = null;
        this._ctx = null;
        this._onResize = null;
        this._motionQuery = null;
        this._onMotionChange = null;
        this._lastFrame = null;
    },
};

// ==================== 主应用 ====================

/**
 * 无依赖 ZIP 回退实现。
 * 使用 ZIP 的“存储”模式，不压缩音频，避免离线导出依赖 CDN。
 */
class LocalZip {
    constructor() { this.files = []; }

    file(name, content) {
        const data = content instanceof ArrayBuffer
            ? new Uint8Array(content)
            : content instanceof Uint8Array
                ? content
                : new TextEncoder().encode(String(content));
        this.files.push({ name, data });
        return this;
    }

    async generateAsync() {
        const encoder = new TextEncoder();
        const localParts = [];
        const centralParts = [];
        let offset = 0;

        for (const file of this.files) {
            const name = encoder.encode(file.name);
            const crc = LocalZip._crc32(file.data);
            const local = new Uint8Array(30 + name.length + file.data.length);
            const view = new DataView(local.buffer);
            view.setUint32(0, 0x04034b50, true);
            view.setUint16(4, 20, true);
            view.setUint16(6, 0x800, true); // UTF-8 filename
            view.setUint16(8, 0, true); // stored, no compression
            view.setUint32(14, crc, true);
            view.setUint32(18, file.data.length, true);
            view.setUint32(22, file.data.length, true);
            view.setUint16(26, name.length, true);
            local.set(name, 30);
            local.set(file.data, 30 + name.length);
            localParts.push(local);

            const central = new Uint8Array(46 + name.length);
            const centralView = new DataView(central.buffer);
            centralView.setUint32(0, 0x02014b50, true);
            centralView.setUint16(4, 20, true);
            centralView.setUint16(6, 20, true);
            centralView.setUint16(8, 0x800, true);
            centralView.setUint16(10, 0, true);
            centralView.setUint32(16, crc, true);
            centralView.setUint32(20, file.data.length, true);
            centralView.setUint32(24, file.data.length, true);
            centralView.setUint16(28, name.length, true);
            centralView.setUint32(42, offset, true);
            central.set(name, 46);
            centralParts.push(central);
            offset += local.length;
        }

        const centralOffset = offset;
        const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
        const end = new Uint8Array(22);
        const endView = new DataView(end.buffer);
        endView.setUint32(0, 0x06054b50, true);
        endView.setUint16(8, this.files.length, true);
        endView.setUint16(10, this.files.length, true);
        endView.setUint32(12, centralSize, true);
        endView.setUint32(16, centralOffset, true);
        return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
    }

    static _crc32(data) {
        let crc = 0xffffffff;
        for (const byte of data) {
            crc ^= byte;
            for (let i = 0; i < 8; i++) {
                crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
            }
        }
        return (crc ^ 0xffffffff) >>> 0;
    }
}

const App = {
    // 当前编辑上下文（workspace 中的哪个 item）
    _editingWsItem: null,
    _isLoading: false,
    _foldersCollapsed: false,
    _atelierClockTimer: null,

    player: {
        audio: null,
        currentIndex: -1,
        playlist: [],
        isPlaying: false,
    },

    // ==================== 初始化 ====================

    async init() {
        // 立即显示加载状态
        this._isLoading = true;
        this.renderLibrary();

        // 启动背景粒子动画
        ParticleBg.start();
        // 启动网页宠物的视线跟随
        WebPet.start();

        // 从 IndexedDB 恢复音频文件
        const restored = await FileStorage.restoreFromDB();
        if (restored > 0) console.log(`从缓存恢复了 ${restored} 个音频文件`);

        // 加载曲库元数据（始终从内嵌数据加载）
        await MusicData.loadDefaultLibrary();
        this._isLoading = false;
        // 加载工作区
        Workspace._load();

        this.renderLibrary();
        this.renderWorkspace();
        this.renderSavedPlaylists();
        this._bindEvents();
        this._startAtelierClock();

        // 为工作区中已有的歌曲加载音频（从上次会话恢复的条目）
        this._loadAudioForWorkspace();

        this.player.audio = new Audio();
        this.player.audio.addEventListener('timeupdate', () => this._updateProgress());
        this.player.audio.addEventListener('ended', () => this._next());
        this.player.audio.addEventListener('loadedmetadata', () => this._updateProgress());
        this.player.audio.volume = 0.7;
    },

    /** 是否触屏设备（手机/平板/触屏笔记本） */
    _isTouch() {
        return window.matchMedia('(pointer: coarse)').matches
            || navigator.maxTouchPoints > 0
            || 'ontouchstart' in window;
    },

    /** 为工作区中所有条目加载音频（后台静默执行） */
    _loadAudioForWorkspace() {
        const items = Workspace.getAll();
        for (const item of items) {
            if (item.isTrimmed) continue;
            const song = MusicData.getSongById(item.sourceId);
            if (song) this._loadAudioForSong(song);
        }
    },

    // ==================== 事件绑定 ====================

    _bindEvents() {
        document.getElementById('searchInput').addEventListener('input', () => this.renderLibrary());

        // 移动端底部 Tab 切换
        document.querySelectorAll('.mobile-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const panel = document.getElementById(tab.dataset.panel);
                if (!panel) return;
                document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
                panel.classList.add('active');
                document.querySelectorAll('.mobile-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
            });
        });

        // 上传 MP3（仅管理员）
        document.getElementById('btnUpload').addEventListener('click', () => {
            const pw = prompt('🔐 管理员验证 — 请输入密码：');
            if (pw === 'ting2026') {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.mp3';
                input.multiple = true;
                input.onchange = (e) => this._handleUpload(e);
                input.click();
            } else if (pw !== null) {
                this._toast('密码错误，仅管理员可更改曲库', 'error');
            }
        });
        document.getElementById('fileUploadMp3').addEventListener('change', (e) => this._handleUpload(e));

        // 拖拽上传
        const dropZone = document.getElementById('panelLibrary');
        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over-zone'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over-zone'));
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('drag-over-zone');
            if (e.dataTransfer.files.length > 0) this._handleUploadFiles(e.dataTransfer.files);
        });

        // 导出 ZIP
        document.getElementById('btnExportZip').addEventListener('click', () => this._exportZip());
        document.getElementById('btnRandomSong').addEventListener('click', () => this._playRandomSong());
        document.getElementById('btnAmbient').addEventListener('click', () => this._toggleAmbient());
        document.getElementById('btnToggleFolders').addEventListener('click', () => this._toggleFolders());
        document.getElementById('btnFocusWorkspace').addEventListener('click', () => this._focusWorkspace());
        // 导出信息
        document.getElementById('btnExportPlaylist').addEventListener('click', () => this._exportWorkspaceInfo());

        // 清空工作区
        document.getElementById('btnClearPlaylist').addEventListener('click', () => {
            if (Workspace.count === 0) return;
            if (confirm('确定要清空工作区吗？（剪辑文件将丢失）')) {
                Workspace.clear();
                this.renderLibrary();
                this.renderWorkspace();
                this._toast('工作区已清空');
            }
        });

        // 保存/加载歌单
        document.getElementById('btnSavePlaylist').addEventListener('click', () => this._savePlaylist());
        document.getElementById('btnLoadPlaylist').addEventListener('click', () => this._loadPlaylist());
        document.getElementById('btnDeleteSaved').addEventListener('click', () => this._deleteSavedPlaylist());

        // 编辑器
        document.getElementById('editorClose').addEventListener('click', () => AudioEditor.close());
        document.getElementById('editorOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) AudioEditor.close(); });
        document.getElementById('btnEditorPlay').addEventListener('click', () => AudioEditor.togglePreview());
        document.getElementById('btnEditorSave').addEventListener('click', () => AudioEditor.saveTrimmed());
        document.getElementById('btnEditorApplyTime').addEventListener('click', () => AudioEditor.applyTimeInputs());

        // 播放器
        document.getElementById('btnPlay').addEventListener('click', () => this._togglePlay());
        document.getElementById('btnPrev').addEventListener('click', () => this._prev());
        document.getElementById('btnNext').addEventListener('click', () => this._next());
        document.getElementById('progressBar').addEventListener('input', (e) => this._seek(e.target.value));
        document.getElementById('volumeBar').addEventListener('input', (e) => { this.player.audio.volume = e.target.value / 100; });

        // 键盘
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
            if (e.code === 'Space') { e.preventDefault(); this._togglePlay(); }
            if (e.code === 'Escape') AudioEditor.close();
        });
    },

    // ==================== 渲染：音乐库（浏览，仅 + 按钮） ====================

    renderLibrary() {
        const query = document.getElementById('searchInput').value.toLowerCase().trim();
        const allSongs = MusicData.getAllSongs();
        const container = document.getElementById('libraryList');
        document.getElementById('libraryCount').textContent = `${MusicData.count} 首`;
        this._updateAtelierStats();

        if (this._isLoading) {
            container.innerHTML = `<div class="empty-state"><div class="empty-icon">⏳</div><p>正在加载音乐库...</p></div>`;
            return;
        }
        if (allSongs.length === 0) {
            container.innerHTML = `<div class="empty-state"><div class="empty-icon">🎶</div><p>还没有歌曲</p></div>`;
            return;
        }

        // 搜索时只按歌曲名称匹配，并将结果按名称排序展示。
        // 不搜索歌手、环节、备注等字段，避免曲库较小时产生不必要的区分。
        const tree = {};
        if (query) {
            const results = allSongs
                .filter(song => String(song.title || '').toLowerCase().includes(query))
                .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
            tree['搜索结果'] = { subs: {}, songs: results };
        } else {
            // 未搜索时按 audioUrl 路径构建文件夹树
            for (const song of allSongs) {
                let path = (song.audioUrl || '').replace(/^.*?data\/audio2?\//, '');
                const parts = path.split('/');
                const parent = parts[0] || '其他';
                const child = parts.length > 2 ? parts[1] : null;
                if (!tree[parent]) tree[parent] = { subs: {}, songs: [] };
                if (child) {
                    if (!tree[parent].subs[child]) tree[parent].subs[child] = [];
                    tree[parent].subs[child].push(song);
                } else {
                    tree[parent].songs.push(song);
                }
            }
            // 预留一个空的 D&L 文件夹，方便后续继续添加歌曲。
            tree['D&L'] = { subs: {}, songs: [] };
        }

        if (Object.keys(tree).length === 0) {
            container.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><p>没有匹配的歌曲</p></div>`;
            return;
        }

        let html = '';
        const topFolders = Object.keys(tree); // 保持 JSON 中的文件夹顺序
        for (const folder of topFolders) {
            const group = tree[folder];
            const totalInFolder = group.songs.length + Object.values(group.subs).reduce((s, arr) => s + arr.length, 0);
            html += `<div class="folder-group open">`;
            html += `<div class="folder-header" data-folder="${this._esc(folder)}">`;
            html += `<span class="folder-arrow">▶</span>`;
            html += `<span class="folder-icon">📁</span>`;
            html += `<span>${this._esc(folder)}</span>`;
            html += `<span class="folder-count">${totalInFolder}</span>`;
            html += `</div><div class="folder-children">`;

            // 直接在此文件夹下的歌曲
            for (const song of group.songs) {
                html += this._renderSongCard(song);
            }

            // 子文件夹
            const subFolders = Object.keys(group.subs); // 保持插入顺序
            for (const sub of subFolders) {
                html += `<div class="folder-sub open">`;
                html += `<div class="folder-header" data-folder="${this._esc(folder)}/${this._esc(sub)}">`;
                html += `<span class="folder-arrow">▶</span>`;
                html += `<span class="folder-icon">📂</span>`;
                html += `<span>${this._esc(sub)}</span>`;
                html += `<span class="folder-count">${group.subs[sub].length}</span>`;
                html += `</div><div class="folder-children">`;
                for (const song of group.subs[sub]) {
                    html += this._renderSongCard(song);
                }
                html += `</div></div>`;
            }

            html += `</div></div>`;
        }

        container.innerHTML = html;

        // 绑定折叠事件
        container.querySelectorAll('.folder-header').forEach(header => {
            header.addEventListener('click', () => {
                const group = header.closest('.folder-group, .folder-sub');
                group.classList.toggle('open');
            });
        });

        // 绑定歌曲卡片事件
        container.querySelectorAll('.song-card').forEach(card => {
            const songId = card.dataset.id;
            if (this._isTouch()) {
                // 触屏：单击卡片主体即试听（操作按钮不拦截）
                card.addEventListener('click', (e) => {
                    if (e.target.closest('.song-actions')) return;
                    this._playLibrarySong(songId);
                });
            } else {
                card.addEventListener('dblclick', () => this._playLibrarySong(songId));
            }
            const addButton = card.querySelector('[data-action="add"]');
            if (addButton) addButton.addEventListener('click', (e) => {
                e.stopPropagation();
                this._addToWorkspace(songId);
            });
            const deleteButton = card.querySelector('[data-action="delete"]');
            if (deleteButton) deleteButton.addEventListener('click', (e) => {
                e.stopPropagation();
                this._deleteFromLibrary(songId);
            });
        });
    },

    _renderSongCard(song) {
        const hasAudio = FileStorage.has(song.id) || !!song.audioUrl;
        const audioDot = hasAudio ? '<span class="audio-dot" title="可播放">🟢</span>' : '<span class="audio-dot dim" title="无音频">⚪</span>';
        return `
            <div class="song-card" data-id="${song.id}">
                <div class="song-cover">🎵</div>
                <div class="song-info">
                    <div class="song-title">${audioDot}${this._esc(song.title)}</div>
                </div>
                <div class="song-duration">${song.durationStr}</div>
                <div class="song-actions">
                    <button class="btn-add" title="添加到我的工作区" data-action="add" data-id="${song.id}">+</button>
                    <button class="btn-del" title="从曲库删除（需管理员密码）" data-action="delete" data-id="${song.id}">×</button>
                </div>
            </div>`;
    },

    /** 从曲库中删除歌曲 */
    _deleteFromLibrary(songId) {
        const song = MusicData.getSongById(songId);
        if (!song) return;
        const pw = prompt(`🔐 管理员验证 — 确认删除「${song.title}」？\n请输入密码：`);
        if (pw === 'ting2026') {
            MusicData.deleteSong(songId);
            this.renderLibrary();
            this._toast(`已删除：${song.title}`, 'success');
        } else if (pw !== null) {
            this._toast('密码错误，仅管理员可删除', 'error');
        }
    },

    // ==================== 渲染：我的工作区（可编辑） ====================

    renderWorkspace() {
        const container = document.getElementById('playlistList');
        const items = Workspace.getAll();
        document.getElementById('playlistCount').textContent = `${items.length} 首`;
        document.getElementById('playlistTotalDuration').textContent = MusicData._formatDuration(Workspace.getTotalDuration());
        this._updateAtelierStats();

        // 更新移动端工作区 Tab 徽章
        const wsBadge = document.getElementById('mobileWsBadge');
        if (wsBadge) {
            wsBadge.textContent = items.length;
            wsBadge.hidden = items.length === 0;
        }

        if (items.length === 0) {
            container.innerHTML = `<div class="empty-state"><div class="empty-icon">🛠️</div><p>工作区是空的</p><p class="empty-hint">从左侧音乐库点击 <strong>+</strong> 添加歌曲到工作区</p></div>`;
            return;
        }

        container.innerHTML = items.map((item, index) => {
            const isTrimmed = item.isTrimmed;
            const badge = isTrimmed ? '<span class="badge badge-trim">✂️ 已剪辑</span>' : '';
            const srcSong = MusicData.getSongById(item.sourceId);
            const hasAudio = Workspace.hasAudio(item);

            return `
            <div class="song-card ws-card" data-ws-id="${item.id}" data-index="${index}" draggable="true">
                <span class="song-number">${index + 1}</span>
                <div class="song-cover">🎵</div>
                <div class="song-info">
                    <div class="song-title">${this._esc(item.title)}${badge}</div>
                    <div class="song-meta">${this._esc(item.artist || (srcSong ? srcSong.artist : ''))}${item.scene ? ` · ${this._esc(item.scene)}` : ''}</div>
                </div>
                <div class="song-duration">${item.durationStr}</div>
                <div class="song-actions">
                    ${hasAudio ? `<button class="btn-icon-mini" title="剪辑此歌曲" data-action="edit-ws" data-ws-id="${item.id}">✂️</button>` : ''}
                    <button class="btn-icon-mini" title="重命名" data-action="rename-ws" data-ws-id="${item.id}">✏️</button>
                    <button class="btn-remove" title="从工作区移除" data-action="remove-ws" data-ws-id="${item.id}">✕</button>
                </div>
            </div>`;
        }).join('');

        container.querySelectorAll('.ws-card').forEach(card => {
            const wsId = card.dataset.wsId;
            if (this._isTouch()) {
                // 触屏：单击卡片主体即播放（操作按钮不拦截）
                card.addEventListener('click', (e) => {
                    if (e.target.closest('.song-actions')) return;
                    this._playWorkspaceSong(wsId);
                });
            } else {
                card.addEventListener('dblclick', () => this._playWorkspaceSong(wsId));
            }
            const editButton = card.querySelector('[data-action="edit-ws"]');
            if (editButton) editButton.addEventListener('click', (e) => { e.stopPropagation(); this._openEditorForWs(wsId); });
            const renameButton = card.querySelector('[data-action="rename-ws"]');
            if (renameButton) renameButton.addEventListener('click', (e) => { e.stopPropagation(); this._renameWsItem(wsId); });
            const removeButton = card.querySelector('[data-action="remove-ws"]');
            if (removeButton) removeButton.addEventListener('click', (e) => { e.stopPropagation(); this._removeFromWorkspace(wsId); });
            card.addEventListener('dragstart', (e) => this._onDragStart(e));
            card.addEventListener('dragover', (e) => this._onDragOver(e));
            card.addEventListener('dragleave', (e) => this._onDragLeave(e));
            card.addEventListener('drop', (e) => this._onDrop(e));
            card.addEventListener('dragend', (e) => this._onDragEnd(e));
        });
    },

    // ==================== 工作区操作 ====================

    _loadingSongs: new Set(),

    async _addToWorkspace(songId) {
        const song = MusicData.getSongById(songId);
        if (!song) return;

        // 已存在检查
        if (Workspace.getAll().find(item => item.sourceId === songId && !item.isTrimmed)) {
            this._toast('这首歌已在工作区中', 'error');
            return;
        }
        if (this._loadingSongs.has(song.id)) {
            this._toast('正在加载中，请稍候...', '');
            return;
        }
        if (!song.audioUrl) {
            this._toast('该歌曲没有音频文件', 'error');
            return;
        }

        // 开始加载，显示进度条
        this._loadingSongs.add(song.id);
        this._showProgress(`正在加载：${song.title}`);

        let buf = null;
        if (FileStorage.has(song.id)) {
            buf = FileStorage.getBuffer(song.id);
            this._updateProgressBar(100);
        } else {
            buf = await MusicData._fetchAudioWithProgress(song.audioUrl, (pct) => {
                this._updateProgressBar(pct);
            });
        }

        this._loadingSongs.delete(song.id);
        this._hideProgress();

        if (!buf) {
            this._toast(`加载失败：${song.title}`, 'error');
            return;
        }

        // 存入内存
        FileStorage.set(song.id, buf, song.audioUrl.split('/').pop(), 'audio/mpeg');
        try { await MusicData._detectDuration(song.id); } catch (e) { /* skip */ }

        // 加载完成 → 才加入工作区
        const result = Workspace.addFromLibrary(song);
        this.renderWorkspace();
        this._toast(`✅ 已添加：${song.title}`, 'success');
    },

    /** 显示加载进度条 */
    _showProgress(title) {
        document.getElementById('loadProgressTitle').textContent = title;
        document.getElementById('loadProgressPct').textContent = '0%';
        document.getElementById('loadProgressFill').style.width = '0%';
        document.getElementById('loadProgress').style.display = 'block';
    },

    /** 更新进度条 */
    _updateProgressBar(pct) {
        document.getElementById('loadProgressPct').textContent = pct + '%';
        document.getElementById('loadProgressFill').style.width = pct + '%';
    },

    /** 隐藏进度条 */
    _hideProgress() {
        document.getElementById('loadProgress').style.display = 'none';
    },

    /** 后台加载歌曲音频到内存（用于恢复会话），不显示进度条 */
    async _loadAudioForSong(song) {
        if (!song.audioUrl) return;
        if (FileStorage.has(song.id)) return;
        if (this._loadingSongs.has(song.id)) return;

        this._loadingSongs.add(song.id);
        let buf = null;
        try {
            buf = await MusicData._fetchAudio(song.audioUrl);
        } catch (e) {
            buf = null;
        }
        this._loadingSongs.delete(song.id);

        if (buf) {
            FileStorage.set(song.id, buf, song.audioUrl.split('/').pop(), 'audio/mpeg');
            try { await MusicData._detectDuration(song.id); } catch (e) { /* skip */ }
            this.renderWorkspace();
        }
    },

    _removeFromWorkspace(wsId) {
        const item = Workspace.getById(wsId);
        Workspace.remove(wsId);
        this.renderWorkspace();
        if (item) this._toast(`已移除：${item.title}`);
    },

    _renameWsItem(wsId) {
        const item = Workspace.getById(wsId);
        if (!item) return;
        const newTitle = prompt('重命名：', item.title);
        if (newTitle && newTitle.trim()) {
            Workspace.rename(wsId, newTitle.trim());
            this.renderWorkspace();
            this._toast(`已重命名：${newTitle.trim()}`, 'success');
        }
    },

    _openEditorForWs(wsId) {
        const item = Workspace.getById(wsId);
        if (!item) return;

        // 检查音频是否在内存中
        const buf = Workspace.getAudioBuffer(item);
        if (buf) { this._launchEditor(item, buf); return; }

        // 不在内存 → 从服务器拉取
        const srcSong = MusicData.getSongById(item.sourceId);
        if (!srcSong || !srcSong.audioUrl) {
            this._toast('该歌曲没有音频文件', 'error');
            return;
        }
        this._toast('正在加载音频...', '');
        MusicData._fetchAudio(srcSong.audioUrl).then(buf => {
            if (!buf) throw new Error('加载失败');
            FileStorage.set(srcSong.id, buf, srcSong.audioUrl.split('/').pop(), 'audio/mpeg');
            App._launchEditor(item, buf);
        }).catch(() => {
            App._toast('音频加载失败，请检查网络', 'error');
        });
    },

    _launchEditor(item, buf) {
        this._editingWsItem = item;
        const pseudoSong = {
            id: item.isTrimmed ? (item.trimFileId || item.sourceId) : item.sourceId,
            title: item.title,
            artist: item.artist,
            _isTrimmed: item.isTrimmed,
        };
        AudioEditor.open(pseudoSong, buf);
    },

    renderSavedPlaylists() {
        const select = document.getElementById('savedPlaylists');
        const playlists = PlaylistManager.getAll();
        select.innerHTML = '<option value="">-- 已保存的歌单 --</option>' +
            playlists.map(p => `<option value="${this._esc(p.name)}">${this._esc(p.name)} (${p.items ? p.items.length : 0}首)</option>`).join('');
    },

    // ==================== 歌单管理（保存/加载工作区快照） ====================

    _savePlaylist() {
        if (Workspace.count === 0) { this._toast('工作区为空', 'error'); return; }
        const name = document.getElementById('playlistName').value.trim() || '婚礼歌单';
        PlaylistManager.save(name);
        this.renderSavedPlaylists();
        this._toast(`歌单「${name}」已保存`, 'success');
    },

    _loadPlaylist() {
        const name = document.getElementById('savedPlaylists').value;
        if (!name) { this._toast('请先选择一个歌单', 'error'); return; }
        if (!PlaylistManager.loadToWorkspace(name)) { this._toast('歌单不存在', 'error'); return; }
        document.getElementById('playlistName').value = name;
        this.renderWorkspace();
        this._toast(`已加载歌单「${name}」`, 'success');
    },

    _deleteSavedPlaylist() {
        const name = document.getElementById('savedPlaylists').value;
        if (!name) { this._toast('请先选择一个歌单', 'error'); return; }
        if (!confirm(`确定删除「${name}」？`)) return;
        PlaylistManager.delete(name);
        this.renderSavedPlaylists();
    },

    _exportWorkspaceInfo() {
        if (Workspace.count === 0) { this._toast('工作区为空', 'error'); return; }
        const name = document.getElementById('playlistName').value.trim() || '婚礼歌单';
        const json = PlaylistManager.exportJson(name);
        this._downloadFile(`${name}.json`, json, 'application/json');
        this._toast('歌单信息已导出');
    },

    // ==================== ZIP 导出（导出工作区音频） ====================

    async _exportZip() {
        if (Workspace.count === 0) { this._toast('工作区为空', 'error'); return; }
        let ZipClass = typeof JSZip !== 'undefined' ? JSZip : null;
        if (!ZipClass) {
            this._toast('正在加载 ZIP 组件...', '');
            try {
                await this._loadJSZip();
                ZipClass = typeof JSZip !== 'undefined' ? JSZip : null;
            } catch (e) {
                // 离线时使用内置的无压缩 ZIP 写入器，不影响导出功能。
                ZipClass = LocalZip;
            }
            if (!ZipClass) ZipClass = LocalZip;
        }

        const name = document.getElementById('playlistName').value.trim() || '婚礼歌单';
        const items = Workspace.getAll();

        // 预先加载所有未在内存中的音频文件
        this._toast(`正在准备 ${items.length} 首歌曲...`, '');
        let missingCount = 0;
        await Promise.all(items.map(async item => {
            const ok = await this._ensureAudioForExport(item);
            if (!ok) missingCount++;
        }));

        if (missingCount > 0) {
            this._toast(`有 ${missingCount} 首歌曲音频缺失，请重新点击 + 添加`, 'error');
            return;
        }

        const zip = new ZipClass();
        let fileCount = 0;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const num = String(i + 1).padStart(2, '0');
            let buf = null;
            let ext = '.mp3';

            if (item.isTrimmed && item.trimFileId && FileStorage.has(item.trimFileId)) {
                buf = FileStorage.getBuffer(item.trimFileId);
                ext = '.mp3';
            } else if (FileStorage.has(item.sourceId)) {
                buf = FileStorage.getBuffer(item.sourceId);
                ext = '.mp3';
            }

            if (buf) {
                let fname = `${num}_${item.title}${ext}`.replace(/[<>:"/\\|?*]/g, '_');
                zip.file(fname, buf);
                fileCount++;
            }
        }

        zip.file('歌单信息.json', PlaylistManager.exportJson(name));
        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${name}.zip`; a.click();
        URL.revokeObjectURL(url);
        this._toast(`已导出 ${fileCount} 个音频文件`, 'success');
    },

    /** 确保导出时有音频数据：优先内存，其次加载。返回 true=成功 */
    async _ensureAudioForExport(wsItem) {
        // 已剪辑的 → 检查 trimFileId 是否在内存中
        if (wsItem.isTrimmed && wsItem.trimFileId) {
            return FileStorage.has(wsItem.trimFileId);
        }

        // 已在内存中 → 无需加载
        if (FileStorage.has(wsItem.sourceId)) return true;

        // 尝试从 audioUrl 加载（支持 fetch + XHR 回退）
        const srcSong = MusicData.getSongById(wsItem.sourceId);
        if (!srcSong || !srcSong.audioUrl) return false;

        const buf = await MusicData._fetchAudio(srcSong.audioUrl);
        if (buf) {
            FileStorage.set(srcSong.id, buf, srcSong.audioUrl.split('/').pop(), 'audio/mpeg');
            return true;
        }
        return false;
    },

    async _loadJSZip() {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
            s.onload = resolve; s.onerror = reject;
            document.head.appendChild(s);
        });
    },

    // ==================== 拖拽排序（工作区） ====================

    _onDragStart(e) {
        e.target.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', e.target.dataset.wsId || '');
    },
    _onDragOver(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const targetCard = e.target.closest('.ws-card');
        if (targetCard) targetCard.classList.add('drag-over');
    },
    _onDragLeave(e) {
        const targetCard = e.target.closest('.ws-card');
        if (targetCard) targetCard.classList.remove('drag-over');
    },
    _onDrop(e) {
        e.preventDefault();
        const targetCard = e.target.closest('.ws-card');
        if (targetCard) targetCard.classList.remove('drag-over');
        const fromId = e.dataTransfer.getData('text/plain');
        const toCard = e.target.closest('.ws-card');
        if (!toCard || !fromId || fromId === toCard.dataset.wsId) return;
        const items = Workspace.getAll();
        const fromIdx = items.findIndex(i => i.id === fromId);
        const toIdx = items.findIndex(i => i.id === toCard.dataset.wsId);
        if (fromIdx === -1 || toIdx === -1) return;
        Workspace.reorder(fromIdx, toIdx);
        this.renderWorkspace();
    },
    _onDragEnd(e) {
        e.target.classList.remove('dragging');
        document.querySelectorAll('.ws-card.drag-over').forEach(c => c.classList.remove('drag-over'));
    },

    // ==================== 播放器 ====================

    /** 确保音频在内存中（按需从服务器加载） */
    _ensureAudio(song, callback) {
        const sid = song.id;
        if (FileStorage.has(sid)) { callback(); return; }
        if (!song.audioUrl) { this._toast('该歌曲没有音频文件', 'error'); return; }
        this._toast('正在加载音频...', '');
        MusicData._fetchAudio(song.audioUrl).then(buf => {
            if (!buf) throw new Error('加载失败');
            FileStorage.set(sid, buf, song.audioUrl.split('/').pop(), 'audio/mpeg');
            callback();
        }).catch(() => {
            this._toast('音频加载失败，请检查网络', 'error');
        });
    },

    _playLibrarySong(songId) {
        const song = MusicData.getSongById(songId);
        if (!song) return;
        this._ensureAudio(song, () => {
            // 播放列表 = 当前搜索范围内所有有音频的歌（不再依赖已删除的筛选下拉框）
            const searchInput = document.getElementById('searchInput');
            const query = (searchInput ? searchInput.value : '').toLowerCase().trim();
            const allSongs = MusicData.getAllSongs().filter(s => {
                if (query && !s.title.toLowerCase().includes(query)) return false;
                return FileStorage.has(s.id) || s.audioUrl;
            });
            this.player.playlist = allSongs;
            this.player.currentIndex = allSongs.findIndex(s => s.id === songId);
            this._loadAndPlay(song);
        });
    },

    _playRandomSong() {
        const playableSongs = MusicData.getAllSongs().filter(song => FileStorage.has(song.id) || song.audioUrl);
        if (playableSongs.length === 0) {
            this._toast('曲库里还没有可播放的音乐', 'error');
            return;
        }
        const song = playableSongs[Math.floor(Math.random() * playableSongs.length)];
        this._playLibrarySong(song.id);
        this._toast(`随机试听：${song.title}`, 'success');
    },

    _toggleAmbient() {
        const muted = document.body.classList.toggle('ambient-muted');
        const button = document.getElementById('btnAmbient');
        button.classList.toggle('is-active', !muted);
        button.setAttribute('aria-pressed', String(!muted));
        this._toast(muted ? '动态氛围已关闭' : '动态氛围已开启');
    },

    _updateAtelierStats() {
        const libraryStat = document.getElementById('atelierLibraryStat');
        const workspaceStat = document.getElementById('atelierWorkspaceStat');
        const durationStat = document.getElementById('atelierDurationStat');
        if (libraryStat) libraryStat.textContent = MusicData.count;
        if (workspaceStat) workspaceStat.textContent = Workspace.count;
        if (durationStat) durationStat.textContent = MusicData._formatDuration(Workspace.getTotalDuration());
    },

    _startAtelierClock() {
        const clock = document.getElementById('atelierClock');
        if (!clock || this._atelierClockTimer) return;
        const update = () => {
            clock.textContent = new Date().toLocaleTimeString('zh-CN', {
                hour: '2-digit', minute: '2-digit', hour12: false,
            });
        };
        update();
        this._atelierClockTimer = window.setInterval(update, 30000);
    },

    _toggleFolders() {
        this._foldersCollapsed = !this._foldersCollapsed;
        document.querySelectorAll('#libraryList .folder-group, #libraryList .folder-sub')
            .forEach(group => group.classList.toggle('open', !this._foldersCollapsed));
        const button = document.getElementById('btnToggleFolders');
        button.textContent = this._foldersCollapsed ? '展开曲库' : '折叠曲库';
    },

    _focusWorkspace() {
        const panel = document.getElementById('panelPlaylist');
        const mobileTab = document.querySelector('.mobile-tab[data-panel="panelPlaylist"]');
        if (this._isTouch() && mobileTab) mobileTab.click();
        if (panel) {
            panel.classList.remove('focus-flash');
            void panel.offsetWidth;
            panel.classList.add('focus-flash');
        }
    },

    _playWorkspaceSong(wsId) {
        const item = Workspace.getById(wsId);
        if (!item) return;
        const url = Workspace.getAudioUrl(item);
        if (!url) { this._toast('音频未加载', 'error'); return; }
        const items = Workspace.getAll();
        this.player._wsPlaylist = items;
        this.player._wsIndex = items.findIndex(i => i.id === wsId);
        this._loadAndPlayUrl(url, { title: item.title, artist: item.artist });
    },

    _loadAndPlay(song) {
        const url = FileStorage.getBlobUrl(song.id);
        if (!url) return;
        this._loadAndPlayUrl(url, song);
    },

    _loadAndPlayUrl(url, info) {
        this.player.audio.src = url;
        this.player.audio.play().catch(e => console.warn(e));
        this.player.isPlaying = true;
        document.getElementById('miniPlayer').style.display = 'flex';
        document.getElementById('playerTitle').textContent = info.title;
        document.getElementById('playerArtist').textContent = info.artist || '';
        document.getElementById('btnPlay').textContent = '⏸️';
    },

    _togglePlay() {
        if (!this.player.audio.src) return;
        if (this.player.isPlaying) {
            this.player.audio.pause(); this.player.isPlaying = false;
            document.getElementById('btnPlay').textContent = '▶️';
        } else {
            this.player.audio.play().catch(e => console.warn(e));
            this.player.isPlaying = true;
            document.getElementById('btnPlay').textContent = '⏸️';
        }
    },

    _prev() {
        const items = this.player._wsPlaylist;
        if (!items || items.length === 0) return;
        const idx = (this.player._wsIndex - 1 + items.length) % items.length;
        this.player._wsIndex = idx;
        const item = items[idx];
        const url = Workspace.getAudioUrl(item);
        if (url) this._loadAndPlayUrl(url, { title: item.title, artist: item.artist });
    },

    _next() {
        const items = this.player._wsPlaylist;
        if (!items || items.length === 0) return;
        const idx = (this.player._wsIndex + 1) % items.length;
        this.player._wsIndex = idx;
        const item = items[idx];
        const url = Workspace.getAudioUrl(item);
        if (url) this._loadAndPlayUrl(url, { title: item.title, artist: item.artist });
    },

    _seek(percent) {
        if (!this.player.audio.duration) return;
        this.player.audio.currentTime = (percent / 100) * this.player.audio.duration;
    },

    _updateProgress() {
        const a = this.player.audio;
        if (!a.duration) return;
        document.getElementById('progressBar').value = (a.currentTime / a.duration) * 100;
        document.getElementById('playerTime').textContent =
            `${this._fmtTime(a.currentTime)} / ${this._fmtTime(a.duration)}`;
    },

    _fmtTime(s) {
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${String(sec).padStart(2, '0')}`;
    },

    // ==================== 文件上传（管理员添加曲库） ====================

    async _handleUpload(e) {
        const files = e.target.files;
        if (files.length > 0) await this._handleUploadFiles(files);
        e.target.value = '';
    },

    async _handleUploadFiles(fileList) {
        const mp3Files = Array.from(fileList).filter(f => f.name.toLowerCase().endsWith('.mp3'));
        if (mp3Files.length === 0) { this._toast('请选择 MP3 文件', 'error'); return; }

        // 选择目标文件夹
        const folder = this._pickFolder();
        if (folder === null) return; // 用户取消

        this._toast(`正在导入到「${folder}」...`, '');
        await MusicData.importFiles(mp3Files, folder);
        this.renderLibrary();
        this._toast(`已导入 ${mp3Files.length} 首到「${folder}」`, 'success');
    },

    /** 弹窗选择目标文件夹 */
    _pickFolder() {
        const folders = this._getFolderList();
        let msg = '📁 选择目标文件夹：\n\n';
        folders.forEach((f, i) => { msg += `  ${i + 1}. ${f}\n`; });
        msg += '\n输入序号，或输入新文件夹名：';
        const input = prompt(msg, '');
        if (!input) return null;
        const num = parseInt(input);
        if (!isNaN(num) && num >= 1 && num <= folders.length) return folders[num - 1];
        return input.trim(); // 当作新文件夹名
    },

    /** 从现有曲库中提取文件夹列表 */
    _getFolderList() {
        const set = new Set();
        for (const song of MusicData.getAllSongs()) {
            const path = (song.audioUrl || '').replace(/^.*?data\/audio2?\//, '');
            const parts = path.split('/');
            if (parts[0]) set.add(parts[0]);
            if (parts.length > 2 && parts[1]) set.add(parts[0] + '/' + parts[1]);
        }
        // D&L 没有歌曲时也要出现在上传目标列表，并固定放在最后。
        set.add('D&L');
        return [...set].filter(folder => folder !== 'D&L').sort().concat('D&L');
    },

    // ==================== 工具 ====================

    _esc(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },

    _downloadFile(filename, content, mimeType = 'application/json') {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    },

    _toast(message, type = '') {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.className = 'toast ' + type + ' show';
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
    },
};

// ==================== 启动 ====================

document.addEventListener('DOMContentLoaded', () => App.init());
