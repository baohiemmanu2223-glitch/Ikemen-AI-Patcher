---
brain_id: mvc_wolverine_ag
name: MVC Wolverine Aggressive Rushdown Brain
version: 2
target_engine: ikemen-go
source_reference: chars/wolverine
description: >
  Character-specific brain scanned from chars/wolverine. It is built for the MVC
  Wolverine command/state layout: fast ground chains, crouch confirm, launcher
  into super jump, air chain, Drill Claw mobility, Berserker Slash/Barrage
  pressure, Tornado Claw anti-air, and level-1 hyper cashout. The source already
  has old AI using var(59) and var(9), so this brain uses marker-safe logical
  variables and treats old AI quarantine as a recommended workflow before full
  replacement.
ai_style: >
  Aggressive MVC rushdown. Wolverine should stay close, start pressure with low
  or fast light normals, convert to medium/hard normals, launch with 250, chase
  with state 203, then finish with air chains, Drill Claw, Fatal Claw X, Weapon X,
  Berserker Barrage X, or Speedy GonzaleX when meter and hit-confirm are valid.
  The preferred porting archetype is crouch-low confirm first: resolve a scanned
  low_starter/crouch_attack normal before rush specials or meter cashout.
ai_strengths: >
  Very fast close-range buttons, low starter 410/430, launcher 250, strong air
  chain 600 -> 610 -> 620 -> 640 -> 650/660, directional Drill Claw routes
  2100-2270, Tornado Claw anti-air 2500/2550/2600, and several one-bar hypers
  6000/6100/6300/6400/6500/6600. Scanner found existing AI flags and helper AI
  states 9741/9742, so the brain can either augment or replace old AI safely.
ai_weaknesses: >
  No true projectile zoning; Wolverine must take risks to enter. Many routes are
  short-range or airborne-only. The existing AI in -3.cns is large and uses many
  vars; full replacement should quarantine old AI first or use Safe Lite modules
  to avoid two AIs fighting over decisions.
combo_routes: >
  Core ground route: 410/400 -> 420/430 -> 440/450/250 -> 203 launcher jump.
  Rush special route: 200/210/220/230/240/430 contact -> 2020/2040/2060 or
  2000/2002/2004. Anti-air route: enemy airborne/high -> 250 or 2500/2550/2600.
  Air route: 600 -> 610 -> 620 -> 640 -> 650/660, then Drill Claw 2200/2250/2260
  or Fatal Claw X 6400 if power >= 1000. With meter-reliability scan enabled,
  generic patching should use scanner-confirmed close_confirm states as combo
  cashout. Wolverine source scan confirms 2000 and 6500 as close_confirm meter
  attacks, 6200 as self_buff, 2050 as unsafe_raw, and 6000/6100/6300/6400/6600
  as native cinematic/wrapper hypers that need native evidence when ported.
  For target characters, the style adapter should synthesize crouch_low_poke ->
  low_chain -> special -> close_confirm cashout without requiring Wolverine state
  numbers one-to-one.
runtime_safety: >
  This source has old AI activation through var(59) and runtime gate var(9), plus
  large -3.cns AI logic. Prefer Replace Old AI quarantine before applying full
  modules. Generated modules must use ${var.ai_enabled} and scanner-resolved state
  aliases. Do not call air-only states while grounded or ground-only states while
  airborne. Meter routes must require Power >= parsed or fallback cost and honor
  scanner meter_reliability: close_confirm/projectile can be combo enders,
  grab is point-blank punish only, self_buff/install are safe setup only, and
  unsafe_raw must not be generated as an attack route.
---

# Brain MVC Wolverine AG

Brain nay duoc viet rieng cho `chars/wolverine` trong IKEMEN AI Patcher. Format
giu cung kieu voi `Brain_Boxer_BL.md` va `Brain_RockAI_BL.md`: frontmatter, YAML
aliases, route preview, module templates, va scanner notes. Tat ca template dung
logical placeholders `${var.*}`, `${fvar.*}`, `${state.*}`, `${range.*}` de
Patcher resolve truoc khi apply.

Source summary from scan:

- `.def`: command file `wolverine.cmd`; states split across `wolverine.cns`,
  `wolverinea.cns`, `wolverineb.cns`, `wolverinec.cns`, `wolverined.cns`, and
  `-3.cns`.
- Existing AI: `-3.cns` sets `var(59)` and `wolverinea.cns` maps `var(9) =
  (var(59) = 1)`. `wolverine.cmd` gates human command logic with `var(9) != 1`.
- Old AI difficulty/reaction vars: `var(54)`, `var(53)`, `var(50)`.
- Ground combo flag: `var(39)` in `State -1`; air combo flag: `var(14)`.
- Important states: normals 200-260/400-460, air normals 600-681, throws
  300/360/690, guard push 330/340, specials 2000/2002/2004/2020/2040/2060/
  2100-2270/2500/2550/2600, hypers 6000/6100/6200/6300/6400/6500/6600.
- Scanner v2 meter reliability: 2000 and 6500 are close_confirm; 6200 is
  self_buff; 2050 is unsafe_raw; 6000/6100/6300/6400/6600 are native wrapper or
  cinematic states and should not be generic cashout unless the target scan
  proves equivalent HitDef/reach.
- Scanner v2 style evidence: 400/410/430/440 are low_starter/crouch_attack
  normals with command-chain MoveContact evidence. Use this as the primary
  Wolverine style signature when porting to another character.

## Conflict Policy

UI should expose four conflict levels:

- `auto_remap`: if preferred var/fvar is occupied, use a free slot.
- `reuse_compatible`: reuse only if scanner sees the same purpose.
- `manual_choose`: user chooses mapping manually.
- `abort_patch`: skip module if safe mapping is impossible.

Default policy is `auto_remap`. Because this Wolverine already uses many vars,
full replacement should use the AI Patcher quarantine workflow first when the UI
detects old AI blocks.

## Variables

