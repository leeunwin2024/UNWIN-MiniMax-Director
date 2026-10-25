import json, shutil, subprocess, tempfile
from pathlib import Path
import torch

def output_root():
    import folder_paths
    return Path(folder_paths.get_output_directory()).resolve()

def safe_output(name, must_exist=True):
    root=output_root(); target=(root / str(name)).resolve()
    if not target.is_relative_to(root): raise ValueError("Paths must remain inside ComfyUI output")
    if must_exist and not target.is_file(): raise FileNotFoundError(target)
    return target

def ffmpeg():
    executable=shutil.which('ffmpeg')
    if not executable:
        try:
            import imageio_ffmpeg
            executable=imageio_ffmpeg.get_ffmpeg_exe()
        except Exception: pass
    if not executable:
        for base in (Path(__file__).resolve().parent,Path(__file__).resolve().parent.parent,Path(__file__).resolve().parent.parent.parent):
            for candidate in (base/'ffmpeg.exe',base/'bin'/'ffmpeg.exe',base/'ffmpeg',base/'bin'/'ffmpeg'):
                if candidate.is_file(): executable=str(candidate);break
            if executable:break
    if not executable: raise RuntimeError('Install ffmpeg and put it on PATH')
    return executable

def run_ffmpeg(args):
    proc=subprocess.run([ffmpeg(),'-hide_banner','-loglevel','error','-y',*map(str,args)],capture_output=True,text=True)
    if proc.returncode: raise RuntimeError('Local ffmpeg failed: '+proc.stderr[-2500:])

class UnwinTimeline:
    @classmethod
    def INPUT_TYPES(cls): return {'required':{'timeline_json':('STRING',{'default':'{"shots":[]}','multiline':True}),'shot_index':('INT',{'default':0,'min':0,'max':999}),'carry_last_frame':('BOOLEAN',{'default':True})},'optional':{'previous_frames':('IMAGE',),'reference_frame':('IMAGE',)}}
    RETURN_TYPES=('STRING','STRING','IMAGE','INT'); RETURN_NAMES=('prompt','settings_json','starting_frame','shot_count'); FUNCTION='run'; CATEGORY='Unwin/MiniMax Director'
    def run(self,timeline_json,shot_index,carry_last_frame,previous_frames=None,reference_frame=None):
        data=json.loads(timeline_json);shots=data.get('shots',[])
        if not isinstance(shots,list) or not shots or shot_index>=len(shots):raise ValueError('Add a shot or select a valid shot index')
        shot=shots[shot_index]; frame=None
        if carry_last_frame and shot.get('carry_last_frame',True) and previous_frames is not None:frame=previous_frames[-1:].clone()
        elif reference_frame is not None:frame=reference_frame[:1].clone()
        if frame is None:frame=torch.zeros((1,64,64,3),dtype=torch.float32)
        return (str(shot.get('prompt','')),json.dumps(shot),frame,len(shots))

class UnwinLastFrame:
    @classmethod
    def INPUT_TYPES(cls):return {'required':{'frames':('IMAGE',)}}
    RETURN_TYPES=('IMAGE','IMAGE');RETURN_NAMES=('last_frame','all_frames');FUNCTION='run';CATEGORY='Unwin/MiniMax Director'
    def run(self,frames):return frames[-1:].clone(),frames

def ffprobe_audio(path):
    probe=shutil.which('ffprobe')
    if not probe:
        candidate=Path(ffmpeg()).with_name('ffprobe.exe' if __import__('os').name=='nt' else 'ffprobe')
        if candidate.is_file(): probe=str(candidate)
    if not probe: raise RuntimeError('ffprobe is required alongside ffmpeg')
    p=subprocess.run([probe,'-v','error','-select_streams','a:0','-show_entries','stream=index','-of','csv=p=0',str(path)],capture_output=True,text=True)
    if p.returncode: raise RuntimeError(p.stderr)
    return bool(p.stdout.strip())

