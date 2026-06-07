---
brain_id: angela_ag
name: Angela Aggressive Grappler Brain
version: 2
target_engine: ikemen-go
source_reference: chars/AngelaAI
description: >
  Template brain extracted from AngelaAI. It is an aggressive grappler/brawler
  brain with Xiangfei-style sensing: target index, enemy velocity, threat flag,
  throw cooldown, jump-memory, archetype bitmask, post-combo retreat, and power
  level gating. It suits power grapplers, brawlers, and close-to-mid range boss
  characters that can parry, roll, throw, anti-air, and cash out meter from a
  confirmed low/launcher route.
ai_style: >
  Aggressive grappler rushdown. Defense happens early through parry, guard, roll,
  and back roll. Offense uses close pokes and crouch-low confirms to force a
  430 -> 440 branch, then chooses body attack or super based on power. When life
  is low, the archetype stays rushdown plus grappler and prefers close/corner
  command-grab pressure.
ai_strengths: >
  Strong close-range pressure, throw threat, low confirm route, anti-air whip,
  jump-memory adaptation, knockdown retreat, and meter-aware level 1/2/3 cashout.
  Scanner data confirms AngelaAI has usable parry states 760/761/762, roll states
  710/715, charge 730, zero counter 750, EX states 1030/1430, supers 3000/3010/
  3100/3150, and level 3 state 3300. Meter reliability scan classifies 3000,
  3010, and 3300 as close-confirm cashouts, 3100 and 3150 as grab-style punish
  cashouts, 730/750/770 as setup utility, and 8330 as unsafe raw.
ai_weaknesses: >
  Needs accurate close range mapping. Level 3 grab routes are short and should not
  be called outside scanner-confirmed X/Y windows. Foxy Lady source states
  3100/3150 are treated as grab-style punish routes, not generic raw supers.
  Projectile/helper-trap supers should require hit-confirm, idle opponent, or
  grounded/falling target checks. Characters without a real throw or parry state
  should use Safe Lite fallback instead of forcing missing behavior.
combo_routes: >
  Core route: 430 hit -> 440 -> scanner-confirmed close-confirm cashout
  (3000/3010/3300 or target equivalent) if power is available and close, else
  1200. Source 3100/3150 routes are preserved as grab-style point-blank punish,
  not the default hit-confirm finisher.
  Anti-air route: enemy airborne/attacking -> 1100, or close anti-air -> 420/650.
  Grappler route: close neutral or corner pressure -> 800/3300. Meter route:
  confirmed normal/special -> 3000/3010/3300 when a close-confirm cashout is
  needed; 3100/3150 only when the resolver maps a real point-blank grab/punish.
  Knockdown route: if opponent is airborne/lying after combo, retreat with 105
  before charging or re-entering pressure.
runtime_safety: >
  The runtime AI flag must be bridged from AILevel before State -1 logic reads it.
  Parry aliases must resolve to existing states. Direct ChangeState must only call
  root-attack-safe states from the scanner. Meter routes must respect parsed power
  cost and must not chain multiple power-spending states sequentially unless the
  total cost is available. The generator must honor scanner meter_reliability:
  close_confirm states require hit confirm and scanned X/Y, grab states require
  point-blank grounded punish, setup utility requires safe neutral/knockdown, and
  unsafe_raw is blocked.
---

# Brain Angela AG

This brain is written for IKemen AI Patcher. It uses logical variables, state
aliases, and ranges. Do not hardcode `var(n)` in generated modules; the patcher
must resolve `${var.*}`, `${fvar.*}`, `${state.*}`, and `${range.*}` before apply.

AngelaAI source behavior summary:

- Runtime: `var(59) = AILevel`, `var(57) = target index`.
- Sensors: enemy X velocity, threat flag, throw cooldown, combo tracker, jump count.
- Persona: `var(56)` bitmask, `1 = Rushdown`, `4 = Grappler`, `5 = both`.
- Low life: below 35 percent life, force rushdown plus grappler.
- Core combo: source route 430 -> 440 -> 3100 with power, otherwise 1200; the
  reliability adapter prefers 3000/3010/3300 for generic hit-confirm cashout.
- Safety: after knockdown, set retreat counter and backdash with state 105.
- Meter: 3000/3100 cost 1000, 3010/3150 cost 2000, 3300 cost 3000.
- Meter reliability: 3000/3010/3300 are close-confirm cashouts; 3100/3150 are
  grab-style punish cashouts; 730/750/770 are setup utility; 8330 is blocked raw.

## Conflict Policy

UI should expose four conflict levels:

- `auto_remap`: if preferred var/fvar is occupied, use a free slot.
- `reuse_compatible`: reuse only if scanner sees the same purpose.
- `manual_choose`: user chooses mapping manually.
- `abort_patch`: skip module if safe mapping is impossible.

Default policy is `auto_remap`; `ai_enabled` should be `reuse_compatible`.

## Variables

```yaml
variables:
  - id: ai_enabled
    kind: var
    preferred: 59
    purpose: Tournament AI enabled flag / AILevel bridge
    conflict: reuse_compatible

  - id: target_index
    kind: var
    preferred: 57
    purpose: EnemyNear target index used by Angela-style sensors
    conflict: auto_remap

  - id: archetype_mode
    kind: var
    preferred: 56
    purpose: 1 rushdown, 4 grappler, 5 rushdown plus grappler
    conflict: auto_remap

  - id: combo_tracker
    kind: var
    preferred: 54
    purpose: Confirmed contact/combo tracker
    conflict: auto_remap

  - id: parry_cd
    kind: var
    preferred: 28
    purpose: Parry cooldown timer
    conflict: auto_remap

  - id: retreat_steps
    kind: var
    preferred: 31
    purpose: Backdash retreat counter after knockdown or unsafe close contact
    conflict: auto_remap

  - id: power_level
    kind: var
    preferred: 37
    purpose: 0 below 500, 1 below 1000, 2 below 2000, 3 below 3000, 4 full power
    conflict: auto_remap

  - id: route_lock
    kind: var
    preferred: 41
    purpose: Short offensive lock to avoid repeated state spam
    conflict: auto_remap

fvariables:
  - id: threat_flag
    kind: fvar
    preferred: 15
    purpose: Enemy airborne, attacking, or projectile pressure flag
    conflict: auto_remap

  - id: grab_cd
    kind: fvar
    preferred: 16
    purpose: Throw cooldown after contact
    conflict: auto_remap

  - id: enemy_vel_x
    kind: fvar
    preferred: 17
    purpose: Enemy X velocity sensor
    conflict: auto_remap

  - id: grappler_weight
    kind: fvar
    preferred: 25
    purpose: Close-range grappler weight, 1 neutral, 2 air rushdown, 4 close grappler
    conflict: auto_remap

  - id: enemy_jump_count
    kind: fvar
    preferred: 26
    purpose: Enemy jump habit memory, clamped 0 to 15
    conflict: auto_remap

  - id: chance_mult
    kind: fvar
    preferred: 32
    purpose: AI chance multiplier for fallback scaling
    conflict: auto_remap
```