```yaml
variables:
  - id: ai_enabled
    kind: var
    preferred: 59
    purpose: Tournament AI enabled flag / AILevel bridge for Wolverine AI
    conflict: reuse_compatible

  - id: wolverine_runtime_gate
    kind: var
    preferred: 9
    purpose: Existing Wolverine runtime AI gate mirrored from ai_enabled
    conflict: reuse_compatible

  - id: ai_level
    kind: var
    preferred: 54
    purpose: Wolverine old AI level / aggression scalar
    conflict: reuse_compatible

  - id: reaction_level
    kind: var
    preferred: 53
    purpose: Wolverine old AI reaction speed scalar
    conflict: reuse_compatible

  - id: target_index
    kind: var
    preferred: 52
    purpose: EnemyNear target index already used by Wolverine old AI
    conflict: reuse_compatible

  - id: ground_chain_flag
    kind: var
    preferred: 39
    purpose: Existing State -1 ground combo/contact flag
    conflict: reuse_compatible

  - id: air_chain_flag
    kind: var
    preferred: 14
    purpose: Existing State -1 air combo/contact flag
    conflict: reuse_compatible

  - id: route_lock
    kind: var
    preferred: 55
    purpose: Short lockout after AI chooses a route
    conflict: auto_remap

  - id: pressure_mode
    kind: var
    preferred: 56
    purpose: 0 neutral, 1 rushdown, 2 launcher, 3 air chase, 4 cashout
    conflict: auto_remap

  - id: anti_air_memory
    kind: var
    preferred: 48
    purpose: Timer when opponent repeatedly jumps or attacks from air
    conflict: auto_remap

  - id: drill_lock
    kind: var
    preferred: 47
    purpose: Prevent repeated Drill Claw spam in air/ground routes
    conflict: auto_remap

  - id: hyper_lock
    kind: var
    preferred: 46
    purpose: Prevent repeated one-bar hyper attempts
    conflict: auto_remap

  - id: throw_lock
    kind: var
    preferred: 45
    purpose: Close throw cooldown
    conflict: auto_remap

fvariables:
  - id: threat_score
    kind: fvar
    preferred: 32
    purpose: Enemy attack/projectile/air threat score
    conflict: auto_remap

  - id: range_score
    kind: fvar
    preferred: 33
    purpose: Close, mid, far spacing score for Wolverine routes
    conflict: auto_remap

  - id: enemy_y
    kind: fvar
    preferred: 34
    purpose: Enemy vertical distance sensor
    conflict: auto_remap

  - id: enemy_vel_x
    kind: fvar
    preferred: 35
    purpose: Enemy X velocity sensor
    conflict: auto_remap

  - id: approach_bias
    kind: fvar
    preferred: 36
    purpose: Rushdown chance scalar from AI level and life
    conflict: auto_remap
```

## State Aliases

```yaml
states:
  - id: stand_guard
    preferred: 130
    purpose: Standing guard state
    conflict: reuse_compatible

  - id: crouch_guard
    preferred: 131
    purpose: Crouching guard state
    conflict: reuse_compatible

  - id: air_guard
    preferred: 132
    purpose: Air guard state
    conflict: reuse_compatible

  - id: run_forward
    preferred: 100
    purpose: Wolverine run/dash forward
    conflict: reuse_compatible

  - id: back_dash
    preferred: 105
    purpose: Wolverine hop back/back dash
    conflict: reuse_compatible

  - id: launcher_jump
    preferred: 203
    purpose: Launcher jump after state 250 hit
    conflict: reuse_compatible

  - id: light_stand
    preferred: 200
    purpose: Standing light punch starter
    conflict: manual_choose

  - id: light_low
    preferred: 410
    purpose: Crouching light kick low starter
    conflict: manual_choose

  - id: medium_low
    preferred: 430
    purpose: Crouching medium kick low confirm
    conflict: manual_choose

  - id: medium_stand
    preferred: 220
    purpose: Standing medium punch chain step
    conflict: manual_choose

  - id: strong_stand
    preferred: 240
    purpose: Standing hard punch close confirm
    conflict: manual_choose

  - id: strong_low
    preferred: 440
    purpose: Crouching hard punch close finisher
    conflict: manual_choose

  - id: launcher
    preferred: 250
    purpose: Standing hard kick launcher
    conflict: manual_choose

  - id: sweep
    preferred: 460
    purpose: Crouching forward hard punch trip/sweep
    conflict: manual_choose

  - id: air_light
    preferred: 600
    purpose: Jump light punch
    conflict: manual_choose

  - id: air_medium
    preferred: 620
    purpose: Jump medium punch
    conflict: manual_choose

  - id: air_kick
    preferred: 640
    purpose: Jump medium kick
    conflict: manual_choose

  - id: air_strong
    preferred: 650
    purpose: Jump hard punch
    conflict: manual_choose

  - id: air_finish
    preferred: 660
    purpose: Jump hard kick finisher
    conflict: manual_choose

  - id: dive_kick
    preferred: 670
    purpose: Down-forward/vertical dive kick route
    conflict: manual_choose

  - id: throw_y
    preferred: 300
    purpose: Close ground throw Y
    conflict: reuse_compatible

  - id: throw_z
    preferred: 360
    purpose: Close ground throw Z
    conflict: reuse_compatible

  - id: air_throw
    preferred: 690
    purpose: Close air throw
    conflict: reuse_compatible

  - id: slash_light
    preferred: 2000
    purpose: Berserker Slash type I rush special
    conflict: manual_choose

  - id: slash_medium
    preferred: 2002
    purpose: Berserker Slash type II rush special
    conflict: manual_choose

  - id: slash_heavy
    preferred: 2004
    purpose: Berserker Slash type III rush special
    conflict: manual_choose

  - id: barrage_light
    preferred: 2020
    purpose: Berserker Barrage light
    conflict: manual_choose

  - id: barrage_medium
    preferred: 2040
    purpose: Berserker Barrage medium
    conflict: manual_choose

  - id: barrage_heavy
    preferred: 2060
    purpose: Berserker Barrage heavy
    conflict: manual_choose

  - id: drill_forward
    preferred: 2100
    purpose: Ground Drill Claw forward
    conflict: manual_choose

  - id: drill_up
    preferred: 2120
    purpose: Ground Drill Claw upward
    conflict: manual_choose

  - id: air_drill_forward
    preferred: 2200
    purpose: Air Drill Claw forward
    conflict: manual_choose

  - id: air_drill_down
    preferred: 2250
    purpose: Air Drill Claw down
    conflict: manual_choose

  - id: air_drill_down_forward
    preferred: 2260
    purpose: Air Drill Claw down-forward
    conflict: manual_choose

  - id: tornado_light
    preferred: 2500
    purpose: Tornado Claw light anti-air/special
    conflict: manual_choose

  - id: tornado_medium
    preferred: 2550
    purpose: Tornado Claw medium anti-air/special
    conflict: manual_choose

  - id: tornado_heavy
    preferred: 2600
    purpose: Tornado Claw heavy anti-air/special
    conflict: manual_choose

  - id: barrage_hyper
    preferred: 6000
    purpose: Berserker Barrage X one-bar rush hyper
    conflict: manual_choose

  - id: weapon_x
    preferred: 6100
    purpose: Weapon X one-bar close/whiff punish hyper
    conflict: manual_choose

  - id: healing_factor
    preferred: 6200
    purpose: Healing Factor X utility hyper
    conflict: manual_choose

  - id: fatal_claw_ground
    preferred: 6300
    purpose: Fatal Claw X grounded hyper
    conflict: manual_choose

  - id: fatal_claw_air
    preferred: 6400
    purpose: Fatal Claw X aerial hyper
    conflict: manual_choose

  - id: speedy_hyper
    preferred: 6500
    purpose: Speedy GonzaleX speed/rush hyper
    conflict: manual_choose

  - id: secret_hyper
    preferred: 6600
    purpose: 1337 hidden/cinematic hyper
    conflict: manual_choose
```

