"""Optional offline AI upscale with Real-ESRGAN NCNN Vulkan; no API calls."""
import os, shutil, subprocess, tempfile, threading, uuid, time, urllib.request, zipfile, hashlib, traceback
from pathlib import Path
from aiohttp import web
from server import PromptServer
from .nodes import safe_output, ffmpeg, run_ffmpeg

JOBS={}
INSTALL_JOBS={}
LOCK=threading.Lock()
RELEASE_URL="https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip"
MODELS=("realesrgan-x4plus", "realesrgan-x4plus-anime")

def binary():
    env=os.environ.get('UNWIN_REALESRGAN_EXE','')
    base=Path(__file__).resolve().parent
    options=[env,str(base/'tools'/'realesrgan-ncnn-vulkan.exe'),str(base/'tools'/'realesrgan-ncnn-vulkan'),shutil.which('realesrgan-ncnn-vulkan'),shutil.which('realesrgan-ncnn-vulkan.exe')]
    for item in options:
        if item and Path(item).is_file(): return str(Path(item).resolve())
    return None

def model_directory():
    return Path(__file__).resolve().parent/'tools'/'models'

def validate_install():
    exe=binary()
    root=model_directory()
    # Portable engine may also be supplied by PATH; model folder must be next to executable.
    if exe and (Path(exe).parent/'models').is_dir():root=Path(exe).parent/'models'
    missing=[f'{name}.{ext}' for name in MODELS for ext in ('param','bin') if not (root/f'{name}.{ext}').is_file() or (root/f'{name}.{ext}').stat().st_size==0]
    ready=bool(exe) and not missing
    message=('Ready: Real-ESRGAN executable and model pairs verified' if ready else ('Executable missing. ' if not exe else '')+('Missing model files: '+', '.join(missing) if missing else ''))
    return {'installed':bool(exe),'ready':ready,'executable':exe or '', 'models':list(MODELS),'models_dir':str(root),'missing':missing,'message':message}

def install_worker(job):
    try:
        base=Path(__file__).resolve().parent/'tools'
        base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='unwin_esrgan_') as tmp:
            archive=Path(tmp)/'realesrgan.zip'
            req=urllib.request.Request(RELEASE_URL,headers={'User-Agent':'Unwin-MiniMax-Director/1.1.1'})
            with urllib.request.urlopen(req,timeout=45) as source,archive.open('wb') as target:
                total=int(source.headers.get('Content-Length','0'))
                received=0
                while True:
                    chunk=source.read(1024*512)
                    if not chunk:break
                    received+=len(chunk)
                    if received>350*1024*1024:raise RuntimeError('Archive exceeds safety limit')
                    target.write(chunk)
                    with LOCK:INSTALL_JOBS[job].update(status=f'Downloading {received//1048576} MB',progress=min(75,int(received/total*75)) if total else 10)
            with zipfile.ZipFile(archive) as z:
                members=z.infolist()
                if sum(x.file_size for x in members)>700*1024*1024:raise RuntimeError('Archive expands beyond safety limit')
                wanted={x.filename.replace('\\','/').split('/')[-1]:x for x in members if not x.is_dir()}
                exe_name='realesrgan-ncnn-vulkan.exe' if os.name=='nt' else 'realesrgan-ncnn-vulkan'
                needed=[exe_name]+[f'{m}.{ext}' for m in MODELS for ext in ('param','bin')]
                for name in needed:
                    if name not in wanted:raise RuntimeError('Official archive is missing '+name)
                for i,name in enumerate(needed):
                    target_dir=base if name==exe_name else base/'models';target_dir.mkdir(parents=True,exist_ok=True)
                    temp_file=target_dir/(name+'.installing')
                    with z.open(wanted[name]) as source,temp_file.open('wb') as target:shutil.copyfileobj(source,target)
                    if not temp_file.stat().st_size:raise RuntimeError('Empty file: '+name)
                    temp_file.replace(target_dir/name)
                    with LOCK:INSTALL_JOBS[job].update(status='Installing '+name,progress=76+int((i+1)/len(needed)*20))
        result=validate_install()
        if not result['ready']:raise RuntimeError(result['message'])
        with LOCK:INSTALL_JOBS[job].update(status='Installed and verified',progress=100,done=True)
    except Exception as exc:
        with LOCK:INSTALL_JOBS[job].update(status='Installation failed',error=str(exc))

