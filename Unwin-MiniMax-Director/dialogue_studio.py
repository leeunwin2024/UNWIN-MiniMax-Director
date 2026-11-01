"""Audio-first film planning routes. Local only; optional TTS/ASR are explicit adapters."""
import json, re, subprocess, uuid, wave
from pathlib import Path
from aiohttp import web
from server import PromptServer
from .nodes import output_root, ffmpeg

ROOT = output_root() / "unwin_director" / "dialogue"
ROOT.mkdir(parents=True, exist_ok=True)
MODES = ("standard", "dialogue_to_video", "audio_to_video")
AUDIO_EXT = {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aac"}
MAX_BYTES = 200 * 1024 * 1024

def safe_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{32}", value):
        raise ValueError("Invalid project ID")
    return value

def project_dir(value):
    folder = ROOT / safe_id(value)
    folder.mkdir(exist_ok=True)
    return folder

def validate_script(lines):
    if not isinstance(lines, list) or not 1 <= len(lines) <= 300:
        raise ValueError("Provide 1-300 dialogue lines")
    result = []
    for item in lines:
        if not isinstance(item, dict):
            raise ValueError("Dialogue line must be an object")
        speaker = str(item.get("speaker", "")).strip()[:80]
        text = str(item.get("text", "")).strip()[:2000]
        if not speaker or not text:
            raise ValueError("Each line needs speaker and text")
        result.append({"speaker": speaker, "text": text, "emotion": str(item.get("emotion", "neutral"))[:60]})
    return result

def probe_duration(path):
    ffprobe = Path(ffmpeg()).with_name("ffprobe.exe" if __import__("os").name == "nt" else "ffprobe")
    executable = str(ffprobe) if ffprobe.exists() else "ffprobe"
    p = subprocess.run([executable, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)], capture_output=True, text=True, timeout=30)
    if p.returncode:
        raise ValueError("Unable to inspect audio duration: " + p.stderr[-300:])
    duration = float(p.stdout.strip())
    if not 0 < duration <= 7200:
        raise ValueError("Audio must be 0-120 minutes")
    return duration

def shots_from_lines(lines, seconds_per_word=0.43):
    """Editable rough cut only. Exact timing requires aligned recorded speech."""
    shots = []
    cursor = 0.0
    for i, line in enumerate(lines):
        duration = max(2.0, min(15.0, len(line["text"].split()) * seconds_per_word + 0.8))
        shots.append({
            "id": "dialogue_" + str(i + 1).zfill(3),
            "speaker": line["speaker"], "dialogue": line["text"],
            "emotion": line["emotion"], "start": round(cursor, 3),
            "duration": round(duration, 3),
            "prompt": "Cinematic dialogue scene. " + line["speaker"] + " speaks with " + line["emotion"] + " emotion. Maintain character and location reference continuity. Natural facial expression, filmic lighting, camera framing appropriate to the conversation.",
            "lip_sync_required": True, "carry_last_frame": True,
            "audio_locked": True
        })
        cursor += duration
    return shots

@PromptServer.instance.routes.get("/unwin/dialogue/capabilities")
async def dialogue_capabilities(request):
    import importlib.util
    return web.json_response({
        "modes": MODES,
        "script_planning": True,
        "audio_upload": True,
        "master_audio_preservation": True,
        "tts_available": False,
        "asr_available": importlib.util.find_spec("whisperx") is not None,
        "lip_sync_available": False,
        "note": "TTS, transcription, MiniMax rendering and lip-sync require configured local workflows; this API does not pretend to perform them."
    })

@PromptServer.instance.routes.post("/unwin/dialogue/project")
async def dialogue_project(request):
    try:
        data = await request.json()
        mode = data.get("mode")
        if mode not in MODES:
            raise ValueError("Invalid mode")
        pid = uuid.uuid4().hex
        project = {"id": pid, "mode": mode, "title": str(data.get("title", "Untitled film"))[:120], "lines": [], "shots": [], "master_audio": None, "version": 1}
        (project_dir(pid) / "project.json").write_text(json.dumps(project, indent=2), encoding="utf-8")
        return web.json_response({"ok": True, "project": project})
    except (ValueError, TypeError) as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)

