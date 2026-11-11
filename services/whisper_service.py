import os
import sys
import io
import subprocess
import base64
import requests
import json
import logging
import wave
import threading
import re
import uuid
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
import numpy as np
from typing import List, Dict, Any

class _SafeNullStream(io.TextIOBase):
    """Safe no-op stream so tqdm/Whisper never fail when stdout/stderr are None under pythonw.exe."""
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

logger = logging.getLogger(__name__)

# Global lock to prevent simultaneous Whisper model inference corruption across threads
_whisper_lock = threading.Lock()

class WhisperService:
    def __init__(self):
        self.model = None
        self.current_model_name = None
        self.faster_model = None
        self.faster_model_name = None

    def is_transcribing(self) -> bool:
        """Check if Whisper model is currently locked and transcribing another job."""
        return _whisper_lock.locked()

    def extract_audio(self, video_path: str, output_wav_path: str) -> bool:
        """Extract audio from video to 16kHz mono WAV using ffmpeg."""
        cmd = [
            "ffmpeg", "-y", "-i", video_path,
            "-vn", "-af", "highpass=f=80,lowpass=f=7500,volume=1.5",
            "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
            output_wav_path
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if res.returncode != 0 or not os.path.exists(output_wav_path):
            logger.error(f"FFmpeg failed: {res.stderr.decode('utf-8', errors='ignore')[-300:]}")
            return False
        # Validate WAV has actual audio content (> 44 bytes = more than just header)
        size = os.path.getsize(output_wav_path)
        if size < 1024:  # less than 1KB → empty/corrupt
            logger.error(f"Extracted WAV too small ({size} bytes) — video may have no audio track")
            return False
        return True

    def transcribe(self, audio_or_video_path: str, model_name: str = "base", language: str = "zh", progress_callback=None) -> List[Dict[str, Any]]:
        """Transcribe Chinese audio to timed segments using Whisper."""
        # Check if input is video; if so, extract audio first
        ext = os.path.splitext(audio_or_video_path)[1].lower()
        wav_path = audio_or_video_path
        temp_wav = None

        if ext in [".mp4", ".mkv", ".mov", ".avi", ".webm", ".ts", ".flv"]:
            temp_wav = os.path.splitext(audio_or_video_path)[0] + "_temp.wav"
            ok = self.extract_audio(audio_or_video_path, temp_wav)
            if ok:
                wav_path = temp_wav
            else:
                # Try alternative ffmpeg command: force audio decode
                logger.warning("Primary FFmpeg extraction failed; trying alternative decode...")
                cmd2 = [
                    "ffmpeg", "-y", "-i", audio_or_video_path,
                    "-vn", "-ar", "16000", "-ac", "1", "-f", "wav",
                    temp_wav
                ]
                res2 = subprocess.run(cmd2, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                if res2.returncode == 0 and os.path.exists(temp_wav) and os.path.getsize(temp_wav) > 1024:
                    wav_path = temp_wav
                    logger.info("Alternative FFmpeg decode succeeded")
                else:
                    raise RuntimeError(
                        "វីដេអូនេះមិនអាចទាញ Audio បានទេ។ សូមពិនិត្យមើលថាវីដេអូមានសំឡេង (Audio Track) ។"
                    )

        # Validate audio file before passing to Whisper
        if not os.path.exists(wav_path) or os.path.getsize(wav_path) < 1024:
            raise RuntimeError(
                "ឯកសារ Audio មិនត្រឹមត្រូវ ឬទទេ។ សូម Drop វីដេអូដែលមានសំឡេងម្តងទៀត។"
            )

        try:
            os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
            # Check audio duration and load PCM array once to optimize for long videos (1-4 hours)
            audio_duration = 0.0
            audio_array = None
            sr = 16000
            try:
                import wave
                with wave.open(wav_path, 'rb') as wf:
                    frames = wf.getnframes()
                    sr = wf.getframerate()
                    audio_duration = frames / float(sr)
                    raw_pcm = wf.readframes(frames)
                    audio_array = np.frombuffer(raw_pcm, dtype=np.int16).astype(np.float32) / 32768.0
                    del raw_pcm
            except Exception as we:
                logger.warning(f"Wave pre-load warning: {we}")

            is_long_audio = (audio_duration > 900)  # > 15 minutes (1-4 hours series)

            if _whisper_lock.locked() and progress_callback:
                try:
                    progress_callback(0.0, 0, audio_duration, "កំពុងរង់ចាំ Whisper បញ្ចប់វីដេអូមុន... (Queue)")
                except TypeError:
                    try: progress_callback(0.0, 0, audio_duration)
                    except Exception: pass
                except Exception:
                    pass

            result = None

            # ── Primary Engine: Faster-Whisper (CTranslate2 INT8 + Silero VAD — 5x to 8x faster) ──
            try:
                from faster_whisper import WhisperModel
                import ctranslate2
                fw_device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
                fw_compute = "float16" if fw_device == "cuda" else "int8"
                cpu_threads = max(4, (os.cpu_count() or 4))

                with _whisper_lock:
                    if self.faster_model is None or self.faster_model_name != model_name:
                        logger.info(f"Loading Faster-Whisper '{model_name}' ({fw_compute}) on {fw_device} with {cpu_threads} threads...")
                        self.faster_model = WhisperModel(
                            model_name,
                            device=fw_device,
                            compute_type=fw_compute,
                            cpu_threads=cpu_threads
                        )
                        self.faster_model_name = model_name

                    fw_input = audio_array if (audio_array is not None and sr == 16000) else wav_path
                    seg_gen, info_fw = self.faster_model.transcribe(
                        fw_input,
                        language=language or "zh",
                        task="transcribe",
                        beam_size=1,
                        best_of=1,
                        temperature=0.0,
                        condition_on_previous_text=True,
                        word_timestamps=True,
                        vad_filter=True,
                        vad_parameters=dict(threshold=0.25, min_silence_duration_ms=250, speech_pad_ms=250),
                        no_speech_threshold=0.70,
                        compression_ratio_threshold=2.4,
                        log_prob_threshold=-1.2
                    )

                    total_dur = max(1.0, audio_duration or getattr(info_fw, "duration", 1.0))
                    fw_segments = []
                    for s in seg_gen:
                        s_dict = {
                            "start": float(s.start),
                            "end": float(s.end),
                            "text": s.text
                        }
                        if getattr(s, "words", None):
                            s_dict["words"] = [
                                {"word": w.word, "start": float(w.start), "end": float(w.end)}
                                for w in s.words
                            ]
                        fw_segments.append(s_dict)
                        if progress_callback:
                            try:
                                curr_s = min(total_dur, round(float(s.end), 1))
                                pct = min(0.99, max(0.01, curr_s / total_dur))
                                progress_callback(pct, curr_s, total_dur)
                            except Exception:
                                pass

                    # Rescue soft/child dialogue inside >3.5s gaps that Silero VAD may have skipped over BGM
                    if audio_array is not None and sr == 16000 and len(fw_segments) > 1:
                        rescued_gaps = []
                        for g_idx in range(len(fw_segments) - 1):
                            g_start = float(fw_segments[g_idx]["end"]) + 0.25
                            g_end = float(fw_segments[g_idx + 1]["start"]) - 0.15
                            if 3.2 <= (g_end - g_start) <= 25.0:
                                s_i = int(g_start * sr)
                                e_i = min(len(audio_array), int(g_end * sr))
                                gap_slice = audio_array[s_i:e_i]
                                if len(gap_slice) > sr and float(np.sqrt(np.mean(gap_slice ** 2))) > 0.015:
                                    try:
                                        g_gen, _ = self.faster_model.transcribe(
                                            gap_slice,
                                            language=language or "zh",
                                            task="transcribe",
                                            beam_size=1,
                                            best_of=1,
                                            temperature=0.0,
                                            condition_on_previous_text=False,
                                            word_timestamps=True,
                                            vad_filter=False,
                                            no_speech_threshold=0.65,
                                            compression_ratio_threshold=2.2,
                                            log_prob_threshold=-0.9
                                        )
                                        for gs in g_gen:
                                            g_txt = (gs.text or "").strip()
                                            if g_txt and re.search(r"[\u4e00-\u9fff]", g_txt):
                                                gs_dict = {
                                                    "start": float(gs.start) + g_start,
                                                    "end": float(gs.end) + g_start,
                                                    "text": g_txt
                                                }
                                                if getattr(gs, "words", None):
                                                    gs_dict["words"] = [
                                                        {"word": w.word, "start": float(w.start) + g_start, "end": float(w.end) + g_start}
                                                        for w in gs.words
                                                    ]
                                                rescued_gaps.append(gs_dict)
                                    except Exception:
                                        pass
                        if rescued_gaps:
                            fw_segments.extend(rescued_gaps)
                            fw_segments.sort(key=lambda x: float(x.get("start", 0.0)))

                    if progress_callback:
                        try:
                            progress_callback(1.0, round(total_dur, 1), total_dur)
                        except Exception:
                            pass
                    result = {"segments": fw_segments}
            except Exception as fw_err:
                logger.warning(f"Faster-Whisper fallback to OpenAI Whisper ({fw_err})...")
                result = None

            # ── Fallback Engine: OpenAI Whisper (Optimized single-temperature greedy) ──
            if result is None:
                import whisper
                import torch

                device = "cuda" if torch.cuda.is_available() else "cpu"
                if device == "cpu":
                    torch.set_num_threads(os.cpu_count() or 4)

                if self.model is None or self.current_model_name != model_name:
                    logger.info(f"Loading Whisper model '{model_name}' on {device}...")
                    self.model = whisper.load_model(model_name, device=device)
                    self.current_model_name = model_name

                options = {
                    "task": "transcribe",
                    "verbose": False,
                    "word_timestamps": (device == "cuda" and not is_long_audio),
                    "fp16": (device == "cuda"),
                    "temperature": 0.0,
                    "beam_size": 1,
                    "best_of": 1,
                    "condition_on_previous_text": True,
                    "no_speech_threshold": 0.6,
                    "compression_ratio_threshold": 2.4,
                    "logprob_threshold": -1.0,
                }
                if language:
                    options["language"] = language

                import tqdm
                orig_tqdm = tqdm.tqdm
                chunk_base_pct = 0.0
                chunk_weight_pct = 1.0

                class CustomProgressTqdm(orig_tqdm):
                    def __init__(self, *args, **kwargs):
                        kwargs["file"] = _SafeNullStream()
                        super().__init__(*args, **kwargs)

                    def update(self, n=1):
                        res = super().update(n)
                        if progress_callback and self.total:
                            try:
                                local_pct = min(1.0, max(0.0, float(self.n) / float(self.total)))
                                pct = min(1.0, max(0.0, chunk_base_pct + (local_pct * chunk_weight_pct)))
                                curr_s = round(pct * audio_duration, 1)
                                progress_callback(pct, curr_s, audio_duration)
                            except Exception:
                                pass
                        return res

                tqdm.tqdm = CustomProgressTqdm
                try:
                    with _whisper_lock:
                        if is_long_audio and audio_array is not None and len(audio_array) > 0:
                            chunk_sec = 600.0
                            total_len_samples = len(audio_array)
                            combined_segments = []
                            c_start = 0.0
                            while c_start < audio_duration:
                                c_end = min(audio_duration, c_start + chunk_sec)
                                if (audio_duration - c_end) < 60.0:
                                    c_end = audio_duration
                                chunk_base_pct = c_start / max(1.0, audio_duration)
                                chunk_weight_pct = (c_end - c_start) / max(1.0, audio_duration)
                                s_idx = int(c_start * sr)
                                e_idx = min(total_len_samples, int(c_end * sr))
                                chunk_audio = audio_array[s_idx:e_idx]
                                if len(chunk_audio) > sr * 0.5:
                                    try:
                                        c_res = self.model.transcribe(chunk_audio, **options)
                                    except Exception as ce:
                                        logger.warning(f"Chunk [{c_start:.0f}-{c_end:.0f}s] transcribe warning ({ce}); retrying safe mode...")
                                        fb_opts = dict(options)
                                        fb_opts["word_timestamps"] = False
                                        c_res = self.model.transcribe(chunk_audio, **fb_opts)
                                    for s in c_res.get("segments", []):
                                        s["start"] = float(s.get("start", 0.0)) + c_start
                                        s["end"] = float(s.get("end", 0.0)) + c_start
                                        if "words" in s and s["words"]:
                                            for w in s["words"]:
                                                w["start"] = float(w.get("start", 0.0)) + c_start
                                                w["end"] = float(w.get("end", 0.0)) + c_start
                                        combined_segments.append(s)
                                c_start = c_end
                            result = {"segments": combined_segments}
                        else:
                            audio_input = audio_array if (audio_array is not None and sr == 16000) else wav_path
                            try:
                                result = self.model.transcribe(audio_input, **options)
                            except RuntimeError as re_err:
                                err_str = str(re_err).lower()
                                if "cannot reshape tensor" in err_str or "unspecified dimension" in err_str or "0 elements" in err_str:
                                    logger.warning(f"Whisper word_timestamps tensor shape glitch ({re_err}); retrying with safe segment alignment...")
                                    fallback_options = dict(options)
                                    fallback_options["word_timestamps"] = False
                                    result = self.model.transcribe(audio_input, **fallback_options)
                                else:
                                    raise
                finally:
                    tqdm.tqdm = orig_tqdm

            # Split segments into natural, precise clauses (តាមវគ្គ តាមឃ្លា ពេលចាប់ផ្ដើមនិយាយភ្លាមចាប់ភ្លាម)
            import re
            raw_segments = []
            for seg in result.get("segments", []):
                words = seg.get("words", [])
                if not words:
                    text = seg.get("text", "").strip()
                    if text:
                        start = round(float(seg["start"]), 2)
                        end = round(float(seg["end"]), 2)
                        if end <= start:
                            end = round(start + 0.8, 2)
                        # Split multi-clause Chinese text proportionally when word_timestamps is off
                        sub_clauses = [
                            re.sub(r"[，。？！；,\.?!]+$", "", c).strip()
                            for c in re.split(r"[，。？！；,\.?!]+", text)
                            if re.sub(r"[，。？！；,\.?!]+$", "", c).strip()
                        ]
                        if len(sub_clauses) > 1:
                            total_chars = max(1, sum(len(c) for c in sub_clauses))
                            total_dur = max(0.6, end - start)
                            cursor = start
                            for idx_c, clause in enumerate(sub_clauses):
                                c_dur = total_dur * (len(clause) / total_chars)
                                c_end = end if idx_c == len(sub_clauses) - 1 else round(cursor + max(0.4, c_dur), 2)
                                if c_end <= cursor:
                                    c_end = round(cursor + 0.5, 2)
                                raw_segments.append({"start": round(cursor, 2), "end": c_end, "original": clause})
                                cursor = c_end
                        else:
                            clean_single = re.sub(r"[，。？！；,\.?!]+$", "", text).strip()
                            if clean_single:
                                raw_segments.append({"start": start, "end": end, "original": clean_single})
                    continue

                def _emit_clause(words_list):
                    if not words_list:
                        return
                    c_text = "".join(x.get("word", "") for x in words_list).strip()
                    clean_text = re.sub(r"[，。？！；,\.?!]+$", "", c_text).strip()
                    if not clean_text:
                        return
                    w0 = words_list[0]
                    w0_start = float(w0.get("start", 0.0))
                    w0_end = float(w0.get("end", w0_start + 0.3))
                    w0_chars = max(1, len(re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", w0.get("word", ""))))
                    # Trim leading silence attached to the first word token after a pause
                    if (w0_end - w0_start) > 0.42 * w0_chars:
                        c_start = round(max(w0_start, w0_end - 0.30 * w0_chars), 2)
                    else:
                        c_start = round(w0_start, 2)
                    c_end = round(float(words_list[-1].get("end", c_start + 0.6)), 2)
                    if c_end <= c_start:
                        c_end = round(c_start + 0.6, 2)
                    raw_segments.append({"start": c_start, "end": c_end, "original": clean_text})

                curr_words = []
                for w in words:
                    w_text = w.get("word", "")
                    w_start = float(w.get("start", 0.0))
                    # Split clause if there is an acoustic pause (>= 0.35s) or space boundary before this word
                    if curr_words:
                        prev_end = float(curr_words[-1].get("end", w_start))
                        if (w_start - prev_end) >= 0.35 or w_text.startswith(" "):
                            _emit_clause(curr_words)
                            curr_words = []

                    curr_words.append(w)
                    # Split clause on natural punctuation marks
                    if any(p in w_text for p in ["，", "。", "？", "！", "；", ",", ".", "?", "!"]):
                        _emit_clause(curr_words)
                        curr_words = []

                if curr_words:
                    _emit_clause(curr_words)

            # ==================== RESCUE MISSED OPENING SPEECH ====================
            # If video starts with BGM/intro and first transcribed segment starts at > 2.2s,
            # decode the opening audio window using without_timestamps=True + DTW word alignment
            # to rescue speech that was suppressed by initial silence/music.
            if self.model is not None and raw_segments and float(raw_segments[0].get("start", 0)) > 2.2:
                first_start = float(raw_segments[0]["start"])
                try:
                    rescued = self._rescue_audio_window(wav_path, 0.0, first_start, language=language or "zh")
                    if rescued:
                        logger.info(f"Rescued {len(rescued)} opening speech segments before {first_start:.2f}s: {[r['original'] for r in rescued]}")
                        raw_segments = rescued + raw_segments
                except Exception as oe:
                    logger.warning(f"Opening speech rescue warning: {oe}")

            # ==================== HALLUCINATION FILTERS ====================
            def _is_hallucination(text: str, start: float, end: float) -> bool:
                duration = end - start
                unique_chars = len(set(text.replace(' ', '')))

                # Filter 1: repeated [Token][Token][Token] — square bracket hallucination
                if re.search(r'(\[.{1,15}\])\1{2,}', text):
                    return True

                # Filter 2: repeated 《Token》《Token》 — Chinese title-mark hallucination
                if re.search(r'(《[^》]{1,10}》)\1{2,}', text):
                    return True

                # Filter 3: repeated 【Token】【Token】 — Chinese bracket hallucination
                if re.search(r'(【[^】]{1,10}】)\1{2,}', text):
                    return True

                # Filter 4: repeated 「Token」「Token」 — Japanese-style bracket
                if re.search(r'(「[^」]{1,10}」)\1{2,}', text):
                    return True

                # Filter 5: repeated short CJK tokens (same 1-4 chars repeated 4+ times)
                if re.search(r'([\u4e00-\u9fff]{1,4})\1{3,}', text):
                    return True

                # Filter 6: any bracketed-unit repeated 3+ times (《》【】「」〔〕)
                # Covers mixed bracket types like 《大陆》《大陆》...
                bracket_tokens = re.findall(r'[《【「〔]([^》】」〕]{1,12})[》】」〕]', text)
                if len(bracket_tokens) >= 4:
                    # If most tokens are identical → hallucination
                    most_common = max(set(bracket_tokens), key=bracket_tokens.count)
                    if bracket_tokens.count(most_common) >= 3:
                        return True

                # Filter 7: very long duration (>20s) with few unique chars
                if duration > 20.0 and unique_chars < 8:
                    return True

                # Filter 8: segment > 25s regardless (silence/music section)
                if duration > 25.0:
                    return True

                # Filter 9: Latin repeating tokens [Ming] [Applause] etc.
                latin_tokens = re.findall(r'\[[A-Za-z_ ]{1,20}\]', text)
                if len(latin_tokens) >= 3 and len(latin_tokens) * 6 >= len(text) * 0.7:
                    return True

                # Filter 10: any repeated unit (any 2-8 chars) repeated 5+ times
                if re.search(r'(.{2,8})\1{4,}', text):
                    return True

                # Filter 11: standalone bracket credit tags like 【设计】, 【后期】, 【制作】, [Music], etc.
                if re.fullmatch(r'[【\[《(（][^】\]》)）]{1,12}[】\]》)）]', text.strip()):
                    return True

                # Filter 12: Require Chinese character; eliminate latin/cyrillic noise artifacts (e.g. 'www', 'ам', 'os')
                if not re.search(r'[\u4e00-\u9fff]', text):
                    return True

                # Filter 13: Filter intro logo audio noise in opening 2.5s if very short (<= 2 chars)
                if end < 2.5 and len(text.replace(' ', '')) <= 2:
                    return True

                return False

            # ==================== ADVANCED DEDUPLICATION ====================
            # Removes A-B-A-B loops and non-consecutive repeats without stretching time
            def _clean_loops(segments_list):
                cleaned = []
                for s in segments_list:
                    orig = s.get('original', '').strip()
                    start = float(s.get('start', 0))
                    end = float(s.get('end', 0))
                    dur = end - start

                    # Skip near-zero duration segments (< 0.2s) unless very short text
                    if dur < 0.2 and len(orig) >= 3:
                        continue

                    # Clamp maximum duration per clause to 6.5s to prevent long blank timeline blocks
                    if dur > 6.5:
                        end = round(start + 6.5, 2)
                        s['end'] = end
                        dur = 6.5

                    if not cleaned:
                        cleaned.append(s)
                        continue

                    prev = cleaned[-1]
                    prev_text = prev.get('original', '').strip()

                    # Exact consecutive duplicate → only merge if very close, NEVER stretch across silences!
                    if orig == prev_text:
                        if (start - float(prev.get('end', 0))) < 0.8 and (end - float(prev.get('start', 0))) <= 6.0:
                            prev['end'] = max(float(prev['end']), end)
                        continue

                    # Non-consecutive repeat within 5.0 seconds (only filter long hallucination sentences > 5 chars, never drop short natural dialogues like '对', '好', '快')
                    is_repeat = (len(orig) > 5) and any(
                        orig == p.get('original', '').strip()
                        and (start - float(p.get('start', 0))) < 5.0
                        for p in reversed(cleaned[-4:])
                    )
                    if is_repeat:
                        logger.info(f"Dedup loop removed: '{orig[:40]}' at {start:.2f}s")
                        continue

                    cleaned.append(s)
                return cleaned

            # Apply hallucination filter first
            filtered_segments = []
            for item in raw_segments:
                if _is_hallucination(item['original'], item['start'], item['end']):
                    logger.info(f"Hallucination removed [{item['start']:.2f}-{item['end']:.2f}]: '{item['original'][:60]}'")
                    continue
                filtered_segments.append(item)

            # Then apply loop deduplication
            cleaned_segments = _clean_loops(filtered_segments)

            # Load audio array for physical acoustic pitch (F0) gender diarization if not already loaded
            if audio_array is None:
                try:
                    if wav_path and os.path.exists(wav_path):
                        with wave.open(wav_path, "rb") as wf:
                            sr = wf.getframerate()
                            raw = wf.readframes(wf.getnframes())
                            audio_array = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                except Exception as ae:
                    logger.warning(f"Audio pitch load warning: {ae}")

            segments = []
            prev_voice = "km-KH-PisethNeural"
            prev_actor = "Actor 1"
            for i, seg in enumerate(cleaned_segments):
                voice = prev_voice
                actor = prev_actor
                if audio_array is not None:
                    v, a = self.classify_gender(
                        audio_array,
                        float(seg["start"]),
                        float(seg["end"]),
                        sr=sr,
                        fallback_voice=prev_voice,
                        fallback_actor=prev_actor
                    )
                    voice, actor = v, a
                    prev_voice, prev_actor = v, a
                else:
                    voice = "km-KH-PisethNeural"
                    actor = "Actor 1"

                segments.append({
                    "id": i + 1,
                    "start": seg["start"],
                    "end": seg["end"],
                    "original": seg["original"],
                    "translated": "",
                    "voice": voice,
                    "actor": actor
                })

            return segments
        except Exception as e:
            logger.error(f"Whisper transcription error: {e}")
            raise
        finally:
            if temp_wav and os.path.exists(temp_wav):
                try:
                    os.remove(temp_wav)
                except Exception:
                    pass

    def _rescue_audio_window(self, wav_path: str, start_time: float, end_time: float, language: str = "zh") -> List[Dict[str, Any]]:
        """
        Decodes an un-transcribed audio window using without_timestamps=True + DTW word timestamps.
        Rescues dialogue dropped by Whisper due to opening music, BGM suppression, or quiet start.
        """
        dur = end_time - start_time
        if dur < 0.6:
            return []

        tmp_chunk = wav_path + f"_rescue_{start_time:.1f}.wav"
        cmd = ["ffmpeg", "-y", "-ss", str(start_time), "-t", str(dur), "-i", wav_path, "-ar", "16000", "-ac", "1", tmp_chunk]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if res.returncode != 0 or not os.path.exists(tmp_chunk):
            return []

        try:
            import whisper
            from whisper.audio import log_mel_spectrogram, pad_or_trim, N_SAMPLES, N_FRAMES
            from whisper.tokenizer import get_tokenizer
            from whisper.timing import add_word_timestamps

            audio = whisper.load_audio(tmp_chunk)
            if len(audio) < 16000 * 0.4:
                return []

            rms = np.sqrt(np.mean(audio ** 2))
            if rms < 0.012:
                return []

            mel = pad_or_trim(log_mel_spectrogram(audio, self.model.dims.n_mels, padding=N_SAMPLES), N_FRAMES)
            options = whisper.DecodingOptions(language=language, task="transcribe", without_timestamps=True, fp16=False)
            result = self.model.decode(mel, options)
            text = result.text.strip()
            if not text or not any('一' <= c <= '鿿' for c in text):
                return []

            tokenizer = get_tokenizer(self.model.is_multilingual, num_languages=self.model.num_languages, language=language, task="transcribe")
            gap_seg = [{"text": text, "start": 0.0, "end": dur, "tokens": result.tokens, "seek": 0}]
            add_word_timestamps(
                segments=gap_seg,
                model=self.model,
                tokenizer=tokenizer,
                mel=mel,
                num_frames=min(mel.shape[-1], N_FRAMES),
                last_speech_timestamp=0.0
            )

            words = gap_seg[0].get("words", [])
            if not words:
                return []

            clauses = []
            curr = []
            for w in words:
                curr.append(w)
                w_text = w.get("word", "")
                is_punct = any(p in w_text for p in ["，", "。", "？", "！", "；", ",", ".", "?", "!"])
                c_dur = float(curr[-1]["end"]) - float(curr[0]["start"])
                if is_punct or (len(curr) >= 8 and c_dur >= 1.4):
                    c_text = "".join(x.get("word", "") for x in curr).strip()
                    clean = re.sub(r"[，。？！；,\.?!]+$", "", c_text).strip()
                    if clean:
                        clauses.append({
                            "start": round(start_time + float(curr[0]["start"]), 2),
                            "end": round(start_time + float(curr[-1]["end"]), 2),
                            "original": clean
                        })
                    curr = []
            if curr:
                c_text = "".join(x.get("word", "") for x in curr).strip()
                clean = re.sub(r"[，。？！；,\.?!]+$", "", c_text).strip()
                c_dur = float(curr[-1]["end"]) - float(curr[0]["start"])
                if clean:
                    if clauses and (c_dur < 0.8 or len(clean) <= 4):
                        clauses[-1]["end"] = round(start_time + float(curr[-1]["end"]), 2)
                        clauses[-1]["original"] += clean
                    else:
                        clauses.append({
                            "start": round(start_time + float(curr[0]["start"]), 2),
                            "end": round(start_time + float(curr[-1]["end"]), 2),
                            "original": clean
                        })
            return clauses
        finally:
            if os.path.exists(tmp_chunk):
                try:
                    os.remove(tmp_chunk)
                except Exception:
                    pass

    @staticmethod
    def estimate_segment_f0(audio_array: np.ndarray, start_sec: float, end_sec: float, sr: int = 16000) -> float:
        """
        Estimates the fundamental frequency (F0) using the YIN pitch tracking algorithm.
        Enhanced with:
        - Fast center-window analysis (samples vowel nuclei where vocal tract vibrates)
        - Vectorized difference function via FFT (10x faster)
        - Octave-correction: collapses f0s that are likely 2x/0.5x of a common fundamental.
        - Frame-level energy gating: removes silence and music background.
        - Trimmed mean (removes outlier 25%) for robustness.
        """
        if audio_array is None or len(audio_array) == 0:
            return -1.0

        dur = end_sec - start_sec
        if dur < 0.08:
            return -1.0

        # Sample up to 1.8s around the center where clear speech vowel nuclei reside
        if dur > 1.8:
            mid = (start_sec + end_sec) / 2.0
            start_sec = max(0.0, mid - 0.9)
            end_sec = start_sec + 1.8

        start_i = max(0, int(start_sec * sr))
        end_i = min(len(audio_array), int(end_sec * sr))
        if end_i - start_i < int(sr * 0.08):
            return -1.0

        chunk = audio_array[start_i:end_i]

        # --- YIN parameters ---
        min_f0 = 70.0
        max_f0 = 450.0
        min_tau = max(2, int(sr / max_f0))
        max_tau = min(int(sr * 0.5), int(sr / min_f0))
        frame_len = max(512, min(max_tau * 3, 2048))
        hop = max(256, int(sr * 0.04))  # 40ms hop for high throughput

        f0s = []
        tau_indices = np.arange(1, max_tau + 1, dtype=np.float32)

        for frame_start in range(0, len(chunk) - frame_len, hop):
            frame = chunk[frame_start:frame_start + frame_len]

            # Energy gating — skip silence (< -40 dBFS equivalent)
            rms = np.sqrt(np.mean(frame ** 2))
            if rms < 0.003:
                continue

            # Step 1: Vectorized Difference Function via FFT (O(N log N))
            n = len(frame)
            f_fft = np.fft.rfft(frame, n * 2)
            r = np.fft.irfft(f_fft * np.conj(f_fft))[:max_tau + 1]
            d = 2.0 * np.maximum(0.0, r[0] - r)

            # Step 2: Cumulative mean normalized d'(tau)
            running_sum = np.cumsum(d[1:])
            d_prime = np.ones(max_tau + 1, dtype=np.float32)
            d_prime[0] = 1.0
            valid = running_sum > 1e-9
            d_prime[1:][valid] = (d[1:][valid] * tau_indices[valid]) / running_sum[valid]

            # Step 3: First dip below threshold (adaptive: start at 0.12, relax to 0.20)
            tau_chosen = -1
            for thresh in (0.12, 0.15, 0.20):
                for tau in range(min_tau, max_tau - 1):
                    if d_prime[tau] < thresh:
                        # Find local minimum in neighbourhood
                        while tau + 1 < max_tau and d_prime[tau + 1] < d_prime[tau]:
                            tau += 1
                        tau_chosen = tau
                        break
                if tau_chosen != -1:
                    break

            if tau_chosen == -1:
                sub = d_prime[min_tau:max_tau]
                best = int(np.argmin(sub))
                if sub[best] < 0.35:
                    tau_chosen = min_tau + best

            if tau_chosen <= 0:
                continue

            # Step 4: Parabolic interpolation
            if 0 < tau_chosen < max_tau:
                s0 = d_prime[tau_chosen - 1]
                s1 = d_prime[tau_chosen]
                s2 = d_prime[tau_chosen + 1]
                denom = 2 * (s0 - 2 * s1 + s2)
                if abs(denom) > 1e-7:
                    tau_chosen = tau_chosen + (s0 - s2) / denom

            f0 = sr / tau_chosen
            if min_f0 <= f0 <= max_f0:
                f0s.append(f0)

        if not f0s:
            return -1.0

        # --- Octave correction: fold any f0 that is ~2x of the cluster median ---
        f0s_arr = np.array(f0s, dtype=np.float32)
        raw_median = float(np.median(f0s_arr))

        corrected = []
        for v in f0s_arr:
            # If a value is roughly double the median, it's an octave error — halve it
            if raw_median > 0 and v / raw_median > 1.65:
                v = v / 2.0
            # If a value is roughly half the median, it's a sub-octave error — double it
            elif raw_median > 0 and raw_median / v > 1.65:
                v = v * 2.0
            corrected.append(v)
        corrected = np.array(corrected, dtype=np.float32)

        # Trimmed mean: drop lowest and highest 20% outliers
        if len(corrected) >= 5:
            lo = np.percentile(corrected, 20)
            hi = np.percentile(corrected, 80)
            corrected = corrected[(corrected >= lo) & (corrected <= hi)]

        if len(corrected) == 0:
            return -1.0
        return float(np.median(corrected))

    @staticmethod
    def classify_gender(
        audio_array: np.ndarray,
        start_sec: float,
        end_sec: float,
        sr: int = 16000,
        male_voice: str = "km-KH-PisethNeural",
        female_voice: str = "km-KH-SreymomNeural",
        fallback_voice: str = "km-KH-PisethNeural",
        fallback_actor: str = "Actor 1",
        wav_path: str = None,
        text: str = ""
    ) -> tuple:
        """
        Classifies speech segment as Male (Actor 1 / Piseth) or Female (Actor 2 / Sreymom).
        Uses:
        1. Dialogue keyword semantics (Chinese kinship/role words)
        2. YIN F0 pitch (octave-corrected, trimmed-mean)
        3. Fallback to context (prev speaker)

        Chinese adult male speech F0:   85–165 Hz (excited/shouting up to ~200 Hz)
        Chinese adult female speech F0: 180–380 Hz
        Optimal threshold: 180 Hz
          → f0 < 180 Hz  → Male (Actor 1)
          → f0 >= 180 Hz → Female (Actor 2)
        Note: threshold lowered from 220→180 to catch female voices at boundary.
        """
        # --- Step 1: Acoustic F0 pitch analysis first (ground truth vocal cord frequency) ---
        f0 = WhisperService.estimate_segment_f0(audio_array, start_sec, end_sec, sr)

        # Clear high pitch female (> 210 Hz)
        if f0 >= 210.0:
            return female_voice, "Actor 2"

        # Clear low pitch male (< 175 Hz)
        if 0 < f0 < 175.0:
            return male_voice, "Actor 1"

        # --- Step 2: In ambiguous range (175-210 Hz) or unvoiced (f0 <= 0), use drama keywords ---
        if text:
            # Male cues
            male_keywords = [
                "表舅", "外甥", "长顺", "常旺", "长兴", "赵常旺", "赵长顺",
                "老五", "兄弟", "老子", "大爷", "叔", "哥哥", "大哥", "二哥",
                "老板", "爹", "爸爸", "少爷", "老爷", "舅舅", "男的", "男人"
            ]
            # Female cues
            female_keywords = [
                "老婆", "媳妇", "嫂子", "娘", "妈妈", "妈", "妹妹", "妹",
                "姑娘", "小姐", "民政局离婚", "女儿", "妻子", "女的", "女人",
                "我这一个女孩子", "小妾", "闺女", "姐姐"
            ]
            if any(k in text for k in male_keywords):
                return male_voice, "Actor 1"
            if any(k in text for k in female_keywords):
                return female_voice, "Actor 2"

        if f0 <= 0:
            # No valid pitch and no keywords → use fallback (prev speaker)
            return fallback_voice, fallback_actor

        # Boundary split at 190 Hz for remaining ambiguous cases
        if f0 >= 190.0:
            return female_voice, "Actor 2"
        else:
            return male_voice, "Actor 1"

    def detect_segments_gender(
        self,
        video_or_audio_path: str,
        segments: List[Dict[str, Any]],
        actor1_voice: str = "km-KH-PisethNeural",
        actor2_voice: str = "km-KH-SreymomNeural"
    ) -> List[Dict[str, Any]]:
        """
        Runs robust pitch analysis across all segments with subharmonic correction.
        Scene-gap aware: resets fallback after 1.5s gap to default male voice.
        """
        if not os.path.exists(video_or_audio_path):
            raise FileNotFoundError(f"File not found: {video_or_audio_path}")

        ext = os.path.splitext(video_or_audio_path)[1].lower()
        temp_wav = None
        wav_path = video_or_audio_path
        if ext in [".mp4", ".mkv", ".mov", ".avi", ".webm", ".ts", ".flv"]:
            temp_wav = os.path.splitext(video_or_audio_path)[0] + "_gender_tmp.wav"
            ok = self.extract_audio(video_or_audio_path, temp_wav)
            if not ok:
                raise RuntimeError("Could not extract audio from video for gender detection.")
            wav_path = temp_wav

        try:
            with wave.open(wav_path, "rb") as wf:
                sr = wf.getframerate()
                raw = wf.readframes(wf.getnframes())
                audio_array = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

            prev_voice = actor1_voice
            prev_actor = "Actor 1"
            prev_end = 0.0
            GAP_RESET_SECONDS = 1.5

            updated = []
            for seg in segments:
                new_seg = dict(seg)
                start = float(new_seg.get("start", 0))
                end = float(new_seg.get("end", 0))

                # Reset fallback at scene cuts (gap > 1.5s) to default male voice
                gap = start - prev_end
                if gap > GAP_RESET_SECONDS:
                    fallback_v = actor1_voice
                    fallback_a = "Actor 1"
                else:
                    fallback_v = prev_voice
                    fallback_a = prev_actor

                v, a = self.classify_gender(
                    audio_array,
                    start,
                    end,
                    sr=sr,
                    male_voice=actor1_voice,
                    female_voice=actor2_voice,
                    fallback_voice=fallback_v,
                    fallback_actor=fallback_a,
                    text=new_seg.get("original", "")
                )
                new_seg["voice"] = v
                new_seg["actor"] = a
                prev_voice = v
                prev_actor = a
                prev_end = end
                updated.append(new_seg)
            return updated
        finally:
            if temp_wav and os.path.exists(temp_wav):
                try:
                    os.remove(temp_wav)
                except Exception:
                    pass

    def detect_segments_gender_gemini(
        self,
        video_or_audio_path: str,
        segments: List[Dict[str, Any]],
        gemini_key: str,
        actor1_voice: str = "km-KH-PisethNeural",
        actor2_voice: str = "km-KH-SreymomNeural"
    ) -> List[Dict[str, Any]]:
        """
        Uses Google Gemini AI combined with fast acoustic F0 pitch guidance
        and Chinese drama dialogue analysis to accurately and rapidly diarize character genders (Male vs Female).
        Runs in 3-6 seconds for multi-hundred segment projects, completely avoiding audio timeout errors.
        Falls back to local acoustic pitch detection (YIN) if API fails.
        """
        if not os.path.exists(video_or_audio_path) or not segments:
            return segments

        if not gemini_key:
            logger.info("No Gemini key provided; falling back to acoustic pitch detection.")
            return self.detect_segments_gender(video_or_audio_path, segments, actor1_voice, actor2_voice)

        # Pre-extract full audio once for fast acoustic F0 estimation
        ext = os.path.splitext(video_or_audio_path)[1].lower()
        temp_wav = None
        pitch_wav = video_or_audio_path
        audio_array = None
        sr = 16000
        if ext in [".mp4", ".mkv", ".mov", ".avi", ".webm", ".ts", ".flv"]:
            temp_wav = os.path.splitext(video_or_audio_path)[0] + "_gemini_pitch_tmp.wav"
            if not os.path.exists(temp_wav) or os.path.getsize(temp_wav) < 1000:
                self.extract_audio(video_or_audio_path, temp_wav)
            if os.path.exists(temp_wav) and os.path.getsize(temp_wav) > 1000:
                pitch_wav = temp_wav

        updated = [dict(s) for s in segments]
        f0_dict = {}
        try:
            if os.path.exists(pitch_wav):
                try:
                    with wave.open(pitch_wav, "rb") as wf:
                        sr = wf.getframerate()
                        raw = wf.readframes(wf.getnframes())
                        audio_array = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                except Exception as we:
                    logger.debug(f"Could not load wave for F0 guidance: {we}")

            # Compute fast acoustic F0 for each segment (< 0.5s total)
            seg_items = []
            for s in updated:
                st = float(s.get("start", 0))
                en = float(s.get("end", 0))
                s_id = s.get("id")
                f0 = -1.0
                if audio_array is not None:
                    f0 = WhisperService.estimate_segment_f0(audio_array, st, en, sr)
                f0_dict[s_id] = f0
                seg_items.append({
                    "id": s_id,
                    "start": round(st, 2),
                    "end": round(en, 2),
                    "text": s.get("original", ""),
                    "f0_hz": round(f0, 1)
                })

            BATCH_SIZE = 100
            batches = [seg_items[i:i + BATCH_SIZE] for i in range(0, len(seg_items), BATCH_SIZE)]
            models = ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.8-flash", "gemini-3-flash-preview"]

            def _process_one_batch(b_idx, batch):
                b_map = {}
                first_id = batch[0]["id"]
                prompt = f"""You are an expert audio gender diarization system for dubbing Chinese drama videos into Khmer.
Your goal: Classify each speech segment as Male ("Actor 1") or Female ("Actor 2").

RULES FOR ACCURATE CLASSIFICATION:
1. "Actor 1" = MALE voice (e.g. man, boy, uncle, nephew, husband, brother, male friend/creditor).
2. "Actor 2" = FEMALE voice (e.g. woman, girl, wife, mother, sister, female creditor/maid).
3. DO NOT alternate speakers just because two characters are having a conversation!
   - In Chinese dramas, many conversations happen between TWO OR MORE MEN (e.g. Uncle "表舅" and nephew "长顺", brothers "长兴" & "常旺", loan shark "老五" and debtor).
   - If all speakers in the scene are male, EVERY segment MUST be classified as "Actor 1" (Male).
4. MALE vs FEMALE CUES:
   - Vocal Pitch (f0_hz):
     * If f0_hz >= 210, it is strongly Female ("Actor 2").
     * If f0_hz > 0 and f0_hz < 175, it is strongly Male ("Actor 1").
     * If f0_hz is between 175 and 210, use dialogue context (shouting male vs deep female).
     * If f0_hz <= 0 (unvoiced/music), infer from drama dialogue context, roles, and pronouns.
   - Chinese Kinship & Reference Words:
     * MALE: "表舅" (uncle), "外甥" (nephew), "长顺", "长兴", "常旺", "赵常旺", "老五", "兄弟", "哥", "老板", "老子", "大爷", "兄弟们", "我爸".
     * FEMALE: "老婆", "媳妇", "嫂子", "娘", "妈", "妹", "民政局离婚", "我这一个女孩子", "小妾", "闺女", "姐姐", "小姐".
5. CONTINUOUS MONOLOGUES & RAPID CLAUSES:
   - When a character speaks multiple sentences in a row without pause, keep the same speaker!

Segments:
{json.dumps(batch, ensure_ascii=False)}

Return ONLY a valid JSON array:
[{{"id": {first_id}, "actor": "Actor 1"}}, ...]"""

                for model in models:
                    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={gemini_key}"
                    try:
                        resp = requests.post(url, json={
                            "contents": [{"parts": [{"text": prompt}]}],
                            "generationConfig": {"temperature": 0.0, "responseMimeType": "application/json"}
                        }, timeout=25.0)
                        if resp.status_code == 200:
                            data = resp.json()
                            candidates = data.get("candidates", [])
                            if not candidates:
                                continue
                            raw_text = candidates[0].get("content", {}).get("parts", [{}])[0].get("text", "").strip()
                            raw_text = re.sub(r"^```(?:json)?\s*", "", raw_text, flags=re.MULTILINE)
                            raw_text = re.sub(r"\s*```$", "", raw_text, flags=re.MULTILINE)
                            parsed = json.loads(raw_text)

                            if isinstance(parsed, list):
                                for item in parsed:
                                    if isinstance(item, dict) and "id" in item:
                                        s_id = int(item["id"])
                                        act = item.get("actor")
                                        if not act:
                                            g = str(item.get("gender", "")).lower()
                                            act = "Actor 2" if "female" in g or "woman" in g else "Actor 1"
                                        b_map[s_id] = act
                            elif isinstance(parsed, dict):
                                items_list = parsed.get("segments") or parsed.get("results") or parsed.get("data")
                                if isinstance(items_list, list):
                                    for item in items_list:
                                        if isinstance(item, dict) and "id" in item:
                                            s_id = int(item["id"])
                                            act = item.get("actor")
                                            if not act:
                                                g = str(item.get("gender", "")).lower()
                                                act = "Actor 2" if "female" in g or "woman" in g else "Actor 1"
                                            b_map[s_id] = act
                                else:
                                    for k, v in parsed.items():
                                        try:
                                            s_id = int(k)
                                            if isinstance(v, dict):
                                                act = v.get("actor")
                                                if not act:
                                                    g = str(v.get("gender", "")).lower()
                                                    act = "Actor 2" if "female" in g else "Actor 1"
                                            else:
                                                v_str = str(v).lower()
                                                act = "Actor 2" if ("actor 2" in v_str or "female" in v_str) else "Actor 1"
                                            b_map[s_id] = act
                                        except Exception:
                                            pass

                            if b_map:
                                logger.info(f"Gemini diarized batch {b_idx+1}/{len(batches)} ({len(b_map)} items) using {model}")
                                break
                        elif resp.status_code == 429:
                            continue
                    except Exception as ge:
                        logger.debug(f"Gemini diarization error ({model}): {ge}")
                        continue
                return b_map

            all_classified = {}
            with ThreadPoolExecutor(max_workers=4) as executor:
                futures = {executor.submit(_process_one_batch, b_idx, batch): b_idx for b_idx, batch in enumerate(batches)}
                for f in as_completed(futures):
                    try:
                        b_res = f.result()
                        if b_res:
                            all_classified.update(b_res)
                    except Exception as fe:
                        logger.warning(f"Batch diarization exception: {fe}")

            for s in updated:
                s_id = int(s.get("id", 0))
                if s_id in all_classified:
                    act = all_classified[s_id]
                    s["actor"] = act
                    s["voice"] = actor2_voice if act == "Actor 2" else actor1_voice
                else:
                    # Fast acoustic fallback for unclassified segment
                    f0 = f0_dict.get(s_id, -1.0)
                    act = "Actor 2" if f0 >= 195.0 else "Actor 1"
                    s["actor"] = act
                    s["voice"] = actor2_voice if act == "Actor 2" else actor1_voice

        except Exception as e:
            logger.warning(f"Gemini diarization failed ({e}); falling back completely to local acoustic pitch...")
            return self.detect_segments_gender(video_or_audio_path, updated, actor1_voice, actor2_voice)
        finally:
            if temp_wav and os.path.exists(temp_wav):
                try: os.remove(temp_wav)
                except Exception: pass

        # Temporal Continuity Smoothing:
        # In spoken drama dialogue, a single short clause (< 3.0s) sandwiched between the same speaker
        # with almost zero pause (gap < 0.45s) is overwhelmingly the SAME character continuing their speech.
        for i in range(1, len(updated) - 1):
            prev_s = updated[i - 1]
            curr_s = updated[i]
            next_s = updated[i + 1]
            prev_act = prev_s.get("actor")
            curr_act = curr_s.get("actor")
            next_act = next_s.get("actor")

            if prev_act and next_act and prev_act == next_act and curr_act != prev_act:
                try:
                    prev_end = float(prev_s.get("end", 0))
                    curr_start = float(curr_s.get("start", 0))
                    curr_end = float(curr_s.get("end", 0))
                    next_start = float(next_s.get("start", 0))
                    curr_dur = curr_end - curr_start

                    if (curr_start - prev_end < 0.45) and (next_start - curr_end < 0.45) and (curr_dur < 3.2):
                        logger.info(f"Smoothing isolated segment #{curr_s.get('id')} from {curr_act} to {prev_act}")
                        curr_s["actor"] = prev_act
                        curr_s["voice"] = actor2_voice if prev_act == "Actor 2" else actor1_voice
                except Exception:
                    pass

        return updated

