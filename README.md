# Ikemen AI Patcher

Ikemen AI Patcher is a local desktop tool for scanning, resolving, previewing, backing up, and patching AI logic for Ikemen GO and M.U.G.E.N characters.

The goal is to help users add or replace character AI without manually editing large `.cmd`, `.cns`, `.st`, and `.air` files by hand. The tool scans the target character first, resolves conflicts against the selected AI brain, previews the generated patch, creates backups, and writes marker-based AI blocks that can be updated safely later.


## Features

- Scan Ikemen GO and M.U.G.E.N character folders.
- Detect `.def`, `.cmd`, `.cns`, `.st`, and `.air` files.
- Read existing commands, states, variables, fvars, power costs, hitboxes, and combo routes.
- Load AI brain files from Markdown.
- Resolve logical brain placeholders into real character states, variables, ranges, and commands.
- Preview generated patch operations before writing anything.
- Create timestamped backups before every write operation.
- Apply marker-based AI patch blocks so future patches update existing generated code instead of duplicating it.
- Quarantine old AI logic without deleting the original code.
- Support safer partial workflows when full patching is blocked.
- Use audit checks to block unsafe or unresolved generated code.

## Who Is This For?

Ikemen AI Patcher is designed for two groups:

- Players and character collectors who want to apply AI patches with less manual editing.
- Developers and AI authors who want a structured scanner, resolver, generator, and audit pipeline for reusable AI brains.

The normal workflow is user-first: select a character, select a brain, preview the result, then apply only after reviewing the planned changes.

## How It Works

The patcher uses a scan-first pipeline:

```text
Character folder
-> Scan files
-> Load AI brain
-> Resolve conflicts
-> Preview generated patch
-> Backup original files
-> Apply marker-based patch
-> Write report
```

### 1. Character Scan

The scanner reads the character definition and related files to build a profile of the target character.

It detects:

- Available commands.
- Existing `var(n)` and `fvar(n)` usage.
- StateDef lists and state roles.
- HitDef data and cancel routes.
- Power gain and power cost behavior.
- AIR action hitboxes and reach.
- Existing AI code and previous `AI_PATCH` markers.

### 2. Brain Loading

AI brains are Markdown files that describe a style of AI behavior. A brain can define:

- Logical variables.
- Logical fvariables.
- Logical state aliases.
- Range aliases.
- Module templates.
- Required commands or scanned states.
- AI behavior notes and route preferences.

Instead of assuming that every character uses the same state numbers, the brain uses placeholders. The resolver maps those placeholders onto the scanned character.

### 3. Resolver

The resolver compares the brain requirements with the character scan.

It can:

- Reuse compatible variables.
- Auto-remap to free variable slots.
- Match known state roles.
- Derive range values from scanned hitboxes and movement data.
- Block modules that still contain unresolved placeholders.
- Mark risky mappings for review.

### 4. Generator

The generator creates patch code only after scan and resolve data are available.

Generated code is inserted inside marker blocks:

```c
; AI_PATCH_BEGIN: brain_id:module_id:v1
...
; AI_PATCH_END: brain_id:module_id:v1
```

When the same module is patched again, the existing marker block is replaced instead of duplicated.

### 5. Audit Layer

Before applying, the audit layer checks generated operations for common problems, including:

- Missing variable or state placeholders.
- Invalid command references.
- Missing meter gates for expensive states.
- Unsafe combo transitions.
- High-risk target or helper states.
- Charge-state compatibility issues.
- Generated code that could interrupt multi-hit moves too early.

If a blocking issue is found, the patcher stops and asks the user to resolve or choose a safer workflow.

## Installation

Download the latest Windows release from the project's GitHub Releases page.

The release package is intended to include a ready-to-use `.exe` build. No manual Node.js setup is required for normal users.

Recommended setup:

1. Download the latest release package.
2. Extract it to a folder outside protected Windows directories such as `Program Files`.
3. Keep your Ikemen GO game folder and character folders in a writable location.
4. Run the included `.exe`.

## Usage

1. Open Ikemen AI Patcher.
2. Select or paste the target character folder path.
3. Click `Scan` to inspect the character.
4. Select an AI brain file.
5. Click `Resolve` to map the brain to the character.
6. Review warnings, conflicts, and detected mappings.
7. Click `Preview Diff` to inspect planned changes.
8. Click `Apply Patch` only after reviewing the preview.
9. Test the patched character in Ikemen GO.

## Recommended Workflow

For the safest result:

1. Patch one character at a time.
2. Always review the preview before applying.
3. Test the character after patching.
4. If the character already has old AI, use the quarantine workflow before replacing it.
5. If full patching is blocked, use Safe Lite or Manual Pick instead of forcing unresolved modules.

## Backups And Reports

Every write operation creates a backup before changing files.

Backups and reports are written with timestamps so you can inspect or restore changes later.

Typical backup/report data includes:

- Character name.
- Changed files.
- Selected modules.
- Conflicts or skipped modules.
- Generated patch operations.
- Quarantined old AI blocks, if used.

## AI Brains

AI brains live as Markdown documents. They are designed to be reusable across characters by relying on logical aliases instead of fixed assumptions.

Example concepts used by a brain:

```text
state.power_charge
state.roll_forward
state.parry_stand
range.close_x
var.ai_enabled
fvar.ai_chance
```

The resolver maps these concepts to the actual character where possible.

## Safety Notes

Ikemen AI Patcher is designed to be conservative, but generated AI still changes character behavior.

Before distributing a patched character:

- Confirm that the original character license allows edits and redistribution.
- Test common actions, supers, throws, get-hit states, and power charge behavior.
- Check that expensive moves still require enough power.
- Check that multi-hit moves are not interrupted before their intended final hit.
- Keep the generated backup folder until testing is complete.

## Troubleshooting

### The patch is blocked

The selected brain may require states, variables, commands, or ranges that could not be resolved safely. Use the conflict information in the preview, select fewer modules, or use Safe Lite.

### The character already has AI

Use the old-AI cleanup or quarantine workflow. Quarantine disables detected old AI blocks without deleting them, which makes rollback and review easier.

### A move uses power even when meter is low

The scanner/audit should detect power costs and generated AI should gate expensive states. If a character uses unusual custom power logic, inspect the preview and report the state so the parser can be improved.

### A combo route misses often

Some moves require character-specific range, Y-position, airborne, or hit-confirm rules. The scanner uses AIR hitbox and movement data where possible, but unusual states may need brain or resolver tuning.

### A charge effect disappears

Some characters use short non-looping Explod animations for charge effects. Compatibility shims should refresh these effects while the charge state continues.

## Project Structure

```text
AI_Patcher/
  public/       User interface assets
  helper/       Scanner, resolver, generator, audit, backup, and patch logic
  brains/       AI brain Markdown files
  docs/         Design and implementation notes
  backups/      Timestamped backups created before writes
  reports/      Patch, cleanup, quarantine, and scan reports
  electron/     Desktop wrapper
  dist/         Release/build output
```

## Development Notes

The core patching logic is organized around four major layers:

- Scanner: reads character files and builds a profile.
- Resolver: maps brain requirements to the scanned character.
- Generator: creates marker-based patch modules.
- Audit: blocks unsafe, incomplete, or contradictory generated code.

When adding new AI behavior, prefer adding scanner evidence and audit rules instead of hardcoding a single character's state layout. This keeps brains reusable across different characters.

## For Developers

End users who download the release `.exe` do not need `AI_Patcher/node_modules`.

The `node_modules` folder is only needed when running, editing, or building Ikemen AI Patcher from source. It is generated locally after dependency installation and should not be committed to the repository.

Dependency files:

- `package.json` defines the direct dependencies, scripts, app metadata, and build settings.
- `package-lock.json` locks the exact dependency versions used for reproducible installs and release builds.
- `AI_Patcher/node_modules/` is the locally installed dependency folder created by npm.

To set up the project from source:

1. Install Node.js for your operating system.
2. Clone or download this repository.
3. Open a terminal in the `AI_Patcher` folder.
4. Install dependencies for normal development:

```powershell
npm install
```

For a clean reproducible install based exactly on `package-lock.json`, use:

```powershell
npm ci
```

Both commands create:

```text
AI_Patcher/node_modules/
```

Developer commands are defined in `AI_Patcher/package.json`.

Common development tasks:

```powershell
npm run electron
npm run pack
npm run dist:win
```

Use these only when working from source. Normal users should use the packaged release build instead.

## Donate

If this project helps you, you can support development here:

[DONATE HERE](https://www.paypal.com/paypalme/huytoken)

[![Donate with PayPal](https://i.ibb.co/BV79KDVm/Donate-Paypal.png)](https://www.paypal.com/paypalme/huytoken)

## License

This project is licensed under the Apache License 2.0.

Please also check the licenses of any bundled third-party assets, characters, artwork, music, or Ikemen GO resources before redistribution.
