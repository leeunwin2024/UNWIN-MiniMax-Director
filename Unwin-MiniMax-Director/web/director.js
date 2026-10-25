import { app } from '../../scripts/app.js';

const initial=()=>({width:1024,height:576,shots:[{name:'Scene 1',prompt:'A cinematic opening shot, dramatic lighting',seconds:5,mode:'t2v',carry:true,seed:1,status:'pending',output:''}]});
let state=initial(), nodeRef=null, panel=null, busy=false, selected=0, log=[];
let batchStopRequested=false, batchActive=false, batchCompleted=0, batchTotal=0;
let terminal=null, terminalHidden=false, currentPrompt=null, socket=null, renderStarted=0, lastProgress='Waiting for render', lastNode='—';
const $=(s,root=document)=>root.querySelector(s);
const sleep=t=>new Promise(r=>setTimeout(r,t));
const logLine=s=>{log.push(new Date().toLocaleTimeString()+' '+s);log=log.slice(-300);if(panel){const el=$('#unwin-log',panel);if(el)el.textContent=log.join('\n');}updateTerminal();};
function openTerminal(){
 if(terminal){terminal.style.display='flex';terminalHidden=false;updateTerminal();return;}
 terminal=document.createElement('div');terminal.id='unwin-floating-terminal';
 terminal.innerHTML=`<style>#unwin-floating-terminal{position:fixed;z-index:100001;right:22px;bottom:22px;width:min(590px,90vw);height:330px;display:flex;flex-direction:column;background:#10141b;color:#d9e8ef;border:1px solid #6687a2;border-radius:10px;box-shadow:0 12px 38px #000a;font:12px Consolas,monospace;overflow:hidden}#unwin-floating-terminal .ut-head{display:flex;align-items:center;gap:9px;background:#26384b;padding:9px;cursor:move;user-select:none}#unwin-floating-terminal button{cursor:pointer;background:#354b62;color:white;border:1px solid #637b92;border-radius:5px;padding:4px 9px}#unwin-floating-terminal .ut-stats{padding:8px 12px;white-space:pre-wrap;border-bottom:1px solid #34475a}#unwin-floating-terminal .ut-progress{height:8px;background:#25303e;margin:4px 12px;border-radius:5px;overflow:hidden}#unwin-floating-terminal .ut-bar{height:100%;width:0;background:#4cb7b4;transition:width .2s}#unwin-floating-terminal pre{flex:1;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:8px 12px;margin:0;color:#c5e5d2}</style><div class="ut-head"><strong>UNWIN · LIVE RENDER TERMINAL</strong><span style="flex:1"></span><button data-ut="copy">Copy log</button><button data-ut="min">_</button><button data-ut="close">✕</button></div><div class="ut-stats"></div><div class="ut-progress"><div class="ut-bar"></div></div><pre></pre>`;
 document.body.appendChild(terminal);
 terminal.querySelector('[data-ut="copy"]').onclick=()=>navigator.clipboard?.writeText(log.join('\n'));
 terminal.querySelector('[data-ut="close"]').onclick=()=>{terminal.remove();terminal=null;terminalHidden=true;};
 terminal.querySelector('[data-ut="min"]').onclick=()=>{const pre=terminal.querySelector('pre');pre.hidden=!pre.hidden;terminal.style.height=pre.hidden?'110px':'330px';};
 const head=terminal.querySelector('.ut-head');let drag=null;
 head.addEventListener('pointerdown',e=>{if(e.target.closest('button'))return;const r=terminal.getBoundingClientRect();drag={x:e.clientX-r.left,y:e.clientY-r.top};head.setPointerCapture(e.pointerId)});
 head.addEventListener('pointermove',e=>{if(!drag)return;terminal.style.left=Math.max(0,Math.min(innerWidth-120,e.clientX-drag.x))+'px';terminal.style.top=Math.max(0,Math.min(innerHeight-60,e.clientY-drag.y))+'px';terminal.style.right='auto';terminal.style.bottom='auto'});
 head.addEventListener('pointerup',()=>drag=null);
 updateTerminal();
}
function updateTerminal(percent=null){if(!terminal)return;const elapsed=renderStarted?Math.floor((Date.now()-renderStarted)/1000):0;terminal.querySelector('.ut-stats').textContent=`Scene: ${currentPrompt?.scene||'—'}  |  Node: ${lastNode}  |  Elapsed: ${Math.floor(elapsed/60)}m ${elapsed%60}s\n${lastProgress}  |  Prompt: ${currentPrompt?.id||'—'}`;if(percent!==null)terminal.querySelector('.ut-bar').style.width=Math.max(0,Math.min(100,percent))+'%';const pre=terminal.querySelector('pre');const atBottom=pre.scrollHeight-pre.scrollTop-pre.clientHeight<45;pre.textContent=log.join('\n');if(atBottom)pre.scrollTop=pre.scrollHeight;}
function connectRenderEvents(clientId,promptId,scene){
 if(socket){socket.close();socket=null;}currentPrompt={id:promptId,scene};renderStarted=Date.now();lastProgress='Queued / awaiting execution';lastNode='—';updateTerminal(0);
 try{const protocol=location.protocol==='https:'?'wss:':'ws:';socket=new WebSocket(`${protocol}//${location.host}/ws?clientId=${encodeURIComponent(clientId)}`);
 socket.onopen=()=>logLine('Live ComfyUI progress connected');
 socket.onmessage=e=>{if(typeof e.data!=='string')return;let msg;try{msg=JSON.parse(e.data)}catch{return}const d=msg.data||{};if(d.prompt_id&&d.prompt_id!==promptId)return;
 if(msg.type==='executing'){lastNode=d.node===null?'Finalising output':String(d.node);lastProgress=d.node===null?'Execution finished; finding saved video':'Executing graph node '+d.node;updateTerminal();}
 if(msg.type==='progress'){const v=Number(d.value),m=Number(d.max);if(m>0){lastProgress=`Sampling ${v}/${m} (${Math.round(v/m*100)}%)`;updateTerminal(v/m*100)}}
 if(msg.type==='progress_state'){const nodes=d.nodes||{};for(const [id,item] of Object.entries(nodes)){const v=Number(item.value),m=Number(item.max);if(m>0){lastNode=id;lastProgress=`Sampling ${v}/${m} (${Math.round(v/m*100)}%)`;updateTerminal(v/m*100)}}}
 if(msg.type==='execution_error'){logLine('ComfyUI reported execution error: '+String(d.exception_message||d.node_type||'unknown').slice(0,400));lastProgress='Execution failed';updateTerminal()}
 if(msg.type==='execution_interrupted'){lastProgress='Execution interrupted';logLine('ComfyUI execution interrupted')}
 };
 socket.onerror=()=>logLine('Live progress socket unavailable; render history polling continues');
 socket.onclose=()=>{socket=null;updateTerminal()};
 }catch(e){logLine('Live progress unavailable: '+e.message)}
}
async function api(url,options){
 const r=await fetch(url,options);
 const raw=await r.text();
 let j;
 try{j=JSON.parse(raw)}catch{
   throw Error('HTTP '+r.status+' from '+url+': '+raw.slice(0,500));
 }
 if(!r.ok)throw Error('HTTP '+r.status+' '+url+': '+(j.error||j.message||JSON.stringify(j)).slice(0,1200));
 return j;
}
const post=(url,data)=>api(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function openAIUpscale(){
 let info;try{info=await api('/unwin/ai-upscale/status')}catch(e){logLine('AI upscale: '+e.message);return}
 const old=document.getElementById('unwin-ai-dialog');if(old)old.remove();
 const d=document.createElement('div');d.id='unwin-ai-dialog';d.style.cssText='position:fixed;z-index:100005;top:12%;left:calc(50% - 260px);width:760px;max-width:95vw;background:#19232f;color:white;padding:20px;border:1px solid #74879d;border-radius:10px;box-shadow:0 10px 60px #000b;font:13px Arial';
 const options=[...(state.shots||[]).filter(x=>x.output).map(x=>({name:x.name,output:x.output}))];if(state.lastStitched)options.unshift({name:'Final stitched project',output:state.lastStitched});
 d.innerHTML=`<h3>Video Upscale · Lanczos / CUDA AI</h3><p id="unwin-upscale-info">Lanczos works without models. CUDA AI uses installed ComfyUI upscale models (no Real-ESRGAN Vulkan).</p><label>Source video</label><select id="unwin-ai-source" style="width:100%;padding:7px">${options.map((x,i)=>`<option value="${i}">${esc(x.name)} — ${esc(x.output)}</option>`).join('')}</select><p>Method <select id="unwin-ai-method"><option value="lanczos">FFmpeg Lanczos — reliable (not AI)</option><option value="cuda">CUDA AI — native ComfyUI upscale model</option></select> Scale <select id="unwin-ai-scale"><option value="2">2×</option><option value="4">4×</option></select></p><p id="unwin-cuda-options" style="display:none">CUDA model <select id="unwin-ai-model"></select> <button id="unwin-refresh-models">Refresh models</button><small style="display:block">Install a compatible .pth or .safetensors upscale model into ComfyUI/models/upscale_models and restart/refresh models.</small></p><label><input type="checkbox" id="unwin-ai-review" checked style="width:auto"> Review first upscaled frame before rendering the rest</label><div id="unwin-ai-preview" style="display:none;padding:10px;background:#121922;border:1px solid #53647a;border-radius:8px;margin:8px 0"><strong>Compare original and enhanced frames</strong><div id="unwin-ai-compare" style="display:flex;gap:8px;margin-top:8px"></div><p id="unwin-ai-tile-choices"></p><p><button id="unwin-ai-reject">Reject — stop</button></p></div><p id="unwin-ai-status">Ready</p><progress id="unwin-ai-progress" value="0" max="100" style="width:100%"></progress><p><button id="unwin-ai-start" ${!options.length?'disabled':''}>Start Upscale</button> <button id="unwin-ai-close">Close</button></p><small>Source video is preserved. CUDA AI uses PyTorch and ComfyUI's model loader; audio is copied into the output.</small>`;
 document.body.appendChild(d);d.querySelector('#unwin-ai-close').onclick=()=>d.remove();
 const methodSelect=d.querySelector('#unwin-ai-method');
 const modelSelect=d.querySelector('#unwin-ai-model');
 const modelBox=d.querySelector('#unwin-cuda-options');
 const infoBox=d.querySelector('#unwin-upscale-info');
 const refreshModels=async()=>{try{const result=await api('/unwin/ai-upscale/models');modelSelect.innerHTML=(result.models||[]).map(name=>`<option value="${esc(name)}">${esc(name)}</option>`).join('');infoBox.textContent=result.models?.length?`${result.models.length} CUDA-compatible upscale model file(s) available.`:'No upscale models found. Add a compatible model to ComfyUI/models/upscale_models for CUDA AI, or choose Lanczos.';}catch(e){infoBox.textContent='Could not list CUDA models: '+e.message}};
 methodSelect.onchange=()=>{modelBox.style.display=methodSelect.value==='cuda'?'block':'none';if(methodSelect.value==='cuda')refreshModels()};
 d.querySelector('#unwin-refresh-models').onclick=refreshModels;
 const cancelAI=document.createElement('button');cancelAI.textContent='Cancel Upscale';cancelAI.style.marginLeft='8px';cancelAI.onclick=async()=>{if(!d.dataset.aiJob)return;try{await post('/unwin/ai-upscale/cancel',{job:d.dataset.aiJob});logLine('AI upscale cancellation requested')}catch(e){logLine('Cancel upscale: '+e.message)}};d.querySelector('#unwin-ai-start').insertAdjacentElement('afterend',cancelAI);
 d.querySelector('#unwin-ai-start').onclick=async()=>{const idx=Number(d.querySelector('#unwin-ai-source').value);const item=options[idx];if(!item)return;d.querySelector('#unwin-ai-start').disabled=true;try{const start=await post('/unwin/ai-upscale/start',{filename:item.output,method:d.querySelector('#unwin-ai-method').value,model:d.querySelector('#unwin-ai-model').value,scale:Number(d.querySelector('#unwin-ai-scale').value),review:d.querySelector('#unwin-ai-review').checked});logLine('AI upscale started: '+start.job);d.dataset.aiJob=start.job;for(;;){const r=await api('/unwin/ai-upscale/status?job='+encodeURIComponent(start.job));if(!d.isConnected)break;d.querySelector('#unwin-ai-status').textContent=r.status+(r.eta_seconds!=null?' · ETA '+Math.ceil(r.eta_seconds/60)+' min':'')+(r.error?' — '+r.error:'');d.querySelector('#unwin-ai-progress').value=r.progress||0;
const preview=d.querySelector('#unwin-ai-preview');
if(r.review_pending){
 preview.style.display='block';
 const comparison=d.querySelector('#unwin-ai-compare');
 if(comparison.dataset.job!==start.job){
  comparison.dataset.job=start.job;
  const makePreview=(path,label)=>{const parts=path.split('/');const name=parts.pop();const url='/view?filename='+encodeURIComponent(name)+'&subfolder='+encodeURIComponent(parts.join('/'))+'&type=output';return '<div style="flex:1;min-width:0"><div>'+label+'</div><a href="'+url+'" target="_blank"><img style="width:100%;object-fit:contain;max-height:230px" src="'+url+'"></a></div>'};
  comparison.innerHTML=makePreview(r.preview_original,'Original');
  const choices=d.querySelector('#unwin-ai-tile-choices');
  choices.innerHTML='';
  for(const candidate of (r.preview_candidates||[])){
    comparison.innerHTML+=makePreview(candidate.image,candidate.tile==='cuda'?'CUDA AI · inspect full size':candidate.tile==='lanczos'?'Lanczos · inspect full size':'Tile '+candidate.tile+' · inspect full size');
    const button=document.createElement('button');
    button.textContent=candidate.tile==='lanczos'?'Approve Lanczos — render video':candidate.tile==='cuda'?'Approve CUDA AI — render video':'Use tile '+candidate.tile+' — render video';
    button.style.margin='4px';
    button.onclick=async()=>{try{await post('/unwin/ai-upscale/review',{job:start.job,decision:'tile:'+candidate.tile});preview.style.display='none'}catch(e){logLine('Tile selection: '+e.message)}};
    choices.appendChild(button);
  }
  if(!r.preview_candidates?.length)choices.textContent='No usable diagnostic frames. Reject this upscale.';
  d.querySelector('#unwin-ai-reject').onclick=async()=>{try{await post('/unwin/ai-upscale/review',{job:start.job,decision:'reject'});preview.style.display='none'}catch(e){logLine('Preview rejection: '+e.message)}};
 }
}else preview.style.display='none';
if(r.output){state.lastAIUpscaled=r.output;save();logLine('AI upscale complete: '+r.output);break}if(r.error){logLine('AI upscale failed: '+r.error);break}await sleep(1500)}}catch(e){logLine('AI upscale: '+e.message);if(d.isConnected)d.querySelector('#unwin-ai-status').textContent=e.message}finally{if(d.isConnected)d.querySelector('#unwin-ai-start').disabled=false}};
}

function save(){if(nodeRef){nodeRef.properties.unwin=JSON.stringify(state);nodeRef.setDirtyCanvas(true,true);}}
function draw(){if(!panel)return;const wasMinimized=panel.classList.contains('minimized');const shot=state.shots[selected]||state.shots[0];panel.innerHTML=`<style>
#unwin-panel{position:fixed;z-index:9999;inset:5vh 4vw;background:#15191f;color:#e8edf5;border:1px solid #657187;border-radius:13px;display:flex;flex-direction:column;font:13px Arial;box-shadow:0 12px 70px #000b}#unwin-panel *{box-sizing:border-box}#unwin-panel button,#unwin-panel select,#unwin-panel input,#unwin-panel textarea{background:#252e39;color:#f0f3f8;border:1px solid #445062;border-radius:5px;padding:7px}#unwin-panel button{cursor:pointer}#unwin-panel button:hover{background:#3b5068}#unwin-panel .top{padding:13px 16px;display:flex;gap:10px;align-items:center;border-bottom:1px solid #343f4d}#unwin-panel .main{display:grid;grid-template-columns:220px minmax(300px,1fr) 290px;gap:12px;padding:12px;overflow:auto;flex:1}#unwin-panel .side{overflow:auto}#unwin-panel .shot{display:block;width:100%;text-align:left;margin-bottom:7px;padding:12px}#unwin-panel .active{border-color:#bca58e;background:#3c3531}#unwin-panel label{display:block;color:#b7c3d3;margin:9px 0 4px}#unwin-panel textarea{width:100%;height:170px;resize:vertical}#unwin-panel input,#unwin-panel select{width:100%}#unwin-panel .buttons{display:flex;gap:6px;flex-wrap:wrap}#unwin-panel .buttons button{flex:1}#unwin-panel pre{white-space:pre-wrap;background:#080b10;padding:9px;min-height:130px;max-height:290px;overflow:auto;font-size:11px}#unwin-panel .preview{width:100%;background:#080b10;min-height:120px;max-height:220px}#unwin-panel h3{margin:4px 0 10px}
#unwin-panel.minimized{inset:auto auto 15px 15px;width:330px;height:auto;max-height:55px;overflow:hidden}#unwin-panel.minimized .main{display:none}#unwin-panel .strip{display:flex;gap:8px;overflow-x:auto;padding:8px 0}#unwin-panel .tile{min-width:175px;max-width:175px;background:#202936;border:1px solid #475363;border-radius:7px;padding:6px;cursor:pointer}#unwin-panel .tile.active{border-color:#f5c18b}#unwin-panel .tile video{width:100%;height:94px;background:#090b10;object-fit:contain}#unwin-panel .tile small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#unwin-panel .modelstatus{white-space:pre-wrap;font:11px monospace;background:#10151c;padding:8px;max-height:145px;overflow:auto}</style><div class="top"><strong>UNWIN MINIMAX DIRECTOR v1.4.2</strong><span>Local timeline / frame continuity / stitching</span><span style="flex:1"></span><button data-act="save-project">Save Project As</button><button data-act="project-backups">Saved Projects / Backups</button><button data-act="load-project">Load Project</button><button id="unwin-open-model-manager" type="button">Model Manager</button><button data-act="terminal">Live Terminal</button><button data-act="ai-upscale">AI Video Upscale</button><button data-act="minimize">_ Minimise</button><button data-act="close">✕</button></div><div class="main"><div class="side"><h3>Timeline (${state.shots.length})</h3><div id="unwin-shots">${state.shots.map((s,i)=>`<button class="shot ${selected===i?'active':''}" data-shot="${i}"><b>${i+1}. ${esc(s.name)}</b><div>${s.seconds}s · ${esc(s.status||'pending')}</div></button>`).join('')}</div><div class="buttons"><button data-act="add">+ Scene</button><button data-act="duplicate">Duplicate</button></div><div class="buttons"><button data-act="render-project" ${busy?'disabled':''}>▶ Render ALL scenes</button><button data-act="stop-batch" ${!batchActive?'disabled':''}>Stop after scene</button></div><label><input type="checkbox" id="unwin-skip-completed" style="width:auto" ${state.skipCompleted!==false?'checked':''}> Skip already rendered scenes</label><div class="modelstatus" id="unwin-batch-status">${batchActive?`Rendering batch: ${batchCompleted}/${batchTotal} completed`:'Batch idle · sequential rendering preserves last-frame continuity'}</div><div class="buttons"><button data-act="up">↑</button><button data-act="down">↓</button><button data-act="delete">Delete</button></div></div><div class="side"><h3>Rendered scene timeline</h3><div class="strip">${state.shots.map((s,i)=>`<div class="tile ${selected===i?'active':''}" data-shot="${i}">${s.output?`<video controls preload="metadata" src="/view?filename=${encodeURIComponent(s.output.split('/').pop())}&subfolder=${encodeURIComponent(s.output.split('/').slice(0,-1).join('/'))}&type=output"></video>`:'<div style="height:94px;text-align:center;padding-top:30px">Awaiting render</div>'}<small>${i+1}. ${esc(s.name)} · ${esc(s.status)}</small></div>`).join('')}</div><h3>Scene editor</h3><label>Name</label><input data-field="name" value="${esc(shot?.name||'')}"><label>Direction / Prompt</label><textarea data-field="prompt">${esc(shot?.prompt||'')}</textarea><div class="buttons"><div style="flex:1"><label>Duration (seconds)</label><input type="number" min="1" max="15" data-field="seconds" value="${shot?.seconds||5}"></div><div style="flex:1"><label>Seed</label><input type="number" data-field="seed" value="${shot?.seed||1}"></div></div><h3>Scene reference images (optional)</h3><div class="modelstatus">Upload references for this scene. Scene image takes priority as the I2V starting frame; character image can be used as the starting frame when no scene image is supplied. MiniMax H3 does not automatically support two simultaneous image references.</div><div class="buttons"><div style="flex:1"><label>Character reference</label><input type="file" accept="image/png,image/jpeg,image/webp" data-ref-upload="character"/><div data-ref-preview="character">${shot?.characterRef?`<img style="width:100%;max-height:145px;object-fit:contain" src="/unwin/studio/image/${encodeURIComponent(shot.characterRef)}">`:''}</div><button data-ref-clear="character">Remove character</button></div><div style="flex:1"><label>Scene / location reference</label><input type="file" accept="image/png,image/jpeg,image/webp" data-ref-upload="location"/><div data-ref-preview="location">${shot?.sceneRef?`<img style="width:100%;max-height:145px;object-fit:contain" src="/unwin/studio/image/${encodeURIComponent(shot.sceneRef)}">`:''}</div><button data-ref-clear="location">Remove scene image</button></div></div><h3>Character continuity (Qwen)</h3><div class="modelstatus">For Scene 2 onward: previous scene final frame + uploaded character portrait → Qwen identity-corrected starting image. Preview and approve before rendering. Qwen two-image conditioning support is required.</div><label><input type="checkbox" style="width:auto" data-field="characterContinuity" ${shot?.characterContinuity?'checked':''}> Use character continuity when rendering this scene</label><label>Identity strength (prompt guidance, not a model weight)</label><input type="range" min="0" max="1" step="0.05" data-field="identityStrength" value="${shot?.identityStrength??0.65}"><label><input type="checkbox" style="width:auto" data-field="preserveBackground" ${shot?.preserveBackground!==false?'checked':''}> Preserve original background and composition</label><div class="buttons"><button data-act="prepare-continuity">Prepare / regenerate continuity frame</button><button data-act="clear-continuity">Discard prepared frame</button></div>${shot?.continuityImage?`<img style="max-width:100%;max-height:280px;object-fit:contain" src="/unwin/studio/image/${encodeURIComponent(shot.continuityImage)}"><div class="modelstatus">Review this frame against the previous scene's last frame before rendering.</div>`:'<div class="modelstatus">No prepared continuity image yet.</div>'}${shot?.continuityStatus==='failed'?`<div class="modelstatus" style="color:#ffb5b5">Qwen failed: ${esc(shot.continuityError||'Unknown error')}. Retry Prepare, or disable character continuity and use Carry last frame.</div>`:''}<label>Generation mode</label><select data-field="mode"><option value="t2v" ${shot?.mode==='t2v'?'selected':''}>Text to video</option><option value="i2v" ${shot?.mode==='i2v'?'selected':''}>Image to video</option></select><label><input style="width:auto" type="checkbox" data-field="carry" ${shot?.carry?'checked':''}> Carry previous scene last frame (I2V)</label><div class="buttons"><button data-act="render-one">Render scene</button><button data-act="render-all">Render from here</button></div><label>Scene preview</label>${shot?.output?`<video class="preview" controls src="/view?filename=${encodeURIComponent(shot.output.split('/').pop())}&subfolder=${encodeURIComponent(shot.output.split('/').slice(0,-1).join('/'))}&type=output"></video>`:'<div class="preview" style="padding:30px;text-align:center">No render yet</div>'}</div><div class="side"><h3>Local model settings</h3><label>H3 render preset</label><select id="unwin-h3-preset"><option value="standard">MiniMax H3 · Standard quality (20 steps)</option><option value="standard-turbo">MiniMax H3 · Official Turbo LoRA (8 steps)</option><option value="fast-v2">FastVideo FastH3 V2 · 8 steps</option></select><label>Output resolution profile</label><select id="unwin-output-profile"><option value="preview">Preview · 1024 × 576</option><option value="720">720p class · 1280 × 704 native (I2V-safe)</option><option value="1080">1080p delivery · 1344 × 768 native + upscale after render</option><option value="2k">2K delivery · 2560 × 1440 (native H3 + upscale)</option><option value="custom">Custom</option></select><div class="modelstatus">H3 native maximum is approximately 1344×768, not 1920×1080. For 1080p or 2K delivery use AI Video Upscale after rendering; 2K is not native. FastH3 V2 uses 8 steps, res_multistep and simple scheduler; do not combine with Turbo/VSA LoRAs. Licensing may restrict local weights in your region.</div><div class="buttons"><button data-act="auto-model">Auto select VRAM profile</button><button data-act="verify">Verify models / FFmpeg</button></div><div id="unwin-system" class="modelstatus">Model verification available on demand. Presets automatically select compatible installed model files; missing files are reported.</div><div id="unwin-model-profile-status" class="modelstatus">Checking selected preset model files…</div><label>Diffusion checkpoint</label><select id="unwin-model"></select><label>Text encoder</label><select id="unwin-clip"></select><label>Video VAE</label><select id="unwin-vae"></select><label>Audio VAE</label><select id="unwin-audio-vae"></select><label>LoRA compatibility</label><div id="unwin-lora-advice" class="modelstatus">Select a MiniMax H3 LoRA; verify its base checkpoint and architecture on the model page.</div><label>LoRA (optional)</label><select id="unwin-lora"></select><div class="buttons"><button data-act="lora-links">Find H3 LoRAs / downloads ↗</button><button data-act="lora-check">Check selected LoRA</button></div><h3>Multi-LoRA Stack (global or per-scene)</h3><div class="modelstatus">Compatible H3 LoRAs only. LoRA order matters. Turbo requires 4-step preset. Semantic Bridge is a separate adapter, VSA requires a companion node.</div><label>LoRA stack scope</label><select id="unwin-stack-scope"><option value="global">Global</option><option value="scene">This scene only</option></select><div id="unwin-stack-rows"></div><div class="buttons"><button id="unwin-stack-add">+ Add installed LoRA</button><button id="unwin-stack-clear">Clear stack</button></div><label>Render acceleration</label><select id="unwin-acceleration"><option value="base">Base (standard steps)</option><option value="lightx2v">LightX2V Turbo (4 steps)</option><option value="sol">Sol-Attention (recommended; no Sage)</option><option value="vsa">FastVideo VSA (legacy experimental)</option></select><label>Sol-Attention tau (default 1.3)</label><input type="number" id="unwin-sol-tau" min="0" max="4" step="0.05" value="${shot?.solTau??1.3}"><label>VSA top-k ratio (0.10 draft, 1.0 quality)</label><input type="number" id="unwin-vsa-topk" min="0.05" max="1" step="0.05" value="${shot?.vsaTopk??0.1}"><label><input type="checkbox" id="unwin-semantic" style="width:auto" ${shot?.semanticBridge?'checked':''}> Semantic Bridge (requires installed companion node)</label><label>Semantic Bridge alpha</label><input type="number" id="unwin-semantic-alpha" min="0" max="1" step="0.05" value="${shot?.semanticAlpha??0.1}"><div class="modelstatus" id="unwin-advanced-status">Special adapters require installed ComfyUI nodes. Unsupported combinations are blocked before rendering.</div><label>LoRA strength</label><input id="unwin-lora-strength" type="number" min="0" max="2" step="0.05" value="${state.loraStrength??0.8}"><label><input type="checkbox" style="width:auto" id="unwin-latent-upscale" ${state.latentUpscale?'checked':''}> Experimental latent upscale (2×, requires LatentUpscaleBy compatible with H3)</label><label><input type="checkbox" style="width:auto" id="unwin-video-upscale" ${state.videoUpscale?'checked':''}> 2× final video upscale (FFmpeg Lanczos)</label><label>Steps</label><input type="number" id="unwin-steps" min="1" max="100" value="${state.steps||8}"><label>Resolution preset</label><select id="unwin-resolution"><option value="custom">Custom width × height</option><option value="640x352">640 × 352 · Low VRAM / landscape</option><option value="768x432">768 × 432 · Landscape</option><option value="960x544">960 × 544 · Standard landscape</option><option value="1024x576">1024 × 576 · Recommended I2V default</option><option value="1280x720">1280 × 720 · HD landscape</option><option value="352x640">352 × 640 · Low VRAM / portrait</option><option value="432x768">432 × 768 · Portrait</option><option value="544x960">544 × 960 · Portrait</option><option value="720x1280">720 × 1280 · HD portrait</option></select><label>Width</label><input type="number" id="unwin-width" min="128" step="16" value="${state.width||1024}"><label>Height</label><input type="number" id="unwin-height" min="128" step="16" value="${state.height||576}"><div class="modelstatus">For MiniMax I2V use multiples of 64. Recommended 1024 × 576. Larger resolutions require more VRAM.</div><label>FPS</label><input type="number" id="unwin-fps" value="${state.fps||24}"><div class="buttons"><label><input id="unwin-trim-seam" type="checkbox" style="width:auto" ${state.trimSeam?"checked":""}> Remove first frame at scene joins (use for carried-frame scenes)</label><button data-act="stitch">Stitch completed</button><button data-act="refresh">Refresh models</button></div><label>Diagnostics</label><pre id="unwin-log">${esc(log.join('\n'))}</pre></div></div>`;if(wasMinimized)panel.classList.add('minimized');bindAdvanced();
 panel.querySelectorAll('[data-shot]').forEach(b=>b.onclick=()=>{selected=+b.dataset.shot;draw()});
 $('#unwin-skip-completed',panel).onchange=e=>{state.skipCompleted=e.target.checked;save()};
 panel.querySelectorAll('[data-field]').forEach(e=>e.onchange=()=>{if(!state.shots[selected])return;state.shots[selected][e.dataset.field]=e.type==='checkbox'?e.checked:e.type==='number'?Number(e.value):e.value;save();if(e.dataset.field!=='prompt')draw()});
 panel.querySelectorAll('[data-ref-upload]').forEach(input=>input.onchange=async()=>{const kind=input.dataset.refUpload;const file=input.files?.[0];if(!file)return;try{if(file.size>18*1024*1024)throw Error('Reference must be under 18 MB');const sceneIndex=selected;const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('Could not read image'));reader.readAsDataURL(file)});const result=await post('/unwin/studio/reference',{kind,name:'scene_'+(sceneIndex+1),image:data});state.shots[sceneIndex][kind==='character'?'characterRef':'sceneRef']=result.reference;delete state.shots[sceneIndex].continuityImage;save();logLine('Scene '+(sceneIndex+1)+' '+kind+' reference uploaded');draw()}catch(e){logLine('Reference upload failed: '+e.message)}});panel.querySelectorAll('[data-ref-clear]').forEach(button=>button.onclick=()=>{const kind=button.dataset.refClear;delete state.shots[selected][kind==='character'?'characterRef':'sceneRef'];save();draw()});panel.querySelectorAll('[data-act]').forEach(b=>b.onclick=()=>action(b.dataset.act));
 const hp=$('#unwin-h3-preset',panel);hp.value=state.h3Preset||'standard';hp.onchange=()=>{state.h3Preset=hp.value;state.steps=hp.value==='standard'?20:8;state['unwin-lora']='';state.loraStack=[];state.shots.forEach(x=>{if(x.acceleration==='vsa'||x.acceleration==='lightx2v')x.acceleration='base'});save();draw();logLine('H3 preset selected: '+hp.value+'; selecting matching model files.');};
 const op=$('#unwin-output-profile',panel);op.value=state.outputProfile||'preview';op.onchange=()=>{state.outputProfile=op.value;const profiles={preview:[1024,576],720:[1280,704],1080:[1344,768],"2k":[1344,768]};if(profiles[op.value]){[state.width,state.height]=profiles[op.value]}save();draw();if(op.value==='1080')logLine('1080p delivery profile: generate at H3 native 1344×768, then upscale finished video to 1920×1080 using AI Video Upscale.');if(op.value==='2k')logLine('2K delivery profile: generate at H3 native 1344×768, then upscale finished video to 2560×1440. This is NOT native 2K generation. Use AI Video Upscale; final dimensions may require FFmpeg scaling.');};
 const res=$('#unwin-resolution',panel);res.value=`${state.width||1024}x${state.height||576}`;if(!res.value)res.value='custom';res.onchange=()=>{if(res.value==='custom')return;const [w,h]=res.value.split('x').map(Number);state.width=w;state.height=h;save();draw()};
 for(const [id,key] of [['unwin-steps','steps'],['unwin-width','width'],['unwin-height','height'],['unwin-fps','fps']])$('#'+id,panel).onchange=e=>{state[key]=Number(e.target.value);save()};
 for(const [id,key] of [['unwin-lora-strength','loraStrength'],['unwin-latent-upscale','latentUpscale'],['unwin-video-upscale','videoUpscale'],['unwin-trim-seam','trimSeam']])$('#'+id,panel).onchange=e=>{state[key]=e.type==='checkbox'?e.checked:Number(e.value);save()};
 fillModels();
}
let modelProfileError='';
const H3_MODEL_PROFILES={
 'fast-v2':{
  diffusion:['fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors'],
  text:['qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'],
  video:['minimax_h3_video_vae_int8_convrot.safetensors'],
  audio:['minimax_h3_audio_vae_fp32.safetensors'],steps:8},
 'standard':{
  diffusion:['minimax_h3_fl2va_pruned_fp8_scaled.safetensors','minimax_h3_fl2va_pruned_int8_convrot.safetensors'],
  text:['qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors','qwen3vl_32b_minimax_h3_int8_convrot.safetensors'],
  video:['minimax_h3_video_vae_int8_convrot.safetensors','minimax_h3_video_vae_fp16.safetensors'],
  audio:['minimax_h3_audio_vae_fp32.safetensors'],steps:20},
 'standard-turbo':{
  diffusion:['minimax_h3_fl2va_pruned_fp8_scaled.safetensors','minimax_h3_fl2va_pruned_int8_convrot.safetensors'],
  text:['qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors','qwen3vl_32b_minimax_h3_int8_convrot.safetensors'],
  video:['minimax_h3_video_vae_int8_convrot.safetensors','minimax_h3_video_vae_fp16.safetensors'],
  audio:['minimax_h3_audio_vae_fp32.safetensors'],steps:8}
};
function matchInstalled(list,preferred){return preferred.map(name=>(list||[]).find(x=>x.toLowerCase().split(/[\\/]/).pop()===name.toLowerCase())).find(Boolean)||'';}
function applyH3ModelProfile({report=true}={}){
 if(!modelCache)return false;
 const preset=state.h3Preset||'standard',profile=H3_MODEL_PROFILES[preset]||H3_MODEL_PROFILES.standard;
 const entries=[['unwin-model','diffusion_models','diffusion'],['unwin-clip','text_encoders','text'],['unwin-vae','vae','video'],['unwin-audio-vae','vae','audio']];
 const missing=[];
 for(const [id,folder,role] of entries){
  const value=matchInstalled(modelCache[folder],profile[role]);
  state[id]=value;
  const el=panel?.querySelector('#'+id);if(el)el.value=value;
  if(!value)missing.push(role+': '+profile[role].join(' OR '));
 }
 state.steps=profile.steps;
 const steps=panel?.querySelector('#unwin-steps');if(steps)steps.value=profile.steps;
 modelProfileError=missing.length?'Missing compatible files for '+preset+': '+missing.join('; '):'';
 const status=panel?.querySelector('#unwin-model-profile-status');if(status){status.textContent=modelProfileError||'Ready: compatible diffusion, H3 text encoder, video VAE and audio VAE selected for '+preset+'.';status.style.color=modelProfileError?'#ffb5b5':'#b6ebc5';}
 save();if(report)logLine(modelProfileError||'Automatically selected all four installed H3 model files for '+preset);
 return !missing.length;
}
let modelCache=null;