@PromptServer.instance.routes.post('/unwin/ai-upscale/install')
async def install_esrgan(request):
    with LOCK:
        if any(not j.get('done') and not j.get('error') for j in INSTALL_JOBS.values()):
            return web.json_response({'error':'An installation is already running'},status=409)
        job=uuid.uuid4().hex[:12]
        INSTALL_JOBS[job]={'job':job,'status':'Starting download','progress':0,'done':False,'error':''}
    threading.Thread(target=install_worker,args=(job,),daemon=True).start()
    return web.json_response({'job':job})

@PromptServer.instance.routes.get('/unwin/ai-upscale/install')
async def install_esrgan_status(request):
    job=request.query.get('job','')
    with LOCK: result=INSTALL_JOBS.get(job)
    if result is None:return web.json_response({'error':'Unknown installation'},status=404)
    return web.json_response(result)

def probe_duration(path):
    tool=shutil.which('ffprobe')
    if not tool: return None
    p=subprocess.run([tool,'-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',str(path)],capture_output=True,text=True)
    try:return float(p.stdout.strip())
    except: return None

def update(job,**kw):
    with LOCK:JOBS[job].update(kw)

def _cancelled(job):
    with LOCK:
        return bool(JOBS.get(job, {}).get('cancel_requested'))


def _run_esrgan_batch(job, cmd, timeout_seconds=180):
    """Drain engine output and impose a hard timeout; don't leave a stuck Vulkan child running."""
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, errors='replace', bufsize=1,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    lines = []
    def drain():
        try:
            for line in proc.stdout:
                lines.append(line.rstrip())
                if len(lines) > 120:
                    del lines[:60]
        except Exception as exc:
            lines.append('Log reader: ' + str(exc))
    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    started = time.monotonic()
    try:
        while proc.poll() is None:
            if _cancelled(job):
                raise RuntimeError('Cancelled by user')
            if time.monotonic() - started > timeout_seconds:
                raise RuntimeError('Real-ESRGAN batch exceeded %ds. Last output: %s' %
                                   (timeout_seconds, ' | '.join(lines[-6:])))
            time.sleep(0.5)
        reader.join(timeout=3)
        if proc.returncode:
            raise RuntimeError('Real-ESRGAN exit %s: %s' %
                               (proc.returncode, ' | '.join(lines[-12:])))
    except BaseException:
        if proc.poll() is None:
            proc.kill()
            try: proc.wait(timeout=5)
            except subprocess.TimeoutExpired: pass
        raise
    return ' | '.join(lines[-6:])