def stitch_audio(clips, fps=24, output_name=None, upscale=1, trim_seam=False):
    paths=[safe_output(c) for c in clips]
    if not paths: raise ValueError('No clips selected')
    if len(paths)>100: raise ValueError('Maximum 100 clips')
    dest=safe_output(Path(output_name).name if output_name else 'unwin_director_final.mp4',False).with_suffix('.mp4')
    if dest in paths: raise ValueError('Output would overwrite an input')
    if upscale not in (1,2): raise ValueError('Upscale must be 1 or 2')
    with tempfile.TemporaryDirectory() as td:
        td=Path(td);norm=[]
        for i,src in enumerate(paths):
            out=td/f'{i:04}.mp4'
            scale=f'scale=trunc(iw*{upscale}/2)*2:trunc(ih*{upscale}/2)*2:flags=lanczos'
            args=(['-ss',str(1.0/fps)] if trim_seam and i>0 else [])+['-i',src]
            if not ffprobe_audio(src):args+=['-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000']
            args+=['-map','0:v:0','-map',('0:a:0' if ffprobe_audio(src) else '1:a:0'),'-vf',f'fps={fps},{scale},format=yuv420p','-c:v','libx264','-crf','18','-preset','medium','-c:a','aac','-ar','48000','-ac','2','-b:a','192k','-shortest',out]
            run_ffmpeg(args);norm.append(out)
        manifest=td/'clips.txt';manifest.write_text(''.join("file '"+str(x)+"'\n" for x in norm),encoding='utf-8')
        run_ffmpeg(['-f','concat','-safe','0','-i',manifest,'-c','copy','-movflags','+faststart',dest])
    return dest

class UnwinStitch:
    @classmethod
    def INPUT_TYPES(cls):return {'required':{'clips_json':('STRING',{'default':'[]','multiline':True}),'output_name':('STRING',{'default':'unwin_final.mp4'}),'fps':('INT',{'default':24,'min':1,'max':120}),'transition_seconds':('FLOAT',{'default':0,'min':0,'max':3,'step':0.1}),'upscale':([1,2],)}}
    RETURN_TYPES=('STRING',);RETURN_NAMES=('output_path',);FUNCTION='run';CATEGORY='Unwin/MiniMax Director';OUTPUT_NODE=True
    def run(self,clips_json,output_name,fps,transition_seconds,upscale):
        if transition_seconds:raise ValueError('Transitions not yet supported; set to 0')
        return (str(stitch_audio(json.loads(clips_json),fps,output_name,int(upscale))),)

class UnwinExtractFrame:
    @classmethod
    def INPUT_TYPES(cls):return {'required':{'clip_filename':('STRING',{'default':'scene_00001.mp4'}),'position':(['last','first'],),'output_image_name':('STRING',{'default':'unwin_frame.png'})}}
    RETURN_TYPES=('IMAGE','STRING');RETURN_NAMES=('frame','image_path');FUNCTION='run';CATEGORY='Unwin/MiniMax Director'
    def run(self,clip_filename,position,output_image_name):
        import numpy as np
        from PIL import Image
        src=safe_output(clip_filename); dest=safe_output(Path(output_image_name).name,False).with_suffix('.png')
        if position=='first':run_ffmpeg(['-i',src,'-frames:v','1',dest])
        else:run_ffmpeg(['-sseof','-2','-i',src,'-an','-vf','reverse','-update','1','-frames:v','1',dest])
        im=np.asarray(Image.open(dest).convert('RGB'),dtype=np.float32)/255.0
        return torch.from_numpy(im)[None,...],str(dest)

NODE_CLASS_MAPPINGS={'UnwinTimeline':UnwinTimeline,'UnwinLastFrame':UnwinLastFrame,'UnwinStitch':UnwinStitch,'UnwinExtractFrame':UnwinExtractFrame}
NODE_DISPLAY_NAME_MAPPINGS={'UnwinTimeline':'Unwin Director Timeline','UnwinLastFrame':'Unwin Last Frame','UnwinStitch':'Unwin Local Video Stitch','UnwinExtractFrame':'Unwin Extract Video Frame'}

# Standalone local director services. No external HTTP calls.
import copy, uuid
from aiohttp import web
from server import PromptServer

_BASE = Path(__file__).parent

