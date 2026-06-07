---
brain_id: boxer_bl
name: Boxer Balanced Low Defense Brain
version: 2
target_engine: ikemen-go
source_reference: Heavy D! AI architecture
description: >
  Template brain for boxer/striker characters with ground chains, anti-air routes,
  roll, charge, parry, zero counter, and meter cashout. It follows the current
  Heavy D! architecture: low-defense hybrid, Ryu-style HitOverride parry,
  post-zero router, knockdown reset,
  light -> medium -> strong -> special/EX -> super/hyper combo routing. It is
  combo-scan-aware: HitDef, cancel edges, AIR reach, and power costs are used
  to decide whether routes are safe, review-only, or suitable for Safe Lite.
ai_style: >
  Boxer/striker balanced-low-defense. It prioritizes threat reading, low guard/parry,
  roll-based spacing resets, close-range hit-confirms, and boss-rush pressure when
  life is low. Route decisions should prefer scanner-confirmed combo links over
  hardcoded state aliases.
ai_strengths: >
  Hybrid low-attack defense, Ryu-style HitOverride parry, safer zero-counter follow-up,
  knockdown reset into power charge, close-range cashout, boss-rush mode, and air
  pursuit routing. The brain can use comboScan data to validate HitDef, MoveHit/
  MoveContact cancel edges, AIR reach, meter reliability class, multi-hit timing,
  and power cost before marking a route safe.
ai_weaknesses: >
  Depends heavily on each character's state/action map. If AIR hitboxes are short or
  launcher states do not create usable hitstun, anti-air and EX routes can whiff.
  Dynamic or unconfirmed routes should stay in needs_review. Heavy D source has
  several meter states that scan as grab/install/unsafe_raw, so resolver should not
  use source names alone as hit-confirm cashout evidence. Full behavior needs enough
  free variables or a resolved conflict plan, though Safe Lite can still apply clean
  modules.
combo_routes: >
  430 hit -> 440 -> 1200/1000; 420 hit -> 1400/EX anti-air; light low -> medium low
  -> rush special; launcher -> anti-air special/EX anti-air; close confirm should
  cash out through scanner-confirmed close_confirm/projectile meter aliases, not
  through grab/install aliases. Heavy D source scan confirms 2900/2910 as close-
  confirm supers, 3005 as projectile spacing/punish, 2000/2050/3100/3101/4000/4011
  as grab-style punish, and 750/770/3000/3050/6060/6061 as setup utility. Each route
  should be promoted to safe only when comboScan confirms HitDef/cancel/AIR reach
  requirements; otherwise it remains needs_review or Safe Lite skips it.
runtime_safety: >
  The AI runtime flag must be bridged from AILevel before State -1/State -3 logic
  reads it, then cleared when AILevel is off. Parry aliases must resolve to real
  StateDefs such as 6080/6081/6082, 1300/1310/1320, or 760/761/762; never inject
  a missing parry state. Air parry must not trigger while the character is in hit
  states or common get-hit states 5000-5999. Generated ChangeState routes must keep
  power gates, target-not-liedown guards, multi-hit last-hit guards, and meter
  reliability policy: close_confirm requires hit confirm, projectile requires safe
  spacing/punish, grab is point-blank punish only, install/self_buff is setup only,
  and unsafe_raw is blocked.
---

# Brain Boxer BL

Brain nay duoc viet de AI Patcher doc va tao patch plan. Tat ca bien deu la logical variable, khong duoc hardcode `var(n)` trong template. Patcher phai resolve `${var.*}`, `${fvar.*}`, `${state.*}`, `${file.*}` truoc khi apply.

## Conflict Policy

UI phai hien 4 muc xu ly conflict:

- `auto_remap`: neu preferred var/state bi dung, tim slot trong khac.
- `reuse_compatible`: chi dung lai khi scanner thay bien/state co cung muc dich.
- `manual_choose`: nguoi dung tu chon mapping.
- `abort_patch`: dung module neu khong resolve an toan.

Default policy cua brain nay la `auto_remap`, rieng `ai_enabled` nen `reuse_compatible` neu nhan vat da co AI var.

## Variables

```yaml
variables:
  - id: ai_enabled
    kind: var
    preferred: 59
    purpose: Tournament AI enabled flag / AILevel bridge
    conflict: reuse_compatible

  - id: ai_scalar
    kind: var
    preferred: 40
    purpose: AI level / chance scalar
    conflict: auto_remap

  - id: boss_rush
    kind: var
    preferred: 41
    purpose: Boss rushdown flag when life is low
    conflict: auto_remap

  - id: threat_class
    kind: var
    preferred: 42
    purpose: 0 none, 1 low/projectile, 2 mid/high/air, 3 throw/unblockable
    conflict: auto_remap

  - id: route_selector
    kind: var
    preferred: 43
    purpose: 0 neutral, 1 safe, 2 bnb, 3 ex, 4 super, 5 kill, 6 reset, 7 corner, 8 anti-air, 9 whiff punish
    conflict: auto_remap

  - id: anti_projectile_score
    kind: var
    preferred: 44
    purpose: Projectile pressure / fireball chain score
    conflict: auto_remap

  - id: defensive_cd
    kind: var
    preferred: 45
    purpose: Defensive cooldown
    conflict: auto_remap

  - id: offensive_cd
    kind: var
    preferred: 46
    purpose: Offensive cooldown
    conflict: auto_remap

  - id: combo_intent
    kind: var
    preferred: 47
    purpose: Combo intent timer
    conflict: auto_remap

  - id: charge_intent
    kind: var
    preferred: 48
    purpose: Power charge intent timer
    conflict: auto_remap

  - id: parry_memory
    kind: var
    preferred: 49
    purpose: 18 stand parry, 28 crouch parry, 38 air parry
    conflict: auto_remap

  - id: post_zero_timer
    kind: var
    preferred: 51
    purpose: Timer after zero counter to route follow-up safely
    conflict: auto_remap

  - id: anti_launcher_air_timer
    kind: var
    preferred: 52
    purpose: Air parry timer after launcher threat
    conflict: auto_remap

  - id: air_pursuit_timer
    kind: var
    preferred: 53
    purpose: Air combo pursuit timer after launcher/extender
    conflict: auto_remap

fvariables:
  - id: chance_mult
    kind: fvar
    preferred: 32
    purpose: AI random chance multiplier
    conflict: auto_remap

  - id: whiff_projectile_score
    kind: fvar
    preferred: 39
    purpose: Whiff/projectile punish score
    conflict: auto_remap
```

## State Aliases

```yaml
states:
  - id: stand_guard
    preferred: 130
    purpose: standing guard
    conflict: reuse_compatible

  - id: crouch_guard
    preferred: 131
    purpose: crouching guard
    conflict: reuse_compatible

  - id: air_guard
    preferred: 132
    purpose: air guard
    conflict: reuse_compatible

  - id: stand_parry
    preferred: 760
    purpose: standing parry
    conflict: reuse_compatible

  - id: crouch_parry
    preferred: 761
    purpose: crouching parry
    conflict: reuse_compatible

  - id: air_parry
    preferred: 762
    purpose: air parry
    conflict: reuse_compatible

  - id: roll_forward
    preferred: 710
    purpose: forward roll / roll-through
    conflict: reuse_compatible

  - id: roll_back
    preferred: 715
    purpose: back roll / spacing reset
    conflict: reuse_compatible

  - id: power_charge
    preferred: 730
    purpose: power charge
    conflict: reuse_compatible

  - id: zero_counter
    preferred: 750
    purpose: zero counter / guard counter
    conflict: reuse_compatible

  - id: light_low
    preferred: 430
    purpose: crouch light kick / low starter
    conflict: manual_choose

  - id: medium_low
    preferred: 440
    purpose: crouch medium kick / low bridge
    conflict: manual_choose

  - id: strong_launcher
    preferred: 420
    purpose: crouch strong / launcher
    conflict: manual_choose

  - id: close_pressure
    preferred: 1100
    purpose: close pressure special
    conflict: manual_choose

  - id: rush_special
    preferred: 1000
    purpose: advancing special / RSD style carry
    conflict: manual_choose

  - id: ducking_special
    preferred: 1200
    purpose: ducking route / special bridge
    conflict: manual_choose

  - id: anti_air_special
    preferred: 1400
    purpose: blast upper / anti-air special
    conflict: manual_choose

  - id: ex_anti_air
    preferred: 1430
    purpose: EX blast upper
    conflict: manual_choose

  - id: close_confirm_super
    preferred: 2900
    purpose: scanner-confirmed close-confirm level 1 cashout
    conflict: manual_choose

  - id: close_confirm_super_alt
    preferred: 2910
    purpose: alternate scanner-confirmed close-confirm level 1 cashout
    conflict: manual_choose

  - id: close_super
    preferred: 2000
    purpose: close grab-style super; point-blank grounded punish only
    conflict: manual_choose

  - id: projectile_super_start
    preferred: 3000
    purpose: charged projectile/install super start; setup/review unless target resolver maps a reliable attack
    conflict: manual_choose

  - id: projectile_super_fire
    preferred: 3005
    purpose: projectile super release / spacing-or-punish cashout
    conflict: manual_choose

  - id: rush_hyper
    preferred: 3100
    purpose: ground rush hyper grab-style finisher; point-blank punish only unless target scanner marks it close_confirm
    conflict: manual_choose
```