function bindAdvanced(){
 if(!panel)return;
 const shot=state.shots[selected],scope=$('#unwin-stack-scope',panel),list=$('#unwin-stack-rows',panel);
 if(!scope||!list)return;
 scope.value=shot.loraStackScope||'global';
 const stack=()=>scope.value==='scene'?(shot.loraStack||(shot.loraStack=[])):(state.loraStack||(state.loraStack=[]));
 const redraw=()=>{
   const models=modelCache?.loras||[];
   list.innerHTML=stack().map((entry,i)=>`<div class="buttons" style="margin:5px 0;align-items:center">
   <input type="checkbox" data-stack-enabled="${i}" style="width:auto" ${entry.enabled!==false?'checked':''}>
   <select data-stack-name="${i}" style="flex:1"><option value="">Choose LoRA</option>${models.map(n=>`<option value="${esc(n)}" ${n===entry.name?'selected':''}>${esc(n)}</option>`).join('')}</select>
   <input data-stack-strength="${i}" type="number" min="0" max="2" step="0.05" style="width:60px" value="${entry.strength??0.8}">
   <button data-stack-up="${i}">↑</button><button data-stack-down="${i}">↓</button><button data-stack-remove="${i}">✕</button></div>`).join('')||'<div class="modelstatus">No stacked LoRAs. Legacy single LoRA selection remains available.</div>';
   list.querySelectorAll('[data-stack-name]').forEach(e=>e.onchange=()=>{stack()[+e.dataset.stackName].name=e.value;save()});
   list.querySelectorAll('[data-stack-strength]').forEach(e=>e.onchange=()=>{stack()[+e.dataset.stackStrength].strength=Math.max(0,Math.min(2,Number(e.value)||0));save()});
   list.querySelectorAll('[data-stack-enabled]').forEach(e=>e.onchange=()=>{stack()[+e.dataset.stackEnabled].enabled=e.checked;save()});
   for(const kind of ['up','down','remove'])list.querySelectorAll('[data-stack-'+kind+']').forEach(e=>e.onclick=()=>{
     const a=stack(),i=Number(e.dataset['stack'+kind[0].toUpperCase()+kind.slice(1)]);
     if(kind==='remove')a.splice(i,1);
     if(kind==='up'&&i>0)[a[i-1],a[i]]=[a[i],a[i-1]];
     if(kind==='down'&&i<a.length-1)[a[i+1],a[i]]=[a[i],a[i+1]];
     save();redraw();
   });
 };
 scope.onchange=()=>{shot.loraStackScope=scope.value;save();redraw()};
 $('#unwin-stack-add',panel).onclick=()=>{stack().push({name:'',strength:0.8,enabled:true});save();redraw()};
 $('#unwin-stack-clear',panel).onclick=()=>{stack().length=0;save();redraw()};
 const accel=$('#unwin-acceleration',panel);accel.value=shot.acceleration||'base';
 accel.onchange=()=>{shot.acceleration=accel.value;save()};
 const solTau=$('#unwin-sol-tau',panel);solTau.onchange=()=>{shot.solTau=Math.max(0,Math.min(4,Number(solTau.value)||1.3));save()};
 const vsaTopk=$('#unwin-vsa-topk',panel);vsaTopk.onchange=()=>{shot.vsaTopk=Math.min(1,Math.max(0.05,Number(vsaTopk.value)||0.1));save()};
 const semantic=$('#unwin-semantic',panel);semantic.onchange=()=>{shot.semanticBridge=semantic.checked;save()};
 const alpha=$('#unwin-semantic-alpha',panel);alpha.onchange=()=>{shot.semanticAlpha=Number(alpha.value);save()};
 redraw();
}
async function fillModels(){try{modelCache=modelCache||await api('/unwin/models');for(const [id,key,filter] of [['unwin-model','diffusion_models',()=>true],['unwin-clip','text_encoders',()=>true],['unwin-vae','vae',n=>!n.toLowerCase().includes('audio')],['unwin-audio-vae','vae',n=>n.toLowerCase().includes('audio')],['unwin-lora','loras',()=>true]]){let e=$('#'+id,panel);if(!e)continue;const choices=(modelCache[key]||[]).filter(filter);e.innerHTML='<option value="">Select installed model</option>'+choices.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('');e.value=state[id]||'';e.onchange=()=>{state[id]=e.value;save()}}applyH3ModelProfile({report:false});bindAdvanced()}catch(e){logLine('Model scan: '+e.message)}}
// Save without browser prompt(), which may be blocked by ComfyUI Desktop's embedded browser.
async function saveProjectDialog(){
 const old=document.getElementById('unwin-project-save-dialog');if(old)old.remove();
 const dialog=document.createElement('div');dialog.id='unwin-project-save-dialog';
 dialog.style.cssText='position:fixed;z-index:100010;top:20%;left:50%;transform:translateX(-50%);width:min(520px,94vw);background:#182432;color:#fff;padding:22px;border:1px solid #8190a0;border-radius:12px;box-shadow:0 12px 60px #000b;font:14px Arial';
 dialog.innerHTML='<h3 style="margin-top:0">Save Unwin Project</h3><label for="unwin-save-name">Project name</label><input id="unwin-save-name" style="display:block;width:100%;box-sizing:border-box;margin:9px 0 16px;padding:9px;background:#101820;color:white;border:1px solid #728295;border-radius:5px"><div style="display:flex;gap:8px;flex-wrap:wrap"><button id="unwin-save-server">Save to ComfyUI</button><button id="unwin-save-download">Download JSON</button><button id="unwin-save-close">Close</button></div><pre id="unwin-save-result" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto;font:12px monospace"></pre>';
 document.body.appendChild(dialog);
 const nameInput=dialog.querySelector('#unwin-save-name');nameInput.value=state.projectName||'Unwin Project';
 const result=dialog.querySelector('#unwin-save-result');
 const serverBtn=dialog.querySelector('#unwin-save-server');const dlBtn=dialog.querySelector('#unwin-save-download');
 dialog.querySelector('#unwin-save-close').onclick=()=>dialog.remove();
 function snapshot(){state.projectName=(nameInput.value.trim()||'Unwin Project').slice(0,100);state.projectVersion=3;state.savedAt=new Date().toISOString();save();return JSON.stringify(state,null,2)}
 async function saveServer(){
  const content=snapshot();serverBtn.disabled=true;result.textContent='Saving to ComfyUI output folder...';
  try{const saved=await post('/unwin/project/save',{project:JSON.parse(content)});
   if(!saved.ok||!saved.path)throw Error('Server did not confirm the saved file');
   result.textContent='SAVED SUCCESSFULLY\n'+saved.path+'\nBackup: '+saved.backup;
   logLine('Project saved: '+saved.path);return true;
  }catch(e){result.textContent='SAVE FAILED: '+e.message+'\nUse Download JSON to keep a copy.';logLine('Project save failed: '+e.message);return false}
  finally{serverBtn.disabled=false}
 }
 serverBtn.onclick=saveServer;
 dlBtn.onclick=()=>{try{const content=snapshot();const filename=(state.projectName.replace(/[^a-z0-9_-]+/gi,'_')||'unwin-project')+'.unwin.json';
  const blob=new Blob([content],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  result.textContent='JSON download requested: '+filename+'\nCheck your browser downloads (Ctrl+J).';logLine('Project JSON download requested: '+filename);
 }catch(e){result.textContent='Download failed: '+e.message}};
 nameInput.focus();nameInput.select();
}

async function action(a){const shots=state.shots,s=shots[selected];if(a==='lora-links'){window.open('https://huggingface.co/models?search=MiniMax%20H3%20LoRA','_blank','noopener,noreferrer');logLine('Opened Hugging Face model search; check model license, base checkpoint and architecture before downloading.');return}if(a==='lora-check'){const n=state['unwin-lora']||'';const msg=!n?'No LoRA selected. Base model will be used.':!/minimax|h3/i.test(n)?'WARNING: filename does not identify MiniMax H3 compatibility. Check model card before rendering.':/h3/i.test(n)?'Filename suggests H3. Confirm exact base checkpoint, LoRA format and recommended strength from model card.':'Filename suggests MiniMax, but H3 compatibility is unverified. Check model card.';const el=$('#unwin-lora-advice',panel);if(el)el.textContent=msg;logLine(msg);return}if(a==='prepare-continuity'){try{await prepareContinuity(selected)}catch(e){logLine('Continuity FAILED: '+e.message);state.shots[selected].continuityStatus='failed';state.shots[selected].continuityError=String(e?.message||e||'Unknown error');save();draw()}return}if(a==='clear-continuity'){delete s.continuityImage;s.continuityStatus='pending';save();draw();return}if(a==='terminal'){openTerminal();return}if(a==='ai-upscale'){openAIUpscale();return}if(a==='close'){panel.remove();panel=null;return}if(a==='minimize'){panel.classList.toggle('minimized');return}if(a==='verify'){try{const d=await api('/unwin/system');const el=$('#unwin-system',panel);el.textContent='GPU: '+(d.gpu||'CPU')+' | VRAM: '+d.vram_gb+' GB\nFFmpeg: '+(d.ffmpeg||'NOT FOUND')+'\n'+Object.entries(d.models).map(([k,v])=>k+': '+v.length+' installed, '+v.filter(x=>!x.exists).length+' invalid paths').join('\n');logLine('Verified local model files and FFmpeg')}catch(e){logLine('Verification failed: '+e.message)}return}if(a==='auto-model'){try{modelCache=await api('/unwin/models');applyH3ModelProfile();return}catch(e){logLine('Auto model selection: '+e.message);return}}if(a==='add'){shots.push({name:'Scene '+(shots.length+1),prompt:'',seconds:5,mode:'t2v',carry:true,seed:1,status:'pending',output:''});selected=shots.length-1}if(a==='duplicate'){shots.splice(selected+1,0,JSON.parse(JSON.stringify(s)));selected++}if(a==='delete'&&shots.length>1){shots.splice(selected,1);selected=Math.min(selected,shots.length-1)}if(a==='up'&&selected>0){[shots[selected-1],shots[selected]]=[shots[selected],shots[selected-1]];selected--}if(a==='down'&&selected<shots.length-1){[shots[selected+1],shots[selected]]=[shots[selected],shots[selected+1]];selected++}if(a==='refresh')modelCache=null;if(a==='save-project'||a==='export'){
  await saveProjectDialog();
  return;
 }
 if(a==='project-backups'){
  try{const result=await api('/unwin/project/list');const items=result.projects||[];
   const options=items.slice(0,30).map((x,i)=>`${i+1}. ${x.filename}`).join('\n');
   const choice=window.prompt('Saved in: '+result.directory+'\n\nEnter number to load a project or backup:\n'+(options||'(no saved projects)'),'');
   if(choice===null||!choice.trim())return;
   const index=Number(choice)-1;if(!Number.isInteger(index)||!items[index])throw Error('Invalid project selection');
   const loaded=await api('/unwin/project/load?name='+encodeURIComponent(items[index].filename));
   const d=loaded.project;if(!Array.isArray(d.shots)||!d.shots.length)throw Error('Invalid saved project');
   if(!window.confirm('Load '+items[index].filename+'? Unsaved changes in the current director will be replaced.'))return;
   state={...initial(),...d};selected=0;save();draw();logLine('Loaded server project: '+items[index].filename);
  }catch(e){logLine('Saved projects: '+e.message)}return;
 }
 if(a==='load-project'||a==='import'){const inp=document.createElement('input');inp.type='file';inp.accept='.json';inp.onchange=async()=>{try{const d=JSON.parse(await inp.files[0].text());if(!d||typeof d!=='object'||!Array.isArray(d.shots)||!d.shots.length)throw Error('Invalid project: no scenes');if(!d.shots.every(x=>x&&typeof x==='object'&&typeof x.prompt==='string'))throw Error('Invalid project scene data');state={...initial(),...d};selected=0;save();draw();logLine('Loaded project: '+(state.projectName||inp.files[0].name)+' ('+state.shots.length+' scenes). Output previews require the original video files to remain in ComfyUI output.')}catch(e){logLine(e.message)}};inp.click()}if(a==='stop-batch'){if(batchActive){batchStopRequested=true;logLine('Stop requested: the active scene will finish, then the batch will stop.')}return}
if(a==='render-project'){if(busy)return;const needsContinuity=shots.findIndex((shot,i)=>i>0&&shot.characterContinuity&&!shot.continuityImage&&!(state.skipCompleted!==false&&shot.output&&shot.status==='done'));if(needsContinuity>=0){selected=needsContinuity;draw();logLine('Render All preflight: Scene '+(needsContinuity+1)+' requires a prepared Qwen frame. Prepare and review it first, or disable character continuity to carry the previous scene final frame directly. No video jobs were queued.');return;}const skip=state.skipCompleted!==false;const todo=shots.map((shot,i)=>({shot,i})).filter(({shot})=>!(skip&&shot.output&&shot.status==='done'));if(!todo.length){logLine('Render All: every scene is already complete. Disable Skip already rendered scenes to rerender.');return}const invalid=todo.find(({shot})=>!String(shot.prompt||'').trim()||!(Number(shot.seconds)>0));if(invalid){logLine('Render All: Scene '+(invalid.i+1)+' needs a prompt and positive duration.');return}const missing=todo.find(({shot,i})=>shot.mode==='i2v'&&!shot.sceneRef&&!shot.characterRef&&!shot.continuityImage&&!(i>0&&shot.carry));if(missing){logLine('Render All: Scene '+(missing.i+1)+' is I2V but has no reference or last-frame carryover.');return}busy=true;batchActive=true;batchStopRequested=false;batchCompleted=0;batchTotal=todo.length;save();draw();openTerminal();logLine('Render All started: '+todo.length+' scenes, in timeline order; '+(skip?'skipping':'rerendering')+' completed scenes. I2V carryover waits for the preceding scene to finish.');try{for(const {i} of todo){if(batchStopRequested){logLine('Render All stopped before Scene '+(i+1));break}selected=i;draw();logLine('Batch '+(batchCompleted+1)+'/'+batchTotal+': rendering Scene '+(i+1)+' ('+shots[i].mode.toUpperCase()+', '+shots[i].seconds+'s)');await render(i);batchCompleted++;logLine('Batch progress: '+batchCompleted+'/'+batchTotal+' scenes completed');save();draw()}if(!batchStopRequested&&batchCompleted===batchTotal)logLine('Render All complete: '+batchCompleted+' scenes finished. Review previews before stitching.')}catch(e){if(shots[selected]&&shots[selected].status!=='done')shots[selected].status='failed';lastProgress='BATCH FAILED: '+e.message;updateTerminal();logLine('Render All stopped after error: '+e.message+' — previously completed scenes are preserved.')}finally{busy=false;batchActive=false;batchStopRequested=false;save();draw()}return}
if(a==='render-one'||a==='render-all'){if(busy)return;busy=true;try{for(let i=selected;i<(a==='render-one'?selected+1:shots.length);i++)await render(i)}catch(e){lastProgress='FAILED: '+e.message;updateTerminal();logLine('FAILED: '+e.message)}finally{busy=false}}if(a==='stitch'){try{let clips=shots.map(s=>s.output).filter(Boolean);if(!clips.length)throw Error('No completed clips');const result=await post('/unwin/stitch',{clips,fps:state.fps||24,upscale:state.videoUpscale?2:1,trim_seam:!!state.trimSeam});state.lastStitched=result.filename;logLine('Final video: '+result.filename)}catch(e){logLine('Stitch error: '+e.message)}}save();draw()}

// Per-scene Qwen identity continuity; deliberately generates a reviewable image before H3 I2V.
function selectFile(arr,pattern,label){const match=(arr||[]).find(x=>pattern.test(x));if(!match)throw Error('Missing '+label+'. Install and verify via Model Manager.');return match}
function nodeInputs(info,name){const x=info[name];if(!x)throw Error('Missing ComfyUI node '+name+'. Update ComfyUI Desktop.');return {...(x.input?.required||{}),...(x.input?.optional||{})}}
function choose(schema,names,label){for(const n of names)if(schema[n])return n;throw Error(label+' input unsupported; found '+Object.keys(schema).join(', '))}
async function buildContinuityWorkflow(prompt,reference,size,seed){
  const engine='qwen';
  const [info,models]=await Promise.all([api('/object_info'),api('/unwin/studio/available-models')]);
  const unet=selectFile(models.diffusion_models,engine==='qwen'?/qwen.*image.*edit/i:/z[_-]?image.*turbo/i,engine+' diffusion checkpoint');
  const clip=selectFile(models.text_encoders,engine==='qwen'?/qwen.*2[._-]?5.*vl.*7b/i:/qwen.*3.*4b/i,engine+' text encoder');
  const vae=selectFile(models.vae,engine==='qwen'?/qwen.*image.*vae/i:/^(ae|z_image.*vae).*\.safetensors$/i,engine+' VAE');
  const graph={};let next=1;
  const add=(class_type,inputs)=>{nodeInputs(info,class_type);const id=String(next++);graph[id]={class_type,inputs};return [id,0]};
  const model=add('UNETLoader',{unet_name:unet,weight_dtype:'default'});
  const clipSchema=nodeInputs(info,'CLIPLoader');const clipType=clipSchema.type?.[0]?.includes('qwen_image')?'qwen_image':(clipSchema.type?.[0]?.includes('lumina2')?'lumina2':'default');
  const textEncoder=add('CLIPLoader',{clip_name:clip,type:clipType,device:'default'});
  const decoder=add('VAELoader',{vae_name:vae});
  size=Number(size)||768;
  let conditioning,latent;
  if(engine==='qwen'){
   if(!reference)throw Error('Qwen Image Edit requires a portrait. Upload and create a reference first.');
   const prepared=await post('/unwin/studio/prepare-input',{filename:reference});
   const inputImage=add('LoadImage',{image:prepared.filename});
   const className=['TextEncodeQwenImageEditPlus','TextEncodeQwenImageEdit'].find(x=>info[x]);
   if(!className)throw Error('Missing Qwen Image Edit conditioning node. Update ComfyUI Desktop to a release supporting Qwen Image Edit.');
   const schema=nodeInputs(info,className),inputs={};
   inputs[choose(schema,['clip'],'Qwen encoder')]=textEncoder;
   inputs[choose(schema,['image1','image'],'Qwen reference')]=inputImage;
   inputs[choose(schema,['prompt','text'],'Qwen prompt')]=prompt;
   if(schema.vae)inputs.vae=decoder;
   if(schema.image2)inputs.image2=inputImage;
   if(schema.image3)inputs.image3=inputImage;
   conditioning=add(className,inputs);
   latent=add('EmptySD3LatentImage',{width:size,height:size,batch_size:1});
  }else{
   conditioning=add('CLIPTextEncode',{clip:textEncoder,text:prompt});
   latent=add('EmptySD3LatentImage',{width:size,height:size,batch_size:1});
  }
  let samplingModel=model;
  if(info.ModelSamplingAuraFlow){samplingModel=add('ModelSamplingAuraFlow',{model,shift:engine==='qwen'?3:3});}
  const sampler=add('KSampler',{model:samplingModel,positive:conditioning,negative:add('ConditioningZeroOut',{conditioning}),latent_image:latent,seed:Number(seed)||42,steps:engine==='qwen'?20:9,cfg:1,sampler_name:'euler',scheduler:'simple',denoise:1});
  const decoded=add('VAEDecode',{samples:sampler,vae:decoder});
  add('SaveImage',{images:decoded,filename_prefix:'UnwinStudio'});
  // Check each generated input name against actual node schemas before queueing.
  for(const [id,node] of Object.entries(graph)){const schema=nodeInputs(info,node.class_type);const bad=Object.keys(node.inputs).filter(k=>!schema[k]);if(bad.length)throw Error(node.class_type+' unsupported inputs: '+bad.join(', '));}
  return graph;
}
// Track the specific Qwen prompt, not unrelated ComfyUI queue activity.
async function continuityQueueState(id){
 const q=await api('/queue');
 const queued=(q.queue_pending||[]).some(item=>item[1]===id);
 const running=(q.queue_running||[]).some(item=>item[1]===id);
 return running?'running':queued?'pending':'absent';
}
async function removeQueuedContinuity(id){
 try{const q=await api('/queue');if((q.queue_pending||[]).some(item=>item[1]===id))
   await post('/queue',{delete:[id]});}catch(e){logLine('Could not remove pending Qwen job: '+e.message)}
}
async function waitContinuityImage(id,sceneIndex){
 const started=Date.now(),maxQueue=20*60*1000,maxRunning=60*60*1000;
 let runningSince=0,lastNotice=0,absentSince=0;
 while(true){
  if(batchStopRequested){await removeQueuedContinuity(id);throw Error('Batch stopped during Qwen continuity')}
  const h=await api('/history/'+encodeURIComponent(id));
  const entry=h[id];
  if(entry){
   if(entry.status?.status_str==='error'||entry.status?.status_str==='interrupted')
     throw Error('Qwen '+(entry.status.status_str||'error')+': '+JSON.stringify(entry.status.messages||[]).slice(-1400));
   const images=Object.values(entry.outputs||{}).flatMap(o=>o.images||[]).filter(x=>x.filename);
   if(images.length)return images[0];
   if(entry.status?.completed)throw Error('Qwen completed without an image. Check SaveImage node.');
  }
  const now=Date.now(),stage=await continuityQueueState(id);
  if(stage==='running'){if(!runningSince)runningSince=now;absentSince=0}
  else if(stage==='absent'){if(!absentSince)absentSince=now}
  else absentSince=0;
  if(stage==='pending'&&now-started>maxQueue){await removeQueuedContinuity(id);throw Error('Qwen remained pending for 20 minutes; removed its queued prompt. Check other ComfyUI jobs.')}
  if(stage==='running'&&now-runningSince>maxRunning)
    throw Error('Qwen exceeded 60 minutes of actual execution. Its GPU job may still be running: interrupt it in ComfyUI before retrying.');
  if(stage==='absent'&&absentSince&&now-absentSince>15000)
    throw Error('Qwen prompt disappeared from the queue without producing a saved image. Check ComfyUI console.');
  if(now-lastNotice>30000){
    logLine('Scene '+(sceneIndex+1)+' Qwen continuity '+stage+' · '+Math.floor((now-started)/60000)+' min elapsed · prompt '+id);
    lastNotice=now;
  }
  await sleep(2000);
 }
}
async function prepareContinuity(i){const shot=state.shots[i],prev=state.shots[i-1];if(!i||!prev?.output)throw Error('Render the previous scene before preparing character continuity.');if(!shot.characterRef)throw Error('Upload a character reference on this scene first.');const last=(await post('/unwin/last-frame',{filename:prev.output})).filename;const character=(await post('/unwin/studio/prepare-input',{filename:shot.characterRef})).filename;const prompt=`Edit IMAGE 1 minimally using IMAGE 2 ONLY as the identity reference. Preserve the exact camera viewpoint, framing, body pose, clothes, background, lighting and scene geometry of IMAGE 1. Match the visible character face and hair to IMAGE 2. Do not add people or objects. Keep the first image nearly pixel-identical except for necessary facial identity corrections. Identity priority ${Math.round((shot.identityStrength??0.65)*100)} percent. ${shot.preserveBackground!==false?'STRICTLY PRESERVE THE ENTIRE BACKGROUND.':''}`;
const graph=await buildContinuityWorkflow(prompt,shot.characterRef,shot.continuitySize||768,shot.seed||42);
// Replace the Qwen image conditioning with distinct inputs: previous last frame as image1, portrait as image2.
const imageNode=Object.entries(graph).find(([id,n])=>n.class_type==='LoadImage');if(!imageNode)throw Error('Qwen graph missing LoadImage');imageNode[1].inputs.image=last;
const info=await api('/object_info');const edit=Object.entries(graph).find(([id,n])=>/TextEncodeQwenImageEdit/.test(n.class_type));if(!edit)throw Error('Qwen conditioning node missing');const schema=nodeInputs(info,edit[1].class_type);if(!schema.image2)throw Error('Installed Qwen Image Edit node lacks image2; two-image identity correction is unavailable. Update ComfyUI or disable Character Continuity.');const next=String(Math.max(...Object.keys(graph).map(Number))+1);graph[next]={class_type:'LoadImage',inputs:{image:character}};edit[1].inputs.image2=[next,0];
shot.continuityStatus='processing';save();draw();openTerminal();logLine('Scene '+(i+1)+': Qwen continuity image queued (separate preparation stage; video not queued yet)');const queued=await post('/prompt',{prompt:graph,client_id:crypto.randomUUID()});if(!queued.prompt_id)throw Error('Qwen queue rejected: '+JSON.stringify(queued.node_errors||queued.error||queued).slice(0,1000));shot.continuityPromptId=queued.prompt_id;save();let image;try{image=await waitContinuityImage(queued.prompt_id,i)}catch(e){shot.continuityStatus='failed';shot.continuityError=e.message;save();draw();throw e}
const stored=await post('/unwin/studio/store-output',{filename:image.filename,subfolder:image.subfolder||'',type:image.type||'output'});shot.continuityImage=stored.reference;shot.continuityStatus='ready';shot.continuityError='';save();draw();logLine('Scene '+(i+1)+': continuity image ready for review.');return stored.reference;
}

async function render(i){const shot=state.shots[i],previous=state.shots[i-1];shot.status='preparing';draw();const carry=i>0&&shot.carry&&previous?.output;if(i>0&&shot.carry&&!previous?.output&&!shot.sceneRef&&!shot.characterRef)throw Error('Scene '+i+' needs previous rendered scene or an uploaded reference image');let frame=null;if(shot.characterContinuity&&!shot.continuityImage)throw Error('Scene '+(i+1)+' requires Qwen continuity preparation. Click Prepare / regenerate continuity frame, review the image, then retry Render All. Or disable character continuity to use the previous scene final frame directly.');const selectedReference=shot.characterContinuity?shot.continuityImage:(shot.sceneRef||shot.characterRef);if(selectedReference){frame=(await post('/unwin/studio/prepare-input',{filename:selectedReference})).filename;logLine('Scene '+(i+1)+' starting from '+(shot.characterContinuity?'Qwen continuity':shot.sceneRef?'scene/location':'character')+' reference image.');if(shot.sceneRef&&shot.characterRef)logLine('Note: H3 I2V uses one starting image. Character image is stored for review, but not separately conditioned.');if(carry)logLine('Explicit reference overrides previous-scene last-frame carryover.');}else if(carry){frame=(await post('/unwin/last-frame',{filename:previous.output})).filename;logLine('Extracted continuity frame '+frame)}const mode=frame?'i2v':shot.mode;if(mode==='i2v'&&!frame)throw Error('Image-to-video needs a scene/character reference or a previous rendered scene with Carry enabled');let graph=await api('/unwin/template/'+mode);for(const [id,k] of [['2','unwin-model'],['1','unwin-clip'],['3','unwin-vae'],['4','unwin-audio-vae']]){if(!state[k])throw Error('Select all four installed model files');const key=Object.keys(graph[id].inputs).find(x=>x.endsWith('_name'));graph[id].inputs[key]=state[k]}
 const stack=shot.loraStackScope==='scene'?(shot.loraStack||[]):(state.loraStack||[]);
 const legacy=state['unwin-lora']?[{name:state['unwin-lora'],strength:state.loraStrength??0.8,enabled:true}]:[];
 const active=stack.length?stack.filter(x=>x.enabled!==false&&x.name):legacy;
 const names=new Set();
 for(const entry of active){
   if(names.has(entry.name))throw Error('Duplicate LoRA in stack: '+entry.name);
   names.add(entry.name);
   if(!Number.isFinite(Number(entry.strength))||Number(entry.strength)<0||Number(entry.strength)>2)throw Error('Invalid LoRA strength');
   if(/fasth3.*vsa/i.test(entry.name))throw Error('FastVideo VSA requires its gate-injection workflow; use the dedicated VSA integration, not a standard LoRA stack.');
 }
 const h3Preset=state.h3Preset||'standard';
 if(modelProfileError)throw Error(modelProfileError+' — open Model Manager and download the missing files.');
 if(h3Preset==='fast-v2'){
   if(!/fastvideo_fasth3_8step_v2_pruned_int8_convrot\.safetensors$/i.test(state['unwin-model']||''))throw Error('FastH3 V2 preset requires its 8-step V2 diffusion checkpoint. Download it in Model Manager and select it under Diffusion checkpoint.');
   if(active.length||state['unwin-lora'])throw Error('FastH3 V2 is already distilled: remove all LoRAs and Turbo adapters.');
   if(shot.semanticBridge)throw Error('FastH3 V2 does not support Semantic Bridge or multi-reference conditioning.');
   if(!['base','sol'].includes(shot.acceleration||'base'))throw Error('FastH3 V2 cannot be combined with VSA or LightX2V acceleration.');
   shot._effectiveSteps=8;
 }else if(/fastvideo_fasth3_8step_v2/i.test(state['unwin-model']||''))throw Error('FastH3 V2 checkpoint requires FastH3 V2 preset; standard H3 schedules are incompatible.');
 if(h3Preset==='standard-turbo'){
   if(!active.some(x=>/minimax_h3_fl2v_turbo_8step_v1\.0_comfyui_bf16/i.test(x.name)))throw Error('Standard H3 Turbo preset requires the official 8-step Turbo LoRA in your active LoRA stack.');
   if(!/minimax_h3_fl2va/i.test(state['unwin-model']||''))throw Error('Standard H3 Turbo requires an FL2VA base checkpoint.');
   shot._effectiveSteps=8;
 }
 const accel=shot.acceleration||'base';
 if(accel==='lightx2v'){
   if(!active.some(x=>/lightx2v.*4step/i.test(x.name)))throw Error('LightX2V 4-step preset requires the matching installed LightX2V LoRA in the active stack.');
   if(active.some(x=>/turbo/i.test(x.name)&&!/lightx2v/i.test(x.name)))throw Error('Do not combine competing Turbo LoRAs.');
   shot._effectiveSteps=4;
 }else shot._effectiveSteps=null;
 const objectInfo=await api('/object_info');
 if(accel==='sol'){
   if(!objectInfo.MiniMaxH3MemoryEfficientSolAttentionPatch)
     throw Error('Sol-Attention MiniMax H3 patch not installed. Install Saganaki22/ComfyUI-sol-attn in ComfyUI Manager and restart. Do NOT use the generic SolAttentionPatch.');
 }
 if(accel==='vsa'){
   if(!objectInfo.H3VSA)throw Error('Install ComfyUI-MiniMax-H3-FastVideo and its vsa Python dependency, then restart ComfyUI.');
   if(!String(state['unwin-model']).includes('fl2va_pruned_int8_convrot'))throw Error('VSA requires minimax_h3_fl2va_pruned_int8_convrot.safetensors.');
   if(active.some(x=>/turbo|lightx2v|fasth3/i.test(x.name)))throw Error('Remove Turbo/VSA LoRAs from the regular stack. The VSA preset loads its own calibrated FastH3 LoRA.');
   const installed=(await api('/unwin/models')).loras||[];
   if(!installed.includes('fasth3_vsa_v5.safetensors')||!installed.includes('fasth3_vsa_gate.safetensors'))throw Error('VSA LoRA or gate not installed. Download both in Model Manager.');
   shot._effectiveSteps=4;
 }
 if(shot.semanticBridge){
   if(!objectInfo.SenseNovaH3DistilledBridge||!objectInfo.MiniMaxH3DistilledImageToVideo)
     throw Error('Install MiniMax-H3-Semantic-Bridge custom node, restart ComfyUI and download its adapter.');
   if(!objectInfo.SenseNovaH3DistilledBridge.input?.required?.distilled_adapter?.[0]?.includes('MiniMaxH3_SemanticBridge_v1.safetensors'))
     throw Error('Semantic Bridge adapter missing in ComfyUI/models/semantic_bridge.');
   if(accel==='vsa')throw Error('VSA + Semantic Bridge has not been validated together. Choose one at a time.');
   if(mode==='t2v'&&!objectInfo.MiniMaxH3DistilledImageToVideo)throw Error('Semantic Bridge I2V conditioning node unavailable.');
 }
 if(active.length){
   const info=await api('/object_info/LoraLoaderModelOnly');
   if(!info.LoraLoaderModelOnly)throw Error('LoraLoaderModelOnly unavailable');
   const installed=(await api('/unwin/models')).loras||[];
   let link=['2',0];
   for(let idx=0;idx<active.length;idx++){
     const entry=active[idx];
     if(!installed.includes(entry.name))throw Error('LoRA not installed: '+entry.name);
     const id=String(90+idx);
     graph[id]={class_type:'LoraLoaderModelOnly',inputs:{model:link,lora_name:entry.name,strength_model:Number(entry.strength)}};
     link=[id,0];
   }
   graph['5'].inputs.model=link;
 }
 if(accel==='sol'){
   const upstream=graph['5'].inputs.model;
   graph['122']={class_type:'MiniMaxH3MemoryEfficientSolAttentionPatch',inputs:{
     model:upstream,enabled:true,tau:Number(shot.solTau??1.3),min_tokens:4096,
     strict:false,thresh_type:'diag',int8_qk:false,int8_pv:false,
     sink_conditioning:'exact_kv',dense_blocks:'0-2,-1'
   }};
   graph['5'].inputs.model=['122',0];
   logLine('Sol-Attention patched into H3 model; Sage disabled; tau '+(shot.solTau??1.3));
 }
 // Apply the FastVideo LoRA after any standard LoRAs, then insert its gate patch
 // before MiniMaxH3SigmaShift so the scheduler and guider use the patched model.
 if(accel==='vsa'){
   const upstream=graph['5'].inputs.model;
   graph['120']={class_type:'LoraLoaderModelOnly',inputs:{model:upstream,lora_name:'fasth3_vsa_v5.safetensors',strength_model:1.0}};
   graph['121']={class_type:'H3VSA',inputs:{model:['120',0],gate_file:'fasth3_vsa_gate.safetensors',topk_ratio:shot.vsaTopk??0.1,min_tokens:4096,keep_gates_on_gpu:false}};
   graph['5'].inputs.model=['121',0];
   graph['10'].inputs.sampler_name='euler';
   graph['9'].inputs.scheduler='simple';
   logLine('FastVideo VSA wired: LoRA → H3VSA gate → sigma shift, 4 steps, topk '+(shot.vsaTopk??0.1));
 }
 if(state.latentUpscale){
   const info=await api('/object_info/LatentUpscaleBy');
   if(!info.LatentUpscaleBy)throw Error('LatentUpscaleBy is unavailable; disable latent upscale');
   graph['91']={class_type:'LatentUpscaleBy',inputs:{samples:['11',0],upscale_method:'nearest-exact',scale_by:2}};
   graph['12'].inputs.samples=['91',0];
 }
 if(!Number.isInteger(state.width)||!Number.isInteger(state.height)||state.width<128||state.height<128||state.width%16||state.height%16)throw Error('Width and height must be integers >=128 and divisible by 16');
 if(state.width*state.height>1344*768)throw Error('MiniMax H3 local native canvas is capped at approximately 1344×768 (1.03MP). Select 720p class or 1080p delivery profile; upscale after render.');
 // H3 I2V packs VAE latents into 2x2 patches. Odd latent dimensions
 // can trigger patchify_video reshape errors. Guard before queueing.
 if(frame&&(state.width%64!==0||state.height%64!==0)){
   throw Error('MiniMax H3 I2V preflight: width and height must be divisible by 64 to avoid patchify_video tensor mismatch. Use 960×512, 1024×576 or 1280×704. For exact 720p, upscale after stitching.');
 }
 if(shot.semanticBridge){
   const adapter='MiniMaxH3_SemanticBridge_v1.safetensors';
   const alpha=Number(shot.semanticAlpha??0.1);
   if(!Number.isFinite(alpha)||alpha<0||alpha>1)throw Error('Semantic Bridge alpha must be between 0 and 1.');
   // Both T2V and I2V use the bridge author's native FL2VA-compatible
   // conditioning node. For I2V, the first-frame input is connected below.
   // This intentionally replaces the template's ReferenceToVideo node.
   graph['6']={class_type:'MiniMaxH3DistilledImageToVideo',inputs:{
     clip:['1',0],vae:['3',0],prompt:shot.prompt,
     distilled_adapter:adapter,alpha,magnitude_match:'per_token',
     width:state.width,height:state.height,length:Math.round((state.fps||24)*shot.seconds/4)*4+1
   }};
   logLine('Semantic Bridge wired into FL2VA conditioning (alpha '+alpha+').');
 }
if(h3Preset==='fast-v2'||h3Preset==='standard-turbo'){
 graph['10'].inputs.sampler_name='res_multistep';graph['9'].inputs.scheduler='simple';shot._effectiveSteps=8;
 if(h3Preset==='fast-v2'){graph['5'].inputs.shift_video=10;graph['5'].inputs.shift_audio=3;logLine('FastH3 V2: 8 steps / res_multistep / simple scheduler / H3 sigma shift 10:3. Sparse attention is not automatically injected; check official FastH3 workflow for optional VSA acceleration.');}
}
if(state.outputProfile==='1080')logLine('1080p delivery: native 1344×768 H3 generation; use AI Video Upscale to export 1920×1080.');if(state.outputProfile==='2k')logLine('2K delivery: native 1344×768 H3 generation; upscale and resize output to 2560×1440. Native 2K H3 is not supported.');
graph['6'].inputs.prompt=shot.prompt;graph['6'].inputs.width=state.width||960;graph['6'].inputs.height=state.height||544;graph['6'].inputs.length=Math.round((state.fps||24)*shot.seconds/4)*4+1;graph['8'].inputs.noise_seed=shot.seed||1;graph['9'].inputs.steps=shot._effectiveSteps||state.steps||8;graph['14'].inputs.fps=state.fps||24;const outputPrefix='unwin_director/scene_'+String(i+1).padStart(3,'0')+'_'+Date.now();graph['15'].inputs.filename_prefix=outputPrefix;
 if(frame){const imageNode=shot.semanticBridge?'MiniMaxH3DistilledImageToVideo':'MiniMaxH3ImageToVideo';const objectInfo=await api('/object_info/'+imageNode);const spec=objectInfo[imageNode]?.input||{};const names={...spec.required,...spec.optional};let imageName=['first_frame','start_image','image','reference_image'].find(n=>n in names);if(!imageName)throw Error('Your installed MiniMaxH3ImageToVideo has no recognized first-frame input; refusing unconditioned render');graph['99']={class_type:'LoadImage',inputs:{image:frame}};
 const scaleInfo=await api('/object_info/ImageScale');
 if(!scaleInfo.ImageScale)throw Error('ImageScale node unavailable; cannot safely normalise I2V reference dimensions.');
 graph['98']={class_type:'ImageScale',inputs:{image:['99',0],upscale_method:'lanczos',width:state.width,height:state.height,crop:'center'}};
 graph['6'].inputs[imageName]=['98',0];
 logLine('I2V preflight: resized/cropped reference to '+state.width+'×'+state.height+'; patch-safe dimensions validated.');}
 shot.status='queued';draw();openTerminal();const clientId=crypto.randomUUID();let response=await post('/prompt',{prompt:graph,client_id:clientId});let id=response.prompt_id;if(!id)throw Error('Queue did not return prompt ID');shot.promptId=id;connectRenderEvents(clientId,id,i+1);save();logLine('Scene '+(i+1)+' queued: '+id+' (waiting up to 90 minutes)');for(let t=0;t<2700;t++){await sleep(2000);const h=await api('/history/'+id);const entry=h[id];if(!entry){if(t>0&&t%30===0)logLine('Scene '+(i+1)+' still waiting ('+Math.floor(t/30)+' min); check ComfyUI queue/console. Prompt '+id);continue;}if(entry.status?.status_str==='error'){const msgs=entry.status.messages||[];const failure=msgs.find(x=>x[0]==='execution_error')?.[1]||{};const raw=String(failure.exception_message||'');const first=raw.split('\n').find(x=>x.trim()&&!x.includes('tensor('))||JSON.stringify(failure).slice(0,350)||'Unknown execution error';const name=failure.node_type||'unknown node';const detail=String(failure.exception_type||'ExecutionError')+': '+first.slice(0,350);logLine('FAILED NODE '+(failure.node_id||'?')+' ('+name+'): '+detail);logLine('ComfyUI console contains full traceback; tensor dumps omitted.');throw Error('Node '+(failure.node_id||'?')+' ('+name+'): '+detail)}if(entry.status?.completed){const records=[];const visit=(x,depth=0)=>{if(depth>5||!x)return;if(Array.isArray(x)){x.forEach(v=>visit(v,depth+1));return}if(typeof x==='object'){if(typeof x.filename==='string'&&/\.(mp4|webm|mov|mkv)$/i.test(x.filename))records.push(x);Object.values(x).forEach(v=>visit(v,depth+1))}};visit(entry.outputs||{});let vid=records.find(v=>v.filename?.match(/\.(mp4|webm|mov|mkv)$/i));if(vid){shot.output=[vid.subfolder,vid.filename].filter(Boolean).join('/')}else{let found=null;for(let retry=0;retry<8;retry++){const result=await api('/unwin/find-render?prefix='+encodeURIComponent(outputPrefix));if(result.filename){found=result.filename;break}await sleep(1000)}if(!found)throw Error('Render completed but no video found in history or output directory for '+outputPrefix+'. Check SaveVideo output and ComfyUI console.');shot.output=found;logLine('Recovered saved video from output directory')}shot.status='done';lastProgress='Scene saved successfully';updateTerminal(100);save();logLine('Scene '+(i+1)+' saved: '+shot.output);draw();return}}throw Error('Render still has no completed history after 90 minutes. Check ComfyUI queue and console before retrying; it may still be running.')}
function openDirector(node){if(panel){panel.classList.remove('minimized');return;}nodeRef=node;try{state=JSON.parse(node.properties.unwin||'null')||initial()}catch{state=initial()}selected=0;panel=document.createElement('div');panel.id='unwin-panel';document.body.append(panel);draw()}
app.registerExtension({name:'unwin.minimax.director',beforeRegisterNodeDef(nodeType,nodeData){if(nodeData.name==='UnwinTimeline'){const orig=nodeType.prototype.onNodeCreated;nodeType.prototype.onNodeCreated=function(){orig?.apply(this,arguments);this.properties=this.properties||{};this.addWidget('button','OPEN UNWIN DIRECTOR',null,()=>openDirector(this));this.size=[340,170]}}}});

async function openStudio(){
 let d=document.getElementById('unwin-studio');if(d){d.remove();return}
 d=document.createElement('div');d.id='unwin-studio';d.style.cssText='position:fixed;z-index:100006;top:5vh;left:10vw;width:min(820px,85vw);max-height:88vh;overflow:auto;background:#1a2532;color:#eaf1f7;border:1px solid #7a93a9;border-radius:10px;padding:18px;box-shadow:0 10px 60px #000b;font:13px Arial';
 d.innerHTML=`<h2>Unwin Character & Location Studio <button id="studio-close" style="float:right">✕</button></h2><p>Save a single reference image and build a labelled reference sheet. Missing camera angles are placeholders until generated with a compatible image-edit workflow.</p><label>Asset type <select id="studio-kind"><option value="character">Character</option><option value="location">Location</option></select></label> <label>Name <input id="studio-name" placeholder="Character or location name"></label><p><input type="file" id="studio-file" accept="image/png,image/jpeg,image/webp"></p><p><textarea id="studio-desc" style="width:98%;height:85px" placeholder="Fixed identity / facial features / outfit, or architecture / lighting / geography"></textarea></p><button id="studio-create">Create reference sheet</button> <button id="studio-save">Save to project</button><p id="studio-status"></p><div id="studio-preview" style="display:flex;gap:8px;flex-wrap:wrap"></div><p><button id="studio-upscale" disabled>AI upscale selected reference (2×)</button> <button id="studio-apply">Add description to selected scene</button></p><h3>Supported image models / downloads</h3><p><a href="https://comfyanonymous.github.io/ComfyUI_examples/qwen_image/" target="_blank">Qwen Image Edit · reference-aware editing</a> · <a href="https://comfyanonymous.github.io/ComfyUI_examples/z_image/" target="_blank">Z-Image Turbo · location concepts</a></p><p><a href="https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI" target="_blank">Qwen Image Edit model files</a> · <a href="https://huggingface.co/QuantStack/Qwen-Image-Edit-2509-GGUF" target="_blank">Quantised image edit (GGUF)</a></p><button id="studio-verify">Validate local image model installation</button><pre id="studio-verify-result" style="white-space:pre-wrap"></pre><small>Image model links are documentation/download sources. Automated character angle generation requires an image-edit workflow and is not yet wired to the renderer. AI upscale uses installed local Real-ESRGAN.</small>`;
 document.body.append(d);const q=id=>d.querySelector('#'+id);let latest=null;

 // Built-in workflow generation. No imported JSON required. Query the actual installed ComfyUI node schemas.
 const extension=document.createElement('section');extension.style.cssText='margin:16px 0;padding:12px;border:1px solid #536779;border-radius:8px';
 extension.innerHTML=`<h3>AI image generation · Automatic workflows</h3><p>Select a model family, validate the installed nodes/models, and generate locally. No workflow JSON required.</p><label>Engine <select id="studio-engine"><option value="qwen">Qwen Image Edit (portrait → new views)</option><option value="zimage">Z-Image Turbo (text → image)</option></select></label><p><button id="studio-workflow-check">Detect models & validate workflow</button></p><label>Generation prompt <textarea id="studio-genprompt" style="width:98%;height:80px" placeholder="Photorealistic full body portrait, natural light..."></textarea></label><p><label>Resolution <select id="studio-image-size"><option value="768">768 × 768</option><option value="1024">1024 × 1024</option><option value="512">512 × 512 (low VRAM)</option></select></label> <label>Seed <input id="studio-image-seed" type="number" value="42" min="0"></label></p><p><button id="studio-generate">Generate image</button> <button id="studio-sheet">Generate 4-view character sheet</button></p><p id="studio-genstatus" style="white-space:pre-wrap"></p><small>Automatically assembles workflows using installed ComfyUI nodes. Qwen requires a reference portrait. Exact node interfaces vary across ComfyUI versions; validation reports unsupported installations before queueing. Review generated angles for identity drift.</small>`;
 d.insertBefore(extension,d.querySelector('#studio-preview'));
 let generated=[],workflow=null;
 const wq=id=>d.querySelector('#'+id);
 const selectFile=(arr,pattern,label)=>{const matches=arr.filter(x=>pattern.test(x));if(!matches.length)throw Error('Missing '+label+'. Install via Model Manager and refresh models.');return matches[0]};
 const nodeInputs=(info,name)=>{const x=info[name];if(!x)throw Error('Missing ComfyUI node '+name+'. Update ComfyUI Desktop or install its required node pack.');return {...(x.input?.required||{}),...(x.input?.optional||{})}};
 const choose=(schema,names,label)=>{for(const n of names)if(schema[n])return n;throw Error(label+' input unsupported by this ComfyUI version. Found: '+Object.keys(schema).join(', '))};
 const buildWorkflow=async(prompt,reference)=>{
  const engine=wq('studio-engine').value;
  const [info,models]=await Promise.all([api('/object_info'),api('/unwin/studio/available-models')]);
  const unet=selectFile(models.diffusion_models,engine==='qwen'?/qwen.*image.*edit/i:/z[_-]?image.*turbo/i,engine+' diffusion checkpoint');
  const clip=selectFile(models.text_encoders,engine==='qwen'?/qwen.*2[._-]?5.*vl.*7b/i:/qwen.*3.*4b/i,engine+' text encoder');
  const vae=selectFile(models.vae,engine==='qwen'?/qwen.*image.*vae/i:/^(ae|z_image.*vae).*\.safetensors$/i,engine+' VAE');
  const graph={};let next=1;
  const add=(class_type,inputs)=>{nodeInputs(info,class_type);const id=String(next++);graph[id]={class_type,inputs};return [id,0]};
  const model=add('UNETLoader',{unet_name:unet,weight_dtype:'default'});
  const clipSchema=nodeInputs(info,'CLIPLoader');const clipType=clipSchema.type?.[0]?.includes('qwen_image')?'qwen_image':(clipSchema.type?.[0]?.includes('lumina2')?'lumina2':'default');
  const textEncoder=add('CLIPLoader',{clip_name:clip,type:clipType,device:'default'});
  const decoder=add('VAELoader',{vae_name:vae});
  const size=Number(wq('studio-image-size').value)||768;
  let conditioning,latent;
  if(engine==='qwen'){
   if(!reference)throw Error('Qwen Image Edit requires a portrait. Upload and create a reference first.');
   const prepared=await post('/unwin/studio/prepare-input',{filename:reference});
   const inputImage=add('LoadImage',{image:prepared.filename});
   const className=['TextEncodeQwenImageEditPlus','TextEncodeQwenImageEdit'].find(x=>info[x]);
   if(!className)throw Error('Missing Qwen Image Edit conditioning node. Update ComfyUI Desktop to a release supporting Qwen Image Edit.');
   const schema=nodeInputs(info,className),inputs={};
   inputs[choose(schema,['clip'],'Qwen encoder')]=textEncoder;
   inputs[choose(schema,['image1','image'],'Qwen reference')]=inputImage;
   inputs[choose(schema,['prompt','text'],'Qwen prompt')]=prompt;
   if(schema.vae)inputs.vae=decoder;
   if(schema.image2)inputs.image2=inputImage;
   if(schema.image3)inputs.image3=inputImage;
   conditioning=add(className,inputs);
   latent=add('EmptySD3LatentImage',{width:size,height:size,batch_size:1});
  }else{
   conditioning=add('CLIPTextEncode',{clip:textEncoder,text:prompt});
   latent=add('EmptySD3LatentImage',{width:size,height:size,batch_size:1});
  }
  let samplingModel=model;
  if(info.ModelSamplingAuraFlow){samplingModel=add('ModelSamplingAuraFlow',{model,shift:engine==='qwen'?3:3});}
  const sampler=add('KSampler',{model:samplingModel,positive:conditioning,negative:add('ConditioningZeroOut',{conditioning}),latent_image:latent,seed:Number(wq('studio-image-seed').value)||42,steps:engine==='qwen'?20:9,cfg:1,sampler_name:'euler',scheduler:'simple',denoise:1});
  const decoded=add('VAEDecode',{samples:sampler,vae:decoder});
  add('SaveImage',{images:decoded,filename_prefix:'UnwinStudio'});
  // Check each generated input name against actual node schemas before queueing.
  for(const [id,node] of Object.entries(graph)){const schema=nodeInputs(info,node.class_type);const bad=Object.keys(node.inputs).filter(k=>!schema[k]);if(bad.length)throw Error(node.class_type+' unsupported inputs: '+bad.join(', '));}
  return graph;
 };
 const inspect=async()=>{const engine=wq('studio-engine').value;const ref=engine==='qwen'?latest?.reference:null;workflow=await buildWorkflow('Photorealistic studio portrait',ref);wq('studio-genstatus').textContent='Automatic '+engine+' workflow validated: '+Object.keys(workflow).length+' nodes. Models and node inputs detected.'};
 wq('studio-workflow-check').onclick=async()=>{try{await inspect()}catch(e){wq('studio-genstatus').textContent='ERROR: '+e.message}};
 const waitPrompt=async(id)=>{for(let n=0;n<1800;n++){await new Promise(r=>setTimeout(r,2000));const h=await api('/history/'+encodeURIComponent(id));const entry=h[id];if(entry){if(entry.status?.status_str==='error')throw Error('ComfyUI workflow failed: '+JSON.stringify(entry.status?.messages||[]).slice(-1200));const images=Object.values(entry.outputs||{}).flatMap(o=>o.images||[]).filter(x=>x.filename);if(images.length)return images}if(n%15===0)wq('studio-genstatus').textContent='Rendering '+id+' · '+(n*2)+' seconds elapsed'}throw Error('Workflow still not completed after 60 minutes; inspect ComfyUI terminal')};
 const generate=async(prompt,reference)=>{const graph=await buildWorkflow(prompt,reference);const r=await post('/prompt',{prompt:graph,client_id:window.name||'unwin-studio'});if(r.error||!r.prompt_id)throw Error('ComfyUI rejected generated workflow: '+JSON.stringify(r.error||r.node_errors||r).slice(0,1200));wq('studio-genstatus').textContent='Queued '+r.prompt_id;const imgs=await waitPrompt(r.prompt_id);return imgs[0]};
 const preview=(img,label)=>{const el=document.createElement('div');el.style.cssText='max-width:46%';const pic=document.createElement('img');pic.src='/view?filename='+encodeURIComponent(img.filename)+'&subfolder='+encodeURIComponent(img.subfolder||'')+'&type=output';pic.style.cssText='width:100%;max-height:320px;object-fit:contain';const cap=document.createElement('div');cap.textContent=label;el.append(pic,cap);wq('studio-preview').append(el)};
 wq('studio-generate').onclick=async()=>{try{const engine=wq('studio-engine').value;const prompt=wq('studio-genprompt').value.trim()||wq('studio-desc').value.trim();if(!prompt)throw Error('Enter a generation prompt');const ref=engine==='qwen'?latest?.reference:null;const img=await generate(prompt,ref);generated.push(img);preview(img,'Generated · '+engine);wq('studio-genstatus').textContent='Image generated. Review before saving.'}catch(e){wq('studio-genstatus').textContent='ERROR: '+e.message}};
 wq('studio-sheet').onclick=async()=>{try{if(wq('studio-engine').value!=='qwen')throw Error('Use Qwen Image Edit for reference-based character sheets');if(!latest?.reference)throw Error('Upload a master portrait and create its reference first');const base=wq('studio-desc').value.trim()||'same person as reference portrait';const views=[['Front portrait','front-facing head and shoulders, direct gaze'],['Left profile','strict left side profile, 90-degree angle'],['Full body front','full body head to toe, front-facing, neutral standing pose'],['Full body rear','full body head to toe, rear-facing, same outfit']];const imgs=[];for(let i=0;i<views.length;i++){wq('studio-genstatus').textContent='Generating '+(i+1)+'/4: '+views[i][0];const prompt=`Photorealistic reference sheet photograph of the EXACT SAME PERSON as input image. Preserve facial identity, age, hair, skin tone, body proportions and outfit. ${base}. ${views[i][1]}. Neutral studio light, plain gray background, single person, realistic anatomy, no text, no collage.`;const im=await generate(prompt,latest.reference);imgs.push(im);preview(im,views[i][0])}const result=await post('/unwin/studio/compose-sheet',{kind:'character',name:wq('studio-name').value,images:imgs,labels:views.map(v=>v[0])});latest.sheet=result.sheet;const el=document.createElement('img');el.src='/unwin/studio/image/'+encodeURIComponent(result.sheet);el.style.cssText='max-width:95%;max-height:520px';wq('studio-preview').append(el);wq('studio-genstatus').textContent='Four-view sheet created: '+result.sheet+' — inspect each angle for identity drift.'}catch(e){wq('studio-genstatus').textContent='ERROR: '+e.message}};
 q('studio-close').onclick=()=>d.remove();
 q('studio-create').onclick=async()=>{try{const f=q('studio-file').files[0];if(!f)throw Error('Select a reference image');if(f.size>18*1024*1024)throw Error('Image too large');const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(f)});const res=await post('/unwin/studio/reference',{kind:q('studio-kind').value,name:q('studio-name').value,image:data});latest=res;const box=q('studio-preview');box.replaceChildren();for(const name of [res.reference,res.sheet]){const im=document.createElement('img');im.src='/unwin/studio/image/'+encodeURIComponent(name);im.style.cssText='max-width:46%;max-height:320px;object-fit:contain';box.append(im)}q('studio-upscale').disabled=false;q('studio-status').textContent=res.note;logLine('Studio reference saved: '+res.reference)}catch(e){q('studio-status').textContent='ERROR: '+e.message}};
 q('studio-save').onclick=()=>{if(!latest){q('studio-status').textContent='Create a reference first';return}state.studioAssets=state.studioAssets||[];state.studioAssets.push({kind:q('studio-kind').value,name:q('studio-name').value,description:q('studio-desc').value,reference:latest.reference,sheet:latest.sheet});save();q('studio-status').textContent='Asset saved in project JSON. Keep studio_assets folder when updating the extension.'};
 q('studio-apply').onclick=()=>{const desc=q('studio-desc').value.trim();if(!desc||!state.shots[selected])return;state.shots[selected].prompt+='\n\nContinuity reference: '+desc;save();draw();q('studio-status').textContent='Description appended to current scene.'};
 q('studio-upscale').onclick=async()=>{if(!latest)return;try{const r=await post('/unwin/studio/upscale',{filename:latest.reference,scale:2});q('studio-status').textContent='Upscaling...';const poll=async()=>{const st=await api('/unwin/ai-upscale/status?job='+encodeURIComponent(r.job));q('studio-status').textContent=st.status+' '+st.progress+'% '+(st.error||'');if(st.status==='Complete'){const im=document.createElement('img');im.src='/unwin/studio/image/'+encodeURIComponent(st.output);im.style.cssText='max-width:46%;max-height:320px';q('studio-preview').append(im)}else if(st.status!=='Failed')setTimeout(poll,1500)};poll()}catch(e){q('studio-status').textContent=e.message}};
 q('studio-verify').onclick=async()=>{try{const x=await api('/unwin/studio/models');q('studio-verify-result').textContent=x.map(m=>`${m.installed?'✓':'✗'} ${m.label} — ${m.folder}\n${m.notes}`).join('\n\n')}catch(e){q('studio-verify-result').textContent=e.message}};
}
