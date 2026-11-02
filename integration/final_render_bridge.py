"""Project-aware, local-only Final Render route for UNWIN Audio Studio."""
import asyncio
import json
import tempfile
import uuid
from pathlib import Path
from aiohttp import web, ClientSession, ClientTimeout
from server import PromptServer
from .dialogue_studio import load, error
from .nodes import safe_output, run_ffmpeg, output_root

async def discover_clips(project):
    jobs = project.get('render_jobs') or {}
    if not jobs:
        raise ValueError('No queued project shots found. Enter completed clip filenames manually.')
    clips = []
    async with ClientSession(timeout=ClientTimeout(total=20)) as session:
        for index in range(len(project.get('shots') or [])):
            pid = jobs.get(str(index))
            if not pid:
                raise ValueError(f'Shot {index + 1} has no render job. Enter clips manually or render all shots.')
            async with session.get('http://127.0.0.1:8188/history/' + str(pid)) as resp:
                if resp.status != 200:
                    raise ValueError(f'Could not inspect render for shot {index + 1}')
                history = await resp.json()
            entry = history.get(str(pid)) or {}
            outputs = entry.get('outputs') or {}
            videos = []
            for node in outputs.values():
                for key in ('gifs', 'videos', 'images'):
                    for item in node.get(key, []):
                        if str(item.get('filename', '')).lower().endswith(('.mp4', '.mov', '.mkv', '.webm')):
                            videos.append(item)
            if not videos:
                raise ValueError(f'Shot {index + 1} is not finished or has no saved video.')
            item = videos[0]
            rel = '/'.join(filter(None, [str(item.get('subfolder') or ''), str(item['filename'])]))
            clips.append(rel)
    return clips

@PromptServer.instance.routes.post('/unwin/dialogue/final-render')
async def final_render(request):
    try:
        d = await request.json()
        path, project = load(d.get('id'))
        info = project.get('master_audio')
        if not isinstance(info, dict) or not info.get('filename'):
            raise ValueError('Assemble or import master audio first.')
        audio = (path.parent / info['filename']).resolve()
        if not audio.is_file() or not audio.is_relative_to(path.parent.resolve()):
            raise ValueError('Master audio is missing or invalid.')
        clips = d.get('clips') or []
        if not isinstance(clips, list):
            raise ValueError('Clips must be a list.')
        if not clips:
            clips = await discover_clips(project)
        if len(clips) > 100:
            raise ValueError('Maximum 100 clips.')
        sources = [safe_output(name) for name in clips]
        dest_name = 'unwin_director/final_' + project['id'][:8] + '_' + uuid.uuid4().hex[:8] + '.mp4'
        dest = safe_output(dest_name, must_exist=False)
        dest.parent.mkdir(parents=True, exist_ok=True)
        loop_to_audio = bool(d.get('loop_to_audio', True))
        with tempfile.TemporaryDirectory(prefix='unwin-final-') as td:
            temp = Path(td)
            normalized = []
            for i, src in enumerate(sources):
                norm = temp / f'{i:04d}.mp4'
                await asyncio.to_thread(run_ffmpeg, ['-i', src, '-map', '0:v:0', '-an',
                    '-vf', 'fps=24,format=yuv420p', '-c:v', 'libx264', '-preset', 'fast',
                    '-crf', '20', '-pix_fmt', 'yuv420p', norm])
                normalized.append(norm)
            listing = temp / 'clips.txt'
            listing.write_text(''.join("file '" + p.as_posix() + "'\n" for p in normalized), encoding='utf-8')
            silent = temp / 'silent.mp4'
            await asyncio.to_thread(run_ffmpeg, ['-f', 'concat', '-safe', '0', '-i', listing, '-c', 'copy', silent])
            inputs = ['-stream_loop', '-1', '-i', silent] if loop_to_audio else ['-i', silent]
            await asyncio.to_thread(run_ffmpeg, [*inputs, '-i', audio, '-map', '0:v:0', '-map', '1:a:0',
                '-c:v', 'libx264' if loop_to_audio else 'copy', '-preset', 'fast',
                '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', dest])
        return web.json_response({'ok': True, 'filename': dest_name, 'clips': clips,
            'view_url': '/view?filename=' + dest.name + '&subfolder=unwin_director&type=output',
            'note': 'Lip-sync not applied. Narration replaces source clip audio.'})
    except Exception as exc:
        return error(exc)
