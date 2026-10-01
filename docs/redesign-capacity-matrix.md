# Redesign Capacity Matrix

Inspection date: 2026-09-30. UI-only work; no future tools or AI engines are implemented by this redesign.

## Status And Counting

- **Unverified (integrated)**: real controls and dispatch code exist; complete specification compliance and live AE execution are not established here. Do not count these as entirely new tools.
- **Partial**: an existing capability overlaps the specification but does not cover its complete workflow.
- **Planned**: no integrated equivalent was found in the inspected action inventory. This is planning status, not a button to ship.
- **Unverified**: evidence is insufficient to classify implementation.
- A specification is not necessarily one new tool. Presets, axis choices, guide show/hide, CRUD actions, navigation and settings are not counted as independent tools.
- Required browsing capacity is current distinct tool entries plus `max(35, distinct planned additions)`. AI specifications are tracked separately. Counts remain provisional until reconciliation is complete.
- Requirements below come from individual feature specifications, not their proposed styling, sample code, target windows, performance promises or implementation order.

Current integration evidence: [Tools markup](../views/tools.html), [tool dispatcher](../js/toolkit/toolkit.js), [workbench presentation index](../js/ui/toolkit-workbench.js). The [capability registry](../js/core/capabilityRegistry.js) is an older baseline, not a complete current inventory.

## Core Specifications

