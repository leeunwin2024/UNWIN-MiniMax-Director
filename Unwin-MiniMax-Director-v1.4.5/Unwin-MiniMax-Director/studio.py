"""Local Character/Location Studio asset storage and safe Real-ESRGAN image upscale."""
import base64, io, json, re, threading, uuid, subprocess
from pathlib import Path
from aiohttp import web
from server import PromptServer
from .ai_upscale import binary, JOBS, LOCK, update
from .nodes import safe_output, bounded_path

ASSETS = Path(__file__).resolve().parent/'studio_assets'
ASSETS.mkdir(exist_ok=True)
MAX_IMAGE = 18 * 1024 * 1024

def clean_name(s):
    return re.sub(r'[^a-zA-Z0-9_-]+','_',str(s or 'asset'))[:64] or 'asset'

@PromptServer.instance.routes.post('/unwin/studio/reference')
async def reference(request):
    try:
        d=await request.json(); kind=d.get('kind')
        if kind not in ('character','location'):raise ValueError('Invalid asset type')
        raw=d.get('image',''); prefix,sep,data=raw.partition(',')
        if not sep or not prefix.startswith('data:image/') or len(data)>MAX_IMAGE*2:raise ValueError('Upload a JPG or PNG under 18MB')
        blob=base64.b64decode(data,validate=True)
        if len(blob)>MAX_IMAGE:raise ValueError('Image too large')
        from PIL import Image,ImageOps,ImageDraw
        im=Image.open(io.BytesIO(blob)); im.verify()
        im=Image.open(io.BytesIO(blob));im=ImageOps.exif_transpose(im).convert('RGB')
        if im.width*im.height>35_000_000:raise ValueError('Image dimensions too large')
        uid=uuid.uuid4().hex[:10];stem=f'{kind}_{clean_name(d.get("name"))}_{uid}'
        source=ASSETS/(stem+'_reference.png');im.save(source,optimize=True)
        # A contact sheet is explicitly a reference layout, NOT generated new viewpoints.
        w,h=360,480;sheet=Image.new('RGB',(w*3,h*2),(27,31,38));draw=ImageDraw.Draw(sheet)
        labels=(['Face reference','Upper-body reference','Full-body reference','Side view needed','Rear view needed','Outfit details'] if kind=='character' else ['Location reference','Wide establishing','Architectural details','Alternative angle needed','Lighting variation needed','Scene details'])
        for i,label in enumerate(labels):
            x=(i%3)*w;y=(i//3)*h
            if i<3:
                crop=ImageOps.fit(im,(w-20,h-65),method=Image.Resampling.LANCZOS)
                sheet.paste(crop,(x+10,y+35))
            else:
                draw.rectangle((x+10,y+35,x+w-10,y+h-30),outline=(110,125,140),width=2)
                draw.text((x+28,y+h//2),'Requires image generation',fill=(205,213,225))
            draw.text((x+12,y+12),label,fill='white')
        contact=ASSETS/(stem+'_sheet.png');sheet.save(contact)
        return web.json_response({'ok':True,'reference':source.name,'sheet':contact.name,'note':'Reference contact sheet only. New angles require a compatible image-edit workflow.'})
    except Exception as e:return web.json_response({'error':str(e)},status=400)

@PromptServer.instance.routes.get('/unwin/studio/image/{name}')
async def asset(request):
    name=request.match_info['name']
    if not re.fullmatch(r'(character|location)_[A-Za-z0-9_-]+_(reference|sheet|upscaled)\.png',name):raise web.HTTPBadRequest()
    path=bounded_path(ASSETS, name, must_exist=False)
    if not path.is_file():raise web.HTTPNotFound()
    return web.FileResponse(path,headers={'Cache-Control':'no-store'})

def image_worker(job,src,scale):
    try:
        exe=binary()
        if not exe:raise RuntimeError('Real-ESRGAN executable missing; install into tools folder')
        dest=ASSETS/(src.stem+'_upscaled.png')
        update(job,status='Enhancing reference image',progress=15)
        cmd=[exe,'-i',str(src),'-o',str(dest),'-n','realesrgan-x4plus','-s',str(scale),'-f','png','-t','128']
        p=subprocess.run(cmd,capture_output=True,text=True,timeout=900,cwd=str(Path(exe).parent),shell=False)
        if p.returncode or not dest.exists():raise RuntimeError((p.stderr or p.stdout or 'Upscale failed')[-1400:])
        update(job,status='Complete',progress=100,output=dest.name)
    except Exception as e:update(job,status='Failed',error=str(e),progress=0)

@PromptServer.instance.routes.post('/unwin/studio/upscale')
async def upscale(request):
    try:
        d=await request.json();name=d.get('filename','')
        if not re.fullmatch(r'(character|location)_[A-Za-z0-9_-]+_(reference|sheet)\.png',name):raise ValueError('Invalid studio asset')
        src=bounded_path(ASSETS, name, must_exist=False)
        if not src.is_file():raise ValueError('Reference image missing')
        if not binary():raise RuntimeError('Install Real-ESRGAN portable Windows engine first')
        scale=int(d.get('scale',2))
        if scale not in (2,4):raise ValueError('Scale must be 2 or 4')
        job=uuid.uuid4().hex[:12]
        with LOCK:JOBS[job]={'job':job,'status':'Queued','progress':0,'output':'','error':''}
        threading.Thread(target=image_worker,args=(job,src,scale),daemon=True).start()
        return web.json_response({'job':job})
    except Exception as e:return web.json_response({'error':str(e)},status=400)

@PromptServer.instance.routes.get('/unwin/studio/models')
async def image_models(request):
    import folder_paths
    specs=[
        ('Qwen Image Edit 2509 FP8','diffusion_models','qwen_image_edit_2509_fp8_e4m3fn.safetensors','Qwen image-edit workflow; needs Qwen 2.5 VL 7B and Qwen Image VAE.'),
        ('Qwen 2.5 VL 7B text encoder','text_encoders','qwen_2.5_vl_7b_fp8_scaled.safetensors','For Qwen Image Edit, NOT the MiniMax H3 text encoder.'),
        ('Qwen Image VAE','vae','qwen_image_vae.safetensors','For Qwen Image Edit.'),
        ('Z-Image Turbo','diffusion_models','z_image_turbo_bf16.safetensors','Fast text-to-image locations; not reference-angle generation.'),
        ('Z-Image text encoder','text_encoders','qwen_3_4b.safetensors','For Z-Image Turbo.'),
        ('Z-Image VAE','vae','ae.safetensors','Flux AE; Z-Image-compatible VAE.'),
    ]
    out=[]
    for label,folder,filename,notes in specs:
        try:found=folder_paths.get_full_path(folder,filename);installed=bool(found and Path(found).is_file())
        except Exception:installed=False
        out.append({'label':label,'folder':folder,'filename':filename,'installed':installed,'notes':notes})
    return web.json_response(out)


# Local ComfyUI workflow bridge: imported API-format workflows execute through
# ComfyUI's own /prompt queue, never an external inference API.
@PromptServer.instance.routes.post('/unwin/studio/prepare-input')
async def prepare_input(request):
    try:
        import folder_paths
        from PIL import Image
        d=await request.json();name=d.get('filename','')
        if not re.fullmatch(r'(character|location)_[A-Za-z0-9_-]+_(reference|sheet|upscaled)\.png',name):raise ValueError('Invalid studio reference')
        src=bounded_path(ASSETS, name, must_exist=False)
        if not src.is_file():raise ValueError('Reference image missing')
        dest=Path(folder_paths.get_input_directory())/('unwin_'+uuid.uuid4().hex[:12]+'.png')
        with Image.open(src) as im: im.convert('RGB').save(dest)
        return web.json_response({'filename':dest.name})
    except Exception as e:return web.json_response({'error':str(e)},status=400)

@PromptServer.instance.routes.post('/unwin/studio/compose-sheet')
async def compose_sheet(request):
    try:
        import folder_paths
        from PIL import Image, ImageOps, ImageDraw
        d=await request.json();items=d.get('images',[])
        if not isinstance(items,list) or not 1<=len(items)<=8:raise ValueError('Supply 1–8 generated images')
        kind=d.get('kind','character')
        if kind not in ('character','location'):raise ValueError('Invalid asset type')
        labels=d.get('labels',[])
        if not isinstance(labels,list):labels=[]
        w,h=480,600;cols=2;rows=(len(items)+1)//2
        canvas=Image.new('RGB',(w*cols,h*rows),(24,28,35));draw=ImageDraw.Draw(canvas)
        base=Path(folder_paths.get_output_directory()).resolve()
        for i,item in enumerate(items):
            filename=item.get('filename','');sub=item.get('subfolder','')
            if not isinstance(filename,str) or not isinstance(sub,str) or '/' in filename or '\\' in filename:raise ValueError('Invalid generated filename')
            path=bounded_path(base, str(Path(sub)/filename), must_exist=False)
            if not path.is_relative_to(base) or not path.is_file() or path.suffix.lower() not in ('.png','.jpg','.jpeg','.webp'):raise ValueError('Generated image missing or unsafe')
            with Image.open(path) as im:thumb=ImageOps.contain(im.convert('RGB'),(w-16,h-50))
            x=(i%cols)*w;y=(i//cols)*h
            canvas.paste(thumb,(x+(w-thumb.width)//2,y+35+(h-50-thumb.height)//2))
            draw.text((x+12,y+10),str(labels[i] if i<len(labels) else f'View {i+1}')[:55],fill='white')
        name=f'{kind}_{clean_name(d.get("name"))}_{uuid.uuid4().hex[:10]}_sheet.png'
        canvas.save(ASSETS/name)
        return web.json_response({'sheet':name})
    except Exception as e:return web.json_response({'error':str(e)},status=400)

@PromptServer.instance.routes.get('/unwin/studio/available-models')
async def studio_available_models(request):
    import folder_paths
    result={}
    for category in ('diffusion_models','text_encoders','vae'):
        try: result[category]=folder_paths.get_filename_list(category)
        except Exception: result[category]=[]
    return web.json_response(result)


@PromptServer.instance.routes.post('/unwin/studio/store-output')
async def unwin_store_generated_output(request):
    """Copy one ComfyUI-generated image into managed studio assets for persistent project references."""
    try:
        from PIL import Image
        import folder_paths, uuid
        data=await request.json()
        filename=str(data.get('filename',''))
        subfolder=str(data.get('subfolder',''))
        if not re.fullmatch(r'[A-Za-z0-9_. -]+\.(png|jpg|jpeg|webp)',filename,re.I):raise ValueError('Invalid image filename')
        if subfolder and (Path(subfolder).is_absolute() or '..' in Path(subfolder).parts):raise ValueError('Invalid subfolder')
        kind=str(data.get('type','output'))
        if kind!='output':raise ValueError('Only output images are accepted')
        root=Path(folder_paths.get_output_directory()).resolve()
        source=(root/subfolder/filename).resolve()
        if not source.is_relative_to(root) or not source.is_file():raise ValueError('Generated image not found in output directory')
        ASSETS.mkdir(parents=True,exist_ok=True)
        target=ASSETS/('character_'+uuid.uuid4().hex[:16]+'_reference.png')
        with Image.open(source) as im:
            if im.width*im.height>30000000:raise ValueError('Image too large')
            im.convert('RGB').save(target,'PNG')
        return web.json_response({'reference':target.name})
    except Exception as exc:
        return web.json_response({'error':str(exc)},status=400)
