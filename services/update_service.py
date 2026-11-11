import os
import json
import logging
import subprocess
import urllib.request
import urllib.error
import time
from typing import Dict, Any, Optional

logger = logging.getLogger("UpdateService")

def to_khmer_num(n: int) -> str:
    """Convert integer to authentic Khmer digits."""
    khmer_digits = {"0": "០", "1": "១", "2": "២", "3": "៣", "4": "៤", "5": "៥", "6": "៦", "7": "៧", "8": "៨", "9": "៩"}
    return "".join(khmer_digits.get(ch, ch) for ch in str(n))

class UpdateService:
    def __init__(self, base_dir: str = "."):
        self.base_dir = os.path.abspath(base_dir)
        self.version_file = os.path.join(self.base_dir, "version.json")
        self.server_start_time = time.time()
        self.simulated_step = 0  # 0: None, 1: 1ដង, 2: 2ដង, 3: 3ដង, 4: v1.0.1
        self.cached_check_result = None
        self.last_check_time = 0

    def get_local_version_info(self) -> Dict[str, Any]:
        """Read version info from version.json or return defaults."""
        default_info = {
            "version": "1.0.0",
            "base_version": "1.0.0",
            "update_count": 0,
            "pending_updates": 0,
            "build": "20261108.01",
            "channel": "stable",
            "name": "Vocal Studio",
            "release_date": "2026-11-08",
            "github_repo": "",
            "remote_version_url": "",
            "changelog": "V1.0.0:\n- កម្មវិធីសម្រាយរឿង និង Dubbing ស្វ័យប្រវត្តិចិនទៅខ្មែរ\n- Whisper AI Speech-to-Text និងបំបែកប្រយោគតាមវគ្គ តាមឃ្លា\n- គាំទ្រ Gemini AI / Google Cloud / DeepL / OpenAI សម្រាប់សម្រាយរឿង\n- Timeline Multi-track (ប្រុស/ស្រី), ភ្លេង BGM, Blur អក្សរចិន, និង Watermark\n- Windows Desktop Tool (VocalStudio.exe)"
        }
        if os.path.exists(self.version_file):
            try:
                with open(self.version_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    default_info.update(data)
            except Exception as e:
                logger.error(f"Error reading version.json: {e}")
        return default_info

    def save_version_info(self, updates: Dict[str, Any]) -> bool:
        """Update fields in version.json."""
        current = self.get_local_version_info()
        current.update(updates)
        try:
            with open(self.version_file, "w", encoding="utf-8") as f:
                json.dump(current, f, ensure_ascii=False, indent=2)
            return True
        except Exception as e:
            logger.error(f"Error saving version.json: {e}")
            return False

    def get_baseline_timestamp(self) -> float:
        """Get the baseline timestamp when the current version was installed/applied."""
        info = self.get_local_version_info()
        base_ts = info.get("baseline_timestamp")
        if base_ts and isinstance(base_ts, (int, float)):
            return float(base_ts)
        if os.path.exists(self.version_file):
            return os.path.getmtime(self.version_file)
        return self.server_start_time

    def get_modified_code_count(self) -> int:
        """Count distinct core code files modified since the baseline timestamp."""
        check_dirs = [
            os.path.join(self.base_dir, "services"),
            os.path.join(self.base_dir, "static", "js"),
            os.path.join(self.base_dir, "static", "css")
        ]
        files = [
            os.path.join(self.base_dir, "app.py"),
            os.path.join(self.base_dir, "static", "index.html")
        ]
        for d in check_dirs:
            if os.path.exists(d):
                for f in os.listdir(d):
                    if f.endswith((".py", ".js", ".css")):
                        files.append(os.path.join(d, f))

        baseline = self.get_baseline_timestamp()
        count = 0
        for fpath in files:
            if os.path.exists(fpath):
                # If file was modified more than 1 second after baseline
                if os.path.getmtime(fpath) > (baseline + 1.0):
                    count += 1
        return count

    def bump_version(self, current_ver: str, update_count: int) -> str:
        """
        When update_count >= 4, increment the version accordingly.
        4 updates -> 1.0.1
        5 updates -> 1.0.2
        6 updates -> 1.0.3
        ...
        """
        raw = current_ver.strip().lstrip("vV")
        parts = raw.split(".")
        try:
            major = int(parts[0]) if len(parts) > 0 else 1
            minor = int(parts[1]) if len(parts) > 1 else 0
            patch = int(parts[2]) if len(parts) > 2 else 0
        except Exception:
            major, minor, patch = 1, 0, 0

        # Starting from 4 updates, bump patch version by (update_count - 3)
        patch_bump = max(1, update_count - 3)
        return f"{major}.{minor}.{patch + patch_bump}"

    def has_git(self) -> bool:
        """Check if project is a Git repository."""
        return os.path.exists(os.path.join(self.base_dir, ".git"))

    def check_git_remote_update(self) -> Optional[Dict[str, Any]]:
        """Check if remote git branch has newer commits."""
        if not self.has_git():
            return None
        try:
            local_commit = subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=self.base_dir, stderr=subprocess.PIPE, timeout=2.5
            ).decode().strip()

            remotes = subprocess.check_output(
                ["git", "remote"],
                cwd=self.base_dir, stderr=subprocess.PIPE, timeout=2.5
            ).decode().strip().split()

            if "origin" not in remotes:
                return None

            out = subprocess.check_output(
                ["git", "ls-remote", "origin", "-h", "refs/heads/main", "refs/heads/master"],
                cwd=self.base_dir, stderr=subprocess.PIPE, timeout=4.0
            ).decode().strip()

            if out:
                lines = out.strip().split("\n")
                remote_commit = lines[0].split()[0].strip()
                if remote_commit and remote_commit != local_commit:
                    return {
                        "has_update": True,
                        "source": "git",
                        "local_commit": local_commit[:7],
                        "remote_commit": remote_commit[:7],
                        "message": f"មានកូដថ្មីនៅលើ Git (Commit: {remote_commit[:7]})!"
                    }
        except Exception as e:
            logger.debug(f"Git remote check skipped or error: {e}")
        return None

    def check_github_repo_update(self, repo_str: str) -> Optional[Dict[str, Any]]:
        """Check GitHub API or raw version.json for updates."""
        if not repo_str or not repo_str.strip():
            return None

        clean_repo = repo_str.strip()
        if "github.com/" in clean_repo:
            clean_repo = clean_repo.split("github.com/")[-1].strip("/")
            if clean_repo.endswith(".git"):
                clean_repo = clean_repo[:-4]

        parts = clean_repo.split("/")
        if len(parts) != 2:
            return None

        owner, repo = parts[0], parts[1]

        for branch in ["main", "master"]:
            raw_url = f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/version.json"
            try:
                req = urllib.request.Request(raw_url, headers={"User-Agent": "VocalStudio-Updater"})
                with urllib.request.urlopen(req, timeout=3.5) as response:
                    if response.status == 200:
                        remote_data = json.loads(response.read().decode())
                        remote_ver = remote_data.get("version", "")
                        local_ver = self.get_local_version_info().get("version", "1.0.0")
                        if remote_ver and remote_ver != local_ver:
                            return {
                                "has_update": True,
                                "source": "github_raw",
                                "latest_version": remote_ver,
                                "latest_build": remote_data.get("build", ""),
                                "changelog": remote_data.get("changelog", "មានកំណែអាប់ដេតថ្មី!"),
                                "message": f"រកឃើញកំណែអាប់ដេតថ្មី V{remote_ver} នៅលើ GitHub!"
                            }
            except Exception:
                pass

        api_url = f"https://api.github.com/repos/{owner}/{repo}/releases/latest"
        try:
            req = urllib.request.Request(api_url, headers={"User-Agent": "VocalStudio-Updater"})
            with urllib.request.urlopen(req, timeout=3.5) as response:
                if response.status == 200:
                    rel_data = json.loads(response.read().decode())
                    tag = rel_data.get("tag_name", "").lstrip("vV")
                    local_ver = self.get_local_version_info().get("version", "1.0.0")
                    if tag and tag != local_ver:
                        return {
                            "has_update": True,
                            "source": "github_release",
                            "latest_version": tag,
                            "release_url": rel_data.get("html_url", ""),
                            "changelog": rel_data.get("body", "មានកំណែអាប់ដេតថ្មី!"),
                            "message": f"រកឃើញ Release ថ្មី V{tag} នៅលើ GitHub!"
                        }
        except Exception:
            pass

        return None

    def check_for_updates(self, force: bool = False) -> Dict[str, Any]:
        """Check all update channels and return comprehensive status with 2x/4x version rule."""
        now = time.time()
        if not force and self.cached_check_result and (now - self.last_check_time < 15):
            return self.cached_check_result

        info = self.get_local_version_info()
        current_ver = info.get("version", "1.0.0")

        result = {
            "current_version": current_ver,
            "current_build": info.get("build", "20261108.01"),
            "channel": info.get("channel", "stable"),
            "release_date": info.get("release_date", "2026-11-08"),
            "github_repo": info.get("github_repo", ""),
            "has_update": False,
            "update_count": 0,
            "badge_text": "",
            "version_changed": False,
            "latest_version": current_ver,
            "update_source": "none",
            "message": "អ្នកកំពុងប្រើប្រាស់កំណែចុងក្រោយបំផុត (Up to date)!",
            "changelog": info.get("changelog", ""),
            "is_git_repo": self.has_git(),
            "code_modified": False,
            "simulated": (self.simulated_step > 0),
            "simulated_step": self.simulated_step
        }

        # 1. Check simulation step (0 to 4)
        if self.simulated_step > 0:
            count = self.simulated_step
            result["has_update"] = True
            result["update_count"] = count
            result["update_source"] = "test_simulation"
            khmer_count = to_khmer_num(count)

            if count >= 4:
                # ចាប់ពី ៤ ដងឡើង ត្រូវប្ដូរ Version តាម
                new_ver = self.bump_version(current_ver, count)
                result["version_changed"] = True
                result["latest_version"] = new_ver
                result["badge_text"] = f"v{new_ver}"
                result["message"] = f"🎉 សាកល្បង៖ មានការអាប់ដេតចាប់ពី {khmer_count} ដងឡើង - ប្ដូរទៅកំណែ V{new_ver}!"
            else:
                # ស្ទួនគ្នាពីដង (២ដង) ឬ ៣ដង
                result["version_changed"] = False
                result["latest_version"] = current_ver
                result["badge_text"] = f"{khmer_count}ដង"
                result["message"] = f"🔔 សាកល្បង៖ មានការអាប់ដេតស្ទួនគ្នា {khmer_count} ដង ({khmer_count}ដង)!"

            self.cached_check_result = result
            self.last_check_time = now
            return result

        # 2. Check Git remote
        git_res = self.check_git_remote_update()
        if git_res and git_res.get("has_update"):
            result["has_update"] = True
            result["update_source"] = "git"
            result["update_count"] = 1
            result["badge_text"] = "Git"
            result["latest_version"] = f"Commit {git_res['remote_commit']}"
            result["message"] = git_res["message"]
            self.cached_check_result = result
            self.last_check_time = now
            return result

        # 3. Check GitHub repo if set
        if info.get("github_repo"):
            gh_res = self.check_github_repo_update(info["github_repo"])
            if gh_res and gh_res.get("has_update"):
                result["has_update"] = True
                result["update_source"] = gh_res.get("source", "github")
                result["latest_version"] = gh_res.get("latest_version", "")
                result["badge_text"] = f"v{result['latest_version']}"
                result["version_changed"] = True
                result["update_count"] = 4
                result["latest_build"] = gh_res.get("latest_build", "")
                result["changelog"] = gh_res.get("changelog", "")
                result["message"] = gh_res.get("message", "មានកំណែអាប់ដេតថ្មីនៅលើ GitHub!")
                self.cached_check_result = result
                self.last_check_time = now
                return result

        # 4. Check local code modifications & update count
        mod_count = self.get_modified_code_count()
        saved_pending = int(info.get("pending_updates", 0))
        total_count = max(mod_count, saved_pending)

        if total_count > 0:
            result["has_update"] = True
            result["code_modified"] = True
            result["update_source"] = "local_code_change"
            result["update_count"] = total_count
            khmer_count = to_khmer_num(total_count)

            if total_count >= 4:
                # ចាប់ពី ៤ដងឡើង ត្រូវប្ដូរ Version តាម
                new_ver = self.bump_version(current_ver, total_count)
                result["version_changed"] = True
                result["latest_version"] = new_ver
                result["badge_text"] = f"v{new_ver}"
                result["message"] = f"🎉 មានការអាប់ដេតចាប់ពី {khmer_count} ដងឡើង៖ ប្ដូរទៅកំណែថ្មី V{new_ver}!"
            elif total_count >= 2:
                # ស្ទួនគ្នាពីដង (២ដង) ឬ ៣ដង
                result["version_changed"] = False
                result["latest_version"] = current_ver
                result["badge_text"] = f"{khmer_count}ដង"
                result["message"] = f"⚡ មានការអាប់ដេតកូដថ្មីស្ទួនគ្នា {khmer_count} ដង ({khmer_count}ដង)!"
            else:
                result["version_changed"] = False
                result["latest_version"] = current_ver
                result["badge_text"] = "១ដង"
                result["message"] = "⚡ មានការអាប់ដេតកូដថ្មី ១ ដង!"

        self.cached_check_result = result
        self.last_check_time = now
        return result

    def perform_update(self) -> Dict[str, Any]:
        """Perform automatic update: apply version bump if >= 4 updates, reset counter, and reload."""
        check_info = self.check_for_updates(force=True)
        update_count = check_info.get("update_count", 0)
        latest_ver = check_info.get("latest_version", "1.0.0")
        version_changed = check_info.get("version_changed", False)

        info = self.get_local_version_info()
        now_ts = time.time()
        new_version_saved = None

        if version_changed and latest_ver and latest_ver != info.get("version"):
            # Update version.json with the new incremented version
            info["version"] = latest_ver
            today_build = time.strftime("%Y%m%d") + ".01"
            info["build"] = today_build
            info["release_date"] = time.strftime("%Y-%m-%d")
            info["pending_updates"] = 0
            info["baseline_timestamp"] = now_ts

            curr_changelog = info.get("changelog", "")
            khmer_count = to_khmer_num(update_count or 4)
            new_note = f"\nV{latest_ver} ({time.strftime('%Y-%m-%d')}):\n- បានអាប់ដេតប្រព័ន្ធ និងកែលម្អកូដស្ទួនគ្នា {khmer_count} ដង\n"
            info["changelog"] = new_note + curr_changelog
            self.save_version_info(info)
            new_version_saved = latest_ver
        else:
            # Under 4 updates: mark current state as baseline
            info["pending_updates"] = 0
            info["baseline_timestamp"] = now_ts
            self.save_version_info(info)

        # Reset server baseline and simulation step
        self.server_start_time = now_ts
        self.simulated_step = 0
        self.cached_check_result = None

        ver_label = f" ទៅកាន់កំណែ V{new_version_saved}" if new_version_saved else ""
        return {
            "success": True,
            "method": "version_bump" if new_version_saved else "cache_refresh",
            "version": new_version_saved or info.get("version", "1.0.0"),
            "message": f"🎉 បានអនុវត្តការអាប់ដេត{ver_label}ដោយជោគជ័យ! ទំព័រនឹង Refresh ដោយស្វ័យប្រវត្តិ..."
        }

    def toggle_simulation(self) -> int:
        """Cycle test simulation steps: 0 -> 1 (១ដង) -> 2 (២ដង) -> 3 (៣ដង) -> 4 (v1.0.1) -> 0."""
        self.simulated_step = (self.simulated_step + 1) % 5
        self.cached_check_result = None
        return self.simulated_step