## Command Aliases

Commands are treated as compatibility gates. Any brain module that references a named command must resolve it against the target character `.cmd` file or against Ikemen/M.U.G.E.N built-in hold commands before Preview Diff and Apply Patch can write it.

```yaml
commands:
  - id: hold_back
    preferred: holdback
    purpose: built-in backward hold command used by parry reset logic
    conflict: reuse_compatible

  - id: hold_up
    preferred: holdup
    purpose: built-in upward hold command used by parry reset logic
    conflict: reuse_compatible
```

## Ranges

Range la logical value, patcher phai resolve theo `RangeProfile` cua tung nhan vat. `preferred` duoc lay theo Heavy D! lam fallback, khong phai gia tri bat buoc.

```yaml
ranges:
  - id: neutral_reset_x
    preferred: 120
    derive: enemy_non_attack_reset_distance
    min: 75
    max: 170
    conflict: auto_derive

  - id: low_threat_x
    preferred: 118
    derive: max_enemy_crouch_attack_reach_plus_guard_buffer
    min: 72
    max: 150
    conflict: auto_derive

  - id: low_parry_close_x
    preferred: 72
    derive: fast_low_reach_close_parry_window
    min: 48
    max: 95
    conflict: auto_derive

  - id: crouch_guard_x
    preferred: 125
    derive: max_enemy_crouch_attack_reach_plus_20
    min: 80
    max: 165
    conflict: auto_derive

  - id: throw_threat_x
    preferred: 24
    derive: enemy_throw_or_point_blank_range
    min: 16
    max: 42
    conflict: auto_derive

  - id: close_threat_x
    preferred: 18
    derive: point_blank_attack_range
    min: 12
    max: 36
    conflict: auto_derive

  - id: post_zero_near_min_x
    preferred: 24
    derive: own_fast_low_min_confirm_x
    min: 0
    max: 45
    conflict: auto_derive

  - id: post_zero_near_max_x
    preferred: 75
    derive: own_medium_low_reach_minus_safety_margin
    min: 50
    max: 110
    conflict: auto_derive

  - id: post_zero_mid_min_x
    preferred: 76
    derive: own_medium_low_reach_plus_1
    min: 45
    max: 120
    conflict: auto_derive

  - id: post_zero_mid_max_x
    preferred: 132
    derive: own_rush_special_confirm_reach
    min: 90
    max: 190
    conflict: auto_derive

  - id: post_zero_far_x
    preferred: 132
    derive: own_rush_special_confirm_reach
    min: 90
    max: 190
    conflict: auto_derive

  - id: knockdown_roll_back_x
    preferred: 122
    derive: enemy_wakeup_reach_plus_roll_buffer
    min: 80
    max: 175
    conflict: auto_derive

  - id: charge_safe_min_x
    preferred: 155
    derive: enemy_wakeup_reach_plus_60
    min: 110
    max: 230
    conflict: auto_derive

  - id: charge_safe_max_x
    preferred: 285
    derive: enemy_wakeup_reach_plus_190
    min: 180
    max: 360
    conflict: auto_derive

  - id: light_to_medium_min_x
    preferred: 0
    derive: own_light_min_confirm_x
    min: -20
    max: 20
    conflict: auto_derive

  - id: light_to_medium_max_x
    preferred: 112
    derive: own_medium_reach_plus_14
    min: 70
    max: 160
    conflict: auto_derive

  - id: medium_to_special_min_x
    preferred: 55
    derive: own_close_reach_multiplier
    min: 20
    max: 90
    conflict: auto_derive

  - id: medium_to_special_max_x
    preferred: 122
    derive: own_rush_special_confirm_reach
    min: 80
    max: 180
    conflict: auto_derive

  - id: launcher_min_x
    preferred: -20
    derive: own_launcher_back_reach
    min: -60
    max: 20
    conflict: auto_derive

  - id: launcher_max_x
    preferred: 105
    derive: own_launcher_front_reach_plus_16
    min: 65
    max: 165
    conflict: auto_derive

  - id: ex_confirm_min_x
    preferred: 0
    derive: own_ex_confirm_min_x
    min: -20
    max: 30
    conflict: auto_derive

  - id: ex_confirm_max_x
    preferred: 55
    derive: own_ex_confirm_reach
    min: 35
    max: 95
    conflict: auto_derive

  - id: close_super_x
    preferred: 60
    derive: own_close_super_high_hit_range
    min: 35
    max: 95
    conflict: auto_derive

  - id: projectile_super_min_x
    preferred: 85
    derive: own_projectile_super_min_safe_x
    min: 55
    max: 130
    conflict: auto_derive

  - id: projectile_super_max_x
    preferred: 175
    derive: own_projectile_super_max_hit_x
    min: 120
    max: 260
    conflict: auto_derive

  - id: grounded_min_y
    preferred: -60
    derive: grounded_target_min_y
    min: -100
    max: -20
    conflict: auto_derive

  - id: post_zero_near_min_y
    preferred: -45
    derive: own_medium_low_vertical_tolerance
    min: -80
    max: -20
    conflict: auto_derive

  - id: post_zero_mid_min_y
    preferred: -60
    derive: own_rush_special_vertical_tolerance
    min: -100
    max: -20
    conflict: auto_derive

  - id: post_zero_far_min_y
    preferred: -70
    derive: roll_chase_vertical_tolerance
    min: -120
    max: -20
    conflict: auto_derive

  - id: grounded_abs_y
    preferred: 50
    derive: grounded_confirm_vertical_abs
    min: 30
    max: 90
    conflict: auto_derive

  - id: cashout_abs_y
    preferred: 80
    derive: super_cashout_vertical_abs
    min: 45
    max: 130
    conflict: auto_derive
```

## AIR Patch Policy

This brain can read `.air` files to obtain hitbox reach, action id, Clsn1/Clsn2,
and active-frame windows. It must not auto-edit `.air` only from a state id,
because every character can map states to actions differently.

The patcher may create an AIR patch only when these four inputs are available:

- `state_id`: state trong `.cmd/.cns/.st` dang can AI goi.
- `action_id`: action trong `.air` duoc state do dung.
- `intent`: muc dich sua, vi du `extend_confirm`, `fix_whiff`, `reduce_miss`, `air_followup_align`.
- `box_delta` hoac `box_profile`: thay doi Clsn1/Clsn2 cu the theo frame/action, co preview diff.

If any input is missing, the UI must show the AIR module as `needs_review`
and must not apply an AIR edit.

```yaml
air_patch_policy:
  default: review_only
  safe_modes:
    - scan_only
    - preview_marker_notes
    - manual_action_mapping
  requires:
    - state_id
    - action_id
    - intent
    - box_delta
  forbidden:
    - global_scale_hitboxes
    - increase_damage
    - add_invulnerability
    - add_armor
    - heal_or_defense_boost
```

## Combo Scan Contract

This brain should prefer scanner-derived combo data over hardcoded assumptions.
Manual state aliases are still used as fallbacks, but the patcher should validate
each route against `comboScan` before applying or marking it as safe.

Required scan fields:

- `comboScan.states`: per-state role, HitDef summary, cancel targets, power cost, action ids, and AIR reach.
- `comboScan.cancelEdges`: numeric ChangeState edges with trigger summary and confidence.
- `comboScan.routeCandidates`: hit-confirm/contact edges that can become combo graph routes.
- `stateActionMap`: state-to-action mapping from CNS/ST.
- `airReach`: Clsn1 reach per action id.
- `states.powerCosts`: parsed or inferred meter cost bucket.

Validation policy:

- `safe`: source state has HitDef, target state exists, cancel is `MoveHit` or `MoveContact`, AIR reach exists for called attack states, and the route does not hit a lying opponent unless intended.
- `needs_review`: target is dynamic such as `value = var(...)`, AIR reach is missing, HitDef has expression-heavy velocity/stun, or target role is unknown.
- `unsafe`: target state is missing, source state has no HitDef for an attack route, required meter cost cannot be paid, or the route targets a grounded liedown opponent with a non-OTG attack.

Role mapping:

- Prefer `low starter` and `normal` for light/medium confirms.
- Prefer `launcher` or `special launcher` for air pursuit and anti-air routes.
- Prefer `special` for grounded extender routes.
- Prefer `super` only after hit-confirm, airborne/fall carry, low opponent life, or safe close range.
- Prefer `air normal` only while `StateType = A` and X/Y windows match `airReach`.

When `comboScan.routeCandidates` confirms a route that differs from the preferred
state alias route, the UI should show both choices and default to the scanner-confirmed
route. If no safe route exists, apply the module as Safe Lite only or keep it in review.

## Lite Fit And Boss Metadata

This metadata is based on a fresh scan of `chars/Heavy D!`. It is intended for
Hybrid Lite Fit planning: keep core boss behavior first, then add memory-heavy
modules only when the receiving character has enough safe vars or user-approved
reuse slots.

```yaml
source_scan:
  character: Heavy D!
  scanned_from: chars/Heavy D!
  var_slots:
    active: 52
    documented_only: 1
    hard_free: 7
    soft_free: 8
    hard_free_list: [2, 4, 11, 12, 27, 28, 37]
  fvar_slots:
    active: 16
    documented_only: 1
    hard_free: 23
    soft_free: 24
  combat_summary:
    starters: ok
    normal_chain: ok
    special_bridge: ok
    super_cashout: ok
    air_followup: ok
  useful_states:
    parry: [760, 761, 762]
    roll: [710, 715]
    run: [100, 101, 105, 106]
    charge: [730]
    zero_counter: [750]
    ex_500: [1030, 1120, 1220, 1430, 1530]
    ex_close_confirm: [1030, 1120, 1220, 1430, 1530]
    close_confirm_super_1000: [2900, 2910]
    projectile_super_1000: [3005]
    grab_super: [2000, 2050, 3100, 3101, 4000, 4011]
    setup_meter: [750, 770, 3000, 3050, 6060, 6061]
    unsafe_raw: [3115, 4002, 4015, 4020, 8330]
  meter_reliability_scan:
    scanner_version: meter_reliability_v1
    report: AI_Patcher/reports/heavy_d_scan_meter_reliability.json
    close_confirm:
      - { state: 1030, use: hit_confirm_only, confidence: 0.78, reach_x: 93, startup: 6, delivery: melee }
      - { state: 1120, use: hit_confirm_only, confidence: 0.78, reach_x: 86, startup: 4, delivery: melee }
      - { state: 1220, use: hit_confirm_only, confidence: 0.78, reach_x: 101, startup: 9, delivery: melee }
      - { state: 1430, use: hit_confirm_only, confidence: 0.78, reach_x: 87, startup: 6, delivery: helper_trap }
      - { state: 1530, use: hit_confirm_only, confidence: 0.78, reach_x: 55, startup: 7, delivery: crossup_melee }
      - { state: 2900, use: hit_confirm_only, confidence: 0.78, reach_x: 58, startup: 3, delivery: melee }
      - { state: 2910, use: hit_confirm_only, confidence: 0.78, reach_x: 81, startup: 4, delivery: melee }
    projectile:
      - { state: 3005, use: spacing_or_punish, confidence: 0.68, reach_x: 130, startup: null, delivery: helper_trap }
    grab:
      - { state: 2000, use: point_blank_punish_only, confidence: 0.76, reach_x: 94, startup: 5, delivery: helper_trap }
      - { state: 2050, use: point_blank_punish_only, confidence: 0.76, reach_x: 99, startup: 5, delivery: helper_trap }
      - { state: 3100, use: point_blank_punish_only, confidence: 0.76, reach_x: 58, startup: 3, delivery: helper_trap }
      - { state: 3101, use: point_blank_punish_only, confidence: 0.76, reach_x: 86, startup: 3, delivery: melee }
      - { state: 4000, use: point_blank_punish_only, confidence: 0.76, reach_x: 105, startup: 3, delivery: helper_trap }
      - { state: 4011, use: point_blank_punish_only, confidence: 0.76, reach_x: 85, startup: 3, delivery: melee }
    install:
      - { state: 750, use: safe_neutral_or_knockdown_setup, confidence: 0.58, reach_x: null, startup: null, delivery: helper_trap }
      - { state: 3000, use: safe_neutral_or_knockdown_setup, confidence: 0.66, reach_x: null, startup: null, delivery: helper_trap }
      - { state: 3050, use: safe_neutral_or_knockdown_setup, confidence: 0.66, reach_x: null, startup: null, delivery: helper_trap }
      - { state: 6060, use: safe_neutral_or_knockdown_setup, confidence: 0.58, reach_x: null, startup: null, delivery: melee }
      - { state: 6061, use: safe_neutral_or_knockdown_setup, confidence: 0.58, reach_x: null, startup: null, delivery: melee }
    self_buff:
      - { state: 770, use: knockdown_or_far_safe_only, confidence: 0.62, reach_x: null, startup: null, delivery: helper_trap }
    unsafe_raw:
      - { state: 3115, use: do_not_raw, confidence: 0.37 }
      - { state: 4002, use: do_not_raw, confidence: 0.37 }
      - { state: 4015, use: do_not_raw, confidence: 0.37 }
      - { state: 4020, use: do_not_raw, confidence: 0.37 }
      - { state: 8330, use: do_not_raw, confidence: 0.37 }
  confirmed_routes:
    - chain: [430, 1100]
      kind: hit_confirm
      note: scanner confirms crouch/normal starter into special launcher
    - chain: [440, 1100]
      kind: hit_confirm
      note: strong confirm into special launcher
    - chain: [3100, 3101]
      kind: grab_followup_review
      note: scanner classifies these as grab-style states; keep point-blank punish only unless target resolver confirms hit-confirm equivalent

boss_profiles:
  normal:
    trigger: "Life >= 500"
    aggression: 180
    parry_priority: high
    meter_cashout: confirmed_only
  rushdown:
    trigger: "Life < 500"
    aggression: 420
    parry_priority: high
    spacing: "use roll_forward/roll_back to enter or reset"
    meter_cashout: "hit_confirm_or_enemy_life_below_400"
  desperation:
    trigger: "Life < 250 || EnemyNear,Life < 220"
    aggression: 560
    parry_priority: high
    meter_cashout: "finish_when_safe"

lite_fit:
  variable_strategy:
    priority:
      - existing_ai_patch_mapping
      - hard_free
      - documented_only_soft_free
      - old_ai_after_quarantine
      - manual_approved_unknown
    forbidden_reuse:
      - gameplay_core
      - helper_projectile
      - state_machine
  module_policy:
    - id: cmd_runtime_bridge_early
      tier: core
      min_vars: [ai_enabled, ai_scalar]
      fallback:
        mode: skip_module
        keeps: [system_runtime_bridge]

    - id: system_threat_classifier
      tier: optional_memory
      min_vars: [ai_scalar, boss_rush, threat_class]
      fallback:
        mode: inline_trigger
        keeps: [boss_life_mode, direct_threat_check]
        trigger: "AILevel && NumEnemy && RoundState = 2"

    - id: hybrid_low_guard_parry
      tier: core_defense
      min_vars: [ai_enabled]
      optional_vars: [parry_memory, defensive_cd, threat_class]
      fallback:
        mode: direct_parry_guard
        trigger: "AILevel && NumEnemy && RoundState = 2 && (InGuardDist || EnemyNear,MoveType = A || Enemy,NumProj > 0)"

    - id: parry_core
      tier: core_defense
      min_vars: [ai_enabled]
      optional_vars: [parry_memory, defensive_cd]
      fallback:
        mode: direct_hitoverride
        trigger: "AILevel && NumEnemy && RoundState = 2 && StateType != A && InGuardDist"

    - id: post_zero_router
      tier: optional_route
      min_vars: [post_zero_timer]
      fallback:
        mode: skip_module
        keeps: [zero_counter_state_only]

    - id: knockdown_reset_charge
      tier: optional_utility
      min_vars: [charge_intent]
      fallback:
        mode: direct_spacing
        trigger: "EnemyNear,StateType = L || EnemyNear,StateNo = [5100,5120]"

    - id: combo_meter_priority_bridge
      tier: boss_core
      min_vars: [route_selector, combo_intent]
      optional_vars: [offensive_cd, boss_rush]
      fallback:
        mode: direct_hit_confirm
        trigger: "AILevel && NumEnemy && RoundState = 2 && (MoveHit || MoveContact)"

    - id: boxer_combo_router
      tier: boss_core
      min_vars: [route_selector]
      optional_vars: [combo_intent, offensive_cd, boss_rush]
      fallback:
        mode: scanner_confirmed_route_only
        trigger: "AILevel && NumEnemy && RoundState = 2 && (Ctrl || MoveHit || MoveContact)"

    - id: meter_cashout_safe
      tier: boss_core
      min_vars: [ai_enabled]
      optional_vars: [route_selector, combo_intent, boss_rush]
      fallback:
        mode: direct_super_cashout
        trigger: "AILevel && NumEnemy && RoundState = 2 && Power >= 1000 && (MoveHit || EnemyNear,Life < 220)"

    - id: boss_rush_mode
      tier: boss_flavor
      min_vars: [ai_enabled]
      optional_vars: [boss_rush, offensive_cd]
      fallback:
        mode: stateless_boss_trigger
        trigger: "AILevel && NumEnemy && RoundState = 2 && Life < 500"

    - id: air_action_review
      tier: review_only
      min_vars: []
      fallback:
        mode: report_only

fallback_triggers:
  low_defense_parry:
    stand: "AILevel && NumEnemy && RoundState = 2 && StateType = S && (InGuardDist || EnemyNear,MoveType = A)"
    crouch: "AILevel && NumEnemy && RoundState = 2 && StateType != A && (EnemyNear,StateType = C || EnemyNear,StateNo = [400,500])"
    air: "AILevel && NumEnemy && RoundState = 2 && StateType = A && (InGuardDist || EnemyNear,MoveType = A)"
  boss_rush_pressure:
    enter: "AILevel && NumEnemy && RoundState = 2 && Life < 500 && EnemyNear,MoveType != H"
    cashout: "AILevel && NumEnemy && RoundState = 2 && Power >= 1000 && (MoveHit || EnemyNear,Life < 220)"
  knockdown_reset:
    space: "AILevel && NumEnemy && RoundState = 2 && EnemyNear,StateType = L"
    charge: "AILevel && NumEnemy && RoundState = 2 && EnemyNear,StateType = L && P2BodyDist X > 90 && Power < 3000"
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
    utility_alias_ids: [power_charge, zero_counter]
    prefer_target_state_reliability_over_source_name: true
  generator_rules:
    close_confirm:
      use: hit_confirm_only
      require: [MoveHit, scanned_x_y_window, target_not_liedown, multi_hit_last_hit_guard]
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
    ex_anti_air:
      preferred: 1430
      scanned_class: close_confirm
      generic_role: ex_bridge_hit_confirm
    close_confirm_super:
      preferred: 2900
      scanned_class: close_confirm
      generic_role: level1_close_confirm_cashout
    close_confirm_super_alt:
      preferred: 2910
      scanned_class: close_confirm
      generic_role: level1_close_confirm_cashout
    close_super:
      preferred: 2000
      scanned_class: grab
      generic_role: point_blank_grab_punish_only
    projectile_super_start:
      preferred: 3000
      scanned_class: install
      generic_role: setup_safe_only
    projectile_super_fire:
      preferred: 3005
      scanned_class: projectile
      generic_role: spacing_or_punish_cashout
    rush_hyper:
      preferred: 3100
      scanned_class: grab
      generic_role: point_blank_grab_punish_only
    zero_counter:
      preferred: 750
      scanned_class: install
      generic_role: defense_or_setup_review
  confirmed_generic_cashout_aliases: [close_confirm_super, close_confirm_super_alt, projectile_super_fire]
  confirmed_grab_cashout_aliases: [close_super, rush_hyper]
  safe_setup_aliases: [power_charge, zero_counter, projectile_super_start]
  blocked_meter_aliases: [d_crazy_raw, d_magnum_raw, helper_raw_unsafe]
  source_scan_evidence:
    confirmed_generic_cashout_states: [2900,2910,3005]
    confirmed_grab_cashout_states: [2000,2050,3100,3101,4000,4011]
    safe_setup_states: [750,770,3000,3050,6060,6061]
    blocked_meter_states:
      - { state: 3115, label: d_crazy_raw, use: do_not_raw }
      - { state: 4002, label: d_magnum_raw, use: do_not_raw }
      - { state: 4015, label: d_magnum_followup_raw, use: do_not_raw }
      - { state: 4020, label: d_magnum_followup_raw_2, use: do_not_raw }
      - { state: 8330, label: helper_raw_unsafe, use: do_not_raw }
```

