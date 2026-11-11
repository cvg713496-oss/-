import logging
import time
import requests
import re
from typing import List, Dict, Any
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger(__name__)

class TranslatorService:
    """
    Robust Chinese ➔ Khmer translator service with multi-tier fallback:
      1. Drama / common subtitle dictionary (instant & 100% natural Khmer)
      2. Google Cloud Translation API (if key provided)
      3. DeepL API (if key provided)
      4. Gemini AI Translation (if key provided)
      5. OpenAI GPT-4o-mini Translation (if key provided)
      6. Google Translate via 'dict-chrome-ex' client (free, no key)
      7. MyMemory Translator (km-KH) fallback
    """

    def __init__(self):
        self._session = requests.Session()
        self._session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        })
        # API keys (set by app.py from settings.json)
        self.google_cloud_key = ""
        self.deepl_key        = ""
        self.gemini_key       = ""
        self.openai_key       = ""
        self.priority         = "auto"  # auto | google_cloud | deepl | gemini | openai | free_only

        # Extended drama / movie recap dictionary
        self._drama_dict = {
            "就这里往下挖一米": "គ្រាន់តែជីកមួយម៉ែត្រនៅទីនេះ",
            "小心别伤到底下的东西": "ប្រយ័ត្នកុំឱ្យប៉ះពាល់របស់នៅខាងក្រោម",
            "我的娘": "ម៉ែថ្លៃអើយ!",
            "现成九龙老板求都求不到": "សូម្បីតែថៅកែ Kowloon ក៏សុំមិនបានផង",
            "一条能卖好几万": "មួយដុំអាចលក់បានរាប់ម៉ឺន",
            "你好": "សួស្តី",
            "谢谢": "អរគុណ",
            "再见": "លាហើយ",
            "薇薇安": "វីវៀន",
            "贝拉": "បេឡា",
            "救命": "ជួយផង!",
            "不要": "កុំ!",
            "快点": "លឿនឡើង!",
            "我说过了": "ខ្ញុំបានប្រាប់រួចហើយ",
            "我说了": "ខ្ញុំប្រាប់ហើយតើ",
            "怎么可能": "តើអាចទៅរួចយ៉ាងម៉េច?",
            "不可思议": "មិនគួរឱ្យជឿសោះ",
            "什么人": "ជាអ្នកណា?",
            "去死吧": "ទៅងាប់ទៅ!",
            "太棒了": "អស្ចារ្យណាស់!",
            "你没事吧": "តើឯងមិនអីទេហ្អី?",
            "对不起": "សុំទោស",
            "没关系": "មិនអីទេ",
            "你是谁": "អ្នកជាអ្នកណា?",
            "为什么": "ហេតុអ្វី?",
            "你在哪里": "អ្នកនៅឯណា?",
            "我不知道": "ខ្ញុំមិនដឹងទេ",
            "你疯了吗": "អ្នកឆ្កួតហើយមែនទេ?",
            "别过来": "កុំចូលមក!",
            "住手": "ឈប់!",
            "走吧": "ទៅ!",
            "小心": "ប្រយ័ត្ន!",
            "等一下": "រង់ចាំ!",
            "回来": "ត្រឡប់មកវិញ!",
            "不可能": "មិនអាចទៅរួចទេ!",
            "你听我说": "ស្ដាប់ខ្ញុំនិយាយ",
            "我爱你": "ខ្ញុំស្រលាញ់អ្នក",
            "放开我": "ដោះលែងខ្ញុំ!",
            "你想干什么": "អ្នកចង់ធ្វើអ្វី?",
            "闭嘴": "បិទមាត់!",
            "滚": "ទៅឲ្យឆ្ងាយ!",
            "真的吗": "ពិតមែនទេ?",
            "当然": "ជាការពិតណាស់",
            "没问题": "គ្មានបញ្ហាទេ",
            "我们走": "យើងទៅ",
            "站住": "ឈប់នៅទីនោះ!",
            "够了": "គ្រប់ហើយ!",
            "我保证": "ខ្ញុំសន្យា",
            "你怎么了": "អ្នកមានរឿងអ្វី?",
            "别担心": "កុំបារម្ភ",
            "我相信你": "ខ្ញុំជឿអ្នក",
            "对": "ត្រូវហើយ",
            "不对": "ខុសហើយ",
            "是的": "បាទ/ចាស",
            "不是": "មិនមែនទេ",
            "快跑": "រត់ឆាប់!",
            "危险": "គ្រោះថ្នាក់!",
            "你说什么": "អ្នកនិយាយអ្វី?",
            "出狱": "ចេញពីពន្ធនាគារ",
            "老改犯": "អតីតទណ្ឌិត",
            "劳改犯": "អតីតទណ្ឌិត",
            "苏晴": "ស៊ូឈីង",
            "胜哥": "បងសឹង",
            "盛哥": "បងសេង",
            "姜爷": "លោកជាំង",
            "江野": "ជាំងយ៉េ",
            "姜胜": "ជាំងសឹង",
            "江盛": "ជាំងសេង",
            "顶罪": "ជាប់គុកជំនួស",
            "坐牢": "ជាប់គុក",
            "这次这个外国了": "អាមួយនេះជាជនបរទេសតើ!",
            "小帅哥想试试": "ចុះប្អូនប្រុសសង្ហារ ចង់សាកល្បងមើលទេ?",
            "十个人 三十万": "បើវាយឈ្នះ ១០ នាក់ ខ្ញុំយក ៣០ ម៉ឺន!",
            "十个人三十万": "បើវាយឈ្នះ ១០ នាក់ ខ្ញុំយក ៣០ ម៉ឺន!",
            "他来干嘛的": "ចុះគាត់មកទីនេះដើម្បីអ្វី?",
            "他来干什么的": "ចុះគាត់មកទីនេះដើម្បីអ្វី?",
            "他来做什么": "ចុះគាត់មកធ្វើអ្វី?",
            "关系断了": "ទំនាក់ទំនងយើងត្រូវកាត់ផ្តាច់ត្រឹមនេះ!",
            "从今往后": "ចាប់ពីពេលនេះតទៅ",
            "姜家": "គ្រួសារត្រកូលជាំង",
            "给我再无干涉": "កុំសង្ឃឹមថាមកពាក់ព័ន្ធជាមួយខ្ញុំទៀតឱ្យសោះ!",
            "跟我再无干涉": "កុំសង្ឃឹមថាមកពាក់ព័ន្ធជាមួយខ្ញុំទៀតឱ្យសោះ!",
            "江家与我再无干涉": "ត្រកូលជាំងគ្មានពាក់ព័ន្ធអ្វីជាមួយខ្ញុំទៀតទេ!",
            "做梦": "យល់សប្តិទាំងថ្ងៃ",
            "你哥也是嫌折腾": "បងប្រុសឯងក៏មិនចង់ឱ្យរឿងវែងឆ្ងាយដែរ",
            "这手都瘫了十六年": "ដៃនេះពិការអស់រយៈពេល ១៦ ឆ្នាំមកហើយ",
            "好多段制什么制": "ព្យាបាលគ្រប់កន្លែងហើយ តើបានការអីទៅ?",
            "万一手里的钱花空了": "ចុះបើលុយក្នុងដៃត្រូវចាយអស់រលីងនោះ?",
            "折腾": "រឿងវែងឆ្ងាយ",
            "嫌折腾": "មិនចង់ឱ្យពិបាកច្រើន",
            "瘫了": "ពិការហើយ",
            "瘫痪": "ពិការភាព",
            "花空": "ចាយអស់រលីង",
            "看病": "ទៅព្យាបាលជំងឺ",
            "治病": "ព្យាបាលជំងឺ",
            "手术费": "ថ្លៃវះកាត់",
            "医药费": "ថ្លៃថ្នាំពេទ្យ",
            "救命钱": "លុយសង្គ្រោះជីវិត",
            "断绝关系": "ផ្តាច់ទំនាក់ទំនង",
            "赶出家门": "ដេញចេញពីផ្ទះ",
            "窝囊废": "មនុស្សអត់បានការ",
            "废物": "មនុស្សឥតប្រយោជន៍",
            "白眼狼": "មនុស្សរមិលគុណ",
            "吃里扒外": "ក្បត់ផលប្រយោជន៍ខ្លួនឯង",
            "狗眼看人低": "មើលងាយមនុស្ស",
            "欺人太甚": "មើលងាយជ្រុលពេកហើយ",
            "不知好歹": "មិនដឹងគុណទោស",
            "给脸不要脸": "ឱ្យតម្លៃមិនចង់បាន",
            "算什么东西": "ឯងជាស្អីឱ្យប្រាកដ?",
            "找死": "ចង់ងាប់មែនទេ?",
            "活得不耐烦了": "រស់នៅមិនចង់យូរទេអី?",
            "跪下": "លុតជង្គង់ចុះ!",
            "磕头认错": "ក្រាបសំពះសុំទោសភ្លាម!",
            "饶命": "លើកលែងជីវិតផង!",
            "大人不记小人过": "សូមកុំប្រកាន់ទោសអី!",
            "你等着瞧": "ចាំមើលទៅ!",
            "走着瞧": "ចាំមើលទៅ!"
        }

    def _translate_google_cloud(self, text: str) -> str:
        """Translate via Google Cloud Translation API v2 (requires API key)."""
        if not self.google_cloud_key:
            return ""
        try:
            url = "https://translation.googleapis.com/language/translate/v2"
            resp = self._session.post(url, json={
                "q": text, "source": "zh-CN", "target": "km", "format": "text"
            }, params={"key": self.google_cloud_key}, timeout=25.0)
            if resp.status_code == 200:
                data = resp.json()
                result = data.get("data", {}).get("translations", [{}])[0].get("translatedText", "")
                return result.strip()
        except Exception as e:
            logger.debug(f"Google Cloud API error: {e}")
        return ""

    def _translate_deepl(self, text: str) -> str:
        """Translate via DeepL API (requires API key)."""
        if not self.deepl_key:
            return ""
        try:
            base = "api-free.deepl.com" if self.deepl_key.endswith(":fx") else "api.deepl.com"
            resp = self._session.post(
                f"https://{base}/v2/translate",
                headers={"Authorization": f"DeepL-Auth-Key {self.deepl_key}"},
                json={"text": [text], "source_lang": "ZH", "target_lang": "KM"},
                timeout=25.0
            )
            if resp.status_code == 200:
                translations = resp.json().get("translations", [])
                if translations:
                    return translations[0].get("text", "").strip()
        except Exception as e:
            logger.debug(f"DeepL API error: {e}")
        return ""

    def _translate_gemini(self, text: str) -> str:
        """Translate via Google Gemini API in Movie Recap narrative style (requires API key)."""
        if not self.gemini_key:
            return ""

        models_to_try = [
            "gemini-3.5-flash-lite",
            "gemini-flash-lite-latest",
            "gemini-3-flash-preview",
            "gemini-3.5-flash",
            "gemma-4-31b-it",
            "gemma-4-26b-a4b-it"
        ]

        system_instruction = (
            "You are a master Khmer Movie Recap narrator and professional short drama dubber (អ្នកសម្រាយរឿង និងបញ្ចូលសំឡេងរឿងភាគចិនកាត់តអាជីពដ៏ល្បីលើ Facebook & YouTube).\n"
            "Translate the Chinese drama dialogue into natural, captivating, punchy, and highly accurate spoken Khmer movie recap narrative (សម្រាយសាច់រឿងបែបធម្មជាតិរស់រវើក ជក់ចិត្ត ត្រូវតាមសាច់រឿងជាក់ស្តែង មិនមែនប្រែពាក្យមួយៗបែប Google Translate ទេ).\n"
            "Rules:\n"
            "1. Output 100% PURE KHMER vocabulary in Khmer script (ភាសាខ្មែរសុទ្ធ ១០០% ហាមដាច់ខាតមិនឱ្យមានអក្សរថៃ ឬពាក្យបរទេសឡើយ) — speak naturally as a Khmer narrator/recap dubber.\n"
            "2. Understand scene context and correct speech recognition sound-alike errors in Chinese (e.g. 这一桥 -> 这一瞧 / មើលចុះ, 单宝 -> 担保 / ធានា, 没啥意思 -> គ្មានការអីធំដុំទេ).\n"
            "3. Character names: Translate Chinese names to Khmer phonetics (赵长顺 -> ឆាងស៊ុន, 表舅 -> លោកពូ, 赵常旺 -> ឆាងវ៉ាង).\n"
            "4. Express emotions, insults, sarcasm, and drama vividly in colloquial Khmer.\n"
            "5. Output ONLY the raw Khmer narrative translation without quotation marks, explanations, or notes."
        )

        payload = {
            "systemInstruction": {
                "parts": [{"text": system_instruction}]
            },
            "contents": [{"parts": [{"text": f"Translate to Khmer movie recap style: {text}"}]}],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": 250}
        }

        for model in models_to_try:
            try:
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={self.gemini_key}"
                resp = self._session.post(url, json=payload, timeout=25.0)
                if resp.status_code == 200:
                    data = resp.json()
                    candidates = data.get("candidates", [])
                    if candidates:
                        parts = candidates[0].get("content", {}).get("parts", [])
                        if parts:
                            res = parts[0].get("text", "").strip()
                            if res:
                                return res
                elif resp.status_code in (429, 503):
                    time.sleep(1.0)
                    continue
                elif resp.status_code == 404:
                    continue
                else:
                    logger.warning(f"Gemini API returned status {resp.status_code}: {resp.text[:150]}")
            except Exception as e:
                logger.debug(f"Gemini API error ({model}): {e}")
        return ""

    def _translate_gemini_batch(self, items: List[tuple]) -> Dict[str, str]:
        """Translate a batch of dialogue items in narrative recap context using Gemini AI."""
        if not self.gemini_key or not items:
            return {}

        import json
        input_dict = {str(item[0]): item[1] for item in items}
        models_to_try = [
            "gemini-3.5-flash-lite",
            "gemini-flash-lite-latest",
            "gemini-3-flash-preview",
            "gemini-3.5-flash",
            "gemma-4-31b-it",
            "gemma-4-26b-a4b-it"
        ]

        batch_instruction = (
            "You are a master Khmer Movie Recap narrator and professional short drama dubber (អ្នកសម្រាយរឿង និងបញ្ចូលសំឡេងរឿងភាគចិនកាត់តអាជីពដ៏ល្បីលើ Facebook & YouTube).\n"
            "Translate these Chinese drama dialogue lines into natural, captivating, punchy, and highly accurate spoken Khmer movie recap narrative (សម្រាយសាច់រឿងបែបធម្មជាតិរស់រវើក ជក់ចិត្ត ត្រូវតាមសាច់រឿងជាក់ស្តែង មិនមែនប្រែពាក្យមួយៗបែប Google Translate ទេ).\n\n"
            "CRITICAL DRAMA STORYTELLING & DUBBING PRINCIPLES:\n"
            "1. PURE NATURAL SPOKEN KHMER: Use authentic Khmer spoken drama phrases (ពាក្យនិយាយធម្មជាតិ មិនរដិបរដុប មិនប្រើភាសាផ្លូវការរឹងស្តូក). ONLY use Khmer script (អក្សរខ្មែរ), NEVER output Thai characters!\n"
            "2. CONTEXT & CHINESE SPEECH HOMOPHONE CORRECTION:\n"
            "   - Subtitle speech recognition often has sound-alike typos: e.g. '这一桥' is '这一瞧' (មើលចុះ / មើលផ្ទាល់ភ្នែក), '单宝' is '担保' (ធានា/អ្នកធានា), '帮称' is '帮衬' (ជួយជ្រោមជ្រែង), '带款' is '贷款' (ខ្ចីប្រាក់ធនាគារ), '逃一分钱' is '还/淘一分钱' (ចេញលុយមួយកាក់មួយសេន), '亲外上' is '亲外甥' (ក្មួយបង្កើត), '大笔一灰' is '大笔一挥' (ឆូតដៃស៊ីញ៉េមួយឆ្វេច). Always translate the INTENDED drama meaning in context!\n"
            "   - Understand character dynamics & colloquial drama terms:\n"
            "     * Uncle / Nephew / Debt / Banking:\n"
            "       '表舅大上午过来有事' -> 'លោកពូមកដល់ព្រឹកព្រលឹមបែបនេះ មានការអីមែនទេ?'\n"
            "       '没啥意思' -> 'គ្មានការអីធំដុំទេក្មួយ!' (NOT 'មិនគួរឱ្យចាប់អារម្មណ៍' / NOT literal)\n"
            "       '就是银行走个形式程序' -> 'គ្រាន់តែជារបៀបរបបតាមបែបបទរបស់ធនាគារប៉ុណ្ណោះ!'\n"
            "       '不用你还一分钱真金白银' -> 'ឯងមិនបាច់ចេញលុយសូម្បីតែមួយកាក់មួយសេនទេ!'\n"
            "       '这个无限连带赔偿责任保证是啥意思' -> 'ចុះពាក្យថា ការធានាទទួលខុសត្រូវគ្មានដែនកំណត់ នេះមានន័យថាម៉េចពូ?'\n"
            "       '嗨 那些官样套话不用看' -> 'ហ្អូយ! ក្រដាសពាក្យពេចន៍ផ្លូវការហ្នឹង មិនបាច់មើលក៏បានដែរ!'\n"
            "       '我当表舅的还能坑亲外甥' -> 'ពូបង្កើតឯងទាំងមូល មានចិត្តទៅបោកក្មួយបង្កើតឯងកើត!'\n"
            "       '大笔一挥签个名就结了' -> 'គ្រាន់តែឆូតដៃស៊ីញ៉េឈ្មោះមួយមក គឺរួចរាល់ហើយ!'\n"
            "     * Husband / Wife / Family disputes:\n"
            "       '咱俩明天就是民政局离婚' -> 'ថ្ងៃស្អែកយើងទៅសាលាស្រុកលែងលះគ្នាទៅ!'\n"
            "       '那是我哥的事' -> 'នោះជារឿងរបស់បងប្រុសខ្ញុំតើ!'\n"
            "       '你别说了 烦死了' -> 'ឈប់និយាយទៅ! ធុញទ្រាន់ណាស់!'\n"
            "     * General drama:\n"
            "       '拆迁' -> 'វាយកម្ទេចផ្ទះយកសំណង', '做梦' -> 'យល់សប្តិទាំងថ្ងៃ', '顶罪' -> 'ជាប់គុកជំនួស', '出狱' -> 'ចេញពីគុក'.\n"
            "3. Tone & Emotion: Deliver high drama punch, sarcasm, anger, or warmth suited for video narration.\n"
            "4. Return ONLY a valid JSON object mapping ID string to Khmer translated string. NO markdown, NO code fences.\n"
            "Example: {\"1\": \"...\", \"2\": \"...\"}"
        )

        payload = {
            "systemInstruction": {"parts": [{"text": batch_instruction}]},
            "contents": [{"parts": [{"text": "Translate the following drama dialogue into Khmer movie recap style:\n" + json.dumps(input_dict, ensure_ascii=False)}]}],
            "generationConfig": {"responseMimeType": "application/json", "temperature": 0.2, "maxOutputTokens": 8192}
        }

        if not hasattr(self, "_exhausted_gemini_models"):
            self._exhausted_gemini_models = set()

        for model in models_to_try:
            if model in self._exhausted_gemini_models:
                continue
            for attempt in range(2):
                try:
                    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={self.gemini_key}"
                    resp = self._session.post(url, json=payload, timeout=25.0)
                    if resp.status_code == 200:
                        data = resp.json()
                        candidates = data.get("candidates", [])
                        if candidates:
                            parts = candidates[0].get("content", {}).get("parts", [])
                            if parts:
                                res_text = parts[0].get("text", "").strip()
                                if res_text:
                                    try:
                                        parsed = json.loads(res_text)
                                        if isinstance(parsed, dict) and len(parsed) > 0:
                                            return {str(k): str(v).strip() for k, v in parsed.items()}
                                    except Exception:
                                        # Handle markdown code fences ```json ... ```
                                        m = re.search(r'\{.*\}', res_text, re.DOTALL)
                                        if m:
                                            try:
                                                parsed = json.loads(m.group(0))
                                                if isinstance(parsed, dict) and len(parsed) > 0:
                                                    return {str(k): str(v).strip() for k, v in parsed.items()}
                                            except Exception:
                                                pass
                    elif resp.status_code == 429:
                        # Free tier daily quota limit or burst rate limit
                        err_body = resp.text.lower()
                        if "quota" in err_body or "exhausted" in err_body or "per day" in err_body:
                            self._exhausted_gemini_models.add(model)
                            logger.warning(f"Gemini model {model} daily quota exhausted (429). Instantly switching to next model...")
                            break
                        else:
                            backoff = 2.0 * (attempt + 1)
                            logger.warning(f"Gemini rate limit (429) on {model}. Backing off {backoff:.1f}s...")
                            time.sleep(backoff)
                            continue
                    elif resp.status_code == 404:
                        self._exhausted_gemini_models.add(model)
                        break
                    elif resp.status_code == 503:
                        time.sleep(1.5)
                        continue
                    else:
                        logger.warning(f"Gemini API returned status {resp.status_code}: {resp.text[:150]}")
                        break
                except Exception as e:
                    logger.debug(f"Gemini batch error ({model}): {e}")
                    time.sleep(1.0)
        return {}

    def _translate_openai(self, text: str) -> str:
        """Translate via OpenAI GPT-4o-mini (requires API key)."""
        if not self.openai_key:
            return ""
        try:
            resp = self._session.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {self.openai_key}"},
                json={
                    "model": "gpt-4o-mini",
                    "messages": [
                        {"role": "system", "content": "You are a professional Chinese to Khmer translator for drama subtitles. Translate naturally and concisely. Output ONLY the Khmer translation."},
                        {"role": "user", "content": f"Translate to Khmer: {text}"}
                    ],
                    "max_tokens": 150, "temperature": 0.1
                }, timeout=10.0
            )
            if resp.status_code == 200:
                result = resp.json().get("choices", [{}])[0].get("message", {}).get("content", "")
                return result.strip()
        except Exception as e:
            logger.debug(f"OpenAI API error: {e}")
        return ""

    def _translate_google_chrome_client(self, text: str) -> str:
        """Translate using Google's dict-chrome-ex endpoint (High success rate, no 429)."""
        text = text.strip()
        if not text:
            return ""
        try:
            url = "https://translate.googleapis.com/translate_a/single"
            params = {
                "client": "dict-chrome-ex",
                "sl": "zh-CN",
                "tl": "km",
                "dt": "t",
                "q": text
            }
            resp = self._session.get(url, params=params, timeout=25.0)
            if resp.status_code == 200:
                data = resp.json()
                if data and len(data) > 0 and len(data[0]) > 0:
                    result = "".join([part[0] for part in data[0] if part and part[0]]).strip()
                    if result:
                        return result
        except Exception as e:
            logger.debug(f"Google Chrome client translate error: {e}")
        return ""

    def _translate_google_batch(self, items: List[tuple]) -> Dict[str, str]:
        """Translate multiple dialogue lines efficiently in batch via Google Translate."""
        if not items:
            return {}
        results = {}
        chunk_size = 50
        for i in range(0, len(items), chunk_size):
            chunk = items[i:i + chunk_size]
            lines = [it[1].replace("\n", " ").strip() for it in chunk]
            joined = "\n".join(lines)
            success = False
            try:
                url = "https://translate.googleapis.com/translate_a/single"
                params = {
                    "client": "gtx",
                    "sl": "zh-CN",
                    "tl": "km",
                    "dt": "t",
                    "q": joined
                }
                resp = self._session.get(url, params=params, timeout=10.0)
                if resp.status_code == 200:
                    data = resp.json()
                    if data and len(data) > 0 and len(data[0]) > 0:
                        full_kh = "".join([part[0] for part in data[0] if part and part[0]])
                        kh_lines = full_kh.split("\n")
                        for idx, (it_id, orig_text) in enumerate(chunk):
                            if idx < len(kh_lines) and kh_lines[idx].strip():
                                results[str(it_id)] = kh_lines[idx].strip()
                            else:
                                results[str(it_id)] = self._translate_google_chrome_client(orig_text) or orig_text
                        success = True
            except Exception as e:
                logger.debug(f"Google batch chunk error: {e}")

            if not success:
                # Fallback to single translate per line for this chunk safely
                for it_id, orig_text in chunk:
                    try:
                        results[str(it_id)] = self._translate_google_chrome_client(orig_text) or orig_text
                    except Exception:
                        results[str(it_id)] = orig_text
        return results

    def _translate_mymemory(self, text: str) -> str:
        """Fallback via MyMemory translation."""
        try:
            from deep_translator import MyMemoryTranslator
            mm = MyMemoryTranslator(source="zh-CN", target="km-KH")
            res = mm.translate(text)
            if res and res.strip() and res.strip() != text.strip():
                return res.strip()
        except Exception as e:
            logger.debug(f"MyMemory error for '{text[:20]}': {e}")
        return ""

    def _clean_translated_text(self, text: str, orig: str = "") -> str:
        """Polish translated Khmer text and fix common literal machine mistranslations for drama recap."""
        if not text:
            return ""

        # 1. Pinyin character names
        replacements = {
            "Zhao Changshun": "ចាងស៊ុន",
            "Zhao Changwang": "ចាងវ៉ាង",
            "Zhao Changxing": "ចាងស៊ុង",
            "Changshun": "ចាងស៊ុន",
            "Changwang": "ចាងវ៉ាង",
            "Changxing": "ចាងស៊ុង",
            "Biaojiu": "លោកពូ",
            "Lao Wu": "អាទីប្រាំ",
            "Su Qing": "ស៊ូឈីង",
            "Jiang Sheng": "ជាំងសេង",
            "Jiang Ye": "ជាំងយ៉េ",
            "Sheng": "សេង",
            "Jiang": "ជាំង",
            "Brother Sheng": "បងសេង"
        }
        for eng, kh in replacements.items():
            text = re.sub(rf"\b{eng}\b", kh, text, flags=re.IGNORECASE)

        # 2. Strip any accidental Thai/Vietnamese/foreign loan characters
        thai_to_khmer = {
            "ชาวบ้าน": "អ្នកភូមិ",
            "ลองមើល": "មើលចុះ",
            "ลองดู": "មើលទៅ",
            "อะไร": "អី",
            "ไม่": "មិន",
            "ไป": "ទៅ",
            "มา": "មក",
            "สิ่ง": "អ្វី",
            "สิ่งที่": "អ្វីដែល",
            "กล้า": "ហ៊ាន",
        }
        for th, kh in thai_to_khmer.items():
            text = text.replace(th, kh)
        text = re.sub(r"[\u0E00-\u0E7F]+", "", text)  # Thai characters
        text = re.sub(r"តamil\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\b[tT]amil\b", "", text)
        text = re.sub(r"\b[a-zA-Zàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]+(?:\s+[a-zA-Zàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]+)*\s*[/]\s*", "", text, flags=re.IGNORECASE)

        # 3. Heuristic fixes for notorious literal machine mistranslations
        # Fix 拿命换来的 (swapped with his life)
        if "拿命换来" in orig and ("ជីវិត" in text or "ចំណាយ" in text or "Zhao" in text or "Changshun" in text):
            text = "គឺយកជីវិតទៅប្តូរយកមកតើ!"
        if "本就该全给" in orig and ("ខ្ញុំគួរតែ" in text or "ទាំងអស់" in text):
            text = "តាមពិតត្រូវតែឱ្យគាត់ទាំងអស់ទើបត្រឹមត្រូវ!"
        if "不是平分" in orig and ("បីរយ" in text or "បី​រយ" in text or "ស្មើ" in text or "ពាន់" in text):
            text = "លុយ ៣០ ម៉ឺននេះមិនមែនត្រូវបែងចែកគ្នាស្មើទេ!"
        # Fix 瘫 (paralyzed) mistakenly translated as 'លក់' (sold) or 'តូប'
        if "瘫" in orig:
            text = re.sub(r"ត្រូវបានលក់|លក់អស់|តូប", "ពិការ", text)
        if "ត្រូវបានលក់អស់រយៈពេល" in text:
            text = re.sub(r"ត្រូវបានលក់អស់រយៈពេល", "ពិការអស់រយៈពេល", text)

        # Fix 折腾 / 嫌折腾
        if "折腾" in orig and ("ពិបាក" in text or "បោះចោល" in text or "រំខាន" in text):
            text = re.sub(r"បោះចោល|រំខាន|ពិបាកដែរ", "មិនចង់ឱ្យរឿងវែងឆ្ងាយដែរ", text)

        # Fix 花空 (money exhausted)
        if "花空" in orig and ("ត្រូវចំណាយ" in text or "ទទេ" in text):
            text = re.sub(r"ត្រូវចំណាយ\??", "ត្រូវចាយអស់រលីងនោះ?", text)

        # Fix 治什么制 / 制什么制
        if ("制什么" in orig or "治什么" in orig) and "ប្រព័ន្ធ" in text:
            text = re.sub(r"ប្រព័ន្ធ[^\?]*\?", "ព្យាបាលគ្រប់កន្លែងហើយ តើបានការអីទៅ?", text)
        # Fix grammatical 'ប្រយោគ' (sentence) mistake
        if "តើប្រយោគមួយមានតម្លៃប៉ុន្មាន" in text:
            text = "វាយឈ្នះម្តងបានលុយប៉ុន្មានដែរ?"
        elif "ប្រយោគមួយ" in text:
            text = re.sub(r"ប្រយោគមួយ", "ម្តង", text)

        # '小帅哥想试试' -> 'ប្រុសស្អាតចង់សាក'
        if "ប្រុសស្អាតចង់សាក" in text or ("小帅哥" in orig and ("ចង់សាក" in text or "ចង់សាកល្បង" in text)):
            text = "ចុះប្អូនប្រុសសង្ហារ ចង់សាកល្បងមើលទេ?"

        # '十个人 三十万' -> 'ដប់នាក់ 300,000'
        if "300,000" in text and ("三十万" in orig or "ដប់នាក់" in text):
            text = "បើវាយឈ្នះ ១០ នាក់ ខ្ញុំយក ៣០ ម៉ឺន!"

        # '这次这个外国了' -> 'លើកនេះជាជនជាតិបរទេស'
        if "លើកនេះជាជនជាតិបរទេស" in text and "外国" in orig:
            text = "អាមួយនេះជាជនបរទេសតើ!"

        # '他来干嘛的' -> 'គាត់មកដើម្បីអ្វី'
        if "គាត់មកដើម្បីអ្វី" in text and ("干嘛" in orig or "干什么" in orig):
            text = "ចុះគាត់មកទីនេះដើម្បីអ្វី?"

        # Clean multiple spaces & normalize punctuation
        text = re.sub(r"\s+", " ", text)
        return text.strip()

    def translate_text_with_provider(self, text: str) -> tuple:
        """Translate and return (result, provider_name). Used for test endpoint."""
        text = text.strip()
        if not text:
            return "", "none"
        if text in self._drama_dict:
            return self._drama_dict[text], "drama_dict"
        result, provider = self._translate_by_priority(text)
        return self._clean_translated_text(result) if result else text, provider

    def _translate_by_priority(self, text: str) -> tuple:
        """Translate according to priority setting. Returns (result, provider_name)."""
        priority = getattr(self, "priority", "auto")

        # Explicit priority mode
        if priority == "google_cloud":
            r = self._translate_google_cloud(text)
            if r: return r, "Google Cloud API"
        elif priority == "deepl":
            r = self._translate_deepl(text)
            if r: return r, "DeepL API"
        elif priority == "gemini":
            r = self._translate_gemini(text)
            if r: return r, "Gemini AI"
            r = self._translate_google_chrome_client(text)
            if r: return r, "Google Free"
            r = self._translate_mymemory(text)
            if r: return r, "MyMemory"
            return text, "fallback"
        elif priority == "openai":
            r = self._translate_openai(text)
            if r: return r, "OpenAI GPT"
        elif priority == "free_only":
            r = self._translate_google_chrome_client(text)
            if r: return r, "Google Free"
            r = self._translate_mymemory(text)
            if r: return r, "MyMemory"
            return text, "fallback"

        # Auto mode: try premium APIs first (if keys exist), then free
        if self.google_cloud_key:
            r = self._translate_google_cloud(text)
            if r: return r, "Google Cloud API"
        if self.gemini_key:
            r = self._translate_gemini(text)
            if r: return r, "Gemini AI"
        if self.deepl_key:
            r = self._translate_deepl(text)
            if r: return r, "DeepL API"
        if self.openai_key:
            r = self._translate_openai(text)
            if r: return r, "OpenAI GPT"

        # Free fallbacks
        r = self._translate_google_chrome_client(text)
        if r: return r, "Google Free"
        r = self._translate_mymemory(text)
        if r: return r, "MyMemory"
        return text, "fallback"

    def translate_text(self, text: str, recap_style: bool = True) -> str:
        """Translate a single line of Chinese text to natural Khmer."""
        text = text.strip()
        if not text:
            return ""

        # 1. Dictionary exact match
        if text in self._drama_dict:
            return self._drama_dict[text]

        # 2. Translate by configured priority (premium APIs or free)
        result, _ = self._translate_by_priority(text)
        return self._clean_translated_text(result) if result else text

    def translate_segments(self, segments: List[Dict[str, Any]], recap_style: bool = True, progress_callback=None) -> List[Dict[str, Any]]:
        """Translate all Chinese segments to Khmer with movie recap storytelling.
        
        High-Performance Pipeline (2953 segments in ~60s instead of ~25 min):
          1. Dictionary instant-match (0ms)
          2. Google Free batch (ultra-fast, ~50 lines/sec, all segments in parallel)
          3. Gemini AI refinement pass (optional, runs in background for premium quality)
        """
        if not segments:
            return []

        total_segs = len(segments)
        use_gemini = (self.priority == "gemini" or (self.priority == "auto" and self.gemini_key)) and bool(self.gemini_key)

        # ── Phase 1: Dictionary instant-match ──────────────────────────────
        dict_hit_count = 0
        items_need_translate = []
        for idx, s in enumerate(segments):
            s_id = str(s.get("id", idx + 1))
            orig = s.get("original", "").strip()
            if not orig:
                continue
            if orig in self._drama_dict:
                s["translated"] = self._drama_dict[orig]
                dict_hit_count += 1
            else:
                items_need_translate.append((s_id, orig))

        logger.info(f"Phase 1: {dict_hit_count} dictionary hits, {len(items_need_translate)} need translation")

        if progress_callback:
            try: progress_callback(dict_hit_count, total_segs)
            except Exception: pass

        if not items_need_translate:
            logger.info(f"Translation complete: all {total_segs} segments from dictionary")
            return segments

        applied_count = 0

        # ── Phase 2: Translation Execution ──────────────────────────────
        if use_gemini:
            # ── DIRECT GEMINI AI TRANSLATION (Fast, cinematic, no Google lag!) ──
            logger.info(f"Translating {len(items_need_translate)} segments directly via Gemini AI Movie Recap mode...")
            gemini_chunk_size = 50  # Highly focused batch size: 50 segments per API call for maximum storytelling quality
            gemini_chunks = []
            for ci in range(0, len(items_need_translate), gemini_chunk_size):
                gemini_chunks.append(items_need_translate[ci:ci + gemini_chunk_size])

            gemini_results = {}
            completed_count = 0
            for c_idx, ch in enumerate(gemini_chunks):
                try:
                    res = self._translate_gemini_batch(ch)
                    if res:
                        gemini_results.update(res)
                        logger.info(f"Gemini translated chunk {c_idx+1}/{len(gemini_chunks)} ({len(res)} items)")
                except Exception as ge:
                    logger.warning(f"Gemini chunk {c_idx+1} error: {ge}")

                completed_count += len(ch)
                if progress_callback:
                    try:
                        progress_callback(min(total_segs, dict_hit_count + completed_count), total_segs)
                    except Exception:
                        pass
                if c_idx < len(gemini_chunks) - 1:
                    time.sleep(0.5)

            seg_by_id = {str(s.get("id", idx + 1)): s for idx, s in enumerate(segments)}
            untranslated = []
            for s_id, orig in items_need_translate:
                s = seg_by_id.get(s_id)
                if s and s_id in gemini_results and gemini_results[s_id]:
                    s["translated"] = self._clean_translated_text(gemini_results[s_id], orig=orig)
                    applied_count += 1
                else:
                    untranslated.append((s_id, orig))

            logger.info(f"Gemini direct complete: {applied_count}/{len(items_need_translate)} translated successfully")

            # Retry any rare missed lines with Gemini AI in chunks of 50 before any fallback!
            if untranslated:
                logger.info(f"Retrying {len(untranslated)} missed lines via Gemini AI...")
                try:
                    retry_res = {}
                    for r_idx in range(0, len(untranslated), 50):
                        r_chunk = untranslated[r_idx:r_idx + 50]
                        r_part = self._translate_gemini_batch(r_chunk)
                        if r_part:
                            retry_res.update(r_part)
                    still_untranslated = []
                    for s_id, orig in untranslated:
                        s = seg_by_id.get(s_id)
                        if s and s_id in retry_res and retry_res[s_id]:
                            s["translated"] = self._clean_translated_text(retry_res[s_id], orig=orig)
                            applied_count += 1
                        else:
                            still_untranslated.append((s_id, orig))
                    untranslated = still_untranslated
                except Exception as re_err:
                    logger.warning(f"Gemini retry error: {re_err}")

            # If any lines still missing, use single Gemini if <= 8 lines, otherwise fast Google batch fallback
            if untranslated:
                if len(untranslated) <= 8:
                    for s_id, orig in untranslated:
                        s = seg_by_id.get(s_id)
                        if s:
                            single_t = self._translate_gemini(orig)
                            if single_t:
                                s["translated"] = self._clean_translated_text(single_t, orig=orig)
                                applied_count += 1
                            else:
                                fb_text = self._translate_google_chrome_client(orig)
                                s["translated"] = self._clean_translated_text(fb_text, orig=orig) if fb_text else orig
                else:
                    try:
                        fb_map = self._translate_google_batch(untranslated)
                        for s_id, orig in untranslated:
                            s = seg_by_id.get(s_id)
                            if s and s_id in fb_map and fb_map[s_id]:
                                s["translated"] = self._clean_translated_text(fb_map[s_id], orig=orig)
                                applied_count += 1
                    except Exception:
                        pass
        else:
            # ── Free Google Batch Mode (when no Gemini key) ──
            logger.info(f"Translating {len(items_need_translate)} segments via Google Free batch...")
            google_map = {}
            try:
                google_map = self._translate_google_batch(items_need_translate)
            except Exception as e:
                logger.warning(f"Google batch error: {e}")

            seg_by_id = {str(s.get("id", idx + 1)): s for idx, s in enumerate(segments)}
            for s_id, orig in items_need_translate:
                s = seg_by_id.get(s_id)
                if s and s_id in google_map and google_map[s_id]:
                    s["translated"] = self._clean_translated_text(google_map[s_id], orig=orig)
                    applied_count += 1

            if progress_callback:
                try:
                    progress_callback(dict_hit_count + applied_count, total_segs)
                except Exception:
                    pass

        # ── Final: fill any remaining untranslated segments ────────────────
        for s in segments:
            orig = s.get("original", "").strip()
            if orig and not s.get("translated", "").strip():
                s["translated"] = self._clean_translated_text(
                    self._translate_google_chrome_client(orig) or orig, orig=orig
                )

        if progress_callback:
            try: progress_callback(total_segs, total_segs)
            except Exception: pass

        logger.info(f"Translation complete: {total_segs} segments (dict={dict_hit_count}, translated={applied_count})")
        return segments