## State Aliases

```yaml
states:
  - id: stand_guard
    preferred: 120
    purpose: Guard start / smart guard entry
    conflict: reuse_compatible

  - id: crouch_guard
    preferred: 131
    purpose: Crouch guard state
    conflict: reuse_compatible

  - id: stand_parry
    preferred: 760
    purpose: Standing parry state
    conflict: reuse_compatible

  - id: crouch_parry
    preferred: 761
    purpose: Crouching parry state
    conflict: reuse_compatible

  - id: air_parry
    preferred: 762
    purpose: Air parry state
    conflict: reuse_compatible

  - id: roll_forward
    preferred: 710
    purpose: Forward roll / roll-through state
    conflict: reuse_compatible

  - id: roll_back
    preferred: 715
    purpose: Back roll / spacing reset state
    conflict: reuse_compatible

  - id: run_forward
    preferred: 100
    purpose: Run or dash forward state
    conflict: reuse_compatible

  - id: back_dash
    preferred: 105
    purpose: Back dash / retreat state
    conflict: reuse_compatible

  - id: jump_start
    preferred: 40
    purpose: Jump or approach hop state
    conflict: reuse_compatible

  - id: power_charge
    preferred: 730
    purpose: Power charge state
    conflict: reuse_compatible

  - id: throw_state
    preferred: 800
    purpose: Close throw / command throw threat
    conflict: reuse_compatible

  - id: light_low
    preferred: 430
    purpose: Low starter / crouch light kick
    conflict: auto_remap

  - id: medium_low
    preferred: 440
    purpose: Low follow-up / crouch medium kick
    conflict: auto_remap

  - id: strong_launcher
    preferred: 420
    purpose: Close anti-air launcher normal
    conflict: auto_remap

  - id: air_light
    preferred: 600
    purpose: Air poke starter
    conflict: auto_remap

  - id: air_strong
    preferred: 650
    purpose: Air strong finisher
    conflict: auto_remap

  - id: rush_special
    preferred: 1000
    purpose: Double Punch Attack / rush special
    conflict: auto_remap

  - id: ex_projectile
    preferred: 1030
    purpose: EX Thunder Wall / 500 power special bridge
    conflict: auto_remap

  - id: anti_air_special
    preferred: 1100
    purpose: Love Me Whip anti-air or long anti-air special
    conflict: auto_remap

  - id: close_pressure
    preferred: 1200
    purpose: Angela Body Attack / close pressure special
    conflict: auto_remap

  - id: ex_anti_air
    preferred: 1430
    purpose: EX anti-air or launcher special
    conflict: auto_remap

  - id: air_special
    preferred: 1500
    purpose: Air Angela Body Attack / air special
    conflict: auto_remap

  - id: projectile_super_start
    preferred: 3000
    purpose: Level 1 Rolling Thunder Wall / projectile or trap super
    conflict: auto_remap

  - id: projectile_super_fire
    preferred: 3010
    purpose: Level 2 Rolling Thunder Wall / stronger projectile or trap super
    conflict: auto_remap

  - id: close_super
    preferred: 3100
    purpose: Foxy Lady / close hit-confirm super
    conflict: auto_remap

  - id: rush_hyper
    preferred: 3150
    purpose: MAX Foxy Lady / level 2 close hit-confirm super
    conflict: auto_remap

  - id: level3_super
    preferred: 3300
    purpose: Angela Giant Buster / level 3 close grab super
    conflict: auto_remap
```

## Ranges

```yaml
ranges:
  - id: parry_x
    preferred: 105
    min: 30
    max: 80
    purpose: Parry/guard threat X window
    conflict: auto_derive

  - id: low_confirm_x
    preferred: 50
    min: 25
    max: 90
    purpose: Low starter X window
    conflict: auto_derive

  - id: combo_cashout_x
    preferred: 70
    min: 45
    max: 100
    purpose: 440 hit to super or close pressure X window
    conflict: auto_derive

  - id: anti_air_x
    preferred: 150
    min: 80
    max: 180
    purpose: Love Me Whip anti-air X window
    conflict: auto_derive

  - id: anti_air_y
    preferred: -70
    min: -140
    max: -30
    purpose: Enemy must be above this Y window for anti-air
    conflict: auto_derive

  - id: close_throw_x
    preferred: 24
    min: 15
    max: 45
    purpose: Throw and grappler pressure X window
    conflict: auto_derive

  - id: level3_x
    preferred: 80
    min: 45
    max: 120
    purpose: Level 3 grab super X window
    conflict: auto_derive

  - id: close_super_x
    preferred: 80
    min: 45
    max: 110
    purpose: Close super X window
    conflict: auto_derive

  - id: grounded_min_y
    preferred: -120
    min: -180
    max: -20
    purpose: Grounded or near-floor target Y lower bound
    conflict: auto_derive

  - id: grounded_max_y
    preferred: 20
    min: -10
    max: 60
    purpose: Grounded or near-floor target Y upper bound
    conflict: auto_derive

  - id: retreat_close_x
    preferred: 40
    min: 20
    max: 70
    purpose: Retreat when knocked-down opponent is too close
    conflict: auto_derive

  - id: charge_safe_min_x
    preferred: 110
    min: 80
    max: 160
    purpose: Minimum safe charge distance after knockdown
    conflict: auto_derive

  - id: charge_safe_max_x
    preferred: 220
    min: 160
    max: 260
    purpose: Maximum useful charge distance after knockdown
    conflict: auto_derive
```

