# Add project-aware multi-scene controls and a truthful local lip-sync readiness check.
# Run with ComfyUI Desktop closed. Creates backups; no model downloads.
$ErrorActionPreference='Stop'
$roots=@((Join-Path $env:LOCALAPPDATA 'Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\custom_nodes\Unwin-MiniMax-Director'),(Join-Path $env:LOCALAPPDATA 'Comfy-Desktop\ComfyUI-Shared\custom_nodes\Unwin-MiniMax-Director'))
$dir=$roots | Where-Object { Test-Path (Join-Path $_ 'web\audio-studio.html') } | Select-Object -First 1
if(-not $dir){$dir=(Read-Host 'Paste full UNWIN Director folder path').Trim('"')}
$htmlPath=Join-Path $dir 'web\audio-studio.html'
if(-not(Test-Path $htmlPath)){throw 'Cannot locate Audio Studio HTML'}
$stamp=Get-Date -Format yyyyMMdd-HHmmss
Copy-Item $htmlPath ($htmlPath+'.backup-'+$stamp)
$html=[IO.File]::ReadAllText($htmlPath)
if(-not $html.Contains('id="final-render-button"')){throw 'Final Render panel not installed. Install the previous GitHub integration first.'}
if(-not $html.Contains('id="unwin-multiscene-check"')){
 $old='<button id="final-render-button">'
 $new='<button id="unwin-multiscene-check" type="button">Check scene jobs</button><button id="unwin-lipsync-check" type="button">Check local lip-sync</button><button id="final-render-button">'
 if(-not $html.Contains($old)){throw 'Final Render button not found'}
 $html=$html.Replace($old,$new)
 $oldScript='</script>'
 $js=@'
$('unwin-multiscene-check').onclick=async()=>{
 try{
  if(!project)throw Error('Create or load a project first');
  const count=(project.shots||[]).length, jobs=project.render_jobs||{};
  const linked=Object.keys(jobs).length;
  status('Project has '+count+' planned scene(s), '+linked+' linked render job(s). Final Render automatically collects completed clips in shot order when the manual clips field is empty. For existing unrelated MP4s, enter their paths separated by commas.');
 }catch(e){status(e.message)}
};
$('unwin-lipsync-check').onclick=async()=>{
 try{
  const r=await fetch('/object_info');
  if(!r.ok)throw Error('ComfyUI object_info unavailable: '+r.status);
  const nodes=await r.json();
  const names=Object.keys(nodes).filter(k=>/lipsync|infinite.?talk|latentsync|wav2lip|musetalk|audio.?driven/i.test(k));
  status(names.length?'Potential lip-sync nodes detected: '+names.join(', ')+'. A configured workflow and matching models are still required; no lip-sync render has been performed.':'No compatible lip-sync node detected by name. Install and validate a suitable local lip-sync workflow before rendering.');
 }catch(e){status('Lip-sync check failed: '+e.message)}
};
'@
 if(-not $html.Contains($oldScript)){throw 'Audio Studio script closing tag missing'}
 $html=$html.Replace($oldScript,$js+$oldScript)
 $html=$html.Replace('â€”','—').Replace('â€¢','•')
 [IO.File]::WriteAllText($htmlPath,$html,[Text.UTF8Encoding]::new($false))
}
Write-Host 'Multi-scene status and lip-sync readiness controls installed.' -ForegroundColor Green
Write-Host 'Restart ComfyUI and open http://localhost:8188/unwin/audio-studio'
