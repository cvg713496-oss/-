class VisualTimeline {
    constructor(containerId, options = {}) {
        this.container = document.getElementById(containerId);
        this.ruler = document.getElementById("timelineRuler");
        this.tracksContainer = document.getElementById("timelineTracks");
        this.track1 = document.getElementById("track1");
        this.track2 = document.getElementById("track2");
        this.cursor = document.getElementById("timelineCursor");

        this.duration = options.duration || 60; // in seconds
        this.segments = [];
        this.zoom = 1.0; // 1.0 = Fit to 100%, up to 100.0x (10000%)
        this.lastActiveId = null;
        this.onSeek = options.onSeek || null;
        this.onSelectSegment = options.onSelectSegment || null;
        this.onSegmentChange = options.onSegmentChange || null;

        // Tooltip for dragging
        this.tooltip = document.createElement("div");
        this.tooltip.className = "timeline-tooltip";
        if (this.tracksContainer) {
            this.tracksContainer.appendChild(this.tooltip);
        }

        this.activeDrag = null;
        this.isScrubbing = false;
        // Flag: true while the user is dragging/resizing or scrubbing — suppresses auto-cursor updates
        this.isUserScrubbing = false;
        this.pendingSeekTime = null;
        this.seekRafId = null;

        this.onScrubStart = options.onScrubStart || null;
        this.onScrubEnd = options.onScrubEnd || null;
        this.initEvents();
        this.initZoomControls();
    }

    setDuration(duration) {
        this.duration = Math.max(duration, 10);
        this.renderRuler();
        this.renderSegments(this.segments);
    }

    setSegments(segments) {
        this.segments = segments || [];
        this.renderSegments(this.segments);
    }

    setZoom(level) {
        this.zoom = Math.max(1.0, Math.min(100.0, Math.round(level * 10) / 10));
        const widthStr = `${this.zoom * 100}%`;
        if (this.ruler) this.ruler.style.width = widthStr;
        if (this.tracksContainer) this.tracksContainer.style.width = widthStr;

        const label = document.getElementById("zoomLevelLabel");
        if (label) label.innerText = `${Math.round(this.zoom * 100)}%`;

        this.renderRuler();
        this.renderSegments(this.segments);
    }

    formatTime(seconds) {
        if (isNaN(seconds)) return "0:00.00";
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.floor((seconds - Math.floor(seconds)) * 100);
        return `${mins}:${secs.toString().padStart(2, "0")}.${ms.toString().padStart(2, "0")}`;
    }

    renderRuler() {
        if (!this.ruler) return;
        this.ruler.innerHTML = "";
        
        // Dynamically scale ruler ticks based on video length and zoom level
        const effectiveDuration = this.duration / this.zoom;
        let step = 5;
        if (effectiveDuration > 3600) {
            step = 120; // 2m ticks
        } else if (effectiveDuration > 1800) {
            step = 60;  // 1m ticks
        } else if (effectiveDuration > 600) {
            step = 30;  // 30s ticks
        } else if (effectiveDuration > 180) {
            step = 15;
        } else if (effectiveDuration > 60) {
            step = 5;
        } else if (effectiveDuration > 25) {
            step = 2;
        } else if (effectiveDuration > 10) {
            step = 1;
        } else if (effectiveDuration > 4) {
            step = 0.5;
        } else if (effectiveDuration > 1.5) {
            step = 0.2;
        } else {
            step = 0.1;
        }

        const totalSteps = Math.min(2500, Math.ceil(this.duration / step));
        const frag = document.createDocumentFragment();

        for (let i = 0; i <= totalSteps; i++) {
            const timeSec = i * step;
            if (timeSec > this.duration + (step * 0.5)) break;

            const percent = (timeSec / this.duration) * 100;
            const mark = document.createElement("div");
            mark.style.position = "absolute";
            mark.style.left = `${percent}%`;
            mark.style.transform = "translateX(-50%)";
            mark.style.cursor = "pointer";

            let label = `${timeSec}s`;
            if (timeSec >= 3600) {
                const h = Math.floor(timeSec / 3600);
                const m = Math.floor((timeSec % 3600) / 60);
                label = m > 0 ? `${h}h${m}m` : `${h}h`;
            } else if (timeSec >= 60) {
                const m = Math.floor(timeSec / 60);
                const s = timeSec % 60;
                const sFormatted = (s % 1 === 0) ? s : s.toFixed(1);
                label = s > 0 ? `${m}m${sFormatted}s` : `${m}m`;
            } else {
                const sFormatted = (timeSec % 1 === 0) ? timeSec : timeSec.toFixed(1);
                label = `${sFormatted}s`;
            }

            mark.innerText = label;
            frag.appendChild(mark);
        }
        this.ruler.appendChild(frag);
    }

    renderSegments(segments) {
        this.segments = segments || [];
        if (!this.track1 || !this.track2) return;

        // Auto-expand duration to accommodate the last segment timestamp
        if (this.segments.length > 0) {
            let maxEnd = 0;
            this.segments.forEach(s => {
                const en = parseFloat(s.end) || (parseFloat(s.start) + 1.5) || 0;
                if (en > maxEnd) maxEnd = en;
            });
            if (maxEnd > this.duration) {
                this.duration = Math.ceil(maxEnd + 5);
                this.renderRuler();
            }
        }

        this.track1.innerHTML = "";
        this.track2.innerHTML = "";

        const frag1 = document.createDocumentFragment();
        const frag2 = document.createDocumentFragment();

        this.segments.forEach(seg => {
            const start = parseFloat(seg.start) || 0;
            const end = parseFloat(seg.end) || (start + 1.5);
            const dur = Math.max(0.2, end - start);

            const leftPercent = Math.min(99.7, Math.max(0, (start / this.duration) * 100));
            // Proportional width reflecting true timing
            const rawWidth = (dur / this.duration) * 100;
            // Scale with zoom so blocks stay distinct and readable
            const widthPercent = Math.min(100 - leftPercent, Math.max(0.35, rawWidth));

            const block = document.createElement("div");
            block.className = "track-block";
            
            const isFemale = (seg.voice && seg.voice.includes("Sreymom")) || (seg.actor && seg.actor.includes("2"));
            block.classList.add(isFemale ? "block-purple" : "block-green");

            block.style.left = `${leftPercent}%`;
            // Clear 3px gap between blocks to ensure neat, orderly separation
            block.style.width = `calc(${widthPercent}% - 3px)`;
            block.style.minWidth = "20px";
            block.dataset.id = seg.id;

            const icon = isFemale 
                ? '<i data-lucide="user-check" style="width: 11px; height: 11px; vertical-align: -0.1em;"></i>' 
                : '<i data-lucide="user" style="width: 11px; height: 11px; vertical-align: -0.1em;"></i>';
            const durSec = (end - start).toFixed(2);
            const label = (seg.translated || seg.original || "").trim();
            block.title = `#${seg.id} [${this.formatTime(start)} ➔ ${this.formatTime(end)} (${durSec}s)]\n${label}`;

            // Left Resize Handle
            const handleLeft = document.createElement("div");
            handleLeft.className = "resize-handle handle-left";
            handleLeft.title = "អូសដើម្បីសារ៉េវិនាទីចាប់ផ្តើម (Start)";

            // Right Resize Handle
            const handleRight = document.createElement("div");
            handleRight.className = "resize-handle handle-right";
            handleRight.title = "អូសដើម្បីសារ៉េវិនាទីបញ្ចប់ (End)";

            // Content text with neat badge and truncated text
            const contentSpan = document.createElement("span");
            contentSpan.style.display = "flex";
            contentSpan.style.alignItems = "center";
            contentSpan.style.gap = "4px";
            contentSpan.style.width = "100%";
            contentSpan.style.overflow = "hidden";
            contentSpan.style.pointerEvents = "none";
            contentSpan.style.padding = "0 3px";

            contentSpan.innerHTML = `
                <span class="block-badge" style="background: rgba(0,0,0,0.45); padding: 1px 4px; border-radius: 3px; font-size: 10px; font-weight: 700; flex-shrink: 0; color: #fff;">#${seg.id}</span>
                <span style="display: inline-flex; align-items: center; flex-shrink: 0;">${icon}</span>
                <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; font-weight: 500;">${label}</span>
            `;

            block.appendChild(handleLeft);
            block.appendChild(contentSpan);
            block.appendChild(handleRight);

            // Click block to seek video and highlight table row
            block.addEventListener("click", () => {
                if (this.activeDrag && this.activeDrag.hasMoved) return;
                if (this.onSelectSegment) {
                    this.onSelectSegment(seg);
                }
            });

            // Double-click block to quickly toggle speaker gender (Male <-> Female)
            block.addEventListener("dblclick", (e) => {
                e.stopPropagation();
                e.preventDefault();
                const isFemaleNow = (seg.voice && seg.voice.includes("Sreymom")) || (seg.actor && seg.actor.includes("2"));
                if (isFemaleNow) {
                    seg.voice = "km-KH-PisethNeural";
                    seg.actor = "Actor 1";
                } else {
                    seg.voice = "km-KH-SreymomNeural";
                    seg.actor = "Actor 2";
                }
                if (this.onSegmentChange) {
                    this.onSegmentChange(seg);
                }
                this.renderSegments(this.segments);
            });

            // Right-click block to also toggle speaker gender
            block.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const isFemaleNow = (seg.voice && seg.voice.includes("Sreymom")) || (seg.actor && seg.actor.includes("2"));
                if (isFemaleNow) {
                    seg.voice = "km-KH-PisethNeural";
                    seg.actor = "Actor 1";
                } else {
                    seg.voice = "km-KH-SreymomNeural";
                    seg.actor = "Actor 2";
                }
                if (this.onSegmentChange) {
                    this.onSegmentChange(seg);
                }
                this.renderSegments(this.segments);
            });

            // Mousedown for dragging or resizing
            block.addEventListener("mousedown", (e) => {
                e.stopPropagation();
                
                // User started dragging — pause auto cursor sync
                this.isUserScrubbing = true;

                let dragType = "move";
                if (e.target === handleLeft) {
                    dragType = "resize-left";
                } else if (e.target === handleRight) {
                    dragType = "resize-right";
                }

                const rect = (isFemale ? this.track2 : this.track1).getBoundingClientRect();
                
                this.activeDrag = {
                    type: dragType,
                    seg: seg,
                    blockElem: block,
                    startX: e.clientX,
                    initialStart: parseFloat(seg.start) || 0,
                    initialEnd: parseFloat(seg.end) || (parseFloat(seg.start) + 2),
                    trackWidth: rect.width,
                    hasMoved: false
                };

                block.classList.add("is-dragging");
            });

            if (isFemale) {
                frag2.appendChild(block);
            } else {
                frag1.appendChild(block);
            }
        });

        this.track1.appendChild(frag1);
        this.track2.appendChild(frag2);
        if (window.refreshIcons) window.refreshIcons();
    }

    updateCursor(currentTime) {
        if (!this.cursor || !this.duration) return;
        // When the user is manually scrubbing, skip auto-update to avoid fighting with drag logic
        if (this.isUserScrubbing) return;

        const percent = Math.min(100, Math.max(0, (currentTime / this.duration) * 100));
        this.cursor.style.left = `${percent}%`;

        // Highlight active segment currently speaking with a tiny lead offset to avoid flicker at boundaries
        const lead = 0.05;
        const activeSeg = this.segments.find(s => {
            const st = parseFloat(s.start);
            const en = parseFloat(s.end);
            return currentTime >= (st - lead) && currentTime < en;
        });
        const activeId = activeSeg ? activeSeg.id : null;

        if (this.lastActiveId !== activeId) {
            this.lastActiveId = activeId;
            const prev = this.tracksContainer ? this.tracksContainer.querySelectorAll(".is-active-playing") : [];
            prev.forEach(el => el.classList.remove("is-active-playing"));
            if (activeId !== null && this.tracksContainer) {
                const cur = this.tracksContainer.querySelector(`.track-block[data-id="${activeId}"]`);
                if (cur) {
                    cur.classList.add("is-active-playing");
                    // Auto-scroll timeline to follow playhead if zoomed in
                    if (this.zoom > 1.0 && this.container) {
                        const containerW = this.container.clientWidth;
                        const curLeft = cur.offsetLeft;
                        if (curLeft > this.container.scrollLeft + containerW - 120 || curLeft < this.container.scrollLeft + 60) {
                            this.container.scrollTo({ left: Math.max(0, curLeft - (containerW / 2)), behavior: 'smooth' });
                        }
                    }
                }
            }
        } else if (this.zoom > 1.0 && this.container && !this.isUserScrubbing && this.cursor) {
            // Also follow playhead smoothly during gaps between segments
            const containerW = this.container.clientWidth;
            const cursorLeft = this.cursor.offsetLeft;
            if (cursorLeft > this.container.scrollLeft + containerW - 120 || cursorLeft < this.container.scrollLeft + 60) {
                this.container.scrollTo({ left: Math.max(0, cursorLeft - (containerW / 2)), behavior: 'smooth' });
            }
        }
    }

    initZoomControls() {
        const btnZoomIn = document.getElementById("btnZoomIn");
        const btnZoomOut = document.getElementById("btnZoomOut");
        const btnZoomFit = document.getElementById("btnZoomFit");
        const label = document.getElementById("zoomLevelLabel");

        const getZoomStep = (currentZoom) => {
            if (currentZoom < 2.0) return 0.25;      // 25% steps up to 200%
            if (currentZoom < 5.0) return 0.5;       // 50% steps up to 500%
            if (currentZoom < 10.0) return 1.0;      // 100% steps up to 1000%
            if (currentZoom < 30.0) return 2.5;      // 250% steps up to 3000%
            if (currentZoom < 60.0) return 5.0;      // 500% steps up to 6000%
            return 10.0;                             // 1000% steps up to 10000%
        };

        if (label) {
            label.style.cursor = "pointer";
            label.title = "ចុចដើម្បីប្តូរកម្រិតពង្រីករហ័ស (100% ➔ 200% ➔ 500% ➔ 1000% ➔ 2500% ➔ 5000% ➔ 10000%)";
            label.addEventListener("click", () => {
                if (this.zoom < 2.0) this.setZoom(2.0);
                else if (this.zoom < 5.0) this.setZoom(5.0);
                else if (this.zoom < 10.0) this.setZoom(10.0);
                else if (this.zoom < 25.0) this.setZoom(25.0);
                else if (this.zoom < 50.0) this.setZoom(50.0);
                else if (this.zoom < 100.0) this.setZoom(100.0);
                else this.setZoom(1.0);
            });
        }

        if (btnZoomIn) {
            btnZoomIn.addEventListener("click", () => {
                const step = getZoomStep(this.zoom);
                this.setZoom(this.zoom + step);
            });
        }
        if (btnZoomOut) {
            btnZoomOut.addEventListener("click", () => {
                const step = getZoomStep(this.zoom - 0.1);
                this.setZoom(this.zoom - step);
            });
        }
        if (btnZoomFit) {
            btnZoomFit.addEventListener("click", () => {
                this.setZoom(1.0);
                if (this.container) {
                    this.container.scrollTo({ left: 0, behavior: 'smooth' });
                }
            });
        }

        // Ctrl + Mouse Wheel Zoom on timeline
        if (this.container) {
            this.container.addEventListener("wheel", (e) => {
                if (e.ctrlKey) {
                    e.preventDefault();
                    const step = getZoomStep(this.zoom);
                    const delta = e.deltaY < 0 ? step : -step;
                    this.setZoom(this.zoom + delta);
                }
            }, { passive: false });
        }
    }

    handleScrubMove(e) {
        if (!this.duration) return;
        const refElem = this.tracksContainer || this.ruler;
        if (!refElem) return;

        const rect = refElem.getBoundingClientRect();
        const clientX = (e.touches && e.touches[0]) ? e.touches[0].clientX : e.clientX;
        const clickX = clientX - rect.left;
        const ratio = Math.max(0, Math.min(1, clickX / rect.width));
        const seekTime = ratio * this.duration;

        // Immediately update cursor visually (zero lag 60fps)
        const percent = ratio * 100;
        if (this.cursor) {
            this.cursor.style.left = `${percent}%`;
        }

        // Show and update time tooltip
        if (this.tooltip) {
            this.tooltip.style.display = "block";
            this.tooltip.style.left = `${percent}%`;
            this.tooltip.innerText = `⏱ ${this.formatTime(seekTime)}`;
        }

        // Auto-scroll timeline container if zoomed in and cursor approaches edges
        if (this.container && this.zoom > 1.0) {
            const cRect = this.container.getBoundingClientRect();
            const edge = 45;
            if (clientX > cRect.right - edge) {
                this.container.scrollLeft += 15;
            } else if (clientX < cRect.left + edge) {
                this.container.scrollLeft -= 15;
            }
        }

        // Throttle video seek via requestAnimationFrame to keep rendering silky smooth
        this.pendingSeekTime = seekTime;
        if (!this.seekRafId) {
            this.seekRafId = requestAnimationFrame(() => {
                this.seekRafId = null;
                if (this.onSeek && this.pendingSeekTime !== null) {
                    this.onSeek(this.pendingSeekTime);
                }
            });
        }
    }

    initEvents() {
        const startScrub = (e) => {
            // Only allow left mouse button or touch
            if (e.button !== undefined && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();

            this.isScrubbing = true;
            this.isUserScrubbing = true;
            document.body.classList.add("is-timeline-scrubbing");
            if (this.cursor) {
                this.cursor.classList.add("is-active-dragging");
            }

            if (this.onScrubStart) {
                this.onScrubStart();
            }

            this.handleScrubMove(e);
        };

        const endScrub = () => {
            if (!this.isScrubbing) return;

            this.isScrubbing = false;
            document.body.classList.remove("is-timeline-scrubbing");
            if (this.cursor) {
                this.cursor.classList.remove("is-active-dragging");
            }

            if (this.tooltip) {
                this.tooltip.style.display = "none";
            }

            if (this.seekRafId) {
                cancelAnimationFrame(this.seekRafId);
                this.seekRafId = null;
            }

            const finalTime = this.pendingSeekTime;
            if (this.onSeek && finalTime !== null) {
                this.onSeek(finalTime);
            }

            if (this.onScrubEnd) {
                this.onScrubEnd(finalTime);
            }

            setTimeout(() => {
                this.isUserScrubbing = false;
            }, 60);
        };

        // Red playhead cursor grab listeners
        if (this.cursor) {
            this.cursor.addEventListener("mousedown", startScrub);
            this.cursor.addEventListener("touchstart", startScrub, { passive: false });
        }

        // Timeline ruler scrub listeners
        if (this.ruler) {
            this.ruler.addEventListener("mousedown", startScrub);
            this.ruler.addEventListener("touchstart", startScrub, { passive: false });
        }

        // Empty tracks scrub listeners
        if (this.tracksContainer) {
            this.tracksContainer.addEventListener("mousedown", (e) => {
                // If clicked on track background, not on a segment or resize handle
                if (e.target === this.tracksContainer || e.target.classList.contains("timeline-track")) {
                    startScrub(e);
                }
            });
        }

        // Global Mouse Move for Dragging / Resizing
        window.addEventListener("mousemove", (e) => {
            if (this.isScrubbing) {
                this.handleScrubMove(e);
                return;
            }

            if (!this.activeDrag) return;

            const d = this.activeDrag;
            const deltaX = e.clientX - d.startX;
            if (Math.abs(deltaX) > 3) {
                d.hasMoved = true;
            }

            const dt = (deltaX / d.trackWidth) * this.duration;
            let newStart = d.initialStart;
            let newEnd = d.initialEnd;
            const origDuration = d.initialEnd - d.initialStart;

            if (d.type === "move") {
                newStart = Math.max(0, d.initialStart + dt);
                newEnd = newStart + origDuration;
                if (newEnd > this.duration) {
                    newEnd = this.duration;
                    newStart = Math.max(0, newEnd - origDuration);
                }
            } else if (d.type === "resize-left") {
                newStart = Math.max(0, Math.min(d.initialEnd - 0.3, d.initialStart + dt));
                newEnd = d.initialEnd;
            } else if (d.type === "resize-right") {
                newStart = d.initialStart;
                newEnd = Math.min(this.duration, Math.max(d.initialStart + 0.3, d.initialEnd + dt));
            }

            // Snap
            newStart = Math.round(newStart * 100) / 100;
            newEnd = Math.round(newEnd * 100) / 100;

            d.seg.start = newStart;
            d.seg.end = newEnd;

            // Update DOM element visually immediately
            const leftPercent = Math.min(100, Math.max(0, (newStart / this.duration) * 100));
            const widthPercent = Math.min(100 - leftPercent, Math.max(0.4, ((newEnd - newStart) / this.duration) * 100));
            d.blockElem.style.left = `${leftPercent}%`;
            d.blockElem.style.width = `calc(${widthPercent}% - 3px)`;

            // Position and show Tooltip
            if (this.tooltip) {
                this.tooltip.style.display = "block";
                this.tooltip.style.left = `${leftPercent}%`;
                this.tooltip.innerText = `[#${d.seg.id}] ${this.formatTime(newStart)} ➔ ${this.formatTime(newEnd)}`;
            }
        });

        // Window touchmove
        window.addEventListener("touchmove", (e) => {
            if (this.isScrubbing) {
                this.handleScrubMove(e);
            }
        }, { passive: true });

        // Global Mouse Up
        window.addEventListener("mouseup", () => {
            if (this.isScrubbing) {
                endScrub();
                return;
            }

            if (!this.activeDrag) return;

            const d = this.activeDrag;
            d.blockElem.classList.remove("is-dragging");

            if (this.tooltip) {
                this.tooltip.style.display = "none";
            }

            // Drag finished — re-enable automatic cursor sync from video time
            this.isUserScrubbing = false;

            if (!d.hasMoved) {
                // Was just a click, trigger select
                if (this.onSelectSegment) {
                    this.onSelectSegment(d.seg);
                }
            } else {
                // Moved or Resized! Trigger change callback
                if (this.onSegmentChange) {
                    this.onSegmentChange(d.seg);
                }
            }

            this.activeDrag = null;
        });

        // Window touchend
        window.addEventListener("touchend", () => {
            if (this.isScrubbing) {
                endScrub();
            }
        });
    }

    scrollToSegment(segId) {
        if (!this.container || !this.tracksContainer) return;
        const block = this.tracksContainer.querySelector(`.track-block[data-id="${segId}"]`);
        if (block) {
            const containerW = this.container.clientWidth;
            const blockLeft = block.offsetLeft;
            const blockW = block.offsetWidth;
            this.container.scrollTo({
                left: Math.max(0, blockLeft - (containerW / 2) + (blockW / 2)),
                behavior: 'smooth'
            });
        }
    }
}