## Command Aliases

```yaml
commands:
  - id: dash
    preferred: "dash, FF"
    purpose: Dash/run command aliases present in wolverine.cmd
    conflict: reuse_compatible

  - id: back_dash
    preferred: "BB"
    purpose: Hop back command
    conflict: reuse_compatible

  - id: recovery
    preferred: "recovery"
    purpose: Recovery/advancing guard command
    conflict: reuse_compatible
```

## Ranges

```yaml
ranges:
  - id: close_x
    preferred: 32
    min: 12
    max: 55
    purpose: Throw and light starter range
    conflict: auto_derive

  - id: low_confirm_x
    preferred: 58
    min: 30
    max: 85
    purpose: Crouch light/medium low confirm range
    conflict: auto_derive

  - id: chain_x
    preferred: 78
    min: 45
    max: 115
    purpose: Normal chain into strong or launcher range
    conflict: auto_derive

  - id: rush_special_x
    preferred: 105
    min: 70
    max: 150
    purpose: Berserker Slash/Barrage punish range
    conflict: auto_derive

  - id: anti_air_x
    preferred: 145
    min: 80
    max: 190
    purpose: Tornado Claw or launcher anti-air X window
    conflict: auto_derive

  - id: anti_air_y
    preferred: -55
    min: -130
    max: -25
    purpose: Enemy Y threshold for anti-air
    conflict: auto_derive

  - id: air_chain_x
    preferred: 72
    min: 40
    max: 105
    purpose: Air normal chain X window
    conflict: auto_derive

  - id: air_chain_y_min
    preferred: -95
    min: -160
    max: -35
    purpose: Air chain lower Y window
    conflict: auto_derive

  - id: air_chain_y_max
    preferred: 30
    min: -10
    max: 70
    purpose: Air chain upper Y window
    conflict: auto_derive

  - id: hyper_close_x
    preferred: 82
    min: 45
    max: 115
    purpose: Close hyper cashout range
    conflict: auto_derive

  - id: hyper_punish_x
    preferred: 130
    min: 80
    max: 175
    purpose: Whiff punish hyper range
    conflict: auto_derive

  - id: grounded_y_min
    preferred: -90
    min: -140
    max: -20
    purpose: Grounded/near-floor target minimum Y
    conflict: auto_derive

  - id: grounded_y_max
    preferred: 25
    min: -5
    max: 60
    purpose: Grounded/near-floor target maximum Y
    conflict: auto_derive
```

## Source Scan Metadata

```yaml
source_scan:
  character: Wolverine
  source_folder: chars/wolverine
  cmd: wolverine.cmd
  cns: wolverine.cns
  st_files: [wolverine.cns, wolverinea.cns, wolverineb.cns, wolverinec.cns, wolverined.cns, -3.cns]
  existing_ai:
    primary_flag: var(59)
    runtime_gate: var(9)
    helper_states: [9741,9742]
    difficulty_vars: [53,54]
    target_var: 52
  used_vars: [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,21,22,23,24,37,39,40,50,51,52,53,54,57,58,59]
  used_fvars: [38]
  important_states:
    movement: [100,105,203,255]
    guard: [120,130,131,132,150,152,154,330,340]
    throws: [300,360,690]
    normals: [200,202,210,220,225,230,235,240,242,250,400,410,420,430,440,450,460]
    air_normals: [600,610,620,640,650,660,670,671,680,681]
    specials: [2000,2002,2004,2020,2040,2060,2100,2120,2140,2160,2180,2200,2210,2220,2230,2240,2250,2260,2270,2500,2550,2600]
    hypers: [6000,6100,6200,6300,6400,6500,6600]
  meter_reliability_scan:
    scanner_version: meter_reliability_v1
    report: AI_Patcher/reports/wolverine_scan_meter_reliability.json
    close_confirm:
      - { state: 2000, label: slash_close_confirm, use: hit_confirm_only, confidence: 0.73, reach_x: 94, y: [-125, 0], startup: 7, recovery: 49 }
      - { state: 6500, label: speedy_close_confirm, use: hit_confirm_only, confidence: 0.73, reach_x: 65, y: [-84, -16], startup: 5, recovery: 33 }
    self_buff:
      - { state: 6000, use: knockdown_or_far_safe_only, confidence: 0.54 }
      - { state: 6200, use: knockdown_or_far_safe_only, confidence: 0.54 }
    install:
      - { state: 6100, use: safe_neutral_or_knockdown_setup, confidence: 0.58 }
      - { state: 6300, use: safe_neutral_or_knockdown_setup, confidence: 0.58 }
      - { state: 6400, use: safe_neutral_or_knockdown_setup, confidence: 0.58 }
      - { state: 6600, use: safe_neutral_or_knockdown_setup, confidence: 0.58 }
    unsafe_raw:
      - { state: 2050, use: do_not_raw, confidence: 0.37 }
    native_wrapper_hypers:
      - { state: 6000, children: [6010,6030], note: Berserker Barrage X wrapper with later HitDefs }
      - { state: 6100, children: [6110,6120,6150,6160,6170,6180], note: Weapon X cinematic wrapper }
      - { state: 6300, children: [6305,6310,6320], note: Fatal Claw grounded wrapper }
      - { state: 6400, children: [6410,6310], note: Fatal Claw air wrapper }
      - { state: 6600, children: [6610,6620,6630,6634,6644,6650,6655], note: Secret hyper wrapper }
  style_adapter_scan:
    scanner_version: style_adapter_v2
    report: AI_Patcher/reports/wolverine_scan_meter_reliability.json
    primary_archetype: crouch_low_confirm_rushdown
    resolver_aliases:
      crouch_low_poke:
        source_states: [400,410]
        source_tags: [low_starter, crouch_attack, light_normal, normal]
        prefer: [fast_startup, movecontact_edge, close_range]
        startup: 3
        route_use: first_confirm
      low_chain:
        source_states: [430,440]
        source_tags: [low_starter, crouch_attack, medium_normal, strong_normal, normal]
        prefer: [movecontact_edge, hit_confirm_bridge]
        startup: [3,7]
        route_use: confirm_bridge
      launcher_bridge:
        source_states: [250,450]
        source_tags: [launcher, normal]
        prefer: [movehit_edge, enemy_not_liedown]
        startup: [2,4]
        route_use: launcher_or_air_route
      rush_special:
        source_states: [2000,2002,2004,2500,2550,2600]
        source_tags: [special, close_confirm, anti_air_special]
        prefer: [scanned_x_y_window, hit_confirm_only]
        route_use: special_or_cashout_bridge
    porting_rules:
      - prefer target states tagged both low_starter and crouch_attack for crouch_low_poke
      - prefer target state range 400-499 only as a weak hint, never as the only proof
      - require MoveHit or MoveContact bridge before special or meter follow-up
      - do not require exact Wolverine aliases when target scan has equivalent role tags
      - if target low starter has no scan reach, keep close-range gate and avoid raw meter after whiff
  confirmed_routes:
    - name: ground_low_confirm
      chain: [410,430,440,250,203]
      condition: close grounded hit/contact, then launcher jump
      tags: [crouch_low_confirm, low_starter, movecontact_bridge, launcher_route]
    - name: crouch_low_confirm_special_cashout
      chain: [400,410,430,2000,6500]
      condition: scanner-confirmed low starter/contact bridge into close_confirm meter window
      tags: [crouch_low_confirm, low_starter, rushdown_combo, close_confirm_cashout]
    - name: ground_rush_special
      chain: [200,210,220,230,240,2020]
      condition: normal chain contact into Berserker Barrage
    - name: anti_air_tornado
      chain: [2500,2505,2520]
      condition: enemy airborne or high Y, X inside anti-air window
    - name: air_chain
      chain: [600,610,620,640,650,660]
      condition: airborne contact route
    - name: air_drill_finish
      chain: [650,660,2250,2260]
      condition: air hit/contact, drill lock clear
    - name: meter_cashout
      chain: [2000,6500]
      condition: scanner-confirmed close_confirm, power at least 1000, hit-confirm window
    - name: native_wrapper_meter_review
      chain: [6000,6100,6300,6400,6600]
      condition: native Wolverine wrappers only; target character must prove HitDef/reach before generic cashout
```