| Spec / Purpose | Category | Inputs And Context | Output / Feedback | Status And Evidence |
| --- | --- | --- | --- | --- |
| [01 Reel safe zone](../features/01_instagram_reel_safezone_guide.md): protect social-video content | Guides | Active comp; single toggle; bundled guide asset | Locked, render-safe overlay; asset/comp error; toggle state | Unverified (integrated): `toggle-ig-guide` control and dispatch |
| [02 Responsive text box](../features/02_responsive_text_box.md): follow changing text bounds | Text | Selected text; padding X/Y, radius, fill controls on generated layer | Parented background; selection/type validation | Unverified (integrated): `text-box`; panel exposes creation, not the generated layer's parameters |
| [03 Text splitter](../features/03_text_splitter.md): separate letters/words/lines | Text | Selected text; three modes; optional 1-3 frame stagger | Style/alignment-preserving layers, master null, retained original; completion/error | Unverified (integrated): `split-text`, stagger select; pixel-perfect host result not established |
| [04 Find and replace](../features/04_find_replace_text.md): edit repeated text | Text | Find, replacement, scope, case checkbox; comp/project text | Styled replacements; instance/layer count; one undo | Unverified (integrated): `find-replace` and all parameter fields |
| [05 Speed ramp](../features/05_instant_speed_ramp.md): preset time remapping | Timing | Selected video/precomp, current time; three preset choices | Four eased remap keys; unsupported-layer feedback | Unverified (integrated): `speed-ramp` with fast/punch/smooth modes |
| [06 Reverse playback](../features/06_reverse_video_playback.md): reverse selected footage | Timing | Selected remappable layers; no parameters | Reversed playback retaining in/out duration; error/completion | Unverified (integrated): `reverse-video` |
| [07 Compact remap](../features/07_compact_time_remap.md): clean remap keys | Timing | Selected layer with remap keys; no parameters | Frame-snapped deduplicated keys, trimmed out point; validation | Unverified (integrated): `compact-remap` |
| [08 Split at playhead](../features/08_split_layer_playhead.md): razor selected layers | Timing | Selected layers; current time inside layer bounds | Two segments preserving effects/parenting/expressions; result | Unverified (integrated): `split-playhead` |
| [09 Batch blend](../features/09_batch_blend_mode.md): change selected layer blending | Layers | Selection; blend option menu | Updated blend modes in one undo; validation/result | Unverified (integrated): `blend-mode`, `cs-wb-blend` |
| [10 Mirror / flip](../features/10_mirror_flip_layers.md): invert scale axis | Transform | Selection; horizontal/vertical option | Mirrored layers; preserve animated scale; validation/result | Unverified (integrated): `mirror` h/v; animated-scale preservation needs host verification |
| [11 Match comp size](../features/11_match_comp_size.md): fit layers to frame | Transform | Selected layers; stretch / proportional crop choice | Scaled layers; dimension/selection validation | Planned: comp-tree resize is not layer fitting |
| [12 Copy transforms](../features/12_copy_transform_layers.md): replicate master transform | Transform | At least two layers; source order; 2D/3D compatibility | Position, scale, rotation, opacity copied; skipped-target feedback | Planned: duplicate/alignment actions are not transform copying |
| [13 Layer sorting](../features/13_layer_reordering_sorting.md): reorder stack | Layers | Two or more layers; name/label/in-point/shuffle, direction | Reordered indices without timing changes; result | Planned: timeline sequencing changes timing, not stack order |
| [14 Track matte](../features/14_quick_track_matte.md): connect matte and target | Layers | Selected matte, underlying target; alpha/luma and inverted variants | Matte relationship; legacy-AE compatibility/error | Planned |
| [15 Auto labels](../features/15_auto_label_colors.md): color-code layer types | Layers | Active comp; no required panel parameters | Assigned AE labels by type; result; camera/light mapping unspecified | Planned: project folder organization is a different workflow |
| [16 Batch renamer](../features/16_batch_renamer.md): rename layers/project items | Layers | Scope; prefix/base/suffix/find/replace, start number and padding | Renamed selection; validation/result | Planned: library preset rename is not timeline/project batch rename |
| [17 Layer switches](../features/17_toggle_layer_switches.md): batch switch states | Layers | Selection; motion blur/3D/shy/guide states | Updated switches; result; solo/lock mentioned only in purpose | Planned: toggle FX and composition guides do not cover these switches |
| [18 Scatter](../features/18_random_collage_scatter.md): randomized collage | Transform | Selection; rotation and scale min/max, position jitter bounds | Randomized transforms; bounds validation/result | Planned |
| [19 Gridder](../features/19_gridder_matrix_layout.md): matrix arrangement | Transform | Selection; rows, columns, margin X/Y | Positioned/scaled layers; capacity and spacing validation | Planned: alignment buttons are not a grid arrangement |
| [20 Loop expression](../features/20_loop_expression.md): repeat animation | Animation | Keyframed properties or selected animated layers; cycle/pingpong | Loop expression; unsupported-property feedback | Planned; generic expression removal is not loop creation |
| [21 Hold keys](../features/21_hold_keyframes.md): stepped interpolation | Animation | Selected keyframes; no numeric input | Hold interpolation; missing-selection feedback | Planned: Flow Steps curve mode is not this selected-key conversion |
| [22 Copy expressions](../features/22_copy_paste_expressions.md): distribute source expressions | Animation | Source plus targets; selected property / transform scope needs clarification | Copied nonmatching expressions; skipped/matched feedback | Planned: clipboard image paste is unrelated |
| [23 Fit keys to work area](../features/23_fit_keys_work_area.md): retime a key span | Animation | Selected keys; comp work area | Proportionally retimed keys; empty/zero-span validation | Planned |
| [24 Random key timing](../features/24_randomize_key_timing.md): stagger animation | Animation | Selected layers; maximum jitter in frames | Per-layer random key offset; range validation/result | Planned: layer sequencing is not keyframe jitter |
| [25 Snap keys to markers](../features/25_snap_keys_to_markers.md): align animation with beats | Animation | Selected keys; comp/audio markers; five-frame threshold | Moved matching keys; unmatched/no-marker feedback | Planned |
| [26 Audio to keys](../features/26_audio_to_keyframes.md): amplitude controller | Audio | Audio layer; generated sensitivity/min/max sliders | Audio controller null; busy, unsupported audio and completion states | Planned |
| [27 Beat markers](../features/27_beat_detector_markers.md): BPM grid or peak detection | Audio | BPM or peak threshold; audio/work area; clear/update choice | Timeline markers; numeric validation, progress and result | Planned |
| [28 SFX library](../features/28_sfx_sound_library.md): preview and insert sounds | Audio | Search/categories; waveform; play/pause; asset and active comp | Sound at playhead; missing media, playback, import progress/error | Planned: existing template library is not a bundled audio catalog |
| [29 Aspect ratio](../features/29_aspect_ratio_switcher.md): resize composition | Composition | Four aspect choices; optional layer auto-scale | Resized comp; selection/result feedback | Partial: `aspect-ratio` integrated; optional auto-scale control absent |
| [30 Auto-trim comp](../features/30_auto_trim_comp_duration.md): remove unused duration | Composition | Active comp; enabled-layer endpoint or work area | Updated duration; empty content/invalid work-area feedback | Planned |
| [31 Project audit](../features/31_project_audit_scanner.md): inspect project health | Project | Project scope; scan and select-result actions | Missing footage/expression/unused counts; progress, empty/error report | Planned |
| [32 Offline placeholders](../features/32_missing_footage_placeholder.md): replace missing media | Project | Missing footage; replacement scope | Placeholder sources; replacement count/error; consequential-change confirmation surface | Planned |
| [33 Export frame](../features/33_quick_export_frame.md): save current PNG | Export | Active comp/current time; project directory or Desktop | Timestamped PNG; busy/error and open-location feedback | Planned: library preview generation is not this export workflow |
| [34 Backup save](../features/34_timestamped_backup_save.md): preserve project versions | Project | Saved project; timestamp/increment mode | Non-overwriting AEP copy; unsaved-project and filesystem feedback | Planned: template Save is not project backup |
| [35 Reduce project](../features/35_reduce_project.md): retain comp dependencies | Project | Active/selected comp scope; explicit confirmation | Reduced project; cancel/result/error states | Planned; destructive confirmation required by spec |
| [36 Essential Graphics](../features/36_essential_graphics_mogrt.md): expose properties | Export | Selected supported properties; active comp | Essential Graphics entries; added/skipped/error counts | Planned |
| [37 OneFramers](../features/37_oneframers_presets_engine.md): browse/apply visual looks | Effects | Search/category/favorite; layer or adjustment mode | Applied native-compatible recipe; unavailable/partial/error feedback | Partial: existing browser in [effects controller](../js/toolkit/effects.js); complete modes/favorites/fallback behavior not established; 106 recipes are not 106 tools |
| [38 Quick Dock](../features/38_custom_quick_dock.md): persistent pinned workspace | Productivity | 1-6 columns; reorder; external JSX, icon/color choices | Saved layout; missing script and execution feedback | Planned: custom dock not evidenced in current integration; extends browsing rather than adding one tool per pin |
| [39 Command palette](../features/39_command_palette_search.md): keyboard action search | Productivity | Ctrl/Cmd+K, query, arrow selection, Enter/Escape | Filtered actions; empty state, execution and focus restoration | Partial: [command palette](../js/ui/command-palette.js) uses all-word substring matching, not fuzzy matching; existing capability, not a future addition |
| [40 Depth extruder](../features/40_depth_extruder_25d.md): stacked 2.5D rig | Effects | Selected 2D text/shape/vector; depth slices, shading | Slices and master 3D null; selection/bounds validation, progress/result | Planned |
| [41 Data importer](../features/41_csv_json_data_importer.md): data-driven text/comps | Productivity | CSV/JSON file, column-to-layer mapping; duplicate-comp-per-row toggle | Generated/populated text or comps; parse preview, validation, progress/error | Planned; mapping table needs bounded scrolling |
| [42 2D rigging](../features/42_quick_2d_rigging.md): parent/joint chain | Rigging | Ordered selection of at least two layers | Joint controller nulls and parent hierarchy; selection/result feedback | Planned; parenting alone does not satisfy joint-controller requirement |

