---
brain_id: rockai_bl
name: DivineRockAI Balanced Logic Brain
version: 2
target_engine: ikemen-go
source_reference: chars/DivineRockAI/RockAI
description: >
  Template brain extracted from DivineRockAI. Its core is helper-style AI:
  measuring distance, velocity, enemy state, guard/parry memory, projectile pressure,
  and then selecting temporary routes before the executor performs ChangeState.
  It suits striker characters with roll/dodge, projectiles, anti-air, EX routes,
  super routes, and air follow-up. It is combo-scan-aware: HitDef, cancel edges,
  AIR reach, and power costs decide which dynamic routes are safe, review-only,
  or small enough for Safe Lite.
ai_style: >
  DivineRockAI-style measured rushdown. It separates sensing from decision making:
  reads X/Y distance, velocity, wake-up, juggle state, projectile pressure, and guard
  memory before choosing a temporary route for the executor. Scanner-confirmed
  routes should override fragile hardcoded assumptions.
ai_strengths: >
  High adaptability, guard memory against repeated starters, separate ground and air
  routes, anti-projectile approach, roll/back reset, and meter cashout based on
  hit-confirm and opponent life. comboScan lets the UI validate route roles, numeric
  MoveHit/MoveContact edges, AIR reach, parsed meter costs, meter reliability class,
  helper travel/owner evidence, and multi-hit timing before applying.
ai_weaknesses: >
  Requires many var/fvar slots, so conflicts are likely on characters with crowded
  variable maps. If the scanner cannot derive ranges from AIR and state-action maps,
  some routes should stay in preview/review before applying. Dynamic routes such as
  value = var(...) are not safe until the UI resolves the selected target state.
  DivineRockAI source has meter states that scan as install/self_buff/grab, so resolver
  must not promote a state to generic cashout by source alias alone.
combo_routes: >
  Ground selector -> light/medium/low poke -> rush/projectile/throw; anti-air window
  -> launcher_low or anti_air_special; air selector -> air_light/air_medium/air_strong;
  meter cashout should prefer scanner-confirmed close_confirm supers, especially
  close_confirm_super/rush_super/rush_super_max. Source scan marks close_super and
  close_super_max as install/setup, level3_super as grab-style point-blank punish,
  and 8330 as unsafe_raw. Numeric comboScan route candidates are preferred; dynamic
  selector routes remain needs_review unless target role, AIR reach, reliability
  class, power cost, and opponent state are confirmed.
---

# Brain RockAI BL

Brain nay duoc viet de IKemen AI Patcher doc va tao patch plan. Tat ca bien deu la logical variable, khong hardcode `var(n)` trong template. Patcher phai resolve `${var.*}`, `${fvar.*}`, `${state.*}`, `${range.*}` truoc khi apply.

DivineRockAI dung hai lop tu duy:

- Lop cam bien: helper/State -1 lien tuc do `P2BodyDist X/Y`, enemy velocity, enemy hitstun, wake-up, projectile va cac state da tung bi guard/parry.
- Lop quyet dinh: gan route vao bien tam, sau do router moi doi state. Ground route va air route tach rieng de tranh goi sai state khi dang nhay.

## Conflict Policy

UI phai hien 4 muc xu ly conflict:

- `auto_remap`: neu preferred var/state bi dung, tim slot trong khac.
- `reuse_compatible`: chi dung lai khi scanner thay bien/state co cung muc dich.
- `manual_choose`: nguoi dung tu chon mapping/state tuong duong.
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

  - id: rock_route
    kind: var
    preferred: 18
    purpose: Ground decision route selected this tick
    conflict: auto_remap

  - id: rock_air_route
    kind: var
    preferred: 19
    purpose: Air decision route selected this tick
    conflict: auto_remap

  - id: rock_action_lock
    kind: var
    preferred: 20
    purpose: One-tick action lock after choosing route
    conflict: auto_remap

  - id: rock_enemy_grounded
    kind: var
    preferred: 14
    purpose: Enemy is standing or crouching
    conflict: auto_remap

  - id: rock_hit_confirm_time
    kind: var
    preferred: 13
    purpose: Enemy hittime/ctrltime available for cancel routing
    conflict: auto_remap

  - id: rock_enemy_juggle_ok
    kind: var
    preferred: 5
    purpose: Enemy can still be juggled after launcher or fall hit
    conflict: auto_remap

  - id: rock_enemy_wakeup
    kind: var
    preferred: 6
    purpose: Enemy wake-up or lie-down state
    conflict: auto_remap

  - id: rock_enemy_unjuggle
    kind: var
    preferred: 3
    purpose: Enemy cannot be juggled safely
    conflict: auto_remap

  - id: rock_guard_memory
    kind: var
    preferred: 49
    purpose: Guard/parry memory timer for repeated enemy starters
    conflict: auto_remap

  - id: rock_projectile_flag
    kind: var
    preferred: 44
    purpose: Enemy projectile or projectile-helper pressure flag
    conflict: auto_remap

  - id: rock_jump_intent
    kind: var
    preferred: 30
    purpose: Jump or super-jump intent selected by anti-projectile/approach logic
    conflict: auto_remap

  - id: rock_grab_cd
    kind: var
    preferred: 46
    purpose: Throw cooldown to avoid repeated impossible throws
    conflict: auto_remap

  - id: rock_guard_state_1
    kind: var
    preferred: 50
    purpose: Recently guarded enemy state slot 1
    conflict: auto_remap

  - id: rock_guard_state_2
    kind: var
    preferred: 51
    purpose: Recently guarded enemy state slot 2
    conflict: auto_remap

  - id: rock_guard_state_3
    kind: var
    preferred: 52
    purpose: Recently guarded enemy state slot 3
    conflict: auto_remap

fvariables:
  - id: rock_enemy_x
    kind: fvar
    preferred: 1
    purpose: Scaled P2BodyDist X
    conflict: auto_remap

  - id: rock_enemy_y
    kind: fvar
    preferred: 2
    purpose: P2BodyDist Y
    conflict: auto_remap

  - id: rock_enemy_vel_x
    kind: fvar
    preferred: 3
    purpose: Enemy real X movement delta
    conflict: auto_remap

  - id: rock_air_angle
    kind: fvar
    preferred: 4
    purpose: Air approach angle score
    conflict: auto_remap

  - id: rock_ai_chance
    kind: fvar
    preferred: 6
    purpose: Random chance scalar from AI level
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

  - id: parry_stand
    preferred: 760
    purpose: standing parry or equivalent
    conflict: reuse_compatible

  - id: parry_crouch
    preferred: 761
    purpose: crouching parry or equivalent
    conflict: reuse_compatible

  - id: parry_air
    preferred: 762
    purpose: air parry or equivalent
    conflict: reuse_compatible

  - id: roll_forward
    preferred: 710
    purpose: forward roll / dodge-through
    conflict: reuse_compatible

  - id: roll_back
    preferred: 715
    purpose: back roll / spacing reset
    conflict: reuse_compatible

  - id: power_charge
    preferred: 730
    purpose: power charge
    conflict: reuse_compatible

  - id: max_mode
    preferred: 770
    purpose: MAX mode activation
    conflict: reuse_compatible

  - id: zero_counter
    preferred: 750
    purpose: guard counter / alpha counter
    conflict: reuse_compatible

  - id: run_forward
    preferred: 100
    purpose: run forward
    conflict: reuse_compatible

  - id: walk_forward
    preferred: 20
    purpose: walk forward
    conflict: reuse_compatible

  - id: walk_back
    preferred: 21
    purpose: walk back
    conflict: reuse_compatible

  - id: light_stand
    preferred: 200
    purpose: fast standing light confirm
    conflict: manual_choose

  - id: medium_stand
    preferred: 210
    purpose: standing medium confirm
    conflict: manual_choose

  - id: strong_stand
    preferred: 220
    purpose: standing strong / heavy punish
    conflict: manual_choose

  - id: light_low
    preferred: 400
    purpose: crouching light starter
    conflict: manual_choose

  - id: medium_low
    preferred: 410
    purpose: crouching medium bridge
    conflict: manual_choose

  - id: launcher_low
    preferred: 420
    purpose: crouching strong / launcher / anti-air normal
    conflict: manual_choose

  - id: poke_low
    preferred: 430
    purpose: crouching kick low poke
    conflict: manual_choose

  - id: long_low
    preferred: 440
    purpose: long crouching kick / hitstun bridge
    conflict: manual_choose

  - id: air_light
    preferred: 600
    purpose: air light
    conflict: manual_choose

  - id: air_medium
    preferred: 610
    purpose: air medium
    conflict: manual_choose

  - id: air_strong
    preferred: 620
    purpose: air strong
    conflict: manual_choose

  - id: throw_close
    preferred: 800
    purpose: close throw / command throw
    conflict: manual_choose

  - id: projectile_light
    preferred: 1000
    purpose: projectile or safe long-range special
    conflict: manual_choose

  - id: ex_projectile
    preferred: 1030
    purpose: EX projectile / faster projectile
    conflict: manual_choose

  - id: rush_special
    preferred: 1100
    purpose: advancing special / carry special
    conflict: manual_choose

  - id: anti_air_special
    preferred: 1400
    purpose: rising anti-air special
    conflict: manual_choose

  - id: ex_anti_air
    preferred: 1430
    purpose: EX anti-air / high reward anti-air
    conflict: manual_choose

  - id: close_grab_special
    preferred: 1500
    purpose: close command grab / pressure break
    conflict: manual_choose

  - id: ex_grab_special
    preferred: 1530
    purpose: EX command grab / fast close punish
    conflict: manual_choose

  - id: close_confirm_super
    preferred: 3005
    purpose: scanner-confirmed close level-1 hit-confirm super
    conflict: manual_choose

  - id: close_super
    preferred: 3000
    purpose: install/setup super start; safe setup only unless target scanner marks it attack reliable
    conflict: manual_choose

  - id: close_super_max
    preferred: 3050
    purpose: level-2 install/setup super start; safe setup only unless target scanner marks it attack reliable
    conflict: manual_choose

  - id: rush_super
    preferred: 3100
    purpose: scanner-confirmed rush/strike hit-confirm super
    conflict: manual_choose

  - id: rush_super_max
    preferred: 3150
    purpose: scanner-confirmed stronger rush/strike hit-confirm super
    conflict: manual_choose

  - id: level3_super
    preferred: 3200
    purpose: level-3 grab-style close finisher; point-blank punish only unless target scanner marks it close_confirm
    conflict: manual_choose