## Source Scan Metadata

```yaml
source_scan:
  character: AngelaAI
  source_folder: chars/AngelaAI
  used_vars: [0,3,4,5,6,7,8,9,10,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,30,31,32,33,34,35,36,37,38,39,40,43,54,56,57,58,59]
  free_vars: [1,2,11,29,41,42,44,45,46,47,48,49,50,51,52,53,55]
  used_fvars: [5,8,10,11,12,15,16,17,25,26,30,31]
  free_fvars: [0,1,2,3,4,6,7,9,13,14,18,19,20,21,22,23,24,27,28,29,32,33,34,35,36,37,38,39]
  state_groups:
    parry: [760,761,762]
    roll: [710,715]
    run: [100,101,105,106]
    charge: [730]
    zero_counter: [750]
    normals: [200,201,210,220,230,231,240,250,400,410,420,430,440,450,600,610,620,640,650]
    specials: [1000,1030,1100,1110,1200,1300,1301,1302,1303,1400,1410,1430,1500,1501,1515,1516]
    supers: [3000,3010,3014,3100,3103,3104,3105,3110,3150,3300,3301,3310,3311]
  power_costs:
    ex_500: [750,1030,1430]
    level1_1000: [770,3000,3100]
    level2_2000: [3010,3150]
    level3_3000: [3300]
  meter_reliability_scan:
    scanner_version: meter_reliability_v1
    report: AI_Patcher/reports/angela_scan_meter_reliability.json
    install:
      - { state: 730, use: safe_neutral_or_knockdown_setup, confidence: 0.66, reach_x: 41, startup: 2, delivery: helper_trap }
      - { state: 750, use: safe_neutral_or_knockdown_setup, confidence: 0.58, reach_x: null, startup: null, delivery: helper_trap, warning: startup_unknown }
    self_buff:
      - { state: 770, use: knockdown_or_far_safe_only, confidence: 0.62, reach_x: null, startup: 1, delivery: helper_trap }
    close_confirm:
      - { state: 1030, use: hit_confirm_only, confidence: 0.78, reach_x: 62, startup: 5, delivery: melee }
      - { state: 1430, use: hit_confirm_only, confidence: 0.78, reach_x: 106, startup: 9, delivery: helper_trap }
      - { state: 3000, use: hit_confirm_only, confidence: 0.78, reach_x: 76, startup: 9, delivery: helper_trap }
      - { state: 3010, use: hit_confirm_only, confidence: 0.78, reach_x: 76, startup: 9, delivery: helper_trap }
      - { state: 3300, use: hit_confirm_only, confidence: 0.78, reach_x: 53, startup: 1, delivery: helper_trap }
    grab:
      - { state: 3100, use: point_blank_punish_only, confidence: 0.76, reach_x: 80, startup: 5, delivery: helper_trap }
      - { state: 3150, use: point_blank_punish_only, confidence: 0.76, reach_x: 80, startup: 5, delivery: helper_trap }
    unsafe_raw:
      - { state: 8330, use: do_not_raw, confidence: 0.37, warning: no_direct_or_effective_hitdef }
  confirmed_routes:
    - name: branch_b_low_confirm
      chain: [430,440,3000]
      condition: 430 hit, 440 hit, p2bodydist x below 70, power at least 1000; source 3100 is grab-class and should be used only as point-blank punish
    - name: branch_b_no_meter
      chain: [430,440,1200]
      condition: 430 hit, 440 hit, p2bodydist x below 70, power below 1000
    - name: anti_air_whip
      chain: [1100]
      condition: enemy airborne or high Y, enemy attacking, X 40 to 150, Y below -70
    - name: close_grappler
      chain: [800,3300]
      condition: close grounded target, throw cooldown clear, corner or full power
    - name: post_combo_retreat
      chain: [105]
      condition: enemy airborne or liedown after 440/1200/3100
```

## Lite Fit Metadata

```yaml
boss_profiles:
  normal:
    life_min: 36
    archetype: rushdown_grappler
    pressure_bias: 65
    throw_bias: 55
    parry_bias: 70
  desperation:
    life_max: 35
    archetype: rushdown_grappler
    pressure_bias: 90
    throw_bias: 80
    parry_bias: 82

fallback_triggers:
  angela_core:
    trigger: AILevel && NumEnemy && RoundState = 2
  angela_guard:
    trigger: AILevel && NumEnemy && RoundState = 2 && MoveType != H
  angela_combo:
    trigger: AILevel && NumEnemy && RoundState = 2 && StateType != A && MoveType != H

lite_fit:
  module_policy:
    - id: angela_runtime_sensor
      tier: core
      min_vars: [ai_enabled]
      optional_vars: [target_index, archetype_mode, combo_tracker, power_level, route_lock, threat_flag, grab_cd, enemy_vel_x, grappler_weight, enemy_jump_count]
      fallback:
        mode: inline_trigger
        trigger: angela_core

    - id: angela_defense_router
      tier: core_defense
      min_vars: [ai_enabled]
      optional_vars: [parry_cd, threat_flag, target_index]
      fallback:
        mode: parry_guard
        trigger: angela_guard

    - id: angela_anti_air_router
      tier: optional
      min_vars: [ai_enabled]
      optional_vars: [target_index, enemy_jump_count, archetype_mode]
      fallback:
        mode: direct_air_followup
        trigger: angela_combo

    - id: angela_grappler_pressure
      tier: optional
      min_vars: [ai_enabled]
      optional_vars: [target_index, archetype_mode, grab_cd, grappler_weight, power_level]
      fallback:
        mode: pressure
        trigger: angela_combo

    - id: angela_branch_b_combo
      tier: boss_core
      min_vars: [ai_enabled]
      optional_vars: [target_index, route_lock]
      fallback:
        mode: ground_route
        trigger: angela_combo

    - id: angela_retreat_reset
      tier: optional
      min_vars: [ai_enabled]
      optional_vars: [target_index, retreat_steps]
      fallback:
        mode: direct_spacing
        trigger: angela_combo

    - id: angela_meter_cashout
      tier: optional
      min_vars: [ai_enabled]
      optional_vars: [target_index, archetype_mode, power_level, route_lock]
      fallback:
        mode: super_cashout
        trigger: angela_combo
```