## AI Specifications (Separate Scope)

These are future UI requirements only. No local engine, model, worker, download, network integration or production AI action is added. Status is unverified against any non-toolkit experimental code; no integrated AI workflow was evidenced in the current production action inventory.

| Spec / Purpose | Category | Inputs And Context | Output / Feedback | Status And Evidence |
| --- | --- | --- | --- | --- |
| [AI-01 Local engine](../features/ai/01_ai_local_engine_architecture.md): offline processing foundation | Infrastructure | GPU/runtime availability; local task queue/lifecycle | Worker status, progress/ETA/frame count, unavailable/error states | Unverified; shared infrastructure, not a distinct browsing entry |
| [AI-02 Captions](../features/ai/02_ai_whisper_auto_subtitles.md): word-timed subtitles | AI / Text | Audio, language; font/case/highlight/background; SRT/VTT import/export | Caption layers; transcription preview, progress and failure feedback | Unverified; one future workflow, not one per caption style |
| [AI-03 Upscale](../features/ai/03_ai_upscale_realesrgan.md): increase footage resolution | AI / Video | Footage; 2x/4x; anime/real-world; replace/stack | Upscaled media; model availability, progress and output/import error | Unverified |
| [AI-04 Interpolation](../features/ai/04_ai_rife_frame_interpolation.md): generate intermediate frames | AI / Video | Footage; 2x/4x/8x; duplicate-frame filtering | Retimed high-frame-rate media; progress/error; target FPS versus multiplier needs clarification | Unverified |
| [AI-05 Object removal](../features/ai/05_ai_lama_object_remover.md): fill masked regions | AI / Video | Footage and named AE mask selection | Inpainted frames; missing-mask validation, preview, progress/import error | Unverified |
| [AI-06 Colorize](../features/ai/06_ai_colorizer.md): add color to monochrome footage | AI / Video | Footage; saturation and warmth ranges | Temporally consistent color video; preview, progress/error | Unverified |
| [AI-07 Depth map](../features/ai/07_ai_depth_map_extractor.md): estimate grayscale depth | AI / Video | Footage; 8/16-bit output | Depth pass for displacement/blur; progress/error | Unverified; referenced FEAT-20 is actually Loop Expression, not a Parallax Rig; dependency unresolved |
| [AI-08 Rotoscope](../features/ai/08_ai_roto_background_remover.md): isolate foreground | AI / Video | Footage; transparent ProRes 4444 or matte output | Alpha-bearing video/matte; preview, progress/import error | Unverified |