```

## Command Aliases

Commands are treated as compatibility gates. RockAI BL currently avoids command-name dependent routing, but this section lets the patcher validate any future command references before Preview Diff and Apply Patch write code that Ikemen cannot parse.

```yaml
commands:
  - id: hold_back
    preferred: holdback
    purpose: built-in backward hold command for guard reset or optional manual override logic
    conflict: reuse_compatible

  - id: hold_up
    preferred: holdup
    purpose: built-in upward hold command for optional jump or air-reset logic
    conflict: reuse_compatible
```

## Ranges

Range la logical value. Patcher nen derive theo `RangeProfile` cua tung nhan vat tu `.air` va state/action map. `preferred` duoc lay theo DivineRockAI lam fallback, khong phai gia tri bat buoc.

```yaml
ranges:
  - id: point_blank_x
    preferred: 18
    derive: throw_or_impossible_action_guard
    min: 10
    max: 35
    conflict: auto_derive

  - id: close_x
    preferred: 55
    derive: own_light_or_throw_range
    min: 35
    max: 80
    conflict: auto_derive

  - id: medium_x
    preferred: 75
    derive: own_medium_reach_plus_velocity_buffer
    min: 50
    max: 115
    conflict: auto_derive

  - id: far_x
    preferred: 140
    derive: safe_approach_or_projectile_range
    min: 90
    max: 220
    conflict: auto_derive

  - id: projectile_x
    preferred: 220
    derive: enemy_projectile_dodge_distance
    min: 120
    max: 320
    conflict: auto_derive

  - id: anti_air_x
    preferred: 65
    derive: anti_air_horizontal_reach
    min: 35
    max: 110
    conflict: auto_derive

  - id: anti_air_y_high
    preferred: -75
    derive: airborne_target_high_y
    min: -140
    max: -35
    conflict: auto_derive

  - id: anti_air_y_low
    preferred: -15
    derive: airborne_target_low_y
    min: -40
    max: 10
    conflict: auto_derive

  - id: air_combo_x
    preferred: 70
    derive: air_normal_reach_plus_velocity_buffer
    min: 35
    max: 110
    conflict: auto_derive

  - id: air_combo_y
    preferred: 55
    derive: air_normal_vertical_window
    min: 25
    max: 85
    conflict: auto_derive

  - id: projectile_special_min_x
    preferred: 90
    derive: projectile_min_safe_distance
    min: 60
    max: 130
    conflict: auto_derive

  - id: projectile_special_max_x
    preferred: 300
    derive: projectile_max_useful_distance
    min: 180
    max: 420
    conflict: auto_derive

  - id: close_super_x
    preferred: 85
    derive: close_super_confirm_reach
    min: 45
    max: 125
    conflict: auto_derive

  - id: close_super_y
    preferred: -65
    derive: close_super_vertical_confirm
    min: -100
    max: 10
    conflict: auto_derive

  - id: level3_x
    preferred: 90
    derive: level3_confirm_reach
    min: 50
    max: 130
    conflict: auto_derive

  - id: knockdown_charge_x
    preferred: 120
    derive: safe_charge_after_knockdown_distance
    min: 80
    max: 180
    conflict: auto_derive
```

## AIR Patch Policy

This brain can read `.air` files to obtain reach, action id, Clsn1/Clsn2,
and active-frame windows. RockAI logic depends heavily on reach and velocity,
so AIR patching must stay `review_only` unless manual state/action mapping is
available.

The patcher may create an AIR patch only when these inputs are available:

- `state_id`: state the AI will call.
- `action_id`: AIR action used by that state.
- `intent`: `extend_confirm`, `fix_whiff`, `anti_air_align`, `air_combo_align`.
- `box_delta` or `box_profile`: exact Clsn change per frame/action with preview diff.

If any input is missing, the UI should show AIR review only and must not apply.

```yaml
air_policy:
  default: review_only
  requires:
    - state_id
    - action_id
    - intent
    - box_delta_or_profile
  safe_intents:
    - extend_confirm
    - fix_whiff
    - anti_air_align
    - air_combo_align
```

## Combo Scan Contract

This brain should treat `comboScan` as the main source of truth for adapting
DivineRockAI-style routing to a new character. State aliases provide preferred
targets, but selector/executor modules should use scanner evidence to decide
whether a route is safe, review-only, or should be skipped.

Required scan fields:

- `comboScan.states`: role, HitDef summary, cancel targets, power cost, action ids, and AIR reach for each state.
- `comboScan.cancelEdges`: numeric ChangeState edges with trigger summary and confidence.
- `comboScan.routeCandidates`: hit-confirm/contact routes that can be used as a stable combo graph.
- `stateActionMap`: state-to-action mapping from CNS/ST.
- `airReach`: Clsn1 reach per action id.
- `states.powerCosts`: parsed or inferred meter cost bucket.

RockAI dynamic-route policy:

- Selector modules may assign `${var.rock_route}` or `${var.rock_air_route}`, but the UI should mark these routes `needs_review` if the target came from `value = var(...)` and cannot be resolved to a numeric state.
- Executor modules are safe only when the selected route target exists, has a valid role for the current StateType, and does not conflict with opponent liedown/juggle state.
- `rock_ground_route_selector` should prefer scanner-confirmed ground routes before fallback aliases.
- `rock_air_route_selector` should prefer `air normal` roles with AIR reach matching X/Y windows.
- `rock_meter_cashout` should require parsed meter cost or a known state alias convention before marking a super route safe.

Validation policy:

- `safe`: target state exists, target role matches the selector, HitDef/AIR reach is present for attack routes, and a numeric `MoveHit`/`MoveContact` edge confirms the link or the call is neutral/punish with valid range.
- `needs_review`: target is dynamic, AIR reach is missing, meter cost is unknown, route uses expression-heavy IfElse targets, or the scanner cannot confirm hitstun/juggle state.
- `unsafe`: target state is missing, route calls a ground state while airborne or an air state while grounded, super cost cannot be paid, or the route targets a lying opponent with a non-OTG attack.

Role mapping:

- Ground selector: `low starter`, `normal`, `launcher`, `special`, `special launcher`, `super`.
- Air selector: `air normal` only.
- Meter selector: `super` only after hit-confirm, opponent low life, airborne/fall carry, or safe close range.
- Defensive selector: guard/parry/roll/run/backdash routes are utility and do not require HitDef.

## Lite Fit And Boss Metadata

This metadata is based on a fresh scan of `chars/DivineRockAI`. It lets the
patcher create a Lite Fit plan when the receiver cannot host the full RockAI
variable set. Core behavior should survive with direct runtime triggers, while
memory-heavy RockAI modules are added only when safe variables exist or the user
manually approves old/unknown variable reuse.

```yaml
source_scan:
  character: DivineRockAI
  scanned_from: chars/DivineRockAI
  var_slots:
    active: 58
    documented_only: 0
    hard_free: 2
    soft_free: 2
    hard_free_list: [55, 57]
  fvar_slots:
    active: 18
    documented_only: 0
    hard_free: 22
    soft_free: 22
  var_ownership:
    ai_owned: 39
    reusable: 39
    high_risk: 24
    unknown: 11
  combat_summary:
    starters: ok
    normal_chain: weak
    special_bridge: ok
    super_cashout: ok
    air_followup: ok
  useful_states:
    parry: [760, 761, 762]
    roll: [710, 715]
    run: [100, 101, 105, 106]
    charge: [730]
    zero_counter: [750]
    ex_500: [1030, 1130, 1230, 1330, 1430, 1530]
    ex_close_confirm: [1030, 1430, 1530]
    ex_grab_or_point_blank: [1130]
    ex_setup_or_self_buff: [1230, 1330]
    close_confirm_super_1000: [3005, 3100]
    close_confirm_super_2000: [3150]
    grab_level3_3000: [3200]
    setup_meter: [740, 750, 770, 3000, 3050, 10004]
    unsafe_raw: [8330]
  meter_reliability_scan:
    scanner_version: meter_reliability_v1
    report: AI_Patcher/reports/divine_rock_ai_scan_meter_reliability.json
    close_confirm:
      - { state: 1030, use: hit_confirm_only, confidence: 0.78, reach_x: 35, startup: 7, delivery: helper_trap }
      - { state: 1430, use: hit_confirm_only, confidence: 0.78, reach_x: 38, startup: 3, delivery: helper_trap }
      - { state: 1530, use: hit_confirm_only, confidence: 0.78, reach_x: 77, startup: 4, delivery: melee }
      - { state: 3005, use: hit_confirm_only, confidence: 0.78, reach_x: 45, startup: 1, delivery: crossup_melee }
      - { state: 3100, use: hit_confirm_only, confidence: 0.78, reach_x: 82, startup: 7, delivery: helper_trap }
      - { state: 3150, use: hit_confirm_only, confidence: 0.78, reach_x: 82, startup: 7, delivery: helper_trap }
    grab:
      - { state: 1130, use: point_blank_punish_only, confidence: 0.76, startup: 5, delivery: melee }
      - { state: 3200, use: point_blank_punish_only, confidence: 0.76, startup: 3, delivery: helper_trap }
    install:
      - { state: 740, use: safe_neutral_or_knockdown_setup, confidence: 0.58, delivery: helper_trap }
      - { state: 750, use: safe_neutral_or_knockdown_setup, confidence: 0.58, delivery: helper_trap }
      - { state: 3000, use: safe_neutral_or_knockdown_setup, confidence: 0.66, startup: 3, delivery: helper_trap }
      - { state: 3050, use: safe_neutral_or_knockdown_setup, confidence: 0.58, delivery: helper_trap }
    self_buff:
      - { state: 770, use: knockdown_or_far_safe_only, confidence: 0.62, startup: 1, delivery: helper_trap }
      - { state: 1230, use: knockdown_or_far_safe_only, confidence: 0.62, startup: 2, delivery: melee }
      - { state: 1330, use: knockdown_or_far_safe_only, confidence: 0.54, delivery: melee }
      - { state: 10004, use: knockdown_or_far_safe_only, confidence: 0.54, delivery: melee }
    unsafe_raw:
      - { state: 8330, use: do_not_raw, confidence: 0.37 }
  confirmed_routes:
    - chain: [1010, 1011]
      kind: contact
      note: special continuation
    - chain: [1130, 1131]
      kind: contact
      note: anti-air/special launcher continuation
    - chain: [3005, 3006]
      kind: close_confirm
      note: scanner classifies 3005 as level-1 hit-confirm super start
    - chain: [3200, 3201]
      kind: grab_followup_review
      note: scanner classifies level3 as grab/custom-target style; keep point-blank punish only unless target resolver confirms close_confirm equivalent

