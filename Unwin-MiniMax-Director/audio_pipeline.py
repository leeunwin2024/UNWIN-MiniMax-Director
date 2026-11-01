"""UNWIN audio-first adapters: local speech, Ollama shot planning, H3 queue and audio mux.
No cloud API, model downloads or paid calls. Optional engines are detected at runtime.
"""
import asyncio, json, os, shutil, subprocess, uuid
from pathlib import Path
from aiohttp import web, ClientSession, ClientTimeout
from server import PromptServer
from .nodes import output_root, ffmpeg, safe_output, run_ffmpeg
from .dialogue_studio import project_dir, shots_from_lines

BASE = Path(__file__).resolve().parent
MAX_LINES = 300

def read_project(pid):
    path = project_dir(pid) / "project.json"
    return path, json.loads(path.read_text(encoding="utf-8"))

def save_project(path, project):
    path.write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")

def speech_engine():
    if os.name == "nt" and (shutil.which("powershell.exe") or shutil.which("powershell")):
        return "windows-sapi"
    return None

def synthesize_sapi(lines, directory):
    """Windows System.Speech offline voices; avoids cloud and unverified TTS installs."""
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not powershell:
        raise RuntimeError("Windows PowerShell not found")
    manifest = directory / "speech_lines.json"
    manifest.write_text(json.dumps(lines, ensure_ascii=False), encoding="utf-8")
    script = directory / "speak.ps1"
    script.write_text("""
Add-Type -AssemblyName System.Speech
$ErrorActionPreference = 'Stop'
$lines = Get-Content -Raw -Encoding UTF8 -LiteralPath $args[0] | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$i = 0
foreach ($line in $lines) {
  $path = Join-Path (Split-Path $args[0]) ('line_{0:d4}.wav' -f $i)
  $synth.SetOutputToWaveFile($path)
  $synth.Speak([string]$line.text)
  $synth.SetOutputToNull()
  $i++
}
$synth.Dispose()
""", encoding="utf-8")
    proc = subprocess.run([powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script), str(manifest)], capture_output=True, text=True, timeout=900)
    if proc.returncode:
        raise RuntimeError("Local TTS failed: " + (proc.stderr or proc.stdout)[-1000:])
    files = [directory / ("line_%04d.wav" % i) for i in range(len(lines))]
    if any(not p.is_file() for p in files):
        raise RuntimeError("Local TTS did not produce all lines")
    return files

def duration_seconds(src):
    probe = Path(ffmpeg()).with_name("ffprobe.exe" if os.name == "nt" else "ffprobe")
    exe = str(probe) if probe.exists() else (shutil.which("ffprobe") or "ffprobe")
    p = subprocess.run([exe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(src)], capture_output=True, text=True, timeout=30)
    if p.returncode: raise RuntimeError("ffprobe unavailable")
    return float(p.stdout.strip())

def combine_speech(files, destination):
    manifest = destination.with_suffix(".txt")
    # Normalize each WAV to the same PCM layout before concatenation.
    normalized = []
    for i, src in enumerate(files):
        dest = destination.parent / ("pcm_%04d.wav" % i)
        run_ffmpeg(["-i", src, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", dest])
        normalized.append(dest)
    manifest.write_text("".join("file '" + str(p).replace("\\", "/").replace("'", "'\\''") + "'\n" for p in normalized), encoding="utf-8")
    run_ffmpeg(["-f", "concat", "-safe", "0", "-i", manifest, "-c:a", "pcm_s16le", destination])
    times = []
    cursor = 0.0
    for src in normalized:
        length = duration_seconds(src)
        times.append({"start": round(cursor, 3), "duration": round(length, 3)})
        cursor += length
    return times

@PromptServer.instance.routes.get("/unwin/dialogue/engines")
async def unwin_dialogue_engines(request):
    import importlib.util
    return web.json_response({
        "offline_tts": speech_engine(),
        "whisperx_installed": importlib.util.find_spec("whisperx") is not None,
        "ffmpeg": bool(shutil.which("ffmpeg")),
        "gemma_backend": "Ollama local HTTP at 127.0.0.1:11434 (optional)",
        "minimax": "installed t2v.json template",
        "lip_sync": "requires user-configured local ComfyUI workflow; not automatically available",
    })

@PromptServer.instance.routes.post("/unwin/dialogue/generate-speech")
async def unwin_generate_speech(request):
    try:
        data = await request.json()
        path, project = read_project(data.get("id"))
        if project["mode"] != "dialogue_to_video" or not project.get("lines"):
            raise ValueError("Save dialogue lines first")
        if not speech_engine():
            raise RuntimeError("Offline Windows SAPI is unavailable; import recorded dialogue instead")
        folder = path.parent
        lines = project["lines"]
        files = await asyncio.to_thread(synthesize_sapi, lines, folder)
        audio = folder / "master_dialogue.wav"
        times = await asyncio.to_thread(combine_speech, files, audio)
        for shot, timing in zip(project["shots"], times):
            shot.update(timing)
        project["master_audio"] = {"filename": audio.name, "duration": round(sum(t["duration"] for t in times), 3), "locked": True, "engine": "Windows SAPI offline"}
        save_project(path, project)
        return web.json_response({"ok": True, "project": project})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)

@PromptServer.instance.routes.post("/unwin/dialogue/plan-with-gemma")
async def unwin_gemma_plan(request):
    try:
        data = await request.json()
        path, project = read_project(data.get("id"))
        if not project.get("lines"):
            raise ValueError("Dialogue lines are required. For imported audio, supply a transcript first.")
        model = str(data.get("model", "gemma3:4b"))
        if not model or len(model) > 100 or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:._-" for c in model):
            raise ValueError("Invalid local Ollama model name")
        instruction = (
            "You are a cinematographer. Return ONLY a JSON object with a shots array. "
            "For each provided dialogue line, output one shot object with prompt, camera and location. "
            "Use cinematic visual language and keep speaker identity consistent. "
            "Do not modify spoken words. No more than 300 shots. Lines: "
            + json.dumps(project["lines"], ensure_ascii=False)
        )
        async with ClientSession(timeout=ClientTimeout(total=180)) as session:
            async with session.post("http://127.0.0.1:11434/api/generate", json={"model": model, "prompt": instruction, "stream": False, "format": "json"}) as resp:
                if resp.status != 200: raise RuntimeError("Ollama local server returned HTTP " + str(resp.status))
                result = await resp.json()
        proposed = json.loads(result.get("response", "{}")).get("shots", [])
        if not isinstance(proposed, list) or len(proposed) != len(project["lines"]):
            raise ValueError("Gemma returned an unexpected shot count; no changes saved")
        if not project.get("shots"):
            project["shots"] = shots_from_lines(project["lines"])
        for shot, idea in zip(project["shots"], proposed):
            if not isinstance(idea, dict): raise ValueError("Invalid Gemma shot")
            shot["prompt"] = str(idea.get("prompt", shot["prompt"]))[:3000]
            shot["camera"] = str(idea.get("camera", ""))[:200]
            shot["location"] = str(idea.get("location", ""))[:200]
        save_project(path, project)
        return web.json_response({"ok": True, "project": project})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)