def worker(job,src,scale,model,review=True):
    try:
        exe=binary()
        verification=validate_install()
        if not verification['ready']:
            raise RuntimeError(verification['message'])
        src=Path(src)
        # Distinct cache per diagnostic version, engine and source.
        fingerprint=hashlib.sha256('|'.join(map(str,(src.resolve(),src.stat().st_size,src.stat().st_mtime_ns,scale,model,'quality-v1153'))).encode()).hexdigest()[:20]
        cache=src.parent/'unwin_ai_cache'/fingerprint
        frames=cache/'frames';outframes=cache/'upscaled'
        frames.mkdir(parents=True,exist_ok=True);outframes.mkdir(parents=True,exist_ok=True)
        update(job,status='Extracting frames (or reusing cached frames)',progress=3,cache=str(cache))
        if not (cache/'extraction_complete').exists():
            for old in frames.glob('frame_*.png'):old.unlink()
            try:
                run_ffmpeg(['-i',str(src),'-map','0:v:0','-an','-sn','-dn',
                            '-fps_mode','passthrough',frames/'frame_%08d.png'])
            except RuntimeError as exc:
                if 'fps_mode' not in str(exc) and 'Unrecognized option' not in str(exc):raise
                run_ffmpeg(['-i',str(src),'-map','0:v:0','-an','-sn','-dn',frames/'frame_%08d.png'])
            (cache/'extraction_complete').write_text('ok')
        inputs=sorted(frames.glob('frame_*.png'))
        count=len(inputs)
        if not count:raise RuntimeError('No frames extracted')
        # Probe ONE real frame with independent Vulkan tile settings.
        # Never assume process success means the image is visually correct.
        chosen_tile=0
        if review:
            candidate_dir=cache/'diagnostics'
            candidate_dir.mkdir(exist_ok=True)
            original=inputs[0]
            candidates=[]
            diagnostics=[]
            for tile in (0,256,128):
                if _cancelled(job):raise RuntimeError('Cancelled by user')
                candidate=candidate_dir/('tile_%d.png' % tile)
                if candidate.exists():candidate.unlink()
                cmd=[exe,'-i',str(original),'-o',str(candidate),'-n',model,
                     '-s',str(scale),'-f','png','-g','0','-t',str(tile)]
                update(job,status='Testing single frame (GPU 0, tile %d)' % tile,progress=5)
                try:
                    log=_run_esrgan_batch(job,cmd,timeout_seconds=180)
                    if not candidate.is_file() or candidate.stat().st_size==0:
                        raise RuntimeError('Engine did not create an image: '+log)
                    relative=candidate.relative_to(safe_output('unwin_preview_root',False).parent).as_posix()
                    candidates.append({'tile':tile,'image':relative})
                    diagnostics.append('tile %d: produced %d bytes' % (tile,candidate.stat().st_size))
                except RuntimeError as exc:
                    if 'Cancelled by user' in str(exc):raise
                    diagnostics.append('tile %d: %s' % (tile,str(exc)))
            if not candidates:
                raise RuntimeError('Every single-frame Vulkan diagnostic failed: '+'; '.join(diagnostics))
            original_rel=original.relative_to(safe_output('unwin_preview_root',False).parent).as_posix()
            update(job,status='Compare each tile result; choose only an undamaged frame',progress=10,
                   review_pending=True,preview_original=original_rel,
                   preview_candidates=candidates,diagnostics=diagnostics)
            while True:
                if _cancelled(job):raise RuntimeError('Cancelled by user')
                with LOCK:decision=JOBS[job].get('review_decision')
                if decision=='reject':raise RuntimeError('All previews rejected; no video was encoded')
                if isinstance(decision,str) and decision.startswith('tile:'):
                    selected=int(decision.split(':',1)[1])
                    if selected in [c['tile'] for c in candidates]:
                        chosen_tile=selected
                        break
                time.sleep(0.5)
            update(job,review_pending=False,review_decision='',
                   status='Selected tile %d; rendering remaining frames' % chosen_tile)
            # Copy the exact approved frame to the output; no rerender of that frame.
            shutil.copy2(candidate_dir/('tile_%d.png'%chosen_tile),outframes/original.name)
        batch_size=8
        completed=0
        for start in range(0,count,batch_size):
            if _cancelled(job):raise RuntimeError('Cancelled by user')
            batch=inputs[start:start+batch_size]
            pending=[f for f in batch if not (outframes/f.name).is_file() or (outframes/f.name).stat().st_size==0]
            if pending:
                with tempfile.TemporaryDirectory(prefix='unwin_batch_',dir=str(cache)) as tmp:
                    batch_in=Path(tmp)/'input';batch_in.mkdir()
                    # Copy rather than symlink: works on Windows without administrator permissions.
                    for frame in pending:shutil.copy2(frame,batch_in/frame.name)
                    errors=[]
                    for tile in ([chosen_tile] if review else [0,256,128]):
                        if _cancelled(job):raise RuntimeError('Cancelled by user')
                        cmd=[exe,'-i',str(batch_in),'-o',str(outframes),'-n',model,
                             '-s',str(scale),'-f','png','-g','0','-t',str(tile)]
                        update(job,status='AI enhancing frames %d-%d/%d (NVIDIA GPU 0, tile %d)' %
                               (start+1,start+len(batch),count,tile),
                               progress=min(89,10+int(completed/count*79)),
                               current_frame=completed,total_frames=count,gpu='NVIDIA GPU 0',tile=tile)
                        try:
                            log=_run_esrgan_batch(job,cmd,timeout_seconds=180)
                            missing=[f.name for f in pending if not (outframes/f.name).is_file() or (outframes/f.name).stat().st_size==0]
                            if missing:raise RuntimeError('No output for '+', '.join(missing[:3])+'. '+log)
                            break
                        except RuntimeError as exc:
                            errors.append('tile %d: %s' % (tile,str(exc)))
                            if 'Cancelled by user' in str(exc):raise
                            # Drop partial files from failed batch before retry.
                            for f in pending:
                                dest=outframes/f.name
                                if dest.exists():dest.unlink()
                    else:
                        raise RuntimeError('Batch %d-%d failed: %s' %
                                           (start+1,start+len(batch),' ; '.join(errors)[-1800:]))
            completed+=len(batch)
            elapsed=time.monotonic()-JOBS[job]['started_at']
            eta=int(elapsed/completed*(count-completed)) if completed else None
            update(job,status='AI enhancing frames: %d/%d' % (completed,count),
                   progress=min(89,10+int(completed/count*79)),current_frame=completed,
                   total_frames=count,eta_seconds=eta,elapsed_seconds=int(elapsed))
        update(job,status='Encoding enhanced video and preserving audio',progress=92)
        dest=safe_output('unwin_ai_upscaled_'+job+'.mp4',False)
        probe=shutil.which('ffprobe');fps='24'
        if probe:
            r=subprocess.run([probe,'-v','error','-select_streams','v:0',
                '-show_entries','stream=avg_frame_rate',
                '-of','default=noprint_wrappers=1:nokey=1',str(src)],capture_output=True,text=True)
            val=r.stdout.strip()
            if val and val!='0/0':fps=val
        run_ffmpeg(['-framerate',fps,'-i',outframes/'frame_%08d.png','-i',str(src),
                    '-map','0:v:0','-map','1:a?','-c:v','libx264','-preset','medium',
                    '-crf','17','-pix_fmt','yuv420p','-c:a','copy','-movflags','+faststart',
                    '-shortest',dest])
        update(job,status='Complete',progress=100,output=dest.name,eta_seconds=0)
    except Exception as e:
        detail=traceback.format_exc()
        print('[Unwin AI Upscale v1.1.5.3] '+detail,flush=True)
        update(job,status='Cancelled' if _cancelled(job) else 'Failed',error=str(e)+' | '+detail[-1400:],progress=0)

