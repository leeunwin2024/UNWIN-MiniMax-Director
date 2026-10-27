# UNWIN MiniMax Director

A locally operated **ComfyUI Desktop** video-directing and scene-building project for MiniMax H3 workflows.

> **Latest packaged build: v1.4.5 — Master & Scene Prompts.** This README describes the features developed through v1.4.5. Verify that the files you uploaded match that version; this documentation update does not modify the application code.

## Features

### Master prompt + per-scene direction (v1.4.5)
- Set a **Master Director Prompt** for the film's overall style, characters, locations, lighting, camera language and continuity.
- Add a distinct **sub-prompt** to every scene, describing only that scene's action and progression.
- The builder combines master direction, scene direction and continuity instructions into the final MiniMax H3 render prompt.
- Preview the combined prompt before rendering; scene-specific direction remains editable.
- Supports individual scene rendering and render-all workflows.

### Continuous soundtrack (v1.4.4)
- Use one music/audio track across the **final stitched video**, without restarting it at scene boundaries.
- Choose **Music only** or **Mix with scene audio**, with separate level controls.
- Optionally loop the music when the film exceeds the soundtrack duration.
- Common soundtrack formats include MP3, WAV, M4A, FLAC, OGG and AAC.
- **Limitation:** individual generated scene previews may still contain their own audio. Continuity is applied to the stitched output; AI-generated dialogue and effects do not inherently continue between scenes.

### Security and resilience (v1.4.3)
- Defensive JSON parsing and validation for timeline, cast and workflow state.
- Resolved asset paths and directory-boundary checks to reduce path traversal risk.
- Shell-free subprocess invocation for helper tools such as FFmpeg; cancellable long-running jobs may use `Popen`.
- Optional dependency import failures log warnings instead of preventing core registration where possible.

### Models and delivery (v1.4.2)
- MiniMax H3 Standard, Turbo and Fast model profile selection.
- Automatic model-component selection for supported profiles.
- Preview, 720p, 1080p and **2K (2560×1440) delivery** presets.
- Higher delivery resolutions use an upscale/export path; they are **not native 2K H3 generation**.

## Installation

1. Install and configure **ComfyUI** (including required H3 models and compatible custom nodes).
2. Download or clone this repository.
3. Locate the folder containing the extension's `__init__.py` and node implementation files.
4. Copy **that folder** into ComfyUI's `custom_nodes` directory. Avoid an extra nested folder level.
5. Install the Python dependencies required by your specific workflow and ensure **FFmpeg** is available if using soundtrack stitching.
6. Restart ComfyUI and check its startup log for missing models or dependencies.

For ComfyUI Desktop, use its configured user/custom-nodes location; this can differ from a standalone installation.

## Typical workflow

1. Create a project and set the **Master Director Prompt**.
2. Define characters, locations and a sequence of timed scenes.
3. Enter a scene-specific sub-prompt for each clip.
4. Review the combined render prompt and continuity settings.
5. Add a soundtrack if needed, and choose music-only or mixed-audio output.
6. Render individual scenes or all scenes, review the results, then **stitch completed** for final audio continuity.
7. Select the desired delivery resolution/export profile.

## Known limitations

- Text prompts alone cannot guarantee perfect character identity, camera continuity or chronological transitions across separate AI generations. Reference images and previous-frame workflows can improve results.
- A continuous master soundtrack is applied to the **final assembled video**; it is not automatically propagated into each source clip.
- FFmpeg and compatible models must be installed locally for their respective features.
- The package has not been validated against every ComfyUI Desktop, MiniMax H3, GPU or operating-system configuration.

## Version history

| Version | Main change |
| --- | --- |
| **1.4.5** | Master Director Prompt and per-scene sub-prompts |
| **1.4.4** | Continuous soundtrack for stitched video |
| **1.4.3** | JSON, filesystem, subprocess and import hardening |
| **1.4.2** | Resolution/delivery profiles including 2K |

## Project status

Community/development build. Back up your existing custom-node folder before updating and test the full workflow before production use.