## Meter Reliability Policy

```yaml
meter_policy:
  source_scanner: meter_reliability_v1
  default_attack_classes: [close_confirm, projectile]
  default_utility_classes: [self_buff, install]
  blocked_classes: [unsafe_raw]
  resolver_scoring:
    attack_alias_allow: [close_confirm, projectile]
    attack_alias_penalty: [grab, self_buff, install, unsafe_raw]
    grab_alias_allow: [grab]
    grab_alias_ids: [close_super, rush_hyper]
    utility_alias_allow: [self_buff, install]
    utility_alias_ids: [power_charge]
    prefer_target_state_reliability_over_source_name: true
  generator_rules:
    close_confirm:
      use: hit_confirm_only
      require: [MoveHit, scanned_x_y_window, target_not_liedown]
    projectile:
      use: spacing_or_punish
      require: [scanned_x_y_window, safe_spacing_or_punish, target_not_liedown]
    grab:
      use: point_blank_punish_only
      require: [point_blank_x, target_grounded, target_not_liedown, opponent_committed_or_recovering]
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
    power_charge:
      preferred: 730
      scanned_class: install
      generic_role: setup_safe_only
    zero_counter:
      preferred: 750
      scanned_class: install
      generic_role: defense_or_setup_review
    max_mode:
      preferred: 770
      scanned_class: self_buff
      generic_role: utility_safe_only
    ex_projectile:
      preferred: 1030
      scanned_class: close_confirm
      generic_role: ex_bridge_hit_confirm
    ex_anti_air:
      preferred: 1430
      scanned_class: close_confirm
      generic_role: anti_air_or_hit_confirm
    projectile_super_start:
      preferred: 3000
      scanned_class: close_confirm
      generic_role: level1_close_confirm_cashout
    projectile_super_fire:
      preferred: 3010
      scanned_class: close_confirm
      generic_role: level2_close_confirm_cashout
    close_super:
      preferred: 3100
      scanned_class: grab
      generic_role: point_blank_grab_punish_only
    rush_hyper:
      preferred: 3150
      scanned_class: grab
      generic_role: point_blank_grab_punish_only
    level3_super:
      preferred: 3300
      scanned_class: close_confirm
      generic_role: close_confirm_or_corner_cashout
  confirmed_generic_cashout_aliases: [projectile_super_start, projectile_super_fire, level3_super]
  confirmed_grab_cashout_aliases: [close_super, rush_hyper]
  safe_setup_aliases: [power_charge, zero_counter, max_mode]
  blocked_meter_aliases: [helper_raw_unsafe]
  source_scan_evidence:
    confirmed_generic_cashout_states: [3000,3010,3300]
    confirmed_grab_cashout_states: [3100,3150]
    safe_setup_states: [730,750,770]
    blocked_meter_states:
      - { state: 8330, label: helper_raw_unsafe, use: do_not_raw }
```

Fallback trigger contract:

- Values such as `angela_core`, `angela_guard`, and `angela_combo` are trigger
  aliases, not Ikemen expressions.
- The patcher must expand these aliases from `fallback_triggers` before writing
  any `.cmd/.cns/.st` file.
- Preview/Apply must block the patch if a generated controller still contains a
  bare alias such as `triggerAll = angela_combo && ...`.
- If an alias is missing, fallback generation should use a safe literal trigger
  or skip the module rather than writing the alias name into game code.

## Module: variable_comments

### Template

```mugen-template
; AI_PATCH_VAR ai_enabled = ${var.ai_enabled}
; AI_PATCH_VAR target_index = ${var.target_index}
; AI_PATCH_VAR archetype_mode = ${var.archetype_mode}
; AI_PATCH_VAR combo_tracker = ${var.combo_tracker}
; AI_PATCH_VAR parry_cd = ${var.parry_cd}
; AI_PATCH_VAR retreat_steps = ${var.retreat_steps}
; AI_PATCH_VAR power_level = ${var.power_level}
; AI_PATCH_VAR route_lock = ${var.route_lock}
; AI_PATCH_FVAR threat_flag = ${fvar.threat_flag}
; AI_PATCH_FVAR grab_cd = ${fvar.grab_cd}
; AI_PATCH_FVAR enemy_vel_x = ${fvar.enemy_vel_x}
; AI_PATCH_FVAR grappler_weight = ${fvar.grappler_weight}
; AI_PATCH_FVAR enemy_jump_count = ${fvar.enemy_jump_count}
; AI_PATCH_FVAR chance_mult = ${fvar.chance_mult}
```

## Module: angela_runtime_sensor

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
; AI_PATCH_BEGIN: angela_ag:angela_runtime_sensor:v1
[State -1, AI Angela CMD AILevel Bridge]
type = VarSet
trigger1 = AILevel > 0
var(${var.ai_enabled:number}) = AILevel
ignoreHitPause = 1

[State -1, AI Angela CMD AILevel Bridge Off]
type = VarSet
trigger1 = AILevel <= 0
var(${var.ai_enabled:number}) = 0
ignoreHitPause = 1

[State -1, AI Angela Target Index]
type = VarSet
trigger1 = ${var.ai_enabled} && NumEnemy
var(${var.target_index:number}) = 0
ignoreHitPause = 1

[State -1, AI Angela Enemy X Vel]
type = VarSet
trigger1 = ${var.ai_enabled} && NumEnemy
fvar(${fvar.enemy_vel_x:number}) = EnemyNear(${var.target_index}), Vel X
ignoreHitPause = 1

[State -1, AI Angela Threat Flag]
type = VarSet
trigger1 = ${var.ai_enabled} && NumEnemy
fvar(${fvar.threat_flag:number}) = (EnemyNear(${var.target_index}), StateType = A) || (EnemyNear(${var.target_index}), MoveType = A) || (EnemyNear(${var.target_index}), NumProj > 0)
ignoreHitPause = 1

