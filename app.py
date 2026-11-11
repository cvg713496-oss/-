import os
import sys
import io

class _SafeNullStream(io.TextIOBase):
    """Fallback stream when running under pythonw.exe where stdout/stderr are None."""
    encoding = "utf-8"
    def write(self, s):
        return len(s) if isinstance(s, str) else 0
    def flush(self):
        pass
    def isatty(self):
        return False

if sys.stdout is None or not hasattr(sys.stdout, "write"):
    sys.stdout = _SafeNullStream()
if sys.stderr is None or not hasattr(sys.stderr, "write"):
    sys.stderr = _SafeNullStream()

import threading
import subprocess
import shutil
import uuid
import json
import logging
import asyncio
import time
from typing import Dict, Any
from concurrent.futures import ThreadPoolExecutor
from flask import Flask, request, jsonify, send_file, send_from_directory

from services.whisper_service import WhisperService
from services.translator_service import TranslatorService
from services.tts_service import TTSService
from services.video_service import VideoService
from services.update_service import UpdateService

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("VocalStudio")

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config['MAX_CONTENT_LENGTH'] = 4 * 1024 * 1024 * 1024  # Support up to 4GB video uploads

# Ensure required directories exist
for d in ["uploads", "outputs", "temp", "sample", "static"]:
    os.makedirs(d, exist_ok=True)

whisper_service = WhisperService()
translator_service = TranslatorService()
tts_service = TTSService()
video_service = VideoService(tts_service=tts_service)
update_service = UpdateService(base_dir=".")

# Dedicated thread pools so critical user tasks never starve or wait behind background jobs
auto_process_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="auto_proc")
export_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="export")
media_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="media")
preload_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="preload")
_preload_cancel_event = threading.Event()

# Legacy alias
thread_pool = media_pool

@app.route("/")
def index():
    return send_file(os.path.join("static", "index.html"))

@app.route("/uploads/<path:filename>")
def serve_uploads(filename):
    return send_from_directory("uploads", filename)

@app.route("/outputs/<path:filename>")
def serve_outputs(filename):
    return send_from_directory("outputs", filename)

@app.route("/sample_video.mp4")
def serve_sample():
    sample_path = "sample_video.mp4"
    if os.path.exists(sample_path):
        return send_file(sample_path, mimetype="video/mp4")
    return jsonify({"error": "Sample video not found"}), 404

def auto_cleanup_stale_files(min_free_gb=5.0):
    """Ensure disk space is kept clean by removing old temporary files and batches."""
    try:
        import shutil, time, glob
        total, used, free = shutil.disk_usage("uploads")
        free_gb = free / (1024 ** 3)
        now = time.time()
        # Always remove stale batch folders older than 30 mins
        for b_dir in glob.glob("uploads/batch_*"):
            try:
                if (now - os.path.getmtime(b_dir)) > 1800:
                    shutil.rmtree(b_dir, ignore_errors=True)
            except Exception:
                pass

        # Clean render_temp files older than 30 mins
        for rt_file in glob.glob("outputs/render_temp/*"):
            try:
                if (now - os.path.getmtime(rt_file)) > 1800:
                    os.remove(rt_file)
            except Exception:
                pass

        # If free space is below min_free_gb, aggressively clean older temporary and merged files
        if free_gb < min_free_gb:
            logger.info(f"Free disk space low ({free_gb:.1f} GB < {min_free_gb} GB). Running cleanup...")
            for pattern in [
                "uploads/norm_*.ts",
                "uploads/concat_list_*.txt",
                "uploads/concat_ts_*.txt",
                "uploads/annexb_*.ts",
                "uploads/*_temp.wav",
                "uploads/*_tmp*.wav",
                "uploads/*_raw.wav",
                "uploads/*_gender_tmp.wav",
                "uploads/*_pitch*.wav",
                "uploads/extracted_bgm_*.mp3",
                "uploads/merged_*_series.mp4",
                "uploads/proxy_*.mp4",
                "outputs/*.wav"
            ]:
                for fpath in glob.glob(pattern):
                    try:
                        if os.path.exists(fpath) and (now - os.path.getmtime(fpath)) > 900:
                            os.remove(fpath)
                    except Exception:
                        pass

            # Clean temporary single uploads older than 2 hours if not actively needed
            for fpath in glob.glob("uploads/*_*.mp4"):
                try:
                    if os.path.exists(fpath) and (now - os.path.getmtime(fpath)) > 7200:
                        os.remove(fpath)
                except Exception:
                    pass

            # Protect rendered mp4 outputs: only clean up if older than 7 days (604800s)
            for fpath in glob.glob("outputs/*.mp4"):
                try:
                    if os.path.exists(fpath) and (now - os.path.getmtime(fpath)) > 604800:
                        os.remove(fpath)
                except Exception:
                    pass
    except Exception as e:
        logger.warning(f"Auto-cleanup error: {e}")

@app.route("/api/upload-video", methods=["POST"])
def upload_video():
    """Upload user video and inspect metadata."""
    try:
        auto_cleanup_stale_files()
        if "file" not in request.files:
            return jsonify({"detail": "No file uploaded"}), 400

        file = request.files["file"]
        if not file or not file.filename:
            return jsonify({"detail": "No file received"}), 400

        file_id = str(uuid.uuid4())[:8]
        clean_name = os.path.basename(file.filename)
        safe_name = f"{file_id}_{clean_name}"
        save_path = os.path.join("uploads", safe_name)
        file.save(save_path)

        info = video_service.get_video_info(save_path)
        info["video_path"] = save_path
        info["url"] = f"/uploads/{safe_name}"

        # Run BGM separation in background thread, waiting up to 3.5s for fast response
        bgm_output = os.path.join("uploads", f"extracted_bgm_{file_id}.mp3")
        bgm_job = media_pool.submit(video_service.extract_and_separate_bgm, save_path, bgm_output)
        try:
            bgm_job.result(timeout=3.5)
            info["bgm_ready"] = True
        except Exception:
            info["bgm_ready"] = False

        info["extracted_bgm_path"] = bgm_output
        info["extracted_bgm_url"] = f"/uploads/extracted_bgm_{file_id}.mp3"

        # Pre-generate lightweight 480p preview proxy for stutter-free playback and instant scrubbing
        proxy_filename = f"proxy_{file_id}_{clean_name}"
        proxy_path = os.path.join("uploads", proxy_filename)
        def _proxy_job():
            try:
                video_service.create_preview_proxy(save_path, proxy_path, target_height=480)
            except Exception as pe:
                logger.error(f"Async proxy generation error: {pe}")
        media_pool.submit(_proxy_job)

        info["proxy_path"] = proxy_path
        info["proxy_url"] = f"/uploads/{proxy_filename}"

        return jsonify(info)
    except Exception as e:
        logger.error(f"Error handling video upload: {e}")
        return jsonify({"detail": f"Upload processing error: {str(e)}"}), 500

def _natural_sort_key(s: str):
    import re
    return [int(text) if text.isdigit() else text.lower() for text in re.split(r'(\d+)', s)]