boss_profiles:
  normal:
    trigger: "Life >= 500"
    aggression: 220
    parry_priority: high
    route_memory: preferred
    meter_cashout: confirmed_only
  rushdown:
    trigger: "Life < 500"
    aggression: 480
    parry_priority: high
    route_memory: optional
    meter_cashout: "hit_confirm_or_enemy_life_below_400"
  desperation:
    trigger: "Life < 250 || EnemyNear,Life < 250"
    aggression: 620
    parry_priority: high
    route_memory: optional
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
    - id: variable_comments
      tier: support
      min_vars: []
      fallback: none

    - id: rock_measurement_core
      tier: core
      min_vars: [ai_enabled]
      optional_vars:
        - rock_enemy_grounded
        - rock_hit_confirm_time
        - rock_enemy_unjuggle
        - rock_enemy_juggle_ok
        - rock_enemy_wakeup
        - rock_enemy_x
        - rock_enemy_y
        - rock_enemy_vel_x
        - rock_ai_chance
      fallback:
        mode: stateless_measurement
        keeps: [AILevel_bridge, direct_P2BodyDist, direct_MoveHit_MoveContact]
        trigger: "AILevel && NumEnemy && RoundState = 2"

    - id: adaptive_guard_memory
      tier: optional_memory
      min_vars: [rock_guard_memory, rock_guard_state_1, rock_guard_state_2, rock_guard_state_3]
      fallback:
        mode: direct_guard_trigger
        keeps: [guard_or_parry_reaction]
        trigger: "AILevel && NumEnemy && RoundState = 2 && (InGuardDist || EnemyNear,MoveType = A || Enemy,NumProj > 0)"

    - id: rock_defensive_router
      tier: core_defense
      min_vars: [ai_enabled]
      optional_vars: [rock_guard_memory, rock_projectile_flag]
      fallback:
        mode: direct_parry_roll_guard
        trigger: "AILevel && NumEnemy && RoundState = 2 && (InGuardDist || EnemyNear,MoveType = A || Enemy,NumProj > 0)"

    - id: rock_combo_meter_bridge
      tier: boss_core
      min_vars: [ai_enabled]
      optional_vars:
        - rock_enemy_grounded
        - rock_hit_confirm_time
        - rock_enemy_unjuggle
        - rock_enemy_juggle_ok
      fallback:
        mode: direct_hit_confirm_meter
        trigger: "AILevel && NumEnemy && RoundState = 2 && (MoveHit || MoveContact)"

    - id: rock_ground_route_selector
      tier: boss_core
      min_vars: [ai_enabled]
      optional_vars: [rock_route, rock_grab_cd, rock_projectile_flag, rock_hit_confirm_time]
      fallback:
        mode: scanner_confirmed_ground_route_only
        trigger: "AILevel && NumEnemy && RoundState = 2 && StateType != A && (Ctrl || MoveHit || MoveContact)"

    - id: rock_air_route_selector
      tier: optional_route
      min_vars: [ai_enabled]
      optional_vars: [rock_air_route, rock_air_angle]
      fallback:
        mode: direct_air_followup
        trigger: "AILevel && NumEnemy && RoundState = 2 && StateType = A && EnemyNear,StateType = A"

    - id: rock_meter_cashout
      tier: boss_core
      min_vars: [ai_enabled]
      optional_vars: [rock_route, rock_enemy_grounded, rock_hit_confirm_time]
      fallback:
        mode: direct_super_cashout
        trigger: "AILevel && NumEnemy && RoundState = 2 && Power >= 1000 && (MoveHit || EnemyNear,Life < 250)"

    - id: rock_route_executor
      tier: optional_route_memory
      min_vars: [rock_route]
      fallback:
        mode: skip_when_no_route_var
        keeps: [direct_selector_modules]

    - id: anti_projectile_approach
      tier: optional_utility
      min_vars: [ai_enabled]
      optional_vars: [rock_projectile_flag, rock_jump_intent]
      fallback:
        mode: direct_anti_projectile_roll_or_jump
        trigger: "AILevel && NumEnemy && RoundState = 2 && Enemy,NumProj > 0"

    - id: air_action_review
      tier: review_only
      min_vars: []
      fallback:
        mode: report_only

fallback_triggers:
  stateless_guard_parry:
    stand: "AILevel && NumEnemy && RoundState = 2 && StateType = S && (InGuardDist || EnemyNear,MoveType = A)"
    crouch: "AILevel && NumEnemy && RoundState = 2 && StateType != A && (EnemyNear,StateType = C || EnemyNear,StateNo = [400,500])"
    air: "AILevel && NumEnemy && RoundState = 2 && StateType = A && (InGuardDist || EnemyNear,MoveType = A)"
  stateless_ground_route:
    poke: "AILevel && NumEnemy && RoundState = 2 && StateType != A && Ctrl && P2BodyDist X < 70"
    confirm: "AILevel && NumEnemy && RoundState = 2 && StateType != A && (MoveHit || MoveContact)"
  stateless_meter_cashout:
    close_confirm_super: "AILevel && NumEnemy && RoundState = 2 && Power >= 1000 && P2BodyDist X < 85 && MoveHit"
    level3_grab_punish: "AILevel && NumEnemy && RoundState = 2 && Power >= 3000 && P2BodyDist X < 35 && EnemyNear,Ctrl = 0 && EnemyNear,StateType != L"
  boss_rush_pressure:
    enter: "AILevel && NumEnemy && RoundState = 2 && Life < 500 && EnemyNear,MoveType != H"
    projectile_response: "AILevel && NumEnemy && RoundState = 2 && Enemy,NumProj > 0 && P2BodyDist X > 60"
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
    grab_alias_ids: [level3_super, close_grab_special, ex_grab_special]
    utility_alias_allow: [self_buff, install]
    utility_alias_ids: [max_mode, power_charge, zero_counter, close_super, close_super_max]
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
    close_confirm_super:
      preferred: 3005
      scanned_class: close_confirm
      generic_role: level1_close_confirm_cashout
    rush_super:
      preferred: 3100
      scanned_class: close_confirm
      generic_role: rush_hit_confirm_cashout
    rush_super_max:
      preferred: 3150
      scanned_class: close_confirm
      generic_role: level2_rush_hit_confirm_cashout
    close_super:
      preferred: 3000
      scanned_class: install
      generic_role: safe_setup_only
    close_super_max:
      preferred: 3050
      scanned_class: install
      generic_role: safe_setup_only
    level3_super:
      preferred: 3200
      scanned_class: grab
      generic_role: point_blank_grab_punish_only
    max_mode:
      preferred: 770
      scanned_class: self_buff
      generic_role: knockdown_or_far_safe_setup
  confirmed_generic_cashout_aliases: [close_confirm_super, rush_super, rush_super_max]
  confirmed_grab_cashout_aliases: [level3_super]
  safe_setup_aliases: [power_charge, zero_counter, max_mode, close_super, close_super_max]
  blocked_meter_aliases: [unsafe_raw_8330]
  source_scan_evidence:
    confirmed_generic_cashout_states: [3005,3100,3150]
    confirmed_grab_cashout_states: [1130,3200]
    safe_setup_states: [740,750,770,1230,1330,3000,3050,10004]
    blocked_meter_states:
      - { state: 8330, label: unsafe_raw_8330, use: do_not_raw }