[State -1, AI Angela Grab Cooldown Decay]
type = VarAdd
trigger1 = ${var.ai_enabled} && fvar(${fvar.grab_cd:number}) > 0
fvar(${fvar.grab_cd:number}) = -1
ignoreHitPause = 1

[State -1, AI Angela Grab Cooldown Reset]
type = VarSet
trigger1 = ${var.ai_enabled} && MoveContact = 1 && StateNo != [800,899]
fvar(${fvar.grab_cd:number}) = 35
ignoreHitPause = 1

[State -1, AI Angela Combo Tracker Reset]
type = VarSet
trigger1 = ${var.ai_enabled} && NumEnemy && (EnemyNear(${var.target_index}), StateType = A || EnemyNear(${var.target_index}), StateType = L || P2BodyDist X > ${range.low_confirm_x})
var(${var.combo_tracker:number}) = 0
ignoreHitPause = 1

[State -1, AI Angela Combo Tracker Set]
type = VarSet
trigger1 = ${var.ai_enabled} && MoveContact = 1 && StateType != A
var(${var.combo_tracker:number}) = 1
ignoreHitPause = 1

[State -1, AI Angela Archetype Default]
type = VarSet
triggerAll = ${var.ai_enabled} && RoundState = 2
trigger1 = var(${var.archetype_mode:number}) = 0
var(${var.archetype_mode:number}) = 5
ignoreHitPause = 1

[State -1, AI Angela Desperation Grappler]
type = VarSet
trigger1 = ${var.ai_enabled} && RoundState = 2 && Life < (LifeMax * 0.35)
var(${var.archetype_mode:number}) = 5
ignoreHitPause = 1

[State -1, AI Angela Grappler Weight]
type = VarSet
trigger1 = ${var.ai_enabled} && NumEnemy && P2BodyDist X <= ${range.close_throw_x}
fvar(${fvar.grappler_weight:number}) = 4
trigger2 = ${var.ai_enabled} && NumEnemy && P2BodyDist X < 60 && EnemyNear(${var.target_index}), StateType = A
fvar(${fvar.grappler_weight:number}) = 2
trigger3 = ${var.ai_enabled} && NumEnemy && P2BodyDist X >= 120
fvar(${fvar.grappler_weight:number}) = 1
ignoreHitPause = 1

[State -1, AI Angela Enemy Jump Count Add]
type = VarAdd
triggerAll = ${var.ai_enabled} && RoundState = 2 && NumEnemy
triggerAll = EnemyNear(${var.target_index}), StateType = A
trigger1 = EnemyNear(${var.target_index}), Time = 1
fvar(${fvar.enemy_jump_count:number}) = 1
ignoreHitPause = 1

[State -1, AI Angela Enemy Jump Count Decay]
type = VarAdd
triggerAll = ${var.ai_enabled} && RoundState = 2 && NumEnemy
triggerAll = EnemyNear(${var.target_index}), StateType != A
trigger1 = GameTime % 60 = 0
fvar(${fvar.enemy_jump_count:number}) = -1
ignoreHitPause = 1

[State -1, AI Angela Enemy Jump Count Clamp Max]
type = VarSet
trigger1 = fvar(${fvar.enemy_jump_count:number}) > 15
fvar(${fvar.enemy_jump_count:number}) = 15
ignoreHitPause = 1

[State -1, AI Angela Enemy Jump Count Clamp Min]
type = VarSet
trigger1 = fvar(${fvar.enemy_jump_count:number}) < 0
fvar(${fvar.enemy_jump_count:number}) = 0
ignoreHitPause = 1

[State -1, AI Angela Power Level 0]
type = VarSet
trigger1 = ${var.ai_enabled} && Power < 500
var(${var.power_level:number}) = 0
ignoreHitPause = 1

[State -1, AI Angela Power Level 1]
type = VarSet
trigger1 = ${var.ai_enabled} && Power >= 500 && Power < 1000
var(${var.power_level:number}) = 1
ignoreHitPause = 1

[State -1, AI Angela Power Level 2]
type = VarSet
trigger1 = ${var.ai_enabled} && Power >= 1000 && Power < 2000
var(${var.power_level:number}) = 2
ignoreHitPause = 1

[State -1, AI Angela Power Level 3]
type = VarSet
trigger1 = ${var.ai_enabled} && Power >= 2000 && Power < 3000
var(${var.power_level:number}) = 3
ignoreHitPause = 1

[State -1, AI Angela Power Level 4]
type = VarSet
trigger1 = ${var.ai_enabled} && Power >= 3000
var(${var.power_level:number}) = 4
ignoreHitPause = 1

[State -1, AI Angela Route Lock Decay]
type = VarAdd
trigger1 = ${var.ai_enabled} && var(${var.route_lock:number}) > 0
var(${var.route_lock:number}) = -1
ignoreHitPause = 1
; AI_PATCH_END: angela_ag:angela_runtime_sensor:v1
```

## Module: angela_defense_router

### Target

```yaml
file: cmd
insert_after_module: angela_runtime_sensor
risk: medium
route_preview:
  - id: angela_defense_routes
    type: defensive_route
    source: angela_parry_roll_guard
    chain:
      - crouch_parry
      - stand_parry
      - air_parry
      - stand_guard
      - roll_forward
      - roll_back
    condition:
      - enemy_attack_or_projectile
      - parry_cooldown_clear
      - low_threat_prefers_crouch_parry
      - close_threat_prefers_back_roll
    policy:
      - defense_before_rushdown
      - do_not_parry_while_in_hit_state
      - reset_space_with_roll_when_p2_is_too_close
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: angela_ag:angela_defense_router:v1
[State -1, AI Angela Low Crouch Parry]
type = HitOverride
triggerAll = ${var.ai_enabled} && NumEnemy
triggerAll = RoundState = 2 && StateType != A && MoveType != H
triggerAll = var(${var.parry_cd:number}) <= 0 || StateNo = [${state.stand_parry},${state.crouch_parry}]
triggerAll = EnemyNear(${var.target_index}), MoveType = A || Enemy, NumProj > 0
triggerAll = EnemyNear(${var.target_index}), StateType = C || EnemyNear(${var.target_index}), StateNo = [400,500]
triggerAll = P2BodyDist X < ${range.parry_x}
trigger1 = Ctrl && Random < 220
trigger1 = var(${var.parry_cd:number}) := 18
attr = C, NA, SA, HA
stateNo = ${state.crouch_parry}
slot = 0
time = 8

