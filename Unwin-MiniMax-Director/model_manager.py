"""Allowlisted, local ComfyUI model downloads. Only user-triggered downloads use network."""
import hashlib
import json
import os
from pathlib import Path
import threading
import time
import urllib.request
import uuid

CATALOG = [
 ('fasth3_v2','FastH3 V2 · 8-step diffusion','fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors','diffusion_models','Comfy-Org/FastVideo-FastH3-Comfy','diffusion_models/fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors','FastH3 V2 distilled 8-step checkpoint. T2V and first/last-frame I2V only; uses the standard H3 encoder and VAEs. UK/EU/US/South Korea open-weight licensing restrictions apply.','fasth3'),
 ('h3_video_vae_int8','Video VAE · INT8','minimax_h3_video_vae_int8_convrot.safetensors','vae','Comfy-Org/MiniMax-H3','vae/minimax_h3_video_vae_int8_convrot.safetensors','INT8 video VAE used by official FastH3 workflow; shared with standard H3.','h3'),
 ('h3_official_turbo','Standard H3 · 8-step Turbo LoRA','minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors','loras','Comfy-Org/MiniMax-H3','loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors','Official FL2VA Turbo LoRA for standard H3, NOT FastH3 V2. Use matching base and 8 steps.','fl2va'),
 ('h3_fl2v_fp8','Diffusion','minimax_h3_fl2va_pruned_fp8_scaled.safetensors','diffusion_models','Comfy-Org/MiniMax-H3','diffusion_models/minimax_h3_fl2va_pruned_fp8_scaled.safetensors','MiniMax H3 FL2VA pruned FP8. Suitable as a lower-storage choice; VRAM not guaranteed.','fl2va'),
 ('h3_fl2v_int8','Diffusion','minimax_h3_fl2va_pruned_int8_convrot.safetensors','diffusion_models','Comfy-Org/MiniMax-H3','diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors','MiniMax H3 FL2VA pruned INT8; requires compatible PyTorch/CUDA environment.','fl2va'),
 ('h3_text_nvfp4','Text encoder','qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors','text_encoders','Comfy-Org/MiniMax-H3','text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors','Required H3-specific 32B Qwen3-VL encoder; not interchangeable with generic 4B encoder.','h3'),
 ('h3_text_int8','Text encoder','qwen3vl_32b_minimax_h3_int8_convrot.safetensors','text_encoders','Comfy-Org/MiniMax-H3','text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors','H3-specific 32B Qwen3-VL INT8; higher memory and storage requirements.','h3'),
 ('h3_video_vae','Video VAE','minimax_h3_video_vae_fp16.safetensors','vae','Comfy-Org/MiniMax-H3','vae/minimax_h3_video_vae_fp16.safetensors','MiniMax H3 video VAE.','h3'),
 ('h3_audio_vae','Audio VAE','minimax_h3_audio_vae_fp32.safetensors','vae','Comfy-Org/MiniMax-H3','vae/minimax_h3_audio_vae_fp32.safetensors','MiniMax H3 audio VAE.','h3'),
 ('h3_turbo_v4_ema','LoRA','minimax_h3_turbo_v4_step600_ema.safetensors','loras','larryvrh/MiniMax-H3-Turbo-Lora','minimax_h3_turbo_v4_step600_ema.safetensors','H3 Turbo v4 EMA; author recommends 6–8 steps; heavy motion at 4 steps may smear.','h3'),
 ('h3_turbo_v4','LoRA','minimax_h3_turbo_v4_step600.safetensors','loras','larryvrh/MiniMax-H3-Turbo-Lora','minimax_h3_turbo_v4_step600.safetensors','H3 Turbo v4 non-EMA; comparison variant.','h3'),
 ('h3_realism_people','LoRA','h3-realism-people-t2v-i2v-r2v.safetensors','loras','fal/MiniMax-H3-Realism-People-LoRA','h3-realism-people-t2v-i2v-r2v.safetensors','Human realism LoRA; trigger r34l1sm; start at 0.8 strength. Compatible H3 model loader required.','h3'),
 ('h3_semantic_bridge','Adapter','MiniMaxH3_SemanticBridge_v1.safetensors','semantic_bridge','speach1sdef178/MiniMax-H3-Semantic-Bridge','MiniMaxH3_SemanticBridge_v1.safetensors','Requires companion Semantic Bridge ComfyUI node; not a normal LoRA.','h3'),
 ('h3_lightx2v_4step','Turbo LoRA','minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy_resized_avg_rank_21_bf16.safetensors','loras','Kijai/MiniMax-H3_comfy','loras/minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy_resized_avg_rank_21_bf16.safetensors','ComfyUI-format LightX2V 4-step FL2VA; experimental; sampler and steps must match.','fl2va'),
 ('h3_vsa_lora','VSA LoRA','fasth3_vsa_v5.safetensors','loras','barelymining/ComfyUI-MiniMax-H3-FastVideo','fasth3_vsa_v5.safetensors','VSA experimental LoRA. Requires gate weights, custom node, pruned INT8 base; not standalone.','fl2va'),
 ('h3_vsa_gate','VSA Gate','fasth3_vsa_gate.safetensors','loras','barelymining/ComfyUI-MiniMax-H3-FastVideo','fasth3_vsa_gate.safetensors','FastVideo sparse-attention gate; requires companion custom node and VSA LoRA.','fl2va'),
]
REGISTRY = {x[0]:dict(id=x[0],category=x[1],filename=x[2],folder=x[3],repo=x[4],repo_path=x[5],description=x[6],family=x[7],url=f'https://huggingface.co/{x[4]}/resolve/main/{x[5]}') for x in CATALOG}
# SHA-256 published on the Hugging Face file page for this exact model.
REGISTRY['h3_turbo_v4']['sha256']='6c280b58f03b5dc89e791347679b821b8a85615bedae04d3c65bbbe753e07ce8'
_jobs={};_lock=threading.Lock()