```

## Files

```yaml
files:
  cmd:
    detect: character_def.cmd
    purpose: State -1 AI router, commands, helper spawn
  system:
    detect: cns_or_st_with_guard_helpers_or_negative_states
    preferred_names:
      - RockAI/System.cns
      - Coding/System.cns
      - System.cns
    purpose: helper spawn, guard state, -2/-3 support
  specials:
    detect: cns_or_st_with_specials_and_supers
    preferred_names:
      - RockAI/Specials.cns
      - RockAI/Supers.cns
      - Coding/Specials.cns
      - Specials.cns
    purpose: state behavior and meter costs
```

## Module: variable_comments

### Goal

Ghi mapping bien de lan patch sau co the reuse.

### Template

```mugen-template
; AI_PATCH_VAR ai_enabled = ${var.ai_enabled}
; AI_PATCH_VAR rock_route = ${var.rock_route}
; AI_PATCH_VAR rock_air_route = ${var.rock_air_route}
; AI_PATCH_VAR rock_action_lock = ${var.rock_action_lock}
; AI_PATCH_VAR rock_guard_memory = ${var.rock_guard_memory}
; AI_PATCH_FVAR rock_enemy_x = ${fvar.rock_enemy_x}
; AI_PATCH_FVAR rock_enemy_y = ${fvar.rock_enemy_y}
; AI_PATCH_FVAR rock_enemy_vel_x = ${fvar.rock_enemy_vel_x}
```

## Module: rock_measurement_core

### Goal

Tao lop cam bien kieu DivineRockAI: do khoang cach, velocity, enemy grounded, hit-confirm time, juggle-ok, wakeup va chance scalar. Module nay nen nam som trong State -1 hoac khu helper AI.

### Target

```yaml
file: cmd
insert_before:
  - "[State -1, AI Guard"
  - "[State -1, AI Activate"
  - "[State -1"
fallback_insert_before:
  - "[Statedef -1]"
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: rockai_bl:rock_measurement_core:v1
[State -1, RockAI AILevel Bridge]
type = VarSet
trigger1 = AILevel > 0
var(${var.ai_enabled:number}) = AILevel
ignoreHitPause = 1

[State -1, RockAI AILevel Bridge Off]
type = VarSet
trigger1 = AILevel <= 0
var(${var.ai_enabled:number}) = 0
ignoreHitPause = 1

[State -1, RockAI Measure X]
type = Null
triggerAll = ${var.ai_enabled} && NumEnemy
trigger1 = 1 || (${fvar.rock_enemy_x} := P2BodyDist X * Const(size.xscale))
trigger1 = 1 || (${fvar.rock_enemy_y} := P2BodyDist Y)
trigger1 = 1 || (${fvar.rock_enemy_vel_x} := EnemyNear,Vel X)
trigger1 = 1 || (${var.rock_enemy_grounded} := (EnemyNear,StateType = S || EnemyNear,StateType = C))
trigger1 = 1 || (${var.rock_hit_confirm_time} := Cond(NumTarget, Cond(EnemyNear,GetHitVar(ctrlTime) > EnemyNear,GetHitVar(hitTime), EnemyNear,GetHitVar(ctrlTime), EnemyNear,GetHitVar(hitTime)), 0))
trigger1 = 1 || (${var.rock_enemy_unjuggle} := (EnemyNear,Anim = 5120 && EnemyNear,AnimTime < -7 || EnemyNear,StateNo = 5040 || EnemyNear,StateType = L))
trigger1 = 1 || (${var.rock_enemy_juggle_ok} := (!${var.rock_enemy_unjuggle} && EnemyNear,HitFall))
trigger1 = 1 || (${var.rock_enemy_wakeup} := (EnemyNear,Anim = 5120 || EnemyNear,StateNo = [5110,5119]))
ignoreHitPause = 1

[State -1, RockAI Chance Scalar]
type = Null
triggerAll = ${var.ai_enabled}
trigger1 = 1 || (${fvar.rock_ai_chance} := (${var.ai_enabled} ** 2 / 64.0))
ignoreHitPause = 1

[State -1, RockAI Clear Routes]
type = VarSet
triggerAll = ${var.ai_enabled}
trigger1 = RoundState != 2 || MoveType = H
trigger2 = StateType = A && ${var.rock_route}
trigger3 = StateType != A && ${var.rock_air_route}
var(${var.rock_route:number}) = 0
ignoreHitPause = 1

[State -1, RockAI Clear Air Route]
type = VarSet
triggerAll = ${var.ai_enabled}
trigger1 = RoundState != 2 || MoveType = H
trigger2 = StateType != A
var(${var.rock_air_route:number}) = 0
ignoreHitPause = 1
; AI_PATCH_END: rockai_bl:rock_measurement_core:v1
```

## Module: adaptive_guard_memory

### Goal

Hoc cac starter ma doi thu da danh trung khi minh vua guard/parry. DivineRockAI luu state doi thu vao danh sach nho de lan sau tang kha nang guard/parry/counter.

### Target

```yaml
file: cmd
insert_after_module: rock_measurement_core
fallback_insert_before:
  - "[State -1, AI Guard"
  - "[State -1"
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: rockai_bl:adaptive_guard_memory:v1
[State -1, RockAI Guard Memory Timer Down]
type = VarAdd
triggerAll = ${var.ai_enabled}
trigger1 = ${var.rock_guard_memory} > 0
var(${var.rock_guard_memory:number}) = -1
ignoreHitPause = 1

[State -1, RockAI Learn Guarded Starter A]
type = Null
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = EnemyNear,MoveHit = 1
triggerAll = PrevStateNo = 131 || PrevStateNo = 152 || PrevStateNo = 153 || StateNo = ${state.parry_stand} || StateNo = ${state.parry_crouch}
triggerAll = EnemyNear,StateType != A
trigger1 = !${var.rock_guard_state_1}
trigger1 = 1 || (${var.rock_guard_state_1} := EnemyNear,StateNo)
trigger1 = 1 || (${var.rock_guard_memory} := 90)
trigger2 = ${var.rock_guard_state_1} && !${var.rock_guard_state_2} && EnemyNear,StateNo != ${var.rock_guard_state_1}
trigger2 = 1 || (${var.rock_guard_state_2} := EnemyNear,StateNo)
trigger2 = 1 || (${var.rock_guard_memory} := 90)
trigger3 = ${var.rock_guard_state_1} && ${var.rock_guard_state_2} && !${var.rock_guard_state_3} && EnemyNear,StateNo != ${var.rock_guard_state_1} && EnemyNear,StateNo != ${var.rock_guard_state_2}
trigger3 = 1 || (${var.rock_guard_state_3} := EnemyNear,StateNo)
trigger3 = 1 || (${var.rock_guard_memory} := 90)
ignoreHitPause = 1

[State -1, RockAI Adaptive Low Guard]
type = ChangeState
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2 && StateType != A
triggerAll = Ctrl && InGuardDist
triggerAll = EnemyNear,MoveType = A
triggerAll = P2BodyDist X <= ${range.medium_x}
trigger1 = EnemyNear,StateType = C
trigger2 = EnemyNear,StateNo = ${var.rock_guard_state_1}
trigger3 = EnemyNear,StateNo = ${var.rock_guard_state_2}
trigger4 = EnemyNear,StateNo = ${var.rock_guard_state_3}
value = ${state.crouch_guard}
; AI_PATCH_END: rockai_bl:adaptive_guard_memory:v1
```

## Module: rock_defensive_router

### Goal

Port tu duy counter/reversal cua DivineRockAI: khi doi thu dang tan cong, uu tien guard/parry/roll theo khoang cach va projectile. Module nay khong tang phong thu, khong armor, khong heal.

### Target

```yaml
file: cmd
insert_after_module: adaptive_guard_memory
fallback_insert_before:
  - "[State -1, AI Guard"
  - "[State -1"
route_preview:
  - id: rock_defensive_escape_routes
    type: defensive_route
    source: divine_rock_ai_guard_parry_roll_logic
    chain:
      - parry_crouch
      - parry_stand
      - parry_air
      - roll_forward
      - roll_back
    condition:
      - enemy_attack_or_projectile
      - guard_distance
      - low_attack_memory
      - point_blank_escape
    policy:
      - parry_before_rushdown
      - roll_forward_through_projectiles
      - roll_back_to_reset_spacing
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: rockai_bl:rock_defensive_router:v1
[State -1, RockAI Crouch Parry Read]
type = HitOverride
triggerAll = ${var.ai_enabled} && NumEnemy
triggerAll = RoundState = 2 && StateType != A && MoveType != H
triggerAll = Ctrl || StateNo = ${state.parry_crouch}
triggerAll = InGuardDist || EnemyNear,MoveType = A || Enemy,NumProj > 0
triggerAll = P2BodyDist X <= ${range.medium_x} || Enemy,NumProj > 0
triggerAll = EnemyNear,StateType = C || EnemyNear,StateNo = ${var.rock_guard_state_1} || EnemyNear,StateNo = ${var.rock_guard_state_2} || EnemyNear,StateNo = ${var.rock_guard_state_3}
trigger1 = Random < Ceil((80 + (${var.rock_guard_memory} > 0) * 120) * ${fvar.rock_ai_chance})
trigger1 = ${var.rock_guard_memory} := 35
attr = C, NA, SA, HA
stateNo = ${state.parry_crouch}
slot = 0
time = 8

