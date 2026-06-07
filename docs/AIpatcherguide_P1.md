# AI Patcher Guide P1 - HTML + Node Helper

This document describes the current implementation plan and operating model for the Ikemen AI Patcher: a local HTML interface backed by a Node helper that scans Ikemen/MUGEN characters, loads AI brain markdown files, resolves conflicts, previews marker-based patches, backs up files, applies AI modules, and can quarantine old AI code before replacement.

## 1. Project Goal

The tool is designed to patch character AI safely across different Ikemen/MUGEN characters. It does not assume that every character uses the same states, hitboxes, ranges, variables, or cancel rules. Instead, it scans the target character, builds a profile, loads a brain file, resolves logical placeholders, previews all changes, writes a backup, and then applies only the selected patch operations.

Primary goals:

- Let users patch AI without manually editing `.cmd`, `.cns`, `.st`, and `.air` files.
- Keep character files recoverable through timestamped backups and reports.
- Use marker-based patching so repeated patches replace existing `AI_PATCH` blocks instead of duplicating them.
- Detect variable and state conflicts before writing files.
- Support Safe Lite, Manual Pick, and Replace Old AI workflows when full patching is blocked.
- Use combo scan data to validate routes instead of blindly trusting hardcoded state aliases.

## 2. Folder Layout

```text
AI_Patcher/
  public/
    index.html                 UI for scan, brain loading, resolve, preview, apply
  helper/
    server.js                  Node helper, scanner, resolver, patcher, backup logic
    package.json
  brains/
    Brain_Boxer_BL.md          Heavy D!/boxer-style brain
    Brain_RockAI_BL.md         DivineRockAI-style brain
  backups/
    <timestamp_character>/     File backups before write operations
  reports/
    *_patch_report.json
    *_air_patch_report.json
    *_cleanup_report.json
    *_quarantine_report.json
  docs/
    optional design notes
```

Root-level files:

```text
AIpatcherguide_P1.md           Implementation guide
Readme_ikemenAIpatcher.md      User-facing Windows README
```

## 3. Runtime Architecture

The browser cannot safely read and write arbitrary local character files by itself, so the tool uses a local Node helper.

Main components:

- `public/index.html`: the single-page UI.
- `helper/server.js`: Express server that scans files, parses brains, resolves plans, previews diffs, applies patches, writes backups, and reports.
- `brains/*.md`: AI brain files with frontmatter metadata, logical variables, state aliases, range definitions, module templates, and scan requirements.

Pipeline:

```text
Paste character folder
-> Scan
-> Load Brain
-> Resolve
-> Preview Diff
-> Apply Patch
-> If blocked: Safe Lite / Manual Pick / Replace Old AI
-> Backup
-> Write marker-based patch
-> Report
```

The current UI uses the left workflow rail as the action menu:

- `Scan`
- `Brain`
- `Resolve`
- `Preview Diff`
- `Apply`

## 4. Node Helper API

Current API endpoints:

```text
GET  /api/health
GET  /api/brains
POST /api/scan
POST /api/load-brain
POST /api/parse-brain
POST /api/resolve-plan
POST /api/preview-diff
POST /api/apply-patch
POST /api/preview-ai-cleanup
POST /api/apply-ai-cleanup
POST /api/apply-ai-quarantine
POST /api/air-scan
POST /api/air-preview
POST /api/air-apply
```

Example scan request:

```json
{
  "characterPath": "E:/x1/Ikemen_Nighty/chars/Heavy D!"
}
```

Example brain parse request:

```json
{
  "fileName": "Brain_RockAI_BL.md",
  "text": "---\nbrain_id: rockai_bl\n..."
}
```

## 5. Character Scanner

The scanner reads:

- `.def`: discovers `.cmd`, `.air`, `.cns`, and `.st` files.
- `.cmd`: command declarations, command references, `State -1`, AI blocks, ChangeState, HitOverride, old AI fingerprints.
- `.cns/.st`: `StateDef`, `HitDef`, power costs, cancel rules, state-action mapping.
- `.air`: actions, frames, Clsn1/Clsn2, hitbox reach.

It extracts:

- Used/free `var(n)` and `fvar(n)`.
- Available `[Command]` names, so generated AI cannot call commands the character does not define.
- Existing `AI_PATCH_VAR` and `AI_PATCH_FVAR` mappings.
- State groups:
  - guard
  - parry
  - roll
  - run
  - backDash
  - charge
  - zeroCounter
  - normals
  - specials
  - supers
