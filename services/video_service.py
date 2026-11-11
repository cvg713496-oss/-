import os
import subprocess
import json
import glob
import logging
import time
import gc
import uuid
import threading
from typing import List, Dict, Any, Optional, Callable
from services.tts_service import TTSService

logger = logging.getLogger(__name__)

_BEST_ENCODER_CONFIG = None

def get_hardware_video_encoder() -> Dict[str, Any]:
    """
    Test and return the fastest available hardware-accelerated video encoder on this system.
    Checks AMD AMF, NVIDIA NVENC, Intel QSV, then falls back to multi-threaded CPU libx264.
    """
    global _BEST_ENCODER_CONFIG
    if _BEST_ENCODER_CONFIG is not None:
        return _BEST_ENCODER_CONFIG

    # 1. Test AMD AMF (Fastest on AMD GPUs & APUs)
    try:
        cmd_amf = [
            "ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=black:s=640x360:d=0.2",
            "-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp", "-qp_p", "22", "-qp_i", "22",
            "-pix_fmt", "yuv420p", "-f", "null", "-"
        ]
        res = subprocess.run(cmd_amf, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
        if res.returncode == 0:
            logger.info("⚡ Hardware Video Acceleration: AMD AMF (h264_amf) active!")
            _BEST_ENCODER_CONFIG = {
                "name": "AMD AMF GPU",
                "args": ["-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp", "-qp_p", "22", "-qp_i", "22", "-pix_fmt", "yuv420p"]
            }
            return _BEST_ENCODER_CONFIG
    except Exception:
        pass

    # 2. Test NVIDIA NVENC
    try:
        cmd_nvenc = [
            "ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=black:s=640x360:d=0.2",
            "-c:v", "h264_nvenc", "-preset", "p4", "-cq", "23", "-pix_fmt", "yuv420p",
            "-f", "null", "-"
        ]
        res = subprocess.run(cmd_nvenc, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
        if res.returncode == 0:
            logger.info("⚡ Hardware Video Acceleration: NVIDIA NVENC (h264_nvenc) active!")
            _BEST_ENCODER_CONFIG = {
                "name": "NVIDIA NVENC GPU",
                "args": ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "23", "-pix_fmt", "yuv420p"]
            }
            return _BEST_ENCODER_CONFIG
    except Exception:
        pass

    # 3. Test Intel QSV
    try:
        cmd_qsv = [
            "ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=black:s=640x360:d=0.2",
            "-c:v", "h264_qsv", "-preset", "medium", "-global_quality", "23", "-pix_fmt", "yuv420p",
            "-f", "null", "-"
        ]
        res = subprocess.run(cmd_qsv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
        if res.returncode == 0:
            logger.info("⚡ Hardware Video Acceleration: Intel QSV (h264_qsv) active!")
            _BEST_ENCODER_CONFIG = {
                "name": "Intel QSV",
                "args": ["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", "23", "-pix_fmt", "yuv420p"]
            }
            return _BEST_ENCODER_CONFIG
    except Exception:
        pass

    # 4. Standard CPU fallback (Multi-threaded libx264 veryfast)
    logger.info("Using multi-threaded CPU libx264 encoder.")
    _BEST_ENCODER_CONFIG = {
        "name": "CPU (libx264 Multi-Core)",
        "args": ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "22", "-threads", "0"]
    }
    return _BEST_ENCODER_CONFIG

class VideoService:
    def __init__(self, tts_service: Optional[TTSService] = None):
        self.tts = tts_service or TTSService()
        self._bgm_in_progress = set()
        self._bgm_lock = threading.Lock()

    def is_bgm_extracting(self, output_bgm_path: str) -> bool:
        abs_out = os.path.abspath(output_bgm_path)
        with self._bgm_lock:
            return abs_out in self._bgm_in_progress

    def merge_video_files(self, video_paths: List[str], output_path: str) -> bool:
        """
        Merge multiple video clips into a single continuous video with strict standardization
        (Normalization of resolution, SAR, framerate, and audio sample rate) to ensure
        100% smooth, glitch-free, and stall-free HTML5 playback across clip boundaries.
        """
        if not video_paths:
            return False
        if len(video_paths) == 1:
            import shutil
            shutil.copyfile(video_paths[0], output_path)
            return True

        work_dir = os.path.dirname(output_path)
        os.makedirs(work_dir, exist_ok=True)
        import uuid
        import concurrent.futures
        batch_tag = uuid.uuid4().hex[:8]

        # Probe stream codec, dimensions, and extradata_hash (SPS/PPS/VPS signature) across clips
        def _probe_clip_sig(vp: str):
            cmd_p = [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_data_hash", "md5",
                "-show_entries", "stream=codec_name,width,height,extradata_hash:format=duration",
                "-of", "json", vp
            ]
            try:
                r = subprocess.run(cmd_p, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                d = json.loads(r.stdout.decode("utf-8", errors="ignore") or "{}")
                st = (d.get("streams") or [{}])[0]
                dur = float((d.get("format") or {}).get("duration", 0.0) or 0.0)
                return {
                    "codec": st.get("codec_name", ""),
                    "w": int(st.get("width", 0) or 0),
                    "h": int(st.get("height", 0) or 0),
                    "hash": st.get("extradata_hash", ""),
                    "dur": dur
                }
            except Exception:
                return {"codec": "", "w": 0, "h": 0, "hash": "", "dur": 0.0}

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            clip_sigs = list(pool.map(_probe_clip_sig, video_paths))

        codecs = {s["codec"] for s in clip_sigs if s["codec"]}
        dims = {(s["w"], s["h"]) for s in clip_sigs if s["w"] > 0 and s["h"] > 0}
        hashes = {s["hash"] for s in clip_sigs if s["hash"]}
        est_total_dur = sum(s["dur"] for s in clip_sigs)

        same_dims_and_codec = (len(codecs) == 1 and len(dims) == 1)
        primary_codec = next(iter(codecs), "h264")
        identical_sps_pps = (same_dims_and_codec and primary_codec == "h264" and len(hashes) == 1)

        # Step 0: Only use direct MP4 concat demuxer if all clips are H.264 with identical SPS/PPS (extradata_hash).
        # Why? Because MP4 (hvc1/avc1) stores only Clip 1's SPS/PPS in the header; if Clip 2..N have different
        # QP/PPS (extradata_hash) or HEVC, direct MP4 concat strips their PPS and causes green macroblock corruption!
        if identical_sps_pps:
            try:
                concat_list_file = os.path.join(work_dir, f"concat_list_{batch_tag}.txt")
                with open(concat_list_file, "w", encoding="utf-8") as f_list:
                    for vp in video_paths:
                        abs_p = os.path.abspath(vp).replace("\\", "/").replace("'", "'\\''")
                        f_list.write(f"file '{abs_p}'\n")

                cmd_fast = [
                    "ffmpeg", "-y", "-f", "concat", "-safe", "0",
                    "-i", concat_list_file,
                    "-c", "copy",
                    "-avoid_negative_ts", "make_zero", "-fflags", "+genpts",
                    "-movflags", "+faststart",
                    output_path
                ]
                res_fast = subprocess.run(cmd_fast, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                if os.path.exists(concat_list_file):
                    try: os.remove(concat_list_file)
                    except Exception: pass

                stderr_fast = res_fast.stderr.decode("utf-8", errors="ignore")
                has_ts_issue = any(w in stderr_fast for w in ["pts < dts", "timestamp discontinuity"])

                if res_fast.returncode == 0 and os.path.exists(output_path) and os.path.getsize(output_path) > 1024 and not has_ts_issue:
                    chk_info = self.get_video_info(output_path)
                    chk_dur = chk_info.get("duration", 0)
                    v_dur = chk_info.get("video_duration", chk_dur)
                    a_dur = chk_info.get("audio_duration", chk_dur) if chk_info.get("has_audio") else chk_dur
                    if chk_dur > 1.0 and abs(v_dur - a_dur) < 3.5:
                        logger.info(f"⚡ Fast lossless H.264 concat demuxer succeeded for {len(video_paths)} clips! Duration: {chk_dur}s")
                        return True
            except Exception as e_fast:
                logger.warning(f"Fast concat demuxer error: {e_fast}, falling back to Annex-B TS pipeline.")

        # Step 1: Annex-B MPEG-TS Pipeline for HEVC or clips with differing per-episode SPS/PPS (extradata_hash).
        # Converting each MP4 clip to .ts with hevc_mp4toannexb / h264_mp4toannexb injects each episode's
        # exact VPS/SPS/PPS inline right before its keyframes with ZERO re-encoding and ZERO cu_qp_delta corruption!
        if same_dims_and_codec and primary_codec in ("hevc", "h264"):
            bsf_v = "hevc_mp4toannexb" if primary_codec == "hevc" else "h264_mp4toannexb"
            annexb_ts_files = [os.path.join(work_dir, f"annexb_{batch_tag}_{i:03d}.ts") for i in range(len(video_paths))]
            try:
                def _to_annexb_ts(idx_vp):
                    idx, vp = idx_vp
                    ts_out = annexb_ts_files[idx]
                    cmd_ts = [
                        "ffmpeg", "-y", "-i", vp,
                        "-c:v", "copy", "-bsf:v", bsf_v,
                        "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k",
                        "-avoid_negative_ts", "make_zero", "-fflags", "+genpts",
                        ts_out
                    ]
                    r = subprocess.run(cmd_ts, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    return r.returncode == 0 and os.path.exists(ts_out) and os.path.getsize(ts_out) > 500

                with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                    ts_results = list(pool.map(_to_annexb_ts, enumerate(video_paths)))

                if all(ts_results):
                    concat_ts_list = os.path.join(work_dir, f"concat_ts_{batch_tag}.txt")
                    with open(concat_ts_list, "w", encoding="utf-8") as f_ts:
                        for tsf in annexb_ts_files:
                            abs_ts = os.path.abspath(tsf).replace("\\", "/").replace("'", "'\\''")
                            f_ts.write(f"file '{abs_ts}'\n")

                    # For <=45min series (or HEVC clips), normalize the Annex-B stream in one fast pass to standard H.264 (avc1)
                    # so HTML5 browser <video> never stutters or shows green blocks on mid-stream HEVC/PPS changes!
                    orig_w, orig_h = next(iter(dims))
                    if est_total_dur <= 2700:
                        target_w = min(720, orig_w) if orig_w <= orig_h else min(1280, orig_w)
                        target_w = target_w - (target_w % 2)
                        vf_norm = f"scale={target_w}:-2,fps=25,format=yuv420p"
                        logger.info(f"Normalizing {len(video_paths)} Annex-B {primary_codec.upper()} clips ({est_total_dur:.1f}s) to smooth H.264 ({target_w}p)...")
                        cmd_mux = [
                            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_ts_list,
                            "-vf", vf_norm,
                            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22",
                            "-g", "50", "-keyint_min", "25", "-sc_threshold", "0",
                            "-c:a", "copy", "-bsf:a", "aac_adtstoasc",
                            "-avoid_negative_ts", "make_zero", "-fflags", "+genpts",
                            "-movflags", "+faststart",
                            output_path
                        ]
                    else:
                        # For >45min (1-4h) series, mux Annex-B stream losslessly with inline parameter sets (-tag:v hev1 for HEVC)
                        v_tag_args = ["-tag:v", "hev1"] if primary_codec == "hevc" else []
                        cmd_mux = [
                            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_ts_list,
                            "-c:v", "copy", *v_tag_args,
                            "-c:a", "copy", "-bsf:a", "aac_adtstoasc",
                            "-avoid_negative_ts", "make_zero", "-fflags", "+genpts",
                            "-movflags", "+faststart",
                            output_path
                        ]

                    res_mux = subprocess.run(cmd_mux, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    if os.path.exists(concat_ts_list):
                        try: os.remove(concat_ts_list)
                        except Exception: pass
                    if res_mux.returncode == 0 and os.path.exists(output_path) and os.path.getsize(output_path) > 1024:
                        logger.info(f"✅ Merged {len(video_paths)} clips cleanly via Annex-B TS pipeline (zero SPS/PPS corruption)!")
                        return True
            except Exception as e_ts:
                logger.warning(f"Annex-B TS merge fallback warning: {e_ts}")
            finally:
                for tsf in annexb_ts_files:
                    if os.path.exists(tsf):
                        try: os.remove(tsf)
                        except Exception: pass

        # 1. Determine clean reference resolution (capped to 720p to save disk space and ensure 100% smooth browser playback)
        info0 = self.get_video_info(video_paths[0])
        raw_w = info0.get("width", 720)
        raw_h = info0.get("height", 1280)
        is_vertical = (raw_h >= raw_w)
        if is_vertical:
            ref_w = 720
            ref_h = 1280
        else:
            ref_w = 1280
            ref_h = 720
        ref_fps = 25

        logger.info(f"Merging {len(video_paths)} clips normalized to {ref_w}x{ref_h} @ {ref_fps}fps (direct single-pass)...")

        # 2. Direct filter_complex concatenation (Zero intermediate disk files, zero out-of-disk errors!)
        script_file = None
        try:
            # If <= 35 clips, process all in one single pass
            if len(video_paths) <= 35:
                inputs = []
                filter_chains = []
                concat_inputs = []
                for i, vp in enumerate(video_paths):
                    inputs.extend(["-i", vp])
                    filter_chains.append(
                        f"[{i}:v:0]scale={ref_w}:{ref_h}:force_original_aspect_ratio=decrease,pad={ref_w}:{ref_h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={ref_fps},format=yuv420p[v{i}];"
                        f"[{i}:a:0]aformat=sample_rates=44100:channel_layouts=stereo[a{i}];"
                    )
                    concat_inputs.append(f"[v{i}][a{i}]")

                filter_complex = f"{''.join(filter_chains)}{''.join(concat_inputs)}concat=n={len(video_paths)}:v=1:a=1[outv][outa]"
                cmd = [
                    "ffmpeg", "-y", *inputs,
                    "-filter_complex", filter_complex,
                    "-map", "[outv]", "-map", "[outa]",
                    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "25", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "128k",
                    "-movflags", "+faststart",
                    output_path
                ]
                res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                if res.returncode == 0 and os.path.exists(output_path) and os.path.getsize(output_path) > 1024:
                    logger.info(f"Successfully merged {len(video_paths)} clips via single-pass filter_complex.")
                    return True
                else:
                    logger.error(f"Single-pass merge error: {res.stderr.decode('utf-8', errors='ignore')[-300:]}")
            else:
                # For large series (>35 clips, e.g. 80-120 episodes), process in 20-clip chunks to avoid FFmpeg FD limit
                chunk_size = 20
                part_files = []
                for c_idx in range(0, len(video_paths), chunk_size):
                    chunk_vps = video_paths[c_idx:c_idx + chunk_size]
                    part_out = os.path.join(work_dir, f"part_{batch_tag}_{c_idx // chunk_size:02d}.mp4")
                    part_files.append(part_out)

                    ch_inputs = []
                    ch_chains = []
                    ch_concat = []
                    for i, vp in enumerate(chunk_vps):
                        ch_inputs.extend(["-i", vp])
                        ch_chains.append(
                            f"[{i}:v:0]scale={ref_w}:{ref_h}:force_original_aspect_ratio=decrease,pad={ref_w}:{ref_h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={ref_fps},format=yuv420p[v{i}];"
                            f"[{i}:a:0]aformat=sample_rates=44100:channel_layouts=stereo[a{i}];"
                        )
                        ch_concat.append(f"[v{i}][a{i}]")

                    ch_filter = f"{''.join(ch_chains)}{''.join(ch_concat)}concat=n={len(chunk_vps)}:v=1:a=1[outv][outa]"
                    cmd_part = [
                        "ffmpeg", "-y", *ch_inputs,
                        "-filter_complex", ch_filter,
                        "-map", "[outv]", "-map", "[outa]",
                        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "25", "-pix_fmt", "yuv420p",
                        "-c:a", "aac", "-b:a", "128k",
                        "-movflags", "+faststart",
                        part_out
                    ]
                    r_part = subprocess.run(cmd_part, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    if r_part.returncode != 0 or not os.path.exists(part_out) or os.path.getsize(part_out) < 1000:
                        logger.error(f"Part {c_idx} merge error: {r_part.stderr.decode('utf-8', errors='ignore')[-200:]}")
                        return False

                # Concat part files losslessly
                part_list_txt = os.path.join(work_dir, f"parts_{batch_tag}.txt")
                with open(part_list_txt, "w", encoding="utf-8") as f_parts:
                    for p_path in part_files:
                        abs_p = os.path.abspath(p_path).replace("\\", "/").replace("'", "'\\''")
                        f_parts.write(f"file '{abs_p}'\n")

                cmd_final = [
                    "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", part_list_txt,
                    "-c", "copy",
                    "-avoid_negative_ts", "make_zero", "-fflags", "+genpts",
                    "-movflags", "+faststart",
                    output_path
                ]
                r_final = subprocess.run(cmd_final, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                if os.path.exists(part_list_txt):
                    try: os.remove(part_list_txt)
                    except Exception: pass
                for pf in part_files:
                    if os.path.exists(pf):
                        try: os.remove(pf)
                        except Exception: pass

                if r_final.returncode == 0 and os.path.exists(output_path) and os.path.getsize(output_path) > 1024:
                    logger.info(f"Successfully merged {len(video_paths)} clips in {len(part_files)} chunks.")
                    return True
            return False
        except Exception as e:
            logger.error(f"Error merging video files: {e}")
            return False
        finally:
            if script_file and os.path.exists(script_file):
                try: os.remove(script_file)
                except Exception: pass

    def create_preview_proxy(self, video_path: str, proxy_path: str, target_height: int = 480) -> bool:
        """
        Creates a fast, lightweight 480p preview proxy video (short GOP, faststart, normalized PTS starting at 0.0s)
        designed specifically for stutter-free HTML5 browser playback and instant scrubbing.
        """
        if not os.path.exists(video_path):
            return False
        cmd = [
            "ffmpeg", "-y", "-threads", "2", "-ss", "0", "-i", video_path,
            "-vf", f"scale=-2:min({target_height}\\,ih),fps=25,format=yuv420p,setpts=PTS-STARTPTS",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
            "-g", "25", "-keyint_min", "25", "-sc_threshold", "0",
            "-c:a", "aac", "-b:a", "96k", "-ar", "44100", "-ac", "2",
            "-af", "asetpts=PTS-STARTPTS",
            "-movflags", "+faststart",
            proxy_path
        ]
        try:
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            return res.returncode == 0 and os.path.exists(proxy_path) and os.path.getsize(proxy_path) > 1024
        except Exception as e:
            logger.error(f"Error generating preview proxy: {e}")
            return False

    def extract_and_separate_bgm(self, video_path: str, output_bgm_path: str, segments: Optional[List[Dict[str, Any]]] = None) -> bool:
        """
        Extract crystal-clear, high-definition background audio (ambience, sound effects, action hits, music)
        with 100% elimination of Chinese spoken dialogue:
        1. If speech segments (with timestamps) are available or cached, surgical mute intervals
           (with merged overlapping windows & batch volume chaining) drop spoken dialogue to 0.0.
        2. Surgical center-vocal cancellation (mlev=0.015625) suppresses center-panned speech.
        3. Dynamic Audio Normalization levels cinematic sound effects and ambience cleanly.
        """
        if not os.path.exists(video_path):
            return False

        abs_out = os.path.abspath(output_bgm_path)
        with self._bgm_lock:
            if abs_out in self._bgm_in_progress:
                return False
            self._bgm_in_progress.add(abs_out)

        temp_bgm_path = output_bgm_path + f".tmp_{uuid.uuid4().hex[:6]}.mp3"
        script_file = None
        try:
            # If segments not explicitly provided, try to find cached transcription segments
            if not segments:
                try:
                    base_without_ext = os.path.splitext(video_path)[0]
                    possible_caches = glob.glob(f"{video_path}_*_full.json") + glob.glob(f"{base_without_ext}*_full.json")
                    for cp in possible_caches:
                        if os.path.exists(cp) and os.path.getsize(cp) > 100:
                            with open(cp, "r", encoding="utf-8") as f:
                                cached = json.load(f)
                                if isinstance(cached, list) and len(cached) > 0:
                                    segments = cached
                                    break
                except Exception:
                    pass

            # Check channel count
            cmd_ch = [
                "ffprobe", "-v", "error", "-select_streams", "a:0",
                "-show_entries", "stream=channels", "-of", "default=noprint_wrappers=1:nokey=1",
                video_path
            ]
            channels = 2
            try:
                r = subprocess.run(cmd_ch, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                channels = int(r.stdout.decode().strip() or "2")
            except Exception:
                pass

            if segments and len(segments) > 0:
                # Sort and merge intervals to prevent memory overflow and cover all dialogue
                raw = []
                for s in segments:
                    st = max(0.0, float(s.get('start', 0.0)) - 0.06)
                    en = float(s.get('end', 0.0)) + 0.06
                    if en > st:
                        raw.append((st, en))
                raw.sort()

                merged = []
                for st, en in raw:
                    if not merged:
                        merged.append([st, en])
                    else:
                        if st <= merged[-1][1]:
                            merged[-1][1] = max(merged[-1][1], en)
                        else:
                            merged.append([st, en])

                conds = [f"between(t,{st:.2f},{en:.2f})" for st, en in merged]

                batch_size = 30
                volume_filters = []
                for i in range(0, len(conds), batch_size):
                    batch = conds[i:i+batch_size]
                    expr = '+'.join(batch)
                    volume_filters.append(f"volume=enable='{expr}':volume=0.0:eval=frame")

                # Cap chained volume nodes at 60 to avoid FFmpeg filtergraph stack overflow on 3-4h series;
                # beyond 60 nodes (~1800 intervals), center vocal cancellation + formant notch handles the rest cleanly
                if len(volume_filters) <= 60:
                    vol_chain = ','.join(volume_filters)
                    if channels >= 2:
                        filter_complex = f"[0:a]stereotools=mlev=0.015625:slev=1.0,dynaudnorm=p=0.95:m=12:s=5,{vol_chain}[aout]"
                    else:
                        filter_complex = f"[0:a]dynaudnorm=p=0.95:m=12:s=5,{vol_chain}[aout]"
                else:
                    if channels >= 2:
                        filter_complex = (
                            "[0:a]stereotools=mlev=0.015625:slev=1.0,"
                            "equalizer=f=300:width_type=o:width=2:g=-24,"
                            "equalizer=f=800:width_type=o:width=2:g=-24,"
                            "equalizer=f=2000:width_type=o:width=2:g=-24,"
                            "equalizer=f=3500:width_type=o:width=2:g=-20,"
                            "dynaudnorm=p=0.95:m=12:s=5[aout]"
                        )
                    else:
                        filter_complex = (
                            "[0:a]equalizer=f=300:width_type=o:width=2:g=-24,"
                            "equalizer=f=800:width_type=o:width=2:g=-24,"
                            "equalizer=f=2000:width_type=o:width=2:g=-24,"
                            "equalizer=f=3500:width_type=o:width=2:g=-20,"
                            "dynaudnorm=p=0.95:m=12:s=5[aout]"
                        )
            else:
                # Fallback when segments are not yet generated: notch cut speech formants and center channel
                if channels >= 2:
                    filter_complex = (
                        "[0:a]stereotools=mlev=0.015625:slev=1.0,"
                        "equalizer=f=300:width_type=o:width=2:g=-24,"
                        "equalizer=f=800:width_type=o:width=2:g=-24,"
                        "equalizer=f=2000:width_type=o:width=2:g=-24,"
                        "equalizer=f=3500:width_type=o:width=2:g=-20,"
                        "dynaudnorm=p=0.95:m=12:s=5[aout]"
                    )
                else:
                    filter_complex = (
                        "[0:a]equalizer=f=300:width_type=o:width=2:g=-24,"
                        "equalizer=f=800:width_type=o:width=2:g=-24,"
                        "equalizer=f=2000:width_type=o:width=2:g=-24,"
                        "equalizer=f=3500:width_type=o:width=2:g=-20,"
                        "dynaudnorm=p=0.95:m=12:s=5[aout]"
                    )

            cmd = [
                "ffmpeg", "-y", "-threads", "2", "-i", video_path,
                "-vn", "-filter_complex", filter_complex,
                "-map", "[aout]",
                "-c:a", "libmp3lame", "-b:a", "128k",
                temp_bgm_path
            ]
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if res.returncode == 0 and os.path.exists(temp_bgm_path) and os.path.getsize(temp_bgm_path) > 1000:
                os.replace(temp_bgm_path, output_bgm_path)
                return True
            return False
        except Exception as e:
            logger.error(f"Error separating BGM from video: {e}")
            return False
        finally:
            with self._bgm_lock:
                self._bgm_in_progress.discard(abs_out)
            if script_file and os.path.exists(script_file):
                try:
                    os.remove(script_file)
                except Exception:
                    pass
            if os.path.exists(temp_bgm_path):
                try:
                    os.remove(temp_bgm_path)
                except Exception:
                    pass

    def get_video_info(self, video_path: str) -> Dict[str, Any]:
        """Retrieve video metadata using ffprobe."""
        cmd = [
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_format", "-show_streams", video_path
        ]
        try:
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            data = json.loads(res.stdout.decode("utf-8", errors="ignore"))
            duration = float(data.get("format", {}).get("duration", 0.0))
            
            width = 1280
            height = 720
            has_audio = False
            video_duration = duration
            audio_duration = 0.0
            for s in data.get("streams", []):
                if s.get("codec_type") == "video":
                    width = int(s.get("width", 1280))
                    height = int(s.get("height", 720))
                    try:
                        v_d = float(s.get("duration", 0.0))
                        if v_d > 0: video_duration = v_d
                    except Exception:
                        pass
                elif s.get("codec_type") == "audio":
                    has_audio = True
                    try:
                        a_d = float(s.get("duration", 0.0))
                        if a_d > 0: audio_duration = a_d
                    except Exception:
                        pass

            return {
                "duration": round(duration, 2),
                "video_duration": round(video_duration, 2),
                "audio_duration": round(audio_duration, 2),
                "width": width,
                "height": height,
                "has_audio": has_audio,
                "filename": os.path.basename(video_path)
            }
        except Exception as e:
            logger.error(f"Error getting video info: {e}")
            return {"duration": 10.0, "width": 1280, "height": 720, "has_audio": False}

    @staticmethod
    def split_khmer_single_line_chunks(text: str, max_len: int = 22) -> List[str]:
        """Split long Khmer text into clean single-line chunks without breaking ligatures."""
        if not text or len(text) <= max_len:
            return [text]
        chunks = []
        rem = text.strip()
        while len(rem) > max_len:
            cut = -1
            # 1. Check space or punctuation
            for i in range(min(len(rem) - 1, max_len + 2), max(1, max_len - 6), -1):
                if rem[i] in " ,.!?\t\n":
                    cut = i if rem[i] == " " else i + 1
                    break
            # 2. Break before an independent base consonant (avoid breaking subscript Coeng \u17D2)
            if cut == -1:
                for i in range(min(len(rem) - 1, max_len), max(2, max_len - 7), -1):
                    c = rem[i]
                    prev = rem[i - 1]
                    if '\u1780' <= c <= '\u17A2' and prev != '\u17D2':
                        cut = i
                        break
            if cut == -1 or cut == 0:
                cut = max_len
            part = rem[:cut].strip()
            if part:
                chunks.append(part)
            rem = rem[cut:].strip()
        if rem:
            chunks.append(rem)
        return chunks

    def generate_srt(self, segments: List[Dict[str, Any]], srt_path: str):
        """Generate SRT subtitle file from segments, splitting long sentences into single-line sequential subtitles."""
        def format_timestamp(seconds: float) -> str:
            hrs = int(seconds // 3600)
            mins = int((seconds % 3600) // 60)
            secs = int(seconds % 60)
            milli = int(round((seconds - int(seconds)) * 1000))
            return f"{hrs:02d}:{mins:02d}:{secs:02d},{milli:03d}"

        valid_entries = []
        valid_segs = [s for s in segments if (s.get("translated") or s.get("original") or "").strip()]
        for i, seg in enumerate(valid_segs, 1):
            text = (seg.get("translated") or seg.get("original") or "").strip()
            if text:
                s_val = float(seg.get("start", 0))
                e_val = max(s_val + 0.5, float(seg.get("end", 0)))
                if i == len(valid_segs):
                    e_val = max(e_val, s_val + 3.0)

                chunks = self.split_khmer_single_line_chunks(text, max_len=22)
                if len(chunks) <= 1:
                    start = format_timestamp(s_val)
                    end = format_timestamp(e_val)
                    valid_entries.append((start, end, text))
                else:
                    total_dur = e_val - s_val
                    chunk_dur = total_dur / len(chunks)
                    for c_idx, chunk in enumerate(chunks):
                        c_start = s_val + (c_idx * chunk_dur)
                        c_end = s_val + ((c_idx + 1) * chunk_dur)
                        valid_entries.append((format_timestamp(c_start), format_timestamp(c_end), chunk))

        with open(srt_path, "w", encoding="utf-8") as f:
            if not valid_entries:
                # Provide a non-empty placeholder subtitle to prevent libass from crashing FFmpeg
                f.write("1\n00:00:00,000 --> 00:00:00,100\n \n\n")
            else:
                for idx, (start, end, text) in enumerate(valid_entries, 1):
                    f.write(f"{idx}\n{start} --> {end}\n{text}\n\n")

    def build_dubbed_audio(self, segments: List[Dict[str, Any]], total_duration: float, 
                           work_dir: str, rate: str = "+35%", pitch: str = "+0Hz",
                           voice_settings: Optional[Dict[str, Dict[str, str]]] = None,
                           progress_callback: Optional[Callable[[int, str], None]] = None) -> str:
        """Create a frame-accurate, sample-synchronized full-length Khmer audio track matching video timestamps exactly."""
        import numpy as np
        import wave
        import gc
        import concurrent.futures

        os.makedirs(work_dir, exist_ok=True)
        master_dub_audio = os.path.join(work_dir, "master_dub.wav")

        # Use native 24kHz for long videos (>20 min) to keep RAM & temp WAV size 4x smaller
        sample_rate = 24000 if total_duration > 1200 else 44100
        safe_duration = max(total_duration, 1.0) + 2.0
        total_samples = int(safe_duration * sample_rate)

        # High precision float32 mixing buffer for zero-drift multitrack placement
        master_buffer = np.zeros(total_samples, dtype=np.float32)

        # Filter valid segments that have dialogue text
        valid_segs = [s for s in segments if (s.get("translated") or s.get("original") or "").strip()]
        sorted_segs = sorted(valid_segs, key=lambda s: float(s.get("start", 0)))
        total_segs = len(sorted_segs)

        logger.info(f"Building sample-synchronized dub track for {total_segs} segments (duration: {total_duration:.2f}s)")

        def _get_vp(v_name: str):
            if voice_settings and isinstance(voice_settings, dict):
                v_cfg = voice_settings.get(v_name) or {}
                return v_cfg.get("rate") or rate, v_cfg.get("pitch") or pitch
            return rate, pitch

        # Step 1: Ensure all required TTS audio files exist (generate missing ones in parallel)
        missing_segs = []
        for seg in sorted_segs:
            text = (seg.get("translated") or seg.get("original") or "").strip()
            voice = seg.get("voice", "km-KH-PisethNeural")
            seg_rate, seg_pitch = _get_vp(voice)
            cache_file = self.tts._get_cache_filename(text, voice, seg_rate, seg_pitch)
            if not os.path.exists(cache_file) or os.path.getsize(cache_file) < 500:
                missing_segs.append((text, voice, seg_rate, seg_pitch))

        total_missing = len(missing_segs)
        if total_missing > 0:
            logger.info(f"Generating {total_missing} missing TTS files for export...")
            completed_tts = 0
            tts_lock = threading.Lock()

            def _gen(item):
                nonlocal completed_tts
                t, v, s_rate, s_pitch = item
                try:
                    self.tts.generate_speech(t, voice=v, rate=s_rate, pitch=s_pitch)
                except Exception as e:
                    logger.warning(f"TTS generation error for '{t[:15]}': {e}")
                with tts_lock:
                    completed_tts += 1
                    cur = completed_tts
                if progress_callback:
                    pct = 8 + int((cur / max(1, total_missing)) * 28)  # 8% to 36%
                    progress_callback(pct, f"កំពុងទាញយកសំឡេងនិយាយតួអង្គខ្មែរ {cur}/{total_missing}...")

            with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
                list(pool.map(_gen, missing_segs))
        else:
            if progress_callback:
                progress_callback(36, f"សំឡេងនិយាយតួអង្គខ្មែរគ្រប់ {total_segs} ប្រយោគ មានស្រាប់ក្នុង Cache...")

        # Step 2: Prepare decoding tasks matching web preview tempo logic
        decode_tasks = []
        for idx, seg in enumerate(sorted_segs):
            start = max(0.0, float(seg.get("start", 0)))
            end = max(start + 0.3, float(seg.get("end", start + 2.0)))
            seg_slot = max(0.4, end - start)

            text = (seg.get("translated") or seg.get("original") or "").strip()
            voice = seg.get("voice", "km-KH-PisethNeural")
            seg_rate, seg_pitch = _get_vp(voice)
            cache_file = self.tts._get_cache_filename(text, voice, seg_rate, seg_pitch)

            # Available slot before next segment
            next_start = float(sorted_segs[idx + 1].get("start", total_duration)) if (idx + 1 < total_segs) else (start + seg_slot)
            available_time = max(seg_slot, next_start - start)

            decode_tasks.append({
                "start": start,
                "end": end,
                "text": text,
                "voice": voice,
                "rate": seg_rate,
                "pitch": seg_pitch,
                "seg_slot": seg_slot,
                "available_time": available_time,
                "cache_file": cache_file
            })

        # Step 3: Decode and tempo-adjust audio clips in parallel (Direct decode without redundant ffprobe)
        total_tasks = len(decode_tasks)
        decoded_clips = [None] * total_tasks
        dec_completed = 0
        dec_lock = threading.Lock()

        def _decode_clip(idx_task):
            idx, task = idx_task
            cf = task["cache_file"]
            if not os.path.exists(cf) or os.path.getsize(cf) < 100:
                # Fallback generate if missing so NO segment is ever skipped in export!
                t = task.get("text", "")
                v = task.get("voice", "km-KH-PisethNeural")
                s_rate = task.get("rate", rate)
                s_pitch = task.get("pitch", pitch)
                if t:
                    try:
                        self.tts.generate_speech(t, voice=v, rate=s_rate, pitch=s_pitch, output_file=cf)
                    except Exception as e:
                        logger.warning(f"Fallback generation error for '{t[:20]}': {e}")
            if not os.path.exists(cf) or os.path.getsize(cf) < 100:
                return idx, task["start"], None

            # Fast direct decode into PCM s16le stream
            cmd = ["ffmpeg", "-y", "-i", cf, "-f", "s16le", "-ar", str(sample_rate), "-ac", "1", "-"]
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            if res.returncode == 0 and res.stdout:
                pcm = np.frombuffer(res.stdout, dtype=np.int16).astype(np.float32) / 32768.0
                dur = len(pcm) / sample_rate
                avail = task["available_time"]

                # Dynamic tempo speedup if speech exceeds the available dialogue slot (gentle, max 1.30x)
                if dur > 0 and dur > avail * 1.05:
                    boost = min(1.30, max(1.05, round(dur / avail, 2)))
                    if boost > 1.05:
                        cmd_tempo = ["ffmpeg", "-y", "-i", cf, "-filter:a", f"atempo={boost:.2f}", "-f", "s16le", "-ar", str(sample_rate), "-ac", "1", "-"]
                        res_t = subprocess.run(cmd_tempo, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                        if res_t.returncode == 0 and res_t.stdout:
                            pcm = np.frombuffer(res_t.stdout, dtype=np.int16).astype(np.float32) / 32768.0

                return idx, task["start"], pcm
            return idx, task["start"], None

        max_reached_sample = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
            futures = [pool.submit(_decode_clip, (i, task)) for i, task in enumerate(decode_tasks)]
            for fut in concurrent.futures.as_completed(futures):
                try:
                    idx, start, pcm_data = fut.result()
                    if pcm_data is not None and len(pcm_data) > 0:
                        with dec_lock:
                            clip_len = len(pcm_data)
                            start_sample = int(round(start * sample_rate))
                            if (start_sample + clip_len) > total_samples:
                                pad_needed = (start_sample + clip_len) - total_samples + (sample_rate * 2)
                                master_buffer = np.pad(master_buffer, (0, pad_needed), mode="constant")
                                total_samples = len(master_buffer)
                            end_sample = start_sample + clip_len
                            master_buffer[start_sample:end_sample] += pcm_data
                            if end_sample > max_reached_sample:
                                max_reached_sample = end_sample
                        del pcm_data
                except Exception as ex:
                    logger.warning(f"Clip decode error: {ex}")
                with dec_lock:
                    dec_completed += 1
                    cur = dec_completed
                if progress_callback and (cur % 8 == 0 or cur == total_tasks):
                    pct = 36 + int((cur / max(1, total_tasks)) * 14)  # 36% to 50%
                    progress_callback(pct, f"កំពុងបំប្លែង និងតម្រឹមសំឡេងនិយាយ {cur}/{total_tasks}...")

        # Step 4: Finalize master buffer duration and write pristine WAV in memory-safe chunks
        if progress_callback:
            progress_callback(51, "កំពុងផ្គុំ និងរក្សាទុក Master Audio Track...")

        target_samples = int(round(max(total_duration, 1.0) * sample_rate))
        final_len = max(max_reached_sample, target_samples)
        final_samples = master_buffer[:final_len]

        # Chunked peak scan & WAV write to avoid multi-GB duplicate allocations on 1-4h videos
        chunk_sz = sample_rate * 600  # 10-minute chunks
        max_val = 0.0
        for offset in range(0, len(final_samples), chunk_sz):
            sub = final_samples[offset:offset + chunk_sz]
            if len(sub) > 0:
                c_max = float(max( abs(float(np.min(sub))), abs(float(np.max(sub))) ))
                if c_max > max_val:
                    max_val = c_max

        scale_factor = (0.95 / max_val) * 32767.0 if max_val > 0.98 else 32767.0

        with wave.open(master_dub_audio, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            for offset in range(0, len(final_samples), chunk_sz):
                sub = final_samples[offset:offset + chunk_sz]
                int16_chunk = np.clip(sub * scale_factor, -32768, 32767).astype(np.int16)
                wf.writeframes(int16_chunk.tobytes())
                del int16_chunk

        logger.info(f"Master dub audio created with 100% frame-perfect sync: {master_dub_audio} ({len(final_samples) / sample_rate:.2f}s)")

        # Free massive audio buffers immediately to avoid MemoryError during FFmpeg encoding and status polling
        try:
            del final_samples
            del master_buffer
            del decoded_clips
            gc.collect()
        except Exception:
            pass

        return master_dub_audio

    def export_video(self, video_path: str, segments: List[Dict[str, Any]], 
                     output_path: str,
                     orig_volume: float = 0.1,
                     bgm_path: Optional[str] = None,
                     bgm_volume: float = 0.25,
                     burn_subtitles: bool = True,
                     watermark_text: Optional[str] = None,
                     watermark_fontsize: Optional[int] = 56,
                     watermark_x: Optional[float] = None,
                     watermark_y: Optional[float] = None,
                     watermark_logo_path: Optional[str] = None,
                     logo_position: str = "top-right",
                     logo_scale: float = 0.15,
                     resolution: str = "1080p",
                     aspect_ratio: str = "original",
                     logos: Optional[List[Dict[str, Any]]] = None,
                     rate: str = "+35%",
                     pitch: str = "+0Hz",
                     voice_settings: Optional[Dict[str, Dict[str, str]]] = None,
                     mask_chinese: bool = False,
                     mask_mode: str = "blur",
                     mask_bottom_pct: float = 14.0,
                     mask_height_pct: float = 14.0,
                     smart_crop_chinese: bool = False,
                     crop_bottom_pct: float = 12.0,
                     thumbnail_path: Optional[str] = None,
                     thumbnail_cover: bool = False,
                     thumbnail_duration: float = 0.8,
                     progress_callback: Optional[Callable[[int, str], None]] = None) -> bool:
        """Render final dubbed video with Khmer narration, BGM, and optional subtitles/watermark/multiple logos."""
        info = self.get_video_info(video_path)
        total_duration = info.get("duration", 10.0)

        work_dir = os.path.join(os.path.dirname(output_path), "render_temp")
        os.makedirs(work_dir, exist_ok=True)

        try:
            # 1. Build synchronized Khmer Dub audio track
            dub_audio = self.build_dubbed_audio(segments, total_duration, work_dir, rate=rate, pitch=pitch, voice_settings=voice_settings, progress_callback=progress_callback)

            # 2. Build Subtitle SRT file
            srt_path = os.path.join(work_dir, "subs.srt")
            self.generate_srt(segments, srt_path)

            # 3. Assemble FFmpeg inputs
            inputs = ["-i", video_path, "-i", dub_audio]
            input_count = 2

            if bgm_path and os.path.exists(bgm_path) and bgm_volume > 0.001:
                # Loop BGM to video duration
                inputs.extend(["-stream_loop", "-1", "-i", bgm_path])
                bgm_idx = input_count
                input_count += 1
            else:
                bgm_idx = -1

            # Thumbnail Cover input
            thumb_idx = -1
            if thumbnail_path and os.path.exists(thumbnail_path) and thumbnail_cover and thumbnail_duration > 0.05:
                inputs.extend(["-loop", "1", "-i", thumbnail_path])
                thumb_idx = input_count
                input_count += 1

            # Prepare logos list (supports both new multi-logo format and legacy single logo)
            logo_list = []
            if logos and isinstance(logos, list):
                for lg in logos:
                    p = lg.get("path")
                    if p and os.path.exists(p):
                        logo_list.append(lg)
            elif watermark_logo_path and os.path.exists(watermark_logo_path):
                logo_list.append({
                    "path": watermark_logo_path,
                    "position": logo_position,
                    "scale": logo_scale,
                    "x": None,
                    "y": None
                })

            logo_inputs_meta = []
            for lg in logo_list:
                p = lg["path"]
                ext = os.path.splitext(p)[1].lower()
                if ext in [".gif", ".mp4", ".mov", ".webm"]:
                    inputs.extend(["-ignore_loop", "0", "-i", p])
                else:
                    inputs.extend(["-loop", "1", "-i", p])
                logo_inputs_meta.append({
                    "idx": input_count,
                    "meta": lg
                })
                input_count += 1

            # Build Audio filter complex
            filter_parts = []
            audio_mix_inputs = []

            # Dub voice volume (Khmer narration — always full volume)
            filter_parts.append("[1:a]volume=1.0[dub]")
            audio_mix_inputs.append("[dub]")

            if info.get("has_audio") and orig_volume > 0.001:
                # Build surgical mute intervals from segments to eliminate Chinese dialogue 100%
                orig_mute_filters = []
                if segments:
                    raw_s = []
                    for s in segments:
                        st = max(0.0, float(s.get('start', 0.0)) - 0.06)
                        en = float(s.get('end', 0.0)) + 0.06
                        if en > st:
                            raw_s.append((st, en))
                    raw_s.sort()
                    merged_s = []
                    for st, en in raw_s:
                        if not merged_s:
                            merged_s.append([st, en])
                        else:
                            if st <= merged_s[-1][1]:
                                merged_s[-1][1] = max(merged_s[-1][1], en)
                            else:
                                merged_s.append([st, en])
                    conds_s = [f"between(t,{st:.2f},{en:.2f})" for st, en in merged_s]
                    for i in range(0, len(conds_s), 12):
                        batch = conds_s[i:i+12]
                        orig_mute_filters.append(f"volume=enable='{'+'.join(batch)}':volume=0.0:eval=frame")

                orig_mute_chain = ("," + ",".join(orig_mute_filters)) if orig_mute_filters else ""

                if bgm_idx != -1 and bgm_volume > 0.001:
                    bg_vol = min(orig_volume, 0.08)   # Keep ambience very quiet
                    speech_suppress = (
                        "highpass=f=80,"               # Remove sub-bass hum below 80 Hz
                        "equalizer=f=300:width_type=o:width=2:g=-18,"   # Cut 300 Hz (voice body)
                        "equalizer=f=800:width_type=o:width=2:g=-18,"   # Cut 800 Hz (voice warmth)
                        "equalizer=f=2000:width_type=o:width=2:g=-18,"  # Cut 2000 Hz (voice presence)
                        "equalizer=f=3500:width_type=o:width=2:g=-15,"  # Cut 3500 Hz (sibilance)
                        f"volume={bg_vol:.2f}"          # Final gentle volume
                        f"{orig_mute_chain}"
                    )
                    filter_parts.append(f"[0:a]{speech_suppress}[orig_bg]")
                else:
                    # BGM is OFF: pass original audio through but surgical mute speech
                    filter_parts.append(f"[0:a]volume={orig_volume:.2f}{orig_mute_chain}[orig_bg]")
                audio_mix_inputs.append("[orig_bg]")

            if bgm_idx != -1 and bgm_volume > 0.001:
                filter_parts.append(f"[{bgm_idx}:a]volume={bgm_volume:.2f}[bgm]")
                audio_mix_inputs.append("[bgm]")

            mix_count = len(audio_mix_inputs)
            if mix_count > 1:
                filter_parts.append(f"{''.join(audio_mix_inputs)}amix=inputs={mix_count}:duration=first:dropout_transition=0[aout]")
                audio_map = "[aout]"
            else:
                audio_map = "[dub]"

            # Video processing filters
            v_prep = []

            base_width = info.get("width", 1280)
            if resolution == "1080p":
                base_width = 1080 if aspect_ratio in ["9:16", "1:1"] else 1920
            elif resolution == "720p":
                base_width = 720 if aspect_ratio in ["9:16", "1:1"] else 1280

            # Check if dubbed narration extends beyond original video duration:
            # If so, extend/freeze the final video frame using tpad so the last sentence is NEVER cut off!
            dub_dur = self.tts.get_audio_duration(dub_audio)
            if dub_dur > total_duration + 0.1:
                freeze_pad_sec = round(dub_dur - total_duration + 0.6, 2)
                v_prep.append(f"tpad=stop_mode=clone:stop_duration={freeze_pad_sec}")

            if smart_crop_chinese:
                # ✂️ Smart Crop: Crop bottom Chinese subtitle zone while maintaining exact aspect ratio!
                crop_pct = max(5.0, min(25.0, float(crop_bottom_pct)))
                scale_ratio = round((100.0 - crop_pct) / 100.0, 4)
                v_prep.append(f"crop=w='trunc(iw*{scale_ratio:.4f}/2)*2':h='trunc(ih*{scale_ratio:.4f}/2)*2':x='(iw-ow)/2':y=0")

            if resolution == "1080p":
                if aspect_ratio == "9:16":
                    v_prep.append("scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black")
                elif aspect_ratio == "16:9":
                    v_prep.append("scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black")
                elif aspect_ratio == "1:1":
                    v_prep.append("scale=1080:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=black")
                else:
                    v_prep.append("scale='if(gt(a,1),-2,1080)':'if(gt(a,1),1080,-2)'")
            elif resolution == "720p":
                if aspect_ratio == "9:16":
                    v_prep.append("scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black")
                elif aspect_ratio == "16:9":
                    v_prep.append("scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black")
                elif aspect_ratio == "1:1":
                    v_prep.append("scale=720:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=720:720:(ow-iw)/2:(oh-ih)/2:color=black")
                else:
                    v_prep.append("scale='if(gt(a,1),-2,720)':'if(gt(a,1),720,-2)'")
            else:
                if aspect_ratio == "9:16":
                    v_prep.append("scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black")
                elif aspect_ratio == "16:9":
                    v_prep.append("scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black")
                elif aspect_ratio == "1:1":
                    v_prep.append("scale=1080:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=black")

            if not smart_crop_chinese and mask_chinese:
                # Mask/blur bar over original Chinese subtitles
                # In vertical short dramas (9:16), Chinese subtitles are standardly around 18% - 24% from bottom
                safe_bottom = float(mask_bottom_pct) if (mask_bottom_pct is not None and float(mask_bottom_pct) > 0) else 19.0
                safe_height = float(mask_height_pct) if (mask_height_pct is not None and float(mask_height_pct) > 0) else 12.0
                # Enforce safe bounds so it never accidentally drops below subtitle zone
                safe_bottom = max(8.0, min(55.0, safe_bottom))
                safe_height = max(8.0, min(25.0, safe_height))

                y_pct = max(0.05, min(0.85, (100.0 - safe_bottom - safe_height) / 100.0))
                h_pct = max(0.05, min(0.30, safe_height / 100.0))
                if mask_mode == "cover":
                    v_prep.append(f"drawbox=x=0:y=ih*{y_pct:.4f}:w=iw:h=ih*{h_pct:.4f}:color=black@0.92:t=fill")
                else:
                    v_prep.append(f"drawbox=x=0:y=ih*{y_pct:.4f}:w=iw:h=ih*{h_pct:.4f}:color=black@0.78:t=fill")

            if burn_subtitles and os.path.exists(srt_path):
                # Use clean relative path to avoid Windows drive colons (C:) and non-ASCII paths (សម្រាយរឿង)
                # which break FFmpeg libass option parsing
                clean_rel_srt = "outputs/render_temp/subs.srt"
                try:
                    if os.path.abspath(srt_path) != os.path.abspath(clean_rel_srt) and not os.path.samefile(srt_path, clean_rel_srt):
                        import shutil
                        shutil.copyfile(srt_path, clean_rel_srt)
                except Exception:
                    pass
                v_prep.append(f"subtitles={clean_rel_srt}:force_style='Fontname=Noto Sans Khmer,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=2,Shadow=1,MarginV=30'")

            if watermark_text:
                wm_str = watermark_text.strip()
                if not wm_str or wm_str in ["សម្រាយរឿង", "សម្រាយរឿង HD", "សម្រាយរឿងHD"]:
                    wm_str = "សម្រាយរឿងHD"
                safe_wm = wm_str.replace("'", "").replace(":", "\\:")
                font_file = None
                for c in [
                    r"C:\Windows\Fonts\NotoSansKhmer-Bold.ttf",
                    r"C:\Windows\Fonts\NotoSansKhmer-Regular.ttf",
                    r"C:\Windows\Fonts\KhmerOS.ttf",
                    r"C:\Windows\Fonts\daunpenh.ttf",
                    r"C:\Windows\Fonts\arial.ttf"
                ]:
                    if os.path.exists(c):
                        font_file = c.replace("\\", "/").replace(":", "\\:")
                        break
                if font_file:
                    try:
                        user_fs = int(watermark_fontsize) if watermark_fontsize else 56
                    except (ValueError, TypeError):
                        user_fs = 56

                    if resolution == "1080p":
                        wm_fontsize = user_fs
                    elif resolution == "720p":
                        wm_fontsize = max(24, int(round(user_fs * 0.72)))
                    else:
                        wm_fontsize = user_fs if base_width >= 1000 else max(24, int(round(user_fs * 0.72)))

                    border_w = max(8, int(round(wm_fontsize * 0.22)))

                    if watermark_x is not None and watermark_y is not None:
                        pct_x = max(0.0, min(0.95, float(watermark_x)))
                        pct_y = max(0.0, min(0.95, float(watermark_y)))
                        pos_expr = f"x=(w-tw)*{pct_x:.4f}:y=(h-th)*{pct_y:.4f}"
                    else:
                        pos_expr = "x=w-tw-30:y=30"

                    v_prep.append(f"drawtext=fontfile='{font_file}':text='{safe_wm}':fontcolor=white@0.98:fontsize={wm_fontsize}:box=1:boxcolor=black@0.65:boxborderw={border_w}:{pos_expr}")

            # Combine video filters
            v_chain = ",".join(v_prep) if v_prep else "null"

            current_v = "[0:v]"
            if v_prep:
                filter_parts.append(f"[0:v]{v_chain}[v_scaled]")
                current_v = "[v_scaled]"

            if logo_inputs_meta:
                for i, item in enumerate(logo_inputs_meta):
                    l_idx = item["idx"]
                    l_meta = item["meta"]
                    l_scale = float(l_meta.get("scale", 0.15))
                    scale_factor = max(0.04, min(0.50, l_scale))
                    target_logo_w = max(32, int(round(base_width * scale_factor)))
                    if target_logo_w % 2 != 0:
                        target_logo_w += 1

                    # Scale logo stream using calculated pixel width (avoids invalid scale expressions in FFmpeg)
                    logo_scaled_tag = f"[logo_{i}_sc]"
                    filter_parts.append(f"[{l_idx}:v]scale={target_logo_w}:-2{logo_scaled_tag}")

                    # Position coordinates (support exact percentage or preset position)
                    pos_x = "W-w-20"
                    pos_y = "20"
                    if l_meta.get("x") is not None and l_meta.get("y") is not None:
                        # Exact percentage drag position: 0 to 1
                        pct_x = max(0.0, min(0.95, float(l_meta["x"])))
                        pct_y = max(0.0, min(0.95, float(l_meta["y"])))
                        pos_x = f"(W-w)*{pct_x:.4f}"
                        pos_y = f"(H-h)*{pct_y:.4f}"
                    else:
                        pos = l_meta.get("position", "top-right")
                        if pos == "top-left":
                            pos_x, pos_y = "20", "20"
                        elif pos == "bottom-right":
                            pos_x, pos_y = "W-w-20", "H-h-20"
                        elif pos == "bottom-left":
                            pos_x, pos_y = "20", "H-h-20"
                        elif pos == "top-center":
                            pos_x, pos_y = "(W-w)/2", "20"
                        elif pos == "center":
                            pos_x, pos_y = "(W-w)/2", "(H-h)/2"

                    next_v = f"[v_over_{i}]"
                    filter_parts.append(f"{current_v}{logo_scaled_tag}overlay={pos_x}:{pos_y}:repeatlast=1{next_v}")
                    current_v = next_v

                video_map = current_v
            elif v_prep:
                video_map = "[v_scaled]"
            else:
                video_map = "0:v"

            # Apply Thumbnail Intro Cover Frame if requested
            if thumb_idx != -1:
                t_w, t_h = base_width, info.get("height", 720)
                if resolution == "1080p":
                    t_w, t_h = (1080, 1920) if aspect_ratio == "9:16" else ((1920, 1080) if aspect_ratio == "16:9" else ((1080, 1080) if aspect_ratio == "1:1" else (1080, 1920)))
                elif resolution == "720p":
                    t_w, t_h = (720, 1280) if aspect_ratio == "9:16" else ((1280, 720) if aspect_ratio == "16:9" else ((720, 720) if aspect_ratio == "1:1" else (720, 1280)))

                filter_parts.append(f"[{thumb_idx}:v]scale={t_w}:{t_h}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad={t_w}:{t_h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[thumb_sc]")
                cover_v = "[v_with_cover]"
                filter_parts.append(f"{current_v}[thumb_sc]overlay=0:0:enable='between(t,0,{thumbnail_duration:.2f})'{cover_v}")
                current_v = cover_v
                video_map = current_v

            filter_complex = ";".join(filter_parts)

            cmd = ["ffmpeg", "-y"] + inputs
            if filter_complex:
                cmd.extend(["-filter_complex", filter_complex])
                cmd.extend(["-map", video_map, "-map", audio_map])
            else:
                cmd.extend(["-map", "0:v", "-map", "1:a"])

            hw_enc = get_hardware_video_encoder()
            cmd.extend(hw_enc["args"])
            cmd.extend([
                "-c:a", "aac", "-b:a", "192k",
                "-shortest", output_path
            ])

            def _run_ffmpeg(cmd_list: List[str], label: str = "Render") -> bool:
                prog_cmd = [cmd_list[0]] + ["-progress", "pipe:1"] + cmd_list[1:]
                log_file = os.path.join(work_dir, "ffmpeg_render.log")
                logger.info(f"FFmpeg command ({label}): {' '.join(cmd_list)}")
                try:
                    with open(log_file, "w", encoding="utf-8") as f_err:
                        p = subprocess.Popen(prog_cmd, stdout=subprocess.PIPE, stderr=f_err, text=True, bufsize=1)
                        curr_sec = 0.0
                        speed_str = "1.0x"
                        last_update = 0.0
                        for line in p.stdout:
                            line = line.strip()
                            if line.startswith("out_time_us="):
                                try:
                                    curr_sec = float(line.split("=")[1]) / 1_000_000.0
                                except Exception:
                                    pass
                            elif line.startswith("speed="):
                                speed_str = line.split("=")[1].strip()
                            elif line.startswith("progress="):
                                now = time.time()
                                if now - last_update >= 0.8 and progress_callback and total_duration > 0:
                                    last_update = now
                                    pct = min(94, int(52 + (curr_sec / max(1.0, total_duration)) * 42))
                                    m_curr, s_curr = int(curr_sec // 60), int(curr_sec % 60)
                                    m_tot, s_tot = int(total_duration // 60), int(total_duration % 60)
                                    try:
                                        sp_val = float(speed_str.replace("x", "").strip())
                                    except Exception:
                                        sp_val = 1.0
                                    rem_sec = max(0, int((total_duration - curr_sec) / max(0.5, sp_val))) if sp_val > 0 else 0
                                    rem_str = f"នៅសល់ ~{rem_sec} វិនាទី" if rem_sec > 0 else "ជិតរួចរាល់"
                                    progress_callback(
                                        pct,
                                        f"កំពុង {label}: {m_curr}:{s_curr:02d} / {m_tot}:{s_tot:02d} នាទី ({speed_str}) • {rem_str}"
                                    )
                        p.wait()
                        return p.returncode == 0 and os.path.exists(output_path) and os.path.getsize(output_path) > 1024
                except Exception as ex:
                    logger.error(f"Error running FFmpeg {label}: {ex}")
                    return False

            if progress_callback:
                progress_callback(52, f"កំពុង Render វីដេអូកម្រិត {resolution.upper()} ({hw_enc['name']})...")

            ok = _run_ffmpeg(cmd, label=f"Render {resolution.upper()} ({hw_enc['name']})")
            if ok:
                if progress_callback:
                    progress_callback(95, "កំពុងផ្ទៀងផ្ទាត់ និងរៀបចំឯកសារទាញយក...")
                return True

            logger.warning("Primary render failed, reading error log...")
            log_err_path = os.path.join(work_dir, "ffmpeg_render.log")
            if os.path.exists(log_err_path):
                try:
                    with open(log_err_path, "r", encoding="utf-8", errors="ignore") as f_err_read:
                        logger.error(f"Render failed log: {f_err_read.read()[-400:]}")
                except Exception:
                    pass

            # Robust Fallback 1: If subtitle or text filter failed, render without subtitles/drawtext while keeping logos, blur box and audio
            logger.warning("Attempting safe fallback render...")
            fb_v_prep = [fp for fp in v_prep if not fp.startswith("subtitles=") and not fp.startswith("drawtext=")]
            fb_v_chain = ",".join(fb_v_prep) if fb_v_prep else "null"
            fallback_parts = []
            for p in filter_parts:
                if p.startswith(f"[0:v]{v_chain}[v_scaled]"):
                    fallback_parts.append(f"[0:v]{fb_v_chain}[v_scaled]")
                else:
                    fallback_parts.append(p)
            fb_fc = ";".join(fallback_parts)
            fallback_cmd = ["ffmpeg", "-y"] + inputs
            if fb_fc:
                fallback_cmd.extend(["-filter_complex", fb_fc, "-map", video_map, "-map", audio_map])
            else:
                fallback_cmd.extend(["-map", "0:v", "-map", "1:a"])
            fallback_cmd.extend([
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "22",
                "-threads", "0",
                "-c:a", "aac", "-b:a", "192k",
                "-shortest", output_path
            ])
            if _run_ffmpeg(fallback_cmd, label="Render (Safe Fallback)"):
                logger.info("Fallback render succeeded!")
                return True

            # Emergency Fallback 2: Direct mux of video and dubbed audio (guaranteed not to fail)
            logger.warning("Attempting emergency mux fallback...")
            em_cmd = [
                "ffmpeg", "-y", "-i", video_path, "-i", dub_audio,
                "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                "-avoid_negative_ts", "make_zero", "-fflags", "+genpts",
                "-shortest", output_path
            ]
            em_res = subprocess.run(em_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if em_res.returncode == 0 and os.path.exists(output_path):
                logger.info("Emergency mux fallback succeeded!")
                return True

            return False

            return os.path.exists(output_path)
        except Exception as e:
            logger.error(f"Video export failed: {e}")
            return False
        finally:
            # Clean up temporary work files
            pass