[State -1, RockAI Stand Parry Read]
type = HitOverride
triggerAll = ${var.ai_enabled} && NumEnemy
triggerAll = RoundState = 2 && StateType != A && MoveType != H
triggerAll = Ctrl || StateNo = ${state.parry_stand}
triggerAll = InGuardDist || EnemyNear,MoveType = A || Enemy,NumProj > 0
triggerAll = !(EnemyNear,StateType = C && EnemyNear,MoveType = A)
trigger1 = Random < Ceil((55 + (${var.rock_guard_memory} > 0) * 80) * ${fvar.rock_ai_chance})
trigger1 = ${var.rock_guard_memory} := 25
attr = SA, AA, AP
stateNo = ${state.parry_stand}
slot = 0
time = 8

[State -1, RockAI Air Parry Read]
type = HitOverride
triggerAll = ${var.ai_enabled} && NumEnemy
triggerAll = RoundState = 2 && StateType = A && MoveType != H
triggerAll = Ctrl || StateNo = ${state.parry_air}
triggerAll = StateNo != [5000,5999]
triggerAll = InGuardDist || EnemyNear,MoveType = A || Enemy,NumProj > 0
trigger1 = Random < Ceil((55 + (${var.rock_guard_memory} > 0) * 70) * ${fvar.rock_ai_chance})
trigger1 = ${var.rock_guard_memory} := 30
attr = SA, AA, AP
stateNo = ${state.parry_air}
forceAir = 1
slot = 0
time = 7

[State -1, RockAI Roll Through Projectile]
type = ChangeState
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && Ctrl
triggerAll = Enemy,NumProj > 0 || EnemyNear,MoveType = A
triggerAll = P2BodyDist X = [${range.close_x},${range.projectile_x}]
trigger1 = FrontEdgeBodyDist > 80 && Random < Ceil(260 * ${fvar.rock_ai_chance})
value = ${state.roll_forward}

[State -1, RockAI Roll Back Point Blank]
type = ChangeState
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && Ctrl
triggerAll = EnemyNear,MoveType = A || P2BodyDist X <= ${range.point_blank_x}
trigger1 = BackEdgeBodyDist > 60 && Random < Ceil(240 * ${fvar.rock_ai_chance})
value = ${state.roll_back}
; AI_PATCH_END: rockai_bl:rock_defensive_router:v1
```

## Module: rock_combo_meter_bridge

### Goal

Give meter and special routes priority before the generic light/medium selector
fills `${var.rock_route}` with normal attacks. This fixes characters whose scan
has valid super states and power costs, but whose cancel graph does not expose
enough numeric edges for the normal route selector to naturally climb into
special/hyper/super.

The bridge uses direct `ChangeState` only from safe neutral, punish, hit-confirm,
or `MoveContact` windows. It does not add armor, defense, damage, or healing.

### Target

```yaml
file: cmd
insert_after_module: rock_defensive_router
fallback_insert_before:
  - "[State -1, AI Hyper Combo"
  - "[State -1, AI Special Combo"
  - "[State -1"
risk: medium
scan_requirements:
  - comboScan.states
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
  - id: rock_priority_meter_bridge
    type: meter_bridge
    source: divine_rock_ai_meter_reliability_cashout_routes
    chain:
      - close_confirm_super
      - rush_super_max
      - rush_super
      - level3_super
      - ex_projectile
      - rush_special
      - projectile_light
    condition:
      - power_gate
      - hit_confirm_or_movecontact
      - grounded_enemy
      - scanner_resolved_range
    policy:
      - prefer_meter_before_generic_normals
      - close_confirm_supers_only_after_hit_confirm
      - meter_state_x_y_window_must_come_from_target_scan
      - no_ifelse_between_meter_states_with_different_cost_or_reach
      - level3_super_only_as_point_blank_punish
      - skip_liedown_or_unjuggle_targets
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: rockai_bl:rock_combo_meter_bridge:v1
[State -1, AI_PATCH_METER_POLICY RockAI Point Blank Level3 Punish]
type = ChangeState
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && EnemyNear,StateType != L
triggerAll = Power >= ${state.level3_super:cost}
triggerAll = !${var.rock_enemy_unjuggle}
triggerAll = P2BodyDist X <= ${range.point_blank_x}
triggerAll = P2BodyDist Y > -35
triggerAll = Ctrl && !InGuardDist && Enemy,NumProj = 0
trigger1 = EnemyNear,Ctrl = 0 && EnemyNear,MoveType != A
trigger1 = Random < Ceil(95 * ${fvar.rock_ai_chance})
trigger2 = EnemyNear,MoveType = H && EnemyNear,Life < 320
trigger2 = Random < Ceil(120 * ${fvar.rock_ai_chance})
value = ${state.level3_super}

[State -1, AI_PATCH_METER_POLICY RockAI Priority Close Confirm Super Cashout]
type = ChangeState
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && EnemyNear,StateType != L
triggerAll = Power >= ${state.close_confirm_super:cost}
triggerAll = !${var.rock_enemy_unjuggle}
triggerAll = P2BodyDist X = [-8,${state.close_confirm_super:x_max}]
triggerAll = P2BodyDist Y = [${state.close_confirm_super:y_min},${state.close_confirm_super:y_max}]
triggerAll = Ctrl || MoveHit || MoveContact || ${var.rock_hit_confirm_time} > 2 || StateNo = [200,699] || StateNo = [1000,2999]
trigger1 = MoveHit || ${var.rock_hit_confirm_time} > 4
trigger2 = EnemyNear,Life < 450
trigger3 = StateNo = [200,699] && MoveContact && Random < Ceil(280 * ${fvar.rock_ai_chance})
value = ${state.close_confirm_super}

[State -1, AI_PATCH_METER_POLICY RockAI Priority Rush Super Max Cashout]
type = ChangeState
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && EnemyNear,StateType != L
triggerAll = Power >= ${state.rush_super_max:cost}
triggerAll = !${var.rock_enemy_unjuggle}
triggerAll = P2BodyDist X = [-20,${state.rush_super_max:x_max}]
triggerAll = P2BodyDist Y = [${state.rush_super_max:y_min},${state.rush_super_max:y_max}]
triggerAll = Ctrl || MoveHit || MoveContact || ${var.rock_hit_confirm_time} > 2 || StateNo = [200,699] || StateNo = [1000,2999]
trigger1 = MoveHit || ${var.rock_hit_confirm_time} > 4
trigger2 = EnemyNear,Life < 420
trigger3 = StateNo = [200,699] && MoveContact && Random < Ceil(240 * ${fvar.rock_ai_chance})
value = ${state.rush_super_max}

[State -1, AI_PATCH_METER_POLICY RockAI Priority Rush Super Cashout]
type = ChangeState
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && EnemyNear,StateType != L
triggerAll = Power >= ${state.rush_super:cost}
triggerAll = !${var.rock_enemy_unjuggle}
triggerAll = P2BodyDist X = [-20,${state.rush_super:x_max}]
triggerAll = P2BodyDist Y = [${state.rush_super:y_min},${state.rush_super:y_max}]
triggerAll = Ctrl || MoveHit || MoveContact || ${var.rock_hit_confirm_time} > 2 || StateNo = [200,699] || StateNo = [1000,2999]
trigger1 = MoveHit || ${var.rock_hit_confirm_time} > 4
trigger2 = EnemyNear,Life < 420
trigger3 = StateNo = [200,699] && MoveContact && Random < Ceil(210 * ${fvar.rock_ai_chance})
value = ${state.rush_super}

[State -1, AI_PATCH_METER_POLICY RockAI Normal Contact To EX Projectile]
type = ChangeState
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && EnemyNear,StateType != L
triggerAll = Power >= ${state.ex_projectile:cost}
triggerAll = StateNo = [200,499] && MoveContact
triggerAll = P2BodyDist X = [-20,${state.ex_projectile:x_max}]
triggerAll = P2BodyDist Y = [${state.ex_projectile:y_min},${state.ex_projectile:y_max}]
trigger1 = MoveHit && Random < Ceil(520 * ${fvar.rock_ai_chance})
trigger2 = Random < Ceil(180 * ${fvar.rock_ai_chance})
value = ${state.ex_projectile}

[State -1, RockAI Normal Contact To Rush Special]
type = ChangeState
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && EnemyNear,StateType != L
triggerAll = StateNo = [200,499] && MoveContact
triggerAll = P2BodyDist X = [-8,${range.medium_x}]
triggerAll = P2BodyDist Y > -65
trigger1 = MoveHit && Random < Ceil(420 * ${fvar.rock_ai_chance})
trigger2 = Random < Ceil(220 * ${fvar.rock_ai_chance})
value = ${state.rush_special}

[State -1, AI_PATCH_METER_POLICY RockAI Strong Contact To EX Projectile]
type = ChangeState
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && EnemyNear,StateType != L
triggerAll = Power >= ${state.ex_projectile:cost}
triggerAll = StateNo = [400,699] && MoveContact
triggerAll = P2BodyDist X = [-20,${state.ex_projectile:x_max}]
triggerAll = P2BodyDist Y = [${state.ex_projectile:y_min},${state.ex_projectile:y_max}]
triggerAll = !NumHelper
trigger1 = MoveHit && Random < Ceil(420 * ${fvar.rock_ai_chance})
trigger2 = ${var.rock_hit_confirm_time} > 2 && Random < Ceil(220 * ${fvar.rock_ai_chance})
value = ${state.ex_projectile}