## Lite Fit Metadata

```yaml
boss_profiles:
  normal:
    life_min: 36
    archetype: mvc_rushdown
    pressure_bias: 78
    launcher_bias: 70
    cashout_bias: 58
  desperation:
    life_max: 35
    archetype: mvc_desperation_rushdown
    pressure_bias: 92
    launcher_bias: 82
    cashout_bias: 76

fallback_triggers:
  wolverine_core:
    trigger: AILevel && NumEnemy && RoundState = 2
  wolverine_ground:
    trigger: AILevel && NumEnemy && RoundState = 2 && StateType != A && MoveType != H
  wolverine_air:
    trigger: AILevel && NumEnemy && RoundState = 2 && StateType = A && MoveType != H

lite_fit:
  module_policy:
    - id: variable_comments
      tier: metadata
      min_vars: [ai_enabled]
      optional_vars: [wolverine_runtime_gate, ai_level, reaction_level, target_index, route_lock, pressure_mode]
      fallback:
        mode: comments_only
        trigger: wolverine_core

    - id: wolverine_runtime_sensor
      tier: core
      min_vars: [ai_enabled]
      optional_vars: [wolverine_runtime_gate, ai_level, reaction_level, target_index, route_lock, pressure_mode, anti_air_memory, drill_lock, hyper_lock, throw_lock, threat_score, range_score, enemy_y, enemy_vel_x, approach_bias]
      fallback:
        mode: inline_trigger
        trigger: wolverine_core

    - id: wolverine_defense_approach
      tier: core_defense
      min_vars: [ai_enabled]
      optional_vars: [target_index, threat_score, route_lock, approach_bias]
      fallback:
        mode: guard_run
        trigger: wolverine_ground

    - id: wolverine_ground_rush_router
      tier: boss_core
      min_vars: [ai_enabled]
      optional_vars: [target_index, route_lock, pressure_mode, range_score]
      fallback:
        mode: ground_route
        trigger: wolverine_ground

    - id: wolverine_launcher_air_router
      tier: boss_core
      min_vars: [ai_enabled]
      optional_vars: [target_index, anti_air_memory, drill_lock, enemy_y]
      fallback:
        mode: air_route
        trigger: wolverine_air

    - id: wolverine_meter_cashout
      tier: optional
      min_vars: [ai_enabled]
      optional_vars: [target_index, hyper_lock, pressure_mode, approach_bias]
      fallback:
        mode: super_cashout
        trigger: wolverine_ground
```

## Meter Reliability Policy

```yaml
meter_policy:
  source_scanner: meter_reliability_v1
  default_attack_classes: [close_confirm, projectile]
  default_utility_classes: [self_buff, install]
  blocked_classes: [unsafe_raw]
  resolver_scoring:
    attack_alias_allow: [close_confirm, projectile, grab]
    attack_alias_penalty: [self_buff, install, unsafe_raw]
    utility_alias_allow: [self_buff, install]
    utility_alias_ids: [healing_factor]
    native_wrapper_requires_target_evidence: true
    style_alias_boosts:
      crouch_low_poke: [low_starter, crouch_attack, light_normal, fast_startup]
      low_chain: [low_starter, crouch_attack, medium_normal, strong_normal, movecontact_bridge]
      launcher_bridge: [launcher, enemy_not_liedown, movehit_bridge]
      rush_special: [special, close_confirm, scanned_x_y_window]
  generator_rules:
    crouch_low_confirm:
      use: primary_rushdown_starter
      require: [target_not_liedown, close_range, low_starter_or_crouch_attack_tag]
      followup_require: [MoveHit_or_MoveContact, anti_loop_cooldown, scanned_x_y_window_for_special_or_meter]
    close_confirm:
      use: hit_confirm_only
      require: [MoveHit, scanned_x_y_window, target_not_liedown]
    projectile:
      use: spacing_or_punish
      require: [scanned_x_y_window, safe_spacing_or_punish]
    grab:
      use: point_blank_punish_only
      require: [point_blank_x, target_grounded, target_not_liedown]
    self_buff:
      use: knockdown_or_far_safe_only
      require: [Ctrl, target_liedown_or_far, no_in_guard_dist]
    install:
      use: safe_neutral_or_knockdown_setup
      require: [Ctrl, target_liedown_or_far, no_in_guard_dist]
    unsafe_raw:
      use: do_not_raw
      require: [never_auto_generate]
  source_state_intent:
    barrage_hyper:
      preferred: 6000
      scanned_class: self_buff
      native_wrapper: true
      generic_fallback_role: close_confirm_cashout
    weapon_x:
      preferred: 6100
      scanned_class: install
      native_wrapper: true
      generic_fallback_role: close_confirm_cashout
    healing_factor:
      preferred: 6200
      scanned_class: self_buff
      generic_role: utility_safe_only
    fatal_claw_ground:
      preferred: 6300
      scanned_class: install
      native_wrapper: true
      generic_fallback_role: close_confirm_cashout
    fatal_claw_air:
      preferred: 6400
      scanned_class: install
      native_wrapper: true
      generic_role: air_confirm_only
    speedy_hyper:
      preferred: 6500
      scanned_class: close_confirm
      generic_role: close_confirm_cashout
    secret_hyper:
      preferred: 6600
      scanned_class: install
      native_wrapper: true
      generic_role: kill_or_setup_review
  confirmed_generic_cashout_aliases: [barrage_slash, speedy_hyper]
  review_only_source_wrapper_aliases: [barrage_hyper, weapon_x, fatal_claw_ground, fatal_claw_air, secret_hyper]
  safe_setup_aliases: [healing_factor]
  source_scan_evidence:
    confirmed_generic_cashout_states: [2000,6500]
    crouch_low_confirm_states: [400,410,430,440]
    crouch_low_confirm_routes:
      - [400,410,430,440]
      - [410,430,440,250,203]
      - [400,410,430,2000,6500]
    review_only_source_wrappers: [6000,6100,6300,6400,6600]
    safe_setup_states: [6200]
```

