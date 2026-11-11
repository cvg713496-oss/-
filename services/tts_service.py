import os
import re
import asyncio
import subprocess
import hashlib
import logging
from typing import Optional

logger = logging.getLogger(__name__)

class TTSService:
    VOICES = {
        "km-KH-PisethNeural": {
            "name": "km-KH-PisethNeural (ប្រុស / Male)",
            "gender": "Male",
            "lang": "km-KH"
        },
        "km-KH-SreymomNeural": {
            "name": "km-KH-SreymomNeural (ស្រី / Female)",
            "gender": "Female",
            "lang": "km-KH"
        }
    }

    def __init__(self, cache_dir: str = "temp/tts_cache"):
        self.cache_dir = cache_dir
        os.makedirs(self.cache_dir, exist_ok=True)

    @staticmethod
    def _sanitize_khmer_tts_text(text: str) -> str:
        """Strip Greek letters, emojis, control characters, and unsupported symbols that cause Edge-TTS to hang."""
        if not text:
            return ""
        # Strip Greek letters, math symbols, strange unicode
        text = re.sub(r"[\u0370-\u03FF\u1F00-\u1FFF]+", " ", text)  # Greek
        text = re.sub(r"[\u0E00-\u0E7F]+", " ", text)               # Thai
        text = re.sub(r"[\U00010000-\U0010ffff]", " ", text)         # Emojis
        text = re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", text)           # Control chars
        # Strip unpronounceable symbols / slashes
        text = re.sub(r"[/\\_~^|*#@$%&=<>+]+", " ", text)
        # Normalize whitespace
        text = re.sub(r"\s+", " ", text).strip()
        return text

    def _get_cache_filename(self, text: str, voice: str, rate: str, pitch: str) -> str:
        clean_text = self._sanitize_khmer_tts_text(text)
        key = f"{clean_text}_{voice}_{rate}_{pitch}"
        hash_val = hashlib.md5(key.encode("utf-8")).hexdigest()
        return os.path.join(self.cache_dir, f"{hash_val}.mp3")

    async def generate_speech_async(self, text: str, voice: str = "km-KH-PisethNeural", 
                                   rate: str = "+0%", pitch: str = "+0Hz", 
                                   output_file: Optional[str] = None) -> str:
        """Generate Khmer TTS audio file using Edge-TTS with text sanitization and safe concurrency."""
        clean_text = self._sanitize_khmer_tts_text(text)
        if not clean_text:
            if not output_file:
                output_file = os.path.join(self.cache_dir, "silence.mp3")
            self._generate_silence(0.5, output_file)
            return output_file

        is_custom_output = bool(output_file)
        if not output_file:
            output_file = self._get_cache_filename(clean_text, voice, rate, pitch)

        # Only trust cache files that are actual speech (> 3200 bytes for MP3)
        if os.path.exists(output_file) and os.path.getsize(output_file) > 3200:
            return output_file

        try:
            import edge_tts
            communicate = edge_tts.Communicate(text=clean_text, voice=voice, rate=rate, pitch=pitch)
            await asyncio.wait_for(communicate.save(output_file), timeout=10.0)
            if os.path.exists(output_file) and os.path.getsize(output_file) > 1000:
                return output_file
        except Exception as e:
            logger.warning(f"Edge-TTS attempt 1 failed ({e}) for '{clean_text[:20]}', retrying...")
            try:
                await asyncio.sleep(0.4)
                import edge_tts
                communicate = edge_tts.Communicate(text=clean_text, voice=voice, rate=rate, pitch=pitch)
                await asyncio.wait_for(communicate.save(output_file), timeout=10.0)
                if os.path.exists(output_file) and os.path.getsize(output_file) > 1000:
                    return output_file
            except Exception as e2:
                logger.warning(f"Edge-TTS generation failed ({e2}) for '{clean_text[:20]}', creating transient fallback...")
                # IMPORTANT: If output_file is in cache_dir, do NOT corrupt the cache file with silence!
                if is_custom_output:
                    self._generate_silence(0.8, output_file)
                    return output_file
                else:
                    fallback_path = os.path.join(self.cache_dir, "transient_silence.mp3")
                    if not os.path.exists(fallback_path):
                        self._generate_silence(0.8, fallback_path)
                    return fallback_path
        return output_file

    def generate_speech(self, text: str, voice: str = "km-KH-PisethNeural",
                        rate: str = "+0%", pitch: str = "+0Hz",
                        output_file: Optional[str] = None) -> str:
        """Synchronous wrapper for speech generation."""
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # Run in existing loop via executor or separate thread
                import concurrent.futures
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    return pool.submit(asyncio.run, self.generate_speech_async(text, voice, rate, pitch, output_file)).result()
            else:
                return loop.run_until_complete(self.generate_speech_async(text, voice, rate, pitch, output_file))
        except RuntimeError:
            return asyncio.run(self.generate_speech_async(text, voice, rate, pitch, output_file))

    def _generate_silence(self, duration_sec: float, output_file: str):
        """Generate silent audio using ffmpeg."""
        cmd = [
            "ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r=24000:cl=mono",
            "-t", str(duration_sec), "-q:a", "9", "-acodec", "libmp3lame",
            output_file
        ]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def get_audio_duration(self, audio_file: str) -> float:
        """Get exact duration in seconds using ffprobe."""
        try:
            cmd = [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", audio_file
            ]
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            return float(res.stdout.strip())
        except Exception:
            return 1.0
