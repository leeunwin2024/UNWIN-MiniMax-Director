# Unwin MiniMax Director v0.3 — local prototype

A standalone ComfyUI extension based on the locally supplied ALLinONE MiniMax H3 T2V/I2V workflow templates. No external API calls. Does not require MiniMaxH3MotionContextSaveLatent, MiniMaxH3MotionContext or MiniMaxH3MotionContextTrim.

## Installation
Copy the `Unwin-MiniMax-Director` directory to your ComfyUI Desktop installation's `ComfyUI/custom_nodes` folder, restart ComfyUI Desktop, hard-refresh the browser. Add `Unwin Director Timeline` to a workflow, then click `OPEN UNWIN DIRECTOR`.

## Features implemented
- Scene timeline: add, duplicate, reorder, delete, edit direction, duration and seed; save project in node properties; import/export JSON.
- Local model scanner and selector; video/audio VAE and text encoder selection.
- Sequential rendering through the local ComfyUI `/prompt` endpoint using included T2V and I2V API templates; per-scene output tracking and rerender.
- Continuity: extract previous MP4's last frame with local FFmpeg, stage in ComfyUI input, and inject into next I2V graph when the installed I2V conditioning node advertises a compatible image input.
- Stitch locally using FFmpeg into output/unwin_director_*.mp4; trims no overlaps, discards clip audio in this first stitching backend.
- Detailed queue errors and a diagnostics log.
- Existing `Unwin Last Frame`, `Unwin Extract Video Frame` and `Unwin Local Video Stitch` standalone nodes.

## Limitations / preflight notes
This is a prototype, **not verified against your running ComfyUI**. It relies on installed ComfyUI MiniMaxH3ImageToVideo, MiniMaxH3ReferenceToVideo, MiniMaxH3SigmaShift, video/audio VAE and other template classes. The source package's I2V template does not include a first-frame connection by default. The director checks the installed conditioning node's input schema; if none of `start_image`, `image`, `first_frame`, `reference_image` exists, it stops with an explicit error rather than silently render without continuity. Some MiniMax H3 versions use keyframe conditioning instead; this needs adapting to your installed schema.

Model compatibility is **not automatically guaranteed**: choose the matching video model, CLIP, video VAE, and audio VAE. Fast/Turbo checkpoint defaults are not auto-calibrated. The prototype does not yet include LoRA application, latent upscale, audio-preserving stitching, scene thumbnail strip or a resumable background server worker. It supports 1–15 second scene controls but actual model frame limits may be lower. The browser must stay open during a multi-scene queue. FFmpeg must be on PATH. The UI is a modal launched from a node, not an independently docked editor.

## Testing
Start with one 3-second T2V scene and a valid local model quartet. Confirm a saved video. Then add a second scene and enable carry to test your installed I2V conditioning. If you get a schema error, send the text and `/object_info/MiniMaxH3ImageToVideo` schema to adjust the adapter.

## Safety
Original ALLinONE installation is not modified. All video paths are resolved inside ComfyUI's output folder. The director uses ComfyUI's local HTTP server only; no internet calls are made by this extension.

## v0.4 additions
- Optional model-only LoRA injection using local `LoraLoaderModelOnly`. LoRA must match the selected MiniMax checkpoint; file visibility does not establish compatibility.
- Experimental 2x latent scaling through `LatentUpscaleBy` before video VAE decode. **H3 video/audio latents may be incompatible with generic latent upscaling. Keep OFF until tested.** It does not upscale audio.
- Audio-preserving local FFmpeg stitching: each source is re-encoded to 48 kHz stereo AAC and H.264 at the selected frame rate; silent audio is generated for clips without an audio stream. This avoids dropping all audio during stitching. Source audio timing may need further validation.
- Optional final 2x FFmpeg Lanczos video enlargement (not neural super-resolution). This is the safer upscale choice for initial testing.
- No external inference services; the director uses only the local ComfyUI server.

**Testing status:** Python syntax checked. No access to the user's ComfyUI models or live H3 sampler; full rendering, LoRA compatibility, latent upscale and audio sync are not verified end-to-end. Do a one-scene test with latent upscale disabled first.

## v0.5 diagnostic fix
Execution errors now show the failing node ID, class and first error line instead of thousands of tensor values. This does not fix the underlying model/runtime error.


## v0.6 output discovery fix
The director now checks nested ComfyUI history output metadata and, if SaveVideo does not publish a video entry, searches the local ComfyUI output directory for the uniquely named render. This allows completed renders to populate the timeline. Restart ComfyUI after installing. This does not change the model workflow.