## Files

```yaml
files:
  cmd:
    detect: character_def.cmd
    purpose: State -1 AI commands and router
  system:
    detect: cns_or_st_with_guard_and_var_logic
    preferred_names:
      - Coding/System.cns
      - System.cns
      - common.cns
    purpose: -2/-3 variable logic, guard state logic, parry state definitions
  specials:
    detect: cns_or_st_with_specials_and_supers
    preferred_names:
      - Coding/Specials.cns
      - Specials.cns
    purpose: special/super state behavior
```

## Module: variable_comments

### Goal

Them comment mapping vao file system neu nhan vat co block variable list. Neu khong co anchor an toan, chi ghi vao report.

### Template

```mugen-template
; AI_PATCH_VAR ai_enabled = ${var.ai_enabled}
; AI_PATCH_VAR ai_scalar = ${var.ai_scalar}
; AI_PATCH_VAR boss_rush = ${var.boss_rush}
; AI_PATCH_VAR threat_class = ${var.threat_class}
; AI_PATCH_VAR route_selector = ${var.route_selector}
; AI_PATCH_VAR defensive_cd = ${var.defensive_cd}
; AI_PATCH_VAR parry_memory = ${var.parry_memory}
; AI_PATCH_VAR post_zero_timer = ${var.post_zero_timer}
```

## Module: system_threat_classifier

### Target

```yaml
file: system
insert_after:
  - "[State -3, AI Chance Multiplier]"
  - "fvar(${fvar.chance_mult:number})"
fallback_insert_before:
  - "[State -3, AI Defensive Cooldown"
risk: medium
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: boxer_bl:system_threat_classifier:v1
[State -3, AI Boxer AILevel Bridge]
type = VarSet
trigger1 = AILevel > 0
var(${var.ai_enabled:number}) = AILevel
ignoreHitPause = 1

[State -3, AI Boxer AILevel Bridge Off]
type = VarSet
trigger1 = AILevel <= 0
var(${var.ai_enabled:number}) = 0
ignoreHitPause = 1

[State -3, AI Boxer Chance Scalar]
type = VarSet
trigger1 = ${var.ai_enabled}
var(${var.ai_scalar:number}) = ${var.ai_enabled}
ignoreHitPause = 1

[State -3, AI Boxer Chance Multiplier]
type = VarSet
trigger1 = ${var.ai_enabled}
fvar(${fvar.chance_mult:number}) = (${var.ai_enabled} ** 2 / 64.0)
ignoreHitPause = 1

[State -3, AI Threat Reset]
type = VarSet
trigger1 = !${var.ai_enabled} || NumEnemy = 0
trigger2 = ${var.ai_enabled} && !InGuardDist && EnemyNear, MoveType != A
trigger3 = ${var.ai_enabled} && !InGuardDist && P2BodyDist X > ${range.neutral_reset_x} && EnemyNear, StateType != A
${var.threat_class} = 0
ignoreHitPause = 1

[State -3, AI Early Low Threat Read]
type = VarSet
triggerAll = ${var.ai_enabled} && NumEnemy
triggerAll = RoundState = 2 && StateType != A
triggerAll = EnemyNear, MoveType = A
triggerAll = P2BodyDist X < ${range.low_threat_x}
trigger1 = EnemyNear, StateType = C
trigger2 = EnemyNear, StateNo = [400,500]
trigger3 = EnemyNear, HitDefAttr = C, NA, SA, HA
${var.threat_class} = 1
ignoreHitPause = 1

[State -3, AI Threat Mid High Air]
type = VarSet
triggerAll = ${var.ai_enabled} && NumEnemy
triggerAll = InGuardDist
trigger1 = EnemyNear, HitDefAttr = S, AA
trigger2 = EnemyNear, HitDefAttr = A, AA
trigger3 = EnemyNear, StateType = A
trigger3 = EnemyNear, MoveType = A
${var.threat_class} = 2
ignoreHitPause = 1

[State -3, AI Threat Throw]
type = VarSet
triggerAll = ${var.ai_enabled} && NumEnemy
trigger1 = P2BodyDist X < ${range.throw_threat_x} && EnemyNear, HitDefAttr = SCA, AT
trigger2 = P2BodyDist X < ${range.close_threat_x} && EnemyNear, MoveType = A && !InGuardDist
${var.threat_class} = 3
ignoreHitPause = 1
; AI_PATCH_END: boxer_bl:system_threat_classifier:v1
```