def _director_input(name):
    import folder_paths
    base=Path(folder_paths.get_input_directory()).resolve()
    path=(base / Path(str(name)).name).resolve()
    if not path.is_relative_to(base): raise ValueError('invalid input path')
    return path

@PromptServer.instance.routes.get('/unwin/models')
async def unwin_models(request):
    import folder_paths
    def names(key):
        try: return folder_paths.get_filename_list(key)
        except Exception: return []
    return web.json_response({'diffusion_models':names('diffusion_models'),'text_encoders':names('text_encoders'),'vae':names('vae'),'loras':names('loras')})

@PromptServer.instance.routes.get('/unwin/template/{mode}')
async def unwin_template(request):
    mode=request.match_info['mode']
    if mode not in ('i2v','t2v'): return web.json_response({'error':'invalid mode'},status=400)
    return web.json_response(json.loads((_BASE/(mode+'.json')).read_text(encoding='utf-8')))

@PromptServer.instance.routes.post('/unwin/last-frame')
async def unwin_last_frame(request):
    try:
        p=await request.json()
        src=safe_output(str(Path(p['filename']).as_posix()))
        target=_director_input('unwin_last_'+uuid.uuid4().hex[:12]+'.png')
        run_ffmpeg(['-sseof','-2','-i',src,'-an','-vf','reverse','-frames:v','1','-update','1',target])
        return web.json_response({'ok':True,'filename':target.name})
    except Exception as e: return web.json_response({'ok':False,'error':str(e)},status=400)

@PromptServer.instance.routes.post('/unwin/stitch')
async def unwin_stitch(request):
    try:
        p=await request.json();clips=p.get('clips',[])
        if not isinstance(clips,list):raise ValueError('clips must be an array')
        fps=max(1,min(60,int(p.get('fps',24))))
        scale=int(p.get('upscale',1))
        dst=stitch_audio(clips,fps,'unwin_director_'+uuid.uuid4().hex[:10]+'.mp4',scale,bool(p.get('trim_seam',False)))
        return web.json_response({'ok':True,'filename':dst.name,'audio_preserved':True,'upscale':scale})
    except Exception as e:return web.json_response({'ok':False,'error':str(e)},status=400)


@PromptServer.instance.routes.get('/unwin/find-render')
async def unwin_find_render(request):
    """Find SaveVideo outputs even when ComfyUI history omits its video metadata."""
    try:
        prefix=str(request.query.get('prefix','')).replace('\\','/').strip('/')
        if not prefix.startswith('unwin_director/scene_') or '..' in prefix:
            raise ValueError('Invalid director output prefix')
        root=output_root()
        # SaveVideo can add a counter and/or write into a prefix subfolder.
        parent=(root/Path(prefix).parent).resolve()
        if not parent.is_relative_to(root):raise ValueError('Invalid output directory')
        stem=Path(prefix).name
        found=[]
        if parent.is_dir():
            for f in parent.rglob('*'):
                if f.is_file() and f.suffix.lower() in ('.mp4','.webm','.mov','.mkv') and (f.name.startswith(stem) or stem in f.as_posix()):
                    found.append(f)
        found.sort(key=lambda f:f.stat().st_mtime,reverse=True)
        return web.json_response({'ok':True,'filename':found[0].relative_to(root).as_posix() if found else None,'candidates':len(found)})
    except Exception as e:
        return web.json_response({'ok':False,'error':str(e)},status=400)


@PromptServer.instance.routes.get('/unwin/system')
async def unwin_system(request):
    import folder_paths
    from pathlib import Path
    try:
        import torch
        gpu=torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
        vram=round(torch.cuda.get_device_properties(0).total_memory/1024**3,1) if gpu else 0
    except Exception:
        gpu=None;vram=0
    try: ff=ffmpeg()
    except Exception: ff=None
    groups={}
    for key in ('diffusion_models','text_encoders','vae','loras'):
        items=[]
        for name in folder_paths.get_filename_list(key):
            try:
                path=folder_paths.get_full_path(key,name)
                size=round(Path(path).stat().st_size/1024**3,2) if path else None
            except Exception: size=None
            items.append({'name':name,'size_gb':size,'exists':size is not None})
        groups[key]=items
    return web.json_response({'gpu':gpu,'vram_gb':vram,'ffmpeg':ff,'models':groups})