- Power-cost buckets:
  - `500`
  - `1000`
  - `2000`
  - `3000`
  - `3000+`
- State-to-action map from CNS/ST.
- AIR action reach from Clsn1.
- Combo scan data.

## 6. Combo Scan

The current scanner builds `comboScan`, which helps brain files avoid unsafe route assumptions.

`comboScan.states` contains:

- state id
- inferred role
- HitDef summary
- cancel targets
- power cost
- action ids
- AIR reach
- source file

Inferred roles include:

- `normal`
- `low starter`
- `launcher`
- `special`
- `special launcher`
- `super`
- `air normal`
- `utility`

`comboScan.cancelEdges` contains numeric ChangeState edges:

- from state
- to state
- route kind
- trigger summary
- confidence

`comboScan.routeCandidates` contains stable hit-confirm/contact edges that can be used by brains as safe graph routes.

Important rule:

- Numeric `MoveHit` or `MoveContact` edges can become safe route candidates.
- Dynamic targets such as `value = var(...)` or expression-heavy `IfElse(...)` should stay `needs_review` until the UI resolves the final target state.

## 7. Range and AIR Data

Range values must not be treated as universal. Every character has different body size, reach, travel speed, startup, active frames, and hitbox shapes.

Scanner-derived data should be preferred:

- `airReach[action]`: Clsn1 min/max X/Y per action.
- `stateActionMap[state]`: actions used by each state.
- `states.powerCosts[state]`: parsed or inferred meter cost.
- `comboScan.states[].reach`: linked state/action reach data.

Brain files should use logical ranges:

```c
P2BodyDist X < ${range.low_threat_x}
P2BodyDist X = [${range.projectile_super_min_x},${range.projectile_super_max_x}]
Abs(P2BodyDist Y) <= ${range.grounded_abs_y}
```

If a range cannot be derived, the resolver can use brain `preferred` values and mark confidence as low or review-only.

## 8. Brain File Format

Brain files are Markdown documents with frontmatter and structured sections.

Frontmatter includes:

```yaml
---
brain_id: boxer_bl
name: Boxer Balanced Low Defense Brain
version: 1
target_engine: ikemen-go
source_reference: Heavy D! AI architecture
description: >
  ...
ai_style: >
  ...
ai_strengths: >
  ...
ai_weaknesses: >
  ...
combo_routes: >
  ...
---
```

Brain files define:

- logical variables
- logical fvariables
- state aliases
- range aliases
- file targets
- modules
- module YAML metadata
- `mugen-template` code blocks
- dependencies
- scanner notes

Templates should use placeholders instead of hardcoded `var(n)` or state ids:

```c
${var.ai_enabled}
${fvar.rock_ai_chance}
${state.crouch_parry}
${range.close_x}
```

## 9. Brain Metadata in the UI

After loading a brain file, the UI displays a brain description card under the brain tag.

The card shows:

- number of `var` required
- number of `fvar` required
- AI style
- strengths
- weaknesses
- combo routes

The free variable metrics compare the scanned character against the loaded brain:

- Green: `- ok. enough var`
- Yellow: `- Not enough variables? Just do it because the system has a solution.`

For fvars:

- Green: `- ok. enough fvar`
- Yellow: resolver can remap, skip, or apply a lite patch.

## 10. Conflict Resolver

The resolver maps logical brain variables, fvariables, states, ranges, and command aliases onto the scanned character.

Supported conflict strategies:

- `auto_remap`: choose a free compatible slot.
- `reuse_compatible`: reuse an existing slot if comments or mappings show the same purpose.
- `manual_choose`: let the user choose.
- `abort_patch`: block the affected module.

Command references are validated against the scanned `.cmd` file plus standard built-in hold commands such as `holdback`, `holdup`, `holddown`, and `holdfwd`.

When a patch contains unresolved placeholders or a `command = "..."` reference that does not exist, `Apply Patch` returns a blocking response and opens the conflict modal.

## 11. Conflict Modal Workflows

When full apply is blocked, the UI offers three options.

### Safe Lite Patch

Applies only modules that have no unresolved placeholders.

Rules:

- Clean modules are allowed.
- Partial dependency warnings do not block Safe Lite.
- Modules with missing variables remain skipped.

### Manual Pick

Shows all patchable modules.

Rules:

- Ready modules are checked.
- Partial modules are checked but marked as partial.
- Blocked modules are disabled and show missing placeholders.

### Replace Old AI

Scans for old AI code before replacement.

There are three types of candidates:

- marker-protected `AI_PATCH_BEGIN/END` blocks
- high-confidence old AI State -1 blocks
- heuristic preview-only candidates

Marker-protected blocks can be removed automatically.

High-confidence old AI State -1 blocks can be quarantined.

Heuristic candidates stay preview-only.

## 12. Hybrid Replace Old AI: Quarantine + Fingerprint

The current recommended replacement approach is Hybrid Quarantine + Fingerprint.

The scanner fingerprints old AI blocks such as:

- `[State -1, AI ...]`
- controllers gated by `var(59)`, AILevel, Random, fvar chance, or AI-like trigger patterns
- State -1 AI routers, parry, guard, roll, projectile response, combo, cashout, and boss-rush blocks

The quarantine action does not delete code. It inserts:

```c
; AI_PATCH_QUARANTINE_BEGIN: old_ai:xxxxxxxx
triggerAll = 0 ; AI_PATCH_DISABLED_OLD_AI
; AI_PATCH_QUARANTINE_END: old_ai:xxxxxxxx
```

This disables old AI behavior while keeping the original code for review and rollback.

After quarantine:

1. A backup is written.
2. The character is scanned again.
3. The workflow returns to Resolve.
4. The user can preview and apply the selected brain again.

This approach is safer than deleting heuristic blocks because many characters mix AI-looking code with gameplay routing.

## 13. Marker-Based Patching

All new AI code should be inserted inside marker blocks:

```c
; AI_PATCH_BEGIN: brain_id:module_id:v1
...
; AI_PATCH_END: brain_id:module_id:v1
```

When a marker already exists, the patcher replaces it instead of appending a duplicate.

If no marker exists, the patcher uses:

- `insert_after_module`
- `insert_before`
- `insert_after`
- fallback anchors
- append as last resort

## 14. Backup and Reports

Every write operation creates a backup first.

Backup names include a timestamp and character name:

```text
AI_Patcher/backups/20260529_053110_Heavy_D!_ai_quarantine/
```

Reports are written to:

```text
AI_Patcher/reports/
```

Report types include:

- patch reports
- AIR patch reports
- cleanup reports
- quarantine reports

## 15. AIR Patch Workflow

AIR patching is intentionally conservative.

The patcher can scan:

- action id
- frame index
- Clsn1/Clsn2 boxes
- reach
- state-action relation

AIR editing requires explicit inputs:

- action id
- frame index
- Clsn type
- box index
- delta values
- expected previous line

If the expected previous line changed, apply is blocked and the user must re-run preview.

AIR patching should not:

- globally scale hitboxes
- increase damage
- add armor
- add invulnerability
- heal or boost defense

## 16. Implementation Safety Rules

The patcher must never silently:

- delete heuristic old AI blocks
- overwrite non-marker gameplay code
- apply unresolved placeholders
- add focus armor
- increase damage
- increase defense
- add healing
- edit AIR without explicit preview

Dangerous operations must be backed up and reported.

## 17. Current Recommended User Flow

```text
1. Start Node helper.
2. Open http://127.0.0.1:8787.
3. Paste the character folder path.
4. Click Scan in the left rail.
5. Click Brain and select a brain .md file.
6. Review brain metadata and variable requirements.
7. Click Resolve.
8. Click Preview Diff.
9. Click Apply.
10. If blocked:
    - Use Safe Lite, or
    - Open Manual Pick, or
    - Use Replace Old AI -> Quarantine Safe AI Blocks.
11. After quarantine, Resolve and Preview Diff again.
12. Apply the final patch.
13. Test the character in Ikemen.
```

## 18. Future Work

Useful next steps:

- UI mapping for dynamic `value = var(...)` route targets.
- Better scoring for `comboScan.routeCandidates`.
- Manual quarantine selection for review candidates.
- Undo quarantine by marker id.
- Quick test runner integration for match results.
- Brain comparison view.
- Range editor for low-confidence derived ranges.