## Module: cmd_runtime_bridge_early

### Goal

Set the Boxer AI runtime variables inside State -1 before any command decision
block reads them. Some engines/characters evaluate State -1 before State -3 in
the same tick, so relying only on the system bridge can make injected combo and
meter routes react one tick late or not fire during early match startup.

### Target

```yaml
file: cmd
insert_after:
  - "[Statedef -1]"
fallback_insert_before:
  - "[State -1"
risk: low
remove_blocks:
  - file: cmd
    scope: State -1
    match_any:
      - "AI_PATCH_BEGIN: boxer_bl:cmd_runtime_bridge:v1"
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: boxer_bl:cmd_runtime_bridge_early:v1
[State -1, AI Boxer CMD AILevel Bridge]
type = VarSet
trigger1 = AILevel > 0
var(${var.ai_enabled:number}) = AILevel
ignoreHitPause = 1

[State -1, AI Boxer CMD AILevel Bridge Off]
type = VarSet
trigger1 = AILevel <= 0
var(${var.ai_enabled:number}) = 0
ignoreHitPause = 1

[State -1, AI Boxer CMD Chance Scalar]
type = VarSet
trigger1 = ${var.ai_enabled}
var(${var.ai_scalar:number}) = ${var.ai_enabled}
ignoreHitPause = 1

[State -1, AI Boxer CMD Chance Multiplier]
type = VarSet
trigger1 = ${var.ai_enabled}
fvar(${fvar.chance_mult:number}) = (${var.ai_enabled} ** 2 / 64.0)
ignoreHitPause = 1
; AI_PATCH_END: boxer_bl:cmd_runtime_bridge_early:v1
```

## Module: hybrid_low_guard_parry

### Goal

Tang ty le crouch guard/parry truoc low starter cua nhan vat bat ky, khong chi Sagat.

### Remove Existing

```yaml
remove_blocks:
  - file: cmd
    scope: State -1
    match_any:
      - "AI Hybrid Early Low Crouching Parry"
      - "AI Ryu Port Low Crouching Parry"
    safe_only_with_marker: false
```

### Target

```yaml
file: cmd
insert_before:
  - "[State -1, AI d_ai Stand Guard]"
  - "[State -1, AI Projectile Stand Guard"
  - "; Priority defense"
risk: medium
route_preview:
  - id: boxer_low_defense_routes
    type: defensive_route
    source: heavy_d_low_guard_parry_and_sagat_low_starter_fix
    chain:
      - crouch_parry
      - crouch_guard
      - stand_parry
    condition:
      - low_attack_memory
      - crouching_enemy_attack
      - guard_distance_or_close_low_threat
      - defensive_cooldown_clear
    policy:
      - parry_before_rushdown
      - guard_when_low_parry_window_is_not_safe
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: boxer_bl:hybrid_low_guard_parry:v1
[State -1, AI Hybrid Early Low Crouching Parry]
type = HitOverride
triggerAll = ${var.ai_enabled} && NumEnemy
triggerAll = RoundState = 2 && StateType != A && MoveType != H
triggerAll = ${var.defensive_cd} <= 0 || StateNo = [${state.stand_parry},${state.crouch_parry}]
triggerAll = EnemyNear, MoveType = A
triggerAll = EnemyNear, StateType = C || EnemyNear, StateNo = [400,500] || ${var.threat_class} = 1
triggerAll = P2BodyDist X < ${range.low_threat_x}
trigger1 = ctrl && (InGuardDist || P2BodyDist X < ${range.low_parry_close_x})
trigger1 = Random < ceil((${range.low_threat_x} + ${var.boss_rush} * 34 + ${var.ai_scalar} * 7) * ${fvar.chance_mult})
trigger2 = StateNo = [${state.stand_parry},${state.crouch_parry}] && Random < 420
trigger1 = ${var.parry_memory} := 28
trigger2 = ${var.parry_memory} := 28
attr = C, NA, SA, HA
stateNo = ${state.crouch_parry}
slot = 4
time = 9

[State -1, AI Hybrid Early Low Crouch Guard]
type = ChangeState
value = ${state.crouch_guard}
triggerAll = ${var.ai_enabled} && NumEnemy
triggerAll = RoundState = 2 && StateType != A
triggerAll = (InGuardDist || (${var.threat_class} = 1 && EnemyNear, MoveType = A && P2BodyDist X < ${range.low_threat_x}))
triggerAll = ${var.defensive_cd} <= 0
triggerAll = ctrl || StateNo = [100,101]
triggerAll = ${var.threat_class} != 2
trigger1 = EnemyNear, StateType = C
trigger1 = P2BodyDist X < ${range.crouch_guard_x}
trigger1 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 162, 132) * ${fvar.chance_mult})
trigger2 = ${var.threat_class} = 1
trigger2 = P2BodyDist X < ${range.low_threat_x}
trigger2 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 166, 134) * ${fvar.chance_mult})
; AI_PATCH_END: boxer_bl:hybrid_low_guard_parry:v1
```

## Module: parry_core

### Goal

Ryu-style HitOverride parry: stand, crouch, air, reset. Neu nhan vat da co parry core khac, UI nen hoi: replace, keep, hoac skip.

### Target

```yaml
file: cmd
insert_after_module: hybrid_low_guard_parry
risk: medium
route_preview:
  - id: boxer_parry_core_routes
    type: defensive_route
    source: ryu_port_parry_mapped_to_heavy_d_760_761_762
    chain:
      - stand_parry
      - crouch_parry
      - air_parry
    condition:
      - enemy_attack_or_projectile
      - standing_crouching_or_air_state
      - parry_memory_window
      - defensive_cooldown_clear
    policy:
      - use_existing_parry_states_only
      - reset_hittoverride_when_control_or_state_type_changes
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: boxer_bl:parry_core:v1
[State -1, AI Ryu Port Standing Parry]
type = HitOverride
triggerAll = ${var.ai_enabled} && NumEnemy
triggerAll = RoundState = 2 && StateType != A && MoveType != H
triggerAll = EnemyNear, MoveType = A || (Enemy, NumProj > 0 && InGuardDist)
triggerAll = ${var.defensive_cd} <= 0 || StateNo = [${state.stand_parry},${state.crouch_parry}]
triggerAll = !(EnemyNear, StateNo = [400,500])
triggerAll = !(EnemyNear, StateType = C && EnemyNear, MoveType = A)
trigger1 = (ctrl && Random < ceil((55 + ${var.boss_rush} * 20 + ${var.ai_scalar} * 4) * ${fvar.chance_mult})) || (StateNo = [${state.stand_parry},${state.crouch_parry}] && Random < 260)
trigger1 = ${var.parry_memory} := 18
attr = SA, AA, AP
stateNo = ${state.stand_parry}
slot = 0
time = 8

[State -1, AI Ryu Port Crouching Parry]
type = HitOverride
triggerAll = ${var.ai_enabled} && NumEnemy
triggerAll = RoundState = 2 && StateType != A && MoveType != H
triggerAll = EnemyNear, MoveType = A || (Enemy, NumProj > 0 && InGuardDist)
triggerAll = ${var.defensive_cd} <= 0 || StateNo = [${state.stand_parry},${state.crouch_parry}]
trigger1 = (ctrl && Random < ceil((55 + ${var.boss_rush} * 18 + ${var.ai_scalar} * 4) * ${fvar.chance_mult})) || (StateNo = [${state.stand_parry},${state.crouch_parry}] && Random < 260)
trigger1 = ${var.parry_memory} := 28
attr = C, NA, SA, HA
stateNo = ${state.crouch_parry}
slot = 0
time = 9

[State -1, AI Ryu Port Air Parry]
type = HitOverride
triggerAll = ${var.ai_enabled} && NumEnemy
triggerAll = RoundState = 2 && StateType = A && MoveType != H
triggerAll = Ctrl || StateNo = ${state.air_parry}
triggerAll = StateNo != [5000,5999]
triggerAll = EnemyNear, MoveType = A || (Enemy, NumProj > 0 && InGuardDist)
triggerAll = ${var.defensive_cd} <= 0 || StateNo = ${state.air_parry} || ${var.anti_launcher_air_timer} > 0
trigger1 = (ctrl && Random < ceil((55 + ${var.boss_rush} * 18 + ${var.ai_scalar} * 4) * ${fvar.chance_mult})) || (StateNo = ${state.air_parry} && Random < 260)
trigger1 = ${var.parry_memory} := 38
attr = SA, AA, AP
stateNo = ${state.air_parry}
forceAir = 1
slot = 0
time = 7

[State -1, AI Ryu Port Reset Parry]
type = HitOverride
trigger1 = (!ctrl && StateNo != [${state.stand_parry},${state.air_parry}] && StateNo != 5120) || var(20)
trigger2 = MoveType != I || StateNo = [100,106] || StateNo = [120,132]
trigger3 = !${var.ai_enabled} && (command = "${command.hold_back}" || command = "${command.hold_up}")
trigger4 = (StateType = S || StateType = C) && ${var.parry_memory} >= 30
trigger5 = StateType = A && ${var.parry_memory} > 0 && ${var.parry_memory} < 30
slot = 0
time = 0
; AI_PATCH_END: boxer_bl:parry_core:v1
```