# Optional online model acquisition; generation remains entirely local.
from . import model_manager as _unwin_mm

@PromptServer.instance.routes.get('/unwin/model-manager/catalog')
async def unwin_model_catalog(request):
    return web.json_response({'models':_unwin_mm.catalog(),'jobs':_unwin_mm.jobs()})

@PromptServer.instance.routes.post('/unwin/model-manager/download')
async def unwin_model_download(request):
    try:
        payload=await request.json()
        return web.json_response(_unwin_mm.start(str(payload.get('id',''))))
    except Exception as e:return web.json_response({'error':str(e)},status=400)

@PromptServer.instance.routes.post('/unwin/model-manager/verify')
async def unwin_model_verify(request):
    try:
        payload=await request.json();mid=str(payload.get('id',''))
        if mid not in _unwin_mm.REGISTRY:raise ValueError('Unknown model')
        return web.json_response(_unwin_mm.verify(mid,True))
    except Exception as e:return web.json_response({'error':str(e)},status=400)


# Project persistence: server-side copies are kept outside the extension folder.
import re as _unwin_re
from datetime import datetime as _unwin_datetime, timezone as _unwin_timezone

def _unwin_project_dir():
    root=output_root()/'unwin_director'/'projects'
    root.mkdir(parents=True,exist_ok=True)
    return root

def _unwin_project_name(value):
    name=_unwin_re.sub(r'[^a-zA-Z0-9_-]+','_',str(value or 'Unwin_Project')).strip('_')[:80]
    return name or 'Unwin_Project'

@PromptServer.instance.routes.post('/unwin/project/save')
async def unwin_project_save(request):
    try:
        data=await request.json()
        project=data.get('project')
        if not isinstance(project,dict) or not isinstance(project.get('shots'),list) or not project['shots']:
            raise ValueError('Project must contain scenes')
        if len(project['shots'])>500:raise ValueError('Too many scenes')
        serialized=json.dumps(project,ensure_ascii=False,indent=2)
        if len(serialized.encode('utf-8'))>8*1024*1024:raise ValueError('Project exceeds 8MB')
        name=_unwin_project_name(project.get('projectName'))
        folder=_unwin_project_dir(); destination=folder/(name+'.unwin.json')
        stamp=_unwin_datetime.now(_unwin_timezone.utc).strftime('%Y%m%d_%H%M%S_%f')
        backup=folder/(name+'__'+stamp+'.backup.unwin.json')
        import os
        from tempfile import NamedTemporaryFile
        with NamedTemporaryFile('w',encoding='utf-8',dir=folder,delete=False,suffix='.tmp') as tmp:
            tmp.write(serialized); temp=Path(tmp.name)
        try:os.replace(temp,destination)
        finally:temp.unlink(missing_ok=True)
        backup.write_text(serialized,encoding='utf-8')
        backups=sorted(folder.glob(name+'__*.backup.unwin.json'),reverse=True)
        for old in backups[20:]:old.unlink(missing_ok=True)
        return web.json_response({'ok':True,'filename':destination.name,'path':str(destination),'backup':backup.name})
    except Exception as exc:return web.json_response({'error':str(exc)},status=400)

@PromptServer.instance.routes.get('/unwin/project/list')
async def unwin_project_list(request):
    folder=_unwin_project_dir()
    return web.json_response({'directory':str(folder),'projects':[{'filename':f.name,'modified':f.stat().st_mtime} for f in sorted(folder.glob('*.unwin.json'),key=lambda f:f.stat().st_mtime,reverse=True)][:100]})

@PromptServer.instance.routes.get('/unwin/project/load')
async def unwin_project_load(request):
    name=str(request.query.get('name',''))
    if not name or Path(name).name!=name or not name.endswith('.unwin.json'):
        return web.json_response({'error':'Invalid project filename'},status=400)
    path=_unwin_project_dir()/name
    if not path.is_file():return web.json_response({'error':'Project not found'},status=404)
    return web.json_response({'project':json.loads(path.read_text(encoding='utf-8'))})