@app.route("/api/upload-and-merge-videos", methods=["POST"])
def upload_and_merge_videos():
    """Upload multiple short video clips, sort naturally (ep1, ep2, ep10...) and merge into 1 seamless video."""
    uploaded_files = request.files.getlist("files")
    if not uploaded_files:
        uploaded_files = [f for k, f in request.files.items() if f.filename]

    if not uploaded_files:
        return jsonify({"detail": "មិនមានឯកសារវីដេអូត្រូវបានបញ្ចូលទេ"}), 400

    batch_id = str(uuid.uuid4())[:8]
    batch_dir = os.path.join("uploads", f"batch_{batch_id}")
    os.makedirs(batch_dir, exist_ok=True)

    # Auto-cleanup stale temporary files when free disk space drops below 2.5 GB
    try:
        import shutil, glob, time
        total, used, free = shutil.disk_usage("uploads")
        if free < 2.5 * 1024 * 1024 * 1024:
            logger.info("Free disk space is low (<2.5GB). Auto-cleaning stale test files...")
            now = time.time()
            for pattern in ["uploads/merged_*_series.mp4", "uploads/proxy_merged_*.mp4", "uploads/*_temp.wav"]:
                for old_f in glob.glob(pattern):
                    try:
                        if os.path.exists(old_f) and (now - os.path.getmtime(old_f)) > 7200:
                            os.remove(old_f)
                    except Exception:
                        pass
    except Exception as e:
        logger.warning(f"Disk check warning: {e}")

    # Check if client provided custom ordered filenames
    order_data = request.form.get("file_order")
    client_order = []
    if order_data:
        try:
            client_order = json.loads(order_data)
        except Exception:
            pass

    # Save each uploaded file
    saved_map = {}
    for f in uploaded_files:
        orig_name = f.filename
        save_path = os.path.join(batch_dir, orig_name)
        f.save(save_path)
        saved_map[orig_name] = save_path

    # Build sorted/ordered list of file paths
    ordered_paths = []
    if client_order:
        for name in client_order:
            if name in saved_map:
                ordered_paths.append(saved_map[name])

    # Add any remaining files sorted naturally (1 -> 2 -> 10)
    remaining = [p for p in saved_map.values() if p not in ordered_paths]
    remaining.sort(key=lambda p: _natural_sort_key(os.path.basename(p)))
    ordered_paths.extend(remaining)

    if not ordered_paths:
        return jsonify({"detail": "No valid video files saved"}), 400

    merged_filename = f"merged_{batch_id}_series.mp4"
    merged_path = os.path.join("uploads", merged_filename)

    logger.info(f"Merging {len(ordered_paths)} video clips in natural order into {merged_path}...")
    success = video_service.merge_video_files(ordered_paths, merged_path)
    if not success or not os.path.exists(merged_path):
        return jsonify({"detail": "ការបញ្ចូលវីដេអូជាច្រើនចូលគ្នាបរាជ័យ សូមពិនិត្យឯកសារ"}), 500

    # Clean raw clips in batch_dir immediately to save disk space
    import shutil
    try:
        shutil.rmtree(batch_dir, ignore_errors=True)
    except Exception:
        pass

    info = video_service.get_video_info(merged_path)
    info["video_path"] = merged_path
    info["url"] = f"/uploads/{merged_filename}"
    info["merged_count"] = len(ordered_paths)
    info["filename"] = f"សម្រាយរឿង ({len(ordered_paths)} ភាគ)"

    # Trigger background BGM separation on merged video, waiting up to 3.5s for fast response
    bgm_output = os.path.join("uploads", f"extracted_bgm_{batch_id}.mp3")
    bgm_job = media_pool.submit(video_service.extract_and_separate_bgm, merged_path, bgm_output)
    try:
        bgm_job.result(timeout=3.5)
        info["bgm_ready"] = True
    except Exception:
        info["bgm_ready"] = False

    info["extracted_bgm_path"] = bgm_output
    info["extracted_bgm_url"] = f"/uploads/extracted_bgm_{batch_id}.mp3"

    # Pre-generate lightweight 480p preview proxy in background only when needed (skip if already <=540p or >15min series)
    proxy_filename = f"proxy_{merged_filename}"
    proxy_path = os.path.join("uploads", proxy_filename)
    min_dim = min(info.get("width", 1280), info.get("height", 720))
    if min_dim <= 540 or info.get("duration", 0) > 900:
        info["proxy_path"] = None
        info["proxy_url"] = None
    else:
        media_pool.submit(video_service.create_preview_proxy, merged_path, proxy_path, 480)
        info["proxy_path"] = proxy_path
        info["proxy_url"] = f"/uploads/{proxy_filename}"

    return jsonify(info)

@app.route("/api/batch-upload/init", methods=["POST"])
def batch_upload_init():
    """Initialize a batch session for multi-episode series upload."""
    auto_cleanup_stale_files()
    batch_id = str(uuid.uuid4())[:8]
    batch_dir = os.path.join("uploads", f"batch_{batch_id}")
    os.makedirs(batch_dir, exist_ok=True)
    return jsonify({"ok": True, "batch_id": batch_id})

@app.route("/api/batch-upload/clip", methods=["POST"])
def batch_upload_clip():
    """Upload a single clip belonging to a batch session."""
    try:
        batch_id = request.form.get("batch_id")
        if not batch_id or not batch_id.isalnum():
            return jsonify({"detail": "Invalid batch_id"}), 400
        
        batch_dir = os.path.join("uploads", f"batch_{batch_id}")
        os.makedirs(batch_dir, exist_ok=True)
        
        file = request.files.get("file")
        if not file or not file.filename:
            return jsonify({"detail": "No file received"}), 400
        
        safe_name = os.path.basename(file.filename)
        save_path = os.path.join(batch_dir, safe_name)
        file.save(save_path)
        return jsonify({"ok": True, "filename": safe_name})
    except Exception as e:
        logger.error(f"Error saving batch clip: {e}")
        return jsonify({"detail": f"Upload error: {str(e)}"}), 500

@app.route("/api/batch-upload/merge", methods=["POST"])
def batch_upload_merge():
    """Merge all uploaded clips in a batch into a single continuous video."""
    data = request.get_json() or {}
    batch_id = data.get("batch_id")
    client_order = data.get("file_order", [])

    if not batch_id or not batch_id.isalnum():
        return jsonify({"detail": "Invalid batch_id"}), 400

    batch_dir = os.path.join("uploads", f"batch_{batch_id}")
    if not os.path.exists(batch_dir):
        return jsonify({"detail": "Batch directory not found"}), 404

    saved_files = [f for f in os.listdir(batch_dir) if os.path.isfile(os.path.join(batch_dir, f))]
    if not saved_files:
        return jsonify({"detail": "No video clips found in batch"}), 400

    saved_map = {f: os.path.join(batch_dir, f) for f in saved_files}
    ordered_paths = []
    if client_order:
        for name in client_order:
            if name in saved_map:
                ordered_paths.append(saved_map[name])
    
    remaining = [p for p in saved_map.values() if p not in ordered_paths]
    remaining.sort(key=lambda p: _natural_sort_key(os.path.basename(p)))
    ordered_paths.extend(remaining)

    if not ordered_paths:
        return jsonify({"detail": "No valid clips to merge"}), 400

    merged_filename = f"merged_{batch_id}_series.mp4"
    merged_path = os.path.join("uploads", merged_filename)

    logger.info(f"Merging {len(ordered_paths)} clips for batch {batch_id}...")
    success = video_service.merge_video_files(ordered_paths, merged_path)
    if not success or not os.path.exists(merged_path):
        return jsonify({"detail": "ការបញ្ចូលវីដេអូបរាជ័យ សូមពិនិត្យឯកសារ"}), 500

    # IMMEDIATELY delete raw individual clips to free disk space
    import shutil
    try:
        shutil.rmtree(batch_dir, ignore_errors=True)
    except Exception as e_rm:
        logger.warning(f"Could not remove batch dir {batch_dir}: {e_rm}")

    info = video_service.get_video_info(merged_path)
    info["video_path"] = merged_path
    info["url"] = f"/uploads/{merged_filename}"
    info["merged_count"] = len(ordered_paths)
    info["filename"] = f"សម្រាយរឿង ({len(ordered_paths)} ភាគ)"

    # Background BGM separation
    bgm_output = os.path.join("uploads", f"extracted_bgm_{batch_id}.mp3")
    bgm_job = media_pool.submit(video_service.extract_and_separate_bgm, merged_path, bgm_output)
    try:
        bgm_job.result(timeout=3.5)
        info["bgm_ready"] = True
    except Exception:
        info["bgm_ready"] = False

    info["extracted_bgm_path"] = bgm_output
    info["extracted_bgm_url"] = f"/uploads/extracted_bgm_{batch_id}.mp3"

    # Pre-generate lightweight 480p preview proxy in background only when needed (skip if already <=540p or >15min series)
    proxy_filename = f"proxy_{merged_filename}"
    proxy_path = os.path.join("uploads", proxy_filename)
    min_dim = min(info.get("width", 1280), info.get("height", 720))
    if min_dim <= 540 or info.get("duration", 0) > 900:
        info["proxy_path"] = None
        info["proxy_url"] = None
    else:
        media_pool.submit(video_service.create_preview_proxy, merged_path, proxy_path, 480)
        info["proxy_path"] = proxy_path
        info["proxy_url"] = f"/uploads/{proxy_filename}"
    return jsonify(info)