## Reconciled Capacity

The counted unit is a user-facing tool family, not a preset, axis, command-palette alias, CRUD operation or navigation route. This inventory establishes browsing size, not host correctness.

| Current Group | Distinct Families | Count | Integration Evidence |
| --- | --- | --- | --- |
| Toolkit | Anchor; Align; Create Layer; Organize Project; Toggle Effects; Precompose; Un-precompose; Purge Cache; Multi-Precompose; Sequence; True Duplicate; De-compose; Resize Comp Tree; Bounce; Comp Guides; Reel Safe Zone; Remove Expressions; Mirror; Blend Mode; Split at Playhead; Reverse; Speed Ramp; Compact Remap; Aspect Ratio; Text Box; Split Text; Find/Replace; Paste Image; Crop Precomp | 29 | Tools markup, dispatcher and workbench index linked above; crop has a dedicated control path |
| Specialized tools | Template Library; Saved Effect Presets; Text Animation Presets; OneFramers; Flow; ColorFlow | 6 | Existing view/controller integration; individual user assets and presets remain variable-size collections |

- Current tool families: **35**. Create-layer types, anchor positions and aspect/ramp choices are grouped as modes. Search/settings are infrastructure and excluded.
- Core specs 01-10 already have integrated actions; 29 and 37 partially overlap existing tools; 39 is existing search infrastructure with incomplete fuzzy matching.
- Core specs 11-28, 30-36 and 40-42 provide **28 planned script workflows**. Spec 38 adds **one planned workspace/dock**, not another script per pinned item.
- Conservatively counting the dock as a future browsing entry gives 29 additions. Required non-AI capacity is **35 + max(35, 29) = 70 entries**. The remaining six stress entries must be labeled repetitions of source-based fixtures, not invented production capabilities.
- AI adds **seven possible workflows plus one shared infrastructure spec**, outside the 35-script minimum. A separate 77-entry stress case may include them; their actual integration status remains unverified.
- No spec is certified fully implemented by this UI inspection. Planned status means no integrated equivalent in the inspected production action inventory, not proof that no experimental or host-only code exists anywhere.