## Module: post_zero_router

### Goal

Sau zero counter, khong mac dinh spam medium low neu P2 bi day xa. Gan thi danh, tam vua chase, xa thi roll/reset.

### Target

```yaml
file: cmd
insert_before:
  - "[State -1, AI Close Range"
  - "[State -1, AI d_ai Stand Guard]"
risk: low
route_preview:
  - id: boxer_post_zero_routes
    type: post_zero_route
    source: heavy_d_zero_counter_followup_distance_fix
    chain:
      - medium_low
      - rush_special
      - roll_forward
    condition:
      - post_zero_timer_active
      - p2_not_liedown_or_airborne
      - no_enemy_projectile
      - distance_selects_near_mid_or_far
    policy:
      - do_not_force_medium_low_when_projectile_zero_counter_pushes_p2_far
      - chase_or_reset_spacing_when_blue_box_is_not_in_range
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: boxer_bl:post_zero_router:v1
[State -1, AI Post-Zero Safe Medium Low]
type = ChangeState
value = ${state.medium_low}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A
triggerAll = ${var.post_zero_timer} > 0 && ctrl
triggerAll = EnemyNear, StateType != A && EnemyNear, StateType != L && EnemyNear, MoveType != H
triggerAll = Enemy, NumProj = 0
triggerAll = P2BodyDist X = [${range.post_zero_near_min_x},${range.post_zero_near_max_x}] && P2BodyDist Y >= ${range.post_zero_near_min_y}
triggerAll = EnemyNear, Time >= 8 || EnemyNear, Ctrl
trigger1 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 128, 96) * ${fvar.chance_mult})

[State -1, AI Post-Zero Rush Chase]
type = ChangeState
value = ${state.rush_special}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A
triggerAll = Power >= ${state.rush_special:cost}
triggerAll = ${var.post_zero_timer} > 0 && (ctrl || StateNo = [100,101]) && ${var.offensive_cd} <= 0
triggerAll = EnemyNear, StateType != A && EnemyNear, StateType != L && EnemyNear, MoveType != H
triggerAll = Enemy, NumProj = 0
triggerAll = P2BodyDist X = [${range.post_zero_mid_min_x},${range.post_zero_mid_max_x}] && P2BodyDist Y >= ${range.post_zero_mid_min_y}
trigger1 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 118, 88) * ${fvar.chance_mult})

[State -1, AI Post-Zero Roll Chase]
type = ChangeState
value = ${state.roll_forward}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A
triggerAll = ${var.post_zero_timer} > 0 && (ctrl || StateNo = [100,101]) && ${var.defensive_cd} <= 0
triggerAll = EnemyNear, StateType != L
triggerAll = P2BodyDist X > ${range.post_zero_far_x} && P2BodyDist Y >= ${range.post_zero_far_min_y} && FrontEdgeBodyDist > 45
trigger1 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 88, 62) * ${fvar.chance_mult})
; AI_PATCH_END: boxer_bl:post_zero_router:v1
```

## Module: knockdown_reset_charge

### Goal

Khi P2 nam dat, AI khong meaty lung tung; lui khoang cach an toan roi charge.

### Target

```yaml
file: cmd
insert_before:
  - "[State -1, AI Boss Rush"
  - "[State -1, AI Power Charge]"
risk: low
route_preview:
  - id: boxer_knockdown_reset_routes
    type: reset_route
    source: heavy_d_knockdown_spacing_and_charge_rule
    chain:
      - roll_back
      - power_charge
    condition:
      - enemy_liedown_or_wakeup
      - safe_charge_distance
      - no_projectile_or_guard_distance
      - not_in_max_mode
    policy:
      - back_off_before_charging
      - avoid_ex_spend_on_liedown_target
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: boxer_bl:knockdown_reset_charge:v1
[State -1, AI Knockdown Roll Back]
type = ChangeState
value = ${state.roll_back}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A
triggerAll = (ctrl || StateNo = [100,101]) && ${var.defensive_cd} <= 0
triggerAll = EnemyNear, StateType = L
triggerAll = P2BodyDist X < ${range.knockdown_roll_back_x} && BackEdgeBodyDist > 50
trigger1 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 125, 96) * ${fvar.chance_mult})

[State -1, AI Knockdown Safe Charge]
type = ChangeState
value = ${state.power_charge}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A
triggerAll = (ctrl || StateNo = [100,101]) && Power < Const(data.power) && Power < PowerMax && !var(20)
triggerAll = EnemyNear, StateType = L
triggerAll = P2BodyDist X = [${range.charge_safe_min_x},${range.charge_safe_max_x}] && !InGuardDist
triggerAll = Enemy, NumProj = 0
trigger1 = Power < 3000 && Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 128, 105) * ${fvar.chance_mult})
; AI_PATCH_END: boxer_bl:knockdown_reset_charge:v1
```

## Module: combo_meter_priority_bridge

### Goal

Give special, EX, and meter cashout routes priority before generic normal chains
consume the turn. This mirrors the RockAI fix for characters whose scan finds
meter states and power costs, but whose cancel graph does not expose enough safe
numeric edges for the normal combo router to naturally climb into special/super.

The bridge uses direct `ChangeState` only from neutral, punish, hit-confirm, or
`MoveContact` windows. It must not add armor, defense, damage, or healing.

### Target