@app.route("/api/save-thumbnail", methods=["POST"])
def save_thumbnail():
    """Save generated thumbnail image (base64 PNG) to uploads directory."""
    data = request.get_json() or {}
    image_b64 = data.get("image_base64")
    if not image_b64:
        return jsonify({"detail": "No image data provided"}), 400

    try:
        import base64
        if "," in image_b64:
            image_b64 = image_b64.split(",", 1)[1]
        raw_bytes = base64.b64decode(image_b64)
        file_id = str(uuid.uuid4())[:8]
        filename = f"thumbnail_{file_id}.png"
        save_path = os.path.join("uploads", filename)
        with open(save_path, "wb") as f:
            f.write(raw_bytes)
        return jsonify({
            "success": True,
            "path": save_path,
            "url": f"/uploads/{filename}",
            "filename": filename
        })
    except Exception as e:
        logger.error(f"Failed to save thumbnail: {e}")
        return jsonify({"detail": str(e)}), 500

@app.route("/api/upload-thumbnail-image", methods=["POST"])
def upload_thumbnail_image():
    """Upload custom image file for thumbnail background."""
    if "file" not in request.files:
        return jsonify({"detail": "No file uploaded"}), 400
    file = request.files["file"]
    file_id = str(uuid.uuid4())[:8]
    ext = os.path.splitext(file.filename)[1].lower() or ".png"
    safe_name = f"thumb_bg_{file_id}{ext}"
    save_path = os.path.join("uploads", safe_name)
    file.save(save_path)
    return jsonify({"success": True, "path": save_path, "url": f"/uploads/{safe_name}"})

@app.route("/api/upload-bgm", methods=["POST"])
def upload_bgm():
    """Upload background music."""
    if "file" not in request.files:
        return jsonify({"detail": "No file uploaded"}), 400

    file = request.files["file"]
    file_id = str(uuid.uuid4())[:8]
    safe_name = f"bgm_{file_id}_{file.filename}"
    save_path = os.path.join("uploads", safe_name)
    file.save(save_path)
    return jsonify({"bgm_path": save_path, "url": f"/uploads/{safe_name}"})

@app.route("/api/extract-original-audio", methods=["POST"])
def extract_original_audio():
    """Extract original video audio track into high-bitrate MP3 for external AI processing."""
    data = request.get_json() or {}
    video_path = data.get("video_path")
    if not video_path or not os.path.exists(video_path):
        return jsonify({"detail": "Video file not found"}), 404

    base = os.path.splitext(os.path.basename(video_path))[0]
    out_name = f"audio_{base}.mp3"
    out_path = os.path.join("uploads", out_name)

    if not os.path.exists(out_path) or os.path.getsize(out_path) < 1000:
        cmd = ["ffmpeg", "-y", "-i", video_path, "-vn", "-c:a", "libmp3lame", "-b:a", "320k", out_path]
        subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    if os.path.exists(out_path):
        return jsonify({"success": True, "url": f"/uploads/{out_name}", "filename": out_name})
    return jsonify({"detail": "Extraction failed"}), 500

@app.route("/api/check-bgm", methods=["POST"])
def check_bgm():
    """Check if separated video BGM is ready, or trigger background extraction once without blocking."""
    data = request.get_json() or {}
    bgm_path = data.get("bgm_path")
    video_path = data.get("video_path")
    force = bool(data.get("force", False))

    if not force and bgm_path and os.path.exists(bgm_path) and os.path.getsize(bgm_path) > 1000:
        filename = os.path.basename(bgm_path)
        mtime = int(os.path.getmtime(bgm_path))
        return jsonify({"ready": True, "url": f"/uploads/{filename}?t={mtime}", "path": bgm_path})

    if video_path and os.path.exists(video_path):
        if not bgm_path:
            base_name = os.path.splitext(os.path.basename(video_path))[0]
            parts = base_name.split('_')
            file_id = parts[1] if (parts[0] == "merged" and len(parts) > 1) else parts[0]
            bgm_path = os.path.join("uploads", f"extracted_bgm_{file_id}.mp3")
        if not force and os.path.exists(bgm_path) and os.path.getsize(bgm_path) > 1000:
            filename = os.path.basename(bgm_path)
            mtime = int(os.path.getmtime(bgm_path))
            return jsonify({"ready": True, "url": f"/uploads/{filename}?t={mtime}", "path": bgm_path})

        # Do not block HTTP thread or spawn duplicate FFmpeg processes while Whisper or BGM is running
        if not video_service.is_bgm_extracting(bgm_path) and not whisper_service.is_transcribing():
            media_pool.submit(video_service.extract_and_separate_bgm, video_path, bgm_path)

    return jsonify({"ready": False})

@app.route("/api/upload-logo", methods=["POST"])
def upload_logo():
    """Upload custom image logo or animated GIF/video logo."""
    if "file" not in request.files:
        return jsonify({"detail": "No logo uploaded"}), 400

    file = request.files["file"]
    file_id = str(uuid.uuid4())[:8]
    ext = os.path.splitext(file.filename)[1].lower()
    safe_name = f"logo_{file_id}{ext}"
    save_path = os.path.join("uploads", safe_name)
    file.save(save_path)
    return jsonify({"logo_path": save_path, "url": f"/uploads/{safe_name}"})