def _path(item):
    import folder_paths
    if item['folder']=='semantic_bridge':
        root=Path(folder_paths.models_dir)/'semantic_bridge'
        return root/item['filename']
    existing=folder_paths.get_full_path(item['folder'],item['filename'])
    if existing and Path(existing).is_file():return Path(existing)
    roots=folder_paths.get_folder_paths(item['folder'])
    if not roots:raise RuntimeError('No ComfyUI model folder: '+item['folder'])
    root=Path(roots[0]).resolve();p=(root/item['filename']).resolve()
    if p.parent!=root:raise ValueError('Invalid model path')
    return p

def catalog():
    result=[]
    for item in REGISTRY.values():
        x=dict(item)
        try:
            p=_path(item);x['installed']=p.is_file();x['size_bytes']=p.stat().st_size if p.is_file() else 0
            x['location']=str(p)
        except Exception as e:x['installed']=False;x['error']=str(e)
        x['verification']='sha256 available' if item.get('sha256') else 'size and safetensors header (SHA-256 not published in registry)'
        result.append(x)
    return result

def _header_check(path):
    with open(path,'rb') as f:
        n=int.from_bytes(f.read(8),'little')
        if not 2<n<100_000_000:raise ValueError('Invalid safetensors header size')
        h=json.loads(f.read(n))
        if not isinstance(h,dict) or not any(k!='__metadata__' for k in h):raise ValueError('Invalid safetensors metadata')

def verify(model_id, full_hash=False):
    item=REGISTRY[model_id];p=_path(item)
    if not p.is_file():return {'installed':False,'valid':False,'reason':'File missing'}
    _header_check(p)
    sha=None
    if full_hash and item.get('sha256'):
        digest=hashlib.sha256()
        with open(p,'rb') as f:
            for chunk in iter(lambda:f.read(4*1024*1024),b''):digest.update(chunk)
        sha=digest.hexdigest()
        if sha!=item['sha256']:raise ValueError('SHA-256 checksum mismatch')
    return {'installed':True,'valid':True,'size_bytes':p.stat().st_size,'sha256':sha,'hash_verified':bool(sha),'path':str(p)}

def _run(job_id,model_id):
    job=_jobs[job_id];item=REGISTRY[model_id];part=None
    try:
        dest=_path(item);dest.parent.mkdir(parents=True,exist_ok=True)
        if dest.exists():raise FileExistsError('Model already installed; verify instead')
        part=dest.with_name(dest.name+'.unwin-download-'+job_id+'.part')
        req=urllib.request.Request(item['url'],headers={'User-Agent':'Unwin-MiniMax-Director/1.0'})
        with urllib.request.urlopen(req,timeout=45) as response,open(part,'wb') as out:
            final_url=response.geturl()
            if not final_url.startswith('https://'):raise RuntimeError('Download redirected outside HTTPS')
            total=int(response.headers.get('Content-Length') or 0)
            job.update(status='downloading',total=total)
            while True:
                data=response.read(1024*1024)
                if not data:break
                out.write(data);job['downloaded']+=len(data)
        job['status']='verifying';_header_check(part)
        if item.get('sha256'):
            digest=hashlib.sha256()
            with open(part,'rb') as f:
                for chunk in iter(lambda:f.read(4*1024*1024),b''):digest.update(chunk)
            if digest.hexdigest()!=item['sha256']:raise ValueError('SHA-256 mismatch; refusing installation')
            job['hash_verified']=True
        if dest.exists():raise FileExistsError('Destination appeared during download')
        os.replace(part,dest);job['status']='installed'
    except Exception as e:job.update(status='failed',error=str(e))
    finally:
        if part and part.exists():part.unlink(missing_ok=True)

def start(model_id):
    if model_id not in REGISTRY:raise ValueError('Model is not in verified-source registry')
    if _path(REGISTRY[model_id]).exists():raise FileExistsError('Already installed')
    with _lock:
        if any(x['model_id']==model_id and x['status'] in ('queued','downloading','verifying') for x in _jobs.values()):raise RuntimeError('Download already running')
        jid=uuid.uuid4().hex[:12];_jobs[jid]=dict(id=jid,model_id=model_id,status='queued',downloaded=0,total=0,error='',hash_verified=False,started=time.time())
    threading.Thread(target=_run,args=(jid,model_id),daemon=True).start()
    return dict(_jobs[jid])

def jobs():return list(_jobs.values())[-30:]