```yaml
file: cmd
insert_before:
  - "[State -1, AI Power Charge]"
  - "[State -1, Crouching Light Punch]"
  - "[State -1"
risk: medium
scan_requirements:
  - comboScan.states
  - comboScan.routeCandidates
  - states.powerCosts
  - airReach
safe_when:
  - target_state_exists
  - meter_cost_known_or_alias_verified
  - hit_confirm_contact_or_low_life
  - range_matches_super_reach
review_when:
  - target_state_missing
  - meter_cost_unknown
  - current_state_cancel_unknown
route_preview:
  - id: boxer_priority_meter_bridge
    type: meter_bridge
    source: heavy_d_priority_super_ex_and_special_bridge
    chain:
      - close_confirm_super
      - close_confirm_super_alt
      - projectile_super_fire
      - rush_special
      - ex_anti_air
      - close_super
      - rush_hyper
    condition:
      - power_gate
      - hit_confirm_or_movecontact
      - grounded_enemy
      - scanner_resolved_range
    policy:
      - meter_routes_before_generic_normals
      - close_confirm_supers_only_after_hit_confirm
      - projectile_super_fire_only_when_x_y_window_is_safe
      - close_super_and_rush_hyper_grabs_only_when_point_blank_punish
      - skip_liedown_or_unjuggle_targets
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: boxer_bl:combo_meter_priority_bridge:v1
[State -1, AI_PATCH_METER_POLICY Close Confirm Super Cashout]
type = ChangeState
value = ${state.close_confirm_super}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A
triggerAll = Power >= ${state.close_confirm_super:cost}
triggerAll = EnemyNear, StateType != A && EnemyNear, StateType != L
triggerAll = P2BodyDist X < ${range.close_super_x} && P2BodyDist Y >= ${range.grounded_min_y}
triggerAll = Ctrl || MoveHit || MoveContact || StateNo = [200,699]
trigger1 = MoveHit || MoveContact || var(6)
trigger1 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 170, 132) * ${fvar.chance_mult})
trigger2 = EnemyNear, Life < 350 && EnemyNear, MoveType != A
trigger2 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 110, 82) * ${fvar.chance_mult})
trigger3 = StateNo = [200,699] && MoveContact
trigger3 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 96, 68) * ${fvar.chance_mult})

[State -1, AI_PATCH_METER_POLICY Alternate Close Confirm Cashout]
type = ChangeState
value = ${state.close_confirm_super_alt}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A
triggerAll = Power >= ${state.close_confirm_super_alt:cost}
triggerAll = EnemyNear, StateType != A && EnemyNear, StateType != L
triggerAll = P2BodyDist X = [0,${range.projectile_super_max_x}]
triggerAll = Abs(P2BodyDist Y) <= ${range.cashout_abs_y}
triggerAll = Ctrl || MoveHit || MoveContact || StateNo = [200,699] || StateNo = [1000,1999]
trigger1 = MoveHit || var(6)
trigger1 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 155, 118) * ${fvar.chance_mult})
trigger2 = EnemyNear, Life < 420 && EnemyNear, MoveType = H
trigger2 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 124, 92) * ${fvar.chance_mult})

[State -1, AI_PATCH_METER_POLICY Projectile Super Fire Cashout]
type = ChangeState
value = ${state.projectile_super_fire}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A
triggerAll = Power >= ${state.projectile_super_fire:cost}
triggerAll = EnemyNear, StateType != A && EnemyNear, StateType != L
triggerAll = !(Enemy, NumProj > 0 && InGuardDist)
triggerAll = P2BodyDist X = [${range.projectile_super_min_x},${range.projectile_super_max_x} + Floor(EnemyNear, Vel X * 6)]
triggerAll = Abs(P2BodyDist Y) <= ${range.cashout_abs_y}
triggerAll = Ctrl || MoveHit || MoveContact || StateNo = [200,699]
trigger1 = (StateNo = ${state.strong_launcher} || StateNo = ${state.ex_anti_air}) && MoveHit
trigger1 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 160, 124) * ${fvar.chance_mult})
trigger2 = EnemyNear, Life < 450 && EnemyNear, MoveType = H
trigger2 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 120, 88) * ${fvar.chance_mult})

[State -1, AI_PATCH_METER_POLICY Point Blank Grab Super Punish]
type = ChangeState
value = ${state.close_super}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A
triggerAll = Power >= ${state.close_super:cost}
triggerAll = EnemyNear, StateType != A && EnemyNear, StateType != L
triggerAll = P2BodyDist X < ${range.throw_threat_x} && P2BodyDist Y >= ${range.grounded_min_y}
triggerAll = Ctrl && !InGuardDist && Enemy, NumProj = 0
trigger1 = EnemyNear, MoveType != A && EnemyNear, Ctrl = 0
trigger1 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 62, 38) * ${fvar.chance_mult})
trigger2 = EnemyNear, MoveType = H && MoveHit
trigger2 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 76, 48) * ${fvar.chance_mult})

[State -1, AI Normal Contact To Rush Special]
type = ChangeState
value = ${state.rush_special}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A
triggerAll = Power >= ${state.rush_special:cost}
triggerAll = StateNo = [200,499] && MoveContact
triggerAll = EnemyNear, StateType != A && EnemyNear, StateType != L
triggerAll = P2BodyDist X = [${range.medium_to_special_min_x},${range.medium_to_special_max_x}]
trigger1 = MoveHit && Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 146, 108) * ${fvar.chance_mult})
trigger2 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 82, 54) * ${fvar.chance_mult})

[State -1, AI Launcher Contact To EX AntiAir]
type = ChangeState
value = ${state.ex_anti_air}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A
triggerAll = Power >= ${state.ex_anti_air:cost}
triggerAll = StateNo = ${state.strong_launcher} && MoveContact
triggerAll = EnemyNear, StateType != L
triggerAll = P2BodyDist X = [${range.ex_confirm_min_x},${range.ex_confirm_max_x}]
triggerAll = Abs(P2BodyDist Y) <= ${range.grounded_abs_y}
trigger1 = MoveHit && Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 136, 100) * ${fvar.chance_mult})
; AI_PATCH_END: boxer_bl:combo_meter_priority_bridge:v1
```

## Module: boxer_combo_router

### Goal

Create boxer-style ground-to-air routes: light -> medium -> strong/launcher
-> special/EX -> super/hyper. This module must use `comboScan` to confirm
which states are real starters, links, launchers, extenders, and cashout states
for the current character.

Preferred route model:

- `low starter` or light normal -> medium/strong normal.
- medium/strong normal -> `special` or `special launcher`.
- launcher -> anti-air special/EX anti-air only when enemy hitstun/juggle and AIR reach are valid.
- close confirmed hit -> close super.
- projectile/cashout super only when X/Y windows and opponent state are safe.

Do not mark a route as safe just because the state alias exists. The route should
be `safe` only when `comboScan.cancelEdges` or `comboScan.routeCandidates` confirms
the connection. Dynamic routes such as `value = var(...)` stay `needs_review`
unless the UI resolves the target from local code.

### Target

```yaml
file: cmd
insert_before:
  - "[State -1, AI Power Charge]"
  - "[State -1, Crouching Light Punch]"
risk: medium
scan_requirements:
  - comboScan.states
  - comboScan.cancelEdges
  - comboScan.routeCandidates
  - stateActionMap
  - airReach
safe_when:
  - source_has_hitdef
  - target_state_exists
  - movehit_or_movecontact_cancel
  - air_reach_matches_range
review_when:
  - dynamic_change_state_target
  - missing_air_reach
  - target_role_unknown
  - lying_opponent_mismatch
route_preview:
  - id: boxer_ground_combo_routes
    type: ground_route
    source: heavy_d_light_medium_strong_special_cashout_router
    chain:
      - light_low
      - medium_low
      - strong_launcher
      - close_pressure
      - rush_special
      - ducking_special
      - anti_air_special
      - ex_anti_air
      - close_confirm_super
      - close_confirm_super_alt
      - projectile_super_fire
      - close_super
    condition:
      - movehit_or_movecontact
      - hitstun_or_combo_intent
      - route_mode_bnb_ex_super_kill_reset_corner_antiair
      - air_reach_or_ground_reach_matches_target
    policy:
      - light_to_medium_to_launcher_before_spending_meter
      - launcher_to_anti_air_or_air_followup_only_when_juggle_valid
      - meter_cashout_uses_reliability_labels_not_source_state_names
      - route_aliases_are_resolved_per_character
      - prefer_combo_scan_evidence_before_fallback
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: boxer_bl:boxer_combo_router:v1
[State -1, AI Light Low To Medium Low]
type = ChangeState
value = ${state.medium_low}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A
triggerAll = StateNo = ${state.light_low} && MoveHit
triggerAll = EnemyNear, StateType != L && P2BodyDist X = [${range.light_to_medium_min_x},${range.light_to_medium_max_x}]
trigger1 = 1

[State -1, AI Medium Low To Rush Special]
type = ChangeState
value = ${state.rush_special}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A
triggerAll = Power >= ${state.rush_special:cost}
triggerAll = StateNo = ${state.medium_low} && MoveHit
triggerAll = EnemyNear, StateType != A && EnemyNear, StateType != L
triggerAll = P2BodyDist X = [${range.medium_to_special_min_x},${range.medium_to_special_max_x}]
trigger1 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 112, 88) * ${fvar.chance_mult})

[State -1, AI Strong Launcher To AntiAir Special]
type = ChangeState
value = ${state.anti_air_special}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A
triggerAll = Power >= ${state.anti_air_special:cost}
triggerAll = StateNo = ${state.strong_launcher} && MoveHit
triggerAll = !var(16)
triggerAll = EnemyNear, StateType = A || EnemyNear, MoveType = H
triggerAll = P2BodyDist X = [${range.launcher_min_x},${range.launcher_max_x}]
trigger1 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 118, 92) * ${fvar.chance_mult})

[State -1, AI EX AntiAir Cashout]
type = ChangeState
value = ${state.ex_anti_air}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A
triggerAll = Power >= ${state.ex_anti_air:cost}
triggerAll = StateNo = ${state.strong_launcher} && MoveHit
triggerAll = EnemyNear, StateType != L
triggerAll = P2BodyDist X = [${range.ex_confirm_min_x},${range.ex_confirm_max_x}]
triggerAll = Abs(P2BodyDist Y) <= ${range.grounded_abs_y}
trigger1 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 106, 82) * ${fvar.chance_mult})
; AI_PATCH_END: boxer_bl:boxer_combo_router:v1
```

## Module: meter_cashout_safe

### Goal

Dung projectile super/charged super chi khi de trung: P2 dang hitstun/airborne/fall-carry, trong vung `${range.projectile_super_min_x}-${range.projectile_super_max_x}` da duoc derive theo tung nhan vat. Neu P2 qua gan thi uu tien close super.

