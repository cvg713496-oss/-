document.addEventListener("DOMContentLoaded", () => {
    // Application State
    const state = {
        videoPath: "",
        videoUrl: "",
        duration: 20,
        segments: [],
        bgmPath: null,
        bgmVolume: 0.60,
        origVolume: 0.15, // Keep original video audio / background sound active
        watermarkText: "សម្រាយរឿងHD",
        showWatermark: true,
        watermarkFontSize: parseInt(localStorage.getItem("vocal_studio_wm_fontsize") || "56"),
        watermarkX: null,
        watermarkY: null,
        burnSubtitles: true,
        recapStyle: true,
        actor1Voice: "km-KH-PisethNeural",
        actor2Voice: "km-KH-SreymomNeural",
        speechRate: localStorage.getItem("vocal_piseth_rate") || "+35%",
        pisethPitch: localStorage.getItem("vocal_piseth_pitch") || "+0Hz",
        pisethRate: localStorage.getItem("vocal_piseth_rate") || "+35%",
        sreymomPitch: localStorage.getItem("vocal_sreymom_pitch") || "+0Hz",
        sreymomRate: localStorage.getItem("vocal_sreymom_rate") || "+35%",
        isLoading: false,
        muteOrigAudio: true,
        enableLiveDub: true,
        subFontSize: 18,
        showSubtitles: true,
        logoPath: null,
        logoUrl: null,
        logoPosition: "top-right",
        logoScale: 0.15,
        logos: [], // Array of { id, path, url, scale, x, y, name }
        aspectRatio: "original",
        maskChineseMode: "off", // "off" | "blur" | "cover"
        maskBottomPercent: 19,
        maskHeightPercent: 12,
        smartCropChinese: false,
        cropBottomPercent: 12.0,
        proxyPath: null,
        proxyUrl: null,
        useProxy: false,
        playlist: [], // Array of { id, name, file, url, video_path, duration, segments, ... }
        playlistIndex: 0,
        autoPlayNext: true,
        thumbnail: {
            enabled: false,
            title: "មហាសេដ្ឋីក្លែងខ្លួនជាអ្នកសុំទាន",
            titleFont: localStorage.getItem("vocal_studio_thumb_title_font") || "Moul",
            subtitle: "សម្រាយរឿងពេញ | ភាគទី ០១",
            subFont: localStorage.getItem("vocal_studio_thumb_sub_font") || "Kantumruy Pro",
            subFontSize: parseInt(localStorage.getItem("vocal_studio_thumb_sub_fontsize") || "32"),
            subColor: localStorage.getItem("vocal_studio_thumb_sub_color") || "#ffffff",
            fontSize: parseInt(localStorage.getItem("vocal_studio_thumb_fontsize") || "64"),
            textColor: localStorage.getItem("vocal_studio_thumb_color") || "#fbbf24",
            boxStyle: localStorage.getItem("vocal_studio_thumb_box_style") || "ribbon",
            position: "center",
            yPercent: parseInt(localStorage.getItem("vocal_studio_thumb_y_pct") || "48"),
            bgImage: null,
            imagePath: null,
            imageUrl: null,
            insertAsCover: true,
            coverDuration: 0.8
        }
    };

    // Live Synchronized Dubbing State
    let audioCache = {};
    let currentPlayingSegId = null;
    let activeDubAudio = null;

    // Single shared Audio instance for live dubbing segments to avoid hitting Chromium media decoder limits
    const liveDubAudioPlayer = new Audio();
    liveDubAudioPlayer.preload = "auto";

    // Helper to clear audio cache and revoke blob URLs to avoid memory leaks
    function clearAudioCache(clearDecoded = false) {
        if (audioCache) {
            for (const id in audioCache) {
                if (audioCache[id] && audioCache[id].url) {
                    try { URL.revokeObjectURL(audioCache[id].url); } catch (e) {}
                }
            }
        }
        audioCache = {};
        if (clearDecoded) {
            window.__vocalStudioAudioBuffer = null;
        }
    }

    function clearSegmentAudioCache(segId) {
        if (!audioCache) return;
        const prefix = segId + "_";
        for (const k in audioCache) {
            if (k.startsWith(prefix) || k === String(segId)) {
                if (audioCache[k] && audioCache[k].url) {
                    try { URL.revokeObjectURL(audioCache[k].url); } catch (e) {}
                }
                delete audioCache[k];
            }
        }
    }

    // Helper to refresh Lucide vector icons dynamically
    function refreshIcons() {
        if (window.lucide && typeof window.lucide.createIcons === "function") {
            try {
                window.lucide.createIcons();
            } catch (e) {
                console.warn("lucide.createIcons error:", e);
            }
        }
    }
    window.refreshIcons = refreshIcons;

    function updatePlayPauseUI(isPlaying) {
        const iconSpan = document.getElementById("playIconSpan");
        const labelSpan = document.getElementById("playLabelSpan");
        if (iconSpan && labelSpan) {
            iconSpan.innerHTML = isPlaying ? '<i data-lucide="pause"></i>' : '<i data-lucide="play"></i>';
            labelSpan.innerText = isPlaying ? "Pause" : "Play";
        } else {
            const btn = document.getElementById("btnPlayPause");
            if (btn) {
                btn.innerHTML = isPlaying 
                    ? '<span id="playIconSpan"><i data-lucide="pause"></i></span> <span id="playLabelSpan">Pause</span>' 
                    : '<span id="playIconSpan"><i data-lucide="play"></i></span> <span id="playLabelSpan">Play</span>';
            }
        }
        refreshIcons();
    }

    // DOM Elements
    const videoPlayer = document.getElementById("videoPlayer");
    const previewAudio = document.getElementById("previewAudio");
    const bgmAudioPlayer = document.getElementById("bgmAudioPlayer");
    const tableBody = document.getElementById("tableBody");
    const segmentCount = document.getElementById("segmentCount");
    const videoStatus = document.getElementById("videoStatus");
    const currentTimeDisplay = document.getElementById("currentTimeDisplay");
    const durationDisplay = document.getElementById("durationDisplay");
    const subtitlePreview = document.getElementById("subtitlePreview");
    const watermarkPreview = document.getElementById("watermarkPreview");
    const progressBar = document.getElementById("progressBar");
    const progressText = document.getElementById("progressText");
    const statusMessage = document.getElementById("statusMessage");
    const btnToggleOrigAudio = document.getElementById("btnToggleOrigAudio");
    const muteIcon = document.getElementById("muteIcon");
    const muteLabel = document.getElementById("muteLabel");
    const btnToggleBgm = document.getElementById("btnToggleBgm");
    const bgmToggleIcon = document.getElementById("bgmToggleIcon");
    const bgmToggleLabel = document.getElementById("bgmToggleLabel");
    const chkMuteOrigExport = document.getElementById("chkMuteOrigExport");
    const btnLiveDubToggle = document.getElementById("btnLiveDubToggle");
    const liveDubIcon = document.getElementById("liveDubIcon");
    const liveDubLabel = document.getElementById("liveDubLabel");
    const toolbarSpeedSelect = document.getElementById("toolbarSpeedSelect");
    const btnToolbarToggleOrigAudio = document.getElementById("btnToolbarToggleOrigAudio");
    const tbMuteIcon = document.getElementById("tbMuteIcon");
    const tbMuteLabel = document.getElementById("tbMuteLabel");

    // Subtitle Customization Controls (Resize & Toggle / Remove)
    const btnSubDecrease = document.getElementById("btnSubDecrease");
    const btnSubIncrease = document.getElementById("btnSubIncrease");
    const subSizeBadge = document.getElementById("subSizeBadge");
    const btnSubToggleVisible = document.getElementById("btnSubToggleVisible");
    const subVisibleIcon = document.getElementById("subVisibleIcon");
    const subVisibleText = document.getElementById("subVisibleText");

    function updateSubtitleDisplay() {
        if (!subtitlePreview) return;
        subtitlePreview.style.fontSize = `${state.subFontSize}px`;
        if (subSizeBadge) subSizeBadge.innerText = `${state.subFontSize}px`;

        if (state.showSubtitles) {
            const hasText = !!(subtitlePreview.innerText && subtitlePreview.innerText.trim());
            subtitlePreview.style.display = hasText ? "block" : "none";
            subtitlePreview.style.opacity = hasText ? "1" : "0";
            if (btnSubToggleVisible) {
                btnSubToggleVisible.style.background = "#1e293b";
                btnSubToggleVisible.style.borderColor = "#334155";
                btnSubToggleVisible.style.color = "#e2e8f0";
            }
            if (subVisibleIcon) subVisibleIcon.innerHTML = '<i data-lucide="eye"></i>';
            if (subVisibleText) subVisibleText.innerText = "Sub";
        } else {
            subtitlePreview.style.display = "none";
            subtitlePreview.style.opacity = "0";
            if (btnSubToggleVisible) {
                btnSubToggleVisible.style.background = "#450a0a";
                btnSubToggleVisible.style.borderColor = "#ef4444";
                btnSubToggleVisible.style.color = "#fca5a5";
            }
            if (subVisibleIcon) subVisibleIcon.innerHTML = '<i data-lucide="eye-off"></i>';
            if (subVisibleText) subVisibleText.innerText = "Sub: បិទ";
        }
        refreshIcons();
    }

    if (btnSubDecrease) {
        btnSubDecrease.addEventListener("click", () => {
            if (state.subFontSize > 10) {
                state.subFontSize -= 2;
                updateSubtitleDisplay();
            }
        });
    }

    if (btnSubIncrease) {
        btnSubIncrease.addEventListener("click", () => {
            if (state.subFontSize < 36) {
                state.subFontSize += 2;
                updateSubtitleDisplay();
            }
        });
    }

    if (btnSubToggleVisible) {
        btnSubToggleVisible.addEventListener("click", () => {
            state.showSubtitles = !state.showSubtitles;
            updateSubtitleDisplay();
            setStatus(state.showSubtitles ? "✨ បានបើកបង្ហាញ Subtitle លើវីដេអូ" : "🚫 បានលាក់/លុប Subtitle ពីលើវីដេអូ");
        });
    }

    // Initialize subtitle display
    updateSubtitleDisplay();

    // ─── Subtitle Mask / Blur Original Chinese Subtitles Handler ──────────────
    const btnToggleMask = document.getElementById("btnToggleMask");
    const subtitleMask = document.getElementById("subtitleMask");
    const maskIcon = document.getElementById("maskIcon");
    const maskLabel = document.getElementById("maskLabel");
    const maskAdjustGroup = document.getElementById("maskAdjustGroup");
    const maskPosBadge = document.getElementById("maskPosBadge");
    const btnMaskUp = document.getElementById("btnMaskUp");
    const btnMaskDown = document.getElementById("btnMaskDown");

    function updateMaskDisplay() {
        if (!subtitleMask) return;
        subtitleMask.style.bottom = `${state.maskBottomPercent}%`;
        subtitleMask.style.height = `${state.maskHeightPercent}%`;
        if (subtitlePreview) {
            subtitlePreview.style.bottom = `${state.maskBottomPercent}%`;
        }

        if (maskPosBadge) {
            maskPosBadge.innerText = `${state.maskBottomPercent}%`;
        }

        const handleText = subtitleMask.querySelector(".subtitle-mask-handle");
        if (handleText) {
            handleText.innerText = `↕️ អូសដើម្បីតម្រង់ចំអក្សរចិន (${state.maskBottomPercent}%)`;
        }

        if (state.maskChineseMode === "off") {
            subtitleMask.classList.remove("mode-blur", "mode-cover");
            subtitleMask.style.display = "none";
            if (maskAdjustGroup) maskAdjustGroup.style.display = "none";
            if (btnToggleMask) {
                btnToggleMask.style.background = "rgba(30, 41, 59, 0.7)";
                btnToggleMask.style.borderColor = "rgba(255, 255, 255, 0.1)";
                btnToggleMask.style.color = "#94a3b8";
            }
            if (maskIcon) maskIcon.innerHTML = '<i data-lucide="scan-line"></i>';
            if (maskLabel) maskLabel.innerText = "Blur: បិទ";
        } else if (state.maskChineseMode === "blur") {
            subtitleMask.classList.remove("mode-cover");
            subtitleMask.classList.add("mode-blur");
            subtitleMask.style.display = "flex";
            if (maskAdjustGroup) maskAdjustGroup.style.display = "inline-flex";
            if (btnToggleMask) {
                btnToggleMask.style.background = "linear-gradient(135deg, #1e3a8a, #2563eb)";
                btnToggleMask.style.borderColor = "#3b82f6";
                btnToggleMask.style.color = "#eff6ff";
            }
            if (maskIcon) maskIcon.innerHTML = '<i data-lucide="scan-line"></i>';
            if (maskLabel) maskLabel.innerText = "Blur: បើក";
        } else if (state.maskChineseMode === "cover") {
            subtitleMask.classList.remove("mode-blur");
            subtitleMask.classList.add("mode-cover");
            subtitleMask.style.display = "flex";
            if (maskAdjustGroup) maskAdjustGroup.style.display = "inline-flex";
            if (btnToggleMask) {
                btnToggleMask.style.background = "linear-gradient(135deg, #3730a3, #4f46e5)";
                btnToggleMask.style.borderColor = "#818cf8";
                btnToggleMask.style.color = "#eef2ff";
            }
            if (maskIcon) maskIcon.innerHTML = '<i data-lucide="layers"></i>';
            if (maskLabel) maskLabel.innerText = "Cover: បើក";
        }
        refreshIcons();
    }

    if (btnToggleMask) {
        btnToggleMask.addEventListener("click", () => {
            if (state.maskChineseMode === "off") {
                state.maskChineseMode = "blur";
                setStatus(`🌫️ បានបើកមុខងារ 'ព្រិលអក្សរចិនដើម' (កម្ពស់ ${state.maskBottomPercent}% ពីក្រោម)! ចុច ▲ ឬ ▼ ដើម្បីរំកិល`);
            } else if (state.maskChineseMode === "blur") {
                state.maskChineseMode = "cover";
                setStatus(`⬛ បានប្តូរទៅ 'ប្រអប់ខ្មៅបិទបាំងអក្សរចិន' (កម្ពស់ ${state.maskBottomPercent}% ពីក្រោម)!`);
            } else {
                state.maskChineseMode = "off";
                setStatus("🚫 បានបិទមុខងារបិទបាំងអក្សរចិនដើម");
            }
            updateMaskDisplay();
        });
    }

    if (btnMaskUp) {
        btnMaskUp.addEventListener("click", (e) => {
            e.stopPropagation();
            state.maskBottomPercent = Math.min(55, state.maskBottomPercent + 2);
            updateMaskDisplay();
            setStatus(`📍 បានរំកិលប្រអប់ Blur ឡើងលើ៖ ${state.maskBottomPercent}% ពីបាតក្រោម`);
        });
    }

    if (btnMaskDown) {
        btnMaskDown.addEventListener("click", (e) => {
            e.stopPropagation();
            state.maskBottomPercent = Math.max(8, state.maskBottomPercent - 2);
            updateMaskDisplay();
            setStatus(`📍 បានរំកិលប្រអប់ Blur ចុះក្រោម៖ ${state.maskBottomPercent}% ពីបាតក្រោម`);
        });
    }

    // Vertical Dragging to adjust Mask position over Chinese subtitles
    if (subtitleMask) {
        let isDraggingMask = false;
        let dragStartY = 0;
        let startBottomPercent = 19;

        const onDragStart = (clientY) => {
            isDraggingMask = true;
            dragStartY = clientY;
            startBottomPercent = state.maskBottomPercent;
        };

        const onDragMove = (clientY) => {
            if (!isDraggingMask || !videoFrame) return;
            const deltaY = dragStartY - clientY; // upward is positive
            const frameH = videoFrame.clientHeight || 300;
            const deltaPercent = (deltaY / frameH) * 100;
            state.maskBottomPercent = Math.max(8, Math.min(55, Math.round(startBottomPercent + deltaPercent)));
            subtitleMask.style.bottom = `${state.maskBottomPercent}%`;
            if (subtitlePreview) {
                subtitlePreview.style.bottom = `${state.maskBottomPercent}%`;
            }
            if (maskPosBadge) {
                maskPosBadge.innerText = `${state.maskBottomPercent}%`;
            }
            const handleText = subtitleMask.querySelector(".subtitle-mask-handle");
            if (handleText) {
                handleText.innerText = `↕️ អូសដើម្បីតម្រង់ចំអក្សរចិន (${state.maskBottomPercent}%)`;
            }
        };

        const onDragEnd = () => {
            if (isDraggingMask) {
                isDraggingMask = false;
                updateMaskDisplay();
                setStatus(`📍 ទីតាំងបិទបាំងអក្សរចិនត្រូវបានតម្រង់ទៅ៖ ${state.maskBottomPercent}% ពីក្រោម`);
            }
        };

        subtitleMask.addEventListener("mousedown", (e) => {
            e.preventDefault();
            onDragStart(e.clientY);
        });

        window.addEventListener("mousemove", (e) => {
            onDragMove(e.clientY);
        });

        window.addEventListener("mouseup", onDragEnd);

        // Touch support for dragging
        subtitleMask.addEventListener("touchstart", (e) => {
            if (e.touches.length === 1) {
                onDragStart(e.touches[0].clientY);
            }
        }, { passive: true });

        window.addEventListener("touchmove", (e) => {
            if (isDraggingMask && e.touches.length === 1) {
                onDragMove(e.touches[0].clientY);
            }
        }, { passive: true });

        window.addEventListener("touchend", onDragEnd);
    }

    updateMaskDisplay();

    // ─── ✂️ Smart Crop Chinese Subtitles Handler ──────────────
    const btnSmartCrop = document.getElementById("btnSmartCrop");
    const smartCropIcon = document.getElementById("smartCropIcon");
    const smartCropLabel = document.getElementById("smartCropLabel");

    function updateSmartCropDisplay() {
        if (!videoPlayer) return;
        if (state.smartCropChinese) {
            videoPlayer.classList.add("smart-crop-active");
            if (btnSmartCrop) {
                btnSmartCrop.style.background = "linear-gradient(135deg, #064e3b, #059669)";
                btnSmartCrop.style.borderColor = "#10b981";
                btnSmartCrop.style.color = "#ecfdf5";
            }
            if (smartCropIcon) smartCropIcon.innerHTML = '<i data-lucide="scissors"></i>';
            if (smartCropLabel) smartCropLabel.innerText = "Crop: បើក";
            if (subtitleMask) subtitleMask.style.display = "none";
        } else {
            videoPlayer.classList.remove("smart-crop-active");
            if (btnSmartCrop) {
                btnSmartCrop.style.background = "rgba(30, 41, 59, 0.7)";
                btnSmartCrop.style.borderColor = "rgba(255, 255, 255, 0.1)";
                btnSmartCrop.style.color = "#94a3b8";
            }
            if (smartCropIcon) smartCropIcon.innerHTML = '<i data-lucide="scissors"></i>';
            if (smartCropLabel) smartCropLabel.innerText = "Crop: បិទ";
            updateMaskDisplay();
        }
        refreshIcons();
    }

    if (btnSmartCrop) {
        btnSmartCrop.addEventListener("click", () => {
            state.smartCropChinese = !state.smartCropChinese;
            updateSmartCropDisplay();
            if (state.smartCropChinese) {
                setStatus("✂️ បានបើកមុខងារ Smart Crop: កាត់លុបអក្សរចិនផ្នែកក្រោម ១០០% ដោយស្វ័យប្រវត្ត!");
            } else {
                setStatus("✂️ បានបិទមុខងារ Smart Crop");
            }
        });
    }

    updateSmartCropDisplay();

    // ─── ⚡ Proxy Preview Handler (480p Fast & Smooth Playback) ──────────────
    const btnToggleProxy = document.getElementById("btnToggleProxy");
    const proxyIcon = document.getElementById("proxyIcon");
    const proxyLabel = document.getElementById("proxyLabel");

    function updateProxyDisplay() {
        if (!btnToggleProxy) return;
        if (state.useProxy) {
            btnToggleProxy.style.background = "linear-gradient(135deg, #92400e, #b45309)";
            btnToggleProxy.style.borderColor = "#f59e0b";
            btnToggleProxy.style.color = "#fef3c7";
            if (proxyIcon) proxyIcon.innerHTML = '<i data-lucide="zap"></i>';
            if (proxyLabel) proxyLabel.innerText = "Proxy: បើក";
        } else {
            btnToggleProxy.style.background = "rgba(30, 41, 59, 0.7)";
            btnToggleProxy.style.borderColor = "rgba(255, 255, 255, 0.1)";
            btnToggleProxy.style.color = "#94a3b8";
            if (proxyIcon) proxyIcon.innerHTML = '<i data-lucide="zap"></i>';
            if (proxyLabel) proxyLabel.innerText = "Proxy: បិទ";
        }
        refreshIcons();
    }

    async function toggleProxyMode() {
        if (!state.videoPath) {
            alert("សូមជ្រើសរើស ឬបញ្ចូលវីដេអូជាមុនសិន!");
            return;
        }

        if (state.useProxy) {
            // Switch to Original Quality
            state.useProxy = false;
            const curTime = videoPlayer.currentTime;
            const wasPaused = videoPlayer.paused;
            videoPlayer.src = state.videoUrl;
            videoPlayer.currentTime = curTime;
            if (!wasPaused) videoPlayer.play().catch(() => {});
            updateProxyDisplay();
            setStatus("🎬 បានប្តូរទៅប្រើវីដេអូដើមច្បាស់ (Original Quality) សម្រាប់ Preview");
        } else {
            // Switch to 480p Proxy
            if (!state.proxyUrl) {
                if (proxyLabel) proxyLabel.innerText = "កំពុងបង្កើត Proxy...";
                setStatus("⚡ កំពុងបង្កើត Preview Proxy 480p ល្បឿនលឿន (សូមរង់ចាំបន្តិច)...");
                try {
                    const res = await fetch("/api/generate-proxy", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ video_path: state.videoPath })
                    });
                    const d = await res.json();
                    if (res.ok && d.proxy_url) {
                        state.proxyPath = d.proxy_path;
                        state.proxyUrl = d.proxy_url;
                    } else {
                        alert("មិនអាចបង្កើត Proxy បានទេ៖ " + (d.detail || "Error"));
                        updateProxyDisplay();
                        return;
                    }
                } catch (e) {
                    alert("កំហុសក្នុងការបង្កើត Proxy");
                    updateProxyDisplay();
                    return;
                }
            }

            state.useProxy = true;
            const curTime = videoPlayer.currentTime;
            const wasPaused = videoPlayer.paused;
            videoPlayer.src = state.proxyUrl;
            videoPlayer.currentTime = curTime;
            if (!wasPaused) videoPlayer.play().catch(() => {});
            updateProxyDisplay();
            setStatus("⚡ បានបើក Preview Proxy 480p រលូន ១០០% មិនគាំងម៉ាស៊ីន (ការ Export នឹងប្រើវីដេអូច្បាស់ដើម)");
        }
    }

    if (btnToggleProxy) {
        btnToggleProxy.addEventListener("click", toggleProxyMode);
    }
    updateProxyDisplay();

    // Auto-fit video frame to exact dimensions of original video without distortion or clipping
    const videoFrame = document.getElementById("videoFrame");
    const videoViewport = document.getElementById("videoViewport");
    const exportAspectRatioSelect = document.getElementById("exportAspectRatio");

    function fitVideoToOriginal() {
        if (!videoPlayer || !videoFrame) return;
        const container = videoFrame.closest(".video-container") || videoFrame.parentElement;
        const viewport = document.getElementById("videoViewport") || videoFrame.parentElement;
        if (!container) return;

        if (videoPlayer.videoWidth && videoPlayer.videoHeight) {
            const ratio = videoPlayer.videoWidth / videoPlayer.videoHeight;

            // Set appropriate container width based on aspect ratio (if not custom dragged or theater mode)
            if (!container.classList.contains("theater-mode") && !container.dataset.customWidth) {
                if (ratio < 1) {
                    // Portrait vertical video (9:16): neat, spacious width
                    container.style.width = "480px";
                } else {
                    // Landscape widescreen video (16:9)
                    container.style.width = "580px";
                }
            }

            // Available dimensions from viewport or container
            let availH = 0;
            if (viewport && viewport.clientHeight > 80) {
                availH = viewport.clientHeight - 6; // leave 3px top/bottom breathing space
            } else {
                const controlsEl = container.querySelector(".video-controls");
                const playlistEl = container.querySelector(".playlist-container");
                const controlsH = controlsEl ? controlsEl.offsetHeight : 62;
                const playlistH = (playlistEl && playlistEl.style.display !== "none") ? playlistEl.offsetHeight + 6 : 0;
                availH = Math.max(180, container.clientHeight - controlsH - playlistH - 16);
            }

            const availW = Math.max(180, (viewport ? viewport.clientWidth : container.clientWidth) - 12);

            let targetH = availH;
            let targetW = Math.round(targetH * ratio);

            if (targetW > availW) {
                targetW = availW;
                targetH = Math.round(targetW / ratio);
            }

            videoFrame.style.width = `${targetW}px`;
            videoFrame.style.height = `${targetH}px`;
            videoPlayer.style.width = `${targetW}px`;
            videoPlayer.style.height = `${targetH}px`;
        } else {
            videoFrame.style.width = "auto";
            videoFrame.style.height = "100%";
            videoPlayer.style.width = "100%";
            videoPlayer.style.height = "100%";
        }
        updateSubtitleDisplay();
        renderVideoLogos();
    }

    // ─── Draggable Resizer & Theater Mode for Video Preview Panel ───
    const panelResizer = document.getElementById("panelResizer");
    const videoContainer = document.getElementById("videoContainer") || document.querySelector(".video-container");
    const btnTheaterMode = document.getElementById("btnTheaterMode");

    if (panelResizer && videoContainer) {
        let isResizing = false;
        let startX = 0;
        let startWidth = 0;

        // Restore saved width if available
        const savedWidth = localStorage.getItem("vocal_video_width");
        if (savedWidth) {
            const w = parseInt(savedWidth, 10);
            if (w >= 360 && w <= 950) {
                videoContainer.style.width = `${w}px`;
                videoContainer.dataset.customWidth = "true";
            }
        }

        panelResizer.addEventListener("mousedown", (e) => {
            isResizing = true;
            startX = e.clientX;
            startWidth = videoContainer.offsetWidth;
            panelResizer.classList.add("is-dragging");
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            e.preventDefault();
        });

        window.addEventListener("mousemove", (e) => {
            if (!isResizing) return;
            const deltaX = startX - e.clientX; // dragging to the left increases video panel width
            const newWidth = Math.max(360, Math.min(window.innerWidth * 0.7, startWidth + deltaX));
            videoContainer.style.width = `${newWidth}px`;
            videoContainer.dataset.customWidth = "true";
            fitVideoToOriginal();
        });

        window.addEventListener("mouseup", () => {
            if (isResizing) {
                isResizing = false;
                panelResizer.classList.remove("is-dragging");
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
                localStorage.setItem("vocal_video_width", videoContainer.offsetWidth);
                fitVideoToOriginal();
            }
        });
    }

    if (btnTheaterMode && videoContainer) {
        btnTheaterMode.addEventListener("click", () => {
            const isTheater = videoContainer.classList.toggle("theater-mode");
            if (isTheater) {
                videoContainer.dataset.prevWidth = videoContainer.style.width || "480px";
                videoContainer.style.width = "720px";
                btnTheaterMode.classList.add("active");
                btnTheaterMode.title = "បង្រួមកម្រិតដើម";
                btnTheaterMode.innerHTML = '<i data-lucide="minimize-2"></i> <span>បង្រួម</span>';
                setStatus("📺 បានបើកផ្ទាំងទស្សនាវីដេអូធំ (Theater Mode)");
            } else {
                videoContainer.style.width = videoContainer.dataset.prevWidth || "480px";
                btnTheaterMode.classList.remove("active");
                btnTheaterMode.title = "ពង្រីកផ្ទាំងវីដេអូអោយធំច្បាស់ (Theater Mode)";
                btnTheaterMode.innerHTML = '<i data-lucide="maximize-2"></i> <span>ពង្រីកធំ</span>';
                setStatus("📺 បានបង្រួមផ្ទាំងវីដេអូត្រឡប់មកវិញធម្មតា");
            }
            if (window.lucide) lucide.createIcons();
            fitVideoToOriginal();
        });
    }

    // Speed Selector Handler
    if (toolbarSpeedSelect) {
        toolbarSpeedSelect.value = state.speechRate;
        toolbarSpeedSelect.addEventListener("change", () => {
            state.speechRate = toolbarSpeedSelect.value;
            state.pisethRate = state.speechRate;
            state.sreymomRate = state.speechRate;
            localStorage.setItem("vocal_piseth_rate", state.pisethRate);
            localStorage.setItem("vocal_sreymom_rate", state.sreymomRate);
            clearAudioCache();
            stopDubAudio();
            triggerBackendPreload();
            setStatus(`ល្បឿននិយាយសម្លេងខ្មែរត្រូវបានប្តូរទៅ៖ ${state.speechRate}`);
        });
    }

    function getVoiceParams(voiceName) {
        const v = voiceName || "km-KH-PisethNeural";
        if (v.includes("Sreymom")) {
            return {
                rate: state.sreymomRate || state.speechRate || "+35%",
                pitch: state.sreymomPitch || "+0Hz"
            };
        }
        return {
            rate: state.pisethRate || state.speechRate || "+35%",
            pitch: state.pisethPitch || "+0Hz"
        };
    }

    function getVoiceSettingsPayload() {
        return {
            "km-KH-PisethNeural": {
                rate: state.pisethRate || state.speechRate || "+35%",
                pitch: state.pisethPitch || "+0Hz"
            },
            "km-KH-SreymomNeural": {
                rate: state.sreymomRate || state.speechRate || "+35%",
                pitch: state.sreymomPitch || "+0Hz"
            }
        };
    }

    // Fetch or Get Cached Audio for Segment
    async function getSegmentAudio(seg) {
        if (!seg) return null;
        const _cacheVoice = seg.voice || "km-KH-PisethNeural";
        const _vp = getVoiceParams(_cacheVoice);
        const _cacheKey = seg.id + "_" + _cacheVoice + "_" + _vp.rate + "_" + _vp.pitch;
        if (audioCache[_cacheKey]) return audioCache[_cacheKey];
        const text = (seg.translated || seg.original || "").trim();
        if (!text) return null;

        try {
            const res = await fetch("/api/preview-tts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    text: text,
                    voice: _cacheVoice,
                    rate: _vp.rate,
                    pitch: _vp.pitch
                })
            });
            if (res.ok) {
                const blob = await res.blob();
                const audioUrl = URL.createObjectURL(blob);
                const textLen = text.length;
                let dur = Math.max(0.4, Math.round((textLen / 16.0) * 100) / 100);

                const cacheEntry = {
                    url: audioUrl,
                    duration: dur,
                    blob: blob
                };

                // Decode accurate audio duration via Web Audio API
                try {
                    const arrayBuffer = await blob.slice(0).arrayBuffer();
                    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                    const decodedBuffer = await new Promise((resolve) => {
                        audioCtx.decodeAudioData(arrayBuffer, resolve, () => resolve(null));
                    });
                    if (decodedBuffer && decodedBuffer.duration) {
                        cacheEntry.duration = decodedBuffer.duration;
                    }
                    audioCtx.close().catch(() => {});
                } catch (e) {}

                audioCache[_cacheKey] = cacheEntry;
                return cacheEntry;
            }
        } catch (e) {
            console.error("Failed to load audio for seg", seg.id, e);
        }
        return null;
    }

    // Prefetch upcoming segments in background
    function prefetchUpcomingAudio(currentIdx, count = 6) {
        for (let i = 1; i <= count; i++) {
            const nextSeg = state.segments[currentIdx + i];
            if (nextSeg) {
                const _v = nextSeg.voice || "km-KH-PisethNeural";
                const _vp = getVoiceParams(_v);
                if (!audioCache[nextSeg.id + "_" + _v + "_" + _vp.rate + "_" + _vp.pitch]) {
                    getSegmentAudio(nextSeg);
                }
            }
        }
    }

    // Tell backend to pre-generate TTS audio files in background with debouncing and safe limit
    let _preloadDebounceTimer = null;
    function triggerBackendPreload(customSegments = null) {
        if (_preloadDebounceTimer) clearTimeout(_preloadDebounceTimer);
        _preloadDebounceTimer = setTimeout(() => {
            const segs = customSegments || state.segments;
            if (!segs || !segs.length) return;
            fetch("/api/preload-audio", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    segments: segs,
                    rate: state.speechRate || "+35%",
                    pitch: state.pisethPitch || "+0Hz",
                    voice_settings: getVoiceSettingsPayload(),
                    limit: 50
                })
            }).catch(() => {});
        }, 300);
    }

    // Live Dub Toggle
    if (btnLiveDubToggle && liveDubLabel) {
        state.enableLiveDub = true;
        btnLiveDubToggle.style.background = "linear-gradient(135deg, #312e81, #4338ca)";
        btnLiveDubToggle.style.borderColor = "#6366f1";
        btnLiveDubToggle.style.color = "#e0e7ff";
        if (liveDubIcon) liveDubIcon.innerHTML = '<i data-lucide="mic"></i>';
        liveDubLabel.innerText = "Dub: បើក";

        btnLiveDubToggle.addEventListener("click", () => {
            state.enableLiveDub = !state.enableLiveDub;
            if (state.enableLiveDub) {
                btnLiveDubToggle.style.background = "linear-gradient(135deg, #312e81, #4338ca)";
                btnLiveDubToggle.style.borderColor = "#6366f1";
                btnLiveDubToggle.style.color = "#e0e7ff";
                if (liveDubIcon) liveDubIcon.innerHTML = '<i data-lucide="mic"></i>';
                liveDubLabel.innerText = "Dub: បើក";
                setStatus("សម្លេងខ្មែរ (Live Dub) ត្រូវបានបើក៖ វីដេអូរត់ដល់ឃ្លាណា សម្លេងខ្មែរនឹងនិយាយឃ្លានោះភ្លាម!");
            } else {
                btnLiveDubToggle.style.background = "rgba(30, 41, 59, 0.7)";
                btnLiveDubToggle.style.borderColor = "rgba(255, 255, 255, 0.1)";
                btnLiveDubToggle.style.color = "#94a3b8";
                if (liveDubIcon) liveDubIcon.innerHTML = '<i data-lucide="mic-off"></i>';
                liveDubLabel.innerText = "Dub: បិទ";
                stopDubAudio();
                setStatus("សម្លេងខ្មែរ (Live Dub) ត្រូវបានបិទជាបណ្ដោះអាសន្ន។");
            }
            refreshIcons();
        });
    }

    // ─── Background Music (BGM) & Video Ambient Audio Separation ──────────────
    let isBgmEnabled = false;
    let userExplicitlyToggledBgm = false;

    function updateBgmUI(enabled) {
        isBgmEnabled = enabled;
        if (btnToggleBgm && bgmToggleIcon && bgmToggleLabel) {
            if (enabled) {
                btnToggleBgm.style.background = "linear-gradient(135deg, #0e7490, #0891b2)";
                btnToggleBgm.style.borderColor = "#06b6d4";
                btnToggleBgm.style.color = "#ecfeff";
                bgmToggleIcon.innerHTML = '<i data-lucide="music-2"></i>';
                bgmToggleLabel.innerText = "BGM: បើក";
            } else {
                btnToggleBgm.style.background = "rgba(30, 41, 59, 0.7)";
                btnToggleBgm.style.borderColor = "rgba(255, 255, 255, 0.1)";
                btnToggleBgm.style.color = "#94a3b8";
                bgmToggleIcon.innerHTML = '<i data-lucide="volume-x"></i>';
                bgmToggleLabel.innerText = "BGM: បិទ";
            }
            refreshIcons();
        }
    }

    // Connect and poll/ensure extracted background audio track is loaded cleanly
    async function setupExtractedBgm(bgmUrl, bgmPath, forceReload = false) {
        if (!bgmUrl && !bgmPath && !state.bgmPath) return;
        if (bgmPath) state.bgmPath = bgmPath;

        let attempts = 0;
        const maxAttempts = 20;

        const checkAndLoad = async () => {
            attempts++;
            try {
                const res = await fetch("/api/check-bgm", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ bgm_path: state.bgmPath, video_path: state.videoPath, force: (forceReload && attempts === 1) })
                });
                const d = await res.json();
                if (d.ready && d.url) {
                    state.bgmPath = d.path || state.bgmPath;
                    if (bgmAudioPlayer) {
                        const cur = videoPlayer.currentTime;
                        bgmAudioPlayer.src = d.url;
                        bgmAudioPlayer.load();
                        bgmAudioPlayer.currentTime = cur;
                        bgmAudioPlayer.playbackRate = videoPlayer.playbackRate || 1.0;
                        bgmAudioPlayer.volume = state.bgmVolume || 0.60;
                        if (!videoPlayer.paused && isBgmEnabled) {
                            bgmAudioPlayer.play().catch(() => {});
                        }
                    }
                    if (!userExplicitlyToggledBgm) {
                        updateBgmUI(true);
                    } else {
                        updateBgmUI(isBgmEnabled);
                    }
                    setStatus("🎶 សំឡេង Background វីដេអូដើម (BGM) ត្រូវបានបំបែករួចរាល់ ១០០% គ្មានសំឡេងចិន!");
                    return;
                }
            } catch (e) {
                console.warn("BGM check error:", e);
            }

            if (attempts < maxAttempts) {
                setTimeout(checkAndLoad, 1000);
            }
        };

        checkAndLoad();
    }

    if (btnToggleBgm) {
        btnToggleBgm.addEventListener("click", async () => {
            userExplicitlyToggledBgm = true;
            if (isBgmEnabled) {
                // Turn OFF BGM
                updateBgmUI(false);
                if (bgmAudioPlayer) {
                    bgmAudioPlayer.pause();
                }
                setStatus("🔇 បានបិទភ្លេង Background (BGM)");
            } else {
                // Turn ON BGM
                if (!state.bgmPath || !bgmAudioPlayer || !bgmAudioPlayer.src) {
                    if (state.videoPath) {
                        setStatus("⏳ កំពុងទាញយកសំឡេង Background វីដេអូដើម...");
                        await setupExtractedBgm(null, state.bgmPath);
                    } else {
                        alert("អ្នកមិនទាន់បាន Upload វីដេអូ ឬភ្លេង Background ទេ!");
                        openModal("bgmModal");
                        return;
                    }
                }
                updateBgmUI(true);
                if (bgmAudioPlayer && bgmAudioPlayer.src) {
                    bgmAudioPlayer.volume = state.bgmVolume || 0.60;
                    bgmAudioPlayer.currentTime = videoPlayer.currentTime;
                    bgmAudioPlayer.playbackRate = videoPlayer.playbackRate || 1.0;
                    if (!videoPlayer.paused) {
                        bgmAudioPlayer.play().catch(() => {});
                    }
                }
                setStatus("🔊 បានបើកសំឡេង Background (BGM) វីដេអូដើម!");
            }
        });
    }

    // Toggle Mute / Unmute Original Video Audio (Chinese Spoken Speech)
    function setMuteState(isMuted) {
        state.muteOrigAudio = isMuted;
        videoPlayer.muted = isMuted;
        if (isMuted) {
            videoPlayer.volume = 0;
            state.origVolume = 0.0;
        } else {
            videoPlayer.volume = 1;
            state.origVolume = 0.15;
        }

        // 1. Update Video Player Button UI
        if (btnToggleOrigAudio && muteIcon && muteLabel) {
            if (isMuted) {
                btnToggleOrigAudio.style.background = "rgba(30, 41, 59, 0.7)";
                btnToggleOrigAudio.style.borderColor = "rgba(239, 68, 68, 0.4)";
                btnToggleOrigAudio.style.color = "#fca5a5";
                muteIcon.innerHTML = '<i data-lucide="volume-x"></i>';
                muteLabel.innerText = "ដើម: បិទ";
            } else {
                btnToggleOrigAudio.style.background = "linear-gradient(135deg, #064e3b, #059669)";
                btnToggleOrigAudio.style.borderColor = "#10b981";
                btnToggleOrigAudio.style.color = "#ecfdf5";
                muteIcon.innerHTML = '<i data-lucide="volume-2"></i>';
                muteLabel.innerText = "ដើម: បើក";
            }
        }

        // 2. Update Top Toolbar Button UI
        if (btnToolbarToggleOrigAudio && tbMuteIcon && tbMuteLabel) {
            if (isMuted) {
                btnToolbarToggleOrigAudio.classList.add("is-muted");
                tbMuteIcon.innerHTML = '<i data-lucide="volume-x"></i>';
                tbMuteLabel.innerText = "សម្លេងដើម: បិទ";
            } else {
                btnToolbarToggleOrigAudio.classList.remove("is-muted");
                tbMuteIcon.innerHTML = '<i data-lucide="volume-2"></i>';
                tbMuteLabel.innerText = "សម្លេងដើម: បើក";
            }
        }
        refreshIcons();

        if (isMuted) {
            setStatus("🔇 បានបិទសំឡេងដើម (សំឡេងនិយាយចិនត្រូវបានបិទស្ងាត់ ១០០%)");
        } else {
            setStatus("🔊 សម្លេងដើមត្រូវបានបើកដំណើរការឡើងវិញ។");
        }

        if (chkMuteOrigExport) {
            chkMuteOrigExport.checked = !isMuted;
            const chkText = document.getElementById("chkMuteOrigText");
            const chkLabel = chkMuteOrigExport.closest("label");
            if (chkText) {
                chkText.innerHTML = !isMuted
                    ? '<i data-lucide="volume-2" class="icon-sm"></i> ទុកសម្លេង Background វីដេអូដើម'
                    : '<i data-lucide="volume-x" class="icon-sm"></i> សម្លេង Background ដើម: បិទ';
            }
            if (chkLabel) {
                if (!isMuted) {
                    chkLabel.style.background = "#064e3b";
                    chkLabel.style.borderColor = "#10b981";
                    chkLabel.style.color = "#a7f3d0";
                } else {
                    chkLabel.style.background = "#2a1e12";
                    chkLabel.style.borderColor = "#f59e0b";
                    chkLabel.style.color = "#fde68a";
                }
            }
        }
    }

    if (btnToggleOrigAudio) {
        btnToggleOrigAudio.addEventListener("click", () => {
            setMuteState(!state.muteOrigAudio);
        });
    }

    if (btnToolbarToggleOrigAudio) {
        btnToolbarToggleOrigAudio.addEventListener("click", () => {
            setMuteState(!state.muteOrigAudio);
        });
    }

    if (chkMuteOrigExport) {
        chkMuteOrigExport.addEventListener("change", (e) => {
            // Checked = keep orig audio (!isMuted), Unchecked = mute orig audio (isMuted)
            setMuteState(!e.target.checked);
        });
    }

    // Keep video player strictly muted when muteOrigAudio is true across source loads
    videoPlayer.addEventListener("loadedmetadata", () => {
        videoPlayer.muted = state.muteOrigAudio;
        if (state.muteOrigAudio) {
            videoPlayer.volume = 0;
        }
    });

    // Initialize default mute state (Original Chinese voice muted by default)
    setMuteState(true);

    // Initialize Timeline
    const timeline = new VisualTimeline("timelineContainer", {
        duration: state.duration,
        onScrubStart: () => {
            state.wasPlayingBeforeScrub = !videoPlayer.paused;
            if (state.wasPlayingBeforeScrub) {
                videoPlayer.pause();
            }
            stopDubAudio();
        },
        onSeek: (time) => {
            stopDubAudio();
            videoPlayer.currentTime = time;
            if (currentTimeDisplay) {
                currentTimeDisplay.innerText = formatTime(time);
            }
            if (bgmAudioPlayer) {
                bgmAudioPlayer.currentTime = time;
                if (!videoPlayer.paused && isBgmEnabled) {
                    bgmAudioPlayer.play().catch(() => {});
                }
            }
            updateSubtitlePosition(time);
        },
        onScrubEnd: (time) => {
            if (state.wasPlayingBeforeScrub) {
                videoPlayer.play().catch(() => {});
            }
        },
        onSelectSegment: (seg) => {
            stopDubAudio();
            videoPlayer.currentTime = parseFloat(seg.start) || 0;
            highlightRow(seg.id);
        },
        onSegmentChange: (seg) => {
            // Update the corresponding table inputs for start, end, and voice
            const row = document.getElementById(`row-${seg.id}`);
            if (row) {
                const startInp = row.querySelector('[data-field="start"]');
                const endInp = row.querySelector('[data-field="end"]');
                const voiceSelect = row.querySelector('[data-field="voice"]');
                if (startInp) startInp.value = formatTime(seg.start);
                if (endInp) endInp.value = formatTime(seg.end);
                if (voiceSelect && seg.voice) voiceSelect.value = seg.voice;
            }
            clearSegmentAudioCache(seg.id);
            stopDubAudio();
            videoPlayer.currentTime = parseFloat(seg.start) || 0;
            highlightRow(seg.id);
            const genderLabel = (seg.voice && seg.voice.includes("Sreymom")) ? "ស្រី (Actor 2 - Sreymom)" : "ប្រុស (Actor 1 - Piseth)";
            setStatus(`🎭 ឃ្លាទី #${seg.id} ត្រូវបានប្តូរទៅតួ៖ ${genderLabel}`);
        }
    });

    // Format Time helper (seconds to M:SS.ms)
    function formatTime(seconds) {
        if (isNaN(seconds)) return "0:00.00";
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.floor((seconds - Math.floor(seconds)) * 100);
        return `${mins}:${secs.toString().padStart(2, "0")}.${ms.toString().padStart(2, "0")}`;
    }

    // Parse Time helper (M:SS.ms or SS.ms to seconds)
    function parseTime(str) {
        if (typeof str === "number") return str;
        str = (str || "").trim();
        if (str.includes(":")) {
            const parts = str.split(":");
            return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
        }
        return parseFloat(str) || 0;
    }

    // Update Progress
    function setProgress(percent, text) {
        progressBar.style.width = `${percent}%`;
        progressText.innerText = text ? `${percent}% - ${text}` : `${percent}%`;
    }

    // Set Status Message
    function setStatus(msg) {
        statusMessage.innerText = msg;
    }

    // Show Loading State in Table
    function renderLoadingTable(message) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="8" style="text-align: center; padding: 60px 20px; background: rgba(15, 23, 42, 0.6);">
                    <div style="font-size: 32px; animation: pulse 1.5s infinite; margin-bottom: 12px;">⚡</div>
                    <div style="font-size: 15px; font-weight: 700; color: #38bdf8;">${message || "កំពុងដំណើរការស្រង់សម្លេងចិន និងសម្រាយជាភាសាខ្មែរ..."}</div>
                    <div style="font-size: 12px; color: #94a3b8; margin-top: 8px;">AI កំពុងដំណើរការ Whisper Speech-to-Text និងបកប្រែសម្រាយរឿង សូមរង់ចាំបន្តិច...</div>
                </td>
            </tr>
        `;
    }

    // Render Table Rows
    function renderTable() {
        tableBody.innerHTML = "";
        segmentCount.innerText = state.segments.length;
        const tlBadge = document.getElementById("timelineSegCountBadge");
        if (tlBadge) {
            tlBadge.innerText = `បង្ហាញ៖ ${state.segments.length} ប្រយោគ (ទាំងអស់)`;
        }

        if (!state.segments || state.segments.length === 0) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="8" style="text-align: center; padding: 60px 20px; color: #64748b;">
                        <div style="margin-bottom: 10px;"><i data-lucide="clapperboard" style="width: 44px; height: 44px; color: #f59e0b;"></i></div>
                        <div style="font-size: 14px; font-weight: 600; color: #cbd5e1;">មិនទាន់មានស្គ្រីបអត្ថបទនៅឡើយទេ</div>
                        <div style="font-size: 12px; color: #94a3b8; margin-top: 6px;">
                            សូមចុចប៊ូតុង <strong><i data-lucide="sparkles" style="width: 12px; height: 12px;"></i> ចាប់យកស្គ្រីប & សម្រាយជាខ្មែរ</strong> ខាងលើ ដើម្បីឱ្យ AI ចាប់យកសម្លេងចិន និងបំលែងជាអត្ថបទខ្មែរ
                        </div>
                    </td>
                </tr>
            `;
            timeline.renderSegments([]);
            refreshIcons();
            return;
        }

        const tableFrag = document.createDocumentFragment();

        state.segments.forEach((seg, idx) => {
            const tr = document.createElement("tr");
            tr.id = `row-${seg.id}`;
            tr.dataset.id = seg.id;

            tr.innerHTML = `
                <td class="col-idx">${seg.id}</td>
                <td class="col-time">
                    <input class="input-cell time-input" data-field="start" value="${formatTime(seg.start)}">
                </td>
                <td class="col-time">
                    <input class="input-cell time-input" data-field="end" value="${formatTime(seg.end)}">
                </td>
                <td class="col-orig">
                    <textarea class="input-cell orig-input" data-field="original" rows="2">${seg.original || ""}</textarea>
                </td>
                <td class="col-trans">
                    <textarea class="input-cell trans-input" data-field="translated" rows="2" placeholder="អត្ថបទសម្រាយរឿងខ្មែរ...">${seg.translated || ""}</textarea>
                </td>
                <td class="col-voice">
                    <select class="select-voice" data-field="voice">
                        <option value="km-KH-PisethNeural" ${seg.voice === "km-KH-PisethNeural" ? "selected" : ""}>km-KH-Piseth (ប្រុស)</option>
                        <option value="km-KH-SreymomNeural" ${seg.voice === "km-KH-SreymomNeural" ? "selected" : ""}>km-KH-Sreymom (ស្រី)</option>
                    </select>
                </td>
                <td class="col-action">
                    <button class="btn-play-line" title="ស្តាប់សម្លេង"><i data-lucide="play"></i></button>
                </td>
                <td class="col-action">
                    <button class="btn-del-line" title="លុបជួរ"><i data-lucide="trash-2"></i></button>
                </td>
            `;

            // Row click event (seek video & scroll timeline to center this segment)
            tr.addEventListener("click", (e) => {
                if (!e.target.closest("input") && !e.target.closest("textarea") && !e.target.closest("select") && !e.target.closest("button")) {
                    stopDubAudio();
                    lastSpokenIndex = idx - 1;
                    const st = parseFloat(seg.start) || 0;
                    videoPlayer.currentTime = st;
                    currentTimeDisplay.innerText = formatTime(st);
                    timeline.updateCursor(st);
                    if (timeline.scrollToSegment) {
                        timeline.scrollToSegment(seg.id);
                    }
                    highlightRow(seg.id);
                }
            });

            // Input changes
            const startInput = tr.querySelector('[data-field="start"]');
            const endInput = tr.querySelector('[data-field="end"]');
            const origInput = tr.querySelector('[data-field="original"]');
            const transInput = tr.querySelector('[data-field="translated"]');
            const voiceSelect = tr.querySelector('[data-field="voice"]');
            const btnPlay = tr.querySelector(".btn-play-line");
            const btnDel = tr.querySelector(".btn-del-line");

            startInput.addEventListener("change", () => {
                seg.start = parseTime(startInput.value);
                startInput.value = formatTime(seg.start);
                timeline.renderSegments(state.segments);
            });

            endInput.addEventListener("change", () => {
                seg.end = parseTime(endInput.value);
                endInput.value = formatTime(seg.end);
                timeline.renderSegments(state.segments);
            });

            origInput.addEventListener("input", () => {
                seg.original = origInput.value;
            });

            transInput.addEventListener("input", () => {
                seg.translated = transInput.value;
                clearSegmentAudioCache(seg.id);
                timeline.renderSegments(state.segments);
            });

            voiceSelect.addEventListener("change", () => {
                seg.voice = voiceSelect.value;
                seg.actor = seg.voice.includes("Piseth") ? "Actor 1" : "Actor 2";
                clearSegmentAudioCache(seg.id);
                stopDubAudio();
                timeline.renderSegments(state.segments);
            });

            // Play TTS preview
            btnPlay.addEventListener("click", async () => {
                const text = (seg.translated || "").trim();
                if (!text) {
                    alert("សូមបញ្ចូលអត្ថបទសម្រាយខ្មែរជាមុនសិន!");
                    return;
                }
                btnPlay.innerHTML = '<i data-lucide="volume-2"></i>';
                refreshIcons();
                try {
                    const audioData = await getSegmentAudio(seg);
                    if (audioData && audioData.url) {
                        previewAudio.src = audioData.url;
                        previewAudio.currentTime = 0;
                        previewAudio.play();
                    } else {
                        alert("មិនអាចបង្កើតសម្លេងបានទេ សូមពិនិត្យ Internet");
                    }
                } catch (err) {
                    console.error("Preview TTS error:", err);
                } finally {
                    btnPlay.innerHTML = '<i data-lucide="play"></i>';
                    refreshIcons();
                }
            });

            // Delete row
            btnDel.addEventListener("click", () => {
                state.segments = state.segments.filter(s => s.id !== seg.id);
                // reindex
                state.segments.forEach((s, i) => s.id = i + 1);
                renderTable();
                timeline.renderSegments(state.segments);
            });

            tableFrag.appendChild(tr);
        });

        tableBody.appendChild(tableFrag);
        refreshIcons();

        timeline.renderSegments(state.segments);
        triggerBackendPreload();
        if (typeof syncCurrentPlaylistEpisode === "function") {
            syncCurrentPlaylistEpisode();
        }

        // ★ Pre-warm TTS audio cache for first 12 segments immediately
        // So audio is ready before user presses Play (no delay on first segments)
        setTimeout(() => {
            const warmCount = Math.min(12, state.segments.length);
            for (let i = 0; i < warmCount; i++) {
                const seg = state.segments[i];
                if (seg && (seg.translated || "").trim() && !audioCache[seg.id]) {
                    getSegmentAudio(seg); // background fetch, fire-and-forget
                }
            }
        }, 500);

        // ---------------------------------------------------------------------
        // Translation utilities – Chinese → Khmer (using MyMemory free API)
        // ---------------------------------------------------------------------
        /** Detect if a string contains any Chinese characters. */
        function containsChinese(txt) {
            return /[\u4e00-\u9fff]/.test(txt);
        }

        /** Translate a given text from Chinese (zh) to Khmer (km) via MyMemory API. */
        async function translateChineseToKhmer(text) {
            const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=zh|km`;
            try {
                const resp = await fetch(url);
                const data = await resp.json();
                if (data && data.responseData && data.responseData.translatedText) {
                    return data.responseData.translatedText;
                }
                console.warn('MyMemory translation failed, returning original');
                return text;
            } catch (e) {
                console.error('Translation error:', e);
                return text;
            }
        }

        /** Translate all subtitle rows whose original text contains Chinese characters. */
        async function translateAllChineseSegments() {
            if (!state.segments || state.segments.length === 0) {
                alert('📭 គ្មានជួរដេកសម្រាប់បកប្រែទេ!');
                return;
            }
            const promises = state.segments.map(async seg => {
                if (containsChinese(seg.original)) {
                    const kh = await translateChineseToKhmer(seg.original);
                    seg.translated = kh;
                }
            });
            await Promise.all(promises);
            renderTable();
            if (timeline && timeline.renderSegments) timeline.renderSegments(state.segments);
            setStatus(`✅ បានបកប្រែ ${state.segments.filter(s => containsChinese(s.original)).length} ជួរ​។`);
            alert('✅ បកប្រែ​បញ្ចប់!');
        }

        // Add a button to the toolbar for translating Chinese → Khmer (if toolbar exists)
        document.addEventListener('DOMContentLoaded', () => {
            const toolbar = document.getElementById('toolbar');
            if (toolbar && !document.getElementById('btnTranslateAll')) {
                const btn = document.createElement('button');
                btn.id = 'btnTranslateAll';
                btn.innerText = '🔁 បកប្រែចិន→ខ្មែរ';
                btn.style.marginLeft = '8px';
                btn.addEventListener('click', translateAllChineseSegments);
                toolbar.appendChild(btn);
            }
        });
    }

    function highlightRow(id) {
        document.querySelectorAll(".dub-table tr").forEach(r => r.classList.remove("active-row"));
        const targetRow = document.getElementById(`row-${id}`);
        if (targetRow) {
            targetRow.classList.add("active-row");
            targetRow.scrollIntoView({ behavior: "smooth", block: "center" });
        }
    }

    // State for tracking audio playback completion
    let isDubAudioPlaying = false;
    
    // Queue: ID of next segment to play after current audio finishes
    let pendingNextSegId = null;

    // Track the highest spoken segment index to prevent skipping any line
    let lastSpokenIndex = -1;

    // Global registry of all playing Audio instances to ensure none can loop in the background
    window._activeAudioInstances = [];

    // ─── Core dub player: ធានានិយាយចប់ ១០០% និងដាច់ខាតមិនរំលងប្រយោគណាមួយឡើយ ────────
    function playSegmentByIndex(idx) {
        if (!state.segments || idx < 0 || idx >= state.segments.length) {
            isDubAudioPlaying = false;
            return;
        }
        if (!state.enableLiveDub || videoPlayer.paused || !state.videoPath) {
            isDubAudioPlaying = false;
            return;
        }

        const seg = state.segments[idx];
        if (!seg) return;

        const text = (seg.translated || seg.original || "").trim();
        if (!text) {
            lastSpokenIndex = idx;
            isDubAudioPlaying = false;
            const nextIdx = idx + 1;
            if (nextIdx < state.segments.length && videoPlayer.currentTime >= (parseFloat(state.segments[nextIdx].start) - 0.05)) {
                playSegmentByIndex(nextIdx);
            }
            return;
        }

        // Lock playback state immediately to this segment index
        isDubAudioPlaying = true;
        currentPlayingSegId = seg.id;
        lastSpokenIndex = idx;

        // Highlight table row
        highlightRow(seg.id);
        // ★ Let updateSubtitlePosition handle subtitle via video time (called by timeupdate)
        // Do NOT force-set subtitle here — it would show WRONG text if audio takes time to load

        // Pre-fetch next 10 segments in background so audio is always pre-cached and instant
        prefetchUpcomingAudio(idx, 10);

        getSegmentAudio(seg).then(audioData => {
            // Re-verify conditions
            if (!audioData || !state.videoPath || videoPlayer.paused) {
                isDubAudioPlaying = false;
                activeDubAudio = null;
                return;
            }

            // If user jumped to another segment while downloading, cancel
            if (currentPlayingSegId !== seg.id) return;

            const cur = videoPlayer.currentTime;
            const segStart = parseFloat(seg.start);
            const segEnd = parseFloat(seg.end);
            const segSlot = Math.max(0.4, (segEnd - segStart));
            const nextSeg = (idx + 1 < state.segments.length) ? state.segments[idx + 1] : null;
            const nextStart = nextSeg ? parseFloat(nextSeg.start) : (segStart + segSlot + 2.0);
            const availableSlot = Math.max(segSlot, nextStart - segStart);
            const dur = audioData.duration || 0;

            // ★ Dynamic tempo matching: slightly boost rate (up to 1.30x max) if speech exceeds available dialogue slot
            // This ensures Khmer speech finishes right as or before the Chinese speaker ends!
            let neededRate = 1.0;
            if (dur > 0 && availableSlot > 0.3 && dur > availableSlot * 1.05) {
                neededRate = Math.min(1.30, Math.max(1.0, dur / availableSlot));
            }
            liveDubAudioPlayer.playbackRate = neededRate;

            liveDubAudioPlayer.src = audioData.url;
            activeDubAudio = liveDubAudioPlayer;
            liveDubAudioPlayer.currentTime = 0;
            isDubAudioPlaying = true;

            // ★ ធានានិយាយចប់ ១០០% មួយប្រយោគសិន ទើបអាចចូលនិយាយប្រយោគបន្ទាប់បាន (ដាច់ខាតមិនរំលង និងមិនកាត់ផ្ដាច់)
            liveDubAudioPlayer.onended = () => {
                isDubAudioPlaying = false;
                activeDubAudio = null;
                currentPlayingSegId = null;

// Video plays continuously without interruption

                // ប្រសិនបើវីដេអូរត់ដល់ចប់ហើយ ប្តូរប៊ូតុងមក ▶ Play វិញ និងចាក់ភាគបន្ទាប់
                if (videoPlayer.ended || (videoPlayer.duration && videoPlayer.currentTime >= videoPlayer.duration - 0.25)) {
                    updatePlayPauseUI(false);
                    triggerAutoPlayNextEpisode();
                    return;
                }

                const curTime = videoPlayer.currentTime;

                // ─── បន្ទាប់ពីប្រយោគនេះនិយាយចប់ ១០០%៖ រកមើល segment ដែលវីដេអូកំពុងស្ថិតនៅជាក់ស្ដែង ───
                let nextToPlay = state.segments.findIndex(s => {
                    const st = parseFloat(s.start);
                    const en = parseFloat(s.end);
                    return curTime >= (st - 0.10) && curTime < (en + 0.35);
                });

                if (nextToPlay !== -1 && nextToPlay !== lastSpokenIndex) {
                    playSegmentByIndex(nextToPlay);
                    return;
                }

                // ប្រសិនបើវីដេអូនៅចន្លោះស្ងាត់ (gap)៖ ពិនិត្យមើលប្រយោគបន្ទាប់
                const nextIdx = idx + 1;
                if (nextIdx < state.segments.length) {
                    const nextCandidateStart = parseFloat(state.segments[nextIdx].start);
                    if (curTime >= (nextCandidateStart - 0.10)) {
                        playSegmentByIndex(nextIdx);
                        return;
                    }
                    lastSpokenIndex = idx;
                }
            };

            liveDubAudioPlayer.onerror = (e) => {
                console.warn("Live dub play error:", e);
                isDubAudioPlaying = false;
                activeDubAudio = null;
            };

            liveDubAudioPlayer.play().catch(err => {
                console.log("Live dub play error:", err);
                isDubAudioPlaying = false;
                activeDubAudio = null;
            });
        });
    }

    // Stop and reset live dubbing audio
    function stopDubAudio(resetIndex = false) {
        if (liveDubAudioPlayer) {
            try {
                liveDubAudioPlayer.pause();
                liveDubAudioPlayer.currentTime = 0;
                liveDubAudioPlayer.onended = null;
                liveDubAudioPlayer.onerror = null;
            } catch (e) {}
        }
        activeDubAudio = null;
        currentPlayingSegId = null;
        pendingNextSegId = null;
        isDubAudioPlaying = false;

        if (resetIndex) {
            lastSpokenIndex = -1;
        }

        // Force stop every audio instance in memory
        if (window._activeAudioInstances && window._activeAudioInstances.length > 0) {
            window._activeAudioInstances.forEach(a => {
                try {
                    a.pause();
                    a.currentTime = 0;
                } catch (e) {}
            });
            window._activeAudioInstances = [];
        }
    }

    // Stop all possible audio across the app immediately
    function killAllAudio() {
        stopDubAudio(true);
        if (bgmAudioPlayer) {
            try {
                bgmAudioPlayer.pause();
                bgmAudioPlayer.currentTime = 0;
            } catch (e) {}
        }
        if (previewAudio) {
            try {
                previewAudio.pause();
                previewAudio.currentTime = 0;
                previewAudio.removeAttribute("src");
                previewAudio.load();
            } catch (e) {}
        }
        if (videoPlayer) {
            try {
                videoPlayer.pause();
                videoPlayer.currentTime = 0;
            } catch (e) {}
        }
    }

    // ─── Single-Line Khmer Subtitle Splitting & Synchronization ─────────────
    function splitKhmerSingleLineChunks(text, maxLen = 18) {
        if (!text || text.length <= maxLen) return [text];
        const chunks = [];
        let rem = text.trim();
        while (rem.length > maxLen) {
            let cut = -1;
            // 1. Check space or punctuation
            for (let i = Math.min(rem.length - 1, maxLen + 2); i >= Math.max(1, maxLen - 6); i--) {
                if (/[\s,，.!?！？\t\n]/.test(rem[i])) {
                    cut = rem[i] === ' ' ? i : i + 1;
                    break;
                }
            }
            // 2. Break before an independent base consonant (avoid breaking subscript Coeng \u17D2)
            if (cut === -1) {
                for (let i = Math.min(rem.length - 1, maxLen); i >= Math.max(2, maxLen - 7); i--) {
                    const code = rem.charCodeAt(i);
                    const prevCode = rem.charCodeAt(i - 1);
                    if (code >= 0x1780 && code <= 0x17A2 && prevCode !== 0x17D2) {
                        cut = i;
                        break;
                    }
                }
            }
            if (cut === -1 || cut === 0) cut = maxLen;
            const part = rem.substring(0, cut).trim();
            if (part) chunks.push(part);
            rem = rem.substring(cut).trim();
        }
        if (rem) chunks.push(rem);
        return chunks;
    }

    function updateSubtitlePosition(curTime) {
        if (!state.segments || state.segments.length === 0 || !state.showSubtitles) {
            subtitlePreview.innerText = "";
            subtitlePreview.style.display = "none";
            return;
        }

        // ★ VIDEO-TIME PRIMARY: Always use video currentTime to find the matching segment.
        // This ensures subtitle matches the Chinese burned-in subtitles on screen exactly.
        let activeSeg = state.segments.find(s => {
            const st = parseFloat(s.start);
            const en = parseFloat(s.end);
            return curTime >= st && curTime < en;
        });

        // ★ GAP FALLBACK: If video is in a silent gap between segments AND dub audio
        // is currently playing, show the audio segment's text so user sees what is being spoken.
        if (!activeSeg && isDubAudioPlaying && currentPlayingSegId) {
            const audioSeg = state.segments.find(s => s.id === currentPlayingSegId) || null;
            // Only use audio-driven text if audio's segment is CLOSE to current video time (within 3s)
            if (audioSeg) {
                const audioEnd = parseFloat(audioSeg.end);
                const audioStart = parseFloat(audioSeg.start);
                if (curTime >= (audioStart - 0.5) && curTime <= (audioEnd + 3.0)) {
                    activeSeg = audioSeg;
                }
            }
        }

        if (activeSeg) {
            highlightRow(activeSeg.id);
            // Always show full translated (or original) text — no chunking that causes word mismatch
            const rawText = (activeSeg.translated || activeSeg.original || "").trim();
            if (!rawText) {
                subtitlePreview.innerText = "";
                subtitlePreview.style.display = "none";
                return;
            }

            subtitlePreview.innerText = rawText;
            subtitlePreview.style.display = "block";
            subtitlePreview.style.opacity = "1";

            // Keep subtitle width inside video bounds
            if (videoPlayer && videoPlayer.clientWidth) {
                subtitlePreview.style.maxWidth = `${Math.floor(videoPlayer.clientWidth * 0.92)}px`;
            }
        } else {
            subtitlePreview.innerText = "";
            subtitlePreview.style.display = "none";
            // Auto-focus on upcoming segment if before first speech
            if (state.segments.length > 0 && curTime < parseFloat(state.segments[0].start)) {
                const firstRow = document.getElementById(`row-${state.segments[0].id}`);
                if (firstRow && !firstRow.classList.contains("active-row")) {
                    document.querySelectorAll(".dub-table tr").forEach(r => r.classList.remove("active-row"));
                    firstRow.classList.add("active-row");
                    firstRow.scrollIntoView({ behavior: "smooth", block: "center" });
                }
            }
        }
    }

    // Video Player Events
    videoPlayer.addEventListener("timeupdate", () => {
        // ដាច់ខាតមិនចាក់សម្លេងអ្វីទាំងអស់ ប្រសិនបើគ្មានវីដេអូ ឬគ្មាន segments
        if (!state.videoPath || !state.segments || state.segments.length === 0) {
            stopDubAudio(false);
            subtitlePreview.innerText = "";
            return;
        }

        const cur = videoPlayer.currentTime;
        currentTimeDisplay.innerText = formatTime(cur);
        timeline.updateCursor(cur);

        // ★ TIME-BASED SYNCHRONIZATION: Subtitle text strictly matches the video's current second!
        updateSubtitlePosition(cur);

        // Sync BGM with video if drifting
        if (isBgmEnabled && bgmAudioPlayer && !bgmAudioPlayer.paused && state.bgmPath) {
            const bgmDrift = Math.abs(bgmAudioPlayer.currentTime - cur);
            if (bgmDrift > 0.65) {
                bgmAudioPlayer.currentTime = cur;
            }
        }

        if (videoPlayer.paused) {
            // ប្រសិនបើវីដេអូរត់ដល់ចុងបញ្ចប់ ប៉ុន្តែសម្លេងប្រយោគចុងក្រោយកំពុងនិយាយ សូមកុំកាត់ផ្ដាច់ ទុកឱ្យនិយាយចប់ ១០០%
            const isAtEnd = videoPlayer.ended || (videoPlayer.duration && cur >= videoPlayer.duration - 0.25);
            if (isAtEnd && isDubAudioPlaying) {
                return; // កុំកាត់ផ្ដាច់សម្លេងប្រយោគចុងក្រោយ
            }
            stopDubAudio(false);
            return;
        }

        // ★ SYNCHRONIZED PLAYBACK: ធានាសម្លេងនិយាយត្រូវគ្នានឹងវីដេអូ ១០០% និងដាច់ខាតមិនរអិលខុសប្រយោគឡើយ
        if (currentPlayingSegId) {
            highlightRow(currentPlayingSegId);
        }

        if (state.enableLiveDub && !videoPlayer.paused) {
            // 1. រកមើល Segment ដែលត្រូវនឹងវិនាទីបច្ចុប្បន្នរបស់វីដេអូ (cur):
            let activeIdx = state.segments.findIndex(s => {
                const st = parseFloat(s.start);
                const en = parseFloat(s.end);
                return cur >= (st - 0.08) && cur < (en + 0.30);
            });

            // ប្រសិនបើវីដេអូនៅចន្លោះស្ងាត់ (gap) រកមើល segment បន្ទាប់ដែលជិតមកដល់ (< 0.08s)
            if (activeIdx === -1) {
                const upcoming = state.segments.findIndex(s => parseFloat(s.start) > cur);
                if (upcoming !== -1 && cur >= (parseFloat(state.segments[upcoming].start) - 0.08)) {
                    activeIdx = upcoming;
                }
            }

            if (activeIdx !== -1) {
                if (!isDubAudioPlaying) {
                    // មិនមានសម្លេងកំពុងនិយាយ៖ ចាក់ segment នេះភ្លាម!
                    if (activeIdx !== lastSpokenIndex) {
                        playSegmentByIndex(activeIdx);
                    }
                } else if (currentPlayingSegId) {
                    // សម្លេងកំពុងនិយាយ៖ ពិនិត្យមើលថាតើវីដេអូបានរត់ឆ្ងាយហួសពីសម្លេងនេះ (> 1 segment) ដែរឬទេ?
                    const curPlayingIdx = state.segments.findIndex(s => s.id === currentPlayingSegId);
                    if (curPlayingIdx !== -1 && Math.abs(activeIdx - curPlayingIdx) > 1) {
                        // វីដេអូបានរត់ទៅមុខឆ្ងាយ ឬអ្នកប្រើបានរំកិល Timeline៖ បញ្ឈប់សម្លេងចាស់ ហើយចាក់ segment ត្រូវវីដេអូភ្លាម!
                        stopDubAudio(false);
                        playSegmentByIndex(activeIdx);
                    }
                }
            } else {
                // នៅក្នុងចន្លោះស្ងាត់ (gap)៖ រក្សាស៊ីចង្វាក់ lastSpokenIndex តាមវិនាទីវីដេអូ
                if (!isDubAudioPlaying) {
                    const upcoming = state.segments.findIndex(s => parseFloat(s.start) > cur);
                    if (upcoming !== -1) {
                        lastSpokenIndex = upcoming - 1;
                    }
                }
            }
        }
    });

    videoPlayer.addEventListener("pause", () => {
        // ប្រសិនបើវីដេអូរត់ដល់ចប់ (ended) សូមកុំកាត់ផ្ដាច់សម្លេងប្រយោគចុងក្រោយដែលកំពុងបន្លឺ
        const isAtEnd = videoPlayer.ended || (videoPlayer.duration && videoPlayer.currentTime >= videoPlayer.duration - 0.25);
        if (isAtEnd && isDubAudioPlaying) {
            return; // ទុកឱ្យសម្លេងប្រយោគចុងក្រោយនិយាយចប់សព្វគ្រប់សិន
        }

        if (activeDubAudio && !activeDubAudio.paused) {
            activeDubAudio.pause();
        }
        if (bgmAudioPlayer && !bgmAudioPlayer.paused) {
            bgmAudioPlayer.pause();
        }
        updatePlayPauseUI(false);
        updateSubtitlePosition(videoPlayer.currentTime);
    });

    videoPlayer.addEventListener("ended", () => {
        if (!isDubAudioPlaying) {
            stopDubAudio(false);
            updatePlayPauseUI(false);
            triggerAutoPlayNextEpisode();
        }
    });

    // ─── Browser Video Decoder Stall Watchdog & Dub Synchronization ────────
    let lastObservedVideoTime = -1;
    let lastObservedWallTime = Date.now();
    let stallNudgeCount = 0;

    videoPlayer.addEventListener("waiting", () => {
        // Video is waiting for frames or buffering: pause dub voice immediately so audio doesn't run ahead!
        if (activeDubAudio && !activeDubAudio.paused) {
            try { activeDubAudio.pause(); } catch (e) {}
        }
        if (bgmAudioPlayer && !bgmAudioPlayer.paused) {
            try { bgmAudioPlayer.pause(); } catch (e) {}
        }
        updateSubtitlePosition(videoPlayer.currentTime);
    });

    videoPlayer.addEventListener("playing", () => {
        lastObservedWallTime = Date.now();
        stallNudgeCount = 0;
        // Resume dub voice when video resumes, but only if video is still within that segment's window
        if (activeDubAudio && activeDubAudio.paused && isDubAudioPlaying) {
            const cur = videoPlayer.currentTime;
            if (currentPlayingSegId) {
                const curSeg = state.segments.find(s => s.id === currentPlayingSegId);
                if (curSeg) {
                    activeDubAudio.play().catch(() => {});
                }
            }
        }
        if (isBgmEnabled && bgmAudioPlayer && bgmAudioPlayer.paused && state.bgmPath) {
            bgmAudioPlayer.currentTime = videoPlayer.currentTime;
            bgmAudioPlayer.playbackRate = videoPlayer.playbackRate || 1.0;
            bgmAudioPlayer.volume = state.bgmVolume || 0.60;
            bgmAudioPlayer.play().catch(() => {});
        }
    });

    // Safe playback monitor: Auto-recovers from any browser video decoder stall or buffering hiccup!
    setInterval(() => {
        if (!videoPlayer || videoPlayer.paused || videoPlayer.ended || !state.videoPath) {
            lastObservedVideoTime = -1;
            stallNudgeCount = 0;
            return;
        }

        // Only ignore if user is actively dragging the slider
        if (videoPlayer.seeking) {
            lastObservedWallTime = Date.now();
            return;
        }

        const now = Date.now();
        const cur = videoPlayer.currentTime;

        // 1. ករណីជាប់គាំងនៅដើមវីដេអូ (< 0.25s)៖ ដោះស្រាយតែ ១ ដងគត់បើគាំងលើស 600ms
        if (cur < 0.25 && stallNudgeCount < 1) {
            if (lastObservedVideoTime >= 0 && Math.abs(cur - lastObservedVideoTime) < 0.02) {
                if (now - lastObservedWallTime > 600) {
                    stallNudgeCount++;
                    videoPlayer.currentTime = 0.18;
                    videoPlayer.play().catch(() => {});
                    lastObservedWallTime = now;
                    lastObservedVideoTime = 0.18;
                    return;
                }
            } else {
                lastObservedVideoTime = cur;
                lastObservedWallTime = now;
                return;
            }
        }

        // 2. កំឡុងពេលចាក់ធម្មតា (> 0.25s)៖ កុំបង្ខំកែ videoPlayer.currentTime ព្រោះវាធ្វើឱ្យវីដេអូលោតទាក់ៗ (Keyframe Seek Loop)
        lastObservedVideoTime = cur;
        lastObservedWallTime = now;
    }, 500);

    videoPlayer.addEventListener("play", () => {
        updatePlayPauseUI(true);

        // Play BGM in sync if enabled
        if (isBgmEnabled && bgmAudioPlayer && state.bgmPath) {
            bgmAudioPlayer.currentTime = videoPlayer.currentTime;
            bgmAudioPlayer.playbackRate = videoPlayer.playbackRate || 1.0;
            bgmAudioPlayer.volume = state.bgmVolume || 0.60;
            bgmAudioPlayer.play().catch(() => {});
        }

        // Resume audio if currently in an active segment
        if (state.enableLiveDub && activeDubAudio && isDubAudioPlaying) {
            activeDubAudio.play().catch(() => {});
        }
    });

    videoPlayer.addEventListener("seeking", () => {
        stopDubAudio(false);
        if (isBgmEnabled && bgmAudioPlayer && state.bgmPath) {
            bgmAudioPlayer.currentTime = videoPlayer.currentTime;
        }
        updateSubtitlePosition(videoPlayer.currentTime);
    });

    videoPlayer.addEventListener("seeked", () => {
        stopDubAudio(false);
        const cur = videoPlayer.currentTime;
        currentTimeDisplay.innerText = formatTime(cur);
        timeline.updateCursor(cur);
        if (bgmAudioPlayer) {
            bgmAudioPlayer.currentTime = cur;
            if (!videoPlayer.paused && isBgmEnabled) {
                bgmAudioPlayer.play().catch(() => {});
            }
        }
        updateSubtitlePosition(cur);
        // Snap immediately to whatever segment matches the new seek position:
        let targetIdx = state.segments.findIndex(s => cur >= (parseFloat(s.start) - 0.20) && cur < (parseFloat(s.end) + 0.35));
        if (targetIdx !== -1) {
            lastSpokenIndex = targetIdx - 1;
            if (!videoPlayer.paused && state.enableLiveDub) {
                playSegmentByIndex(targetIdx);
            }
        } else {
            const upcomingIdx = state.segments.findIndex(s => parseFloat(s.start) > cur);
            lastSpokenIndex = upcomingIdx !== -1 ? upcomingIdx - 1 : state.segments.length - 1;
        }
    });

    videoPlayer.addEventListener("loadedmetadata", () => {
        state.duration = videoPlayer.duration || 20;
        durationDisplay.innerText = formatTime(state.duration);
        timeline.setDuration(state.duration);
        // Automatically resize video frame to exact dimensions of original uploaded video
        fitVideoToOriginal();
    });

    videoPlayer.addEventListener("loadeddata", () => {
        fitVideoToOriginal();
    });

    videoPlayer.addEventListener("error", () => {
        console.warn("videoPlayer encountered an error loading src:", videoPlayer.src);
        if (state.videoUrl && videoPlayer.src !== state.videoUrl && !videoPlayer.src.endsWith(state.videoUrl)) {
            console.log("Automatically falling back to original video URL:", state.videoUrl);
            state.useProxy = false;
            updateProxyDisplay();
            videoPlayer.src = state.videoUrl;
            videoPlayer.load();
        }
    });

    window.addEventListener("resize", () => {
        fitVideoToOriginal();
    });

    // Control buttons
    const btnPlayPause = document.getElementById("btnPlayPause");
    btnPlayPause.addEventListener("click", () => {
        if (videoPlayer.paused) {
            // ប្រសិនបើវីដេអូរត់ដល់ចុងបញ្ចប់ហើយ ចុច Play នឹងចាក់សាឡើងវិញពីដើម
            if (videoPlayer.ended || (videoPlayer.duration && videoPlayer.currentTime >= videoPlayer.duration - 0.25)) {
                videoPlayer.currentTime = 0.15;
                lastSpokenIndex = -1;
            } else if (videoPlayer.currentTime < 0.15) {
                // ប្រសិនបើ playhead នៅ 0:00 (ឬក្រោម 0.15s) ត្រូវរំកិលទៅ 0.15s ដើម្បីរំលង audio pre-roll gap និងជៀសវាង hardware decoder deadlock
                videoPlayer.currentTime = 0.15;
            }
            const playPromise = videoPlayer.play();
            if (playPromise !== undefined) {
                playPromise.then(() => {
                    updatePlayPauseUI(true);
                    // ធានាថាក្រោយ 150ms playhead ត្រូវតែរំកិលទៅមុខ មិនឲ្យជាប់គាំងនៅ 0:00 ជាដាច់ខាត
                    setTimeout(() => {
                        if (!videoPlayer.paused && videoPlayer.currentTime < 0.15) {
                            videoPlayer.currentTime = 0.18;
                            videoPlayer.play().catch(() => {});
                        }
                    }, 150);
                }).catch(err => {
                    console.warn('Playback error or blocked by browser policy:', err);
                    updatePlayPauseUI(false);
                    // If blocked due to unmuted sound, ensure muted and retry cleanly
                    if (!videoPlayer.muted) {
                        videoPlayer.muted = true;
                        videoPlayer.play().then(() => updatePlayPauseUI(true)).catch(() => {});
                    }
                });
            } else {
                updatePlayPauseUI(true);
            }
        } else {
            // អ្នកប្រើចុច Pause ដោយចេតនា៖ ផ្អាកទាំងវីដេអូ និងសម្លេង
            videoPlayer.pause();
            if (activeDubAudio && !activeDubAudio.paused) {
                activeDubAudio.pause();
            }
            if (bgmAudioPlayer && !bgmAudioPlayer.paused) {
                bgmAudioPlayer.pause();
            }
            updatePlayPauseUI(false);
        }
    });

    document.getElementById("btnRewind").addEventListener("click", () => {
        stopDubAudio();
        videoPlayer.currentTime = Math.max(0.12, videoPlayer.currentTime - 3);
    });

    document.getElementById("btnForward").addEventListener("click", () => {
        stopDubAudio();
        videoPlayer.currentTime = Math.min(videoPlayer.duration || 60, videoPlayer.currentTime + 3);
    });

    // Process uploaded or dropped video file
    async function processUploadedVideoFile(file) {
        if (!file) return;
        console.log("Processing video file:", file.name, file.size);

        // 1. Immediately clear old segments and timeline blocks completely
        state.segments = [];
        clearAudioCache();
        killAllAudio();
        timeline.renderSegments([]);
        segmentCount.innerText = "0";
        subtitlePreview.innerText = "";

        // 2. Immediately preview local video without waiting for upload to complete
        const localVideoUrl = URL.createObjectURL(file);
        videoPlayer.src = localVideoUrl;
        videoPlayer.load();
        videoStatus.innerText = file.name;

        renderLoadingTable("កំពុងចាប់យកស្គ្រីបពីវីដេអូចិន និងបំលែងជាភាសាខ្មែរ...");
        setStatus(`កំពុង Upload វីដេអូ: ${file.name}...`);
        setProgress(25, "Uploading Video");

        const formData = new FormData();
        formData.append("file", file);

        try {
            const data = await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open("POST", "/api/upload-video", true);
                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable) {
                        const pct = Math.min(95, Math.round((e.loaded / e.total) * 90));
                        const loadedMb = (e.loaded / (1024 * 1024)).toFixed(1);
                        const totalMb = (e.total / (1024 * 1024)).toFixed(1);
                        setProgress(pct, `Uploading ${pct}% (${loadedMb}MB / ${totalMb}MB)`);
                        setStatus(`កំពុង Upload វីដេអូ (${pct}%) [${loadedMb}MB / ${totalMb}MB]...`);
                    }
                };
                xhr.onload = () => {
                    try {
                        const resp = JSON.parse(xhr.responseText);
                        if (xhr.status >= 200 && xhr.status < 300) {
                            resolve(resp);
                        } else if (xhr.status === 404) {
                            reject(new Error("Server Port ត្រូវបានប៉ះទង្គិច ឬមិនទាន់ដំណើរការ សូមបើកដំណើរការ Vocal Studio ឡើងវិញ"));
                        } else {
                            reject(new Error(resp.detail || `Upload failed with status ${xhr.status}`));
                        }
                    } catch (pe) {
                        if (xhr.status === 404) {
                            reject(new Error("Server ឆ្លើយតប 404 (សូមបើក Vocal Studio តាមរយៈ Icon លើ Desktop)"));
                        } else {
                            reject(new Error("Upload response parsing error"));
                        }
                    }
                };
                xhr.onerror = () => reject(new Error("មិនអាចភ្ជាប់ទៅកាន់ Server បានទេ សូមប្រាកដថា Vocal Studio កំពុងដំណើរការ!"));
                xhr.send(formData);
            });
            if (data && data.video_path) {
                state.videoPath = data.video_path;
                state.videoUrl = data.url;
                state.proxyPath = data.proxy_path || null;
                state.proxyUrl = data.proxy_url || null;
                state.duration = data.duration || 20;

                // Sync with playlist item if active
                if (state.playlist && state.playlist[state.playlistIndex]) {
                    state.playlist[state.playlistIndex].video_path = data.video_path;
                    state.playlist[state.playlistIndex].url = data.url;
                    state.playlist[state.playlistIndex].duration = data.duration;
                }

                // Automatically connect separated background music track
                if (data.extracted_bgm_path && data.extracted_bgm_url) {
                    setupExtractedBgm(data.extracted_bgm_url, data.extracted_bgm_path);
                }

                state.useProxy = false;
                videoPlayer.src = data.url;
                videoPlayer.load();
                updateProxyDisplay();
                videoStatus.innerText = file.name;
                timeline.setDuration(state.duration);
                setProgress(100, "Video Loaded");
                setStatus(`វីដេអូ ${file.name} ត្រូវបានបញ្ចូល និងបំបែកភ្លេងដើមដោយជោគជ័យ!`);

                // Auto Trigger Fresh Speech-to-Text & Khmer Translation
                await runAutoProcess(true);
            } else {
                alert(`កំហុស Upload វីដេអូ៖ ${data ? data.detail : "Upload failed"}`);
                setStatus("❌ បញ្ចូលវីដេអូបរាជ័យ");
                renderTable();
            }
        } catch (err) {
            console.error("Video upload error:", err);
            const msg = err.message || err || "Server unreachable";
            alert(`ដំណើរការ Upload វីដេអូបរាជ័យ៖ ${msg}\n\nសូមព្យាយាម Upload ម្ដងទៀត!`);
            setStatus(`❌ Upload វីដេអូបរាជ័យ៖ ${msg}`);
            renderTable();
        }
    }

    // Multi-Video Batch Management (Short Drama Episodes Concat)
    let batchVideoFiles = [];

    function naturalSortFiles(arr) {
        return arr.slice().sort((a, b) => 
            a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        );
    }

    function renderBatchFileList() {
        const listEl = document.getElementById("batchFileList");
        const countEl = document.getElementById("batchCountLabel");
        if (!listEl) return;
        listEl.innerHTML = "";
        if (countEl) countEl.innerText = `បានជ្រើសរើស ${batchVideoFiles.length} វីដេអូខ្លីៗ`;

        if (batchVideoFiles.length === 0) {
            listEl.innerHTML = `<div style="text-align:center; padding:30px 10px; color:#64748b;">មិនមានឯកសារវីដេអូក្នុងបញ្ជីទេ</div>`;
            return;
        }

        batchVideoFiles.forEach((file, idx) => {
            const item = document.createElement("div");
            item.style.cssText = "display:flex; align-items:center; justify-content:space-between; background:#1e293b; padding:8px 12px; border-radius:6px; font-size:12px; border:1px solid #334155; gap:8px;";

            const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
            item.innerHTML = `
                <div style="display:flex; align-items:center; gap:8px; overflow:hidden; flex:1;">
                    <span style="font-weight:700; color:#38bdf8; min-width:28px;">#${idx + 1}</span>
                    <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#f1f5f9; font-family:monospace; font-size:12px;" title="${file.name}">${file.name}</span>
                    <span style="color:#64748b; font-size:11px; margin-left:auto; padding-right:8px; flex-shrink:0;">${sizeMb} MB</span>
                </div>
                <div style="display:flex; gap:4px; flex-shrink:0;">
                    <button type="button" class="btn-mini btn-move-up" data-idx="${idx}" title="ផ្លាស់ទីឡើងលើ" style="padding:4px 8px; background:#1e293b; border:1px solid #334155; cursor:pointer; border-radius:4px; color:#cbd5e1; display:inline-flex; align-items:center; justify-content:center;" ${idx === 0 ? "disabled style='opacity:0.35; cursor:not-allowed; background:#1e293b; border:1px solid #334155; padding:4px 8px; border-radius:4px;'" : ""}><i data-lucide="arrow-up" style="width:12px; height:12px;"></i></button>
                    <button type="button" class="btn-mini btn-move-down" data-idx="${idx}" title="ផ្លាស់ទីចុះក្រោម" style="padding:4px 8px; background:#1e293b; border:1px solid #334155; cursor:pointer; border-radius:4px; color:#cbd5e1; display:inline-flex; align-items:center; justify-content:center;" ${idx === batchVideoFiles.length - 1 ? "disabled style='opacity:0.35; cursor:not-allowed; background:#1e293b; border:1px solid #334155; padding:4px 8px; border-radius:4px;'" : ""}><i data-lucide="arrow-down" style="width:12px; height:12px;"></i></button>
                    <button type="button" class="btn-mini btn-remove-batch" data-idx="${idx}" title="លុបចេញ" style="padding:4px 8px; background:rgba(239,68,68,0.18); color:#fca5a5; border:1px solid rgba(239,68,68,0.4); cursor:pointer; border-radius:4px; display:inline-flex; align-items:center; justify-content:center;"><i data-lucide="trash-2" style="width:12px; height:12px;"></i></button>
                </div>
            `;

            item.querySelector(".btn-move-up")?.addEventListener("click", () => {
                if (idx > 0) {
                    const temp = batchVideoFiles[idx];
                    batchVideoFiles[idx] = batchVideoFiles[idx - 1];
                    batchVideoFiles[idx - 1] = temp;
                    renderBatchFileList();
                }
            });

            item.querySelector(".btn-move-down")?.addEventListener("click", () => {
                if (idx < batchVideoFiles.length - 1) {
                    const temp = batchVideoFiles[idx];
                    batchVideoFiles[idx] = batchVideoFiles[idx + 1];
                    batchVideoFiles[idx + 1] = temp;
                    renderBatchFileList();
                }
            });

            item.querySelector(".btn-remove-batch")?.addEventListener("click", () => {
                batchVideoFiles.splice(idx, 1);
                renderBatchFileList();
            });

            listEl.appendChild(item);
        });
        refreshIcons();
    }

    // ─── Playlist & Sequential Auto-Play Next Episode ────────
    function syncCurrentPlaylistEpisode() {
        if (state.playlist && state.playlist[state.playlistIndex]) {
            state.playlist[state.playlistIndex].segments = state.segments;
            state.playlist[state.playlistIndex].duration = state.duration;
            state.playlist[state.playlistIndex].video_path = state.videoPath;
            if (state.videoUrl) state.playlist[state.playlistIndex].url = state.videoUrl;
        }
    }

    let isTransitioningNextEpisode = false;

    function triggerAutoPlayNextEpisode() {
        if (isTransitioningNextEpisode) return;
        if (!state.autoPlayNext || !state.playlist || state.playlist.length <= 1) return;
        const nextIdx = state.playlistIndex + 1;
        if (nextIdx < state.playlist.length) {
            isTransitioningNextEpisode = true;
            const nextItem = state.playlist[nextIdx];
            setStatus(`⏩ វីដេអូភាគ ${(state.playlistIndex + 1)} បានចប់! កំពុងចាក់ភាគបន្ត៖ ភាគ ${nextIdx + 1}/${state.playlist.length} (${nextItem.name})...`);
            setTimeout(() => {
                playPlaylistItem(nextIdx, true).finally(() => {
                    setTimeout(() => {
                        isTransitioningNextEpisode = false;
                    }, 800);
                });
            }, 600);
        } else {
            setStatus(`🎉 បានចាក់ចប់វីដេអូគ្រប់ភាគទាំងអស់ (${state.playlist.length} ភាគ) តាមលំដាប់លំដោយដោយជោគជ័យ!`);
        }
    }

    async function playPlaylistItem(idx, autoStart = true) {
        if (!state.playlist || idx < 0 || idx >= state.playlist.length) return;

        stopDubAudio(true);
        state.playlistIndex = idx;
        const item = state.playlist[idx];
        renderPlaylistBar();

        videoStatus.innerText = `[ភាគ ${idx + 1}/${state.playlist.length}] ${item.name}`;
        setStatus(`🎬 កំពុងចាក់ភាគ ${idx + 1}/${state.playlist.length}៖ ${item.name}`);

        if (!item.url && item.file) {
            item.url = URL.createObjectURL(item.file);
        }
        videoPlayer.src = item.url;
        videoPlayer.load();

        if (item.segments && item.segments.length > 0) {
            state.segments = item.segments;
            state.videoPath = item.video_path || "";
            state.duration = item.duration || videoPlayer.duration || 60;
            timeline.setDuration(state.duration);
            timeline.renderSegments(state.segments);
            renderTable();
            segmentCount.innerText = state.segments.length;
        } else if (item.file) {
            processUploadedVideoFile(item.file).then(() => {
                item.video_path = state.videoPath;
                item.segments = state.segments;
                item.duration = state.duration;
            });
        }

        if (autoStart) {
            const startPlay = () => {
                videoPlayer.play().then(() => {
                    updatePlayPauseUI(true);
                }).catch(e => {
                    console.log("Auto-play next error:", e);
                });
            };

            if (videoPlayer.readyState >= 2) {
                startPlay();
            } else {
                videoPlayer.addEventListener("canplay", function handler() {
                    videoPlayer.removeEventListener("canplay", handler);
                    startPlay();
                });
            }
        }
    }

    function renderPlaylistBar() {
        const container = document.getElementById("playlistContainer");
        const itemsEl = document.getElementById("playlistItems");
        const currentNum = document.getElementById("playlistCurrentNum");
        const totalNum = document.getElementById("playlistTotalNum");
        const currentTitle = document.getElementById("playlistCurrentTitle");
        const btnToggle = document.getElementById("btnToggleAutoPlayNext");

        if (!container || !itemsEl) return;

        if (!state.playlist || state.playlist.length <= 1) {
            container.style.display = "none";
            return;
        }

        container.style.display = "block";
        if (currentNum) currentNum.innerText = (state.playlistIndex + 1);
        if (totalNum) totalNum.innerText = state.playlist.length;
        if (currentTitle && state.playlist[state.playlistIndex]) {
            currentTitle.innerText = state.playlist[state.playlistIndex].name;
        }
        if (btnToggle) {
            if (state.autoPlayNext) {
                btnToggle.style.background = "#064e3b";
                btnToggle.style.borderColor = "#10b981";
                btnToggle.style.color = "#6ee7b7";
                btnToggle.innerHTML = '<i data-lucide="repeat"></i> <span>ចាក់ភាគបន្ទាប់: បើក (Auto-Next)</span>';
            } else {
                btnToggle.style.background = "#2a1e12";
                btnToggle.style.borderColor = "#f59e0b";
                btnToggle.style.color = "#fde68a";
                btnToggle.innerHTML = '<i data-lucide="repeat"></i> <span>ចាក់ភាគបន្ទាប់: បិទ</span>';
            }
            refreshIcons();
        }

        itemsEl.innerHTML = "";
        state.playlist.forEach((item, idx) => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = `playlist-chip ${idx === state.playlistIndex ? "active" : ""}`;
            chip.title = `ចុចដើម្បីចាក់ភាគ ${idx + 1}៖ ${item.name}`;
            chip.innerHTML = `
                <span class="chip-icon">${idx === state.playlistIndex ? "▶" : "🎬"}</span>
                <span class="chip-num">ភាគ ${idx + 1}</span>
                <span class="chip-name">${item.name}</span>
            `;
            chip.addEventListener("click", () => {
                playPlaylistItem(idx, true);
            });
            itemsEl.appendChild(chip);
        });
    }

    function handleMultipleVideoFiles(files) {
        if (!files || files.length === 0) return;
        if (files.length === 1) {
            processUploadedVideoFile(files[0]);
            return;
        }
        batchVideoFiles = naturalSortFiles(files);
        renderBatchFileList();
        openModal("batchMergeModal");
        refreshIcons();
    }

    const btnSortBatchNatural = document.getElementById("btnSortBatchNatural");
    if (btnSortBatchNatural) {
        btnSortBatchNatural.addEventListener("click", () => {
            batchVideoFiles = naturalSortFiles(batchVideoFiles);
            renderBatchFileList();
            setStatus("🔄 បានតម្រៀបវីដេអូខ្លីៗតាមលេខភាគឡើងវិញ");
        });
    }

    const btnClearBatchList = document.getElementById("btnClearBatchList");
    if (btnClearBatchList) {
        btnClearBatchList.addEventListener("click", () => {
            batchVideoFiles = [];
            renderBatchFileList();
        });
    }

    const btnToggleAutoPlayNext = document.getElementById("btnToggleAutoPlayNext");
    if (btnToggleAutoPlayNext) {
        btnToggleAutoPlayNext.addEventListener("click", () => {
            state.autoPlayNext = !state.autoPlayNext;
            renderPlaylistBar();
            if (state.autoPlayNext) {
                setStatus("🔁 មុខងារចាក់ភាគបន្ទាប់ស្វ័យប្រវត្ត (Auto-Play Next) ត្រូវបានបើក!");
            } else {
                setStatus("⏸️ មុខងារចាក់ភាគបន្ទាប់ស្វ័យប្រវត្តត្រូវបានបិទ។");
            }
        });
    }

    const btnBatchPlayQueue = document.getElementById("btnBatchPlayQueue");
    if (btnBatchPlayQueue) {
        btnBatchPlayQueue.addEventListener("click", () => {
            if (!batchVideoFiles || batchVideoFiles.length === 0) {
                alert("សូមជ្រើសរើសវីដេអូយ៉ាងហោចណាស់មួយ!");
                return;
            }

            closeModal("batchMergeModal");

            // Setup Playlist in state
            state.playlist = batchVideoFiles.map((file, idx) => ({
                id: idx,
                name: file.name,
                file: file,
                url: URL.createObjectURL(file),
                video_path: "",
                duration: 0,
                segments: []
            }));
            state.playlistIndex = 0;
            state.autoPlayNext = true;

            renderPlaylistBar();
            setStatus(`🎬 បានផ្ទុកបញ្ជីភាគចំនួន ${state.playlist.length} វីដេអូ! ចាប់ផ្តើមចាក់ភាគ ១ ភ្លាមៗ...`);

            // Start playing the first episode!
            playPlaylistItem(0, true);
        });
    }

    const btnConfirmBatchMerge = document.getElementById("btnConfirmBatchMerge");
    if (btnConfirmBatchMerge) {
        btnConfirmBatchMerge.addEventListener("click", async () => {
            if (!batchVideoFiles || batchVideoFiles.length === 0) {
                alert("សូមជ្រើសរើសវីដេអូយ៉ាងហោចណាស់មួយ!");
                return;
            }

            closeModal("batchMergeModal");

            // Clean previous state
            state.segments = [];
            clearAudioCache();
            killAllAudio();
            timeline.renderSegments([]);
            segmentCount.innerText = "0";
            subtitlePreview.innerText = "";

            renderLoadingTable(`កំពុង Upload និងបញ្ចូលគ្នាចំនួន ${batchVideoFiles.length} វីដេអូខ្លីៗ...`);
            setStatus(`កំពុងរៀបចំ Upload ចំនួន ${batchVideoFiles.length} វីដេអូ...`);
            setProgress(5, `Starting batch upload of ${batchVideoFiles.length} videos`);

            try {
                // Step 1: Initialize batch session on server
                const initRes = await fetch("/api/batch-upload/init", { method: "POST" });
                const initData = await initRes.json();
                if (!initRes.ok || !initData.batch_id) {
                    throw new Error(initData.detail || "Could not initialize batch upload session");
                }
                const batchId = initData.batch_id;
                const fileOrder = [];
                const totalClips = batchVideoFiles.length;

                // Step 2: Upload clips sequentially to avoid HTTP payload limits & memory spikes
                for (let i = 0; i < totalClips; i++) {
                    const clipFile = batchVideoFiles[i];
                    fileOrder.push(clipFile.name);

                    const clipForm = new FormData();
                    clipForm.append("batch_id", batchId);
                    clipForm.append("file", clipFile);

                    const pct = Math.round(5 + ((i + 1) / totalClips) * 65);
                    setStatus(`កំពុង Upload ភាគទី ${i + 1}/${totalClips} (${clipFile.name})...`);
                    setProgress(pct, `Uploading episode ${i + 1}/${totalClips} (${pct}%)`);

                    const clipRes = await fetch("/api/batch-upload/clip", {
                        method: "POST",
                        body: clipForm
                    });
                    if (!clipRes.ok) {
                        const errData = await clipRes.json().catch(() => ({}));
                        throw new Error(errData.detail || `Failed to upload clip ${clipFile.name}`);
                    }
                }

                // Step 3: Merge all uploaded clips losslessly
                setStatus(`⚡ កំពុងបញ្ចូលគ្នាចំនួន ${totalClips} ភាគទៅជាវីដេអូពេញលេញតែមួយ (Lossless Merge)...`);
                setProgress(75, `Merging ${totalClips} episodes...`);

                const mergeRes = await fetch("/api/batch-upload/merge", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ batch_id: batchId, file_order: fileOrder })
                });
                const data = await mergeRes.json();
                if (mergeRes.ok && data.video_path) {
                    state.videoPath = data.video_path;
                    state.videoUrl = data.url;
                    state.proxyPath = data.proxy_path || null;
                    state.proxyUrl = data.proxy_url || null;
                    state.duration = data.duration || 60;
                    if (data.proxy_url) {
                        state.useProxy = true;
                        videoPlayer.src = data.proxy_url;
                    } else {
                        state.useProxy = false;
                        videoPlayer.src = data.url;
                    }
                    videoPlayer.load();
                    updateProxyDisplay();
                    videoStatus.innerText = data.filename || `Merged (${batchVideoFiles.length} episodes)`;
                    timeline.setDuration(state.duration);
                    fitVideoToOriginal();

                    if (data.extracted_bgm_path && data.extracted_bgm_url) {
                        setupExtractedBgm(data.extracted_bgm_url, data.extracted_bgm_path);
                    }

                    setProgress(35, "Videos merged successfully! Starting Auto-Process...");
                    setStatus(`🎉 បានបញ្ចូលគ្នាសម្រេច ${batchVideoFiles.length} វីដេអូ (រយៈពេលសរុប៖ ${Math.round(state.duration/60)} នាទី)! កំពុងចាប់ផ្តើមស្គ្រីប...`);

                    // Automatically launch Speech-to-Text & Khmer translation on the merged continuous video
                    await runAutoProcess(true);
                } else {
                    alert(`កំហុសបញ្ចូលវីដេអូ៖ ${data.detail || "Merge failed"}`);
                    setStatus("❌ បញ្ចូលវីដេអូបរាជ័យ");
                    renderTable();
                }
            } catch (err) {
                console.error("Batch merge error:", err);
                const errMsg = err.message || err || "Connection error";
                alert(`ដំណើរការបញ្ចូលវីដេអូបរាជ័យ៖ ${errMsg}\n\nសូមព្យាយាមជ្រើសរើស និងចុចបញ្ចូលវីដេអូម្តងទៀត!`);
                setStatus(`❌ បញ្ចូលវីដេអូបរាជ័យ៖ ${errMsg}`);
                renderTable();
            }
        });
    }

    // Add Video File via button
    const btnAddVideo = document.getElementById("btnAddVideo");
    const videoFileInput = document.getElementById("videoFileInput");

    if (btnAddVideo && videoFileInput) {
        btnAddVideo.addEventListener("click", () => {
            videoFileInput.click();
        });

        videoFileInput.addEventListener("change", async () => {
            if (!videoFileInput.files || videoFileInput.files.length === 0) return;
            const files = Array.from(videoFileInput.files).filter(f => f.type.startsWith("video/") || /\.(mp4|mkv|mov|avi|webm|flv|ts)$/i.test(f.name));
            handleMultipleVideoFiles(files);
            videoFileInput.value = "";
        });
    }

    // Drag & Drop video files directly onto browser / video player
    window.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.stopPropagation();
    });
    window.addEventListener("drop", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("video/") || /\.(mp4|mkv|mov|avi|webm|flv|ts)$/i.test(f.name));
            if (files.length > 0) {
                handleMultipleVideoFiles(files);
            }
        }
    });

    // Function to make all segments strictly continuous with zero gaps
    async function makeSegmentsContinuous(silent = false) {
        if (!state.segments || state.segments.length === 0) {
            if (!silent) alert("មិនមានស្គ្រីបអត្ថបទសម្រាប់តភ្ជាប់គ្នាទេ!");
            return;
        }

        if (!silent) {
            setStatus("កំពុងគណនាប្រវែងសម្លេងនិយាយ (TTS) ដើម្បីតម្រៀបឃ្លានីមួយៗឱ្យត្រូវនឹងប្រយោគ...");
        }

        // 1. Sort segments by start time
        state.segments.sort((a, b) => (parseFloat(a.start) || 0) - (parseFloat(b.start) || 0));

        const totalVideoDuration = Math.max(state.duration || 0, videoPlayer.duration || 0);

        // 2. Fetch and calculate real speech durations for each Khmer sentence
        // Keep each segment starting at its video timestamp, but ensure seg.end >= seg.start + audioDuration
        // and if it overlaps with the next segment's start, adjust subsequent start time naturally
        let currentTimelineCursor = 0.0;

        for (let i = 0; i < state.segments.length; i++) {
            const seg = state.segments[i];
            seg.id = i + 1;

            const origStart = parseFloat(seg.start) || 0;
            // Keep segment start locked close to original video dialogue cue (never drift more than 0.35s):
            if (currentTimelineCursor > origStart) {
                seg.start = Math.round(Math.min(origStart + 0.35, currentTimelineCursor) * 100) / 100;
            } else {
                seg.start = origStart;
            }

            // Get audio or estimate duration based on Khmer text length
            const textLen = (seg.translated || "").length;
            // Khmer speech rate with +35% speed: ~12-14 characters per second
            const estimatedDuration = Math.max(1.4, Math.round((textLen / 12.5) * 100) / 100);

            let audioDur = estimatedDuration;
            // Use cached audio duration if already available, otherwise instant estimate without freezing UI
            if (audioCache[seg.id] && audioCache[seg.id].duration && !isNaN(audioCache[seg.id].duration) && audioCache[seg.id].duration > 0) {
                audioDur = Math.max(audioCache[seg.id].duration + 0.15, estimatedDuration);
            }

            const minNeededEnd = Math.round((seg.start + audioDur) * 100) / 100;
            const origEnd = parseFloat(seg.end) || 0;
            // End time must be at least long enough for the entire speech to finish
            seg.end = Math.max(origEnd, minNeededEnd);
            currentTimelineCursor = seg.end;
        }

        // Keep last segment natural: only extend slightly if within 1.5s of video end, never stretch over tens of seconds
        if (state.segments.length > 0 && totalVideoDuration > currentTimelineCursor) {
            const lastSeg = state.segments[state.segments.length - 1];
            if (totalVideoDuration - currentTimelineCursor <= 1.5) {
                lastSeg.end = Math.round(totalVideoDuration * 100) / 100;
            }
        }

        clearAudioCache();
        stopDubAudio();
        renderTable();
        timeline.renderSegments(state.segments);
        if (!silent) {
            setStatus("✨ បានគណនា និងតម្រៀបឃ្លាទាំងអស់ឱ្យនិយាយចប់គ្រប់ប្រយោគ ដោយគ្មានការកាត់ផ្តាច់រួចរាល់!");
        }
    }

    // Button event to manually trigger continuous segments
    const btnMakeContinuous = document.getElementById("btnMakeContinuous");
    if (btnMakeContinuous) {
        btnMakeContinuous.addEventListener("click", () => makeSegmentsContinuous(false));
    }

    // Deduplicate consecutive identical segments
    function deduplicateSegments(silent = false) {
        if (!state.segments || state.segments.length === 0) return;

        const cleaned = [];
        for (let i = 0; i < state.segments.length; i++) {
            const seg = state.segments[i];
            const orig = (seg.original || "").trim();
            const trans = (seg.translated || "").trim();

            if (cleaned.length === 0) {
                cleaned.push(seg);
                continue;
            }

            const prev = cleaned[cleaned.length - 1];
            const prevOrig = (prev.original || "").trim();
            const prevTrans = (prev.translated || "").trim();

            // Check if identical or repetition loop
            const isDuplicate = (orig && orig === prevOrig) || (trans && trans === prevTrans);

            if (isDuplicate) {
                // Merge time to previous segment instead of creating duplicate line
                prev.end = Math.max(parseFloat(prev.end) || 0, parseFloat(seg.end) || 0);
            } else {
                cleaned.push(seg);
            }
        }

        const removedCount = state.segments.length - cleaned.length;
        cleaned.forEach((s, idx) => s.id = idx + 1);
        state.segments = cleaned;

        renderTable();
        timeline.renderSegments(state.segments);

        if (!silent) {
            setStatus(`✨ បានសម្អាត និងលុបពាក្យជាន់គ្នាដដែលៗចំនួន ${removedCount} ជួររួចរាល់!`);
        }
    }

    const btnCleanDuplicates = document.getElementById("btnCleanDuplicates");
    if (btnCleanDuplicates) {
        btnCleanDuplicates.addEventListener("click", () => deduplicateSegments(false));
    }

    // Unified Auto Process: Transcribe & Translate to Khmer (Supports 1-3+ hour long videos seamlessly)
    async function runAutoProcess(force = false) {
        if (!state.videoPath) {
            alert("សូមជ្រើសរើសវីដេអូជាមុនសិន!");
            return;
        }

        const model = document.getElementById("modelSelect").value;
        state.isLoading = true;
        // Clean old segments on start of new processing
        state.segments = [];
        timeline.renderSegments([]);
        segmentCount.innerText = "0";
        subtitlePreview.innerText = "";
        clearAudioCache();
        stopDubAudio();

        renderLoadingTable("កំពុងចាប់ផ្តើមដំណើរការស្គ្រីបពីវីដេអូ...");
        setStatus("កំពុងរៀបចំដំណើរការស្គ្រីប និងសម្រាយរឿង...");
        setProgress(5, "Starting processing...");

        try {
            // 1. Start background job (avoids browser HTTP fetch timeout on 1-3 hour videos)
            const startRes = await fetch("/api/start-auto-process", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    video_path: state.videoPath,
                    model_name: model,
                    language: "zh",
                    recap_style: state.recapStyle,
                    force: force
                })
            });

            const startData = await startRes.json();
            if (!startRes.ok) {
                throw new Error(startData.detail || "មិនអាចចាប់ផ្តើមដំណើរការបានទេ");
            }

            // If already completed from cache
            if (startData.status === "completed" && startData.segments) {
                clearAudioCache();
                stopDubAudio();
                state.segments = startData.segments;
                deduplicateSegments(true);
                renderTable();
                timeline.renderSegments(state.segments);
                setProgress(100, "Done!");
                setStatus(`🎉 ទទួលបាន ${state.segments.length} ឃ្លាស្គ្រីបត្រូវតាមពេលវេលាសំឡេងនិយាយនៃវីដេអូរួចរាល់!`);
                triggerBackendPreload(state.segments);
                syncCurrentPlaylistEpisode();
                if (state.videoPath) {
                    setupExtractedBgm(null, state.bgmPath, true);
                }
                return;
            }

            const jobId = startData.job_id;
            if (!jobId) {
                throw new Error("Invalid job ID from server");
            }

            // 2. Poll job status every 1.5 seconds with live percentage & progress messages
            await new Promise((resolve, reject) => {
                const pollInterval = setInterval(async () => {
                    try {
                        const statusRes = await fetch(`/api/job-status/${jobId}`);
                        if (!statusRes.ok) {
                            clearInterval(pollInterval);
                            reject(new Error("បាត់បង់ការភ្ជាប់ជាមួយ Server"));
                            return;
                        }
                        const jobData = await statusRes.json();

                        const progress = jobData.progress || 10;
                        const message = jobData.message || "កំពុងដំណើរការ...";

                        setProgress(progress, message);
                        setStatus(message);
                        renderLoadingTable(message);

                        if (jobData.status === "completed") {
                            clearInterval(pollInterval);
                            clearAudioCache();
                            stopDubAudio();
                            state.segments = jobData.segments || [];
                            deduplicateSegments(true);
                            renderTable();
                            timeline.renderSegments(state.segments);
                            setProgress(100, "Done!");
                            setStatus(`🎉 ទទួលបាន ${state.segments.length} ឃ្លាស្គ្រីបសម្រាប់វីដេអូរយៈពេលវែងដោយជោគជ័យ!`);
                            triggerBackendPreload(state.segments);
                            syncCurrentPlaylistEpisode();
                            if (state.videoPath) {
                                setupExtractedBgm(null, state.bgmPath, true);
                            }
                            resolve();
                        } else if (jobData.status === "error") {
                            clearInterval(pollInterval);
                            reject(new Error(jobData.error || jobData.message || "ដំណើរការបរាជ័យ"));
                        }
                    } catch (pollErr) {
                        console.error("Polling error:", pollErr);
                    }
                }, 1500);
            });

        } catch (err) {
            console.error("Auto process error:", err);
            alert("❌ " + (err.message || "ដំណើរការបរាជ័យ សូមពិនិត្យ Server"));
            setStatus("❌ " + (err.message || "ដំណើរការបរាជ័យ"));
            renderTable();
        } finally {
            state.isLoading = false;
        }
    }

    document.getElementById("btnAutoProcess").addEventListener("click", runAutoProcess);

    // Translate (Chunked batch translation for massive series / multi-episode videos)
    document.getElementById("btnTranslate").addEventListener("click", async () => {
        if (!state.segments || state.segments.length === 0) {
            alert("មិនមានអត្ថបទចិនសម្រាប់បកប្រែទេ! សូមចុច 'ចាប់យកស្គ្រីប & សម្រាយជាខ្មែរ' ជាមុនសិន។");
            return;
        }

        const total = state.segments.length;
        const chunkSize = 200; // High-throughput batch size: 200 segments per chunk (500 segments in just 2-3 requests!)
        setStatus(`កំពុងចាប់ផ្តើមបកប្រែសម្រាយជាភាសាខ្មែរ (សរុប ${total} ឃ្លា)...`);
        setProgress(60, `Translating (0 / ${total})`);

        clearAudioCache();
        stopDubAudio();

        let completed = 0;
        let hasError = false;

        for (let i = 0; i < total; i += chunkSize) {
            const chunkSlice = state.segments.slice(i, i + chunkSize);
            let chunkSuccess = false;
            let attempts = 0;

            while (!chunkSuccess && attempts < 3) {
                attempts++;
                try {
                    const res = await fetch("/api/translate", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            segments: chunkSlice,
                            recap_style: state.recapStyle
                        })
                    });

                    if (res.ok) {
                        const data = await res.json();
                        if (data.segments && data.segments.length) {
                            // Merge translated chunk back into state.segments
                            data.segments.forEach((transSeg, idx) => {
                                const targetIdx = i + idx;
                                if (state.segments[targetIdx]) {
                                    state.segments[targetIdx].translated = transSeg.translated;
                                    if (transSeg.actor) state.segments[targetIdx].actor = transSeg.actor;
                                    if (transSeg.voice) state.segments[targetIdx].voice = transSeg.voice;
                                }
                            });
                            chunkSuccess = true;
                        }
                    }
                } catch (chunkErr) {
                    console.warn(`Chunk ${i} attempt ${attempts} error:`, chunkErr);
                    // Delay before retry
                    await new Promise(r => setTimeout(r, 1200));
                }
            }

            if (!chunkSuccess) {
                hasError = true;
                console.error(`Chunk starting at index ${i} failed after 3 attempts.`);
            }

            completed = Math.min(total, i + chunkSize);
            const pct = 60 + Math.round((completed / total) * 38);
            setProgress(pct, `Translating (${completed} / ${total})`);
            setStatus(`✨ កំពុងសម្រាយជាភាសាខ្មែរ៖ ${completed} / ${total} ឃ្លា (${Math.round((completed / total) * 100)}%)...`);
            renderTable();

            // Pacing delay between chunks to respect Gemini API rate limits on massive videos
            if (i + chunkSize < total) {
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        renderTable();
        setProgress(100, "Translation Complete");

        if (hasError) {
            setStatus(`⚠️ ការបកប្រែបានបញ្ចប់ ដោយមានឃ្លាមួយចំនួនរក្សាទុកទម្រង់ដើម (សរុប ${total} ឃ្លា)`);
            alert("⚠️ ការបកប្រែបានសម្រេចស្ទើរតែទាំងអស់! ប្រសិនបើមានឃ្លាមិនទាន់បកប្រែ លោកអ្នកអាចចុចបកប្រែម្តងទៀត ឬកែសម្រួលផ្ទាល់បាន។");
        } else {
            setStatus(`🎉 សម្រាយជាភាសាខ្មែរចប់សព្វគ្រប់ទាំង ${total} ឃ្លា ដោយជោគជ័យ ១០០%!`);
        }
    });

    // Add Row
    document.getElementById("btnAddRow").addEventListener("click", () => {
        const lastSeg = state.segments[state.segments.length - 1];
        const newStart = lastSeg ? parseFloat(lastSeg.end) + 0.5 : 0;
        const newEnd = newStart + 3.0;

        state.segments.push({
            id: state.segments.length + 1,
            start: newStart,
            end: newEnd,
            original: "（请输入台词）",
            translated: "（បញ្ចូលអត្ថបទសម្រាយខ្មែរ...）",
            voice: "km-KH-PisethNeural",
            actor: "Actor 1"
        });
        renderTable();
    });

    // ==========================================
    // Export Folder Directory Management
    // ==========================================
    let defaultExportFolders = {
        outputs: "",
        desktop: "",
        downloads: "",
        videos: ""
    };

    const exportOutputDirInput = document.getElementById("exportOutputDirInput");
    const lblShortFolder = document.getElementById("lblShortFolder");
    const btnBrowseOutputDir = document.getElementById("btnBrowseOutputDir");
    const btnExploreOutputDir = document.getElementById("btnExploreOutputDir");
    const btnFooterChooseFolder = document.getElementById("btnFooterChooseFolder");

    function getShortFolderName(fullPath) {
        if (!fullPath) return "outputs";
        const clean = fullPath.trim().replace(/[\\/]+$/, "");
        if ((clean.length === 2 || clean.length === 3) && clean[1] === ':') {
            return `Drive ${clean[0].toUpperCase()}:`;
        }
        const parts = clean.split(/[\\/]/);
        return parts[parts.length - 1] || clean || "outputs";
    }

    function updateExportFolderDisplay(folderPath) {
        if (!folderPath) return;
        let cleanPath = folderPath.trim();
        if (cleanPath.length === 2 && cleanPath[1] === ':') {
            cleanPath = cleanPath + '\\';
        }
        if (exportOutputDirInput) exportOutputDirInput.value = cleanPath;
        if (lblShortFolder) lblShortFolder.textContent = getShortFolderName(cleanPath);
        localStorage.setItem("vocal_export_dir", cleanPath);

        const statusText = document.getElementById("exportFolderStatusText");
        if (statusText) {
            statusText.textContent = `បានកំណត់ទីតាំងរួចរាល់៖ ${getShortFolderName(cleanPath)} (${cleanPath})`;
        }

        // Update active preset styling for both standard folders and Drive buttons
        document.querySelectorAll(".dest-preset-btn").forEach(btn => {
            const preset = btn.getAttribute("data-preset");
            const dataPath = btn.getAttribute("data-path");
            const btnTarget = dataPath || (preset && defaultExportFolders[preset]);
            if (btnTarget && (
                btnTarget.toLowerCase() === cleanPath.toLowerCase() ||
                btnTarget.replace(/[\\/]+$/, '').toLowerCase() === cleanPath.replace(/[\\/]+$/, '').toLowerCase()
            )) {
                btn.classList.add("active-preset");
                btn.style.borderColor = "#10b981";
                btn.style.boxShadow = "0 0 8px rgba(16, 185, 129, 0.4)";
                btn.style.color = "#34d399";
            } else {
                btn.classList.remove("active-preset");
                btn.style.borderColor = "";
                btn.style.boxShadow = "";
                btn.style.color = "";
            }
        });
    }

    async function loadDefaultExportFolders() {
        try {
            const res = await fetch("/api/default-folders");
            if (res.ok) {
                const data = await res.json();
                defaultExportFolders = data;

                // Render dynamic drive pills (Drive C:, Drive D:, etc.)
                const driveContainer = document.getElementById("driveShortcutButtons");
                if (driveContainer && Array.isArray(data.drives) && data.drives.length > 0) {
                    driveContainer.innerHTML = "";
                    data.drives.forEach(drv => {
                        const btn = document.createElement("button");
                        btn.type = "button";
                        btn.className = "dest-preset-btn dest-drive-btn";
                        btn.setAttribute("data-path", drv.path);
                        btn.style.cssText = "background: linear-gradient(135deg, rgba(14, 165, 233, 0.15), rgba(2, 132, 199, 0.25)); border: 1px solid rgba(56, 189, 248, 0.4); color: #38bdf8; font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 4px; transition: all 0.2s;";
                        btn.innerHTML = `💽 ${drv.label || `Drive ${drv.letter}:`}`;
                        btn.title = `ជ្រើសរើសរក្សាទុកក្នុង ${drv.path} (ទំហំទំនេរ ${drv.free_gb || 0} GB)`;
                        btn.addEventListener("click", () => {
                            updateExportFolderDisplay(drv.path);
                        });
                        driveContainer.appendChild(btn);
                    });
                }
            }
        } catch (e) {
            console.warn("Could not load default folders:", e);
        }

        const saved = localStorage.getItem("vocal_export_dir");
        if (saved) {
            updateExportFolderDisplay(saved);
        } else if (defaultExportFolders.outputs) {
            updateExportFolderDisplay(defaultExportFolders.outputs);
        }
    }

    async function triggerBrowseExportFolder() {
        const cur = (exportOutputDirInput ? exportOutputDirInput.value.trim() : "") || defaultExportFolders.outputs || "";
        const folderCard = document.querySelector(".export-destination-card");
        if (folderCard) folderCard.classList.add("highlight-pulse");

        try {
            setStatus("📂 កំពុងបើកផ្ទាំងជ្រើសរើស Folder លើ Windows...");
            const res = await fetch("/api/browse-folder", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ initial_dir: cur })
            });
            const cType = res.headers.get("content-type") || "";
            if (!res.ok || !cType.includes("application/json")) {
                const errText = await res.text();
                throw new Error(`Server response error (${res.status}): ${errText.slice(0, 60)}`);
            }
            const data = await res.json();
            if (data.status === "ok" && data.folder) {
                updateExportFolderDisplay(data.folder);
                setStatus(`✅ បានជ្រើសរើស Folder៖ ${data.folder}`);
            } else {
                setStatus("Ready");
            }
        } catch (err) {
            console.warn("Native browse folder dialog fallback:", err);
            const manualPath = prompt("សូមវាយ ឬ Paste ទីតាំង Folder ដែលចង់រក្សាទុក (ឬចុចប៊ូតុងផ្លូវកាត់ Desktop, Downloads, Videos)៖", cur);
            if (manualPath && manualPath.trim()) {
                updateExportFolderDisplay(manualPath.trim());
                setStatus(`✅ បានកំណត់ Folder៖ ${manualPath.trim()}`);
            } else {
                setStatus("Ready");
            }
        } finally {
            setTimeout(() => {
                if (folderCard) folderCard.classList.remove("highlight-pulse");
            }, 1500);
        }
    }

    async function openCurrentExportFolder() {
        const cur = (exportOutputDirInput ? exportOutputDirInput.value.trim() : "") || defaultExportFolders.outputs || "";
        try {
            await fetch("/api/open-folder", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: cur })
            });
        } catch (err) {
            console.error("Open folder error:", err);
        }
    }

    if (btnBrowseOutputDir) {
        btnBrowseOutputDir.addEventListener("click", triggerBrowseExportFolder);
    }
    if (btnFooterChooseFolder) {
        btnFooterChooseFolder.addEventListener("click", triggerBrowseExportFolder);
    }
    if (btnExploreOutputDir) {
        btnExploreOutputDir.addEventListener("click", openCurrentExportFolder);
    }

    // Preset shortcut clicks
    document.querySelectorAll(".dest-preset-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const preset = btn.getAttribute("data-preset");
            if (preset && defaultExportFolders[preset]) {
                updateExportFolderDisplay(defaultExportFolders[preset]);
            }
        });
    });

    if (exportOutputDirInput) {
        const handleManualFolderInput = () => {
            const val = exportOutputDirInput.value.trim();
            if (val) {
                updateExportFolderDisplay(val);
            }
        };
        exportOutputDirInput.addEventListener("input", handleManualFolderInput);
        exportOutputDirInput.addEventListener("change", handleManualFolderInput);
    }

    // Initialize folder presets on startup
    loadDefaultExportFolders();

    // Export Video Modal Trigger
    const btnExport = document.getElementById("btnExport");
    const exportModal = document.getElementById("exportModal");
    const btnConfirmExport = document.getElementById("btnConfirmExport");

    // Sync modal checkboxes with current states
    if (btnExport) {
        btnExport.addEventListener("click", () => {
            if (!state.videoPath) {
                alert("សូមជ្រើសរើសវីដេអូជាមុនសិន!");
                return;
            }
            if (!state.segments || state.segments.length === 0) {
                alert("មិនមានអត្ថបទសម្រាយរឿងសម្រាប់បញ្ចូលសម្លេងទេ!");
                return;
            }

            // Sync output directory from storage or defaults
            const savedFolder = localStorage.getItem("vocal_export_dir");
            if (savedFolder) {
                updateExportFolderDisplay(savedFolder);
            } else if (defaultExportFolders.outputs) {
                updateExportFolderDisplay(defaultExportFolders.outputs);
            }

            const modalChkKeepOrig = document.getElementById("modalChkKeepOrig");
            const modalChkBgm = document.getElementById("modalChkBgm");
            const modalChkBurnSub = document.getElementById("modalChkBurnSub");
            const modalChkWatermark = document.getElementById("modalChkWatermark");

            if (modalChkKeepOrig) {
                modalChkKeepOrig.checked = !state.muteOrigAudio;
            }
            if (modalChkBgm) {
                modalChkBgm.checked = Boolean(isBgmEnabled && state.bgmPath);
            }
            if (modalChkBurnSub) {
                modalChkBurnSub.checked = state.burnSubtitles;
            }
            if (modalChkWatermark) {
                modalChkWatermark.checked = state.showWatermark;
            }
            const modalChkMaskChinese = document.getElementById("modalChkMaskChinese");
            if (modalChkMaskChinese) {
                modalChkMaskChinese.checked = (state.maskChineseMode !== "off");
            }
            const modalChkSmartCrop = document.getElementById("modalChkSmartCrop");
            if (modalChkSmartCrop) {
                modalChkSmartCrop.checked = state.smartCropChinese;
            }
            const modalChkThumbCover = document.getElementById("modalChkThumbnailCover");
            if (modalChkThumbCover) {
                modalChkThumbCover.checked = Boolean(state.thumbnail && state.thumbnail.enabled && state.thumbnail.insertAsCover && state.thumbnail.imagePath);
            }

            openModal("exportModal");
            if (window.lucide && typeof window.lucide.createIcons === "function") {
                window.lucide.createIcons();
            }
        });
    }

    // Toggle active state for Export Cards
    document.querySelectorAll(".export-card").forEach(card => {
        card.addEventListener("click", () => {
            document.querySelectorAll(".export-card").forEach(c => c.classList.remove("active"));
            card.classList.add("active");
            const radio = card.querySelector('input[type="radio"]');
            if (radio) radio.checked = true;
        });
    });

    // Confirm & Start Video Render
    if (btnConfirmExport) {
        btnConfirmExport.addEventListener("click", async () => {
            closeModal("exportModal");

            const modalChkKeepOrig = document.getElementById("modalChkKeepOrig");
            const modalChkBgm = document.getElementById("modalChkBgm");
            const modalChkBurnSub = document.getElementById("modalChkBurnSub");
            const modalChkWatermark = document.getElementById("modalChkWatermark");
            const modalChkMaskChinese = document.getElementById("modalChkMaskChinese");
            const modalChkSmartCrop = document.getElementById("modalChkSmartCrop");
            const selectedRes = document.querySelector('input[name="exportResolution"]:checked')?.value || "1080p";
            const selectedRatio = document.getElementById("exportAspectRatio")?.value || "original";

            // Original audio volume: Strictly 0.0 if state.muteOrigAudio is true OR modalChkKeepOrig is unchecked!
            const keepOrig = modalChkKeepOrig ? modalChkKeepOrig.checked : !state.muteOrigAudio;
            const finalOrigVolume = (!keepOrig || state.muteOrigAudio) ? 0.0 : ((state.origVolume && state.origVolume > 0.001) ? state.origVolume : 0.15);

            // BGM calculation: Strictly null and 0.0 if isBgmEnabled is false OR modalChkBgm is unchecked!
            const keepBgm = modalChkBgm ? modalChkBgm.checked : isBgmEnabled;
            const isBgmActive = Boolean(keepBgm && isBgmEnabled && state.bgmPath);
            const finalBgmPath = isBgmActive ? state.bgmPath : null;
            const finalBgmVolume = isBgmActive ? (state.bgmVolume ? Number(state.bgmVolume) : 0.25) : 0.0;

            const burnSubs = modalChkBurnSub ? modalChkBurnSub.checked : state.showSubtitles;
            const useWatermark = modalChkWatermark ? modalChkWatermark.checked : state.showWatermark;
            const maskChinese = modalChkMaskChinese ? modalChkMaskChinese.checked : (state.maskChineseMode !== "off");
            const useSmartCrop = modalChkSmartCrop ? modalChkSmartCrop.checked : state.smartCropChinese;
            const modalChkThumbCover = document.getElementById("modalChkThumbnailCover");
            const useThumbCover = modalChkThumbCover ? modalChkThumbCover.checked : (state.thumbnail && state.thumbnail.insertAsCover);
            const finalThumbPath = (useThumbCover && state.thumbnail && state.thumbnail.imagePath) ? state.thumbnail.imagePath : null;
            const finalThumbDuration = state.thumbnail ? (state.thumbnail.coverDuration || 0.8) : 0.8;

            const chosenOutputDir = exportOutputDirInput ? exportOutputDirInput.value.trim() : "";

            setStatus(`🎬 កំពុងចាប់ផ្តើម Export វីដេអូកម្រិត ${selectedRes.toUpperCase()} (${selectedRatio})...`);
            setProgress(8, `Preparing ${selectedRes.toUpperCase()} Export...`);

            try {
                const startRes = await fetch("/api/start-export", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        video_path: state.videoPath,
                        segments: state.segments,
                        orig_volume: finalOrigVolume,
                        bgm_path: finalBgmPath,
                        bgm_volume: finalBgmVolume,
                        is_bgm_enabled: isBgmActive,
                        burn_subtitles: burnSubs,
                        watermark_text: useWatermark ? (state.watermarkText || "សម្រាយរឿងHD") : null,
                        watermark_fontsize: state.watermarkFontSize || 56,
                        watermark_x: state.watermarkX,
                        watermark_y: state.watermarkY,
                        watermark_logo_path: state.logoPath,
                        logo_position: state.logoPosition,
                        logo_scale: state.logoScale,
                        logos: state.logos.map(l => ({
                            path: l.path,
                            scale: l.scale,
                            x: l.x,
                            y: l.y
                        })),
                        resolution: selectedRes,
                        aspect_ratio: selectedRatio,
                        rate: state.speechRate || "+35%",
                        pitch: state.pisethPitch || "+0Hz",
                        voice_settings: getVoiceSettingsPayload(),
                        mask_chinese: maskChinese,
                        mask_mode: state.maskChineseMode === "off" ? "blur" : state.maskChineseMode,
                        mask_bottom_pct: state.maskBottomPercent,
                        mask_height_pct: state.maskHeightPercent,
                        smart_crop_chinese: useSmartCrop,
                        crop_bottom_pct: state.cropBottomPercent || 12.0,
                        thumbnail_path: finalThumbPath,
                        thumbnail_cover: Boolean(useThumbCover && finalThumbPath),
                        thumbnail_duration: finalThumbDuration,
                        output_dir: chosenOutputDir
                    })
                });

                const startData = await startRes.json();
                if (!startRes.ok || !startData.job_id) {
                    throw new Error(startData.detail || "Could not start export job");
                }

                const jobId = startData.job_id;

                // Poll export status safely without stacking network requests
                await new Promise((resolve, reject) => {
                    let isPolling = false;
                    const pollInterval = setInterval(async () => {
                        if (isPolling) return; // Prevent concurrent requests from flooding server threads
                        isPolling = true;
                        try {
                            const pollRes = await fetch(`/api/export-status/${jobId}`);
                            if (!pollRes.ok) return;
                            const jobData = await pollRes.json();

                            if (jobData.progress !== undefined) {
                                setProgress(jobData.progress, jobData.message || 'Exporting Video');
                            }
                            if (jobData.message) {
                                setStatus(jobData.message);
                            }

                            if (jobData.status === "completed") {
                                clearInterval(pollInterval);
                                setProgress(100, "Export Succeeded!");

                                const finalSavedPath = jobData.saved_path || (chosenOutputDir ? (chosenOutputDir + '\\' + jobData.filename) : (`outputs\\${jobData.filename}`));
                                setStatus(`🎉 វីដេអូបាន Render រួចរាល់! ទីតាំង៖ ${finalSavedPath}`);

                                // Automatic download
                                const downloadLink = document.createElement("a");
                                downloadLink.href = jobData.url;
                                downloadLink.download = jobData.filename;
                                document.body.appendChild(downloadLink);
                                downloadLink.click();
                                document.body.removeChild(downloadLink);

                                setTimeout(() => {
                                    const confirmMsg = `🎉 វីដេអូ Dubbed ជាភាសាខ្មែរ (${selectedRes.toUpperCase()}) បាន Render និងទាញយករួចរាល់ ១០០%!\n\n📁 ទីតាំងរក្សាទុកក្នុងកុំព្យូទ័រ៖\n${finalSavedPath}\n\nតើអ្នកចង់បើក Folder ដែលផ្ទុកវីដេអូនេះផ្ទាល់លើ Windows Explorer ដែរឬទេ?`;
                                    if (confirm(confirmMsg)) {
                                        fetch("/api/open-folder", {
                                            method: "POST",
                                            headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify({ path: finalSavedPath })
                                        });
                                    }
                                }, 350);

                                resolve();
                            } else if (jobData.status === "error") {
                                clearInterval(pollInterval);
                                reject(new Error(jobData.error || "Rendering failed on server"));
                            }
                        } catch (pollErr) {
                            console.error("Export poll error:", pollErr);
                        } finally {
                            isPolling = false;
                        }
                    }, 2000);
                });
            } catch (err) {
                console.error("Export error:", err);
                alert(`Export rendering failed: ${err.message || err}`);
                setProgress(0, "Error");
                setStatus("❌ Export វីដេអូបរាជ័យ");
            }
        });
    }

    // Memory & LocalStorage Cache for Copy/Paste (No Browser Permission Required)
    let memoryTableClipboard = null;
    const STORAGE_CLIPBOARD_KEY = "vocal_studio_table_clipboard";

    // 1. Copy All Table Data (Saves to Memory, LocalStorage, AND system clipboard if permitted)
    const btnCopyTable = document.getElementById("btnCopyTable");
    if (btnCopyTable) {
        btnCopyTable.addEventListener("click", async () => {
            if (!state.segments || state.segments.length === 0) {
                alert("មិនទាន់មានទិន្នន័យក្នុងតារាងសម្រាប់ Copy ទេ!");
                return;
            }

            // Map clean array of segment objects
            const exportData = state.segments.map(s => ({
                start: typeof s.start === "number" ? formatTime(s.start) : s.start,
                end: typeof s.end === "number" ? formatTime(s.end) : s.end,
                start_sec: typeof s.start === "number" ? s.start : parseTimeToSeconds(s.start),
                end_sec: typeof s.end === "number" ? s.end : parseTimeToSeconds(s.end),
                original: s.original || "",
                translated: s.translated || "",
                voice: s.voice || state.actor1Voice,
                actor: s.actor || "Actor 1"
            }));

            // Store in Memory & LocalStorage (100% works without asking permission)
            memoryTableClipboard = JSON.parse(JSON.stringify(exportData));
            try {
                localStorage.setItem(STORAGE_CLIPBOARD_KEY, JSON.stringify(exportData));
            } catch (_) {}

            // Try copying to system clipboard silently
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(JSON.stringify(exportData, null, 2));
                }
            } catch (_) {}

            setStatus(`📋 បានចម្លងទិន្នន័យតារាងទាំង ${exportData.length} ជួរដោយជោគជ័យ!`);
            alert(`📋 បានចម្លងទិន្នន័យតារាងទាំងអស់ (${exportData.length} ជួរ) រួចរាល់! អ្នកអាចចុច Paste បានគ្រប់ពេល។`);
        });
    }

    // Helper to convert time string (0:04.44 or 00:04.44 or 1:02:04.44) to numeric seconds
    function parseTimeToSeconds(timeStr) {
        if (typeof timeStr === "number") return timeStr;
        if (!timeStr) return 0;
        const parts = String(timeStr).trim().split(":");
        if (parts.length === 2) {
            return (parseFloat(parts[0]) || 0) * 60 + (parseFloat(parts[1]) || 0);
        } else if (parts.length === 3) {
            return (parseFloat(parts[0]) || 0) * 3600 + (parseFloat(parts[1]) || 0) * 60 + (parseFloat(parts[2]) || 0);
        }
        return parseFloat(timeStr) || 0;
    }

    // Robust JSON object extractor that handles incomplete brackets, trailing commas, or markdown
    function extractObjectsFromText(text) {
        let results = [];
        let depth = 0;
        let startIdx = -1;
        let inString = false;
        let escape = false;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (inString) {
                if (escape) {
                    escape = false;
                } else if (char === "\\") {
                    escape = true;
                } else if (char === '"') {
                    inString = false;
                }
                continue;
            }

            if (char === '"') {
                inString = true;
            } else if (char === "{") {
                if (depth === 0) startIdx = i;
                depth++;
            } else if (char === "}") {
                depth--;
                if (depth === 0 && startIdx !== -1) {
                    const objStr = text.slice(startIdx, i + 1);
                    try {
                        const parsed = JSON.parse(objStr);
                        if (parsed && typeof parsed === "object") {
                            results.push(parsed);
                        }
                    } catch (e) {
                        try {
                            const cleaned = objStr.replace(/,\s*}/g, "}");
                            const parsed = JSON.parse(cleaned);
                            if (parsed && typeof parsed === "object") {
                                results.push(parsed);
                            }
                        } catch (_) {}
                    }
                    startIdx = -1;
                }
            }
        }
        return results;
    }

    // Function to process and apply newly pasted segments (Replacing old table rows completely)
    function applyPastedSegments(rawContent) {
        if (!rawContent || !rawContent.trim()) {
            alert("❌ គ្មានទិន្នន័យសម្រាប់បញ្ចូលទេ!");
            return false;
        }

        let items = [];
        let trimmed = rawContent.trim();

        // Remove Markdown code block wrappers like ```json ... ``` or ``` ... ```
        if (trimmed.startsWith("```")) {
            trimmed = trimmed.replace(/^```[a-zA-Z0-9_-]*\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
        }

        // 1. Direct JSON parse (Array or Object with segments)
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                items = parsed;
            } else if (parsed && Array.isArray(parsed.segments)) {
                items = parsed.segments;
            } else if (parsed && typeof parsed === "object") {
                items = [parsed];
            }
        } catch (_) {}

        // 2. Comprehensive bracket-depth scanner for JSON objects (handles any size, even unclosed arrays `[ { ... }, { ... }`)
        if (items.length === 0) {
            const extracted = extractObjectsFromText(trimmed);
            if (extracted.length > 0) {
                items = extracted;
            }
        }

        // 3. Fallback regex scanner if JSON quotes or keys had slight format variations
        if (items.length === 0 && (trimmed.includes('"start"') || trimmed.includes("'start'") || trimmed.includes('"translated"'))) {
            const blockRegex = /\{[^{}]*?\}/g;
            let match;
            while ((match = blockRegex.exec(trimmed)) !== null) {
                const mStr = match[0];
                const sMatch = mStr.match(/(?:"start"|'start')\s*:\s*("?[^",\n\}]+"?,?)/i);
                const eMatch = mStr.match(/(?:"end"|'end')\s*:\s*("?[^",\n\}]+"?,?)/i);
                const tMatch = mStr.match(/(?:"translated"|'translated')\s*:\s*"([^"]*)"/i);
                const oMatch = mStr.match(/(?:"original"|'original')\s*:\s*"([^"]*)"/i);
                if (tMatch || sMatch) {
                    items.push({
                        start: sMatch ? sMatch[1].replace(/["',]/g, "").trim() : "0:00.00",
                        end: eMatch ? eMatch[1].replace(/["',]/g, "").trim() : "0:02.00",
                        original: oMatch ? oMatch[1] : "",
                        translated: tMatch ? tMatch[1] : ""
                    });
                }
            }
        }

        // 4. Try parsing SRT format (Handles infinite blocks separated by timestamps 00:00:00,000 --> ...)
        if (items.length === 0 && trimmed.includes("-->")) {
            const srtRegex = /(?:(\d+)\s*\r?\n)?(\d{1,2}:\d{2}(?::\d{2})?(?:[,\.]\d{1,3})?)\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[,\.]\d{1,3})?)\s*\r?\n([\s\S]*?)(?=(?:\r?\n\s*\r?\n|\r?\n\d+\s*\r?\n\d{1,2}:|\s*$))/g;
            let srtMatch;
            while ((srtMatch = srtRegex.exec(trimmed)) !== null) {
                const sPart = srtMatch[2].replace(",", ".");
                const ePart = srtMatch[3].replace(",", ".");
                const rawTexts = srtMatch[4].split(/\r?\n/).map(t => t.trim()).filter(Boolean);
                items.push({
                    start: parseTimeToSeconds(sPart),
                    end: parseTimeToSeconds(ePart),
                    original: rawTexts[0] || "",
                    translated: rawTexts[1] || rawTexts[0] || ""
                });
            }
        }

        // 5. Fallback: Tab or Pipe or CSV delimited lines
        if (items.length === 0 && (trimmed.includes("\t") || trimmed.includes("|"))) {
            const lines = trimmed.split(/\r?\n/);
            lines.forEach(r => {
                const sep = r.includes("\t") ? "\t" : "|";
                const cols = r.split(sep).map(c => c.trim());
                if (cols.length >= 2 && (cols[0].includes(":") || !isNaN(parseFloat(cols[0])))) {
                    items.push({
                        start: parseTimeToSeconds(cols[0]),
                        end: parseTimeToSeconds(cols[1]),
                        original: cols[2] || "",
                        translated: cols[3] || cols[2] || ""
                    });
                }
            });
        }

        // 6. Plain text fallback: Line-by-line script without timestamps
        if (items.length === 0) {
            const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            if (lines.length > 0) {
                const totalDur = state.duration || (lines.length * 4.0);
                const step = Math.max(2.0, totalDur / lines.length);
                lines.forEach((line, idx) => {
                    const startSec = idx * step;
                    const endSec = Math.min(totalDur, startSec + (step * 0.9));
                    items.push({
                        start: startSec,
                        end: endSec,
                        original: line,
                        translated: line
                    });
                });
            }
        }

        if (items.length === 0) {
            alert("❌ មិនអាចអានទិន្នន័យបានឡើយ! សូម Paste ជាទម្រង់ JSON, SRT ឬជាអត្ថបទ Script ធម្មតា។");
            return false;
        }

        // Normalize and replace old segments completely
        const normalized = items.map((item, idx) => {
            const startSec = item.start_sec !== undefined ? parseFloat(item.start_sec) : parseTimeToSeconds(item.start);
            const endSec = item.end_sec !== undefined ? parseFloat(item.end_sec) : parseTimeToSeconds(item.end);

            return {
                id: idx + 1,
                start: Math.max(0, startSec),
                end: Math.max(startSec + 0.3, endSec),
                original: item.original || item.text || "",
                translated: item.translated || item.trans || "",
                voice: item.voice || state.actor1Voice,
                actor: item.actor || "Actor 1"
            };
        });

        // Sort ascending by start time
        normalized.sort((a, b) => a.start - b.start);
        normalized.forEach((s, i) => s.id = i + 1);

        // Replace state.segments completely
        state.segments = normalized;
        clearAudioCache();
        stopDubAudio();

        // Update Memory and LocalStorage cache
        memoryTableClipboard = JSON.parse(JSON.stringify(normalized));
        try {
            localStorage.setItem(STORAGE_CLIPBOARD_KEY, JSON.stringify(normalized));
        } catch (_) {}

        // Automatically adjust video duration/timeline if pasted segments extend beyond current duration
        const maxEndSec = normalized.reduce((max, s) => Math.max(max, s.end), 0);
        if (maxEndSec > (state.duration || 0)) {
            state.duration = Math.ceil(maxEndSec + 2);
            if (timeline && timeline.setDuration) {
                timeline.setDuration(state.duration);
            }
        }

        // Re-render UI immediately
        renderTable();
        timeline.renderSegments(state.segments);
        triggerBackendPreload();
        if (typeof syncCurrentPlaylistEpisode === "function") {
            syncCurrentPlaylistEpisode();
        }

        // ★ Pre-warm TTS audio cache for first 12 segments immediately
        // So audio is ready before user presses Play (no delay on first segments)
        setTimeout(() => {
            const warmCount = Math.min(12, state.segments.length);
            for (let i = 0; i < warmCount; i++) {
                const seg = state.segments[i];
                if (seg && (seg.translated || "").trim() && !audioCache[seg.id]) {
                    getSegmentAudio(seg); // background fetch, fire-and-forget
                }
            }
        }, 500);

        // ---------------------------------------------------------------------
        // Translation utilities – Chinese → Khmer (using MyMemory free API)
        // ---------------------------------------------------------------------
        /** Detect if a string contains any Chinese characters. */
        function containsChinese(txt) {
            return /[\u4e00-\u9fff]/.test(txt);
        }

        /** Translate a given text from Chinese (zh) to Khmer (km) via MyMemory API. */
        async function translateChineseToKhmer(text) {
            const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=zh|km`;
            try {
                const resp = await fetch(url);
                const data = await resp.json();
                if (data && data.responseData && data.responseData.translatedText) {
                    return data.responseData.translatedText;
                }
                console.warn('MyMemory translation failed, returning original');
                return text;
            } catch (e) {
                console.error('Translation error:', e);
                return text;
            }
        }

        /** Translate all subtitle rows whose original text contains Chinese characters. */
        async function translateAllChineseSegments() {
            if (!state.segments || state.segments.length === 0) {
                alert('📭 គ្មានជួរដេកសម្រាប់បកប្រែទេ!');
                return;
            }
            const promises = state.segments.map(async seg => {
                if (containsChinese(seg.original)) {
                    const kh = await translateChineseToKhmer(seg.original);
                    seg.translated = kh;
                }
            });
            await Promise.all(promises);
            renderTable();
            if (timeline && timeline.renderSegments) timeline.renderSegments(state.segments);
            setStatus(`✅ បានបកប្រែ ${state.segments.filter(s => containsChinese(s.original)).length} ជួរ​។`);
            alert('✅ បកប្រែ​បញ្ចប់!');
        }

        // Add a button to the toolbar for translating Chinese → Khmer (if toolbar exists)
        document.addEventListener('DOMContentLoaded', () => {
            const toolbar = document.getElementById('toolbar');
            if (toolbar && !document.getElementById('btnTranslateAll')) {
                const btn = document.createElement('button');
                btn.id = 'btnTranslateAll';
                btn.innerText = '🔁 បកប្រែចិន→ខ្មែរ';
                btn.style.marginLeft = '8px';
                btn.addEventListener('click', translateAllChineseSegments);
                toolbar.appendChild(btn);
            }
        });

        setStatus(`📥 បានផ្លាស់ប្តូរអត្ថបទចាស់ចេញ និងជំនួសដោយអត្ថបទថ្មី ${normalized.length} ជួររួចរាល់!`);
        alert(`🎉 ជោគជ័យ! អត្ថបទចាស់ត្រូវបានដកចេញ ហើយអត្ថបទថ្មីចំនួន ${normalized.length} ជួរត្រូវបានដាក់ចូលតារាងរួចរាល់!`);
        return true;
    }

    // 2. Paste Button Handler: Opens Fast Paste Modal & Processes Unlimited Lines
    const btnPasteTable = document.getElementById("btnPasteTable");
    const pasteModal = document.getElementById("pasteModal");
    const txtPasteInput = document.getElementById("txtPasteInput");
    const btnConfirmPaste = document.getElementById("btnConfirmPaste");

    const btnClearPasteInput = document.getElementById("btnClearPasteInput");
    if (btnClearPasteInput && txtPasteInput) {
        btnClearPasteInput.addEventListener("click", () => {
            txtPasteInput.value = "";
            txtPasteInput.focus();
        });
    }

    if (btnPasteTable) {
        btnPasteTable.addEventListener("click", () => {
            // Open modal directly with blank textarea ready for pasting any amount of text
            if (txtPasteInput) {
                txtPasteInput.value = "";
            }
            openModal("pasteModal");
            if (txtPasteInput) {
                txtPasteInput.focus();
            }
        });
    }

    if (btnConfirmPaste && txtPasteInput) {
        btnConfirmPaste.addEventListener("click", () => {
            const rawText = txtPasteInput.value.trim();

            if (!rawText) {
                alert("❌ សូមបញ្ចូលអត្ថបទ JSON ឬអត្ថបទស្គ្រីបជាមុនសិន!");
                return;
            }

            try {
                let itemsToAdd = [];

                // Remove Markdown wrapper if present (e.g. ```json ... ```)
                let cleanText = rawText;
                if (cleanText.startsWith("```")) {
                    cleanText = cleanText.replace(/^```[a-zA-Z0-9_-]*\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
                }

                // 1. Direct JSON.parse
                try {
                    const parsedData = JSON.parse(cleanText);
                    if (Array.isArray(parsedData)) {
                        itemsToAdd = parsedData;
                    } else if (parsedData && Array.isArray(parsedData.segments)) {
                        itemsToAdd = parsedData.segments;
                    } else if (typeof parsedData === "object" && parsedData !== null) {
                        itemsToAdd = [parsedData];
                    }
                } catch (_) {
                    // Try bracket-depth object extraction if trailing comma or syntax glitch
                    const extracted = extractObjectsFromText(cleanText);
                    if (extracted.length > 0) {
                        itemsToAdd = extracted;
                    }
                }

                // 2. Fallback: SRT subtitles format
                if (itemsToAdd.length === 0 && cleanText.includes("-->")) {
                    const srtRegex = /(?:(\d+)\s*\r?\n)?(\d{1,2}:\d{2}(?::\d{2})?(?:[,\.]\d{1,3})?)\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[,\.]\d{1,3})?)\s*\r?\n([\s\S]*?)(?=(?:\r?\n\s*\r?\n|\r?\n\d+\s*\r?\n\d{1,2}:|\s*$))/g;
                    let srtMatch;
                    while ((srtMatch = srtRegex.exec(cleanText)) !== null) {
                        const sPart = srtMatch[2].replace(",", ".");
                        const ePart = srtMatch[3].replace(",", ".");
                        const rawTexts = srtMatch[4].split(/\r?\n/).map(t => t.trim()).filter(Boolean);
                        itemsToAdd.push({
                            start: parseTimeToSeconds(sPart),
                            end: parseTimeToSeconds(ePart),
                            original: rawTexts[0] || "",
                            translated: rawTexts[1] || rawTexts[0] || ""
                        });
                    }
                }

                // 3. Fallback: Tab/Excel or Plain text script
                if (itemsToAdd.length === 0) {
                    const lines = cleanText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                    if (lines.length > 0) {
                        const totalDur = state.duration || (lines.length * 4.0);
                        const step = Math.max(2.0, totalDur / lines.length);
                        lines.forEach((line, idx) => {
                            const startSec = idx * step;
                            const endSec = Math.min(totalDur, startSec + (step * 0.9));
                            itemsToAdd.push({
                                start: startSec,
                                end: endSec,
                                original: line,
                                translated: line
                            });
                        });
                    }
                }

                if (itemsToAdd.length === 0) {
                    alert("❌ ទិន្នន័យមិនត្រឹមត្រូវ ឬគ្មានទិន្នន័យឡើយ!");
                    return;
                }

                // --- ដំណើរការបញ្ចូលគ្រប់ជួរទាំងអស់ (គ្មានដែនកំណត់) ---
                const newSegments = [];
                itemsToAdd.forEach((item, idx) => {
                    const startSec = item.start_sec !== undefined ? parseFloat(item.start_sec) : parseTimeToSeconds(item.start);
                    const endSec = item.end_sec !== undefined ? parseFloat(item.end_sec) : parseTimeToSeconds(item.end);

                    newSegments.push({
                        id: idx + 1,
                        start: Math.max(0, isNaN(startSec) ? 0 : startSec),
                        end: Math.max((isNaN(startSec) ? 0 : startSec) + 0.3, isNaN(endSec) ? (startSec + 2) : endSec),
                        original: item.original || item.text || "",
                        translated: item.translated || item.trans || "",
                        voice: item.voice || state.actor1Voice || "km-KH-PisethNeural",
                        actor: item.actor || "Actor 1"
                    });
                });

                // តម្រៀបតាមពេលវេលា (Start Time)
                newSegments.sort((a, b) => (parseFloat(a.start) || 0) - (parseFloat(b.start) || 0));
                newSegments.forEach((s, i) => s.id = i + 1);

                // ជំនួសទិន្នន័យចាស់ចេញទាំងអស់ដោយទិន្នន័យថ្មី
                // Append new rows to existing segments instead of replacing all
state.segments = (state.segments || []).concat(newSegments);
                clearAudioCache();
                stopDubAudio();

                // រក្សាទុកក្នុង Memory & LocalStorage
                memoryTableClipboard = JSON.parse(JSON.stringify(newSegments));
                try {
                    localStorage.setItem(STORAGE_CLIPBOARD_KEY, JSON.stringify(newSegments));
                } catch (_) {}

                // ពង្រីកប្រវែង Timeline ដោយស្វ័យប្រវត្តិតាមវិនាទីនៃអត្ថបទចុងក្រោយ
                const maxEndSec = newSegments.reduce((max, s) => Math.max(max, parseFloat(s.end) || 0), 0);
                if (maxEndSec > (state.duration || 0)) {
                    state.duration = Math.ceil(maxEndSec + 2);
                    if (timeline && timeline.setDuration) {
                        timeline.setDuration(state.duration);
                    }
                }

                // គូរ (Render) តារាង និង Timeline ឡើងវិញភ្លាមៗ
                renderTable();
                timeline.renderSegments(state.segments);
                triggerBackendPreload();

        // ---------------------------------------------------------------------
        // Translation utilities – Chinese → Khmer (using MyMemory free API)
        // ---------------------------------------------------------------------
        /** Detect if a string contains any Chinese characters. */
        function containsChinese(txt) {
            return /[\u4e00-\u9fff]/.test(txt);
        }

        /** Translate a given text from Chinese (zh) to Khmer (km) via MyMemory API. */
        async function translateChineseToKhmer(text) {
            const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=zh|km`;
            try {
                const resp = await fetch(url);
                const data = await resp.json();
                if (data && data.responseData && data.responseData.translatedText) {
                    return data.responseData.translatedText;
                }
                console.warn('MyMemory translation failed, returning original');
                return text;
            } catch (e) {
                console.error('Translation error:', e);
                return text;
            }
        }

        /** Translate all subtitle rows whose original text contains Chinese characters. */
        async function translateAllChineseSegments() {
            if (!state.segments || state.segments.length === 0) {
                alert('📭 គ្មានជួរដេកសម្រាប់បកប្រែទេ!');
                return;
            }
            const promises = state.segments.map(async seg => {
                if (containsChinese(seg.original)) {
                    const kh = await translateChineseToKhmer(seg.original);
                    seg.translated = kh;
                }
            });
            await Promise.all(promises);
            renderTable();
            if (timeline && timeline.renderSegments) timeline.renderSegments(state.segments);
            setStatus(`✅ បានបកប្រែ ${state.segments.filter(s => containsChinese(s.original)).length} ជួរ​។`);
            alert('✅ បកប្រែ​បញ្ចប់!');
        }

        // Add a button to the toolbar for translating Chinese → Khmer (if toolbar exists)
        document.addEventListener('DOMContentLoaded', () => {
            const toolbar = document.getElementById('toolbar');
            if (toolbar && !document.getElementById('btnTranslateAll')) {
                const btn = document.createElement('button');
                btn.id = 'btnTranslateAll';
                btn.innerText = '🔁 បកប្រែចិន→ខ្មែរ';
                btn.style.marginLeft = '8px';
                btn.addEventListener('click', translateAllChineseSegments);
                toolbar.appendChild(btn);
            }
        });

                // បិទ Modal
                closeModal("pasteModal");

                setStatus(`📥 បានបញ្ចូលទិន្នន័យថ្មីចំនួន ${itemsToAdd.length} ជួរ ទៅក្នុងតារាងដោយជោគជ័យ!`);
                alert(`🎉 ជោគជ័យ! បានបញ្ចូលទិន្នន័យថ្មីចំនួន ${itemsToAdd.length} ជួរ ទៅក្នុងតារាងរួចរាល់ដោយរលូន (គ្មានដែនកំណត់)!`);

            } catch (error) {
                console.error("Paste error:", error);
                alert("❌ ទម្រង់អត្ថបទ JSON មិនត្រឹមត្រូវ! សូមពិនិត្យមើលសញ្ញាធ្មេញកណ្តុរ (\") ឬសញ្ញាក្បៀស (,) ឡើងវិញ។");
            }
        });
    }

    // Save Project to JSON
    document.getElementById("btnSaveProject").addEventListener("click", () => {
        const projectData = {
            version: "1.0",
            videoPath: state.videoPath,
            duration: state.duration,
            segments: state.segments,
            watermarkText: state.watermarkText,
            timestamp: new Date().toISOString()
        };
        const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "movie_recap_project.json";
        a.click();
    });

    // Export Subtitles SRT
    document.getElementById("btnExportSrt").addEventListener("click", () => {
        if (!state.segments.length) {
            alert("មិនមានទិន្នន័យសម្រាប់ទាញយក SRT ទេ!");
            return;
        }
        function formatSrtTime(sec) {
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            const s = Math.floor(sec % 60);
            const ms = Math.floor((sec - Math.floor(sec)) * 1000);
            return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")},${ms.toString().padStart(3, "0")}`;
        }

        let srtContent = "";
        state.segments.forEach((seg, i) => {
            srtContent += `${i + 1}\n`;
            srtContent += `${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n`;
            srtContent += `${seg.translated || seg.original || ""}\n\n`;
        });

        const blob = new Blob([srtContent], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "khmer_subtitles.srt";
        a.click();
    });

    // Modals Handling
    function openModal(id) {
        const m = document.getElementById(id);
        if (m) m.style.display = "flex";
    }

    function closeModal(id) {
        const m = document.getElementById(id);
        if (m) m.style.display = "none";
    }

    document.querySelectorAll("[data-close]").forEach(btn => {
        btn.addEventListener("click", () => {
            closeModal(btn.dataset.close);
        });
    });

    // Assign Voice Modal
    document.getElementById("btnAssignVoiceModal").addEventListener("click", () => openModal("assignVoiceModal"));

    // ── Voice Timbre & Pitch Studio (Piseth & Sreymom) ────────────────────────
    const pisethPitchSlider = document.getElementById("pisethPitchSlider");
    const pisethRateSlider = document.getElementById("pisethRateSlider");
    const pisethPitchLabel = document.getElementById("pisethPitchLabel");
    const pisethRateLabel = document.getElementById("pisethRateLabel");
    const pisethSummaryBadge = document.getElementById("pisethSummaryBadge");

    const sreymomPitchSlider = document.getElementById("sreymomPitchSlider");
    const sreymomRateSlider = document.getElementById("sreymomRateSlider");
    const sreymomPitchLabel = document.getElementById("sreymomPitchLabel");
    const sreymomRateLabel = document.getElementById("sreymomRateLabel");
    const sreymomSummaryBadge = document.getElementById("sreymomSummaryBadge");

    function parseHzValue(strVal) {
        const n = parseInt(String(strVal || "+0Hz").replace(/[^-\d]/g, ""), 10);
        return isNaN(n) ? 0 : Math.max(-20, Math.min(20, n));
    }

    function parsePctValue(strVal) {
        const n = parseInt(String(strVal || "+35%").replace(/[^-\d]/g, ""), 10);
        return isNaN(n) ? 35 : Math.max(-10, Math.min(75, n));
    }

    function formatHzString(num) {
        const n = parseInt(num, 10) || 0;
        return (n >= 0 ? "+" : "") + n + "Hz";
    }

    function formatPctString(num) {
        const n = parseInt(num, 10) || 0;
        return (n >= 0 ? "+" : "") + n + "%";
    }

    function describePitchKhmer(hz, isFemale = false) {
        if (hz <= -10) return isFemale ? "ធ្ងន់ចាស់ទុំ" : "គ្រលរធ្ងន់ខ្លាំង";
        if (hz <= -4) return isFemale ? "មាំថ្លៃថ្នូរ" : "ធ្ងន់មាំ";
        if (hz >= 8) return isFemale ? "ស្រួយតូច" : "ស្រាល/ក្មេង";
        if (hz >= 3) return isFemale ? "ស្រទន់ផ្អែម" : "ស្រាលរហ័ស";
        return "ធម្មជាតិដើម";
    }

    function syncVoiceTunerUI() {
        const pHz = pisethPitchSlider ? parseInt(pisethPitchSlider.value, 10) : parseHzValue(state.pisethPitch);
        const pPct = pisethRateSlider ? parseInt(pisethRateSlider.value, 10) : parsePctValue(state.pisethRate);
        const sHz = sreymomPitchSlider ? parseInt(sreymomPitchSlider.value, 10) : parseHzValue(state.sreymomPitch);
        const sPct = sreymomRateSlider ? parseInt(sreymomRateSlider.value, 10) : parsePctValue(state.sreymomRate);

        const pHzStr = formatHzString(pHz);
        const pPctStr = formatPctString(pPct);
        const sHzStr = formatHzString(sHz);
        const sPctStr = formatPctString(sPct);

        if (pisethPitchLabel) pisethPitchLabel.textContent = `${pHzStr} (${describePitchKhmer(pHz, false)})`;
        if (pisethRateLabel) pisethRateLabel.textContent = pPctStr;
        if (pisethSummaryBadge) pisethSummaryBadge.textContent = `${pHzStr} | ${pPctStr}`;

        if (sreymomPitchLabel) sreymomPitchLabel.textContent = `${sHzStr} (${describePitchKhmer(sHz, true)})`;
        if (sreymomRateLabel) sreymomRateLabel.textContent = sPctStr;
        if (sreymomSummaryBadge) sreymomSummaryBadge.textContent = `${sHzStr} | ${sPctStr}`;

        const dubStatusEl = document.getElementById("dubStatus");
        if (dubStatusEl) {
            dubStatusEl.textContent = `TTS: ពិសិដ្ឋ (${state.pisethPitch}, ${state.pisethRate}) & ស្រីមុំ (${state.sreymomPitch}, ${state.sreymomRate})`;
        }
    }

    function loadVoiceTunerSlidersFromState() {
        if (pisethPitchSlider) pisethPitchSlider.value = parseHzValue(state.pisethPitch);
        if (pisethRateSlider) pisethRateSlider.value = parsePctValue(state.pisethRate);
        if (sreymomPitchSlider) sreymomPitchSlider.value = parseHzValue(state.sreymomPitch);
        if (sreymomRateSlider) sreymomRateSlider.value = parsePctValue(state.sreymomRate);
        syncVoiceTunerUI();
    }

    loadVoiceTunerSlidersFromState();

    const btnVoiceTunerModal = document.getElementById("btnVoiceTunerModal");
    if (btnVoiceTunerModal) {
        btnVoiceTunerModal.addEventListener("click", () => {
            loadVoiceTunerSlidersFromState();
            openModal("voiceTunerModal");
        });
    }

    const btnOpenVoiceTunerFromAssign = document.getElementById("btnOpenVoiceTunerFromAssign");
    if (btnOpenVoiceTunerFromAssign) {
        btnOpenVoiceTunerFromAssign.addEventListener("click", () => {
            closeModal("assignVoiceModal");
            loadVoiceTunerSlidersFromState();
            openModal("voiceTunerModal");
        });
    }

    [pisethPitchSlider, pisethRateSlider, sreymomPitchSlider, sreymomRateSlider].forEach(sl => {
        if (sl) sl.addEventListener("input", syncVoiceTunerUI);
    });

    document.querySelectorAll(".piseth-preset-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            if (pisethPitchSlider) pisethPitchSlider.value = btn.getAttribute("data-pitch") || "0";
            if (pisethRateSlider) pisethRateSlider.value = btn.getAttribute("data-rate") || "35";
            syncVoiceTunerUI();
        });
    });

    document.querySelectorAll(".sreymom-preset-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            if (sreymomPitchSlider) sreymomPitchSlider.value = btn.getAttribute("data-pitch") || "0";
            if (sreymomRateSlider) sreymomRateSlider.value = btn.getAttribute("data-rate") || "35";
            syncVoiceTunerUI();
        });
    });

    async function previewTunedVoice(voiceName, pitchStr, rateStr, btnEl) {
        const sampleInput = document.getElementById("voiceTunerSampleText");
        const text = (sampleInput && sampleInput.value.trim()) || "ចាប់ពីថ្ងៃនេះទៅ ខ្ញុំនឹងការពារនាងឱ្យអស់ពីជីវិត!";
        const origHtml = btnEl ? btnEl.innerHTML : "";
        if (btnEl) {
            btnEl.disabled = true;
            btnEl.innerHTML = '<span>⏳ កំពុងបង្កើតសំឡេងសាកល្បង...</span>';
        }
        try {
            const res = await fetch("/api/preview-tts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    text: text,
                    voice: voiceName,
                    rate: rateStr,
                    pitch: pitchStr
                })
            });
            if (res.ok) {
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                previewAudio.src = url;
                previewAudio.currentTime = 0;
                previewAudio.play();
            } else {
                alert("មិនអាចបង្កើតសំឡេងសាកល្បងបានទេ សូមពិនិត្យ Internet");
            }
        } catch (err) {
            console.error("Voice tuner preview failed:", err);
        } finally {
            if (btnEl) {
                btnEl.disabled = false;
                btnEl.innerHTML = origHtml;
                refreshIcons();
            }
        }
    }

    const btnPreviewPisethVoice = document.getElementById("btnPreviewPisethVoice");
    if (btnPreviewPisethVoice) {
        btnPreviewPisethVoice.addEventListener("click", () => {
            const pHzStr = formatHzString(pisethPitchSlider ? pisethPitchSlider.value : 0);
            const pPctStr = formatPctString(pisethRateSlider ? pisethRateSlider.value : 35);
            previewTunedVoice("km-KH-PisethNeural", pHzStr, pPctStr, btnPreviewPisethVoice);
        });
    }

    const btnPreviewSreymomVoice = document.getElementById("btnPreviewSreymomVoice");
    if (btnPreviewSreymomVoice) {
        btnPreviewSreymomVoice.addEventListener("click", () => {
            const sHzStr = formatHzString(sreymomPitchSlider ? sreymomPitchSlider.value : 0);
            const sPctStr = formatPctString(sreymomRateSlider ? sreymomRateSlider.value : 35);
            previewTunedVoice("km-KH-SreymomNeural", sHzStr, sPctStr, btnPreviewSreymomVoice);
        });
    }

    const btnResetVoiceTuner = document.getElementById("btnResetVoiceTuner");
    if (btnResetVoiceTuner) {
        btnResetVoiceTuner.addEventListener("click", () => {
            if (pisethPitchSlider) pisethPitchSlider.value = 0;
            if (pisethRateSlider) pisethRateSlider.value = 35;
            if (sreymomPitchSlider) sreymomPitchSlider.value = 0;
            if (sreymomRateSlider) sreymomRateSlider.value = 35;
            syncVoiceTunerUI();
        });
    }

    const btnSaveVoiceTuner = document.getElementById("btnSaveVoiceTuner");
    if (btnSaveVoiceTuner) {
        btnSaveVoiceTuner.addEventListener("click", () => {
            state.pisethPitch = formatHzString(pisethPitchSlider ? pisethPitchSlider.value : 0);
            state.pisethRate = formatPctString(pisethRateSlider ? pisethRateSlider.value : 35);
            state.sreymomPitch = formatHzString(sreymomPitchSlider ? sreymomPitchSlider.value : 0);
            state.sreymomRate = formatPctString(sreymomRateSlider ? sreymomRateSlider.value : 35);
            state.speechRate = state.pisethRate;

            localStorage.setItem("vocal_piseth_pitch", state.pisethPitch);
            localStorage.setItem("vocal_piseth_rate", state.pisethRate);
            localStorage.setItem("vocal_sreymom_pitch", state.sreymomPitch);
            localStorage.setItem("vocal_sreymom_rate", state.sreymomRate);

            syncVoiceTunerUI();
            clearAudioCache();
            stopDubAudio();
            triggerBackendPreload();
            closeModal("voiceTunerModal");
            setStatus(`✅ បានរក្សាទុកបំពង់សំឡេង៖ ពិសិដ្ឋ (${state.pisethPitch}, ល្បឿន ${state.pisethRate}) | ស្រីមុំ (${state.sreymomPitch}, ល្បឿន ${state.sreymomRate})`);
        });
    }
    document.getElementById("btnApplyVoiceAssignment").addEventListener("click", () => {
        state.actor1Voice = document.getElementById("modalVoiceActor1").value;
        state.actor2Voice = document.getElementById("modalVoiceActor2").value;
        state.speechRate = document.getElementById("modalSpeechRate").value;

        clearAudioCache();
        state.segments.forEach((seg, i) => {
            // Respect existing detected actor gender if available
            if (seg.actor === "Actor 2" || (seg.voice && seg.voice.includes("Sreymom"))) {
                seg.voice = state.actor2Voice;
                seg.actor = "Actor 2";
            } else {
                seg.voice = state.actor1Voice;
                seg.actor = "Actor 1";
            }
        });

        renderTable();
        timeline.renderSegments(state.segments);
        closeModal("assignVoiceModal");
        setStatus("បានកំណត់សំឡេងតួអង្គ (Actor 1: " + state.actor1Voice + " / Actor 2: " + state.actor2Voice + ") រួចរាល់!");
    });

    const btnSetAllMale = document.getElementById("btnSetAllMale");
    if (btnSetAllMale) {
        btnSetAllMale.addEventListener("click", () => {
            const actor1 = document.getElementById("modalVoiceActor1") ? document.getElementById("modalVoiceActor1").value : "km-KH-PisethNeural";
            clearAudioCache();
            stopDubAudio();
            (state.segments || []).forEach(seg => {
                seg.voice = actor1;
                seg.actor = "Actor 1";
            });
            renderTable();
            if (timeline && timeline.renderSegments) timeline.renderSegments(state.segments);
            closeModal("assignVoiceModal");
            const msg = `✅ បានកំណត់គ្រប់ជួរទាំងអស់ (${state.segments.length} ឃ្លា) ជាសំឡេងតួប្រុស (${actor1})!`;
            setStatus(msg);
            alert(msg);
        });
    }

    const btnSetAllFemale = document.getElementById("btnSetAllFemale");
    if (btnSetAllFemale) {
        btnSetAllFemale.addEventListener("click", () => {
            const actor2 = document.getElementById("modalVoiceActor2") ? document.getElementById("modalVoiceActor2").value : "km-KH-SreymomNeural";
            clearAudioCache();
            stopDubAudio();
            (state.segments || []).forEach(seg => {
                seg.voice = actor2;
                seg.actor = "Actor 2";
            });
            renderTable();
            if (timeline && timeline.renderSegments) timeline.renderSegments(state.segments);
            closeModal("assignVoiceModal");
            const msg = `✅ បានកំណត់គ្រប់ជួរទាំងអស់ (${state.segments.length} ឃ្លា) ជាសំឡេងតួស្រី (${actor2})!`;
            setStatus(msg);
            alert(msg);
        });
    }

    async function autoDetectGenders(mode = "auto") {
        if (!state.videoPath) {
            alert("សូមជ្រើសរើស ឬបញ្ចូលវីដេអូជាមុនសិន!");
            return;
        }
        if (!state.segments || state.segments.length === 0) {
            alert("មិនទាន់មានឃ្លា (Segments) សម្រាប់បែងចែកទេ។ សូមចុចចាប់យកស្គ្រីបជាមុនសិន!");
            return;
        }

        const btnToolbar = document.getElementById("btnAutoDetectGenders");
        const btnModalGemini = document.getElementById("btnModalDetectGemini");
        const btnModalAcoustic = document.getElementById("btnModalAutoDetectGender");

        const origToolbarHtml = btnToolbar ? btnToolbar.innerHTML : "";
        const origGeminiHtml = btnModalGemini ? btnModalGemini.innerHTML : "";
        const origAcousticHtml = btnModalAcoustic ? btnModalAcoustic.innerHTML : "";

        if (btnToolbar) {
            btnToolbar.innerHTML = mode === "gemini" ? "<span>✨</span><span>Gemini AI កំពុងស្ដាប់...</span>" : "<span>⏳</span><span>កំពុងវិភាគ...</span>";
            btnToolbar.disabled = true;
        }
        if (btnModalGemini) {
            btnModalGemini.innerHTML = "<span>⏳</span><span>Google Gemini កំពុងស្ដាប់សំឡេង...</span>";
            btnModalGemini.disabled = true;
        }
        if (btnModalAcoustic) {
            btnModalAcoustic.innerHTML = "<span>⏳</span><span>កំពុងវិភាគរលកសម្លេង (Pitch)...</span>";
            btnModalAcoustic.disabled = true;
        }

        if (mode === "gemini") {
            setStatus("✨ កំពុងឱ្យ Google Gemini AI ស្ដាប់សំឡេង និងវិភាគតួអង្គប្រុស/ស្រី (Multimodal Audio)...");
        } else if (mode === "acoustic") {
            setStatus("⚡ កំពុងវិភាគរលកសម្លេងវីដេអូដើម្បីបែងចែកតួអង្គ (Acoustic Pitch AI)...");
        } else {
            setStatus("🎭 កំពុងវិភាគបែងចែកតួអង្គប្រុស ឬស្រីដោយស្វ័យប្រវត្ត...");
        }

        try {
            const actor1 = document.getElementById("modalVoiceActor1") ? document.getElementById("modalVoiceActor1").value : (state.actor1Voice || "km-KH-PisethNeural");
            const actor2 = document.getElementById("modalVoiceActor2") ? document.getElementById("modalVoiceActor2").value : (state.actor2Voice || "km-KH-SreymomNeural");

            let res;
            try {
                res = await fetch("/api/detect-genders", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        video_path: state.videoPath,
                        segments: state.segments,
                        actor1_voice: actor1,
                        actor2_voice: actor2,
                        mode: mode
                    })
                });
            } catch (netErr) {
                if (mode === "gemini") {
                    console.warn("Gemini network request failed, falling back to local acoustic:", netErr);
                    setStatus("⚡ កំពុងប្ដូរទៅប្រើប្រព័ន្ធ Acoustic Pitch (វាស់រលកសំឡេង)...");
                    res = await fetch("/api/detect-genders", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            video_path: state.videoPath,
                            segments: state.segments,
                            actor1_voice: actor1,
                            actor2_voice: actor2,
                            mode: "acoustic"
                        })
                    });
                } else {
                    throw netErr;
                }
            }

            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.detail || "បរាជ័យក្នុងការវិភាគ");
            }

            state.segments = data.segments;
            clearAudioCache();

            renderTable();
            timeline.renderSegments(state.segments);

            let maleCount = 0;
            let femaleCount = 0;
            state.segments.forEach(s => {
                if (s.actor === "Actor 2" || (s.voice && s.voice.includes("Sreymom"))) femaleCount++;
                else maleCount++;
            });

            closeModal("assignVoiceModal");
            const engineInfo = data.engine ? ` តាមរយៈ ${data.engine}` : "";
            const msg = `🎉 បានបែងចែកសំឡេងតួអង្គជោគជ័យ${engineInfo}!\n👨 ប្រុស (Actor 1): ${maleCount} ឃ្លា\n👩 ស្រី (Actor 2): ${femaleCount} ឃ្លា`;
            setStatus(msg.replace(/\n/g, " | "));
            alert(msg);
        } catch (err) {
            console.error("Gender detect error:", err);
            alert("កំហុសក្នុងការបែងចែកសំឡេង៖ " + err.message);
            setStatus("បរាជ័យក្នុងការបែងចែកសំឡេង");
        } finally {
            if (btnToolbar) {
                btnToolbar.innerHTML = origToolbarHtml;
                btnToolbar.disabled = false;
            }
            if (btnModalGemini) {
                btnModalGemini.innerHTML = origGeminiHtml;
                btnModalGemini.disabled = false;
            }
            if (btnModalAcoustic) {
                btnModalAcoustic.innerHTML = origAcousticHtml;
                btnModalAcoustic.disabled = false;
            }
        }
    }

    // --- Web Audio API Client-Side Instant Pitch Detector (YIN Algorithm) ---
    // Enhanced: octave correction + trimmed-mean + adaptive threshold
    function estimateSegmentPitchYIN(channelData, startSample, endSample, sr) {
        const minF0 = 70;
        const maxF0 = 450;
        const minTau = Math.max(2, Math.floor(sr / maxF0));
        const maxTau = Math.min(Math.floor(sr / minF0), 2048);

        // Use longer frame = 3x maxTau for better low-pitch detection
        const frameLen = Math.min(4096, maxTau * 3);
        const W = frameLen - maxTau;
        if (W <= 0) return -1;

        const segLen = endSample - startSample;
        if (segLen < frameLen + maxTau) return -1;

        const hop = Math.max(128, Math.floor(sr * 0.025)); // 25ms hop
        const f0s = [];

        for (let frameStart = startSample; frameStart + frameLen <= endSample; frameStart += hop) {
            // Energy gate: RMS < 0.003 → silence
            let sumSq = 0;
            for (let j = 0; j < frameLen; j += 2) sumSq += channelData[frameStart + j] ** 2;
            const rms = Math.sqrt(sumSq / (frameLen / 2));
            if (rms < 0.003) continue;

            // Step 1: Difference function d(tau)
            const d = new Float32Array(maxTau + 1);
            for (let tau = minTau; tau <= maxTau; tau++) {
                let s = 0;
                for (let j = 0; j < W; j++) {
                    const diff = channelData[frameStart + j] - channelData[frameStart + j + tau];
                    s += diff * diff;
                }
                d[tau] = s;
            }

            // Step 2: Cumulative mean normalized d'(tau)
            const dPrime = new Float32Array(maxTau + 1);
            dPrime[0] = 1.0;
            let runningSum = 0;
            for (let tau = 1; tau <= maxTau; tau++) {
                runningSum += d[tau];
                dPrime[tau] = runningSum > 0 ? (d[tau] * tau) / runningSum : 1.0;
            }

            // Step 3: Adaptive threshold dip detection (try 0.12 → 0.15 → 0.20)
            let tauChosen = -1;
            outer: for (const thresh of [0.12, 0.15, 0.20]) {
                for (let tau = minTau; tau < maxTau - 1; tau++) {
                    if (dPrime[tau] < thresh) {
                        while (tau + 1 < maxTau && dPrime[tau + 1] < dPrime[tau]) tau++;
                        tauChosen = tau;
                        break outer;
                    }
                }
            }

            if (tauChosen === -1) {
                let minVal = 999, minIdx = -1;
                for (let tau = minTau; tau < maxTau; tau++) {
                    if (dPrime[tau] < minVal) { minVal = dPrime[tau]; minIdx = tau; }
                }
                if (minVal <= 0.35) tauChosen = minIdx;
            }

            if (tauChosen <= 0) continue;

            // Step 4: Parabolic interpolation
            if (tauChosen > minTau && tauChosen < maxTau) {
                const s0 = dPrime[tauChosen - 1], s1 = dPrime[tauChosen], s2 = dPrime[tauChosen + 1];
                const denom = 2 * (s0 - 2 * s1 + s2);
                if (Math.abs(denom) > 1e-7) tauChosen += (s0 - s2) / denom;
            }

            const f0 = sr / tauChosen;
            if (f0 >= minF0 && f0 <= maxF0) f0s.push(f0);
        }

        if (f0s.length === 0) return -1;

        // Octave correction: fold values that are ~2x/0.5x of cluster median
        f0s.sort((a, b) => a - b);
        const rawMedian = f0s[Math.floor(f0s.length / 2)];
        const corrected = f0s.map(v => {
            if (rawMedian > 0 && v / rawMedian > 1.65) return v / 2;
            if (rawMedian > 0 && rawMedian / v > 1.65) return v * 2;
            return v;
        });

        // Trimmed mean: remove lowest/highest 20%
        corrected.sort((a, b) => a - b);
        const lo = Math.floor(corrected.length * 0.2);
        const hi = Math.ceil(corrected.length * 0.8);
        const trimmed = corrected.slice(lo, hi);

        if (trimmed.length === 0) return -1;
        return trimmed[Math.floor(trimmed.length / 2)];
    }

    async function detectGendersWebAudio() {
        if (!state.videoPath && (!videoPlayer || !videoPlayer.src)) {
            alert("សូមជ្រើសរើស ឬបញ្ចូលវីដេអូជាមុនសិន!");
            return;
        }
        if (!state.segments || state.segments.length === 0) {
            alert("មិនទាន់មានឃ្លា (Segments) សម្រាប់បែងចែកទេ។ សូមចុចចាប់យកស្គ្រីបជាមុនសិន!");
            return;
        }

        const btnToolbar = document.getElementById("btnAutoDetectGenders");
        const btnModalWeb = document.getElementById("btnModalWebAudioDetect");
        const origToolbarHtml = btnToolbar ? btnToolbar.innerHTML : "";
        const origWebHtml = btnModalWeb ? btnModalWeb.innerHTML : "";

        if (btnToolbar) {
            btnToolbar.innerHTML = "<span>⚡</span><span>Web Audio កំពុងវិភាគ F0...</span>";
            btnToolbar.disabled = true;
        }
        if (btnModalWeb) {
            btnModalWeb.innerHTML = "<span>⏳</span><span>Web Audio កំពុងគណនា F0 Pitch...</span>";
            btnModalWeb.disabled = true;
        }
        setStatus("🌐 Web Audio API កំពុងដំណើរការវិភាគរលកសំឡេង F0 Pitch លើ Browser ផ្ទាល់ (០.២ វិនាទី)...");

        try {
            const actor1 = document.getElementById("modalVoiceActor1") ? document.getElementById("modalVoiceActor1").value : (state.actor1Voice || "km-KH-PisethNeural");
            const actor2 = document.getElementById("modalVoiceActor2") ? document.getElementById("modalVoiceActor2").value : (state.actor2Voice || "km-KH-SreymomNeural");

            // 1. Get or decode AudioBuffer directly in browser
            let audioBuf = window.__vocalStudioAudioBuffer;
            if (!audioBuf) {
                let audioSourceUrl = null;
                if (state.videoPath) {
                    try {
                        const extRes = await fetch("/api/extract-original-audio", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ video_path: state.videoPath })
                        });
                        if (extRes.ok) {
                            const d = await extRes.json();
                            if (d && d.url) audioSourceUrl = d.url;
                        }
                    } catch (e) {
                        console.warn("Could not pre-extract audio via API, using video src:", e);
                    }
                }
                if (!audioSourceUrl && videoPlayer && videoPlayer.src) {
                    audioSourceUrl = videoPlayer.src;
                }
                if (!audioSourceUrl) {
                    throw new Error("មិនអាចទាញយកប្រភពសំឡេងវីដេអូបានទេ។");
                }

                setStatus("🌐 កំពុងទាញយកទិន្នន័យសំឡេងចូល Browser...");
                const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                const resp = await fetch(audioSourceUrl);
                if (!resp.ok) throw new Error("ទាញយកសំឡេងបរាជ័យ (HTTP " + resp.status + ")");
                const arrayBuffer = await resp.arrayBuffer();
                audioBuf = await audioCtx.decodeAudioData(arrayBuffer);
                window.__vocalStudioAudioBuffer = audioBuf;
            }

            const channelData = audioBuf.getChannelData(0);
            const sr = audioBuf.sampleRate;
            const totalSamples = channelData.length;

            // Semantic kinship keywords for Chinese short drama dialogue
            const maleKeywords = [
                "表舅","外甥","长顺","常旺","长兴","赵常旺","赵长顺",
                "老五","兄弟","老子","大爷","叔叔","叔","哥哥","大哥","二哥","老板",
                "爹","爸爸","爸","儿子","老公","丈夫","先生","少爷","侄子","老爷",
                "舅舅","姑父","表哥","表弟","兄","小伙子","男人","男的","他娘的",
                "老头","大叔","我哥","你哥","表兄","伯伯","伯父","孙子","外孙",
            ];
            const femaleKeywords = [
                "老婆","媳妇","嫂子","娘","妈妈","妈","妹妹","妹",
                "姑娘","小姐","民政局离婚","咱俩离婚","女儿","妻子",
                "太太","夫人","姐姐","姐","妹子","女人","女的",
                "婆婆","岳母","姑姑","姨妈","外婆","奶奶","孙女",
                "表妹","表姐","我媳妇","我老婆","女朋友","情人",
                "我妈","你妈","婆","嫂","姑","阿姨","大娘","大嫂",
            ];

            let prevVoice = actor1;
            let prevActor = "Actor 1";
            let prevEnd = 0.0;
            const GAP_RESET_SECONDS = 1.5;

            let maleCount = 0;
            let femaleCount = 0;

            const updatedSegments = state.segments.map(seg => {
                const newSeg = { ...seg };
                const start = parseFloat(newSeg.start || 0);
                const end = parseFloat(newSeg.end || 0);
                const text = (newSeg.original || "").trim();

                const gap = start - prevEnd;
                let fallbackV = (gap > GAP_RESET_SECONDS) ? actor1 : prevVoice;
                let fallbackA = (gap > GAP_RESET_SECONDS) ? "Actor 1" : prevActor;

                let chosenVoice = fallbackV;
                let chosenActor = fallbackA;

                // Step A: Keyword heuristics
                let matched = false;
                if (text) {
                    if (maleKeywords.some(k => text.includes(k))) {
                        chosenVoice = actor1;
                        chosenActor = "Actor 1";
                        matched = true;
                    } else if (femaleKeywords.some(k => text.includes(k))) {
                        chosenVoice = actor2;
                        chosenActor = "Actor 2";
                        matched = true;
                    }
                }

                // Step B: YIN F0 Pitch analysis if not keyword-matched
                if (!matched && end > start && totalSamples > 0) {
                    const startSample = Math.max(0, Math.floor(start * sr));
                    const endSample = Math.min(totalSamples, Math.ceil(end * sr));

                    if (endSample - startSample > 512) {
                        const f0 = estimateSegmentPitchYIN(channelData, startSample, endSample, sr);
                        if (f0 > 0) {
                            // Threshold: 180 Hz — same as server-side whisper_service.py
                            // Male Chinese speech F0: 85–165 Hz (excited up to ~175 Hz after octave correction)
                            // Female Chinese speech F0: 180–380 Hz
                            if (f0 >= 180.0) {
                                chosenVoice = actor2;
                                chosenActor = "Actor 2";
                            } else {
                                chosenVoice = actor1;
                                chosenActor = "Actor 1";
                            }
                        }
                        // Debug: uncomment to inspect in browser console
                        // console.log(`seg ${newSeg.id} [${start.toFixed(2)}-${end.toFixed(2)}s] f0=${f0.toFixed(1)}Hz → ${chosenActor}`);
                    }
                }

                newSeg.voice = chosenVoice;
                newSeg.actor = chosenActor;

                prevVoice = chosenVoice;
                prevActor = chosenActor;
                prevEnd = end;

                if (chosenActor === "Actor 2" || (chosenVoice && chosenVoice.includes("Sreymom"))) {
                    femaleCount++;
                } else {
                    maleCount++;
                }

                return newSeg;
            });

            state.segments = updatedSegments;
            clearAudioCache();
            renderTable();
            timeline.renderSegments(state.segments);

            // Auto-save project
            if (state.videoPath) {
                try {
                    fetch("/api/save-project", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            video_path: state.videoPath,
                            segments: state.segments
                        })
                    });
                } catch (se) {}
            }

            closeModal("assignVoiceModal");
            const msg = `🎉 បានបែងចែកសំឡេងតាម Web Audio API (រត់លើ Browser ក្នុង ០.២ វិនាទី)!\n👨 ប្រុស (Actor 1 / Piseth): ${maleCount} ឃ្លា\n👩 ស្រី (Actor 2 / Sreymom): ${femaleCount} ឃ្លា`;
            setStatus(msg.replace(/\n/g, " | "));
            alert(msg);

        } catch (err) {
            console.warn("Web Audio pitch detection error, falling back to server acoustic:", err);
            setStatus("⚠️ Web Audio API ជួបបញ្ហា កំពុងប្តូរទៅប្រើ Server Acoustic Pitch...");
            return autoDetectGenders("acoustic");
        } finally {
            if (btnToolbar) {
                btnToolbar.innerHTML = origToolbarHtml;
                btnToolbar.disabled = false;
            }
            if (btnModalWeb) {
                btnModalWeb.innerHTML = origWebHtml;
                btnModalWeb.disabled = false;
            }
        }
    }

    const btnAutoDetectGenders = document.getElementById("btnAutoDetectGenders");
    if (btnAutoDetectGenders) {
        btnAutoDetectGenders.addEventListener("click", () => {
            if (state.videoPath) {
                autoDetectGenders("gemini");
            } else {
                detectGendersWebAudio();
            }
        });
    }
    const btnModalWebAudioDetect = document.getElementById("btnModalWebAudioDetect");
    if (btnModalWebAudioDetect) {
        btnModalWebAudioDetect.addEventListener("click", () => detectGendersWebAudio());
    }
    const btnModalDetectGemini = document.getElementById("btnModalDetectGemini");
    if (btnModalDetectGemini) {
        btnModalDetectGemini.addEventListener("click", () => autoDetectGenders("gemini"));
    }
    const btnModalAutoDetectGender = document.getElementById("btnModalAutoDetectGender");
    if (btnModalAutoDetectGender) {
        btnModalAutoDetectGender.addEventListener("click", () => autoDetectGenders("acoustic"));
    }

    // BGM Modal
    document.getElementById("btnBgmModal").addEventListener("click", () => openModal("bgmModal"));
    const btnSelectBgm = document.getElementById("btnSelectBgm");
    const bgmFileInput = document.getElementById("bgmFileInput");
    const bgmFileName = document.getElementById("bgmFileName");
    const btnExtractOriginalMp3 = document.getElementById("btnExtractOriginalMp3");

    if (btnExtractOriginalMp3) {
        btnExtractOriginalMp3.addEventListener("click", async () => {
            if (!state.videoPath) {
                alert("សូមបញ្ចូលវីដេអូជាមុនសិន!");
                return;
            }
            btnExtractOriginalMp3.innerText = "⏳ កំពុងទាញយក MP3...";
            try {
                const res = await fetch("/api/extract-original-audio", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ video_path: state.videoPath })
                });
                const d = await res.json();
                if (res.ok && d.url) {
                    const a = document.createElement("a");
                    a.href = d.url;
                    a.download = d.filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    btnExtractOriginalMp3.innerText = "✅ បានទាញយក MP3 រួចរាល់!";
                    setTimeout(() => {
                        btnExtractOriginalMp3.innerHTML = "<span>⬇️</span> <span>ទាញយកសំឡេងវីដេអូដើមជា MP3 (Extract Audio)</span>";
                    }, 3000);
                    setStatus(`🎵 បានទាញយកហ្វាយសំឡេង ${d.filename} ដោយជោគជ័យ! អ្នកអាចយកទៅបំបែកលើ vocalremover.org បានភ្លាមៗ`);
                } else {
                    alert("មិនអាចទាញយកសំឡេងបានទេ៖ " + (d.detail || "Error"));
                    btnExtractOriginalMp3.innerHTML = "<span>⬇️</span> <span>ទាញយកសំឡេងវីដេអូដើមជា MP3 (Extract Audio)</span>";
                }
            } catch (e) {
                alert("កំហុសក្នុងការទាញយកសំឡេង");
                btnExtractOriginalMp3.innerHTML = "<span>⬇️</span> <span>ទាញយកសំឡេងវីដេអូដើមជា MP3 (Extract Audio)</span>";
            }
        });
    }

    btnSelectBgm.addEventListener("click", () => bgmFileInput.click());
    bgmFileInput.addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        bgmFileName.innerText = `កំពុង Upload: ${file.name}...`;
        const formData = new FormData();
        formData.append("file", file);

        try {
            const res = await fetch("/api/upload-bgm", { method: "POST", body: formData });
            const data = await res.json();
            if (res.ok) {
                state.bgmPath = data.bgm_path;
                bgmFileName.innerText = `✅ បានជ្រើស៖ ${file.name}`;
                if (bgmAudioPlayer) {
                    bgmAudioPlayer.src = data.url;
                }
                updateBgmUI(true);
            }
        } catch (err) {
            bgmFileName.innerText = "❌ Upload BGM បរាជ័យ";
        }
    });

    const bgmVolumeSlider = document.getElementById("bgmVolume");
    if (bgmVolumeSlider) {
        bgmVolumeSlider.value = "60";
        bgmVolumeSlider.addEventListener("input", () => {
            state.bgmVolume = parseInt(bgmVolumeSlider.value) / 100;
            const valEl = document.getElementById("bgmVolumeVal");
            if (valEl) valEl.innerText = `${bgmVolumeSlider.value}%`;
            if (bgmAudioPlayer) {
                bgmAudioPlayer.volume = state.bgmVolume;
            }
        });
    }

    const origAudioVolumeSlider = document.getElementById("origAudioVolume");
    origAudioVolumeSlider.addEventListener("input", () => {
        state.origVolume = parseInt(origAudioVolumeSlider.value) / 100;
        document.getElementById("origAudioVolumeVal").innerText = `${origAudioVolumeSlider.value}%`;
    });

    // Watermark & Multi-Logo Modal & Draggable Overlays
    document.getElementById("btnWatermarkModal").addEventListener("click", () => {
        renderModalLogosList();
        openModal("watermarkModal");
    });
    const watermarkInput = document.getElementById("watermarkInput");
    const chkShowWatermark = document.getElementById("chkShowWatermark");
    const chkBurnSubtitles = document.getElementById("chkBurnSubtitles");
    const logosContainer = document.getElementById("logosContainer");
    const logosList = document.getElementById("logosList");
    const btnAddLogo = document.getElementById("btnAddLogo");
    const inputLogoFile = document.getElementById("inputLogoFile");

    // Render draggable logos on top of video
    function renderVideoLogos() {
        if (!logosContainer) return;
        logosContainer.innerHTML = "";

        // If player is currently showing an exported video, restore clean original editing video
        if (videoPlayer && videoPlayer.src && videoPlayer.src.includes("/outputs/")) {
            const cleanSource = (state.useProxy && state.proxyUrl) ? state.proxyUrl : state.videoUrl;
            if (cleanSource) {
                videoPlayer.src = cleanSource;
                videoPlayer.load();
            }
        }

        state.logos.forEach((logo) => {
            const el = document.createElement("div");
            el.className = "logo-item-overlay";
            el.dataset.id = logo.id;

            // Dimensions and position relative to video container
            const scalePct = Math.round((logo.scale || 0.15) * 100);
            el.style.width = `${scalePct}%`;
            el.style.maxWidth = "240px";
            el.style.minWidth = "35px";

            // Default position if not set
            if (logo.x === undefined || logo.y === undefined) {
                // If top-right default
                el.style.top = "12px";
                el.style.right = "12px";
                el.style.left = "auto";
                el.style.bottom = "auto";
            } else {
                el.style.left = `${(logo.x * 100).toFixed(2)}%`;
                el.style.top = `${(logo.y * 100).toFixed(2)}%`;
                el.style.right = "auto";
                el.style.bottom = "auto";
            }

            const img = document.createElement("img");
            img.src = logo.url;
            img.alt = logo.name || "Logo";

            // Quick delete badge on hover
            const delBtn = document.createElement("div");
            delBtn.className = "logo-del-btn";
            delBtn.innerText = "×";
            delBtn.title = "លុប Logo នេះ";
            delBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                removeLogo(logo.id);
            });

            el.appendChild(img);
            el.appendChild(delBtn);

            // Drag and drop setup
            makeDraggable(el, logo);

            logosContainer.appendChild(el);
        });
    }

    // Draggable function with smooth pointer events (mouse & touch)
    function makeDraggable(el, logoObj) {
        let isDragging = false;
        let startPointerX = 0;
        let startPointerY = 0;
        let initialLeft = 0;
        let initialTop = 0;
        const container = videoFrame;

        el.addEventListener("pointerdown", (e) => {
            // Ignore click on delete button
            if (e.target.classList.contains("logo-del-btn")) return;
            e.preventDefault();
            e.stopPropagation();

            isDragging = true;
            el.classList.add("dragging");
            try { el.setPointerCapture(e.pointerId); } catch (_) {}

            startPointerX = e.clientX;
            startPointerY = e.clientY;
            initialLeft = el.offsetLeft;
            initialTop = el.offsetTop;
        });

        window.addEventListener("pointermove", (e) => {
            if (!isDragging) return;
            if (e.cancelable) e.preventDefault();

            const dx = e.clientX - startPointerX;
            const dy = e.clientY - startPointerY;

            let newLeft = initialLeft + dx;
            let newTop = initialTop + dy;

            // Boundaries relative to videoFrame
            const maxLeft = container.clientWidth - el.clientWidth;
            const maxTop = container.clientHeight - el.clientHeight;

            if (newLeft < 0) newLeft = 0;
            if (newLeft > maxLeft) newLeft = maxLeft;
            if (newTop < 0) newTop = 0;
            if (newTop > maxTop) newTop = maxTop;

            el.style.left = `${newLeft}px`;
            el.style.top = `${newTop}px`;
            el.style.right = "auto";
            el.style.bottom = "auto";

            // Save responsive percentage
            if (container.clientWidth > 0 && container.clientHeight > 0) {
                logoObj.x = newLeft / container.clientWidth;
                logoObj.y = newTop / container.clientHeight;
            }
        }, { passive: false });

        window.addEventListener("pointerup", (e) => {
            if (!isDragging) return;
            isDragging = false;
            el.classList.remove("dragging");
            try { el.releasePointerCapture(e.pointerId); } catch (_) {}

            // Finalize percentage position
            if (container.clientWidth > 0 && container.clientHeight > 0) {
                logoObj.x = el.offsetLeft / container.clientWidth;
                logoObj.y = el.offsetTop / container.clientHeight;
                el.style.left = `${(logoObj.x * 100).toFixed(2)}%`;
                el.style.top = `${(logoObj.y * 100).toFixed(2)}%`;
            }
        });

        window.addEventListener("pointercancel", (e) => {
            if (!isDragging) return;
            isDragging = false;
            el.classList.remove("dragging");
            try { el.releasePointerCapture(e.pointerId); } catch (_) {}
        });
    }

    // Render list inside modal
    function renderModalLogosList() {
        if (!logosList) return;
        logosList.innerHTML = "";

        if (state.logos.length === 0) {
            logosList.innerHTML = `
                <div id="noLogosMsg" style="text-align: center; color: #64748b; font-size: 12px; padding: 14px 0;">
                    មិនទាន់មាន Logo ទេ សូមចុច <strong>"+ បន្ថែម Logo"</strong>
                </div>
            `;
            return;
        }

        state.logos.forEach((logo, index) => {
            const row = document.createElement("div");
            row.className = "modal-logo-row";

            const scalePct = Math.round((logo.scale || 0.15) * 100);

            row.innerHTML = `
                <div class="modal-logo-thumb">
                    <img src="${logo.url}" alt="Logo">
                </div>
                <div style="flex: 1; min-width: 0;">
                    <div style="font-size: 12px; font-weight: 600; color: #e2e8f0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                        Logo #${index + 1} (${logo.name || "រូបភាព"})
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                        <span style="font-size: 11px; color: #94a3b8;">ទំហំ:</span>
                        <input type="range" class="logo-scale-slider" min="5" max="40" value="${scalePct}" style="flex: 1; height: 4px;">
                        <span class="logo-scale-val" style="font-size: 11px; color: #38bdf8; min-width: 32px;">${scalePct}%</span>
                    </div>
                </div>
                <button type="button" class="btn-mini btn-del-logo-row" style="background: #ef4444; color: white; border: none; padding: 4px 8px; font-size: 11px; border-radius: 4px; cursor: pointer;">
                    🗑️
                </button>
            `;

            const slider = row.querySelector(".logo-scale-slider");
            const valSpan = row.querySelector(".logo-scale-val");
            slider.addEventListener("input", () => {
                const val = parseInt(slider.value, 10);
                logo.scale = val / 100.0;
                valSpan.innerText = `${val}%`;
                renderVideoLogos();
            });

            row.querySelector(".btn-del-logo-row").addEventListener("click", () => {
                removeLogo(logo.id);
            });

            logosList.appendChild(row);
        });
    }

    function removeLogo(id) {
        state.logos = state.logos.filter(l => l.id !== id);
        renderVideoLogos();
        renderModalLogosList();
        setStatus("🗑️ បានដកចេញ Logo");
    }

    if (btnAddLogo && inputLogoFile) {
        btnAddLogo.addEventListener("click", () => {
            inputLogoFile.value = "";
            inputLogoFile.click();
        });

        inputLogoFile.addEventListener("change", async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const tempId = "lg_" + Date.now();
            const tempUrl = URL.createObjectURL(file);

            // Add to state immediately
            const newLogo = {
                id: tempId,
                path: null,
                url: tempUrl,
                name: file.name,
                scale: 0.15,
                x: 0.80, // Default near top-right
                y: 0.05
            };

            state.logos.push(newLogo);
            renderVideoLogos();
            renderModalLogosList();
            setStatus("កំពុង Upload Logo ទៅកាន់ Server...");

            const formData = new FormData();
            formData.append("file", file);

            try {
                const res = await fetch("/api/upload-logo", {
                    method: "POST",
                    body: formData
                });
                const data = await res.json();
                if (res.ok && data.logo_path) {
                    newLogo.path = data.logo_path;
                    newLogo.url = data.url;
                    renderVideoLogos();
                    renderModalLogosList();
                    setStatus("✅ បានបន្ថែម Logo ជោគជ័យ! អ្នកអាចទាញផ្លាស់ទីនៅលើវីដេអូបាន។");
                } else {
                    alert("Upload logo error: " + (data.detail || "បរាជ័យ"));
                    removeLogo(tempId);
                }
            } catch (err) {
                console.error("Logo upload failed:", err);
                removeLogo(tempId);
            }
        });
    }

    // Watermark Configuration (Controlled inside Logo & Watermark Modal)
    const wmModalSizeBadge = document.getElementById("wmModalSizeBadge");
    const wmModalSlider = document.getElementById("wmModalSlider");
    const btnModalWmDec = document.getElementById("btnModalWmDec");
    const btnModalWmInc = document.getElementById("btnModalWmInc");

    function updateWatermarkSettings() {
        let txt = (state.watermarkText || "").trim();
        if (!txt || txt === "សម្រាយរឿង" || txt === "សម្រាយរឿង HD") {
            txt = "សម្រាយរឿងHD";
            state.watermarkText = txt;
        }

        if (watermarkInput && watermarkInput.value !== txt) {
            watermarkInput.value = txt;
        }

        const sz = state.watermarkFontSize || 56;
        if (wmModalSizeBadge) wmModalSizeBadge.innerText = `${sz}px`;
        if (wmModalSlider) wmModalSlider.value = sz;

        // Ensure no overlay is displayed over the video screen
        const wmEl = document.getElementById("watermarkPreview");
        if (wmEl) wmEl.style.display = "none";
    }

    function setWatermarkFontSize(deltaOrVal, isDelta = false) {
        let cur = state.watermarkFontSize || 56;
        let next = isDelta ? cur + deltaOrVal : parseInt(deltaOrVal);
        next = Math.max(24, Math.min(110, next));
        state.watermarkFontSize = next;
        try { localStorage.setItem("vocal_studio_wm_fontsize", next.toString()); } catch (_) {}
        updateWatermarkSettings();
    }

    if (btnModalWmDec) btnModalWmDec.addEventListener("click", () => setWatermarkFontSize(-4, true));
    if (btnModalWmInc) btnModalWmInc.addEventListener("click", () => setWatermarkFontSize(4, true));
    if (wmModalSlider) wmModalSlider.addEventListener("input", () => setWatermarkFontSize(wmModalSlider.value, false));

    if (watermarkInput) {
        watermarkInput.addEventListener("input", () => {
            state.watermarkText = watermarkInput.value;
            updateWatermarkSettings();
        });
    }

    if (chkShowWatermark) {
        chkShowWatermark.addEventListener("change", () => {
            state.showWatermark = chkShowWatermark.checked;
            updateWatermarkSettings();
        });
    }

    // Initialize clean watermark settings
    updateWatermarkSettings();

    chkBurnSubtitles.addEventListener("change", () => {
        state.burnSubtitles = chkBurnSubtitles.checked;
    });

    // ─── Thumbnail & Movie Title Cover System ──────────────────────────────────
    function initThumbnailSystem() {
        const btnThumbnailModal = document.getElementById("btnThumbnailModal");
        const btnQuickThumbnail = document.getElementById("btnQuickThumbnail");
        const btnBottomThumbnail = document.getElementById("btnBottomThumbnail");
        const thumbCanvas = document.getElementById("thumbnailCanvas");
        const thumbAspectBadge = document.getElementById("thumbAspectBadge");
        const btnCaptureCurrentFrame = document.getElementById("btnCaptureCurrentFrame");
        const btnUploadThumbImage = document.getElementById("btnUploadThumbImage");
        const inputThumbnailFile = document.getElementById("inputThumbnailFile");
        const thumbTitleInput = document.getElementById("thumbTitleInput");
        const thumbTitleFontSelect = document.getElementById("thumbTitleFontSelect");
        const thumbSubInput = document.getElementById("thumbSubInput");
        const thumbSubFontSelect = document.getElementById("thumbSubFontSelect");
        const thumbSubFontSizeSlider = document.getElementById("thumbSubFontSizeSlider");
        const thumbSubFontSizeVal = document.getElementById("thumbSubFontSizeVal");
        const thumbSubColorPicker = document.getElementById("thumbSubColorPicker");
        const thumbSubColorBtns = document.querySelectorAll(".thumb-subcolor-btn");
        const thumbFontSizeSlider = document.getElementById("thumbFontSizeSlider");
        const thumbFontSizeVal = document.getElementById("thumbFontSizeVal");
        const thumbColorPicker = document.getElementById("thumbColorPicker");
        const thumbColorBtns = document.querySelectorAll(".thumb-color-btn");
        const thumbPosPresets = document.querySelectorAll(".thumb-pos-preset");
        const thumbPosYSlider = document.getElementById("thumbPosYSlider");
        const thumbPosVal = document.getElementById("thumbPosVal");
        const thumbBoxStyle = document.getElementById("thumbBoxStyle");
        const chkInsertCoverVideo = document.getElementById("chkInsertCoverVideo");
        const thumbCoverDuration = document.getElementById("thumbCoverDuration");
        const btnDownloadThumbnail = document.getElementById("btnDownloadThumbnail");
        const btnSaveThumbnail = document.getElementById("btnSaveThumbnail");

        if (!thumbCanvas) return;
        const ctx = thumbCanvas.getContext("2d");

        // Helper to resolve font family with robust fallbacks
        function getKhmerFontFamily(fontName) {
            switch (fontName) {
                case "Moul":
                    return '"Moul", "Khmer OS Muol", "Khmer OS Muol Light", cursive, sans-serif';
                case "Koulen":
                    return '"Koulen", "Khmer OS", sans-serif';
                case "Battambang":
                    return '"Battambang", "Khmer OS Battambang", sans-serif';
                case "Dangrek":
                    return '"Dangrek", cursive, sans-serif';
                case "Bayon":
                    return '"Bayon", cursive, sans-serif';
                case "Fasthand":
                    return '"Fasthand", cursive, sans-serif';
                case "Siemreap":
                    return '"Siemreap", "Khmer OS Siemreap", sans-serif';
                case "Noto Serif Khmer":
                    return '"Noto Serif Khmer", "Khmer OS", serif';
                case "Bokor":
                    return '"Bokor", cursive, sans-serif';
                case "Kantumruy Pro":
                default:
                    return '"Kantumruy Pro", "Noto Sans Khmer", "Khmer OS", sans-serif';
            }
        }

        // Dragging & Interaction State
        let isDraggingTitle = false;
        let dragStartY = 0;
        let dragStartPercent = 48;
        let lastTitleBox = { top: 0, bottom: 0, height: 0, centerY: 0 };
        let isHoveringTitle = false;

        // Helper to grab current video frame
        function captureVideoFrame() {
            if (!videoPlayer || videoPlayer.readyState < 2 || !videoPlayer.videoWidth) {
                return false;
            }
            try {
                const offscreen = document.createElement("canvas");
                offscreen.width = videoPlayer.videoWidth;
                offscreen.height = videoPlayer.videoHeight;
                const oCtx = offscreen.getContext("2d");
                oCtx.drawImage(videoPlayer, 0, 0, offscreen.width, offscreen.height);
                const frameImg = new Image();
                frameImg.onload = () => {
                    state.thumbnail.bgImage = frameImg;
                    renderThumbnailCanvas();
                };
                frameImg.src = offscreen.toDataURL("image/jpeg", 0.95);
                return true;
            } catch (err) {
                console.warn("Could not capture video frame:", err);
                return false;
            }
        }

        function renderThumbnailCanvas() {
            if (!thumbCanvas || !ctx) return;

            // Determine dimensions: default 9:16 (1080x1920) for short drama, or 16:9 (1920x1080)
            let width = 1080;
            let height = 1920;
            let aspectLabel = "9:16 (TikTok/Reels)";

            if (state.aspectRatio === "16:9" || (videoPlayer && videoPlayer.videoWidth > videoPlayer.videoHeight && state.aspectRatio !== "9:16")) {
                width = 1920;
                height = 1080;
                aspectLabel = "16:9 (YouTube)";
            } else if (state.aspectRatio === "1:1") {
                width = 1080;
                height = 1080;
                aspectLabel = "1:1 (Square)";
            }

            if (thumbAspectBadge) thumbAspectBadge.innerText = aspectLabel;
            if (thumbCanvas.width !== width || thumbCanvas.height !== height) {
                thumbCanvas.width = width;
                thumbCanvas.height = height;
            }

            // 1. Clear background
            ctx.clearRect(0, 0, width, height);

            // 2. Draw background image / captured frame
            if (state.thumbnail.bgImage && state.thumbnail.bgImage.complete) {
                const img = state.thumbnail.bgImage;
                const imgAspect = img.width / img.height;
                const canAspect = width / height;
                let drawW, drawH, drawX, drawY;
                if (imgAspect > canAspect) {
                    drawH = height;
                    drawW = height * imgAspect;
                    drawX = (width - drawW) / 2;
                    drawY = 0;
                } else {
                    drawW = width;
                    drawH = width / imgAspect;
                    drawX = 0;
                    drawY = (height - drawH) / 2;
                }
                ctx.drawImage(img, drawX, drawY, drawW, drawH);
            } else if (videoPlayer && videoPlayer.readyState >= 2 && videoPlayer.videoWidth > 0) {
                ctx.drawImage(videoPlayer, 0, 0, width, height);
            } else {
                // Attractive dark cinema gradient
                const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
                bgGrad.addColorStop(0, "#0f172a");
                bgGrad.addColorStop(0.5, "#1e1b4b");
                bgGrad.addColorStop(1, "#020617");
                ctx.fillStyle = bgGrad;
                ctx.fillRect(0, 0, width, height);

                // Subtle grid
                ctx.strokeStyle = "rgba(255,255,255,0.04)";
                ctx.lineWidth = 1;
                for (let x = 0; x < width; x += 80) {
                    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
                }
                for (let y = 0; y < height; y += 80) {
                    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
                }
            }

            // 3. Vignette gradient for cinematic contrast
            const vignette = ctx.createLinearGradient(0, 0, 0, height);
            vignette.addColorStop(0, "rgba(0, 0, 0, 0.55)");
            vignette.addColorStop(0.20, "rgba(0, 0, 0, 0.0)");
            vignette.addColorStop(0.70, "rgba(0, 0, 0, 0.0)");
            vignette.addColorStop(1, "rgba(0, 0, 0, 0.85)");
            ctx.fillStyle = vignette;
            ctx.fillRect(0, 0, width, height);

            // 4. Texts & Fonts setup
            const titleRaw = (thumbTitleInput ? thumbTitleInput.value : state.thumbnail.title) || "មហាសេដ្ឋីក្លែងខ្លួនជាអ្នកសុំទាន";
            const subRaw = (thumbSubInput ? thumbSubInput.value : state.thumbnail.subtitle) || "";
            const rawFontSize = parseInt(thumbFontSizeSlider ? thumbFontSizeSlider.value : state.thumbnail.fontSize) || 64;
            const fontScale = width / 720;
            const titleFontSize = Math.round(rawFontSize * fontScale);
            const titleColor = state.thumbnail.textColor || "#fbbf24";
            const titleFont = state.thumbnail.titleFont || (thumbTitleFontSelect ? thumbTitleFontSelect.value : "Moul");
            const titleFontFamily = getKhmerFontFamily(titleFont);

            const rawSubFontSize = parseInt(thumbSubFontSizeSlider ? thumbSubFontSizeSlider.value : (state.thumbnail.subFontSize || 32)) || 32;
            const subFontSize = Math.round(rawSubFontSize * fontScale);
            const subColor = state.thumbnail.subColor || "#ffffff";
            const subFont = state.thumbnail.subFont || (thumbSubFontSelect ? thumbSubFontSelect.value : "Kantumruy Pro");
            const subFontFamily = getKhmerFontFamily(subFont);

            const boxStyle = (thumbBoxStyle ? thumbBoxStyle.value : state.thumbnail.boxStyle) || "ribbon";
            const yPct = parseInt(thumbPosYSlider ? thumbPosYSlider.value : state.thumbnail.yPercent) || 48;

            const lines = titleRaw.split("\n").map(l => l.trim()).filter(l => l.length > 0);
            if (lines.length === 0) lines.push("ចំណងជើងរឿងសម្រាយ");

            const lineHeight = Math.round(titleFontSize * 1.35);
            const totalTextHeight = lines.length * lineHeight;
            const centerY = Math.round(height * (yPct / 100));
            const startY = Math.round(centerY - (totalTextHeight / 2) + (lineHeight / 2));

            const subGap = Math.round(titleFontSize * 0.22);
            const subLineHeight = Math.round(subFontSize * 1.35);
            const extraSubH = subRaw ? (subGap + subLineHeight) : 0;

            // Ribbon or background box behind text
            if (boxStyle === "ribbon") {
                const padY = Math.round(titleFontSize * 0.45);
                const rY = startY - (lineHeight / 2) - padY;
                const rH = totalTextHeight + (padY * 2) + extraSubH;

                ctx.fillStyle = "rgba(0, 0, 0, 0.80)";
                ctx.fillRect(0, rY, width, rH);

                // Golden accent borders
                ctx.fillStyle = "rgba(245, 158, 11, 0.75)";
                ctx.fillRect(0, rY, width, Math.max(3, Math.round(4 * fontScale)));
                ctx.fillRect(0, rY + rH - Math.max(3, Math.round(4 * fontScale)), width, Math.max(3, Math.round(4 * fontScale)));
            } else if (boxStyle === "gradient") {
                const padY = Math.round(titleFontSize * 0.6);
                const rY = startY - (lineHeight / 2) - padY;
                const rH = totalTextHeight + (padY * 2) + extraSubH;

                const radGrad = ctx.createLinearGradient(0, rY, 0, rY + rH);
                radGrad.addColorStop(0, "rgba(0, 0, 0, 0.0)");
                radGrad.addColorStop(0.2, "rgba(0, 0, 0, 0.78)");
                radGrad.addColorStop(0.8, "rgba(0, 0, 0, 0.78)");
                radGrad.addColorStop(1, "rgba(0, 0, 0, 0.0)");
                ctx.fillStyle = radGrad;
                ctx.fillRect(0, rY, width, rH);
            }

            // Draw Title Lines
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.font = `bold ${titleFontSize}px ${titleFontFamily}`;

            const outlineWidth = Math.max(6, Math.round(titleFontSize * 0.16));
            lines.forEach((line, idx) => {
                const lineY = startY + (idx * lineHeight);
                ctx.strokeStyle = "#000000";
                ctx.lineWidth = outlineWidth;
                ctx.lineJoin = "round";
                ctx.miterLimit = 2;
                ctx.shadowColor = "rgba(0,0,0,0.95)";
                ctx.shadowBlur = Math.round(14 * fontScale);
                ctx.strokeText(line, width / 2, lineY);

                ctx.fillStyle = titleColor;
                ctx.shadowColor = "transparent";
                ctx.fillText(line, width / 2, lineY);
            });

            // Draw Subtitle / Tagline
            if (subRaw) {
                const subY = startY + (lines.length * lineHeight) + subGap + (subLineHeight / 2);
                ctx.font = `bold ${subFontSize}px ${subFontFamily}`;

                ctx.strokeStyle = "#000000";
                ctx.lineWidth = Math.max(4, Math.round(subFontSize * 0.16));
                ctx.lineJoin = "round";
                ctx.miterLimit = 2;
                ctx.shadowColor = "rgba(0,0,0,0.95)";
                ctx.shadowBlur = Math.round(10 * fontScale);
                ctx.strokeText(subRaw, width / 2, subY);

                ctx.fillStyle = subColor;
                ctx.shadowColor = "transparent";
                ctx.fillText(subRaw, width / 2, subY);
            }

            // Studio Top Badge
            const badgeW = Math.round(240 * fontScale);
            const badgeH = Math.round(46 * fontScale);
            const badgeX = Math.round(36 * fontScale);
            const badgeY = Math.round(48 * fontScale);

            ctx.fillStyle = "rgba(220, 38, 38, 0.88)";
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(badgeX, badgeY, badgeW, badgeH, Math.round(8 * fontScale));
            } else {
                ctx.rect(badgeX, badgeY, badgeW, badgeH);
            }
            ctx.fill();

            ctx.font = `bold ${Math.round(20 * fontScale)}px "Kantumruy Pro", sans-serif`;
            ctx.fillStyle = "#ffffff";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("សម្រាយរឿង HD 1080P", badgeX + (badgeW / 2), badgeY + (badgeH / 2));

            // Record bounding box for interactive mouse drag
            const boxTop = startY - (lineHeight / 2) - Math.round(titleFontSize * 0.45);
            const boxBottom = startY + (lines.length * lineHeight) + extraSubH;
            lastTitleBox = {
                top: boxTop,
                bottom: boxBottom,
                centerY: centerY,
                height: boxBottom - boxTop
            };

            // If user is currently dragging or hovering, draw an intuitive guideline & drag handle pill
            if (isDraggingTitle || isHoveringTitle) {
                ctx.save();
                ctx.strokeStyle = isDraggingTitle ? "#38bdf8" : "rgba(129, 140, 248, 0.75)";
                ctx.lineWidth = Math.max(2, Math.round(3 * fontScale));
                ctx.setLineDash([Math.round(8 * fontScale), Math.round(6 * fontScale)]);
                ctx.strokeRect(
                    Math.round(16 * fontScale),
                    boxTop - Math.round(6 * fontScale),
                    width - Math.round(32 * fontScale),
                    (boxBottom - boxTop) + Math.round(12 * fontScale)
                );
                ctx.setLineDash([]);

                // Floating Drag Pill Indicator
                const pillW = Math.round(340 * fontScale);
                const pillH = Math.round(44 * fontScale);
                const pillX = (width - pillW) / 2;
                const pillY = boxTop - pillH - Math.round(14 * fontScale);

                ctx.fillStyle = isDraggingTitle ? "rgba(14, 165, 233, 0.95)" : "rgba(30, 27, 75, 0.90)";
                ctx.beginPath();
                if (ctx.roundRect) {
                    ctx.roundRect(pillX, Math.max(badgeY + badgeH + 10, pillY), pillW, pillH, Math.round(22 * fontScale));
                } else {
                    ctx.rect(pillX, Math.max(badgeY + badgeH + 10, pillY), pillW, pillH);
                }
                ctx.fill();
                ctx.strokeStyle = "#ffffff";
                ctx.lineWidth = Math.max(1, Math.round(1.5 * fontScale));
                ctx.stroke();

                ctx.font = `bold ${Math.round(18 * fontScale)}px "Kantumruy Pro", sans-serif`;
                ctx.fillStyle = "#ffffff";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(
                    isDraggingTitle ? `↕ កំពុងទាញទីតាំង៖ ${yPct}%` : `↕ ចុចចាប់ទាញ (Drag) ដើម្បីរំកិល`,
                    width / 2,
                    Math.max(badgeY + badgeH + 10, pillY) + (pillH / 2)
                );
                ctx.restore();
            }
        }

        const openThumbModal = () => {
            if (!state.thumbnail.bgImage) {
                captureVideoFrame();
            }
            if (thumbTitleInput) thumbTitleInput.value = state.thumbnail.title || "";
            if (thumbTitleFontSelect) thumbTitleFontSelect.value = state.thumbnail.titleFont || "Moul";
            if (thumbSubInput) thumbSubInput.value = state.thumbnail.subtitle || "";
            if (thumbSubFontSelect) thumbSubFontSelect.value = state.thumbnail.subFont || "Kantumruy Pro";
            if (thumbSubFontSizeSlider) {
                thumbSubFontSizeSlider.value = state.thumbnail.subFontSize || 32;
                if (thumbSubFontSizeVal) thumbSubFontSizeVal.innerText = `${thumbSubFontSizeSlider.value}px`;
            }
            if (thumbSubColorPicker) thumbSubColorPicker.value = state.thumbnail.subColor || "#ffffff";
            thumbSubColorBtns.forEach(btn => {
                if (btn.dataset.color.toLowerCase() === (state.thumbnail.subColor || "#ffffff").toLowerCase()) {
                    btn.classList.add("active");
                } else {
                    btn.classList.remove("active");
                }
            });

            if (thumbFontSizeSlider) {
                thumbFontSizeSlider.value = state.thumbnail.fontSize || 64;
                if (thumbFontSizeVal) thumbFontSizeVal.innerText = `${thumbFontSizeSlider.value}px`;
            }
            if (thumbPosYSlider) {
                thumbPosYSlider.value = state.thumbnail.yPercent || 48;
                if (thumbPosVal) thumbPosVal.innerText = `${thumbPosYSlider.value}%`;
            }
            if (thumbBoxStyle) thumbBoxStyle.value = state.thumbnail.boxStyle || "ribbon";
            if (chkInsertCoverVideo) chkInsertCoverVideo.checked = state.thumbnail.insertAsCover;
            if (thumbCoverDuration) thumbCoverDuration.value = String(state.thumbnail.coverDuration || 0.8);

            thumbColorBtns.forEach(btn => {
                if (btn.dataset.color.toLowerCase() === (state.thumbnail.textColor || "#fbbf24").toLowerCase()) {
                    btn.classList.add("active");
                } else {
                    btn.classList.remove("active");
                }
            });

            openModal("thumbnailModal");
            if (document.fonts && document.fonts.ready) {
                document.fonts.ready.then(() => renderThumbnailCanvas());
            }
            setTimeout(renderThumbnailCanvas, 80);
        };

        if (btnThumbnailModal) btnThumbnailModal.addEventListener("click", openThumbModal);
        if (btnQuickThumbnail) btnQuickThumbnail.addEventListener("click", openThumbModal);
        if (btnBottomThumbnail) btnBottomThumbnail.addEventListener("click", openThumbModal);

        if (btnCaptureCurrentFrame) {
            btnCaptureCurrentFrame.addEventListener("click", () => {
                const ok = captureVideoFrame();
                if (ok) {
                    setStatus("📸 បាន Capture រូបភាពពីវីដេអូបច្ចុប្បន្នសម្រាប់ធ្វើ Thumbnail!");
                } else {
                    alert("សូមចាក់វីដេអូ ឬរង់ចាំវីដេអូដំណើរការសិន មុនពេល Capture!");
                }
            });
        }

        if (btnUploadThumbImage && inputThumbnailFile) {
            btnUploadThumbImage.addEventListener("click", () => inputThumbnailFile.click());
            inputThumbnailFile.addEventListener("change", (e) => {
                const file = e.target.files && e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const img = new Image();
                    img.onload = () => {
                        state.thumbnail.bgImage = img;
                        renderThumbnailCanvas();
                        setStatus(`📁 បានបញ្ចូលរូបភាព Thumbnail៖ ${file.name}`);
                    };
                    img.src = ev.target.result;
                };
                reader.readAsDataURL(file);
            });
        }

        if (thumbTitleInput) {
            thumbTitleInput.addEventListener("input", () => {
                state.thumbnail.title = thumbTitleInput.value.trim();
                renderThumbnailCanvas();
            });
        }
        if (thumbTitleFontSelect) {
            thumbTitleFontSelect.addEventListener("change", (e) => {
                state.thumbnail.titleFont = e.target.value;
                localStorage.setItem("vocal_studio_thumb_title_font", e.target.value);
                if (document.fonts && document.fonts.load) {
                    document.fonts.load(`bold 48px "${e.target.value}"`).then(() => renderThumbnailCanvas());
                }
                renderThumbnailCanvas();
            });
        }
        if (thumbSubInput) {
            thumbSubInput.addEventListener("input", () => {
                state.thumbnail.subtitle = thumbSubInput.value.trim();
                renderThumbnailCanvas();
            });
        }
        if (thumbSubFontSelect) {
            thumbSubFontSelect.addEventListener("change", (e) => {
                state.thumbnail.subFont = e.target.value;
                localStorage.setItem("vocal_studio_thumb_sub_font", e.target.value);
                if (document.fonts && document.fonts.load) {
                    document.fonts.load(`bold 24px "${e.target.value}"`).then(() => renderThumbnailCanvas());
                }
                renderThumbnailCanvas();
            });
        }
        if (thumbSubFontSizeSlider) {
            thumbSubFontSizeSlider.addEventListener("input", () => {
                state.thumbnail.subFontSize = parseInt(thumbSubFontSizeSlider.value);
                if (thumbSubFontSizeVal) thumbSubFontSizeVal.innerText = `${thumbSubFontSizeSlider.value}px`;
                localStorage.setItem("vocal_studio_thumb_sub_fontsize", thumbSubFontSizeSlider.value);
                renderThumbnailCanvas();
            });
        }
        thumbSubColorBtns.forEach(btn => {
            btn.addEventListener("click", () => {
                thumbSubColorBtns.forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                state.thumbnail.subColor = btn.dataset.color;
                if (thumbSubColorPicker) thumbSubColorPicker.value = btn.dataset.color;
                localStorage.setItem("vocal_studio_thumb_sub_color", btn.dataset.color);
                renderThumbnailCanvas();
            });
        });
        if (thumbSubColorPicker) {
            thumbSubColorPicker.addEventListener("input", (e) => {
                state.thumbnail.subColor = e.target.value;
                thumbSubColorBtns.forEach(b => b.classList.remove("active"));
                localStorage.setItem("vocal_studio_thumb_sub_color", e.target.value);
                renderThumbnailCanvas();
            });
        }

        if (thumbFontSizeSlider) {
            thumbFontSizeSlider.addEventListener("input", () => {
                state.thumbnail.fontSize = parseInt(thumbFontSizeSlider.value);
                if (thumbFontSizeVal) thumbFontSizeVal.innerText = `${thumbFontSizeSlider.value}px`;
                localStorage.setItem("vocal_studio_thumb_fontsize", thumbFontSizeSlider.value);
                renderThumbnailCanvas();
            });
        }
        const updatePosDisplay = (pct) => {
            state.thumbnail.yPercent = pct;
            localStorage.setItem("vocal_studio_thumb_y_pct", pct);
            if (thumbPosYSlider) thumbPosYSlider.value = pct;
            if (thumbPosVal) thumbPosVal.innerText = `${pct}%`;
        };

        if (thumbPosYSlider) {
            thumbPosYSlider.addEventListener("input", () => {
                const val = parseInt(thumbPosYSlider.value);
                updatePosDisplay(val);
                thumbPosPresets.forEach(b => b.classList.remove("active"));
                renderThumbnailCanvas();
            });
        }

        // ─── Direct Drag-and-Drop Interaction on Preview Canvas ───────────────────
        const getCanvasCoord = (e) => {
            const rect = thumbCanvas.getBoundingClientRect();
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            const scaleY = thumbCanvas.height / rect.height;
            return {
                x: (clientX - rect.left) * (thumbCanvas.width / rect.width),
                y: (clientY - rect.top) * scaleY,
                clientY: clientY
            };
        };

        const onStartDrag = (e) => {
            const coord = getCanvasCoord(e);
            isDraggingTitle = true;
            dragStartY = coord.clientY;
            dragStartPercent = state.thumbnail.yPercent || 48;
            thumbCanvas.style.cursor = "grabbing";
            renderThumbnailCanvas();
            if (e.cancelable) e.preventDefault();
        };

        const onMoveDrag = (e) => {
            if (!isDraggingTitle) {
                // Check hover state
                const coord = getCanvasCoord(e);
                const rect = thumbCanvas.getBoundingClientRect();
                const hoverPadding = 60 * (thumbCanvas.height / rect.height);
                const isOver = (coord.y >= (lastTitleBox.top - hoverPadding) && coord.y <= (lastTitleBox.bottom + hoverPadding));
                if (isOver !== isHoveringTitle) {
                    isHoveringTitle = isOver;
                    thumbCanvas.style.cursor = isHoveringTitle ? "ns-resize" : "default";
                    renderThumbnailCanvas();
                }
                return;
            }

            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            const rect = thumbCanvas.getBoundingClientRect();
            const deltaY = clientY - dragStartY;
            const deltaPct = (deltaY / rect.height) * 100;

            let newPct = Math.round(dragStartPercent + deltaPct);
            newPct = Math.max(10, Math.min(90, newPct));

            if (newPct !== state.thumbnail.yPercent) {
                updatePosDisplay(newPct);
                thumbPosPresets.forEach(b => b.classList.remove("active"));
                renderThumbnailCanvas();
            }
            if (e.cancelable) e.preventDefault();
        };

        const onEndDrag = () => {
            if (isDraggingTitle) {
                isDraggingTitle = false;
                thumbCanvas.style.cursor = isHoveringTitle ? "ns-resize" : "default";
                renderThumbnailCanvas();
            }
        };

        thumbCanvas.addEventListener("mousedown", onStartDrag);
        window.addEventListener("mousemove", onMoveDrag);
        window.addEventListener("mouseup", onEndDrag);

        thumbCanvas.addEventListener("touchstart", onStartDrag, { passive: false });
        window.addEventListener("touchmove", onMoveDrag, { passive: false });
        window.addEventListener("touchend", onEndDrag);

        thumbPosPresets.forEach(btn => {
            btn.addEventListener("click", () => {
                thumbPosPresets.forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                const pos = btn.dataset.pos;
                let val = 48;
                if (pos === "top") val = 22;
                else if (pos === "center") val = 48;
                else if (pos === "bottom") val = 76;
                updatePosDisplay(val);
                renderThumbnailCanvas();
            });
        });

        thumbColorBtns.forEach(btn => {
            btn.addEventListener("click", () => {
                thumbColorBtns.forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                state.thumbnail.textColor = btn.dataset.color;
                if (thumbColorPicker) thumbColorPicker.value = btn.dataset.color;
                localStorage.setItem("vocal_studio_thumb_color", btn.dataset.color);
                renderThumbnailCanvas();
            });
        });
        if (thumbColorPicker) {
            thumbColorPicker.addEventListener("input", (e) => {
                state.thumbnail.textColor = e.target.value;
                thumbColorBtns.forEach(b => b.classList.remove("active"));
                localStorage.setItem("vocal_studio_thumb_color", e.target.value);
                renderThumbnailCanvas();
            });
        }
        if (thumbBoxStyle) {
            thumbBoxStyle.addEventListener("change", (e) => {
                state.thumbnail.boxStyle = e.target.value;
                localStorage.setItem("vocal_studio_thumb_box_style", e.target.value);
                renderThumbnailCanvas();
            });
        }

        if (btnDownloadThumbnail) {
            btnDownloadThumbnail.addEventListener("click", () => {
                renderThumbnailCanvas();
                const a = document.createElement("a");
                const safeName = (state.thumbnail.title || "Movie").replace(/[^a-zA-Z0-9_\u1780-\u17FF]/g, "_");
                a.download = `Thumbnail_${safeName}.png`;
                a.href = thumbCanvas.toDataURL("image/png");
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setStatus("📥 បានទាញយករូប Thumbnail ជា PNG រួចរាល់!");
            });
        }

        if (btnSaveThumbnail) {
            btnSaveThumbnail.addEventListener("click", async () => {
                renderThumbnailCanvas();
                btnSaveThumbnail.disabled = true;
                btnSaveThumbnail.innerHTML = '<i data-lucide="loader-2" class="spin"></i> កំពុងរក្សាទុក...';
                try {
                    const dataUrl = thumbCanvas.toDataURL("image/png");
                    const res = await fetch("/api/save-thumbnail", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ image_base64: dataUrl })
                    });
                    const d = await res.json();
                    if (d.success && d.path) {
                        state.thumbnail.enabled = true;
                        state.thumbnail.imagePath = d.path;
                        state.thumbnail.imageUrl = d.url;
                        state.thumbnail.insertAsCover = chkInsertCoverVideo ? chkInsertCoverVideo.checked : true;
                        state.thumbnail.coverDuration = parseFloat(thumbCoverDuration ? thumbCoverDuration.value : "0.8") || 0.8;
                        state.thumbnail.title = thumbTitleInput ? thumbTitleInput.value.trim() : state.thumbnail.title;
                        state.thumbnail.titleFont = thumbTitleFontSelect ? thumbTitleFontSelect.value : (state.thumbnail.titleFont || "Moul");
                        state.thumbnail.subtitle = thumbSubInput ? thumbSubInput.value.trim() : state.thumbnail.subtitle;
                        state.thumbnail.subFont = thumbSubFontSelect ? thumbSubFontSelect.value : (state.thumbnail.subFont || "Kantumruy Pro");
                        state.thumbnail.subFontSize = parseInt(thumbSubFontSizeSlider ? thumbSubFontSizeSlider.value : "32") || 32;
                        state.thumbnail.subColor = state.thumbnail.subColor || "#ffffff";

                        setStatus("✅ បានបង្កើត និងរក្សាទុក Thumbnail ចំណងជើងរឿងរួចរាល់!");
                        closeModal("thumbnailModal");
                    } else {
                        throw new Error(d.detail || "Save failed");
                    }
                } catch (err) {
                    console.error("Save thumbnail error:", err);
                    alert("បរាជ័យក្នុងការរក្សាទុក Thumbnail: " + err.message);
                } finally {
                    btnSaveThumbnail.disabled = false;
                    btnSaveThumbnail.innerHTML = '<i data-lucide="check"></i> <span>យល់ព្រម & រក្សាទុក</span>';
                    refreshIcons();
                }
            });
        }
    }

    initThumbnailSystem();

    // Settings Modal
    document.getElementById("btnSettingsModal").addEventListener("click", () => {
        loadAPISettings(); // load saved keys into fields
        openModal("settingsModal");
    });
    const inputProfileName = document.getElementById("inputProfileName");
    inputProfileName.addEventListener("input", () => {
        document.getElementById("userName").innerText = inputProfileName.value || "VANNTHAN";
    });

    const selectRecapStyle = document.getElementById("selectRecapStyle");
    selectRecapStyle.addEventListener("change", () => {
        state.recapStyle = (selectRecapStyle.value === "true");
    });

    // ── API Key helpers ───────────────────────────────────────────────────────
    window.toggleApiKeyVisibility = function(inputId, btn) {
        const inp = document.getElementById(inputId);
        if (inp.type === "password") { 
            inp.type = "text"; 
            btn.innerHTML = '<i data-lucide="eye-off"></i>'; 
        } else { 
            inp.type = "password"; 
            btn.innerHTML = '<i data-lucide="eye"></i>'; 
        }
        refreshIcons();
    };

    // Load API keys from localStorage and server (_settings.json) into the modal fields
    function loadAPISettings() {
        // 1. Instant load from localStorage so inputs are NEVER empty on refresh
        try {
            const cached = JSON.parse(localStorage.getItem("vocal_studio_settings") || "{}");
            if (cached.google_cloud_key) document.getElementById("apiKeyGoogle").value = cached.google_cloud_key;
            if (cached.deepl_key)        document.getElementById("apiKeyDeepL").value = cached.deepl_key;
            if (cached.gemini_key)       document.getElementById("apiKeyGemini").value = cached.gemini_key;
            if (cached.openai_key)       document.getElementById("apiKeyOpenAI").value = cached.openai_key;
            if (cached.priority)         document.getElementById("selectTranslatePriority").value = cached.priority;
        } catch (e) {}

        // 2. Fetch authoritative settings from server file
        fetch("/api/settings").then(r => r.json()).then(d => {
            if (d.google_cloud_key) document.getElementById("apiKeyGoogle").value = d.google_cloud_key;
            if (d.deepl_key)        document.getElementById("apiKeyDeepL").value = d.deepl_key;
            if (d.gemini_key)       document.getElementById("apiKeyGemini").value = d.gemini_key;
            if (d.openai_key)       document.getElementById("apiKeyOpenAI").value = d.openai_key;
            if (d.priority)         document.getElementById("selectTranslatePriority").value = d.priority;

            // Sync back to localStorage for offline / quick reload persistence
            try {
                localStorage.setItem("vocal_studio_settings", JSON.stringify(d));
            } catch (e) {}
        }).catch(() => {});
    }

    // Preload settings immediately
    loadAPISettings();

    // Save API keys permanently to both localStorage and server
    window.saveAPISettings = function() {
        const payload = {
            google_cloud_key: document.getElementById("apiKeyGoogle").value.trim(),
            deepl_key:        document.getElementById("apiKeyDeepL").value.trim(),
            gemini_key:       document.getElementById("apiKeyGemini").value.trim(),
            openai_key:       document.getElementById("apiKeyOpenAI").value.trim(),
            priority:         document.getElementById("selectTranslatePriority").value,
        };

        // Save immediately to localStorage
        try {
            localStorage.setItem("vocal_studio_settings", JSON.stringify(payload));
        } catch (e) {}

        const statusEl = document.getElementById("apiKeyStatus");
        statusEl.style.display = "block";
        statusEl.style.background = "#1e3a5f";
        statusEl.style.color = "#93c5fd";
        statusEl.style.border = "1px solid #1e40af";
        statusEl.textContent = "⏳ កំពុងរក្សាទុក Key ទៅកាន់ Server...";

        fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        }).then(r => r.json()).then(d => {
            statusEl.style.display = "block";
            statusEl.style.background = "#064e3b";
            statusEl.style.color = "#34d399";
            statusEl.style.border = "1px solid #065f46";
            statusEl.textContent = "✅ បានរក្សាទុក Key និងការកំណត់ដោយជោគជ័យ ១០០%! មិនបាត់បង់ឡើយ";
            setTimeout(() => { statusEl.style.display = "none"; }, 4000);
        }).catch(() => {
            statusEl.style.display = "block";
            statusEl.style.background = "#7f1d1d";
            statusEl.style.color = "#fca5a5";
            statusEl.textContent = "❌ Save failed — Server not reachable";
        });
    };

    // Test the current translation setting
    window.testTranslationAPI = function() {
        const statusEl = document.getElementById("apiKeyStatus");
        statusEl.style.display = "block";
        statusEl.style.background = "#1e3a5f";
        statusEl.style.color = "#93c5fd";
        statusEl.style.border = "1px solid #1e40af";
        statusEl.textContent = "⏳ សាកល្បងការបកប្រែ 你好 → ខ្មែរ...";

        const payload = {
            text: "你好，今天天气很好。",
            google_cloud_key: document.getElementById("apiKeyGoogle").value.trim(),
            deepl_key:        document.getElementById("apiKeyDeepL").value.trim(),
            gemini_key:       document.getElementById("apiKeyGemini").value.trim(),
            openai_key:       document.getElementById("apiKeyOpenAI").value.trim(),
            priority:         document.getElementById("selectTranslatePriority").value,
        };

        fetch("/api/test-translate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        }).then(r => r.json()).then(d => {
            if (d.result) {
                statusEl.style.background = "#064e3b";
                statusEl.style.color = "#34d399";
                statusEl.style.border = "1px solid #065f46";
                statusEl.textContent = `✅ ជោគជ័យ! "${d.result}" (ប្រព័ន្ធបកប្រែ: ${d.provider || "Gemini AI"})`;
            } else {
                statusEl.style.background = "#7f1d1d";
                statusEl.style.color = "#fca5a5";
                statusEl.textContent = "❌ " + (d.error || "Translation failed");
            }
        }).catch(() => {
            statusEl.style.background = "#7f1d1d";
            statusEl.style.color = "#fca5a5";
            statusEl.textContent = "❌ Server error";
        });
    };

    // Profile Modal Handling (Modern Studio Creator Card)
    const btnOpenProfileModal = document.getElementById("btnOpenProfileModal");
    const profileAvatarInput = document.getElementById("profileAvatarInput");
    const inputModalProfileName = document.getElementById("inputModalProfileName");
    const inputModalProfileStudio = document.getElementById("inputModalProfileStudio");
    const profileNamePreview = document.getElementById("profileNamePreview");
    const btnResetAvatar = document.getElementById("btnResetAvatar");
    const btnSaveProfile = document.getElementById("btnSaveProfile");
    const headerAvatarImg = document.getElementById("headerAvatarImg");
    const headerAvatarIcon = document.getElementById("headerAvatarIcon");
    const modalAvatarImg = document.getElementById("modalAvatarImg");
    const modalAvatarPlaceholder = document.getElementById("modalAvatarPlaceholder");

    // Load saved profile from localStorage if exists
    const savedName = localStorage.getItem("vocal_user_name") || "LY PYLAN";
    const savedStudio = localStorage.getItem("vocal_user_studio") || "សម្រាយរឿង HD";
    const savedAvatar = localStorage.getItem("vocal_user_avatar");

    if (savedName) {
        document.getElementById("userName").innerText = savedName;
        if (inputModalProfileName) inputModalProfileName.value = savedName;
        if (profileNamePreview) profileNamePreview.innerText = savedName;
    }
    if (savedStudio && inputModalProfileStudio) {
        inputModalProfileStudio.value = savedStudio;
    }

    if (savedAvatar) {
        if (headerAvatarImg && headerAvatarIcon) {
            headerAvatarImg.src = savedAvatar;
            headerAvatarImg.style.display = "block";
            headerAvatarIcon.style.display = "none";
        }
        if (modalAvatarImg && modalAvatarPlaceholder) {
            modalAvatarImg.src = savedAvatar;
            modalAvatarImg.style.display = "block";
            modalAvatarPlaceholder.style.display = "none";
        }
    }

    // Live typing name preview
    if (inputModalProfileName && profileNamePreview) {
        inputModalProfileName.addEventListener("input", () => {
            profileNamePreview.textContent = (inputModalProfileName.value || "").trim() || "LY PYLAN";
        });
    }

    if (btnOpenProfileModal) {
        btnOpenProfileModal.addEventListener("click", () => {
            const currentName = document.getElementById("userName").innerText || "LY PYLAN";
            if (inputModalProfileName) inputModalProfileName.value = currentName;
            if (profileNamePreview) profileNamePreview.innerText = currentName;
            openModal("profileModal");
        });
    }

    if (profileAvatarInput) {
        profileAvatarInput.addEventListener("change", (e) => {
            const file = e.target.files ? e.target.files[0] : null;
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                const base64Img = event.target.result;
                if (modalAvatarImg && modalAvatarPlaceholder) {
                    modalAvatarImg.src = base64Img;
                    modalAvatarImg.style.display = "block";
                    modalAvatarPlaceholder.style.display = "none";
                }
            };
            reader.readAsDataURL(file);
        });
    }

    // Reset avatar to default icon
    if (btnResetAvatar) {
        btnResetAvatar.addEventListener("click", () => {
            if (modalAvatarImg) {
                modalAvatarImg.src = "";
                modalAvatarImg.style.display = "none";
            }
            if (modalAvatarPlaceholder) {
                modalAvatarPlaceholder.style.display = "flex";
            }
            localStorage.removeItem("vocal_user_avatar");
            if (headerAvatarImg) {
                headerAvatarImg.src = "";
                headerAvatarImg.style.display = "none";
            }
            if (headerAvatarIcon) {
                headerAvatarIcon.style.display = "flex";
            }
            setStatus("✨ បានកំណត់រូបភាព Profile ដើមឡើងវិញ!");
        });
    }

    // Quick Preset Emojis Avatar Generator
    function generatePresetEmojiAvatar(emoji) {
        const canvas = document.createElement("canvas");
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext("2d");
        const grad = ctx.createLinearGradient(0, 0, 128, 128);
        grad.addColorStop(0, "#1e1b4b");
        grad.addColorStop(1, "#312e81");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(64, 64, 64, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = "60px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(emoji, 64, 68);
        return canvas.toDataURL("image/png");
    }

    document.querySelectorAll(".preset-avatar-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const emoji = btn.getAttribute("data-preset");
            if (emoji) {
                const dataUrl = generatePresetEmojiAvatar(emoji);
                if (modalAvatarImg && modalAvatarPlaceholder) {
                    modalAvatarImg.src = dataUrl;
                    modalAvatarImg.style.display = "block";
                    modalAvatarPlaceholder.style.display = "none";
                }
            }
        });
    });

    if (btnSaveProfile) {
        btnSaveProfile.addEventListener("click", () => {
            const newName = (inputModalProfileName.value || "").trim() || "LY PYLAN";
            document.getElementById("userName").innerText = newName;
            localStorage.setItem("vocal_user_name", newName);

            if (inputModalProfileStudio) {
                const studioName = (inputModalProfileStudio.value || "").trim();
                localStorage.setItem("vocal_user_studio", studioName);
            }

            if (modalAvatarImg && modalAvatarImg.src && modalAvatarImg.style.display !== "none") {
                headerAvatarImg.src = modalAvatarImg.src;
                headerAvatarImg.style.display = "block";
                headerAvatarIcon.style.display = "none";
                localStorage.setItem("vocal_user_avatar", modalAvatarImg.src);
            }

            closeModal("profileModal");
            setStatus(`✨ បានកែប្រែព័ត៌មាន Profile ឈ្មោះ៖ "${newName}" ដោយជោគជ័យ!`);
        });
    }

    // ── Software Update System ───────────────────────────────────────────
    function initSoftwareUpdate() {
        const btnCheckUpdate = document.getElementById("btnCheckUpdate");
        const updatePulseDot = document.getElementById("updatePulseDot");
        const updateBtnIcon = document.getElementById("updateBtnIcon");
        const updateBtnLabel = document.getElementById("updateBtnLabel");
        const updateNewBadge = document.getElementById("updateNewBadge");

        const updateModal = document.getElementById("updateModal");
        const updateStatusBanner = document.getElementById("updateStatusBanner");
        const updateBannerIcon = document.getElementById("updateBannerIcon");
        const updateBannerTitle = document.getElementById("updateBannerTitle");
        const updateBannerDesc = document.getElementById("updateBannerDesc");
        const modalCurrentVer = document.getElementById("modalCurrentVer");
        const modalCurrentBuild = document.getElementById("modalCurrentBuild");
        const modalLatestVer = document.getElementById("modalLatestVer");
        const modalUpdateSource = document.getElementById("modalUpdateSource");
        const modalChangelog = document.getElementById("modalChangelog");
        const inputUpdateRepo = document.getElementById("inputUpdateRepo");
        const btnSaveUpdateRepo = document.getElementById("btnSaveUpdateRepo");
        const btnTestUpdateSignal = document.getElementById("btnTestUpdateSignal");
        const btnRefreshCheckUpdate = document.getElementById("btnRefreshCheckUpdate");
        const btnTriggerPerformUpdate = document.getElementById("btnTriggerPerformUpdate");

        if (!btnCheckUpdate) return;

        let latestUpdateData = null;

        function toKhmerNum(n) {
            const kDigits = ["០", "១", "២", "៣", "៤", "៥", "៦", "៧", "៨", "៩"];
            return String(n).replace(/[0-9]/g, d => kDigits[d]);
        }

        async function fetchUpdateStatus(force = false, userTriggered = false) {
            if (userTriggered && btnRefreshCheckUpdate) {
                btnRefreshCheckUpdate.innerHTML = '<i data-lucide="loader-2" class="icon-spin icon-xs"></i> <span>កំពុងពិនិត្យ...</span>';
                refreshIcons();
            }

            try {
                const res = await fetch(`/api/check-update?force=${force ? "true" : "false"}`);
                if (!res.ok) throw new Error("Server error");
                const data = await res.json();
                latestUpdateData = data;

                const count = data.update_count || (data.has_update ? 1 : 0);
                const khmerCount = toKhmerNum(count);

                // Update Header Brand Badge
                const headerBrandBadge = document.getElementById("headerBrandBadge");
                if (headerBrandBadge && data.current_version) {
                    headerBrandBadge.textContent = `V${data.current_version.replace(/^v/i, '')} - Free Edition`;
                }

                // Update Header Button State
                if (data.has_update) {
                    btnCheckUpdate.classList.add("has-update");
                    if (updatePulseDot) updatePulseDot.style.display = "inline-block";
                    if (updateNewBadge) {
                        updateNewBadge.style.display = "inline-block";
                        if (data.version_changed || count >= 4) {
                            // ចាប់ពី ៤ដងឡើង ត្រូវប្ដូរ Version តាម
                            const vStr = data.latest_version ? data.latest_version.replace(/^v/i, '') : "1.0.1";
                            updateNewBadge.textContent = `v${vStr}`;
                        } else if (count >= 2) {
                            // អាប់ដេតស្ទួនគ្នាថ្មី ២ដង (ឬ ៣ដង)
                            updateNewBadge.textContent = `${khmerCount}ដង`;
                        } else {
                            updateNewBadge.textContent = data.badge_text || `${khmerCount}ដង`;
                        }
                    }
                    if (updateBtnLabel) updateBtnLabel.textContent = "Update ថ្មី!";

                    if (count >= 4) {
                        btnCheckUpdate.title = `🎉 មានកំណែអាប់ដេតថ្មី V${data.latest_version} (អាប់ដេត ${khmerCount}ដង)! ចុចដើម្បីអាប់ដេត`;
                    } else if (count >= 2) {
                        btnCheckUpdate.title = `⚡ មានការអាប់ដេតកូដថ្មីស្ទួនគ្នា ${khmerCount} ដង! ចុចដើម្បីអាប់ដេត`;
                    } else {
                        btnCheckUpdate.title = `🎉 មានកំណែអាប់ដេតថ្មី! ចុចដើម្បីអាប់ដេត`;
                    }
                } else {
                    btnCheckUpdate.classList.remove("has-update");
                    if (updatePulseDot) updatePulseDot.style.display = "none";
                    if (updateNewBadge) updateNewBadge.style.display = "none";
                    if (updateBtnLabel) updateBtnLabel.textContent = "Update";
                    btnCheckUpdate.title = `កំណែបច្ចុប្បន្ន V${data.current_version || '1.0.0'} (ទាន់សម័យ)`;
                }

                // Update Modal Content if open or user requested
                if (modalCurrentVer) modalCurrentVer.textContent = `V${data.current_version || '1.0.0'}`;
                if (modalCurrentBuild) modalCurrentBuild.textContent = `Build: ${data.current_build || '20261108'}`;
                if (modalLatestVer) {
                    if (data.has_update) {
                        if (data.version_changed || count >= 4) {
                            modalLatestVer.textContent = `V${data.latest_version.replace(/^v/i, '')}`;
                            modalLatestVer.style.color = "#34d399";
                        } else if (count >= 2) {
                            modalLatestVer.textContent = `V${data.current_version} (${khmerCount}ដង)`;
                            modalLatestVer.style.color = "#fbbf24";
                        } else {
                            modalLatestVer.textContent = `V${data.current_version} (១ដង)`;
                            modalLatestVer.style.color = "#f59e0b";
                        }
                    } else {
                        modalLatestVer.textContent = `V${data.current_version || '1.0.0'}`;
                        modalLatestVer.style.color = "#10b981";
                    }
                }
                if (modalUpdateSource) {
                    if (data.has_update) {
                        if (data.version_changed || count >= 4) {
                            modalUpdateSource.textContent = `ស្ថានភាព៖ ប្ដូរទៅកំណែ V${data.latest_version} (${khmerCount}ដង)`;
                        } else if (count >= 2) {
                            modalUpdateSource.textContent = `ស្ថានភាព៖ អាប់ដេតស្ទួនគ្នា ${khmerCount} ដង`;
                        } else {
                            modalUpdateSource.textContent = `ស្ថានភាព៖ អាប់ដេតកូដថ្មី ១ ដង`;
                        }
                    } else {
                        modalUpdateSource.textContent = "ស្ថានភាព៖ គ្មាន Update ថ្មីទេ";
                    }
                }
                if (modalChangelog && data.changelog) {
                    modalChangelog.textContent = data.changelog;
                }
                if (inputUpdateRepo && data.github_repo !== undefined) {
                    inputUpdateRepo.value = data.github_repo || "";
                }

                // Update Status Banner in Modal
                if (updateStatusBanner && updateBannerIcon && updateBannerTitle && updateBannerDesc) {
                    if (data.has_update) {
                        if (count >= 4 || data.version_changed) {
                            updateStatusBanner.style.background = "rgba(16, 185, 129, 0.16)";
                            updateStatusBanner.style.borderColor = "rgba(16, 185, 129, 0.45)";
                            updateBannerIcon.textContent = "🚀";
                            updateBannerTitle.textContent = `អាប់ដេតចាប់ពី ${khmerCount} ដងឡើង - ប្ដូរទៅកំណែ V${data.latest_version}!`;
                            updateBannerTitle.style.color = "#34d399";
                            updateBannerDesc.textContent = `ប្រព័ន្ធបានកែលម្អច្រើនដង និងប្ដូរកំណែ Version ថ្មីដោយស្វ័យប្រវត្តិ។ សូមចុច 'អាប់ដេតឥឡូវនេះ' ដើម្បីដំឡើងកំណែថ្មី!`;
                        } else if (count >= 2) {
                            updateStatusBanner.style.background = "rgba(245, 158, 11, 0.16)";
                            updateStatusBanner.style.borderColor = "rgba(245, 158, 11, 0.45)";
                            updateBannerIcon.textContent = "⚡";
                            updateBannerTitle.textContent = `មានការអាប់ដេតកូដថ្មីស្ទួនគ្នា ${khmerCount} ដង!`;
                            updateBannerTitle.style.color = "#fbbf24";
                            updateBannerDesc.textContent = `ប្រព័ន្ធបានរកឃើញការកែសម្រួលកូដថ្មីចំនួន ${khmerCount} ដង។ សូមចុច 'អាប់ដេតឥឡូវនេះ' ដើម្បី Refresh ប្រើប្រាស់កូដថ្មី។`;
                        } else {
                            updateStatusBanner.style.background = "rgba(245, 158, 11, 0.15)";
                            updateStatusBanner.style.borderColor = "rgba(245, 158, 11, 0.4)";
                            updateBannerIcon.textContent = "🔥";
                            updateBannerTitle.textContent = "រកឃើញការអាប់ដេតកូដថ្មី!";
                            updateBannerTitle.style.color = "#fbbf24";
                            updateBannerDesc.textContent = data.message || "មានកូដថ្មីត្រូវបានរៀបចំរួចរាល់។ សូមចុច 'អាប់ដេតឥឡូវនេះ' ដើម្បីដំណើរការ។";
                        }
                    } else {
                        updateStatusBanner.style.background = "rgba(16, 185, 129, 0.12)";
                        updateStatusBanner.style.borderColor = "rgba(16, 185, 129, 0.35)";
                        updateBannerIcon.textContent = "✨";
                        updateBannerTitle.textContent = "អ្នកកំពុងប្រើប្រាស់កំណែចុងក្រោយបំផុត (Up to date)";
                        updateBannerTitle.style.color = "#34d399";
                        updateBannerDesc.textContent = "កម្មវិធី Vocal Studio របស់អ្នកដំណើរការលើកូដថ្មីបំផុត។ មិនទាន់មានកំណែថ្មីនៅឡើយទេ។";
                    }
                }

                if (userTriggered) {
                    setStatus(data.has_update ? `🎉 ${data.message}` : "✨ អ្នកកំពុងប្រើប្រាស់កំណែចុងក្រោយបំផុតរួចរាល់ហើយ!");
                }
            } catch (err) {
                console.debug("Update check failed:", err);
            } finally {
                if (userTriggered && btnRefreshCheckUpdate) {
                    btnRefreshCheckUpdate.innerHTML = '<i data-lucide="refresh-cw" class="icon-xs"></i> <span>ពិនិត្យម្តងទៀត</span>';
                    refreshIcons();
                }
            }
        }

        // Open Modal on Header Button Click
        btnCheckUpdate.addEventListener("click", () => {
            openModal("updateModal");
            fetchUpdateStatus(false, false);
        });

        // Refresh check button in modal
        if (btnRefreshCheckUpdate) {
            btnRefreshCheckUpdate.addEventListener("click", () => {
                fetchUpdateStatus(true, true);
            });
        }

        // Save GitHub Repo configuration
        if (btnSaveUpdateRepo && inputUpdateRepo) {
            btnSaveUpdateRepo.addEventListener("click", async () => {
                const repoVal = inputUpdateRepo.value.trim();
                btnSaveUpdateRepo.disabled = true;
                btnSaveUpdateRepo.textContent = "កំពុងរក្សាទុក...";
                try {
                    const res = await fetch("/api/save-update-config", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ github_repo: repoVal })
                    });
                    if (res.ok) {
                        setStatus("✨ បានរក្សាទុកអាសយដ្ឋាន GitHub Repository ដោយជោគជ័យ!");
                        fetchUpdateStatus(true, true);
                    }
                } catch (e) {
                    console.error("Save repo error:", e);
                } finally {
                    btnSaveUpdateRepo.disabled = false;
                    btnSaveUpdateRepo.textContent = "រក្សាទុក";
                }
            });
        }

        // Perform Update action (Git pull / cache reload)
        if (btnTriggerPerformUpdate) {
            btnTriggerPerformUpdate.addEventListener("click", async () => {
                btnTriggerPerformUpdate.disabled = true;
                btnTriggerPerformUpdate.innerHTML = '<i data-lucide="loader-2" class="icon-spin icon-xs"></i> <span>កំពុងអាប់ដេត...</span>';
                refreshIcons();

                try {
                    const res = await fetch("/api/perform-update", { method: "POST" });
                    const resData = await res.json();
                    if (resData.success) {
                        setStatus(resData.message || "🎉 អាប់ដេតបានជោគជ័យ!");
                        if (updateStatusBanner && updateBannerTitle && updateBannerDesc) {
                            updateStatusBanner.style.background = "rgba(16, 185, 129, 0.2)";
                            updateStatusBanner.style.borderColor = "#10b981";
                            updateBannerIcon.textContent = "🎉";
                            updateBannerTitle.textContent = "អាប់ដេតជោគជ័យ ១០០%!";
                            updateBannerTitle.style.color = "#34d399";
                            updateBannerDesc.textContent = "កូដត្រូវបានទាញយក និងរៀបចំរួចរាល់។ ទំព័រនឹង Refresh ក្នុងរយៈពេល ២ វិនាទី...";
                        }
                        setTimeout(() => {
                            window.location.reload();
                        }, 2200);
                    } else {
                        alert("កំហុសក្នុងការអាប់ដេត៖\n" + (resData.message || resData.error || ""));
                    }
                } catch (e) {
                    alert("កំហុសបណ្តាញពេលអាប់ដេត៖ " + e);
                } finally {
                    btnTriggerPerformUpdate.disabled = false;
                    btnTriggerPerformUpdate.innerHTML = '<i data-lucide="download"></i> <span>អាប់ដេតឥឡូវនេះ</span>';
                    refreshIcons();
                }
            });
        }

        // Test simulation button: cycle through 1ដង -> 2ដង -> 3ដង -> v1.0.1 -> 0
        if (btnTestUpdateSignal) {
            btnTestUpdateSignal.addEventListener("click", async () => {
                try {
                    const res = await fetch("/api/toggle-update-simulation", { method: "POST" });
                    const dat = await res.json();
                    await fetchUpdateStatus(true, false);
                    const step = dat.step || 0;
                    if (step === 1) {
                        setStatus("🔔 សាកល្បង៖ អាប់ដេតលើកទី ១ (Badge: ១ដង)");
                    } else if (step === 2) {
                        setStatus("⚡ សាកល្បង៖ អាប់ដេតស្ទួនគ្នា ២ដង (Badge: ២ដង)");
                    } else if (step === 3) {
                        setStatus("⚡ សាកល្បង៖ អាប់ដេតស្ទួនគ្នា ៣ដង (Badge: ៣ដង)");
                    } else if (step === 4) {
                        setStatus("🚀 សាកល្បង៖ អាប់ដេតចាប់ពី ៤ដងឡើង -> ប្ដូរទៅកំណែ V1.0.1!");
                    } else {
                        setStatus("✅ បានបិទការសាកល្បង - ត្រឡប់មកស្ថានភាពដើម (Up to date)!");
                    }
                } catch (e) {
                    console.error("Toggle simulation error:", e);
                }
            });
        }

        // Auto-check 2 seconds after page load
        setTimeout(() => {
            fetchUpdateStatus(false, false);
        }, 2000);

        // Periodic background check every 5 minutes (300,000 ms)
        setInterval(() => {
            fetchUpdateStatus(false, false);
        }, 300000);
    }

    // ── Smooth Toolbar Drag & Mouse Wheel Horizontal Scroll ───────────────
    function initToolbarSmoothScroll() {
        const toolbar = document.getElementById("mainToolbar");
        const btnLeft = document.getElementById("btnToolbarScrollLeft");
        const btnRight = document.getElementById("btnToolbarScrollRight");
        if (!toolbar) return;

        // Update Left / Right Arrow visibility
        function updateArrowVisibility() {
            if (!btnLeft || !btnRight) return;
            const hasOverflow = toolbar.scrollWidth > toolbar.clientWidth + 5;
            if (!hasOverflow) {
                btnLeft.classList.remove("visible");
                btnRight.classList.remove("visible");
                return;
            }
            if (toolbar.scrollLeft > 15) {
                btnLeft.classList.add("visible");
            } else {
                btnLeft.classList.remove("visible");
            }

            if (toolbar.scrollLeft < toolbar.scrollWidth - toolbar.clientWidth - 15) {
                btnRight.classList.add("visible");
            } else {
                btnRight.classList.remove("visible");
            }
        }

        toolbar.addEventListener("scroll", updateArrowVisibility, { passive: true });
        window.addEventListener("resize", updateArrowVisibility, { passive: true });
        setTimeout(updateArrowVisibility, 300);

        // Arrow Click Handlers
        if (btnLeft) {
            btnLeft.addEventListener("click", () => {
                toolbar.scrollBy({ left: -260, behavior: "smooth" });
            });
        }
        if (btnRight) {
            btnRight.addEventListener("click", () => {
                toolbar.scrollBy({ left: 260, behavior: "smooth" });
            });
        }

        // 1. Mouse Wheel Scroll: Converts vertical wheel into smooth horizontal scroll
        toolbar.addEventListener("wheel", (e) => {
            if (toolbar.scrollWidth <= toolbar.clientWidth) return;
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                e.preventDefault();
                toolbar.scrollBy({
                    left: e.deltaY * 1.4,
                    behavior: "smooth"
                });
            }
        }, { passive: false });

        // 2. Drag-to-Scroll (Mouse Click & Drag with Smooth Momentum)
        let isDown = false;
        let startX = 0;
        let scrollStartLeft = 0;
        let hasDragged = false;
        let lastX = 0;
        let lastTime = 0;
        let velocity = 0;
        let momentumRaf = null;

        toolbar.addEventListener("mousedown", (e) => {
            // Allow native clicks on select and input without dragging
            if (e.target.closest("select") || e.target.closest("input")) return;

            isDown = true;
            hasDragged = false;
            toolbar.classList.add("is-dragging");
            startX = e.pageX - toolbar.offsetLeft;
            scrollStartLeft = toolbar.scrollLeft;
            lastX = e.pageX;
            lastTime = performance.now();
            velocity = 0;
            if (momentumRaf) cancelAnimationFrame(momentumRaf);
        });

        window.addEventListener("mousemove", (e) => {
            if (!isDown) return;
            const x = e.pageX - toolbar.offsetLeft;
            const walk = x - startX;

            if (Math.abs(walk) > 4) {
                hasDragged = true;
            }

            const now = performance.now();
            const dt = now - lastTime;
            if (dt > 0) {
                velocity = (lastX - e.pageX) / dt;
                lastX = e.pageX;
                lastTime = now;
            }

            toolbar.scrollLeft = scrollStartLeft - walk;
        });

        window.addEventListener("mouseup", (e) => {
            if (!isDown) return;
            isDown = false;
            toolbar.classList.remove("is-dragging");

            // Smooth momentum glide
            if (Math.abs(velocity) > 0.12) {
                let vel = velocity * 14;
                function applyMomentum() {
                    if (Math.abs(vel) < 0.3) return;
                    toolbar.scrollLeft += vel;
                    vel *= 0.92;
                    momentumRaf = requestAnimationFrame(applyMomentum);
                }
                applyMomentum();
            }
        });

        // Prevent button click if the user was dragging the toolbar
        toolbar.addEventListener("click", (e) => {
            if (hasDragged) {
                e.preventDefault();
                e.stopPropagation();
                hasDragged = false;
            }
        }, true);
    }

    // Initialize smooth toolbar scrolling
    initToolbarSmoothScroll();

    // Initialize software update checking
    initSoftwareUpdate();

    // Initial table render (empty prompt)
    renderTable();

    // Render all Lucide vector icons initially across the whole UI
    refreshIcons();

    // Ensure all audio elements are strictly killed and muted upon fresh page load
    killAllAudio();

    // Window blur or hide event to ensure zero background sound
    window.addEventListener("beforeunload", () => {
        killAllAudio();
    });
});