## v0.7 additions
- Minimise button collapses the director to a small floating bar, exposing the ComfyUI canvas; click again to restore.
- Rendered-scene filmstrip with independent playback before stitching.
- Local VRAM detection and an **installed-model-only** auto-selection heuristic for 8GB/16GB/higher GPUs. This is NOT an assertion that any given checkpoint/encoder combination is compatible; verify with a short test.
- Verify models/FFmpeg reports local files and whether paths resolve. Model downloads are **not** automated: arbitrary model URLs, licences, and compatibility must be verified before installing.
- Exact last-frame extraction from the final ~2 seconds (reverse filter), replacing approximate -0.5s extraction.
- Optional seam trim of one frame from each subsequent clip during stitching; this can reduce duplicated carried frames. It does not guarantee motion-perfect continuity.
- FFmpeg search checks PATH, imageio_ffmpeg if available, and common adjacent folders.

### Known limits
- Auto-selection cannot know exact model architecture from filenames and does not automatically download models.
- GPU memory recommendations are heuristics, not guaranteed render capacity.
- Seam trim removes a repeated frame, but different generated motion may still require blending/optical-flow processing.
- No actual ComfyUI GPU render was run in this packaging environment.


## v0.8 resolution and LoRA discovery

- Resolution presets: 640×352, 768×432, 960×544, 1280×720, and portrait equivalents; custom width/height supported. Dimensions validated as multiples of 16 before queueing. Higher presets may exhaust VRAM.
- LoRA dropdown lists locally installed LoRAs. A compatibility advisory flags filenames not clearly identified as MiniMax H3; filenames alone **cannot prove** compatibility.
- **Find H3 LoRAs / downloads** opens Hugging Face model search (https://huggingface.co/models?search=MiniMax%20H3%20LoRA). These are discovery links, not a curated or verified compatibility list, and do not install anything. Verify each model card, architecture, checkpoint, licence, and required trigger words.
- Install approved safetensors LoRAs under ComfyUI/models/loras and press Refresh models.
- Model downloads, automatic compatibility verification, and live GPU render testing are not included.

## v0.9: Save and Load Project

Use **Save Project** in the director header to name your project and download a `.unwin.json` file. The file contains the ordered scenes, prompts, durations, seeds, model/LoRA choices, settings, render statuses, and relative output references. **Load Project** opens a local `.json` file and restores the timeline. Existing projects are still stored in the ComfyUI node's workflow properties when you save the ComfyUI workflow.

**Important:** A project JSON is not a media archive. Rendered video previews will only work while their original MP4 files remain in the ComfyUI output directory at the same relative paths. Export the videos separately when moving projects between machines. Loading a project replaces the current timeline; save the current project first.

## v1.0 Model Manager
The director toolbar now includes **Model Manager**. The catalogue uses fixed, reviewed
Hugging Face repository/file URLs, rather than filename guessing. Downloads are opt-in,
use HTTPS, stream to a temporary file in the correct ComfyUI models folder, validate the
safetensors header, and atomically rename only after successful completion. One listed
LoRA has a published SHA-256 in the registry, and its hash is checked on installation;
other files use structural checks only and are explicitly NOT described as hash-verified.
Click Verify to run the available checks. The manager polls for progress every 2.5 seconds.
Download jobs live in ComfyUI's Python process; restarting ComfyUI interrupts a download.
The manager does not promise that a model fits 8GB or 16GB VRAM. It does not automatically
accept model licenses, authenticate to gated repos, or support pause/resume.


## v1.0.1 timeout hotfix
- Increased frontend history wait from 24 to 90 minutes for slower MiniMax H3 renders.
- Records queued prompt ID in project state and logs waiting status every minute.
- A timeout does not cancel a ComfyUI render. Check ComfyUI queue and console before retrying.
- Does not change model inference speed or solve a stalled sampler/OOM.


## v1.0.3: Offline AI Video Upscale

The **AI Video Upscale** toolbar button processes any rendered scene or the latest stitched project using the **optional external Real-ESRGAN NCNN Vulkan** executable. It runs fully locally; no cloud API. The engine is **not bundled** and must be installed separately from the official releases: https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/releases . Download the Windows package including the `models` folder. Either put `realesrgan-ncnn-vulkan.exe` on PATH, place it at `Unwin-MiniMax-Director/tools/realesrgan-ncnn-vulkan.exe` (with the `models` folder beside it), or set `UNWIN_REALESRGAN_EXE` to the full executable path before starting ComfyUI.

Choose **realesrgan-x4plus** for photorealistic scenes; 2× output is recommended as a starting point. The manager extracts all frames to a temporary directory, runs Real-ESRGAN on the GPU, then re-encodes H.264 and copies the original audio. The temporary directory is deleted after the job. Requires significant temporary disk space, and long clips can take time. The model must exist in the Real-ESRGAN package's `models` directory. Status and per-frame progress are displayed in the upscale dialog. The resulting MP4 is saved to ComfyUI output.

For photorealistic character consistency, use a locked character description (age, hair, eye colour, wardrobe, distinctive features) repeated verbatim in every scene, image-to-video with a reference frame, consistent lighting and camera settings, and minimal changes between shots. Frame carryover alone cannot guarantee facial identity. AI upscaling sharpens frames but does not repair inconsistent faces, poor hands, or temporal flicker.

## v1.0.4 Character / Location Studio

Click **Character / Location Studio** in the director toolbar. Upload a PNG/JPG/WebP reference (18MB max), enter a name and a fixed character/location description, then click **Create reference sheet**. This creates a labelled contact sheet with the source reference and marked placeholders for angles that are not available. It **does not fabricate new viewpoints**; those require an image-edit workflow. Click **Save to project** to retain metadata in exported `.unwin.json`. The actual images are saved to `studio_assets/` inside this custom node folder. Back up this directory when updating; JSON alone does not embed image bytes.

**Add description to selected scene** inserts the identity/location description into the current video scene prompt. This is a prompt aid, not a trained identity lock or true H3 image reference conditioning. Use the existing I2V start frame to reinforce consistency. The **Validate local image model installation** control checks six exact ComfyUI model filenames. It does not test model compatibility at inference time. Download/documentation links for Qwen Image Edit and Z-Image are provided in the Studio window; automated image generation and automated downloads for those models are NOT yet implemented.

**AI upscale selected reference (2x)** sends the saved source image through the portable Real-ESRGAN Vulkan executable, using tile size 128 to reduce peak GPU usage. The original is preserved. If GPU memory remains insufficient, use the executable manually with `-t 64`. AI enhancement may invent texture or subtly alter facial details, so keep the original reference as the source of identity.

### Install Real-ESRGAN on Windows 11 (portable, no Python install)

1. Download the official portable Windows ZIP: https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip
2. Extract it (do not run it from inside the ZIP). Keep the `models` folder beside `realesrgan-ncnn-vulkan.exe`.
3. Copy **both** `realesrgan-ncnn-vulkan.exe` and its entire `models` directory to `ComfyUI/custom_nodes/Unwin-MiniMax-Director/tools/` (create `tools` if necessary).
4. Restart ComfyUI Desktop. The director's AI Video Upscale button should detect the engine, and Character / Location Studio image upscaling uses the same executable.
5. To test manually in PowerShell, change to the folder containing the executable and run:

   `./realesrgan-ncnn-vulkan.exe -i "C:\\path\\to\\photo.png" -o "C:\\path\\to\\enhanced.png" -n realesrgan-x4plus -s 2 -t 128`

   For memory problems use `-t 64`. This is image enhancement, not guaranteed identity preservation.

Official README: https://github.com/xinntao/Real-ESRGAN/blob/master/README.md

**Compatibility:** image-edit models need their own separate ComfyUI graph. This release validates installation and manages reference images, but does not automatically render six newly imagined character angles or generate new locations using Qwen/Z-Image. It avoids silently substituting resized/cropped copies as synthetic viewpoints.


## v1.0.5 native ComfyUI image workflow bridge

Character/Location Studio now imports **API-format** ComfyUI workflow JSON files (enable Dev Mode > Save API Format, or use workflow export as API JSON). It runs the graph locally using ComfyUI's `/prompt` and `/history` endpoints. You must select the appropriate prompt node and, for Qwen reference edits, a `LoadImage` node in the graph. For Z-Image, choose the Z-Image engine and import a compatible text-to-image workflow. For Qwen, import a compatible Qwen Image Edit workflow and select the LoadImage that feeds the reference image. The **Generate 4-view character sheet** action runs four Qwen image edits and assembles a real generated sheet. It is not guaranteed to preserve exact facial identity. Image-model downloads and validation remain on the Studio and Model Manager pages; workflow import is needed because the available model variants use different ComfyUI node graphs. Images are generated to the ComfyUI output folder; sheets go into `studio_assets`. Back up `studio_assets` on upgrade.


## v1.0.6 automatic image workflows

Character Studio now builds ComfyUI API graphs locally for Qwen Image Edit and Z-Image Turbo without importing JSON. It detects model filenames from ComfyUI folders and checks node input names using `/object_info`. This is an initial built-in graph template; actual model inference compatibility varies by ComfyUI version, especially Qwen Image Edit conditioning/latent interfaces. Use **Detect models & validate workflow** before rendering. The generator does not download models automatically; use Model Manager.


## v1.0.7 scene references
Character/Location Studio has been removed from the Director toolbar. Each scene now has optional character and location/scene reference image uploads, saved in the existing `studio_assets` folder and referenced in project JSON. Uploaded images use the existing local reference and input-preparation endpoints.

**MiniMax H3 limitation:** Its I2V graph currently accepts one starting image. The scene/location reference takes precedence over the character reference, which takes precedence over last-frame carryover. When both are provided, the character image is retained for visual reference but **not** sent as a second image conditioning input. T2V automatically switches to I2V when an image is present. To continue from the preceding clip instead, remove the explicit scene references. Keep the `studio_assets` folder when upgrading or moving projects.


## v1.0.8 — Character continuity per scene

For Scene 2+, upload a **character reference**, enable **Use character continuity**, then click **Prepare / regenerate continuity frame**. The director extracts the previous rendered scene's last frame and uses Qwen Image Edit's two-image conditioning (image1=last frame, image2=portrait) to produce an identity-corrected starting frame. Preview it and render the scene. A separate **Discard prepared frame** action restores the original handoff workflow.

Requires Qwen Image Edit checkpoint, compatible encoder/VAE and ComfyUI's two-image Qwen editing node (`image2` input). Identity strength is prompt guidance, **not a numerical conditioning weight**. Qwen may change pixels beyond the face, so review joins carefully. The approved image is stored in `studio_assets`; back up that folder. No automatic character edits happen during video rendering.


## v1.0.9 hotfix — FFmpeg and I2V preflight
- AI upscale uses `-fps_mode passthrough` rather than legacy `-vsync 0`, with fallback for FFmpeg builds lacking that option.
- Image-to-video now normalises uploaded references and extracted last frames to the selected video size using ComfyUI `ImageScale` (Lanczos, centre crop).
- I2V preflight rejects width/height not divisible by 64 before GPU sampling. Recommended working test sizes: 960×512, 1024×576, 1280×704. Export exact 1280×720 after rendering/stitching if needed.
- The preflight reduces a known source of MiniMax `patchify_video` reshape errors; checkpoint-specific conditioning bugs may still require a further fix.
- Scene videos and projects are not modified by installing this patch. Back up the existing extension folder and project JSON first.


## v1.1.1 — 1024 × 576 and Real-ESRGAN Install & Verify

New projects start at 1024 × 576. Auto-select on 16 GB VRAM also uses 1024 × 576. Existing saved projects retain their resolution; select the 1024 × 576 preset to change them.

Open **AI Video Upscale** → **Verify Real-ESRGAN** or **Install / Repair Real-ESRGAN**. The installer downloads the official portable Windows ZIP from the Real-ESRGAN GitHub release, installs the executable and photorealistic/anime `.param` and `.bin` model pairs into `tools/`, and validates presence and nonzero file size. Download progress is displayed. The installation requires internet access; inference remains fully local.

Verification checks file existence and size, **not** SHA-256 authenticity or GPU execution. The installer does not install FFmpeg.


### v1.1.2 AI upscale reliability hotfix
- Real-ESRGAN runs in batches of eight frames, forced to NVIDIA Vulkan GPU 0 (`-g 0`).
- Each batch has a 180-second watchdog; retries at tile sizes 128, 64 and 32.
- Stdout/stderr are continuously drained to prevent subprocess pipe deadlocks.
- Upscale cache is stored under `output/unwin_ai_cache/<hash>` next to the source video, so a retry resumes completed frames.
- The AI upscale dialog has a Cancel Upscale button and an ETA based on completed batches.
- A job that was already running under an older version cannot be resumed in place; restart ComfyUI and start a new upscale.
- GPU index 0 must be the NVIDIA GPU; check Real-ESRGAN's device list if your device order differs.
- Cache may use substantial disk space; delete `unwin_ai_cache` folders when finished.


## v1.1.5 — AI Upscale Quality Review

AI upscaling now uses a new versioned cache (old enhanced frames are not reused), attempts whole-frame Vulkan processing first (`-t 0`) and falls back to 256 or 128 pixel tiles if needed. A first-batch preview compares original and enhanced PNG frames. Approve to continue processing or reject to stop before encoding. Turn off preview review if unattended processing is needed. Quality approval is visual; the tool does not automatically detect every possible image artifact.


## v1.3 advanced models and render settings

The Model Manager includes one-click downloads for MiniMax H3 Realism People, LightX2V ComfyUI 4-step, FastVideo VSA LoRA + gate, and Semantic Bridge. These are downloadable weights, not automatic dependency installers. Review model licenses and available disk space before downloading.

Multi-LoRA stacking is functional for compatible ordinary H3 LoRAs through chained `LoraLoaderModelOnly` nodes, with global and per-scene stacks, order, enable toggles, and strengths. Legacy single-LoRA settings remain available when the stack is empty. Scene data persists with the project.

LightX2V preset sets 4 sampling steps and requires the selected 4-step LoRA in the active stack. Kijai recommends around 0.75 strength for the v0.1 conversion. Results vary with sampler and base model. Avoid mixing Turbo LoRAs.

FastVideo VSA and Semantic Bridge have model download entries and per-scene settings, but the actual gate/adapter workflow injection depends on the installed companion custom node's exact API. In this release, requesting those adapters blocks the render with an explicit error instead of silently producing a base-model render. Their full inference integration is NOT claimed or verified. FastVideo VSA specifically requires a matching pruned INT8 FL2VA base, a custom node, its dependencies, the LoRA and the gate. VSA and Semantic Bridge are not regular stackable LoRAs.

Qwen continuity, scene timeline, save/load, Render All and CUDA/Lanczos upscale are preserved from v1.1.8.

Sources:
- https://huggingface.co/fal/MiniMax-H3-Realism-People-LoRA
- https://huggingface.co/Kijai/MiniMax-H3_comfy/tree/main/loras
- https://huggingface.co/barelymining/ComfyUI-MiniMax-H3-FastVideo
- https://huggingface.co/speach1sdef178/MiniMax-H3-Semantic-Bridge

## v1.3.1 — Wired experimental adapter graphs

VSA is now connected: `LoraLoaderModelOnly` (FastH3 v5 at 1.0) → `H3VSA` (gate, topk, min_tokens 4096, CPU-streamed gates) → `MiniMaxH3SigmaShift`, with 4 steps, Euler, simple scheduler. Requires pruned INT8 FL2VA checkpoint, both files and `ComfyUI-MiniMax-H3-FastVideo` custom node plus the `vsa` package. GPU memory requirements from upstream are ~22GB for a 5-second 0.8MP render; 16GB is likely to run out of memory. Use short low-resolution tests and expect experimental issues.

Semantic Bridge is now connected using the author's `MiniMaxH3DistilledImageToVideo` node, which replaces the template's conditioning node and accepts optional first_frame; alpha and per_token matching are passed. Requires installed `MiniMax-H3-Semantic-Bridge` custom node and adapter file. This uses FL2VA first-frame/text-conditioned paths, not Ref2VA; avoid for reference-audio/lip-sync. VSA and Semantic Bridge cannot currently be combined in the same scene.

Neither backend has been executed against the user's local ComfyUI installation. The UI checks installed node schemas and model filenames, but upstream version differences or GPU memory limits can still cause errors.

## v1.3.2 — Sol-Attention instead of SageAttention

New `Sol-Attention` acceleration choice uses the upstream MiniMax-specific
`MiniMaxH3MemoryEfficientSolAttentionPatch` node (NOT the generic Sol node).
It is inserted after the LoRA stack and before `MiniMaxH3SigmaShift`, with
tau=1.3, min_tokens=4096, strict=false, thresh_type=diag,
int8_qk=false, int8_pv=false, sink_conditioning=exact_kv,
dense_blocks=0-2,-1. Uses native dense attention for unsupported cases;
does NOT install, invoke or require SageAttention. Scene-specific tau is saved.
LightX2V Turbo may be selected separately in the acceleration selector, but
there is not yet a combined LightX2V+Sol preset; do not claim both active
simultaneously.

Install https://github.com/Saganaki22/ComfyUI-sol-attn and dependencies
into the ComfyUI Desktop Python environment, then restart. Model Manager's
LoRA downloads are unchanged. SageAttention is intentionally NOT a fallback.
On RTX 5060 Ti (sm_120), documented SageAttention issues include KJNodes'
"not new enough or cannot determine CUDA architecture" with PyPI 1.0.6,
CUDA illegal/misaligned address and driver-level device loss in some kernels.
Do not force SageAttention kernels to diagnose a failed render. If Sol fails,
choose Base attention and inspect the ComfyUI terminal stack trace.

Static syntax checks pass; GPU runtime rendering is untested.


## v1.4.0 H3 model and resolution profiles
- Model Manager: FastVideo FastH3 V2 diffusion checkpoint, shared INT8 video VAE and official H3 Turbo LoRA. Model downloads are user-triggered and use the existing allowlisted HTTPS downloader. Check the MiniMax open-weight territorial licence before downloading.
- Presets: Standard H3 20-step, Standard H3 Turbo 8-step (requires matching official LoRA), FastH3 V2 8-step (separate checkpoint, no LoRA).
- Resolution profiles: preview 1024×576; 720p class 1280×704 (I2V patch-safe); 1080p delivery starts at native 1344×768, then requires a separate upscale/export to 1920×1080. Native 1080p is NOT supported by local H3.
- FastH3 V2 uses `res_multistep`, `simple`, 8 steps, sigma shift video=10/audio=3. Sparse attention is optional and NOT injected automatically; official FastH3 workflow should be used when sparse attention is required.
- Not GPU-render tested. Existing Qwen and timeline features preserved.


## v1.4.1 — automatic H3 model selection
Selecting a render preset now matches **installed** diffusion, H3-specific text encoder, video VAE and audio VAE files, and sets the preset sampling steps. Missing components are reported in the builder instead of silently selecting an unrelated checkpoint. It does not download weights or change ComfyUI model files. The Model Manager remains the explicit download mechanism.

**Recommended for RTX 5060 Ti 16GB:** FastH3 V2 INT8 diffusion, H3 Qwen3VL 32B NVFP4 AWQ encoder, H3 video VAE INT8, H3 audio VAE FP32; 8 steps, 1024×576 preview, and 1280×704 for higher resolution. Model offloading and ample system RAM are essential; this is not a guaranteed 16GB fit. FastH3 V2 is for T2V and first/last-frame I2V, not multi-reference conditioning.


## v1.4.2: 2K delivery preset

Select **2K delivery · 2560 × 1440** in the output resolution profile selector. The renderer intentionally uses **1344 × 768** (the established local H3 generation ceiling) and preserves the existing H3 Standard, Turbo and FastH3 model auto-selection. After rendering, use **AI Video Upscale** and resize/crop the result to **2560 × 1440** as needed. This is **2K delivery, not native 2K diffusion**. The profile does not automatically upscale or export at 2560 × 1440.


## v1.4.3 security and reliability hardening
- Safe bounded JSON decoding for timeline, cast and clip state; malformed state yields clear validation errors.
- Resolved path boundary checks for ComfyUI input/output and studio assets (including symlinks).
- FFmpeg and other subprocesses are invoked with argument lists and `shell=False`; existing cancellable long-running jobs retain `Popen`.
- Optional AI upscaling and studio routes log warnings on missing dependencies rather than preventing core node registration.
- Note: full live ComfyUI GPU/integration testing is still required.


## v1.4.4 — Continuous soundtrack across scene joins

The director now supports uploading a full-length project soundtrack from the panel.
After rendering all scenes, choose **Stitch completed**. FFmpeg first joins the video clips,
then applies the song **once across the full joined timeline**, avoiding the common
problem of music restarting at each scene. Choose **Music only** or **Mix with generated
scene audio**, and adjust both volume levels. Music loops by default if shorter than the
video. Uploaded files are confined to the ComfyUI output/unwin_director/soundtracks
directory, validated for an audio stream, and limited to 80 MB.

**Important:** This synchronises an imported song in the final export; it does not
make MiniMax generate acoustically continuous audio across independently rendered scenes,
nor does it automatically align scene cuts to musical beats. Individual scene previews
continue to play their generated audio; the continuous soundtrack is audible in the
final stitched video.


## v1.4.5 — Master Director Prompt + scene sub-prompts

The Master Director Prompt in the scene editor stores a project-wide visual and narrative brief. Each scene has its own action/direction sub-prompt. At render time, both are combined with explicit sequential continuity instructions for T2V and I2V, including when rendering all scenes. Preview combined render prompt shows the exact text sent to H3 in the live terminal. The master prompt is saved in the project state and can be changed without overwriting scene prompts. This is **prompt-level** continuity: it cannot guarantee identity, voices, or seamless generated audio across independent H3 clips. Use carry-last-frame and the continuous soundtrack for additional continuity.
