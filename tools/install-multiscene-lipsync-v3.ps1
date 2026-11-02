$ErrorActionPreference = 'Stop'
$roots = @(
 (Join-Path $env:LOCALAPPDATA 'Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\custom_nodes\Unwin-MiniMax-Director'),
 (Join-Path $env:LOCALAPPDATA 'Comfy-Desktop\ComfyUI-Shared\custom_nodes\Unwin-MiniMax-Director')
)
$dir = $roots | Where-Object { Test-Path (Join-Path $_ 'web\audio-studio.html') } | Select-Object -First 1
if (-not $dir) { $dir = (Read-Host 'Full path to Unwin-MiniMax-Director folder').Trim('"') }
$file = Join-Path $dir 'web\audio-studio.html'
if (-not (Test-Path $file)) { throw 'Audio Studio HTML not found.' }
$html = [IO.File]::ReadAllText($file)
if (-not $html.Contains('id="final-render-button"')) { throw 'Existing Final Render button missing.' }
if ($html.Contains('id="unwin-multiscene-check"')) { Write-Host 'Already installed.'; exit 0 }
$backup = $file + '.backup-' + (Get-Date -Format yyyyMMdd-HHmmss)
Copy-Item $file $backup
$old = '<button id="final-render-button"'
$new = '<button id="unwin-multiscene-check" type="button">Check scene jobs</button><button id="unwin-lipsync-check" type="button">Check local lip-sync</button><button id="final-render-button"'
if (-not $html.Contains($old)) { throw 'Final Render button markup not found.' }
$html = $html.Replace($old,$new)
$js = @'
(function(){
  const scene=document.getElementById('unwin-multiscene-check');
  const lip=document.getElementById('unwin-lipsync-check');
  if(scene)scene.addEventListener('click',()=>{
    try{
      const p=typeof project!=='undefined'?project:null;
      if(!p)throw Error('Create or load a project first');
      const n=(p.shots||[]).length;
      const j=Object.keys(p.render_jobs||{}).length;
      alert('Project scenes: '+n+'. Linked render jobs: '+j+'. Leave manual clip paths blank for automatic collection, or enter completed clips in order.');
    }catch(e){alert(e.message)}
  });
  if(lip)lip.addEventListener('click',async()=>{
    try{
      const response=await fetch('/object_info');
      if(!response.ok)throw Error('ComfyUI node list unavailable: '+response.status);
      const nodes=await response.json();
      const matches=Object.keys(nodes).filter(k=>/lipsync|infinite.?talk|latentsync|wav2lip|musetalk|audio.?driven/i.test(k));
      alert(matches.length?'Possible lip-sync nodes: '+matches.join(', ')+'. Models and workflow still need validation.':'No lip-sync node found by name. Install a compatible local workflow before trying lip-sync.');
    }catch(e){alert(e.message)}
  });
})();
'@
$marker = '</script>'
if (-not $html.Contains($marker)) { throw 'Script tag missing.' }
$html = $html.Replace($marker,$js+$marker)
[IO.File]::WriteAllText($file,$html,[Text.UTF8Encoding]::new($false))
Write-Host 'SUCCESS: Added scene and lip-sync check buttons.' -ForegroundColor Green
Write-Host ('Backup: '+$backup)
Write-Host 'Restart ComfyUI Desktop.'