@PromptServer.instance.routes.post("/unwin/dialogue/script")
async def dialogue_script(request):
    try:
        data = await request.json()
        folder = project_dir(data.get("id"))
        project = json.loads((folder / "project.json").read_text(encoding="utf-8"))
        if project["mode"] != "dialogue_to_video":
            raise ValueError("Select Dialogue to Video mode")
        lines = validate_script(data.get("lines"))
        project["lines"] = lines
        project["shots"] = shots_from_lines(lines)
        (folder / "project.json").write_text(json.dumps(project, indent=2), encoding="utf-8")
        return web.json_response({"ok": True, "project": project, "timing": "estimated; generate or import speech and align before final render"})
    except (ValueError, TypeError, FileNotFoundError, json.JSONDecodeError) as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)

@PromptServer.instance.routes.post("/unwin/dialogue/import-audio")
async def dialogue_import_audio(request):
    try:
        reader = await request.multipart()
        project_id = None
        filename = None
        blob = None
        while part := await reader.next():
            if part.name == "id":
                project_id = (await part.text()).strip()
            elif part.name == "audio":
                filename = Path(part.filename or "").name
                ext = Path(filename).suffix.lower()
                if ext not in AUDIO_EXT:
                    raise ValueError("Unsupported audio format")
                chunks = []
                size = 0
                while chunk := await part.read_chunk(size=1024 * 1024):
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise ValueError("Audio exceeds 200 MB")
                    chunks.append(chunk)
                blob = b"".join(chunks)
        if not blob or not project_id:
            raise ValueError("Provide project id and audio file")
        folder = project_dir(project_id)
        project_path = folder / "project.json"
        project = json.loads(project_path.read_text(encoding="utf-8"))
        if project["mode"] not in ("audio_to_video", "dialogue_to_video"):
            raise ValueError("Audio import requires an audio-driven project")
        dest = folder / ("master_audio" + Path(filename).suffix.lower())
        dest.write_bytes(blob)
        try:
            duration = probe_duration(dest)
        except Exception:
            dest.unlink(missing_ok=True)
            raise
        project["master_audio"] = {"filename": dest.name, "duration": duration, "locked": True}
        project_path.write_text(json.dumps(project, indent=2), encoding="utf-8")
        return web.json_response({"ok": True, "master_audio": project["master_audio"]})
    except (ValueError, TypeError, FileNotFoundError, json.JSONDecodeError) as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)

@PromptServer.instance.routes.get("/unwin/dialogue/project/{id}")
async def dialogue_get_project(request):
    try:
        folder = project_dir(request.match_info["id"])
        return web.json_response(json.loads((folder / "project.json").read_text(encoding="utf-8")))
    except (ValueError, FileNotFoundError) as e:
        return web.json_response({"error": str(e)}, status=404)

@PromptServer.instance.routes.post("/unwin/dialogue/shot-plan")
async def dialogue_shot_plan(request):
    """Save an editable, timestamped shot plan. Does not trigger generation."""
    try:
        data = await request.json()
        folder = project_dir(data.get("id"))
        path = folder / "project.json"
        project = json.loads(path.read_text(encoding="utf-8"))
        shots = data.get("shots")
        if not isinstance(shots, list) or not 1 <= len(shots) <= 500:
            raise ValueError("Provide 1-500 shots")
        for shot in shots:
            if not isinstance(shot, dict) or not isinstance(shot.get("prompt"), str):
                raise ValueError("Each shot requires a prompt")
            start = float(shot.get("start", -1))
            duration = float(shot.get("duration", 0))
            if not 0 <= start <= 7200 or not 0 < duration <= 30:
                raise ValueError("Invalid shot timing")
        project["shots"] = shots
        path.write_text(json.dumps(project, indent=2), encoding="utf-8")
        return web.json_response({"ok": True, "shot_count": len(shots)})
    except (ValueError, TypeError, FileNotFoundError, json.JSONDecodeError) as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)

@PromptServer.instance.routes.get("/unwin/audio-studio")
async def dialogue_studio_page(request):
    return web.FileResponse(Path(__file__).resolve().parent / "web" / "audio-studio.html")
