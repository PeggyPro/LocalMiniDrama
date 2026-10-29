# Video planning implementation contract

This document coordinates the current implementation. Existing `backend-node/scripts/**` and `backend-node/comfyui-bridge/**` are read-only. Existing uncommitted edits must be preserved. No external text/video generation is authorized merely by implementing this feature. Use mocks and local tests first; do not submit GPU jobs automatically.

## Ownership

- Planning worker: new `backend-node/src/services/videoWorkflowCatalog.js`, `videoPlanningService.js`, `backend-node/src/routes/videoPlanning.js`, and their tests. Owns planning schema helper. Do not edit existing services or route index.
- Execution worker: new `backend-node/src/services/videoPlanExecutionService.js`, helper modules for media/latent, and their tests; can extend existing `comfyUIVideoClient.js` preserving its preexisting edits. Owns execution schema helper. Do not edit existing `videoService.js`, app, migration, or route index.
- UI worker: `frontweb/src/views/FilmCreate.vue`, new planning components/API/utilities/tests. Do not edit existing AIConfigContent/comfyUIConfig/videoOmniSupport files (preexisting changes).
- Captain: existing episode/storyboard generation hooks, migrations, route registration, app startup, legacy video-entry protection, selected-media/export integration, and integration tests.

## HTTP contract (under /api/v1)

Routes module `videoPlanning.js` exports `(db,cfg,log) => express.Router()` mounted at `/video-planning`.

- GET `/capabilities`: `{version,items:[{model_id,label,family,stage:'single'|'first'|'continue',continuation_model,requires_latent,produces_latent,availability,blocking_reasons,...}]}`. Static registration must not be described as proven GPU compatibility.
- GET `/episodes/:episodeId`: `{items:[{storyboard_id,recommendation,choice,validation,selected_version_id,last_execution}],capabilities_version}`.
- POST `/episodes/:episodeId/recommend`: update recommendations on existing IDs (not regenerate storyboards), preserving manual locks. May call an LLM using bounded catalogue/source context. No GPU work. Return same shape as GET. Explicitly distinguish heuristic fallback from AI if implemented.
- PUT `/storyboards/:id/choice`: `{expected_revision,model_id,source_ref,manual_locked:true|false}`; CAS 409 on conflict. source_ref null for single/first; continue uses `{kind:'version',version_id,tail_segment_id?}` or `{kind:'storyboard',storyboard_id,choice_revision}`. Manual locking does not bypass validation. Restoring follow recommendation is explicit.
- GET `/sources?drama_id=...`: `{storyboards:[...],versions:[...]}` within same drama, stable IDs, explicit eligibility/reasons.
- POST `/plans/preview`: `{episode_id,storyboard_ids,config_id?,inputs?:{[storyboardId]:{prompt,duration,aspect_ratio,first_frame_url,last_frame_url,reference_image_urls,...}},append_version_id?}`. Return frozen finite plan `{id,revision,status,nodes:[{id,storyboard_id,model_id,source_ref,status,blocking_reasons,...}],...}`. Creating a preview does not submit GPU work or generate previous episodes implicitly.
- POST `/plans/:id/run`: `{expected_revision}`. Validate revisions and run only frozen nodes; `{id,status,nodes,...}`.
- GET `/plans/:id`: current durable state.
- POST `/plans/:id/resume`: resume known attempts; never blind-resubmit unknown submissions.
- GET `/storyboards/:id/versions`: `{items:[{id,storyboard_id,model_id,tail_segment_id,video_url,local_path,duration,status,continuable,...}]}`.
- PUT `/storyboards/:id/adoption`: `{expected_revision,version_id}` stores explicit selection; ordinary selection compatibility handled by captain. Return updated planning DTO.

Error responses use the existing response envelope and HTTP 400/404/409. No silent fallback for a selected invalid model or source.

## Planning service interface

Export `ensureVideoPlanningSchema(db)`, `getStoryboardVideoPlan(db,id)`, `getEpisodeVideoPlans(db,episodeId)`, `setVideoChoice(db,id,body)`, `invalidateStoryboardVideoPlan(db,id,reason)`, `getPlanningPromptContext(db,episodeId,options)`, and `applyStoryboardRecommendations(db,episodeId,rawStoryboards,options)`. Additional helpers allowed, report exact final exports to captain.