## Reusable Parameter Patterns

| Pattern | Representative Specs | Layout Contract |
| --- | --- | --- |
| Simple action | 06, 08, 12, 15, 21, 36, 42 | One action, contextual validation and result; no permanently expanded empty form |
| Options / toggles | 05, 09-11, 13-14, 17, 20, 29-30 | Compact select or segmented mode group; wrap without reducing target size |
| Numeric fields / ranges | 18-19, 24, 26-27, 40 | Labeled controls with units/bounds; two-column fields reflow to one; values retained on resize |
| Text form | 04, 16 | Full-width text fields, compact numbering row, reachable action/footer |
| File / mapping | 33-34, 41 | Bounded file label, native picker action, mapping rows and error region; no shell-width growth |
| Media / preset browser | 28, 37 | Existing search/filter and scrollable entries; preview/playback separate from apply; unavailable-media state |
| Report / confirmation | 31-32, 35 | Scrollable results, explicit consequential action and reachable cancel/confirm |
| Long-running preview | AI-02 through AI-08 | Preview, progress/ETA, result/error; cancellation only where a future backend actually supports it |

Only the selected/expanded workflow should expose parameters. Categories stay within the content surface; adding tools must not add top-level rail buttons. Reuse current command discovery, preset browsing and form primitives instead of creating a new dispatcher or plugin framework. Capacity fixture entries must be disabled and must not write Settings/localStorage or invoke host code.

## Verification Boundaries

- Browser fixture results establish frontend layout and explicitly stubbed controller behavior only. They do not establish CEP/AE operation, undo, actual media import/save, DPI behavior or performance guarantees.
- The supported manifest minimum is 280 x 400. 240px width and 320px height are stress cases, not a newly promised supported minimum.
- Production data, localStorage and host callbacks must remain isolated from capacity fixtures.
- All 42 core and eight AI specifications have been inspected for functional requirements. Capacity checks below cover the palette and representative modal primitives, not a complete future dock, media browser or tool implementation. Matched reference evidence remains pending.

## Browser Capacity Checks

The isolated [preview fixture](../tests/fixtures/redesign-preview.html) loads the real command-palette renderer with disabled, fixture-only source controls. Use `?route=tools&width=280&height=400&capacity=1` for 70 entries or `capacity=ai` for 77. Production bootstrap scripts are removed; localStorage writes, Settings writes and the fixture host entry points throw rather than execute.

Recorded checks on 2026-09-30:

- Both datasets rendered their expected counts. The last row was reachable at widths 240, 280, 400, 550 and 800 without horizontal list overflow. The 77-entry sweep used a 320px panel height; this is stress coverage, not a revised supported minimum.
- Category group IDs were unique. Attempting the final disabled AI entry closed the palette and reported `Capacity: AI-08 Rotoscope is currently unavailable`. A direct storage-write attempt was blocked.
- The Mapping form's unbroken column label initially overflowed at 240px. Shared modal wrapping corrected it; the same five-width check then passed.
- A Renamer text value survived resizing to 240 x 320, and Escape removed its dialog. This does not yet establish focus restoration or every form's keyboard behavior.
- Focused Jest regressions passed: 3 suites, 120 tests covering category dialogs, settings accordion behavior and visual tokens. Editor diagnostics reported no errors in the modal stylesheet or preview fixture.

Still required: repeatable automated capacity coverage, a complete short/tall-height sweep of all parameter patterns, focus restoration, no-results behavior, populated media/report states and live CEP checks. These focused tests do not supersede the previously reported full-suite failures.