[State -1, AI Angela Stand Parry]
type = HitOverride
triggerAll = ${var.ai_enabled} && NumEnemy
triggerAll = RoundState = 2 && StateType != A && MoveType != H
triggerAll = var(${var.parry_cd:number}) <= 0 || StateNo = [${state.stand_parry},${state.crouch_parry}]
triggerAll = EnemyNear(${var.target_index}), MoveType = A || Enemy, NumProj > 0
triggerAll = !(EnemyNear(${var.target_index}), StateType = C && EnemyNear(${var.target_index}), MoveType = A)
triggerAll = P2BodyDist X < ${range.parry_x}
trigger1 = Ctrl && Random < 170
trigger1 = var(${var.parry_cd:number}) := 16
attr = SA, AA, AP
stateNo = ${state.stand_parry}
slot = 1
time = 8

[State -1, AI Angela Air Parry]
type = HitOverride
triggerAll = ${var.ai_enabled} && NumEnemy
triggerAll = RoundState = 2 && StateType = A && MoveType != H
triggerAll = var(${var.parry_cd:number}) <= 0 || StateNo = ${state.air_parry}
triggerAll = EnemyNear(${var.target_index}), MoveType = A || Enemy, NumProj > 0
trigger1 = Ctrl && Random < 145
trigger1 = var(${var.parry_cd:number}) := 14
attr = SA, AA, AP
stateNo = ${state.air_parry}
forceAir = 1
slot = 2
time = 7

[State -1, AI Angela Smart Guard]
type = ChangeState
value = ${state.stand_guard}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Ctrl || StateNo = [21,22]
trigger1 = fvar(${fvar.threat_flag:number}) > 0 && InGuardDist

[State -1, AI Angela Roll Forward Through Threat]
type = ChangeState
value = ${state.roll_forward}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Ctrl || StateNo = [100,101]
triggerAll = EnemyNear(${var.target_index}), MoveType = A && EnemyNear(${var.target_index}), Ctrl = 0
triggerAll = EnemyNear(${var.target_index}), BackEdgeDist > 10 || P2BodyDist X >= 100
trigger1 = Random < 150

[State -1, AI Angela Roll Back Close Threat]
type = ChangeState
value = ${state.roll_back}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Ctrl || StateNo = [100,101]
triggerAll = EnemyNear(${var.target_index}), MoveType = A
triggerAll = P2BodyDist X <= 40 && BackEdgeBodyDist > 45
trigger1 = Random < 185
; AI_PATCH_END: angela_ag:angela_defense_router:v1
```

## Module: angela_anti_air_router

### Target

```yaml
file: cmd
insert_after_module: angela_defense_router
risk: medium
route_preview:
  - id: angela_anti_air_routes
    type: anti_air_route
    source: love_me_whip_and_close_aa
    chain:
      - anti_air_special
      - strong_launcher
      - air_strong
      - air_special
    condition:
      - enemy_airborne_or_high_y
      - enemy_attacking_or_jump_memory
      - scanner_x_y_window
    policy:
      - prefer_long_anti_air_when_enemy_is_high
      - use_close_launcher_or_air_normal_when_too_close
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: angela_ag:angela_anti_air_router:v1
[State -1, AI Angela Love Me Whip Anti Air]
type = ChangeState
value = ${state.anti_air_special}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Ctrl || StateNo = [21,22]
triggerAll = EnemyNear(${var.target_index}), StateType = A || P2BodyDist Y <= -90
triggerAll = EnemyNear(${var.target_index}), MoveType = A || fvar(${fvar.enemy_jump_count:number}) >= 4
triggerAll = P2BodyDist X = [40,${range.anti_air_x}]
triggerAll = P2BodyDist Y <= ${range.anti_air_y}
trigger1 = Random < 260 || ${var.ai_enabled} > 5

[State -1, AI Angela Close Anti Air Launcher]
type = ChangeState
value = ${state.strong_launcher}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Ctrl || StateNo = [21,22]
triggerAll = EnemyNear(${var.target_index}), StateType = A || P2BodyDist Y <= -75
triggerAll = P2BodyDist X = [-5,55]
trigger1 = Random < 170

[State -1, AI Angela Air Punish]
type = ChangeState
value = ${state.air_strong}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType = A && MoveType != H
triggerAll = Ctrl
triggerAll = Vel Y > -2
triggerAll = EnemyNear(${var.target_index}), StateType != L
triggerAll = P2BodyDist X = [0,70]
triggerAll = P2BodyDist Y = [-80,20]
trigger1 = Random < 155

[State -1, AI Angela Air Special Followup]
type = ChangeState
value = ${state.air_special}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType = A && MoveType != H
triggerAll = MoveHit || MoveContact
triggerAll = EnemyNear(${var.target_index}), MoveType = H
triggerAll = P2BodyDist X = [0,80]
trigger1 = Random < 175
; AI_PATCH_END: angela_ag:angela_anti_air_router:v1
```

## Module: angela_grappler_pressure

### Target

```yaml
file: cmd
insert_after_module: angela_anti_air_router
risk: medium
route_preview:
  - id: angela_grappler_routes
    type: grappler_pressure
    source: angela_throw_and_giant_buster
    chain:
      - throw_state
      - level3_super
    condition:
      - close_grounded_target
      - grab_cooldown_clear
      - full_power_or_corner_pressure
      - enemy_not_liedown
    policy:
      - level3_is_close_only
      - do_not_call_throw_when_enemy_in_hitstun_or_airborne
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: angela_ag:angela_grappler_pressure:v1
[State -1, AI Angela Close Throw]
type = ChangeState
value = ${state.throw_state}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Ctrl || StateNo = [21,22]
triggerAll = fvar(${fvar.grab_cd:number}) <= 0
triggerAll = EnemyNear(${var.target_index}), StateType != A && EnemyNear(${var.target_index}), StateType != L
triggerAll = EnemyNear(${var.target_index}), MoveType != H
triggerAll = P2BodyDist X < ${range.close_throw_x}
trigger1 = Random < ifElse(var(${var.archetype_mode:number}) >= 4, 230, 120)