### Target

```yaml
file: cmd
insert_before:
  - "[State -1, AI D.Magnum"
  - "[State -1, AI MAX"
  - "[State -1, AI Power Charge]"
risk: medium
route_preview:
  - id: boxer_safe_meter_cashout_routes
    type: super_cashout
    source: heavy_d_meter_reliability_cashout_policy
    chain:
      - close_confirm_super
      - close_confirm_super_alt
      - projectile_super_fire
      - close_super
      - rush_hyper
    condition:
      - power_gate
      - hit_confirm_or_low_life
      - p2_near_floor_for_close_super
      - projectile_super_x_y_window
      - enemy_not_liedown
    policy:
      - call_close_confirm_super_if_p2_is_within_close_floor_window
      - release_projectile_super_fire_only_when_distance_is_safe
      - use_close_super_or_rush_hyper_only_as_point_blank_punish
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: boxer_bl:meter_cashout_safe:v1
[State -1, AI_PATCH_METER_POLICY Close Range Confirmed Super Override]
type = ChangeState
value = ${state.close_confirm_super}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A
triggerAll = Power >= ${state.close_confirm_super:cost}
triggerAll = EnemyNear, StateType != A && EnemyNear, StateType != L
triggerAll = P2BodyDist X < ${range.close_super_x} && P2BodyDist Y >= ${range.grounded_min_y}
trigger1 = var(6) && MoveHit
trigger1 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 150, 120) * ${fvar.chance_mult})
trigger2 = (ctrl || StateNo = [100,101]) && EnemyNear, MoveType != A
trigger2 = Enemy, NumProj = 0 && Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 74, 48) * ${fvar.chance_mult})

[State -1, AI_PATCH_METER_POLICY Projectile Super Fire Hit Cashout]
type = ChangeState
value = ${state.projectile_super_fire}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A
triggerAll = Power >= ${state.projectile_super_fire:cost}
triggerAll = var(6) && !var(16)
triggerAll = EnemyNear, StateType != A && EnemyNear, StateType != L && EnemyNear, MoveType = H
triggerAll = !(Enemy, NumProj > 0 && InGuardDist)
triggerAll = P2BodyDist X = [${range.projectile_super_min_x},${range.projectile_super_max_x} + Floor(EnemyNear, Vel X * 6)]
triggerAll = Abs(P2BodyDist Y) <= ${range.cashout_abs_y}
trigger1 = (StateNo = ${state.strong_launcher} || StateNo = ${state.ex_anti_air}) && MoveHit
trigger1 = EnemyNear, Life < 850 || ${var.boss_rush} || var(13) >= 3
trigger1 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 150, 118) * ${fvar.chance_mult})

[State -1, AI_PATCH_METER_POLICY Close Grab Punish Only]
type = ChangeState
value = ${state.close_super}
triggerAll = ${var.ai_enabled} && RoundState = 2 && StateType != A
triggerAll = Power >= ${state.close_super:cost}
triggerAll = Ctrl && !InGuardDist && Enemy, NumProj = 0
triggerAll = EnemyNear, StateType != A && EnemyNear, StateType != L
triggerAll = P2BodyDist X < ${range.throw_threat_x} && P2BodyDist Y >= ${range.grounded_min_y}
trigger1 = EnemyNear, MoveType != A && EnemyNear, Ctrl = 0
trigger1 = Random < ceil(${var.ai_scalar} * ifElse(${var.boss_rush}, 58, 36) * ${fvar.chance_mult})
; AI_PATCH_END: boxer_bl:meter_cashout_safe:v1
```

## Module: boss_rush_mode

### Goal

Khi HP thap hon 499, AI chuyen sang KOF boss rushdown: tan cong don dap nhung van uu tien parry/guard low.

### Target

```yaml
file: system
insert_before:
  - "[State -3, AI Threat Reset]"
  - "[State -3, AI Chance Multiplier]"
risk: low
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: boxer_bl:boss_rush_mode:v1
[State -3, AI Boss Rush Flag]
type = VarSet
trigger1 = ${var.ai_enabled} && RoundState = 2 && Life <= 499
${var.boss_rush} = 1
ignoreHitPause = 1

[State -3, AI Boss Rush Flag Off]
type = VarSet
trigger1 = !${var.ai_enabled} || RoundState != 2 || Life > 499
${var.boss_rush} = 0
ignoreHitPause = 1
; AI_PATCH_END: boxer_bl:boss_rush_mode:v1
```

## Module: air_action_review

### Goal

Danh dau cac state/action can review khi AI route goi state co nguy co miss vi AIR hitbox/action id khong khop. Module nay mac dinh `review_only`, khong sua `.air` neu UI chua co mapping thu cong.

### Target

```yaml
file: air
mode: review_only
risk: high
requires_manual:
  - state_to_action_map
  - frame_window
  - clsn_delta
  - before_after_preview
```

### AIR Review Candidates

```yaml
air_review:
  - id: close_pressure_action
    state: ${state.close_pressure}
    purpose: close pressure should not whiff at point blank or small pushback
    checks:
      - action_id_used_by_state
      - clsn1_forward_reach
      - first_active_frame
      - recovery_pushbox_overlap

  - id: ducking_special_action
    state: ${state.ducking_special}
    purpose: combo extender after medium confirm
    checks:
      - hitbox_covers_grounded_target
      - travel_distance_matches_confirm_range
      - does_not_hit_down_lied_enemy_unless_intended

  - id: anti_air_special_action
    state: ${state.anti_air_special}
    purpose: launcher and air follow-up connector
    checks:
      - vertical_clsn1_reach
      - p2_y_window
      - action_not_missing_airborne_hitstun

  - id: ex_anti_air_action
    state: ${state.ex_anti_air}
    purpose: meter route should skip if p2 is grounded liedown
    checks:
      - meter_cost_confirm
      - grounded_liedown_skip
      - air_hitstun_connection
```

## Module Dependencies

```yaml
dependencies:
  cmd_runtime_bridge_early:
    requires:
      - system_threat_classifier

  hybrid_low_guard_parry:
    requires:
      - cmd_runtime_bridge_early
      - system_threat_classifier

  parry_core:
    requires:
      - cmd_runtime_bridge_early
      - system_threat_classifier

  post_zero_router:
    requires:
      - post_zero_timer

  combo_meter_priority_bridge:
    requires:
      - cmd_runtime_bridge_early
      - system_threat_classifier

  meter_cashout_safe:
    requires:
      - combo_meter_priority_bridge
      - boxer_combo_router

  air_action_review:
    requires:
      - boxer_combo_router
```

## Scanner Notes

If the scanner cannot find a state alias:

- `stand_parry/crouch_parry/air_parry`: resolve only to real StateDefs. Common mappings are `6080/6081/6082`, `1300/1310/1320`, then `760/761/762`; never inject a missing parry state. Abort or skip the parry module if none exists.
- `air_parry`: do not trigger while `MoveType = H` or in common get-hit states `5000-5999`; require `Ctrl` unless already inside the air parry state.
- `roll_forward/roll_back`: if roll is unavailable, use back dash or walk back when an equivalent state exists.
- `power_charge`: if charge is unavailable, skip `knockdown_safe_charge` but keep reset spacing.
- `zero_counter`: if unavailable, skip `post_zero_router`.
- `close_confirm_super/close_confirm_super_alt`: generic hit-confirm cashout aliases. Do not map them to grab, install, self_buff, or unsafe_raw meter states.
- `projectile_super_fire`: projectile cashout alias. `projectile_super_start` is setup/install and must not be used as a direct combo cashout unless the target scanner classifies it as a reliable attack state.
- `close_super/rush_hyper`: Heavy D source scan marks these as grab-style; use only for point-blank grounded punish unless the target scanner gives a stronger close_confirm classification.
- `.air`: if the scanner has no `stateActionMap`, create a review report only; do not auto-edit Clsn/hitboxes.
- `comboScan`: if no safe `MoveHit`/`MoveContact` edge exists, keep the route in `needs_review` or apply a smaller Safe Lite patch.
- AIR patches may be applied only when the UI has state/action mapping and a clear per-action Clsn diff.

## Report Fields

Sau khi apply, patcher nen ghi:

```json
{
  "brain": "boxer_bl",
  "version": 2,
  "modulesApplied": [],
  "logicalVarMap": {},
  "stateMap": {},
  "filesChanged": [],
  "conflicts": [],
  "skippedModules": [],
  "quickTest": {}
}
```