## Module: variable_comments

### Template

```mugen-template
; AI_PATCH_VAR ai_enabled = ${var.ai_enabled}
; AI_PATCH_VAR wolverine_runtime_gate = ${var.wolverine_runtime_gate}
; AI_PATCH_VAR ai_level = ${var.ai_level}
; AI_PATCH_VAR reaction_level = ${var.reaction_level}
; AI_PATCH_VAR target_index = ${var.target_index}
; AI_PATCH_VAR ground_chain_flag = ${var.ground_chain_flag}
; AI_PATCH_VAR air_chain_flag = ${var.air_chain_flag}
; AI_PATCH_VAR route_lock = ${var.route_lock}
; AI_PATCH_VAR pressure_mode = ${var.pressure_mode}
; AI_PATCH_VAR anti_air_memory = ${var.anti_air_memory}
; AI_PATCH_VAR drill_lock = ${var.drill_lock}
; AI_PATCH_VAR hyper_lock = ${var.hyper_lock}
; AI_PATCH_VAR throw_lock = ${var.throw_lock}
; AI_PATCH_FVAR threat_score = ${fvar.threat_score}
; AI_PATCH_FVAR range_score = ${fvar.range_score}
; AI_PATCH_FVAR enemy_y = ${fvar.enemy_y}
; AI_PATCH_FVAR enemy_vel_x = ${fvar.enemy_vel_x}
; AI_PATCH_FVAR approach_bias = ${fvar.approach_bias}
```

## Module: wolverine_runtime_sensor

### Target

```yaml
file: cmd
insert_after:
  - "[Statedef -1]"
fallback_insert_before:
  - "[State -1"
risk: low
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: mvc_wolverine_ag:wolverine_runtime_sensor:v1
[State -1, AI Wolverine AILevel Bridge]
type = VarSet
trigger1 = AILevel > 0
var(${var.ai_enabled:number}) = AILevel
ignoreHitPause = 1

[State -1, AI Wolverine AILevel Off]
type = VarSet
trigger1 = AILevel <= 0
var(${var.ai_enabled:number}) = 0
ignoreHitPause = 1

[State -1, AI Wolverine Runtime Gate Sync]
type = VarSet
trigger1 = ${var.ai_enabled} > 0
var(${var.wolverine_runtime_gate:number}) = 1
trigger2 = ${var.ai_enabled} <= 0
var(${var.wolverine_runtime_gate:number}) = 0
ignoreHitPause = 1

[State -1, AI Wolverine Level Sync]
type = VarSet
trigger1 = ${var.ai_enabled} > 0
var(${var.ai_level:number}) = ifElse(${var.ai_enabled} > 8, 8, ${var.ai_enabled})
ignoreHitPause = 1

[State -1, AI Wolverine Reaction Sync]
type = VarSet
trigger1 = ${var.ai_enabled} > 0
var(${var.reaction_level:number}) = ifElse(${var.ai_enabled} > 8, 8, ${var.ai_enabled})
ignoreHitPause = 1

[State -1, AI Wolverine Target Index]
type = VarSet
trigger1 = ${var.ai_enabled} > 0 && NumEnemy
var(${var.target_index:number}) = 0
ignoreHitPause = 1

[State -1, AI Wolverine Enemy Y Sensor]
type = VarSet
trigger1 = ${var.ai_enabled} > 0 && NumEnemy
fvar(${fvar.enemy_y:number}) = P2BodyDist Y
ignoreHitPause = 1

[State -1, AI Wolverine Enemy Vel X Sensor]
type = VarSet
trigger1 = ${var.ai_enabled} > 0 && NumEnemy
fvar(${fvar.enemy_vel_x:number}) = EnemyNear(${var.target_index}), Vel X
ignoreHitPause = 1

[State -1, AI Wolverine Threat Score]
type = VarSet
trigger1 = ${var.ai_enabled} > 0 && NumEnemy
fvar(${fvar.threat_score:number}) = (EnemyNear(${var.target_index}), MoveType = A) + (EnemyNear(${var.target_index}), StateType = A) + (Enemy, NumProj > 0)
ignoreHitPause = 1

[State -1, AI Wolverine Range Score Close]
type = VarSet
trigger1 = ${var.ai_enabled} > 0 && P2BodyDist X < ${range.close_x}
fvar(${fvar.range_score:number}) = 1
trigger2 = ${var.ai_enabled} > 0 && P2BodyDist X = [${range.close_x},${range.rush_special_x}]
fvar(${fvar.range_score:number}) = 2
trigger3 = ${var.ai_enabled} > 0 && P2BodyDist X > ${range.rush_special_x}
fvar(${fvar.range_score:number}) = 3
ignoreHitPause = 1

[State -1, AI Wolverine Approach Bias]
type = VarSet
trigger1 = ${var.ai_enabled} > 0
fvar(${fvar.approach_bias:number}) = ifElse(Life < LifeMax * 0.35, 2, 1)
ignoreHitPause = 1

[State -1, AI Wolverine Anti Air Memory Add]
type = VarAdd
triggerAll = ${var.ai_enabled} > 0 && NumEnemy
triggerAll = EnemyNear(${var.target_index}), StateType = A || P2BodyDist Y < ${range.anti_air_y}
trigger1 = GameTime % 6 = 0
var(${var.anti_air_memory:number}) = 1
ignoreHitPause = 1

[State -1, AI Wolverine Anti Air Memory Decay]
type = VarAdd
trigger1 = var(${var.anti_air_memory:number}) > 0 && GameTime % 8 = 0
var(${var.anti_air_memory:number}) = -1
ignoreHitPause = 1

[State -1, AI Wolverine Route Lock Decay]
type = VarAdd
trigger1 = var(${var.route_lock:number}) > 0
var(${var.route_lock:number}) = -1
ignoreHitPause = 1

[State -1, AI Wolverine Drill Lock Decay]
type = VarAdd
trigger1 = var(${var.drill_lock:number}) > 0
var(${var.drill_lock:number}) = -1
ignoreHitPause = 1

[State -1, AI Wolverine Hyper Lock Decay]
type = VarAdd
trigger1 = var(${var.hyper_lock:number}) > 0
var(${var.hyper_lock:number}) = -1
ignoreHitPause = 1

[State -1, AI Wolverine Throw Lock Decay]
type = VarAdd
trigger1 = var(${var.throw_lock:number}) > 0
var(${var.throw_lock:number}) = -1
ignoreHitPause = 1
; AI_PATCH_END: mvc_wolverine_ag:wolverine_runtime_sensor:v1
```