[State -1, AI Angela Giant Buster Close Punish]
type = ChangeState
value = ${state.level3_super}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Power >= ${state.level3_super:cost}
triggerAll = Ctrl || StateNo = [21,22]
triggerAll = EnemyNear(${var.target_index}), StateType != A && EnemyNear(${var.target_index}), StateType != L
triggerAll = EnemyNear(${var.target_index}), MoveType != H || EnemyNear(${var.target_index}), Ctrl = 0
triggerAll = P2BodyDist X = [10,${range.level3_x}]
triggerAll = P2BodyDist Y = [${range.grounded_min_y},${range.grounded_max_y}]
trigger1 = fvar(${fvar.grappler_weight:number}) >= 4 && Random < 170
trigger2 = EnemyNear(${var.target_index}), BackEdgeDist < 45 && Random < 220
; AI_PATCH_END: angela_ag:angela_grappler_pressure:v1
```

## Module: angela_branch_b_combo

### Target

```yaml
file: cmd
insert_after_module: angela_grappler_pressure
risk: medium
route_preview:
  - id: angela_branch_b_low_confirm
    type: ground_route
    source: angela_430_440_reliable_cashout_or_1200
    chain:
      - light_low
      - medium_low
      - projectile_super_start
      - close_pressure
    condition:
      - light_low_hit
      - medium_low_hit
      - scanner_resolved_close_range
      - power_gate_for_super
    policy:
      - use_close_confirm_meter_state_when_power_is_available
      - keep_close_super_grab_alias_for_point_blank_punish_only
      - use_close_pressure_when_meter_is_not_available
      - start_route_only_against_grounded_nonblocking_target
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: angela_ag:angela_branch_b_combo:v1
[State -1, AI Angela Branch B Entry Low]
type = ChangeState
value = ${state.light_low}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Ctrl && var(${var.route_lock:number}) <= 0
triggerAll = EnemyNear(${var.target_index}), StateType != A && EnemyNear(${var.target_index}), StateType != L
triggerAll = EnemyNear(${var.target_index}), MoveType != H
triggerAll = EnemyNear(${var.target_index}), StateNo != [120,155]
triggerAll = P2BodyDist X = [0,${range.low_confirm_x}]
trigger1 = Random < ifElse(Life < LifeMax * 0.35, 260, 185)

[State -1, AI Angela Branch B Low To Medium]
type = ChangeState
value = ${state.medium_low}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A && MoveType != H
triggerAll = StateNo = ${state.light_low} && MoveHit
triggerAll = EnemyNear(${var.target_index}), StateType != L
trigger1 = 1

[State -1, AI Angela Branch B Medium To Super]
type = ChangeState
value = ${state.projectile_super_start}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Power >= ${state.projectile_super_start:cost}
triggerAll = StateNo = ${state.medium_low} && MoveHit
triggerAll = EnemyNear(${var.target_index}), MoveType = H && EnemyNear(${var.target_index}), StateType != L
triggerAll = P2BodyDist X < ${range.combo_cashout_x}
triggerAll = P2BodyDist Y = [${range.grounded_min_y},${range.grounded_max_y}]
trigger1 = Random < 320
trigger1 = var(${var.route_lock:number}) := 14

[State -1, AI Angela Branch B Medium To Body Attack]
type = ChangeState
value = ${state.close_pressure}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Power < ${state.projectile_super_start:cost}
triggerAll = StateNo = ${state.medium_low} && MoveHit
triggerAll = EnemyNear(${var.target_index}), MoveType = H && EnemyNear(${var.target_index}), StateType != L
triggerAll = P2BodyDist X < ${range.combo_cashout_x}
trigger1 = 1
trigger1 = var(${var.route_lock:number}) := 12
; AI_PATCH_END: angela_ag:angela_branch_b_combo:v1
```

## Module: angela_retreat_reset

### Target

```yaml
file: cmd
insert_after_module: angela_branch_b_combo
risk: low
route_preview:
  - id: angela_post_combo_retreat
    type: spacing_reset
    source: angela_knockdown_retreat
    chain:
      - back_dash
      - power_charge
    condition:
      - opponent_liedown_or_airborne_after_combo
      - close_distance_is_unsafe
      - no_projectile_pressure
    policy:
      - retreat_before_charging
      - avoid_meaty_when_opponent_is_down
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: angela_ag:angela_retreat_reset:v1
[State -1, AI Angela Post Combo Retreat Set]
type = VarSet
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A
triggerAll = Ctrl && var(${var.retreat_steps:number}) = 0
triggerAll = EnemyNear(${var.target_index}), StateType = A || EnemyNear(${var.target_index}), StateType = L
trigger1 = PrevStateNo = ${state.medium_low}
trigger2 = PrevStateNo = ${state.close_pressure}
trigger3 = PrevStateNo = ${state.projectile_super_start}
trigger4 = PrevStateNo = ${state.close_super}
var(${var.retreat_steps:number}) = 2
ignoreHitPause = 1

[State -1, AI Angela Retreat Execute]
type = ChangeState
value = ${state.back_dash}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A && MoveType != H
triggerAll = var(${var.retreat_steps:number}) > 0 && StateNo != ${state.back_dash}
triggerAll = Ctrl || StateNo = [21,22]
trigger1 = P2BodyDist X < ${range.retreat_close_x} || EnemyNear(${var.target_index}), StateType = L