DTO: `{storyboard_id,recommendation:null|{model_id,reason,predecessor?,...},choice:null|{model_id,source_ref,manual_locked,revision},validation:{state:'unplanned'|'draft'|'ready'|'waiting_dependency'|'blocked'|'stale',blocking_reasons:[]},selected_version_id:null|string,last_execution:null|object}`. Return validation separately from static catalogue availability. `getEpisodeVideoPlans` returns `{items,capabilities_version}`.

`getPlanningPromptContext` supplies a bounded instruction block plus allowed source keys. LLM recommendation nested in each storyboard (`video_recommendation`), never a new top-level array. For same draft predecessor use `{kind:'draft_shot',shot_number}`; existing allowed source key resolves server-side. LLM cannot supply arbitrary database IDs, latent paths, URLs, or iteration. Reconcile with finalized saved IDs and content fingerprints, not guessed latest sequence. `options` must include draft/final and optional source-key context/generation run. Do not activate partial/truncated stream. New unlocked finalized items may follow validated recommendation; existing manual locks remain.

Planning owns `storyboard_video_plans` (one row per storyboard; JSON recommendation and choice/source with separate revisions/fingerprints, selection fields) and indexed dependencies. Use helper to initialize schema invoked by migration; allow safe empty DTO when called against old/minimal test DB without schema. No hidden migrations in read getters.

## Execution interface and storage

Execution service exports `ensureVideoExecutionSchema(db)`, `previewPlan(db,cfg,log,body)`, `runPlan(db,cfg,log,id,body)`, `getPlan(db,id)`, `resumePlan(db,cfg,log,id)`, `recoverPlans(db,cfg,log)`, `listSources(db,dramaId)`, `listVersions(db,storyboardId)`, `adoptVersion(db,storyboardId,body)`. Implement dependencies via injectable provider/media adapters for testing.

Own durable plans/nodes/attempts/segments and immutable versions. Agreed table `video_plan_versions`: id TEXT, storyboard_id INTEGER, model_id TEXT, tail_segment_id TEXT, segment_ids TEXT JSON, video_url TEXT, local_path TEXT, duration REAL, status TEXT, created_at TEXT. Additional fields allowed. Version status `completed` means a complete playable result, not necessarily latent-ready. Expose `continuable` and reasons based on exact tail segment artifact. Source provenance and continuation compatibility are not just model name equality.

Adoption is in planning row: separate adoption revision from choice revision is acceptable, expose it as `adoption_revision` in DTO and expect it on adoption endpoint. Do not silently adopt completion. Captain will integrate ordinary source selections and export resolver using this table/row; report actual columns.

Resolve future sources to exact producer node in this frozen plan. Outside-plan unresolved source remains waiting until explicitly bound; don't start other episodes automatically. Persist operation/attempt before network submission; unknown result -> submitted_unknown, never automatic duplicate GPU submission. Freeze original connection identity and task IDs. Actual known task recovery must not use current global default. Compose only current storyboard members; cross-shot/cross-episode parents provide latent, never prepend their video. Same-storyboard append explicitly requested may retain the selected version's members.

Real latent resolution must follow task/prompt-specific history and registered latent-save node/task prefix, or canonical output root and task-exclusive discovery. Missing/ambiguous/outside-root artifacts block children; do not guess newest files. Respect exact loader reference. Reuse managed Python adapter; no extra processes or script edits.

## UI and integration

UI loads planning separately so existing DTOs need not be modified immediately. New toggle on storyboard generation passes `video_planning:true|false` independently of text `model` and `creation_mode`. Source selector chooses exact version or planned storyboard, not arbitrary path. Recommendation vs manual choice vs actual execution visible. Draft is not executable. Change global default doesn't overwrite manual choice. Add separate re-recommend action preserving IDs/videos.

Capture same prompt/reference options currently used for ordinary generation into preview inputs; planned generation routes via preview/run instead of clearing adoption and calling old `/videos`. Existing legacy/unplanned behavior remains. Batch preview must list finite targets, block unsafe children, retain failures; only ready finite plan nodes run. Independent tasks may be conservatively serialized for first implementation. Show source/output membership distinction.

## Verification

Use `C:\nvm4w\nodejs\node.exe` for SQLite ABI compatibility. Backend tests: `node --test test/*.test.js`; frontend tests same and `npm run build`. Test realistic failure/revision/provenance boundaries, not implementation-mirroring tests. No network/GPU calls in tests. No commits/deployment requested.