## Module: wolverine_defense_approach

### Target

```yaml
file: cmd
insert_after_module: wolverine_runtime_sensor
risk: medium
route_preview:
  - id: wolverine_defense_approach_routes
    type: defensive_approach
    source: wolverine_guard_dash_backdash
    chain:
      - stand_guard
      - crouch_guard
      - run_forward
      - back_dash
    condition:
      - enemy_attack_or_projectile
      - guard_when_in_guard_dist
      - run_when_far_and_safe
      - backdash_when_corner_or_close_threat
    policy:
      - defense_before_rushdown
      - do_not_run_into_active_close_attack
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: mvc_wolverine_ag:wolverine_defense_approach:v1
[State -1, AI Wolverine Stand Guard]
type = ChangeState
value = ${state.stand_guard}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Ctrl || StateNo = [20,22]
triggerAll = InGuardDist && fvar(${fvar.threat_score:number}) > 0
trigger1 = EnemyNear(${var.target_index}), StateType != C
trigger1 = Random < 130 + (${var.ai_enabled} * 18)

[State -1, AI Wolverine Crouch Guard]
type = ChangeState
value = ${state.crouch_guard}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Ctrl || StateNo = [20,22]
triggerAll = InGuardDist && fvar(${fvar.threat_score:number}) > 0
trigger1 = EnemyNear(${var.target_index}), StateType = C || P2BodyDist Y > -20
trigger1 = Random < 120 + (${var.ai_enabled} * 18)

[State -1, AI Wolverine Back Dash Close Threat]
type = ChangeState
value = ${state.back_dash}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Ctrl && BackEdgeBodyDist > 45
triggerAll = EnemyNear(${var.target_index}), MoveType = A
triggerAll = P2BodyDist X < ${range.close_x}
trigger1 = Random < 90 + (${var.ai_enabled} * 12)

[State -1, AI Wolverine Run To Pressure]
type = ChangeState
value = ${state.run_forward}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Ctrl || StateNo = 20
triggerAll = StateNo != ${state.run_forward}
triggerAll = P2BodyDist X > ${range.chain_x}
triggerAll = EnemyNear(${var.target_index}), MoveType != A || P2BodyDist X > ${range.rush_special_x}
trigger1 = Random < 120 + (${var.ai_enabled} * 20)

[State -1, AI Wolverine Air Guard]
type = ChangeState
value = ${state.air_guard}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType = A && MoveType != H
triggerAll = Ctrl && InGuardDist
trigger1 = EnemyNear(${var.target_index}), MoveType = A || Enemy, NumProj > 0
trigger1 = Random < 105 + (${var.ai_enabled} * 14)
; AI_PATCH_END: mvc_wolverine_ag:wolverine_defense_approach:v1
```

## Module: wolverine_ground_rush_router

### Target

```yaml
file: cmd
insert_after_module: wolverine_defense_approach
risk: medium
route_preview:
  - id: wolverine_ground_rush_routes
    type: ground_route
    source: low_confirm_to_chain_launcher_or_special
    chain:
      - light_low
      - medium_low
      - strong_low
      - launcher
      - launcher_jump
      - barrage_heavy
      - slash_heavy
    condition:
      - grounded_target
      - close_or_mid_range
      - scanner_confirmed_normal_contact_edges
      - route_lock_clear
    policy:
      - prefer_low_starter_at_close_range
      - prefer_launcher_when enemy_not_liedown
      - use_special_only_from hit_or_contact
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: mvc_wolverine_ag:wolverine_ground_rush_router:v1
[State -1, AI Wolverine Low Starter]
type = ChangeState
value = ${state.light_low}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Ctrl && var(${var.route_lock:number}) <= 0
triggerAll = EnemyNear(${var.target_index}), StateType != A && EnemyNear(${var.target_index}), StateType != L
triggerAll = EnemyNear(${var.target_index}), MoveType != H
triggerAll = P2BodyDist X = [0,${range.low_confirm_x}]
trigger1 = Random < 135 + (${var.ai_enabled} * 18) * fvar(${fvar.approach_bias:number})

[State -1, AI Wolverine Standing Starter]
type = ChangeState
value = ${state.light_stand}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Ctrl && var(${var.route_lock:number}) <= 0
triggerAll = EnemyNear(${var.target_index}), StateType != L
triggerAll = P2BodyDist X = [0,${range.close_x}]
trigger1 = Random < 95 + (${var.ai_enabled} * 13)

[State -1, AI Wolverine Low To Medium]
type = ChangeState
value = ${state.medium_low}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType != A && MoveType != H
triggerAll = StateNo = ${state.light_low} && MoveContact
triggerAll = EnemyNear(${var.target_index}), StateType != L
trigger1 = 1

[State -1, AI Wolverine Medium To Strong Low]
type = ChangeState
value = ${state.strong_low}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType != A && MoveType != H
triggerAll = StateNo = ${state.medium_low} && MoveContact
triggerAll = P2BodyDist X < ${range.chain_x}
trigger1 = Random < 680

[State -1, AI Wolverine Medium To Launcher]
type = ChangeState
value = ${state.launcher}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType != A && MoveType != H
triggerAll = StateNo = ${state.medium_low} && MoveHit
triggerAll = EnemyNear(${var.target_index}), StateType != L
triggerAll = P2BodyDist X < ${range.chain_x}
trigger1 = Random < 420
trigger1 = var(${var.pressure_mode:number}) := 2

[State -1, AI Wolverine Launcher Jump]
type = ChangeState
value = ${state.launcher_jump}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType != A && MoveType != H
triggerAll = StateNo = ${state.launcher} && MoveContact
trigger1 = var(${var.pressure_mode:number}) = 2

[State -1, AI Wolverine Normal To Barrage]
type = ChangeState
value = ${state.barrage_heavy}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType != A && MoveType != H
triggerAll = MoveContact && var(${var.route_lock:number}) <= 0
triggerAll = StateNo = ${state.strong_stand} || StateNo = ${state.strong_low} || StateNo = ${state.medium_stand}
triggerAll = EnemyNear(${var.target_index}), StateType != L
triggerAll = P2BodyDist X < ${range.rush_special_x}
trigger1 = Random < 360
trigger1 = var(${var.route_lock:number}) := 14

[State -1, AI Wolverine Whiff Punish Slash]
type = ChangeState
value = ${state.slash_heavy}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Ctrl && var(${var.route_lock:number}) <= 0
triggerAll = EnemyNear(${var.target_index}), MoveType = A && EnemyNear(${var.target_index}), Ctrl = 0
triggerAll = EnemyNear(${var.target_index}), StateType != A && EnemyNear(${var.target_index}), StateType != L
triggerAll = P2BodyDist X = [${range.close_x},${range.rush_special_x}]
trigger1 = Random < 90 + (${var.ai_enabled} * 16)
trigger1 = var(${var.route_lock:number}) := 18

[State -1, AI Wolverine Close Throw Y]
type = ChangeState
value = ${state.throw_y}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType = S && MoveType != H
triggerAll = Ctrl && var(${var.throw_lock:number}) <= 0
triggerAll = EnemyNear(${var.target_index}), StateType != A && EnemyNear(${var.target_index}), StateType != L
triggerAll = EnemyNear(${var.target_index}), MoveType != H
triggerAll = P2BodyDist X < ${range.close_x}
trigger1 = Random < 80 + (${var.ai_enabled} * 8)
trigger1 = var(${var.throw_lock:number}) := 45
; AI_PATCH_END: mvc_wolverine_ag:wolverine_ground_rush_router:v1
```