[State -1, AI Angela Knockdown Safe Charge]
type = ChangeState
value = ${state.power_charge}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Ctrl && Power < Const(data.power) && Power < PowerMax
triggerAll = EnemyNear(${var.target_index}), StateType = L
triggerAll = P2BodyDist X = [${range.charge_safe_min_x},${range.charge_safe_max_x}]
triggerAll = Enemy, NumProj = 0 && !InGuardDist
trigger1 = Random < 120
; AI_PATCH_END: angela_ag:angela_retreat_reset:v1
```

## Module: angela_meter_cashout

### Target

```yaml
file: cmd
insert_after_module: angela_retreat_reset
risk: medium
route_preview:
  - id: angela_meter_cashout_routes
    type: super_cashout
    source: rolling_thunder_foxy_lady_giant_buster
    chain:
      - close_super
      - rush_hyper
      - projectile_super_start
      - projectile_super_fire
      - level3_super
    condition:
      - power_gate
      - hit_confirm_or_idle_punish
      - scanner_x_y_window
      - target_not_liedown
    policy:
      - do_not_chain_multiple_meter_spenders_unless_total_power_allows
      - close_only_meter_uses_scanner_y_window
      - close_confirm_meter_uses_3000_3010_3300_or_target_equivalent
      - grab_meter_uses_3100_3150_only_as_point_blank_grounded_punish
      - install_or_self_buff_meter_is_setup_only_not_combo_finisher
      - unsafe_raw_meter_states_are_blocked
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: angela_ag:angela_meter_cashout:v1
; AI_PATCH_METER_POLICY: close_confirm states require MoveHit, scanner X/Y, and target_not_liedown.
; AI_PATCH_METER_POLICY: grab states require point-blank grounded punish; setup utility is never a combo finisher; unsafe_raw is blocked.
[State -1, AI Angela Close Super Cashout]
type = ChangeState
value = ${state.close_super}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Power >= ${state.close_super:cost}
triggerAll = var(${var.route_lock:number}) <= 0
triggerAll = EnemyNear(${var.target_index}), StateType != A && EnemyNear(${var.target_index}), StateType != L
triggerAll = EnemyNear(${var.target_index}), Ctrl = 0 || EnemyNear(${var.target_index}), MoveType = H
triggerAll = P2BodyDist X = [0,${range.close_throw_x}]
triggerAll = P2BodyDist Y = [${range.grounded_min_y},${range.grounded_max_y}]
trigger1 = Ctrl && EnemyNear(${var.target_index}), MoveType != A && EnemyNear(${var.target_index}), Ctrl = 0
trigger1 = Random < 45

[State -1, AI Angela Hyper Cashout]
type = ChangeState
value = ${state.rush_hyper}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Power >= ${state.rush_hyper:cost}
triggerAll = var(${var.route_lock:number}) <= 0
triggerAll = EnemyNear(${var.target_index}), StateType != A && EnemyNear(${var.target_index}), StateType != L
triggerAll = EnemyNear(${var.target_index}), Ctrl = 0 || EnemyNear(${var.target_index}), MoveType = H
triggerAll = P2BodyDist X = [0,${range.close_throw_x}]
triggerAll = P2BodyDist Y = [${range.grounded_min_y},${range.grounded_max_y}]
trigger1 = EnemyNear(${var.target_index}), Life < 350 && Ctrl && EnemyNear(${var.target_index}), MoveType != A && EnemyNear(${var.target_index}), Ctrl = 0
trigger1 = Random < 55

[State -1, AI Angela Rolling Thunder Wall Cashout]
type = ChangeState
value = ${state.projectile_super_start}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Power >= ${state.projectile_super_start:cost}
triggerAll = EnemyNear(${var.target_index}), StateType != L
triggerAll = P2BodyDist X = [35,${range.close_super_x}]
triggerAll = P2BodyDist Y = [${range.grounded_min_y},${range.grounded_max_y}]
trigger1 = MoveHit && EnemyNear(${var.target_index}), MoveType = H
trigger1 = Random < 155
trigger2 = Ctrl && EnemyNear(${var.target_index}), MoveType != A && EnemyNear(${var.target_index}), Ctrl = 0
trigger2 = Random < 55

[State -1, AI Angela MAX Rolling Thunder Wall Cashout]
type = ChangeState
value = ${state.projectile_super_fire}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Power >= ${state.projectile_super_fire:cost}
triggerAll = EnemyNear(${var.target_index}), StateType != L
triggerAll = P2BodyDist X = [35,${range.close_super_x}]
triggerAll = P2BodyDist Y = [${range.grounded_min_y},${range.grounded_max_y}]
trigger1 = MoveHit && EnemyNear(${var.target_index}), MoveType = H
trigger1 = Random < 130
trigger2 = EnemyNear(${var.target_index}), Life < 450 && Ctrl && EnemyNear(${var.target_index}), MoveType != A
trigger2 = Random < 75

[State -1, AI Angela Level 3 Close Cashout]
type = ChangeState
value = ${state.level3_super}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A && MoveType != H
triggerAll = Power >= ${state.level3_super:cost}
triggerAll = var(${var.archetype_mode:number}) >= 4
triggerAll = Ctrl || MoveHit || MoveContact
triggerAll = EnemyNear(${var.target_index}), StateType != A && EnemyNear(${var.target_index}), StateType != L
triggerAll = P2BodyDist X = [10,${range.level3_x}]
triggerAll = P2BodyDist Y = [${range.grounded_min_y},${range.grounded_max_y}]
trigger1 = EnemyNear(${var.target_index}), BackEdgeDist < 45 && Random < 190
trigger2 = EnemyNear(${var.target_index}), Life < 500 && Random < 130
; AI_PATCH_END: angela_ag:angela_meter_cashout:v1
```

## AIR Review Notes

AngelaAI has several helper-trap and projectile-like states whose AIR reach comes
from helper/effective reach:

- 1400/1430: long vertical anti-air/helper-trap style.
- 3000/3010: scanned as close-confirm cashout, reach X about 76, startup 9.
- 3100/3150: scanned as grab-style punish, reach X about 80, startup 5; use
  only for point-blank grounded punish or target resolver equivalent.
- 3300: scanned as close-confirm level 3, reach X about 53, startup 1; keep it
  close/corner-only because it is short-range.
- 730/750/770: setup utility, not combo finishers.
- 8330: unsafe/raw helper state; block direct automatic generation.

When patching another character, resolver should prefer scanner-confirmed direct
root-attack states. If a selected target is helper-only, visual-only, or missing
actions, use fallback or review mode instead of direct ChangeState.