@PromptServer.instance.routes.post('/unwin/ai-upscale/cancel')
async def ai_cancel(request):
    data=await request.json()
    job=str(data.get('job',''))
    with LOCK:
        if job not in JOBS:return web.json_response({'error':'Unknown job'},status=404)
        JOBS[job]['cancel_requested']=True
        JOBS[job]['status']='Cancelling...'
    return web.json_response({'job':job,'cancel_requested':True})

@PromptServer.instance.routes.post('/unwin/ai-upscale/review')
async def ai_review(request):
    data=await request.json()
    job=str(data.get('job',''))
    decision=str(data.get('decision',''))
    if decision not in ('reject','tile:0','tile:256','tile:128','tile:lanczos','tile:cuda'):
        return web.json_response({'error':'Invalid review decision'},status=400)
    with LOCK:
        if job not in JOBS:return web.json_response({'error':'Unknown job'},status=404)
        if not JOBS[job].get('review_pending'):
            return web.json_response({'error':'No review pending'},status=409)
        JOBS[job]['review_decision']=decision
    return web.json_response({'job':job,'decision':decision})

@PromptServer.instance.routes.get('/unwin/ai-upscale/status')
async def ai_status(request):
    job=request.query.get('job','')
    if job:
        with LOCK: d=JOBS.get(job)
        if d is None:return web.json_response({'error':'Unknown job'},status=404)
        return web.json_response(d)
    exe=binary()
    return web.json_response(dict(validate_install(),version='1.1.7'))