## Module: wolverine_launcher_air_router

### Target

```yaml
file: cmd
insert_after_module: wolverine_ground_rush_router
risk: medium
route_preview:
  - id: wolverine_air_routes
    type: air_route
    source: mvc_air_chain_drill_fatal_claw
    chain:
      - air_light
      - air_medium
      - air_kick
      - air_strong
      - air_finish
      - air_drill_down_forward
      - fatal_claw_air
    condition:
      - airborne_self
      - enemy_in_air_or_hitstun
      - air_chain_x_y_window
      - drill_or_hyper_lock_clear
    policy:
      - keep_air_actions_air_only
      - use_fatal_claw_air_only_with_meter
      - do_not_drill_repeatedly_without_contact
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: mvc_wolverine_ag:wolverine_launcher_air_router:v1
[State -1, AI Wolverine Anti Air Launcher]
type = ChangeState
value = ${state.launcher}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Ctrl && var(${var.route_lock:number}) <= 0
triggerAll = EnemyNear(${var.target_index}), StateType = A || P2BodyDist Y <= ${range.anti_air_y} || var(${var.anti_air_memory:number}) >= 4
triggerAll = P2BodyDist X = [0,${range.anti_air_x}]
trigger1 = Random < 100 + (${var.ai_enabled} * 18)
trigger1 = var(${var.pressure_mode:number}) := 2

[State -1, AI Wolverine Tornado Anti Air]
type = ChangeState
value = ${state.tornado_heavy}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Ctrl && var(${var.route_lock:number}) <= 0
triggerAll = EnemyNear(${var.target_index}), StateType = A || P2BodyDist Y <= ${range.anti_air_y}
triggerAll = P2BodyDist X = [20,${range.anti_air_x}]
trigger1 = Random < 85 + (${var.ai_enabled} * 16)
trigger1 = var(${var.route_lock:number}) := 18

[State -1, AI Wolverine Air Chain Light]
type = ChangeState
value = ${state.air_light}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType = A && MoveType != H
triggerAll = Ctrl
triggerAll = EnemyNear(${var.target_index}), StateType != L
triggerAll = P2BodyDist X = [0,${range.air_chain_x}]
triggerAll = P2BodyDist Y = [${range.air_chain_y_min},${range.air_chain_y_max}]
trigger1 = Random < 120 + (${var.ai_enabled} * 14)

[State -1, AI Wolverine Air Light To Medium]
type = ChangeState
value = ${state.air_medium}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType = A && MoveType != H
triggerAll = StateNo = ${state.air_light} && MoveContact
triggerAll = P2BodyDist X < ${range.air_chain_x}
trigger1 = 1

[State -1, AI Wolverine Air Medium To Kick]
type = ChangeState
value = ${state.air_kick}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType = A && MoveType != H
triggerAll = StateNo = ${state.air_medium} && MoveContact
triggerAll = P2BodyDist X < ${range.air_chain_x}
trigger1 = 1

[State -1, AI Wolverine Air Kick To Strong]
type = ChangeState
value = ${state.air_strong}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType = A && MoveType != H
triggerAll = StateNo = ${state.air_kick} && MoveContact
triggerAll = P2BodyDist X < ${range.air_chain_x}
trigger1 = Random < 720

[State -1, AI Wolverine Air Strong To Finish]
type = ChangeState
value = ${state.air_finish}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType = A && MoveType != H
triggerAll = StateNo = ${state.air_strong} && MoveContact
triggerAll = P2BodyDist X < ${range.air_chain_x}
trigger1 = Random < 650

[State -1, AI Wolverine Air Drill Finish]
type = ChangeState
value = ${state.air_drill_down_forward}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType = A && MoveType != H
triggerAll = var(${var.drill_lock:number}) <= 0
triggerAll = StateNo = ${state.air_strong} || StateNo = ${state.air_finish} || StateNo = ${state.dive_kick}
triggerAll = MoveContact
triggerAll = P2BodyDist X < ${range.air_chain_x}
trigger1 = Random < 330
trigger1 = var(${var.drill_lock:number}) := 45

[State -1, AI Wolverine Air Fatal Claw Cashout]
type = ChangeState
value = ${state.fatal_claw_air}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType = A && MoveType != H
triggerAll = Power >= ${state.fatal_claw_air:cost} && var(${var.hyper_lock:number}) <= 0
triggerAll = MoveHit && EnemyNear(${var.target_index}), MoveType = H
triggerAll = P2BodyDist X < ${range.hyper_close_x}
triggerAll = P2BodyDist Y = [${range.air_chain_y_min},${range.air_chain_y_max}]
trigger1 = Random < 145 + (${var.ai_enabled} * 10)
trigger1 = var(${var.hyper_lock:number}) := 70
; AI_PATCH_END: mvc_wolverine_ag:wolverine_launcher_air_router:v1
```

## Module: wolverine_meter_cashout

### Target

