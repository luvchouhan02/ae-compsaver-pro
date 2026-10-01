# 🚀 CompSaver — Master Features Roadmap & Implementation Backlog

> **Purpose:** Comprehensive feature backlog of all 36 high-value After Effects tools + 8 Local GPU AI Engines.  
> **Visual Reference Screenshots**: `C:\Users\luvch\Downloads\reffrence tool for design\` (60 real UI screenshots showing MNTOOLS tool visuals, cards, & states).  
> **Structure:** The **TOP 10 BEST KILLER FEATURES** (excluding SFX) are prioritized right at the top for immediate implementation.  
> **Status:** All 44 individual specification files generated. Ready for step-by-step execution.

---

## 🏆 TOP 10 BEST FEATURES (Highest Priority — Start Here)

Yeh 10 features video editors aur short-form/Reel creators ke liye **sabse zyada game-changing, instant aur daily-use** hain (SFX library ko last me rakha gaya hai):

| Rank | ID | Feature Name | Dedicated File | Kyu Best Hai? |
|:---:|:---|:-------------|:---------------|:--------------|
| 🥇 **#1** | **FEAT-01** | **Instagram Reel Safe Zone Overlay** | [01_instagram_reel_safezone_guide.md](./01_instagram_reel_safezone_guide.md) | Real buttons/profile/captions ka exact visual guide (Zero render export). |
| 🥈 **#2** | **FEAT-02** | **Responsive Auto-Resizing Text Box** | [02_responsive_text_box.md](./02_responsive_text_box.md) | Text ke peeche rounded box jo text badalne par automatically bada/chota hota hai. |
| 🥉 **#3** | **FEAT-03** | **Text Splitter (Letters, Words, Lines)** | [03_text_splitter.md](./03_text_splitter.md) | Kinetic typography ke liye text ko aksharon ya shabdon me alag-alag layers me todna. |
| 🏅 **#4** | **FEAT-05** | **Instant Velocity Speed Ramp** | [05_instant_speed_ramp.md](./05_instant_speed_ramp.md) | 1-click me video me cinematic slow-mo aur speed ramp lagana (Time Remap + Eased curves). |
| 🏅 **#5** | **FEAT-06** | **1-Click Reverse Video Playback** | [06_reverse_video_playback.md](./06_reverse_video_playback.md) | Timeline par video ko 1 click me ulta (reverse) chalana bina export kiye. |
| 🏅 **#6** | **FEAT-29** | **Aspect Ratio Preset Switcher** | [29_aspect_ratio_switcher.md](./29_aspect_ratio_switcher.md) | Kisi bhi comp ko 1 click me 9:16 (Reel), 16:9 (YouTube), ya 1:1 (Square) me convert karna. |
| 🏅 **#7** | **FEAT-04** | **Find & Replace Text Across Comps** | [04_find_replace_text.md](./04_find_replace_text.md) | Poore project ya active comp me kisi bhi word ko dhoond kar replace karna. |
| 🏅 **#8** | **FEAT-20** | **1-Click Seamless Loop Expression** | [20_loop_expression.md](./20_loop_expression.md) | Keyframed animation ko `loopOut("cycle")` se bina keys copy kiye hamesha chalana. |
| 🏅 **#9** | **FEAT-09** | **Batch Blend Mode Changer** | [09_batch_blend_mode.md](./09_batch_blend_mode.md) | Multiple layers ka blend mode ek click me Screen, Add ya Multiply me badalna. |
| 🏅 **#10** | **FEAT-10** | **1-Click Mirror / Flip Horizontal & Vertical** | [10_mirror_flip_layers.md](./10_mirror_flip_layers.md) | Footage, b-roll ya graphics ko 1 click me horizontally ya vertically mirror karna. |

---

## 🛠️ Remaining Essential Workflow Tools (#11 to #36)

### Video & Timeline Utilities
- **[FEAT-07]** [Compact Time Remap Cleaner](./07_compact_time_remap.md) — *Messy time remap keys ko 1-key-per-frame clean karna.*
- **[FEAT-08]** [Split Layer at Playhead (Razor Cut)](./08_split_layer_playhead.md) — *Playhead par selected layers ko razor cut karna.*
- **[FEAT-30]** [Auto-Trim Comp to Content / Last Layer](./30_auto_trim_comp_duration.md) — *Comp duration ko video ke end point par snap karna.*

### Layer Stacking & Batch Transforms
- **[FEAT-11]** [Match Composition Frame Size](./11_match_comp_size.md) — *Layer ko 100% comp me fit karna.*
- **[FEAT-12]** [Copy Transform Across Layers](./12_copy_transform_layers.md) — *Top layer ka position/scale baaki par copy karna.*
- **[FEAT-13]** [Layer Reordering, Sorting & Shuffle](./13_layer_reordering_sorting.md) — *Timeline me layers ko Name, Color ya In-Point se sort karna.*
- **[FEAT-14]** [Quick Track Matte Setup](./14_quick_track_matte.md) — *Luma/Alpha matte 1-click me lagana.*
- **[FEAT-15]** [Auto Label Color Assignment](./15_auto_label_colors.md) — *Text, audio, solids ko auto color-code karna.*
- **[FEAT-16]** [Batch Layer & Comp Renamer](./16_batch_renamer.md) — *Prefix, suffix aur auto-numbering ke saath rename.*
- **[FEAT-17]** [Toggle Layer Switches Batch](./17_toggle_layer_switches.md) — *Motion blur, 3D, Shy ko mass toggle karna.*
- **[FEAT-18]** [Random Collage / Scatter Generator](./18_random_collage_scatter.md) — *Random rotation/scale se collage banana.*
- **[FEAT-19]** [Gridder / Matrix Layout Tool](./19_gridder_matrix_layout.md) — *Layers ko 2x2, 3x3 grid me set karna.*

### Keyframe & Motion Design
- **[FEAT-21]** [Hold Keyframe Switcher](./21_hold_keyframes.md) — *Stop-motion / stepped keyframes.*
- **[FEAT-22]** [Copy-Paste Expressions Across Layers](./22_copy_paste_expressions.md) — *Expression ko ek layer se sabhi par paste karna.*
- **[FEAT-23]** [Fit Keyframes to Work Area](./23_fit_keys_work_area.md) — *Keyframes ko stretch karke work area me fit karna.*
- **[FEAT-24]** [Randomize Keyframe Timing](./24_randomize_key_timing.md) — *Organic animation ke liye key timings jitter karna.*
- **[FEAT-25]** [Snap Keyframes to Markers](./25_snap_keys_to_markers.md) — *Keyframes ko beat markers par snap karna.*

### Audio & Music Beats
- **[FEAT-26]** [Audio Amplitude to Keyframes Rig](./26_audio_to_keyframes.md) — *Music ke beat par pulsing/scale animation chalana.*
- **[FEAT-27]** [Audio Beat Detector & BPM Markers](./27_beat_detector_markers.md) — *Audio track par automatically beat markers lagana.*

### Project Health & Export
- **[FEAT-31]** [Project Audit & Health Scanner](./31_project_audit_scanner.md) — *Missing footage aur broken expressions dhoondna.*
- **[FEAT-32]** [Missing Footage Placeholder Solid](./32_missing_footage_placeholder.md) — *Offline footage ki jagah solid lagana taaki render na ruke.*
- **[FEAT-33]** [Quick Export Current Frame to PNG](./33_quick_export_frame.md) — *Current frame ka full-res PNG instant export.*
- **[FEAT-34]** [Timestamped Backup & Incremental Save](./34_timestamped_backup_save.md) — *Project ka instant timestamped backup banana.*
- **[FEAT-35]** [Reduce Project (Keep Selected Comps Only)](./35_reduce_project.md) — *Unused files clean karke project light karna.*
- **[FEAT-36]** [Essential Graphics / MOGRT Push](./36_essential_graphics_mogrt.md) — *Properties ko 1 click me Essential Graphics panel me bhejna.*

### Visual FX & Presets Suite
- **[FEAT-37]** [106 Instant "One-Framers" Visual FX & Style Presets Engine](./37_oneframers_presets_engine.md) — *106 programmatic visual looks (Glitches, Optics, Film Grain, Bloom, Retro) with zero .ffx dependencies.*
- **[FEAT-40]** [2.5D Depth Extruder & Bevel Rig](./40_depth_extruder_25d.md) — *Faux 3D depth extrusion for shape/text layers with stacked Z-slices.*

### Productivity, Data & Power-User Tools
- **[FEAT-38]** [Custom Floating Quick-Access Dock](./38_custom_quick_dock.md) — *Pin favorite tools, One-Framers, and custom external .jsx scripts.*
- **[FEAT-39]** [Universal Command Palette (Ctrl + K Search)](./39_command_palette_search.md) — *Spotlight search across all tools, presets & actions.*
- **[FEAT-41]** [CSV & JSON Data to Text Importer](./41_csv_json_data_importer.md) — *Import spreadsheets to generate animated text layers.*
- **[FEAT-42]** [Quick 2D Layer Rigging](./42_quick_2d_rigging.md) — *Hierarchical joint parenting for character limbs and cutouts.*

### Sound & Audio Assets (Kept at the Very End)
- **[FEAT-28]** [Built-in SFX Sound Effects Library](./28_sfx_sound_library.md) — *Pre-bundled sound effects library (Audio player & timeline drop) — Deferred to end.*

---

## 🧠 Local GPU Offline AI Suite (Zero Cloud)

> **Dedicated Sub-directory:** [`features/ai/`](./ai/README.md)  
> All neural networks run 100% locally on the user's GPU (Vulkan / DirectML / ncnn / C++). Footage NEVER leaves the machine.

| ID | Feature Name | Dedicated File | Engine | Status |
|:---|:-------------|:---------------|:-------|:-------|
| **AI-01** | Local AI Engine & Daemon Bridge | [01_ai_local_engine_architecture.md](./ai/01_ai_local_engine_architecture.md) | Vulkan / C++ Worker | ⏳ Ready |
| **AI-02** | Whisper Auto-Subtitles & Kinetic Captions | [02_ai_whisper_auto_subtitles.md](./ai/02_ai_whisper_auto_subtitles.md) | whisper.cpp | ⏳ Ready |
| **AI-03** | AI 4K Upscaler | [03_ai_upscale_realesrgan.md](./ai/03_ai_upscale_realesrgan.md) | Real-ESRGAN Vulkan | ⏳ Ready |
| **AI-04** | AI RIFE 60FPS Frame Interpolator | [04_ai_rife_frame_interpolation.md](./ai/04_ai_rife_frame_interpolation.md) | RIFE v4.6 Vulkan | ⏳ Ready |
| **AI-05** | AI Object & Watermark Remover | [05_ai_lama_object_remover.md](./ai/05_ai_lama_object_remover.md) | LaMa Inpainting | ⏳ Ready |
| **AI-06** | AI Black & White Colorizer | [06_ai_colorizer.md](./ai/06_ai_colorizer.md) | DeOldify Vulkan | ⏳ Ready |
| **AI-07** | AI 2D to 3D Depth Map Extractor | [07_ai_depth_map_extractor.md](./ai/07_ai_depth_map_extractor.md) | Depth Anything | ⏳ Ready |
| **AI-08** | AI Subject Roto & Background Remover | [08_ai_roto_background_remover.md](./ai/08_ai_roto_background_remover.md) | Robust Video Matting | ⏳ Ready |