[State -1, RockAI Strong Contact To Projectile Special]
type = ChangeState
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && EnemyNear,StateType != L
triggerAll = StateNo = [400,699] && MoveContact
triggerAll = P2BodyDist X = [${range.close_x},${range.projectile_special_max_x}]
triggerAll = !NumHelper
trigger1 = MoveHit && Random < Ceil(320 * ${fvar.rock_ai_chance})
trigger2 = ${var.rock_hit_confirm_time} > 2 && Random < Ceil(240 * ${fvar.rock_ai_chance})
value = ${state.projectile_light}
; AI_PATCH_END: rockai_bl:rock_combo_meter_bridge:v1
```

## Module: rock_ground_route_selector

### Goal

Select a ground route into `${var.rock_route}` instead of changing state
immediately. DivineRockAI uses this to rank priorities:
punish/reversal > anti-air > lights/links > projectile/poke > throw.

This selector should prefer `comboScan` evidence:

- anti-air route: prefer `launcher` or `special launcher` with AIR reach covering airborne Y.
- hitstun link: prefer numeric `MoveHit`/`MoveContact` route candidates first.
- neutral light/medium: prefer `low starter` or `normal` roles that have HitDef and valid reach.
- projectile/poke: prefer `special` or projectile helper states only outside point-blank range.
- throw/grab: keep review if target has no HitDef and no throw-like state evidence.

### Target

```yaml
file: cmd
insert_after_module: rock_defensive_router
fallback_insert_before:
  - "[State -1, AI Hyper Combo"
  - "[State -1, AI Special Combo"
  - "[State -1"
risk: medium
scan_requirements:
  - comboScan.states
  - comboScan.routeCandidates
  - comboScan.cancelEdges
  - stateActionMap
  - airReach
safe_when:
  - target_state_exists
  - target_role_matches_ground_route
  - hitdef_or_utility_route_present
  - range_matches_air_reach
review_when:
  - dynamic_route_target
  - missing_air_reach
  - target_role_unknown
  - ifelse_target_unresolved
route_preview:
  - id: rock_ground_selector_routes
    type: ground_route
    source: divine_rock_ai_var18_ground_selector
    chain:
      - anti_air_special
      - launcher_low
      - light_low
      - long_low
      - light_stand
      - medium_low
      - medium_stand
      - ex_projectile
      - projectile_light
      - throw_close
      - ex_grab_special
    condition:
      - anti_air_window
      - hitstun_link_window
      - neutral_light_medium_window
      - projectile_poke_window
      - close_throw_window
    policy:
      - route_aliases_are_resolved_per_character
      - prefer_combo_scan_evidence_before_fallback
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: rockai_bl:rock_ground_route_selector:v1
[State -1, RockAI Reset Ground Route]
type = VarSet
triggerAll = ${var.ai_enabled}
trigger1 = RoundState != 2 || StateType = A || MoveType = H
trigger2 = ${var.rock_route} && StateNo = ${var.rock_route}
var(${var.rock_route:number}) = 0
ignoreHitPause = 1

[State -1, RockAI AntiAir Route Pick]
type = Null
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && (Ctrl || StateNo = ${state.walk_forward} || StateNo = ${state.run_forward})
triggerAll = !${var.rock_route} && !${var.rock_enemy_unjuggle}
triggerAll = EnemyNear,StateType = A && !EnemyNear,HitFall && EnemyNear,StateNo != 5040
trigger1 = P2BodyDist X = [-20,${range.anti_air_x}]
trigger1 = P2BodyDist Y = [${range.anti_air_y_high},${range.anti_air_y_low}]
trigger1 = Random < Ceil(520 * ${fvar.rock_ai_chance})
trigger1 = 1 || (${var.rock_route} := ${state.anti_air_special})
trigger2 = P2BodyDist X = [20,${range.anti_air_x}]
trigger2 = P2BodyDist Y = [${range.anti_air_y_high},${range.anti_air_y_low}]
trigger2 = Random < Ceil(420 * ${fvar.rock_ai_chance})
trigger2 = 1 || (${var.rock_route} := ${state.launcher_low})

[State -1, RockAI Hitstun Link Pick]
type = Null
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && !${var.rock_route}
triggerAll = Ctrl || StateNo = ${state.walk_forward} || StateNo = ${state.run_forward}
triggerAll = ${var.rock_enemy_grounded} && ${var.rock_hit_confirm_time} > 2
trigger1 = P2BodyDist X <= ${range.close_x}
trigger1 = 1 || (${var.rock_route} := IfElse(P2BodyDist X < 30, ${state.light_low}, ${state.long_low}))
trigger2 = P2BodyDist X = [${range.close_x},${range.medium_x}]
trigger2 = 1 || (${var.rock_route} := ${state.long_low})

[State -1, RockAI Neutral Light Medium Pick]
type = Null
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && !${var.rock_route} && ${var.rock_enemy_grounded}
triggerAll = Ctrl || StateNo = ${state.walk_forward} || StateNo = ${state.run_forward}
triggerAll = EnemyNear,MoveType != A && EnemyNear,StateType != L
trigger1 = P2BodyDist X <= ${range.close_x}
trigger1 = Random < Ceil(420 * ${fvar.rock_ai_chance})
trigger1 = 1 || (${var.rock_route} := IfElse(EnemyNear,StateType = C, ${state.light_low}, ${state.light_stand}))
trigger2 = P2BodyDist X = [${range.close_x},${range.medium_x}]
trigger2 = Random < Ceil(300 * ${fvar.rock_ai_chance})
trigger2 = 1 || (${var.rock_route} := IfElse(Random < 500, ${state.medium_low}, ${state.medium_stand}))

[State -1, AI_PATCH_METER_POLICY RockAI Poke EX Projectile Pick]
type = Null
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && !${var.rock_route}
triggerAll = Power >= ${state.ex_projectile:cost}
triggerAll = Ctrl || StateNo = ${state.walk_forward} || StateNo = ${state.run_forward}
triggerAll = EnemyNear,MoveType != A || EnemyNear,StateType = L
trigger1 = P2BodyDist X = [-20,${state.ex_projectile:x_max}]
trigger1 = P2BodyDist Y = [${state.ex_projectile:y_min},${state.ex_projectile:y_max}]
trigger1 = !NumHelper && !${var.rock_enemy_unjuggle}
trigger1 = Random < Ceil(140 * ${fvar.rock_ai_chance})
trigger1 = 1 || (${var.rock_route} := ${state.ex_projectile})

[State -1, RockAI Poke Projectile Pick]
type = Null
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && !${var.rock_route}
triggerAll = Ctrl || StateNo = ${state.walk_forward} || StateNo = ${state.run_forward}
triggerAll = EnemyNear,MoveType != A || EnemyNear,StateType = L
trigger1 = P2BodyDist X = [${range.projectile_special_min_x},${range.projectile_special_max_x}]
trigger1 = !NumHelper && !${var.rock_enemy_unjuggle}
trigger1 = Random < Ceil(170 * ${fvar.rock_ai_chance})
trigger1 = 1 || (${var.rock_route} := ${state.projectile_light})
trigger2 = P2BodyDist X = [${range.medium_x},${range.far_x}]
trigger2 = Random < Ceil(180 * ${fvar.rock_ai_chance})
trigger2 = 1 || (${var.rock_route} := ${state.long_low})

[State -1, AI_PATCH_METER_POLICY RockAI Close EX Grab Pick]
type = Null
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && !${var.rock_route} && !${var.rock_grab_cd}
triggerAll = Power >= ${state.ex_grab_special:cost}
triggerAll = Ctrl || StateNo = ${state.walk_forward} || StateNo = ${state.run_forward}
triggerAll = EnemyNear,StateType != A && EnemyNear,MoveType != H && EnemyNear,NumProj = 0
trigger1 = P2BodyDist X = [-8,${state.ex_grab_special:x_max}]
trigger1 = P2BodyDist Y = [${state.ex_grab_special:y_min},${state.ex_grab_special:y_max}]
trigger1 = Random < Ceil(120 * ${fvar.rock_ai_chance})
trigger1 = 1 || (${var.rock_route} := ${state.ex_grab_special})
trigger1 = 1 || (${var.rock_grab_cd} := 45)

[State -1, RockAI Close Throw Pick]
type = Null
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && !${var.rock_route} && !${var.rock_grab_cd}
triggerAll = Ctrl || StateNo = ${state.walk_forward} || StateNo = ${state.run_forward}
triggerAll = EnemyNear,StateType != A && EnemyNear,StateType != L && EnemyNear,MoveType != H && EnemyNear,NumProj = 0
triggerAll = P2BodyDist X = [-8,32]
triggerAll = P2BodyDist Y = [-12,12]
triggerAll = EnemyNear,Ctrl = 0 || EnemyNear,MoveType = A || P2StateNo = [120,155]
triggerAll = P2StateNo != [800,899]
trigger1 = Random < Ceil(80 * ${fvar.rock_ai_chance})
trigger1 = 1 || (${var.rock_route} := ${state.throw_close})
trigger1 = 1 || (${var.rock_grab_cd} := 45)

[State -1, RockAI Grab Cooldown]
type = VarAdd
triggerAll = ${var.ai_enabled}
trigger1 = ${var.rock_grab_cd} > 0
var(${var.rock_grab_cd:number}) = -1
ignoreHitPause = 1
; AI_PATCH_END: rockai_bl:rock_ground_route_selector:v1
```

## Module: rock_air_route_selector

### Goal

Dedicated DivineRockAI-style air route: use X/Y windows and enemy velocity to
select the correct air normal, and avoid calling ground states while airborne.
This module should use `comboScan.states[].role = air normal` and `airReach`
to validate the selected action before marking the route safe.

### Target

```yaml
file: cmd
insert_after_module: rock_ground_route_selector
fallback_insert_before:
  - "[State -1, Jump Light"
  - "[State -1"
risk: medium
scan_requirements:
  - comboScan.states
  - stateActionMap
  - airReach