```yaml
file: cmd
insert_after_module: wolverine_launcher_air_router
risk: medium
route_preview:
  - id: wolverine_hyper_cashout_routes
    type: super_cashout
    source: one_bar_hypers
    chain:
      - speedy_hyper
      - barrage_hyper
      - weapon_x
      - fatal_claw_ground
      - secret_hyper
    condition:
      - power_at_least_1000
      - hit_confirm_or_whiff_punish
      - close_or_mid_range_window
      - target_not_liedown
    policy:
      - no_meter_spender_without_power
      - close_confirm_or_native_wrapper_evidence_required
      - self_buff_install_not_combo_finisher
      - healing_factor_only_when_life_below_max
      - secret_hyper_reserved_for_close_or_kill
  - id: wolverine_safe_meter_utility
    type: safe_setup
    source: meter_reliability_scan
    chain:
      - healing_factor
    condition:
      - self_buff_or_install_only
      - target_liedown_or_far
      - no_in_guard_dist
      - life_below_threshold
    policy:
      - never_use_as_combo_finisher
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: mvc_wolverine_ag:wolverine_meter_cashout:v1
; AI_PATCH_METER_POLICY: attack cashout must resolve to close_confirm/projectile or native-wrapper evidence.
; AI_PATCH_METER_POLICY: self_buff/install aliases are safe setup only; unsafe_raw is never auto-generated.
[State -1, AI Wolverine Berserker Barrage X Cashout]
type = ChangeState
value = ${state.barrage_hyper}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Power >= ${state.barrage_hyper:cost} && var(${var.hyper_lock:number}) <= 0
triggerAll = EnemyNear(${var.target_index}), StateType != L
triggerAll = P2BodyDist X < ${range.hyper_close_x}
trigger1 = MoveHit && EnemyNear(${var.target_index}), MoveType = H
trigger1 = Random < 125 + (${var.ai_enabled} * 12)
trigger1 = var(${var.hyper_lock:number}) := 70

[State -1, AI Wolverine Weapon X Punish]
type = ChangeState
value = ${state.weapon_x}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Power >= ${state.weapon_x:cost} && var(${var.hyper_lock:number}) <= 0
triggerAll = EnemyNear(${var.target_index}), StateType != L
triggerAll = P2BodyDist X = [0,${range.hyper_punish_x}]
trigger1 = MoveHit && EnemyNear(${var.target_index}), MoveType = H && Random < 130 + (${var.ai_enabled} * 10)
trigger1 = var(${var.hyper_lock:number}) := 70
trigger2 = Ctrl && EnemyNear(${var.target_index}), MoveType = A && EnemyNear(${var.target_index}), Ctrl = 0 && Random < 65 + (${var.ai_enabled} * 8)
trigger2 = var(${var.hyper_lock:number}) := 70

[State -1, AI Wolverine Fatal Claw Ground Cashout]
type = ChangeState
value = ${state.fatal_claw_ground}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Power >= ${state.fatal_claw_ground:cost} && var(${var.hyper_lock:number}) <= 0
triggerAll = EnemyNear(${var.target_index}), StateType != L
triggerAll = P2BodyDist X < ${range.hyper_close_x}
triggerAll = P2BodyDist Y = [${range.grounded_y_min},${range.grounded_y_max}]
trigger1 = MoveHit && EnemyNear(${var.target_index}), MoveType = H
trigger1 = Random < 115 + (${var.ai_enabled} * 12)
trigger1 = var(${var.hyper_lock:number}) := 70

[State -1, AI Wolverine Speedy GonzaleX Pressure]
type = ChangeState
value = ${state.speedy_hyper}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Power >= ${state.speedy_hyper:cost} && var(${var.hyper_lock:number}) <= 0
triggerAll = EnemyNear(${var.target_index}), StateType != L
triggerAll = P2BodyDist X = [0,${range.hyper_punish_x}]
trigger1 = MoveHit && EnemyNear(${var.target_index}), MoveType = H && Random < 105 + (${var.ai_enabled} * 10)
trigger1 = var(${var.hyper_lock:number}) := 80
trigger2 = Ctrl && Life < LifeMax * 0.45 && Random < 45 + (${var.ai_enabled} * 8)
trigger2 = var(${var.hyper_lock:number}) := 80

[State -1, AI Wolverine Secret Hyper Kill Attempt]
type = ChangeState
value = ${state.secret_hyper}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Power >= ${state.secret_hyper:cost} && var(${var.hyper_lock:number}) <= 0
triggerAll = EnemyNear(${var.target_index}), StateType != L
triggerAll = P2BodyDist X < ${range.hyper_close_x}
trigger1 = EnemyNear(${var.target_index}), Life < 330 && MoveHit && Random < 120 + (${var.ai_enabled} * 12)
trigger1 = var(${var.hyper_lock:number}) := 95

[State -1, AI Wolverine Healing Factor Safe]
type = ChangeState
value = ${state.healing_factor}
triggerAll = ${var.ai_enabled} > 0 && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Power >= ${state.healing_factor:cost} && var(${var.hyper_lock:number}) <= 0
triggerAll = Ctrl && Life < LifeMax * 0.55 && Life < 999
triggerAll = EnemyNear(${var.target_index}), StateType = L || P2BodyDist X > ${range.hyper_punish_x}
triggerAll = P2BodyDist X > ${range.close_x} || EnemyNear(${var.target_index}), StateType = L
triggerAll = !InGuardDist && Enemy, NumProj = 0
trigger1 = Random < 45 + (${var.ai_enabled} * 7)
trigger1 = var(${var.hyper_lock:number}) := 120
; AI_PATCH_END: mvc_wolverine_ag:wolverine_meter_cashout:v1
```

## Module Dependencies

```yaml
dependencies:
  variable_comments: []
  wolverine_runtime_sensor: [variable_comments]
  wolverine_defense_approach: [wolverine_runtime_sensor]
  wolverine_ground_rush_router: [wolverine_runtime_sensor, wolverine_defense_approach]
  wolverine_launcher_air_router: [wolverine_runtime_sensor, wolverine_ground_rush_router]
  wolverine_meter_cashout: [wolverine_runtime_sensor, wolverine_ground_rush_router, wolverine_launcher_air_router]
```

## Scanner Notes

- The source already contains a large old AI block in `-3.cns`; UI should offer
  Replace Old AI quarantine before full apply.
- If old AI is not quarantined, prefer Safe Lite modules `variable_comments` and
  `wolverine_runtime_sensor`, then manually pick route modules.
- `var(59)` and `var(9)` are special in this character. If resolver remaps
  either one, the generated runtime gate can still work, but old AI may remain
  active unless quarantined.
- `wolverine.cmd` already computes `var(39)` and `var(14)` for ground/air contact
  windows. Scanner-confirmed `MoveContact` edges should be preferred over these
  flags when available.
- `healing_factor` is a utility hyper, not a combo finisher. Keep it review-only
  if the scanner cannot confirm safe distance or knockdown state.
- Air Drill Claw states are directional and easy to whiff. Mark air drill routes
  `needs_review` if AIR reach is missing or if the selected state is ground-only.
- All one-bar hypers in this source use power cost around 1000 by SuperPause or
  VarAdd. If power cost parsing fails, fallback cost should be 1000 because alias
  ids contain `hyper` or are listed as hyper states.

## Report Fields

Expected report additions:

```json
{
  "brainId": "mvc_wolverine_ag",
  "character": "Wolverine",
  "sourceFolder": "chars/wolverine",
  "existingAI": {
    "primaryFlag": "var(59)",
    "runtimeGate": "var(9)",
    "helperStates": [9741, 9742],
    "recommendedWorkflow": "quarantine_old_ai_before_full_apply"
  },
  "routeFamilies": [
    "ground_low_confirm",
    "ground_rush_special",
    "anti_air_tornado",
    "air_chain",
    "air_drill_finish",
    "meter_cashout"
  ],
  "safeLiteRecommended": true
}
```