def lanczos_worker(job, src, scale, review=True):
    """Independent FFmpeg Lanczos upscaler: no NCNN/Vulkan/Real-ESRGAN inference."""
    try:
        src=Path(src)
        dest=safe_output('unwin_lanczos_upscaled_'+job+'.mp4',False)
        preview_root=safe_output('unwin_lanczos_preview_'+job+'.png',False)
        original=safe_output('unwin_lanczos_original_'+job+'.png',False)
        scale_filter='scale=iw*%d:ih*%d:flags=lanczos,unsharp=5:5:0.35:5:5:0.0' % (scale,scale)
        update(job,status='Preparing Lanczos comparison',progress=5)
        run_ffmpeg(['-y','-i',str(src),'-frames:v','1',original])
        run_ffmpeg(['-y','-i',str(src),'-vf',scale_filter,'-frames:v','1',preview_root])
        if review:
            update(job,status='Review Lanczos output (no AI model used)',progress=10,
                review_pending=True,preview_original=original.name,
                preview_candidates=[{'tile':'lanczos','image':preview_root.name}])
            while True:
                if _cancelled(job):raise RuntimeError('Cancelled by user')
                with LOCK: decision=JOBS[job].get('review_decision')
                if decision=='reject':raise RuntimeError('Preview rejected; source video remains unchanged')
                if decision=='tile:lanczos':break
                time.sleep(.5)
            update(job,review_pending=False,review_decision='')
        update(job,status='Encoding Lanczos video (FFmpeg; no Vulkan)',progress=20)
        # Use subprocess directly to support cancellation and expose failures.
        tool=ffmpeg()
        cmd=[str(tool),'-hide_banner','-y','-i',str(src),'-vf',scale_filter,
             '-map','0:v:0','-map','0:a?','-c:v','libx264','-preset','medium',
             '-crf','17','-pix_fmt','yuv420p','-c:a','copy','-movflags','+faststart',str(dest)]
        proc=subprocess.Popen(cmd,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,
                              creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        # Drain stderr continuously to avoid the OS pipe-buffer deadlock.
        tail=[]
        def drain():
            for line in iter(proc.stderr.readline,b''):
                tail.append(line.decode('utf-8','replace').rstrip())
                if len(tail)>80:del tail[:40]
        threading.Thread(target=drain,daemon=True).start()
        while proc.poll() is None:
            if _cancelled(job):
                proc.kill();proc.wait();raise RuntimeError('Cancelled by user')
            update(job,status='Lanczos video encoding in progress',progress=60)
            time.sleep(.5)
        if proc.returncode:raise RuntimeError('FFmpeg encoding failed: '+' | '.join(tail[-8:]))
        if not dest.exists() or dest.stat().st_size==0:raise RuntimeError('No output video was created')
        update(job,status='Complete (Lanczos)',progress=100,output=dest.name)
    except Exception as e:
        update(job,status='Cancelled' if _cancelled(job) else 'Failed',error=str(e),progress=0)


def cuda_models():
    """Use ComfyUI's native upscale_models folder and supported loader."""
    try:
        import folder_paths
        return sorted(folder_paths.get_filename_list('upscale_models'))
    except Exception:
        return []

def cuda_worker(job, src, scale, model_name, review=True):
    """Native ComfyUI/PyTorch upscaling, with no NCNN/Vulkan dependency."""
    try:
        import numpy as np
        import torch
        from PIL import Image
        from comfy_extras.nodes_upscale_model import UpscaleModelLoader, ImageUpscaleWithModel
        src=Path(src)
        available=cuda_models()
        if model_name not in available:
            raise RuntimeError('Select an installed model from ComfyUI/models/upscale_models. Found: '+(', '.join(available) or 'none'))
        update(job,status='Loading CUDA upscale model',progress=2)
        loaded=UpscaleModelLoader().load_model(model_name)[0]
        upscaler=ImageUpscaleWithModel()
        with tempfile.TemporaryDirectory(prefix='unwin_cuda_') as tmp:
            base=Path(tmp);frames=base/'frames';enhanced=base/'enhanced'
            frames.mkdir();enhanced.mkdir()
            run_ffmpeg(['-i',str(src),'-map','0:v:0','-an','-sn','-dn',str(frames/'frame_%08d.png')])
            originals=sorted(frames.glob('frame_*.png'))
            if not originals:raise RuntimeError('No frames extracted')
            total=len(originals)
            original_preview=safe_output('unwin_cuda_original_'+job+'.png',False)
            output_preview=safe_output('unwin_cuda_preview_'+job+'.png',False)
            def enhance(path, destination):
                if _cancelled(job):raise RuntimeError('Cancelled by user')
                with Image.open(path) as im:
                    rgb=im.convert('RGB')
                    arr=np.asarray(rgb,dtype=np.float32)/255.0
                    width,height=rgb.size
                tensor=torch.from_numpy(arr).unsqueeze(0)
                with torch.inference_mode():
                    result=upscaler.upscale(loaded,tensor)[0]
                pixels=(result[0].detach().cpu().float().clamp(0,1).numpy()*255.0).round().astype(np.uint8)
                image=Image.fromarray(pixels,'RGB')
                # Native upscale models may output 4x; scale to the requested exact 2x or 4x.
                target=(width*scale,height*scale)
                if image.size!=target:image=image.resize(target,Image.Resampling.LANCZOS)
                image.save(destination,format='PNG')
                del tensor,result,pixels,image
            shutil.copy2(originals[0],original_preview)
            update(job,status='CUDA enhancing first frame',progress=5)
            enhance(originals[0],enhanced/originals[0].name)
            shutil.copy2(enhanced/originals[0].name,output_preview)
            if review:
                update(job,status='Review CUDA AI result before rendering remaining frames',
                       progress=10,review_pending=True,
                       preview_original=original_preview.name,
                       preview_candidates=[{'tile':'cuda','image':output_preview.name}])
                while True:
                    if _cancelled(job):raise RuntimeError('Cancelled by user')
                    with LOCK: decision=JOBS[job].get('review_decision')
                    if decision=='reject':raise RuntimeError('Preview rejected; original video unchanged')
                    if decision=='tile:cuda':break
                    time.sleep(.5)
                update(job,review_pending=False,review_decision='')
            start=time.monotonic()
            for idx,path in enumerate(originals[1:],2):
                enhance(path,enhanced/path.name)
                elapsed=max(.01,time.monotonic()-start)
                remaining=(total-idx)*elapsed/max(1,idx-1)
                update(job,status='CUDA AI enhancing frames: %d/%d'%(idx,total),
                       progress=min(89,10+int(idx/total*79)),eta_seconds=int(remaining))
            update(job,status='Encoding enhanced video with original audio',progress=92)
            probe=shutil.which('ffprobe')
            fps='24'
            if probe:
                result=subprocess.run([probe,'-v','error','-select_streams','v:0',
                    '-show_entries','stream=avg_frame_rate','-of',
                    'default=noprint_wrappers=1:nokey=1',str(src)],
                    capture_output=True,text=True)
                rate=result.stdout.strip()
                if rate and rate!='0/0':fps=rate
            dest=safe_output('unwin_cuda_upscaled_'+job+'.mp4',False)
            run_ffmpeg(['-framerate',fps,'-i',str(enhanced/'frame_%08d.png'),
                        '-i',str(src),'-map','0:v:0','-map','1:a?',
                        '-c:v','libx264','-preset','medium','-crf','17',
                        '-pix_fmt','yuv420p','-c:a','copy','-movflags','+faststart',
                        '-shortest',str(dest)])
            update(job,status='Complete (CUDA AI)',progress=100,output=dest.name)
    except Exception as exc:
        import traceback
        update(job,status='Cancelled' if _cancelled(job) else 'Failed',
               error=str(exc),traceback=traceback.format_exc()[-5000:],progress=0)

@PromptServer.instance.routes.get('/unwin/ai-upscale/models')
async def upscale_cuda_models(request):
    return web.json_response({'models':cuda_models(),'version':'1.1.7'})

@PromptServer.instance.routes.post('/unwin/ai-upscale/start')
async def ai_start(request):
    try:
        data=await request.json();src=safe_output(data.get('filename',''))
        if src.suffix.lower() not in ('.mp4','.mov','.mkv','.webm'):raise ValueError('Select a supported video')
        method=data.get('method','lanczos')
        if method not in ('lanczos','cuda'):raise ValueError('Invalid upscale method')
        
        model=data.get('model','realesrgan-x4plus')
        
        scale=int(data.get('scale',2))
        if scale not in (2,4):raise ValueError('Scale must be 2 or 4')
        review=bool(data.get('review',True))
        job=uuid.uuid4().hex[:12]
        with LOCK:JOBS[job]={'version':'1.1.7','job':job,'status':'Queued','progress':0,'output':'','error':'','cancel_requested':False,'started_at':time.monotonic()}
        threading.Thread(target=lanczos_worker if method=='lanczos' else cuda_worker,args=(job,src,scale,review) if method=='lanczos' else (job,src,scale,model,review),daemon=True).start()
        return web.json_response({'job':job})
    except Exception as e:return web.json_response({'error':str(e)},status=400)