@app.route("/api/transcribe", methods=["POST"])
def transcribe():
    """Transcribe Chinese speech using Whisper."""
    data = request.get_json() or {}
    video_path = data.get("video_path")
    model_name = data.get("model_name", "base")
    language = data.get("language", "zh")

    if not video_path or not os.path.exists(video_path):
        return jsonify({"detail": "Video file not found"}), 404

    # Check cache
    cache_path = video_path + f"_{model_name}_whisper.json"
    if os.path.exists(cache_path):
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                cached_data = json.load(f)
                return jsonify({"segments": cached_data})
        except Exception:
            pass

    try:
        segments = whisper_service.transcribe(
            audio_or_video_path=video_path,
            model_name=model_name,
            language=language
        )
        try:
            with open(cache_path, "w", encoding="utf-8") as f:
                json.dump(segments, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

        return jsonify({"segments": segments})
    except Exception as e:
        logger.error(f"Transcription failed: {e}")
        return jsonify({"detail": str(e)}), 500

@app.route("/api/translate", methods=["POST"])
def translate():
    """Translate segments from Chinese to Khmer."""
    data = request.get_json() or {}
    segments = data.get("segments", [])
    recap_style = data.get("recap_style", True)

    try:
        _apply_settings_to_translator(_load_settings())
        translated_segs = translator_service.translate_segments(segments, recap_style=recap_style)
        return jsonify({"segments": translated_segs})
    except Exception as e:
        logger.error(f"Translation failed: {e}")
        return jsonify({"detail": str(e)}), 500

@app.route("/api/detect-genders", methods=["POST"])
def detect_genders():
    """Analyze video audio pitch to automatically detect and assign male/female characters."""
    data = request.get_json() or {}
    video_path = data.get("video_path")
    segments = data.get("segments", [])
    actor1_voice = data.get("actor1_voice", "km-KH-PisethNeural")
    actor2_voice = data.get("actor2_voice", "km-KH-SreymomNeural")

    if not video_path or not os.path.exists(video_path):
        return jsonify({"detail": "រកមិនឃើញឯកសារវីដេអូទេ"}), 404

    if not segments:
        return jsonify({"detail": "មិនទាន់មានឃ្លា (Segments) សម្រាប់បែងចែកទេ"}), 400

    mode = data.get("mode", "auto")  # "gemini" | "acoustic" | "auto"
    gemini_key = getattr(translator_service, "gemini_key", "")
    if not gemini_key:
        try:
            with open("settings.json", "r", encoding="utf-8") as f:
                gemini_key = json.load(f).get("gemini_key", "")
        except Exception:
            pass

    used_engine = "Acoustic Pitch (YIN)"
    try:
        if (mode == "gemini" or (mode == "auto" and gemini_key)) and gemini_key:
            try:
                logger.info(f"Running Gemini Multimodal Audio Diarization for {len(segments)} segments...")
                updated_segments = whisper_service.detect_segments_gender_gemini(
                    video_or_audio_path=video_path,
                    segments=segments,
                    gemini_key=gemini_key,
                    actor1_voice=actor1_voice,
                    actor2_voice=actor2_voice
                )
                used_engine = "Google Gemini AI (ស្ដាប់សំឡេង + យល់សាច់រឿង)"
            except Exception as ge:
                logger.warning(f"Gemini diarization failed ({ge}); falling back to local acoustic pitch...")
                updated_segments = whisper_service.detect_segments_gender(
                    video_or_audio_path=video_path,
                    segments=segments,
                    actor1_voice=actor1_voice,
                    actor2_voice=actor2_voice
                )
        else:
            updated_segments = whisper_service.detect_segments_gender(
                video_or_audio_path=video_path,
                segments=segments,
                actor1_voice=actor1_voice,
                actor2_voice=actor2_voice
            )

        # Persist updated segments to cache file on disk
        saved = False
        for m_name in ["base", "tiny", "small", "medium"]:
            cache_file = video_path + f"_{m_name}_full.json"
            if os.path.exists(cache_file):
                try:
                    with open(cache_file, "w", encoding="utf-8") as f:
                        json.dump(updated_segments, f, ensure_ascii=False, indent=2)
                    saved = True
                except Exception as ce:
                    logger.warning(f"Failed to update cache {cache_file}: {ce}")
        if not saved:
            try:
                with open(video_path + "_base_full.json", "w", encoding="utf-8") as f:
                    json.dump(updated_segments, f, ensure_ascii=False, indent=2)
            except Exception:
                pass

        engine_kh = "Google Gemini AI (ស្ដាប់សំឡេង + យល់សាច់រឿង)" if "Gemini" in used_engine else "Acoustic Pitch (វាស់រលកសំឡេង)"
        return jsonify({
            "segments": updated_segments,
            "engine": used_engine,
            "message": f"បានវិភាគតាម {engine_kh} និងបែងចែកតួអង្គប្រុស/ស្រីដោយជោគជ័យ!"
        })
    except Exception as e:
        logger.error(f"Gender detection failed: {e}")
        return jsonify({"detail": str(e)}), 500

@app.route("/api/generate-proxy", methods=["POST"])
def generate_proxy():
    """Generate a lightweight 480p preview proxy for smooth playback and instant seeking."""
    data = request.get_json() or {}
    video_path = data.get("video_path")
    if not video_path or not os.path.exists(video_path):
        return jsonify({"detail": "រកមិនឃើញឯកសារវីដេអូដើមទេ"}), 404

    base_name = os.path.splitext(os.path.basename(video_path))[0]
    proxy_filename = f"proxy_{base_name}.mp4"
    proxy_path = os.path.join("uploads", proxy_filename)

    if os.path.exists(proxy_path) and os.path.getsize(proxy_path) > 1024:
        return jsonify({
            "proxy_path": proxy_path,
            "proxy_url": f"/uploads/{proxy_filename}",
            "message": "បានទាញយក Preview Proxy រួចរាល់!"
        })

    success = video_service.create_preview_proxy(video_path, proxy_path, target_height=480)
    if not success or not os.path.exists(proxy_path):
        return jsonify({"detail": "ការបង្កើត Preview Proxy បរាជ័យ"}), 500

    return jsonify({
        "proxy_path": proxy_path,
        "proxy_url": f"/uploads/{proxy_filename}",
        "message": "បានបង្កើត Preview Proxy 480p ជោគជ័យ!"
    })

# ── Long Video Asynchronous Processing Jobs ──────────────────────────────────
AUTO_PROCESS_JOBS: Dict[str, Dict[str, Any]] = {}
EXPORT_JOBS: Dict[str, Dict[str, Any]] = {}

def _format_sec_to_min(sec: float) -> str:
    m = int(sec // 60)
    s = int(sec % 60)
    return f"{m}:{s:02d}"

@app.route("/api/start-auto-process", methods=["POST"])
def start_auto_process():
    """Asynchronous background worker for long videos (1-3 hours) with live status updates."""
    data = request.get_json() or {}
    video_path = data.get("video_path")
    model_name = data.get("model_name", "base")
    language = data.get("language", "zh")
    recap_style = data.get("recap_style", True)
    force = data.get("force", False)

    if not video_path or not os.path.exists(video_path):
        return jsonify({"detail": "Video file not found"}), 404

    cache_full_path = video_path + f"_{model_name}_full.json"
    if not force and os.path.exists(cache_full_path):
        try:
            with open(cache_full_path, "r", encoding="utf-8") as f:
                cached_data = json.load(f)
                has_corrupt_seg = any(
                    (float(s.get("end", 0)) - float(s.get("start", 0)) >= 6.45 and len(s.get("original", "")) <= 7)
                    for s in cached_data
                )
                import re
                has_untranslated = any(
                    bool(re.search(r'[\u4e00-\u9fff]', s.get("translated", "")))
                    or not s.get("translated", "").strip()
                    or s.get("translated", "").strip() == s.get("original", "").strip()
                    for s in cached_data if s.get("original", "").strip()
                )
                if not has_corrupt_seg and not has_untranslated and len(cached_data) > 0:
                    job_id = f"cached_{str(uuid.uuid4())[:8]}"
                    AUTO_PROCESS_JOBS[job_id] = {
                        "status": "completed",
                        "progress": 100,
                        "message": "ទិន្នន័យត្រូវបានទាញចេញពី Cache រួចរាល់!",
                        "segments": cached_data,
                        "error": None
                    }
                    return jsonify({"job_id": job_id, "status": "completed", "segments": cached_data})
        except Exception:
            pass

    # Immediately cancel any background TTS preloading so full CPU & network are available
    global _preload_cancel_event
    _preload_cancel_event.set()

    job_id = f"job_{str(uuid.uuid4())[:10]}"
    AUTO_PROCESS_JOBS[job_id] = {
        "status": "running",
        "progress": 5,
        "message": "កំពុងរៀបចំ និងត្រួតពិនិត្យទិន្នន័យវីដេអូរយៈពេលវែង...",
        "segments": None,
        "error": None,
        "created_at": time.time()
    }

    def _worker():
        job = AUTO_PROCESS_JOBS[job_id]
        try:
            job["progress"] = 10
            job["message"] = "កំពុងទាញយកសំឡេង Audio ចេញពីវីដេអូ (FFmpeg)..."

            if whisper_service.is_transcribing():
                job["message"] = "កំពុងរង់ចាំ Whisper បញ្ចប់វីដេអូមុន... (Queue)"

            def _whisper_progress(pct, curr_sec, total_sec, status_text=None):
                if status_text:
                    job["message"] = status_text
                    return
                # Scale Whisper progress from 15% to 75%
                job["progress"] = int(15 + (pct * 60))
                c_str = _format_sec_to_min(curr_sec)
                t_str = _format_sec_to_min(total_sec)
                job["message"] = f"Whisper កំពុងស្តាប់ និងចាប់សំឡេង {int(pct*100)}% ({c_str} / {t_str})..."

            segments = whisper_service.transcribe(
                audio_or_video_path=video_path,
                model_name=model_name,
                language=language,
                progress_callback=_whisper_progress
            )

            # Apply latest user API keys and priority before translation
            _apply_settings_to_translator(_load_settings())
            active_p = (translator_service.priority or "gemini").lower()
            if active_p == "gemini":
                provider_label = "Gemini AI"
            elif active_p == "google_cloud":
                provider_label = "Google Cloud"
            elif active_p == "deepl":
                provider_label = "DeepL"
            elif active_p == "openai":
                provider_label = "OpenAI"
            else:
                provider_label = "AI"

            job["progress"] = 75
            job["message"] = f"ទទួលបាន {len(segments)} ឃ្លា! កំពុងចាប់ផ្តើមបកប្រែជាភាសាខ្មែរតាមរយៈ {provider_label}..."

            def _trans_progress(completed, total):
                # Scale Translation progress from 75% to 95%
                pct = completed / max(1, total)
                job["progress"] = int(75 + (pct * 20))
                job["message"] = f"កំពុងបកប្រែជាភាសាខ្មែរតាមរយៈ {provider_label} {int(pct*100)}% ({completed} / {total} ឃ្លា)..."

            translated_segs = translator_service.translate_segments(
                segments, recap_style=recap_style, progress_callback=_trans_progress
            )

            try:
                with open(cache_full_path, "w", encoding="utf-8") as f:
                    json.dump(translated_segs, f, ensure_ascii=False, indent=2)
            except Exception:
                pass

            # Automatically regenerate 100% speech-free BGM in background so UI completes immediately
            try:
                base_name = os.path.splitext(os.path.basename(video_path))[0]
                parts = base_name.split('_')
                file_id = parts[1] if (parts[0] == "merged" and len(parts) > 1) else parts[0]
                bgm_output = os.path.join("uploads", f"extracted_bgm_{file_id}.mp3")
                media_pool.submit(video_service.extract_and_separate_bgm, video_path, bgm_output, translated_segs)
            except Exception as be:
                logger.error(f"Error scheduling speech-free BGM regeneration: {be}")

            job["progress"] = 100
            job["message"] = f"🎉 ជោគជ័យ! បកប្រែបានសម្រេច {len(translated_segs)} ឃ្លា!"
            job["segments"] = translated_segs
            job["status"] = "completed"
        except Exception as e:
            logger.error(f"Auto-process job {job_id} failed: {e}")
            job["status"] = "error"
            job["error"] = str(e)
            job["message"] = f"កំហុស៖ {str(e)}"

    auto_process_pool.submit(_worker)
    return jsonify({"job_id": job_id, "status": "running"})

@app.route("/api/job-status/<job_id>", methods=["GET"])
def get_job_status(job_id):
    """Poll job status for long background processing."""
    job = AUTO_PROCESS_JOBS.get(job_id)
    if not job:
        return jsonify({"detail": "Job not found"}), 404
    return jsonify({
        "job_id": job_id,
        "status": job.get("status", "running"),
        "progress": job.get("progress", 0),
        "message": job.get("message", ""),
        "segments": job.get("segments") if job.get("status") == "completed" else None,
        "error": job.get("error")
    })

@app.route("/api/auto-process", methods=["POST"])
def auto_process():
    """One-click: Transcribe Chinese speech AND translate to Khmer (Synchronous fallback)."""
    data = request.get_json() or {}
    video_path = data.get("video_path")
    model_name = data.get("model_name", "base")
    language = data.get("language", "zh")
    recap_style = data.get("recap_style", True)

    if not video_path or not os.path.exists(video_path):
        return jsonify({"detail": "Video file not found"}), 404

    force = data.get("force", False)

    # Check cached translation
    cache_full_path = video_path + f"_{model_name}_full.json"
    if not force and os.path.exists(cache_full_path):
        try:
            with open(cache_full_path, "r", encoding="utf-8") as f:
                cached_data = json.load(f)
                has_corrupt_seg = any(
                    (float(s.get("end", 0)) - float(s.get("start", 0)) >= 6.45 and len(s.get("original", "")) <= 7)
                    for s in cached_data
                )
                import re
                has_untranslated = any(
                    bool(re.search(r'[\u4e00-\u9fff]', s.get("translated", "")))
                    or not s.get("translated", "").strip()
                    or s.get("translated", "").strip() == s.get("original", "").strip()
                    for s in cached_data if s.get("original", "").strip()
                )
                if not has_corrupt_seg and not has_untranslated and len(cached_data) > 0:
                    return jsonify({"segments": cached_data})
        except Exception:
            pass

    try:
        segments = whisper_service.transcribe(
            audio_or_video_path=video_path,
            model_name=model_name,
            language=language
        )
        translated_segs = translator_service.translate_segments(segments, recap_style=recap_style)

        try:
            with open(cache_full_path, "w", encoding="utf-8") as f:
                json.dump(translated_segs, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

        return jsonify({"segments": translated_segs})
    except Exception as e:
        logger.error(f"Auto-process failed: {e}")
        return jsonify({"detail": str(e)}), 500

# ── Settings: API Keys ────────────────────────────────────────────────────────
SETTINGS_FILE = os.path.join("uploads", "_settings.json")
BACKUP_SETTINGS_FILE = os.path.join(".", "settings.json")

def _load_settings() -> dict:
    for path in [SETTINGS_FILE, BACKUP_SETTINGS_FILE]:
        try:
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if data and any(data.values()):
                        return data
        except Exception:
            pass
    return {}

def _apply_settings_to_translator(s: dict):
    """Push saved API keys into the running translator_service."""
    translator_service.google_cloud_key = s.get("google_cloud_key", "").strip()
    translator_service.deepl_key        = s.get("deepl_key", "").strip()
    translator_service.gemini_key       = s.get("gemini_key", "").strip()
    translator_service.openai_key       = s.get("openai_key", "").strip()
    translator_service.priority         = s.get("priority", "auto").strip()
    logger.info(f"Applied translator settings: priority={translator_service.priority}, has_gemini={bool(translator_service.gemini_key)}")

# Load settings at startup
_apply_settings_to_translator(_load_settings())

@app.route("/api/settings", methods=["GET"])
def get_settings():
    """Return saved API keys (stored permanently in _settings.json)."""
    s = _load_settings()
    # Return real keys so input fields never lose the user's saved keys
    return jsonify({
        "google_cloud_key": s.get("google_cloud_key", ""),
        "deepl_key":        s.get("deepl_key", ""),
        "gemini_key":       s.get("gemini_key", ""),
        "openai_key":       s.get("openai_key", ""),
        "priority":         s.get("priority", "auto"),
    })

@app.route("/api/settings", methods=["POST"])
def save_settings():
    """Save API keys permanently to server-side JSON file and apply immediately."""
    data = request.get_json() or {}
    s = _load_settings()
    for field in ["google_cloud_key", "deepl_key", "gemini_key", "openai_key", "priority"]:
        if field in data:
            s[field] = data[field].strip()
    try:
        for path in [SETTINGS_FILE, BACKUP_SETTINGS_FILE]:
            try:
                os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(s, f, ensure_ascii=False, indent=2)
            except Exception:
                pass
        # Apply to translator_service immediately
        _apply_settings_to_translator(s)
        return jsonify({
            "message": "បានរក្សាទុក Key និងការកំណត់ដោយជោគជ័យ ១០០%! មិនបាត់បង់ឡើយ។",
            "settings": s
        })
    except Exception as e:
        return jsonify({"detail": str(e)}), 500

@app.route("/api/test-translate", methods=["POST"])
def test_translate():
    """Test translation with current or supplied keys."""
    data = request.get_json() or {}
    text = data.get("text", "盛哥，你不用谢我。")

    # If client passed keys directly from the modal input fields, test with them
    for field in ["google_cloud_key", "deepl_key", "gemini_key", "openai_key", "priority"]:
        if field in data and data[field].strip():
            setattr(translator_service, field, data[field].strip())

    try:
        result, provider = translator_service.translate_text_with_provider(text)
        return jsonify({"result": result, "provider": provider})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ── Software Update Endpoints ───────────────────────────────────────────────
@app.route("/api/check-update", methods=["GET"])
def check_update():
    """Check for new software updates across Git, GitHub repo, or local code modification."""
    force = request.args.get("force", "false").lower() == "true"
    res = update_service.check_for_updates(force=force)
    return jsonify(res)

@app.route("/api/save-update-config", methods=["POST"])
def save_update_config():
    """Save user-configured GitHub repository or update source."""
    data = request.get_json() or {}
    github_repo = data.get("github_repo", "").strip()
    remote_version_url = data.get("remote_version_url", "").strip()
    update_service.save_version_info({
        "github_repo": github_repo,
        "remote_version_url": remote_version_url
    })
    update_service.cached_check_result = None
    return jsonify({"status": "saved", "github_repo": github_repo})

@app.route("/api/perform-update", methods=["POST"])
def perform_update():
    """Execute update (e.g. git pull) and refresh state."""
    res = update_service.perform_update()
    return jsonify(res)

@app.route("/api/toggle-update-simulation", methods=["POST"])
def toggle_update_simulation():
    """Toggle simulation mode so user can immediately see the update notification signal in UI."""
    step = update_service.toggle_simulation()
    return jsonify({"status": "toggled", "simulated": (step > 0), "step": step})

@app.route("/api/preview-tts", methods=["POST"])
def preview_tts():
    """Generate preview audio for a single Khmer line."""
    data = request.get_json() or {}
    text = data.get("text", "")
    voice = data.get("voice", "km-KH-PisethNeural")
    rate = data.get("rate", "+35%")
    pitch = data.get("pitch", "+0Hz")

    try:
        audio_file = tts_service.generate_speech(
            text=text,
            voice=voice,
            rate=rate,
            pitch=pitch
        )
        if os.path.exists(audio_file):
            return send_file(audio_file, mimetype="audio/mpeg")
        return jsonify({"detail": "Failed to generate audio"}), 500
    except Exception as e:
        logger.error(f"TTS preview failed: {e}")
        return jsonify({"detail": str(e)}), 500

@app.route("/api/preload-audio", methods=["POST"])
def preload_audio():
    """Pre-generate TTS audio files in background for seamless real-time playback without stutter or limits."""
    global _preload_cancel_event
    _preload_cancel_event.set()
    _preload_cancel_event = threading.Event()
    cancel_evt = _preload_cancel_event

    data = request.get_json() or {}
    segments = data.get("segments", [])
    rate = data.get("rate", "+35%")
    pitch = data.get("pitch", "+0Hz")
    voice_settings = data.get("voice_settings") or {}
    limit = min(int(data.get("limit", 60)), 80)

    to_preload = [s for s in segments[:limit] if (s.get("translated") or s.get("original") or "").strip()]

    def _preload_worker(items, evt):
        consecutive_errors = 0
        for s in items:
            if evt.is_set():
                break
            txt = (s.get("translated") or s.get("original") or "").strip()
            voice = s.get("voice", "km-KH-PisethNeural")
            v_cfg = voice_settings.get(voice) if isinstance(voice_settings, dict) else None
            s_rate = (v_cfg.get("rate") if isinstance(v_cfg, dict) else None) or rate
            s_pitch = (v_cfg.get("pitch") if isinstance(v_cfg, dict) else None) or pitch
            if txt:
                try:
                    res = tts_service.generate_speech(text=txt, voice=voice, rate=s_rate, pitch=s_pitch)
                    if res and "transient_silence" not in res:
                        consecutive_errors = 0
                    else:
                        consecutive_errors += 1
                except Exception as e:
                    consecutive_errors += 1
                    logger.debug(f"Preload error for seg {s.get('id')}: {e}")

                if consecutive_errors >= 3:
                    logger.info("Edge-TTS rate-limited during background preload; pausing preload.")
                    break
                time.sleep(0.04)

    preload_pool.submit(_preload_worker, to_preload, cancel_evt)
    return jsonify({"status": "started", "count": len(to_preload)})


def get_system_drives():
    """Enumerate all available physical, logical, and external drives on Windows."""
    drives = []
    try:
        import string, shutil
        from ctypes import windll
        bitmask = windll.kernel32.GetLogicalDrives()
        for letter in string.ascii_uppercase:
            if bitmask & 1:
                root_path = f"{letter}:\\"
                try:
                    if os.path.exists(root_path):
                        total, used, free = shutil.disk_usage(root_path)
                        free_gb = round(free / (1024**3), 1)
                        drives.append({
                            "letter": letter,
                            "path": root_path,
                            "label": f"Drive {letter}: ({free_gb} GB)",
                            "free_gb": free_gb
                        })
                except Exception:
                    drives.append({
                        "letter": letter,
                        "path": root_path,
                        "label": f"Drive {letter}:",
                        "free_gb": 0
                    })
            bitmask >>= 1
    except Exception as e:
        logger.warning(f"Error enumerating drives: {e}")
    return drives


@app.route("/api/default-folders", methods=["GET"])
def get_default_folders():
    """Return common preset directories and all available system drives for fast selection."""
    home = os.path.expanduser("~")
    outputs_dir = os.path.abspath("outputs")
    desktop_dir = os.path.join(home, "Desktop")
    downloads_dir = os.path.join(home, "Downloads")
    videos_dir = os.path.join(home, "Videos")
    
    return jsonify({
        "outputs": outputs_dir,
        "desktop": desktop_dir if os.path.exists(desktop_dir) else None,
        "downloads": downloads_dir if os.path.exists(downloads_dir) else None,
        "videos": videos_dir if os.path.exists(videos_dir) else None,
        "drives": get_system_drives()
    })


@app.route("/api/browse-folder", methods=["POST", "GET"])
def browse_folder():
    """Launch native Windows folder picker dialog."""
    try:
        data = request.get_json(silent=True) or {}
        initial_dir = data.get("initial_dir", "").strip()
        if len(initial_dir) == 2 and initial_dir[1] == ':':
            initial_dir = initial_dir + '\\'

        script_path = os.path.abspath(os.path.join("scripts", "pick_folder.py"))
        
        args = [sys.executable, script_path]
        if initial_dir and os.path.exists(initial_dir):
            args.append(initial_dir)
            
        proc = subprocess.run(args, capture_output=True, timeout=120)
        selected = proc.stdout.decode("utf-8", errors="replace").strip()
        
        # Fallback to PowerShell FolderBrowserDialog if tkinter dialog did not produce a selection
        if not selected:
            ps_script = os.path.abspath(os.path.join("scripts", "pick_folder.ps1"))
            if os.path.exists(ps_script):
                ps_args = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps_script]
                if initial_dir and os.path.exists(initial_dir):
                    ps_args.extend(["-InitialFolder", initial_dir])
                proc_ps = subprocess.run(ps_args, capture_output=True, timeout=120)
                selected = proc_ps.stdout.decode("utf-8", errors="replace").strip()

        if selected and os.path.exists(selected):
            return jsonify({"status": "ok", "folder": os.path.abspath(selected)})
        elif selected:
            return jsonify({"status": "ok", "folder": selected})
        else:
            return jsonify({"status": "cancelled", "folder": None})
    except subprocess.TimeoutExpired:
        return jsonify({"status": "cancelled", "folder": None})
    except Exception as e:
        logger.error(f"Error browsing folder: {e}")
        return jsonify({"status": "error", "error": str(e)}), 500


@app.route("/api/open-folder", methods=["POST"])
def open_folder():
    """Open a folder or file location in Windows Explorer."""
    try:
        data = request.get_json(silent=True) or {}
        target_path = data.get("path", "").strip() or os.path.abspath("outputs")
        if len(target_path) == 2 and target_path[1] == ':':
            target_path = target_path + '\\'
        target_path = os.path.abspath(target_path)

        # If directory doesn't exist yet, create it so explorer can open it
        if not os.path.exists(target_path):
            try:
                os.makedirs(target_path, exist_ok=True)
            except Exception:
                pass

        if os.path.isfile(target_path):
            os.system(f'explorer /select,"{target_path}"')
            return jsonify({"status": "ok", "opened": target_path})
        elif os.path.isdir(target_path):
            os.startfile(target_path)
            return jsonify({"status": "ok", "opened": target_path})
        else:
            fallback = os.path.abspath("outputs")
            os.makedirs(fallback, exist_ok=True)
            os.startfile(fallback)
            return jsonify({"status": "ok", "opened": fallback})
    except Exception as e:
        logger.error(f"Error opening folder: {e}")
        return jsonify({"status": "error", "error": str(e)}), 500


@app.route("/api/start-export", methods=["POST"])
def start_export():
    """Start asynchronous export job to handle long videos without browser HTTP timeouts."""
    data = request.get_json() or {}
    video_path = data.get("video_path")
    segments = data.get("segments", [])
    orig_volume = float(data.get("orig_volume", 0.0))
    if orig_volume <= 0.001:
        orig_volume = 0.0

    is_bgm_enabled = bool(data.get("is_bgm_enabled", True))
    bgm_path = data.get("bgm_path")
    bgm_volume = float(data.get("bgm_volume", 0.25))

    # If BGM is disabled or path is empty or volume is <= 0.001, omit completely
    if not is_bgm_enabled or not bgm_path or bgm_volume <= 0.001:
        bgm_path = None
        bgm_volume = 0.0
    burn_subtitles = bool(data.get("burn_subtitles", True))
    watermark_text = data.get("watermark_text")
    if watermark_text is not None and (not watermark_text.strip() or watermark_text.strip() in ["សម្រាយរឿង", "សម្រាយរឿង HD", "សម្រាយរឿងHD"]):
        watermark_text = "សម្រាយរឿងHD"
    watermark_fontsize = data.get("watermark_fontsize", 56)
    watermark_x = data.get("watermark_x")
    watermark_y = data.get("watermark_y")
    watermark_logo_path = data.get("watermark_logo_path")
    logo_position = data.get("logo_position", "top-right")
    logo_scale = float(data.get("logo_scale", 0.15))
    logos = data.get("logos", [])
    resolution = data.get("resolution", "1080p")
    aspect_ratio = data.get("aspect_ratio", "original")
    rate = data.get("rate", "+35%")
    pitch = data.get("pitch", "+0Hz")
    voice_settings = data.get("voice_settings") or {}
    mask_chinese = bool(data.get("mask_chinese", False))
    mask_mode = data.get("mask_mode", "blur")
    mask_bottom_pct = float(data.get("mask_bottom_pct", 19.0))
    mask_height_pct = float(data.get("mask_height_pct", 12.0))
    smart_crop_chinese = bool(data.get("smart_crop_chinese", False))
    crop_bottom_pct = float(data.get("crop_bottom_pct", 12.0))
    thumbnail_path = data.get("thumbnail_path")
    thumbnail_cover = bool(data.get("thumbnail_cover", False))
    thumbnail_duration = float(data.get("thumbnail_duration", 0.8))

    output_dir = data.get("output_dir", "").strip()
    if output_dir:
        # Normalize drive path (e.g. "D:" -> "D:\")
        if len(output_dir) == 2 and output_dir[1] == ':':
            output_dir = output_dir + '\\'
        elif len(output_dir) > 2 and output_dir[1] == ':' and output_dir[2] in ['/', '\\']:
            output_dir = output_dir.replace('/', '\\')
        try:
            output_dir = os.path.abspath(output_dir)
            os.makedirs(output_dir, exist_ok=True)
        except Exception as e:
            logger.warning(f"Could not prepare output directory {output_dir}: {e}")
            output_dir = None

    if not video_path or not os.path.exists(video_path):
        return jsonify({"detail": "Video file not found"}), 404

    out_id = str(uuid.uuid4())[:8]
    output_filename = f"dubbed_{resolution}_{out_id}.mp4"
    output_path = os.path.join("outputs", output_filename)

    job_id = f"export_{out_id}"
    EXPORT_JOBS[job_id] = {
        "status": "running",
        "progress": 8,
        "message": f"កំពុងរៀបចំ និងត្រួតពិនិត្យទិន្នន័យ ({len(segments)} ប្រយោគ)...",
        "output_path": output_path,
        "url": f"/outputs/{output_filename}",
        "filename": output_filename,
        "output_dir": output_dir or os.path.abspath("outputs"),
        "saved_path": os.path.abspath(output_path),
        "error": None,
        "created_at": time.time()
    }

    def _export_worker():
        job = EXPORT_JOBS[job_id]
        try:
            def _progress_cb(pct, msg):
                job["progress"] = pct
                job["message"] = msg

            success = video_service.export_video(
                video_path=video_path,
                segments=segments,
                output_path=output_path,
                orig_volume=orig_volume,
                bgm_path=bgm_path,
                bgm_volume=bgm_volume,
                burn_subtitles=burn_subtitles,
                watermark_text=watermark_text,
                watermark_fontsize=watermark_fontsize,
                watermark_x=watermark_x,
                watermark_y=watermark_y,
                watermark_logo_path=watermark_logo_path,
                logo_position=logo_position,
                logo_scale=logo_scale,
                resolution=resolution,
                aspect_ratio=aspect_ratio,
                logos=logos,
                rate=rate,
                pitch=pitch,
                voice_settings=voice_settings,
                mask_chinese=mask_chinese,
                mask_mode=mask_mode,
                mask_bottom_pct=mask_bottom_pct,
                mask_height_pct=mask_height_pct,
                smart_crop_chinese=smart_crop_chinese,
                crop_bottom_pct=crop_bottom_pct,
                thumbnail_path=thumbnail_path,
                thumbnail_cover=thumbnail_cover,
                thumbnail_duration=thumbnail_duration,
                progress_callback=_progress_cb
            )

            if success and os.path.exists(output_path):
                final_saved_path = os.path.abspath(output_path)
                final_saved_dir = os.path.dirname(final_saved_path)
                if output_dir and os.path.abspath(output_dir) != os.path.abspath("outputs"):
                    dest_file = os.path.join(output_dir, output_filename)
                    import shutil
                    for _attempt in range(6):
                        try:
                            shutil.copyfile(output_path, dest_file)
                            if os.path.exists(dest_file):
                                final_saved_path = os.path.abspath(dest_file)
                                final_saved_dir = os.path.abspath(output_dir)
                                logger.info(f"Rendered video saved to custom location: {final_saved_path}")
                                break
                        except Exception as copy_err:
                            if _attempt == 5:
                                logger.error(f"Failed to copy to custom output directory: {copy_err}")
                            else:
                                time.sleep(0.35)

                job["status"] = "completed"
                job["progress"] = 100
                job["saved_path"] = final_saved_path
                job["saved_dir"] = final_saved_dir
                job["message"] = f"🎉 Render វីដេអូបានសម្រេច ១០០%! ({output_filename})"
            else:
                job["status"] = "error"
                job["error"] = "FFmpeg render error: Output video could not be created."
        except Exception as e:
            logger.error(f"Background export failed: {e}")
            job["status"] = "error"
            job["error"] = str(e)

    export_pool.submit(_export_worker)
    return jsonify({
        "status": "started",
        "job_id": job_id,
        "filename": output_filename
    })

@app.route("/api/export-status/<job_id>", methods=["GET"])
def get_export_status(job_id):
    """Poll export status for long background renders without timeout."""
    job = EXPORT_JOBS.get(job_id)
    if not job:
        return jsonify({"detail": "Export job not found"}), 404
    return jsonify({
        "job_id": job_id,
        "status": job.get("status", "running"),
        "progress": job.get("progress", 0),
        "message": job.get("message", ""),
        "url": job.get("url"),
        "filename": job.get("filename"),
        "saved_path": job.get("saved_path"),
        "saved_dir": job.get("saved_dir"),
        "error": job.get("error")
    })

@app.route("/api/export", methods=["POST"])
def export_video():
    """Render full dubbed video with synchronized Khmer narration."""
    data = request.get_json() or {}
    video_path = data.get("video_path")
    segments = data.get("segments", [])
    orig_volume = float(data.get("orig_volume", 0.0))
    if orig_volume <= 0.001:
        orig_volume = 0.0

    is_bgm_enabled = bool(data.get("is_bgm_enabled", True))
    bgm_path = data.get("bgm_path")
    bgm_volume = float(data.get("bgm_volume", 0.25))

    # If BGM is disabled or path is empty or volume is <= 0.001, omit completely
    if not is_bgm_enabled or not bgm_path or bgm_volume <= 0.001:
        bgm_path = None
        bgm_volume = 0.0
    burn_subtitles = bool(data.get("burn_subtitles", True))
    watermark_text = data.get("watermark_text")
    if watermark_text is not None and (not watermark_text.strip() or watermark_text.strip() in ["សម្រាយរឿង", "សម្រាយរឿង HD", "សម្រាយរឿងHD"]):
        watermark_text = "សម្រាយរឿងHD"
    watermark_fontsize = data.get("watermark_fontsize", 56)
    watermark_x = data.get("watermark_x")
    watermark_y = data.get("watermark_y")
    watermark_logo_path = data.get("watermark_logo_path")
    logo_position = data.get("logo_position", "top-right")
    logo_scale = float(data.get("logo_scale", 0.15))
    logos = data.get("logos", [])
    resolution = data.get("resolution", "1080p")
    aspect_ratio = data.get("aspect_ratio", "original")
    rate = data.get("rate", "+35%")
    pitch = data.get("pitch", "+0Hz")
    voice_settings = data.get("voice_settings") or {}
    mask_chinese = bool(data.get("mask_chinese", False))
    mask_mode = data.get("mask_mode", "blur")
    mask_bottom_pct = float(data.get("mask_bottom_pct", 19.0))
    mask_height_pct = float(data.get("mask_height_pct", 12.0))
    smart_crop_chinese = bool(data.get("smart_crop_chinese", False))
    crop_bottom_pct = float(data.get("crop_bottom_pct", 12.0))
    thumbnail_path = data.get("thumbnail_path")
    thumbnail_cover = bool(data.get("thumbnail_cover", False))
    thumbnail_duration = float(data.get("thumbnail_duration", 0.8))

    if not video_path or not os.path.exists(video_path):
        return jsonify({"detail": "Video file not found"}), 404

    out_id = str(uuid.uuid4())[:8]
    output_filename = f"dubbed_{resolution}_{out_id}.mp4"
    output_path = os.path.join("outputs", output_filename)

    try:
        success = video_service.export_video(
            video_path=video_path,
            segments=segments,
            output_path=output_path,
            orig_volume=orig_volume,
            bgm_path=bgm_path,
            bgm_volume=bgm_volume,
            burn_subtitles=burn_subtitles,
            watermark_text=watermark_text,
            watermark_fontsize=watermark_fontsize,
            watermark_x=watermark_x,
            watermark_y=watermark_y,
            watermark_logo_path=watermark_logo_path,
            logo_position=logo_position,
            logo_scale=logo_scale,
            resolution=resolution,
            aspect_ratio=aspect_ratio,
            logos=logos,
            rate=rate,
            pitch=pitch,
            mask_chinese=mask_chinese,
            mask_mode=mask_mode,
            mask_bottom_pct=mask_bottom_pct,
            mask_height_pct=mask_height_pct,
            smart_crop_chinese=smart_crop_chinese,
            crop_bottom_pct=crop_bottom_pct,
            thumbnail_path=thumbnail_path,
            thumbnail_cover=thumbnail_cover,
            thumbnail_duration=thumbnail_duration
        )

        if success and os.path.exists(output_path):
            return jsonify({
                "success": True,
                "output_path": output_path,
                "url": f"/outputs/{output_filename}",
                "filename": output_filename
            })
        else:
            return jsonify({"detail": "ការ Render វីដេអូបរាជ័យ សូមពិនិត្យឯកសារ ឬបន្ថយទំហំ Resolution"}), 500
    except Exception as e:
        logger.error(f"Export exception: {e}")
        return jsonify({"detail": f"កំហុស Export៖ {str(e)}"}), 500

@app.route("/api/sample-project", methods=["GET"])
def get_sample_project():
    """Load default demo project with Chinese lines and Khmer translations."""
    sample_video = "sample_video.mp4"
    if not os.path.exists(sample_video):
        os.system("ffmpeg -y -f lavfi -i testsrc=duration=20:size=1280x720:rate=30 -f lavfi -i sine=frequency=220:duration=20 -c:v libx264 -c:a aac -pix_fmt yuv420p sample_video.mp4")

    demo_segments = [
        {
            "id": 1,
            "start": 0.0,
            "end": 3.3,
            "original": "哇，薇薇安竟然为慈善机构筹集了一千万美元。",
            "translated": "អូ វ៉ូវៀន ឯងរកលុយបាន ១០ លានដុល្លារ សម្រាប់សប្បុរសធម៌។",
            "voice": "km-KH-PisethNeural",
            "actor": "Actor 1"
        },
        {
            "id": 2,
            "start": 3.3,
            "end": 5.4,
            "original": "爸爸只捐了一百万，那剩下的九百万从哪里来的？",
            "translated": "ប៉ាបោះតែមួយលានប៉ុណ្ណោះ ចុះឯណាទៀត? ប្រាំបួនលានបានមកពីណា?",
            "voice": "km-KH-PisethNeural",
            "actor": "Actor 1"
        },
        {
            "id": 3,
            "start": 5.5,
            "end": 8.2,
            "original": "天哪，这真是太不可思议了，完全出乎意料。",
            "translated": "អីយ៉ា នេះហើយ មិននឹកស្មានដល់។",
            "voice": "km-KH-SreymomNeural",
            "actor": "Actor 2"
        },
        {
            "id": 4,
            "start": 8.3,
            "end": 11.2,
            "original": "我真不敢相信我竟然打败了骄傲的贝拉！",
            "translated": "ខ្ញុំមិនជឿថាខ្ញុំពិតជាឈ្នះ Bella មានមោទនភាព។",
            "voice": "km-KH-SreymomNeural",
            "actor": "Actor 2"
        },
        {
            "id": 5,
            "start": 11.3,
            "end": 14.8,
            "original": "看来我的所有努力和坚持终于得到了回报。",
            "translated": "ខ្ញុំគិតថារាល់ការខិតខំប្រឹងប្រែង និងការតស៊ូរបស់ខ្ញុំ ទីបំផុតបានផល។",
            "voice": "km-KH-PisethNeural",
            "actor": "Actor 1"
        },
        {
            "id": 6,
            "start": 15.0,
            "end": 18.5,
            "original": "既然事情已经到了这个地步，那我们接下来该怎么做呢？",
            "translated": "ពេលនេះរឿងបានមកដល់ចំណុចនេះហើយ តើពួកយើងគួរធ្វើបែបណាបន្តទៀត?",
            "voice": "km-KH-SreymomNeural",
            "actor": "Actor 2"
        }
    ]

    return jsonify({
        "video_path": sample_video,
        "video_url": "/sample_video.mp4",
        "duration": 20.0,
        "segments": demo_segments
    })

@app.route("/api/health", methods=["GET"])
def health_check():
    """Health check for launcher and frontend verification."""
    return jsonify({"app": "VocalStudio", "status": "ok", "version": "1.0.0"})

if __name__ == "__main__":
    import sys, socket
    target_port = 8000
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        target_port = int(sys.argv[1])
    else:
        # Check if port 8000 is available; if blocked, safely fallback to 8088
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.bind(("127.0.0.1", target_port))
            s.close()
        except Exception:
            logger.warning(f"Port {target_port} is busy or occupied by another application. Falling back to port 8088...")
            target_port = 8088

    logger.info(f"Starting Vocal Studio on http://127.0.0.1:{target_port}")
    app.run(host="127.0.0.1", port=target_port, debug=False)