@PromptServer.instance.routes.post("/unwin/dialogue/render-shot")
async def unwin_render_dialogue_shot(request):
    """Queue a short local H3 shot; does not imply lip-sync or final mix."""
    try:
        data = await request.json()
        path, project = read_project(data.get("id"))
        index = int(data.get("index", -1))
        shots = project.get("shots", [])
        if not 0 <= index < len(shots): raise ValueError("Invalid shot index")
        shot = shots[index]
        workflow = json.loads((BASE / "t2v.json").read_text(encoding="utf-8"))
        fps = 24
        # Constrain to short, low-resolution local tests by default.
        width = int(data.get("width", 512))
        height = int(data.get("height", 288))
        steps = int(data.get("steps", 8))
        if width % 16 or height % 16 or not (256 <= width <= 960 and 256 <= height <= 544):
            raise ValueError("Dimensions must be multiples of 16 within 256-960 x 256-544")
        if not 4 <= steps <= 30: raise ValueError("Steps must be 4-30")
        frames = max(9, min(129, int(float(shot["duration"]) * fps)))
        workflow["6"]["inputs"].update({"prompt": str(shot["prompt"]), "width": width, "height": height, "length": frames})
        workflow["9"]["inputs"]["steps"] = steps
        workflow["8"]["inputs"]["noise_seed"] = int.from_bytes(os.urandom(4), "big")
        workflow["15"]["inputs"]["filename_prefix"] = "unwin_director/dialogue_" + project["id"][:8] + "_" + str(index).zfill(3)
        async with ClientSession(timeout=ClientTimeout(total=30)) as session:
            async with session.post("http://127.0.0.1:8188/prompt", json={"prompt": workflow, "client_id": "unwin-audio-" + uuid.uuid4().hex}) as response:
                result = await response.json()
                if response.status != 200 or "prompt_id" not in result:
                    raise RuntimeError("ComfyUI rejected shot: " + str(result)[:900])
        project.setdefault("render_jobs", {})[str(index)] = result["prompt_id"]
        save_project(path, project)
        return web.json_response({"ok": True, "prompt_id": result["prompt_id"], "note": "Video queued; audio remains separate until final mux. Lip-sync requires its own workflow."})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)

@PromptServer.instance.routes.post("/unwin/dialogue/final-mux")
async def unwin_dialogue_mux(request):
    """Combine completed video clips and replace generated audio with master dialogue."""
    try:
        data = await request.json()
        path, project = read_project(data.get("id"))
        audio_info = project.get("master_audio")
        if not audio_info: raise ValueError("Import or generate master dialogue first")
        audio = path.parent / audio_info["filename"]
        if not audio.is_file(): raise ValueError("Master audio file is missing")
        clips = data.get("clips")
        if not isinstance(clips, list) or not 1 <= len(clips) <= 100: raise ValueError("Provide 1-100 completed clip filenames")
        sources = [safe_output(name) for name in clips]
        dest = safe_output("unwin_dialogue_final_" + uuid.uuid4().hex[:10] + ".mp4", False)
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            norm = []
            for i, src in enumerate(sources):
                out = temp / ("%04d.mp4" % i)
                run_ffmpeg(["-i", src, "-map", "0:v:0", "-an", "-vf", "fps=24,format=yuv420p", "-c:v", "libx264", "-crf", "19", out])
                norm.append(out)
            manifest = temp / "clips.txt"
            manifest.write_text("".join("file '" + str(p).replace("\\", "/") + "'\n" for p in norm), encoding="utf-8")
            video = temp / "silent.mp4"
            run_ffmpeg(["-f", "concat", "-safe", "0", "-i", manifest, "-c", "copy", video])
            run_ffmpeg(["-i", video, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", dest])
        return web.json_response({"ok": True, "filename": dest.name, "note": "Audio replaced, not lip-synced. Check scene durations against dialogue."})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)