safe_when:
  - target_role_is_air_normal
  - air_reach_matches_x_y_window
  - state_type_air_only
review_when:
  - missing_air_reach
  - target_not_air_normal
  - action_missing_clsn1
route_preview:
  - id: rock_air_followup_routes
    type: air_follow_up
    source: divine_rock_ai_air_normal_selector
    chain:
      - air_strong
      - air_medium
      - air_light
    condition:
      - airborne_self
      - x_y_air_reach_window
      - enemy_airborne_or_combo_window
    policy:
      - never_call_ground_state_while_airborne
      - require_air_normal_role_or_air_reach
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: rockai_bl:rock_air_route_selector:v1
[State -1, RockAI Air Route Reset]
type = VarSet
triggerAll = ${var.ai_enabled}
trigger1 = StateType != A || MoveType = H || RoundState != 2
trigger2 = ${var.rock_air_route} && StateNo = ${var.rock_air_route}
var(${var.rock_air_route:number}) = 0
ignoreHitPause = 1

[State -1, RockAI Air Normal Pick]
type = Null
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType = A && (Ctrl || StateNo = 140)
triggerAll = !${var.rock_air_route}
triggerAll = P2BodyDist X > -12
triggerAll = EnemyNear,HitDefAttr != SCA,SA || ${var.ai_enabled} < 6
trigger1 = P2BodyDist X = [-10,${range.air_combo_x}]
trigger1 = P2BodyDist Y = [-30,${range.air_combo_y}]
trigger1 = Vel Y > -1 || EnemyNear,StateType = A
trigger1 = Random < Ceil(520 * ${fvar.rock_ai_chance})
trigger1 = 1 || (${var.rock_air_route} := ${state.air_strong})
trigger2 = P2BodyDist X = [-10,${range.air_combo_x}]
trigger2 = P2BodyDist Y = [-15,${range.air_combo_y}]
trigger2 = Random < Ceil(460 * ${fvar.rock_ai_chance})
trigger2 = 1 || (${var.rock_air_route} := ${state.air_medium})
trigger3 = P2BodyDist X = [-10,${range.close_x}]
trigger3 = P2BodyDist Y = [-10,35]
trigger3 = Random < Ceil(620 * ${fvar.rock_ai_chance})
trigger3 = 1 || (${var.rock_air_route} := ${state.air_light})
; AI_PATCH_END: rockai_bl:rock_air_route_selector:v1
```

## Module: rock_meter_cashout

### Goal

DivineRockAI-style cashout: Level 3 only when close and confirmed; Level 2/1
when hitstun, anti-air, fall carry, or opponent life makes the cashout valuable.
Do not call super when P2 is lying too far away or when juggle state is invalid.
Use `states.powerCosts` and `comboScan` before marking a cashout route safe.

### Target

```yaml
file: cmd
insert_after_module: rock_air_route_selector
fallback_insert_before:
  - "[State -1, AI Hyper Combo"
  - "[State -1, AI Special Combo"
  - "[State -1"
risk: medium
scan_requirements:
  - comboScan.states
  - comboScan.routeCandidates
  - states.powerCosts
  - airReach
safe_when:
  - super_role_detected
  - meter_cost_known_or_alias_verified
  - hit_confirm_or_low_life_or_fall_carry
  - range_matches_super_reach
review_when:
  - meter_cost_unknown
  - super_reach_missing
  - target_liedown_mismatch
route_preview:
  - id: rock_meter_cashout_routes
    type: super_cashout
    source: divine_rock_ai_meter_reliability_cashout_policy
    chain:
      - close_confirm_super
      - rush_super_max
      - rush_super
      - level3_super
      - max_mode
    condition:
      - power_gate
      - hit_confirm_or_low_life
      - fall_carry_or_grounded_enemy
      - range_matches_super_reach
    policy:
      - close_confirm_supers_only_after_hit_confirm
      - meter_state_x_y_window_must_come_from_target_scan
      - no_ifelse_between_meter_states_with_different_cost_or_reach
      - level3_only_on_point_blank_grab_punish
      - max_mode_only_when_knockdown_space_is_safe
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: rockai_bl:rock_meter_cashout:v1
[State -1, AI_PATCH_METER_POLICY RockAI Level3 Grab Punish Pick]
type = Null
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && !${var.rock_route}
triggerAll = Power >= ${state.level3_super:cost}
triggerAll = !${var.rock_enemy_unjuggle}
triggerAll = Ctrl && !InGuardDist && Enemy,NumProj = 0
trigger1 = P2BodyDist X <= ${range.point_blank_x}
trigger1 = P2BodyDist Y > -35
trigger1 = EnemyNear,Ctrl = 0 && EnemyNear,MoveType != A
trigger1 = Random < Ceil(95 * ${fvar.rock_ai_chance})
trigger1 = 1 || (${var.rock_route} := ${state.level3_super})

[State -1, AI_PATCH_METER_POLICY RockAI Super Confirm Pick]
type = Null
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && !${var.rock_route}
triggerAll = Power >= ${state.close_confirm_super:cost}
triggerAll = !${var.rock_enemy_unjuggle}
triggerAll = MoveHit || ${var.rock_hit_confirm_time} > 4 || EnemyNear,MoveType = H
trigger1 = P2BodyDist X = [-8,${state.close_confirm_super:x_max}]
trigger1 = P2BodyDist Y = [${state.close_confirm_super:y_min},${state.close_confirm_super:y_max}]
trigger1 = Random < Ceil(420 * ${fvar.rock_ai_chance})
trigger1 = 1 || (${var.rock_route} := ${state.close_confirm_super})

[State -1, AI_PATCH_METER_POLICY RockAI Rush Super Max Route Pick]
type = Null
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && !${var.rock_route}
triggerAll = Power >= ${state.rush_super_max:cost}
triggerAll = !${var.rock_enemy_unjuggle}
triggerAll = MoveHit || ${var.rock_hit_confirm_time} > 4 || EnemyNear,MoveType = H
trigger1 = P2BodyDist X = [-20,${state.rush_super_max:x_max}]
trigger1 = P2BodyDist Y = [${state.rush_super_max:y_min},${state.rush_super_max:y_max}]
trigger1 = Random < Ceil(320 * ${fvar.rock_ai_chance})
trigger1 = 1 || (${var.rock_route} := ${state.rush_super_max})

[State -1, AI_PATCH_METER_POLICY RockAI Rush Super Route Pick]
type = Null
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && !${var.rock_route}
triggerAll = Power >= ${state.rush_super:cost}
triggerAll = !${var.rock_enemy_unjuggle}
triggerAll = MoveHit || ${var.rock_hit_confirm_time} > 4 || EnemyNear,MoveType = H
trigger1 = P2BodyDist X = [-20,${state.rush_super:x_max}]
trigger1 = P2BodyDist Y = [${state.rush_super:y_min},${state.rush_super:y_max}]
trigger1 = Random < Ceil(280 * ${fvar.rock_ai_chance})
trigger1 = 1 || (${var.rock_route} := ${state.rush_super})

[State -1, RockAI MAX Mode Opportunist]
type = ChangeState
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && Ctrl
triggerAll = var(20) <= 0 && Power >= 1000
triggerAll = EnemyNear,StateType = L || EnemyNear,HitFall
trigger1 = P2BodyDist X >= ${range.knockdown_charge_x}
trigger1 = Random < Ceil(150 * ${fvar.rock_ai_chance})
value = ${state.max_mode}
; AI_PATCH_END: rockai_bl:rock_meter_cashout:v1
```

## Module: rock_route_executor

### Goal

Executor runs after the selectors. It changes state only when the route is valid,
control/cancel/hit-confirm conditions are met, and the target is suitable for
the current StateType. It also clears impossible point-blank actions like
DivineRockAI does.

Because this module executes `${var.rock_route}` and `${var.rock_air_route}`,
the UI must treat unresolved dynamic targets as `needs_review`. A dynamic route
becomes safe only when the selector assigned a known state alias and scanner
validation confirms target role, reach, and opponent-state compatibility.

### Target

```yaml
file: cmd
insert_after_module: rock_meter_cashout
fallback_insert_before:
  - "[State -1, AI Walk Fwd"
  - "[State -1"
risk: high
scan_requirements:
  - comboScan.states
  - comboScan.cancelEdges
  - stateActionMap
  - airReach
safe_when:
  - selected_route_resolves_to_state
  - target_role_matches_current_state_type
  - opponent_liedown_guard_passes
  - route_has_hit_confirm_or_neutral_range
review_when:
  - value_var_target_unresolved
  - selected_route_role_unknown
  - air_ground_state_mismatch
route_preview:
  - id: rock_dynamic_route_executor
    type: dynamic_route_executor
    source: divine_rock_ai_var18_executor
    chain:
      - rock_route
      - rock_air_route
      - power_charge
      - roll_back
    condition:
      - selector_route_variable_nonzero
      - ctrl_movecontact_or_hitconfirm
      - target_state_type_compatible
      - knockdown_reset_or_charge_window
    policy:
      - execute_selector_result_not_fixed_state
      - clear_projectile_route_at_point_blank
      - clear_liedown_unsafe_route
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: rockai_bl:rock_route_executor:v1
[State -1, RockAI Prevent Impossible Close Route]
type = VarSet
triggerAll = ${var.ai_enabled} && NumEnemy
triggerAll = ${var.rock_route}
triggerAll = Abs(P2BodyDist X) <= ${range.point_blank_x}
trigger1 = ${var.rock_route} = ${state.projectile_light}
trigger2 = ${var.rock_route} = ${state.ex_projectile}
trigger3 = EnemyNear,StateType = L && ${var.rock_route} != ${state.roll_back} && ${var.rock_route} != ${state.power_charge}
var(${var.rock_route:number}) = 0
ignoreHitPause = 1

[State -1, RockAI Prevent Meter Route Without Power]
type = VarSet
triggerAll = ${var.ai_enabled} && NumEnemy
triggerAll = ${var.rock_route}
trigger1 = ${var.rock_route} = ${state.level3_super} && Power < ${state.level3_super:cost}
trigger2 = ${var.rock_route} = ${state.close_confirm_super} && Power < ${state.close_confirm_super:cost}
trigger3 = ${var.rock_route} = ${state.close_super} && Power < ${state.close_super:cost}
trigger4 = ${var.rock_route} = ${state.close_super_max} && Power < ${state.close_super_max:cost}
trigger5 = ${var.rock_route} = ${state.rush_super} && Power < ${state.rush_super:cost}
trigger6 = ${var.rock_route} = ${state.rush_super_max} && Power < ${state.rush_super_max:cost}
var(${var.rock_route:number}) = 0
ignoreHitPause = 1

[State -1, RockAI Execute Ground Route]
type = ChangeState
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A
triggerAll = ${var.rock_route}
triggerAll = Ctrl || MoveContact || ${var.rock_hit_confirm_time} > 0 || StateNo = ${state.walk_forward} || StateNo = ${state.run_forward}
triggerAll = EnemyNear,StateType != L || ${var.rock_route} = ${state.power_charge} || ${var.rock_route} = ${state.roll_back}
trigger1 = 1
value = ${var.rock_route}

[State -1, RockAI Execute Air Route]
type = ChangeState
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType = A
triggerAll = ${var.rock_air_route}
triggerAll = Ctrl || StateNo = 140
trigger1 = 1
value = ${var.rock_air_route}

[State -1, RockAI Knockdown Reset Charge]
type = ChangeState
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && Ctrl
triggerAll = EnemyNear,StateType = L || EnemyNear,Anim = 5120 || EnemyNear,HitFall
triggerAll = P2BodyDist X >= ${range.knockdown_charge_x}
triggerAll = Power < PowerMax && !var(20)
trigger1 = Random < Ceil(300 * ${fvar.rock_ai_chance})
value = ${state.power_charge}

[State -1, RockAI Knockdown Space Reset]
type = ChangeState
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && Ctrl
triggerAll = EnemyNear,StateType = L || EnemyNear,Anim = 5120 || EnemyNear,HitFall
triggerAll = P2BodyDist X < ${range.knockdown_charge_x}
triggerAll = BackEdgeBodyDist > 50
trigger1 = Random < Ceil(260 * ${fvar.rock_ai_chance})
value = ${state.roll_back}
; AI_PATCH_END: rockai_bl:rock_route_executor:v1
```

## Module: anti_projectile_approach

### Goal

DivineRockAI co nhieu route nhay/roll qua projectile. Module nay tao ban tong quat: neu co projectile va con khoang cach thi roll/jump/super-jump hoac projectile punish.

### Target

```yaml
file: cmd
insert_after_module: rock_defensive_router
fallback_insert_before:
  - "[State -1, AI Roll Fwd"
  - "[State -1"
```

### Insert

```mugen-template
; AI_PATCH_BEGIN: rockai_bl:anti_projectile_approach:v1
[State -1, RockAI Projectile Flag]
type = VarSet
triggerAll = ${var.ai_enabled} && NumEnemy
trigger1 = Enemy,NumProj > 0 || EnemyNear,NumProj > 0
trigger2 = EnemyNear,HitDefAttr = SCA,NP || EnemyNear,HitDefAttr = SCA,SP || EnemyNear,HitDefAttr = SCA,HP
var(${var.rock_projectile_flag:number}) = 18
ignoreHitPause = 1

[State -1, RockAI Projectile Flag Down]
type = VarAdd
triggerAll = ${var.ai_enabled}
trigger1 = ${var.rock_projectile_flag} > 0
var(${var.rock_projectile_flag:number}) = -1
ignoreHitPause = 1

[State -1, RockAI Roll Fwd Projectile Dodge]
type = ChangeState
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && Ctrl
triggerAll = ${var.rock_projectile_flag} > 0
triggerAll = P2BodyDist X = [${range.close_x},${range.projectile_x}]
triggerAll = FrontEdgeBodyDist > 60
trigger1 = Random < Ceil(360 * ${fvar.rock_ai_chance})
value = ${state.roll_forward}

[State -1, AI_PATCH_METER_POLICY RockAI EX Projectile Counter Shot]
type = ChangeState
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && Ctrl
triggerAll = Power >= ${state.ex_projectile:cost}
triggerAll = ${var.rock_projectile_flag} > 0
triggerAll = P2BodyDist X = [-20,${state.ex_projectile:x_max}]
triggerAll = P2BodyDist Y = [${state.ex_projectile:y_min},${state.ex_projectile:y_max}]
triggerAll = !NumHelper
trigger1 = Random < Ceil(180 * ${fvar.rock_ai_chance})
value = ${state.ex_projectile}

[State -1, RockAI Projectile Counter Shot]
type = ChangeState
triggerAll = ${var.ai_enabled} && NumEnemy && RoundState = 2
triggerAll = StateType != A && Ctrl
triggerAll = ${var.rock_projectile_flag} > 0
triggerAll = P2BodyDist X = [${range.projectile_special_min_x},${range.projectile_special_max_x}]
triggerAll = !NumHelper
trigger1 = Random < Ceil(200 * ${fvar.rock_ai_chance})
value = ${state.projectile_light}
; AI_PATCH_END: rockai_bl:anti_projectile_approach:v1
```

## Module: air_action_review

### Goal

Danh dau cac state/action can review khi AI route goi state co nguy co whiff do hitbox/action id khong khop.

### Target

```yaml
file: air
mode: review_only
requires_manual:
  - state_to_action_map
  - selected_action_id
  - chosen_box_delta
```

### AIR Review Candidates

```yaml
air_review:
  - state_alias: anti_air_special
    intent: anti_air_align
    checks:
      - clsn1_reaches_airborne_target
      - startup_frames_match_ai_y_window

  - state_alias: ex_anti_air
    intent: anti_air_align
    checks:
      - clsn1_reaches_airborne_target
      - no_ground_whiff_when_called_as_reversal

  - state_alias: air_strong
    intent: air_combo_align
    checks:
      - clsn1_exists
      - air_combo_x_y_window_matches_action

  - state_alias: projectile_light
    intent: projectile_spacing
    checks:
      - helper_or_projectile_spawn_frame
      - safe_min_distance
```

## Module Dependencies

```yaml
dependencies:
  adaptive_guard_memory:
    requires:
      - rock_measurement_core

  rock_defensive_router:
    requires:
      - rock_measurement_core
      - adaptive_guard_memory

  rock_combo_meter_bridge:
    requires:
      - rock_measurement_core
      - rock_defensive_router

  rock_ground_route_selector:
    requires:
      - rock_measurement_core
      - rock_defensive_router

  rock_air_route_selector:
    requires:
      - rock_measurement_core

  rock_meter_cashout:
    requires:
      - rock_combo_meter_bridge
      - rock_ground_route_selector

  rock_route_executor:
    requires:
      - rock_combo_meter_bridge
      - rock_ground_route_selector
      - rock_air_route_selector
      - rock_meter_cashout

  anti_projectile_approach:
    requires:
      - rock_measurement_core
      - rock_defensive_router

  air_action_review:
    requires:
      - rock_ground_route_selector
      - rock_air_route_selector
```

## Scanner Notes

If the scanner cannot find a state alias:

- `parry_stand/parry_crouch/parry_air`: skip the parry part in `rock_defensive_router`, but keep guard/roll logic.
- Compatible parry states must be resolved from real StateDefs. Common mappings are `6080/6081/6082`, `1300/1310/1320`, then `760/761/762`; never inject a parry state number that is not present.
- MAX/custom mode must also resolve from real StateDefs. Common mappings are `770`, `900`, then `905`; skip MAX mode routing if none exists.
- `roll_forward/roll_back`: replace with run/backdash when the character has no roll.
- `power_charge`: skip `RockAI Knockdown Reset Charge`, keep `RockAI Knockdown Space Reset`.
- `projectile_light/ex_projectile`: skip projectile counter shot if no projectile state or helper spawn exists.
- `close_confirm_super/rush_super/rush_super_max`: generic hit-confirm cashout aliases. Do not map them to install, self_buff, grab, or unsafe_raw meter states.
- `close_super/close_super_max`: DivineRockAI source scan marks these as install/setup, so use only as safe setup unless target scanner classifies them as reliable attack states.
- `level3_super`: DivineRockAI source scan marks this as grab/custom-target style. Use only for point-blank grounded punish unless target scanner confirms a close_confirm equivalent.
- `.air`: if the scanner has no state-to-action map, report review only; do not auto-edit Clsn.
- `comboScan.routeCandidates`: prefer numeric `MoveHit`/`MoveContact` routes as safe graph edges.
- `value = var(...)`: keep executor routes in `needs_review` unless the UI resolves the variable route to a known state alias.
- `airReach`: missing Clsn1 reach means air routes and anti-air routes stay `needs_review`.

## Report Fields

```json
{
  "brain": "rockai_bl",
  "modulesApplied": [],
  "modulesSkipped": [],
  "conflicts": [],
  "rangeDerivations": [],
  "airReview": []
}
```
