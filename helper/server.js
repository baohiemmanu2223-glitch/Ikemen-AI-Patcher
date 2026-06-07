import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import iconv from "iconv-lite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(process.env.AI_PATCHER_ROOT_DIR || path.resolve(__dirname, ".."));
const dataDir = path.resolve(process.env.AI_PATCHER_DATA_DIR || rootDir);
const workspaceDir = path.resolve(process.env.AI_PATCHER_WORKSPACE_DIR || path.resolve(rootDir, ".."));

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(rootDir, "public")));

const textExts = new Set([".cmd", ".cns", ".st", ".air", ".def"]);

function normalizeSlashes(value) {
  return String(value || "").replace(/\\/g, "/");
}

function stripInlineComment(line) {
  const index = line.indexOf(";");
  return index >= 0 ? line.slice(0, index) : line;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readText(filePath) {
  return (await readTextWithEncoding(filePath)).text;
}

function countReplacementChars(text) {
  return (String(text || "").match(/\uFFFD/g) || []).length;
}

function decodeBuffer(buffer, encoding) {
  return encoding === "utf8" ? buffer.toString("utf8") : iconv.decode(buffer, encoding);
}

function detectTextEncodingFromBuffer(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) return "utf8";
  const utf8 = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const utf8Replacements = countReplacementChars(utf8);
  if (!utf8Replacements) return "utf8";

  const candidates = ["cp932", "shift_jis"];
  let best = { encoding: "utf8", text: utf8, replacements: utf8Replacements };
  for (const encoding of candidates) {
    const text = iconv.decode(buffer, encoding);
    const replacements = countReplacementChars(text);
    if (replacements < best.replacements) best = { encoding, text, replacements };
  }
  return best.encoding;
}

async function readTextWithEncoding(filePath) {
  const buffer = await fs.readFile(filePath);
  const encoding = detectTextEncodingFromBuffer(buffer);
  return {
    text: decodeBuffer(buffer, encoding).replace(/^\uFEFF/, ""),
    encoding,
    hadBom: buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF,
  };
}

async function writeTextPreservingEncoding(filePath, text, fallbackEncoding = null) {
  const meta = fallbackEncoding ? { encoding: fallbackEncoding, hadBom: false } : await readTextWithEncoding(filePath);
  const encoding = meta.encoding || "utf8";
  if (encoding === "utf8") {
    const bom = meta.hadBom ? "\uFEFF" : "";
    await fs.writeFile(filePath, bom + text, "utf8");
    return { encoding };
  }
  await fs.writeFile(filePath, iconv.encode(text, encoding));
  return { encoding };
}

async function listFilesRecursive(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listFilesRecursive(fullPath));
    } else {
      out.push(fullPath);
    }
  }
  return out;
}

function parseDef(text) {
  const result = { info: {}, files: {} };
  let section = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripInlineComment(rawLine).trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]/);
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase();
      continue;
    }
    const kv = line.match(/^([^=]+?)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase();
    const value = kv[2].trim().replace(/^"|"$/g, "");
    if (section === "info") result.info[key] = value;
    if (section === "files") result.files[key] = value;
  }
  return result;
}

function collectNumberSet(regex, text) {
  const values = new Set();
  for (const match of text.matchAll(regex)) values.add(Number(match[1]));
  return [...values].sort((a, b) => a - b);
}

function textWithoutCommentLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trimStart().startsWith(";") ? "" : stripInlineComment(line))
    .join("\n");
}

function classifyVariableSlots(text, kind, maxNumber) {
  const refRegex = kind === "fvar" ? /\bfvar\((\d+)\)/gi : /\bvar\((\d+)\)/gi;
  const documented = collectNumberSet(refRegex, text);
  const active = collectNumberSet(refRegex, textWithoutCommentLines(text));
  const activeSet = new Set(active);
  const documentedOnly = documented.filter((num) => !activeSet.has(num));
  const free = [];
  const softFree = [];
  for (let i = 0; i <= maxNumber; i += 1) {
    if (!documented.includes(i)) free.push(i);
    if (!activeSet.has(i)) softFree.push(i);
  }
  return {
    used: documented,
    usedActive: active,
    documentedOnly,
    free,
    softFree,
  };
}

function parseVarComments(text, kind) {
  const pattern = kind === "fvar"
    ? /;\s*fvar\((\d+)\)\s*-\s*(.+)$/gim
    : /;\s*Var\((\d+)\)\s*-\s*(.+)$/gim;
  const comments = {};
  for (const match of text.matchAll(pattern)) comments[match[1]] = match[2].trim();
  const patchPattern = kind === "fvar"
    ? /;\s*AI_PATCH_FVAR\s+([A-Za-z0-9_]+)\s*=\s*fvar\((\d+)\)/gim
    : /;\s*AI_PATCH_VAR\s+([A-Za-z0-9_]+)\s*=\s*var\((\d+)\)/gim;
  for (const match of text.matchAll(patchPattern)) comments[match[2]] = `AI_PATCH_${kind.toUpperCase()} ${match[1].trim()}`;
  return comments;
}

function parsePatchMappings(text, kind) {
  const pattern = kind === "fvar"
    ? /;\s*AI_PATCH_FVAR\s+([A-Za-z0-9_]+)\s*=\s*fvar\((\d+)\)/gim
    : /;\s*AI_PATCH_VAR\s+([A-Za-z0-9_]+)\s*=\s*var\((\d+)\)/gim;
  const mappings = {};
  for (const match of text.matchAll(pattern)) mappings[match[1].trim()] = Number(match[2]);
  return mappings;
}

function parseStates(text) {
  const states = new Set();
  for (const match of text.matchAll(/\[\s*StateDef\s+(-?\d+)\s*\]/gi)) {
    states.add(Number(match[1]));
  }
  return [...states].sort((a, b) => a - b);
}

function parseStateTraits(texts, airActions = {}) {
  const traits = {};
  const stateRegex = /\[\s*StateDef\s+(-?\d+)\s*\]([\s\S]*?)(?=\n\s*\[\s*StateDef\s+-?\d+\s*\]|\s*$)/gi;
  const bodyByState = new Map();
  const helperSpawnTargets = new Set();
  const customTargetStates = new Set();
  for (const item of texts) {
    for (const match of item.text.matchAll(stateRegex)) {
      bodyByState.set(Number(match[1]), match[2]);
    }
  }
  for (const item of texts) {
    for (const match of item.text.matchAll(stateRegex)) {
      const controllers = parseControllers(match[2]);
      for (const controller of controllers) {
        if (/^Helper$/i.test(controller.type)) {
          const helperState = firstNumber(controller.params?.stateno);
          if (helperState !== null && helperState !== undefined) helperSpawnTargets.add(Number(helperState));
        }
        if (/^TargetState$/i.test(controller.type)) {
          for (const target of expressionStateTargets(controller.params?.value || "")) customTargetStates.add(Number(target));
        }
        for (const target of expressionStateTargets(controller.params?.p2stateno || "")) customTargetStates.add(Number(target));
      }
    }
  }
  for (const item of texts) {
    for (const match of item.text.matchAll(stateRegex)) {
      const state = Number(match[1]);
      const body = match[2];
      const controllers = parseControllers(body);
      const hasRootRedirect = /\bRoot\s*,/i.test(body);
      const hasParentRedirect = /\bParent\s*,/i.test(body);
      const hasDestroySelf = controllers.some((controller) => /^DestroySelf$/i.test(controller.type));
      const hasParentVarSet = controllers.some((controller) => /^ParentVarSet$/i.test(controller.type));
      const hasTargetState = controllers.some((controller) => /^TargetState$/i.test(controller.type));
      const hasP2StateNo = controllers.some((controller) => Object.prototype.hasOwnProperty.call(controller.params || {}, "p2stateno"));
      const hasHitDef = controllers.some((controller) => /^HitDef$/i.test(controller.type));
      const hasPlayerExit = controllers.some((controller) => /^ChangeState$/i.test(controller.type) && /\bvalue\s*=\s*0\b/i.test(controller.body || ""));
      const statedefPowerAdd = body.match(/^\s*poweradd\s*=\s*([^\r\n;]+)/im)?.[1] || "";
      const controllerPowerAdds = controllers
        .filter((controller) => /^PowerAdd$/i.test(controller.type))
        .map((controller) => controller.params?.value || "")
        .filter(Boolean);
      const powerGainSignals = [statedefPowerAdd, ...controllerPowerAdds]
        .filter(isLikelyPositivePowerExpression);
      const sourceFile = path.relative(workspaceDir, item.file);
      const helperFile = /helper/i.test(path.basename(item.file));
      const spawnedAsHelper = helperSpawnTargets.has(state);
      const usedAsCustomTarget = customTargetStates.has(state);
      const helperStates = controllers
        .filter((controller) => /^Helper$/i.test(controller.type))
        .map((controller) => firstNumber(controller.params?.stateno))
        .filter((value) => value !== null && value !== undefined);
      const hasRootAnimElemHelper = helperStates.some((helperState) => {
        const helperBody = bodyByState.get(Number(helperState)) || "";
        return /\bRoot\s*,\s*AnimElem/i.test(helperBody);
      });
      const actionRefs = [
        ...[...body.matchAll(/^\s*anim\s*=\s*(-?\d+)/gim)].map((item) => Number(item[1])),
        ...controllers
          .filter((controller) => /^ChangeAnim$/i.test(controller.type))
          .flatMap((controller) => expressionStateTargets(controller.params?.value || "")),
      ].filter((value) => Number.isFinite(value) && value >= 0);
      const missingActions = uniqueValues(actionRefs.filter((action) => !airActions[action]));
      const visualMissingActions = [];
      for (const [helperState, helperBody] of bodyByState.entries()) {
        const rootAnimMatch = helperBody.match(new RegExp(`root\\s*,\\s*anim\\s*=\\s*${state}\\b`, "i"));
        const valueExpr = helperBody.match(/^\s*value\s*=\s*root\s*,\s*anim\s*\+\s*(\d+)/im);
        if (rootAnimMatch && valueExpr) {
          const helperAnim = state + Number(valueExpr[1]) - 10000;
          if (!airActions[helperAnim]) visualMissingActions.push(helperAnim);
        }
        if (helperState === state + 20000 && !airActions[state + 10000]) visualMissingActions.push(state + 10000);
      }
      const comboUnsafeReasons = [
        hasTargetState ? "TargetState controller" : "",
        hasP2StateNo ? "HitDef p2stateno custom state" : "",
        hasRootAnimElemHelper ? "helper follows Root AnimElem" : "",
        missingActions.length ? `missing AIR action ${missingActions.slice(0, 5).join("/")}` : "",
        visualMissingActions.length ? `visual helper missing AIR action ${uniqueValues(visualMissingActions).slice(0, 5).join("/")}` : "",
      ].filter(Boolean);
      let executionRole = "root_attack";
      let executionRoleReason = "root/player state";
      if (hasDestroySelf) {
        executionRole = "helper_destroy";
        executionRoleReason = "state destroys itself; helper/internal cleanup state";
      } else if (usedAsCustomTarget && !hasHitDef && !hasPlayerExit) {
        executionRole = "target_custom";
        executionRoleReason = "state is used as TargetState/p2stateno custom target";
      } else if (spawnedAsHelper || helperFile) {
        executionRole = hasHitDef ? "helper_projectile" : "visual_fx";
        executionRoleReason = spawnedAsHelper
          ? "state is spawned by Helper controller"
          : "state is declared in helper file";
      }
      traits[state] = {
        state,
        hasRootRedirect,
        hasParentRedirect,
        hasDestroySelf,
        hasParentVarSet,
        hasTargetState,
        hasP2StateNo,
        hasHitDef,
        spawnedAsHelper,
        usedAsCustomTarget,
        executionRole,
        executionRoleReason,
        directChangeSafe: executionRole === "root_attack",
        hasRootAnimElemHelper,
        missingActions,
        visualMissingActions: uniqueValues(visualMissingActions),
        comboUnsafe: comboUnsafeReasons.length > 0,
        comboUnsafeReason: comboUnsafeReasons.join(", "),
        helperOnly: hasRootRedirect || hasParentRedirect || hasDestroySelf || hasParentVarSet,
        powerGain: powerGainSignals.length > 0,
        powerGainSignals: uniqueValues(powerGainSignals).slice(0, 6),
        source: sourceFile,
      };
    }
  }
  return traits;
}

function parseCommands(text) {
  const commands = new Set();
  const commandRegex = /\[\s*Command\s*\]([\s\S]*?)(?=\r?\n\s*\[[^\]]+\]|$)/gi;
  for (const match of text.matchAll(commandRegex)) {
    const name = match[1].match(/^\s*name\s*=\s*"?([^"\r\n;]+)"?/im);
    if (name) commands.add(name[1].trim());
  }
  return [...commands].sort((a, b) => a.localeCompare(b));
}

function removeAiPatchBlocks(text) {
  return String(text || "").replace(/^.*AI_PATCH_BEGIN:[\s\S]*?^.*AI_PATCH_END:.*(?:\r?\n)?/gim, "");
}

function parseCommandDefinitions(text) {
  const definitions = [];
  const commandRegex = /\[\s*Command\s*\]([\s\S]*?)(?=\r?\n\s*\[[^\]]+\]|$)/gi;
  for (const match of String(text || "").matchAll(commandRegex)) {
    const body = match[1];
    const name = body.match(/^\s*name\s*=\s*"?([^"\r\n;]+)"?/im);
    const command = body.match(/^\s*command\s*=\s*([^\r\n;]+)/im);
    const time = body.match(/^\s*time\s*=\s*(\d+)/im);
    if (!name) continue;
    definitions.push({
      name: name[1].trim(),
      input: command ? command[1].trim() : "",
      time: time ? Number(time[1]) : null,
    });
  }
  return definitions;
}

function commandNamesFromTrigger(triggerText) {
  const names = [];
  for (const match of String(triggerText || "").matchAll(/\bcommand\s*=\s*"([^"]+)"/gi)) {
    names.push(match[1].trim());
  }
  return uniqueValues(names);
}

function parseCmdMoveEntries(commandText) {
  const cleanText = removeAiPatchBlocks(commandText);
  const commandDefs = parseCommandDefinitions(cleanText);
  const defsByName = new Map();
  for (const def of commandDefs) {
    if (!defsByName.has(def.name)) defsByName.set(def.name, []);
    defsByName.get(def.name).push(def);
  }
  const entries = [];
  const controllers = parseControllers(cleanText).filter((controller) => /^ChangeState$/i.test(controller.type));
  for (const controller of controllers) {
    const triggerText = controllerTriggerText(controller);
    const commandNames = commandNamesFromTrigger(triggerText);
    const targets = expressionStateTargets(controller.params?.value || "");
    if (!commandNames.length || !targets.length) continue;
    const gate = {
      ctrl: /\bctrl\b/i.test(triggerText),
      moveHit: /\bMoveHit\b/i.test(triggerText),
      moveContact: /\bMoveContact\b/i.test(triggerText),
      moveGuarded: /\bMoveGuarded\b/i.test(triggerText),
      power: [...triggerText.matchAll(/\bPower\s*>=\s*(\d+)/gi)].map((match) => Number(match[1])),
      stateRefs: parseStateNoRefs(triggerText),
    };
    for (const commandName of commandNames) {
      for (const state of targets) {
        entries.push({
          commandName,
          state,
          definitions: defsByName.get(commandName) || [],
          controller: controller.heading.replace(/^\[|\]$/g, ""),
          trigger: triggerText,
          gate,
        });
      }
    }
  }
  return { commandDefs, entries };
}

const builtInCommands = new Set([
  "holdfwd",
  "holdback",
  "holdup",
  "holddown",
  "holdx",
  "holdy",
  "holdz",
  "holda",
  "holdb",
  "holdc",
  "holds",
  "recovery",
]);

function isBuiltInCommand(name) {
  return builtInCommands.has(String(name || "").toLowerCase());
}

function classifyPowerCost(cost) {
  if (!cost) return null;
  if (cost <= 500) return "500";
  if (cost <= 1000) return "1000";
  if (cost <= 2000) return "2000";
  if (cost <= 3000) return "3000";
  return "3000+";
}

function parseStatePowerCosts(text) {
  const costs = {};
  const stateRegex = /\[\s*StateDef\s+(-?\d+)\s*\]([\s\S]*?)(?=\n\s*\[\s*StateDef\s+-?\d+\s*\]|\s*$)/gi;
  for (const match of text.matchAll(stateRegex)) {
    const state = Number(match[1]);
    const body = match[2];
    const found = [];

    for (const statePowerAdd of body.matchAll(/^\s*poweradd\s*=\s*([^\r\n;]+)/gim)) {
      const value = negativePowerCostFromExpression(statePowerAdd[1]);
      if (value > 0) found.push(value);
    }

    for (const powerAdd of body.matchAll(/^\s*type\s*=\s*PowerAdd\b[\s\S]{0,220}?^\s*value\s*=\s*([^\r\n;]+)/gim)) {
      const value = negativePowerCostFromExpression(powerAdd[1]);
      if (value > 0) found.push(value);
    }

    for (const powerExpr of body.matchAll(/\bPower\s*(?:=|:=)\s*Power\s*-\s*([^\r\n;]+)/gi)) {
      const value = maxPositiveNumericLiteral(powerExpr[1]);
      if (value > 0) found.push(value);
    }

    for (const gate of powerGateValuesFromText(body)) {
      if (gate >= 500 && state >= 2000) found.push(gate);
    }

    if (found.length) {
      const cost = Math.max(...found.filter((value) => value > 0));
      costs[state] = {
        cost,
        bucket: classifyPowerCost(cost),
        source: "parsed_power",
      };
    }
  }
  return costs;
}

function parseStateActionMap(texts) {
  const map = {};
  const stateRegex = /\[\s*StateDef\s+(-?\d+)\s*\]([\s\S]*?)(?=\n\s*\[\s*StateDef\s+-?\d+\s*\]|\s*$)/gi;
  for (const item of texts) {
    for (const match of item.text.matchAll(stateRegex)) {
      const state = Number(match[1]);
      const body = match[2];
      const stateInfo = map[state] || { state, actions: [], sources: [] };

      const anim = body.match(/^\s*anim\s*=\s*(-?\d+)/im);
      if (anim) {
        const action = Number(anim[1]);
        if (!stateInfo.actions.some((entry) => entry.action === action && entry.kind === "statedef_anim")) {
          stateInfo.actions.push({ action, kind: "statedef_anim" });
        }
      }

      for (const change of body.matchAll(/^\s*(?:value|anim)\s*=\s*(-?\d+)/gim)) {
        const before = body.slice(Math.max(0, change.index - 160), change.index);
        if (!/\bChangeAnim2?\b/i.test(before)) continue;
        const action = Number(change[1]);
        if (!stateInfo.actions.some((entry) => entry.action === action && entry.kind === "change_anim")) {
          stateInfo.actions.push({ action, kind: "change_anim" });
        }
      }

      if (stateInfo.actions.length) {
        stateInfo.sources.push(path.relative(workspaceDir, item.file));
        map[state] = stateInfo;
      }
    }
  }
  return map;
}

function firstNumber(value) {
  const match = String(value ?? "").match(/-?\d+/);
  return match ? Number(match[0]) : null;
}

function positiveNumericLiterals(expression) {
  return (String(expression || "").match(/-?\d+(?:\.\d+)?/g) || [])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
}

function maxPositiveNumericLiteral(expression) {
  const values = positiveNumericLiterals(expression);
  return values.length ? Math.max(...values) : null;
}

function negativePowerCostFromExpression(expression) {
  const expr = stripInlineComment(String(expression || "")).trim();
  if (!expr || !/^\s*-/.test(expr)) return null;
  return maxPositiveNumericLiteral(expr);
}

function powerGateValuesFromText(text) {
  return [...String(text || "").matchAll(/^\s*trigger(?:all|\d+)?\s*=\s*.*?\bPower\s*>=\s*([^\r\n;]+)/gim)]
    .map((match) => maxPositiveNumericLiteral(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function parseControllerParams(body) {
  const params = {};
  for (const line of String(body || "").split(/\r?\n/)) {
    const cleaned = stripInlineComment(line).trim();
    const kv = cleaned.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    params[kv[1].toLowerCase()] = kv[2].trim();
  }
  return params;
}

function parseControllers(stateBody) {
  const controllers = [];
  const text = String(stateBody || "");
  const headings = [...text.matchAll(/^\s*\[State[^\]]*\]\s*$/gim)].map((match) => ({
    index: match.index,
    end: match.index + match[0].length,
    heading: match[0].trim(),
  }));
  for (let i = 0; i < headings.length; i += 1) {
    const body = text.slice(headings[i].end, headings[i + 1]?.index ?? text.length);
    const params = parseControllerParams(body);
    if (params.type) controllers.push({ type: params.type, params, body, heading: headings[i].heading });
  }
  return controllers;
}

function parseControllerBlocksWithOffsets(text) {
  const source = String(text || "");
  const headings = [...source.matchAll(/^\s*\[State[^\]]*\]\s*$/gim)].map((match) => ({
    index: match.index,
    end: match.index + match[0].length,
    heading: match[0].trim(),
  }));
  const controllers = [];
  for (let i = 0; i < headings.length; i += 1) {
    const start = headings[i].index;
    const bodyStart = headings[i].end;
    const end = headings[i + 1]?.index ?? source.length;
    const body = source.slice(bodyStart, end);
    const params = parseControllerParams(body);
    if (!params.type) continue;
    controllers.push({
      type: params.type,
      params,
      body,
      heading: headings[i].heading,
      start,
      end,
      line: lineNumberAt(source, start),
    });
  }
  return controllers;
}

function controllerTriggerText(controller) {
  const values = [];
  for (const line of String(controller?.body || "").split(/\r?\n/)) {
    const cleaned = stripInlineComment(line).trim();
    const kv = cleaned.match(/^(trigger[A-Za-z0-9_.-]*)\s*=\s*(.+)$/i);
    if (kv) values.push(kv[2].trim());
  }
  if (values.length) return values.join(" && ");
  return Object.entries(controller?.params || {})
    .filter(([key]) => /^trigger/i.test(key))
    .map(([, value]) => value)
    .join(" && ");
}

function controllerTriggerGroups(controller) {
  const all = [];
  const groups = new Map();
  for (const line of String(controller?.body || "").split(/\r?\n/)) {
    const cleaned = stripInlineComment(line).trim();
    const kv = cleaned.match(/^(trigger(?:all|\d+)[A-Za-z0-9_.-]*)\s*=\s*(.+)$/i);
    if (!kv) continue;
    const key = kv[1].toLowerCase().startsWith("triggerall") ? "all" : kv[1].toLowerCase().match(/^trigger\d+/)?.[0] || kv[1].toLowerCase();
    if (key === "all") all.push(kv[2].trim());
    else {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(kv[2].trim());
    }
  }
  if (!groups.size) return all.length ? [all.join(" && ")] : [];
  return [...groups.values()].map((parts) => [...all, ...parts].join(" && "));
}

function expandStateRefsToStates(refs, knownStates = [], maxRange = 80) {
  const available = new Set((knownStates || []).map(Number).filter(Number.isFinite));
  const states = [];
  for (const ref of refs || []) {
    if (ref.kind === "state") {
      states.push(Number(ref.state));
      continue;
    }
    const min = Number(ref.min);
    const max = Number(ref.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
    if (available.size) {
      for (const state of available) {
        if (state >= Math.min(min, max) && state <= Math.max(min, max)) states.push(state);
      }
    } else if (Math.abs(max - min) <= maxRange) {
      for (let state = Math.min(min, max); state <= Math.max(min, max); state += 1) states.push(state);
    }
  }
  return uniqueValues(states.filter((state) => Number.isFinite(state) && Math.abs(state) >= 100)).sort((a, b) => a - b);
}

function parseVarWriteRefs(controller) {
  const refs = [];
  const type = String(controller?.type || "");
  if (!/^(VarSet|VarAdd|VarRandom|ParentVarSet)$/i.test(type)) return refs;
  const kind = /^ParentVarSet$/i.test(type) ? "var" : String(controller?.params?.v || "").toLowerCase().startsWith("f") ? "fvar" : "var";
  const number = firstNumber(controller?.params?.v);
  const value = controller?.params?.value || "";
  if (Number.isFinite(number)) refs.push({ kind, number, value, type });
  for (const line of String(controller?.body || "").split(/\r?\n/)) {
    const cleaned = stripInlineComment(line).trim();
    const match = cleaned.match(/^(f?var)\s*\(\s*(\d+)\s*\)\s*=\s*(.+)$/i);
    if (!match) continue;
    refs.push({
      kind: match[1].toLowerCase() === "fvar" ? "fvar" : "var",
      number: Number(match[2]),
      value: match[3].trim(),
      type,
    });
  }
  return refs.filter((ref, index, all) =>
    index === all.findIndex((item) => item.kind === ref.kind && item.number === ref.number && item.value === ref.value));
}

function varRefsInText(text) {
  const refs = [];
  for (const match of String(text || "").matchAll(/\b(f?var)\s*\(\s*(\d+)\s*\)/gi)) {
    refs.push({
      kind: match[1].toLowerCase() === "fvar" ? "fvar" : "var",
      number: Number(match[2]),
    });
  }
  return refs.filter((ref, index, all) =>
    index === all.findIndex((item) => item.kind === ref.kind && item.number === ref.number));
}

function hitDefTriggerTimes(triggerText) {
  const text = String(triggerText || "");
  const times = [];
  for (const match of text.matchAll(/\bTime\s*=\s*(-?\d+)\b/gi)) times.push(Number(match[1]));
  for (const match of text.matchAll(/\bTime\s*<=\s*(-?\d+)\b/gi)) times.push(Number(match[1]));
  for (const match of text.matchAll(/\bTime\s*<\s*(-?\d+)\b/gi)) times.push(Number(match[1]) - 1);
  for (const match of text.matchAll(/\bTime\s*>=\s*(-?\d+)\b/gi)) times.push(Number(match[1]));
  for (const match of text.matchAll(/\bTime\s*>\s*(-?\d+)\b/gi)) times.push(Number(match[1]) + 1);
  return uniqueValues(times.filter((value) => Number.isFinite(value) && value >= 0)).sort((a, b) => a - b);
}

function parseHitDefController(controller) {
  const p = controller.params;
  const triggerText = controllerTriggerText(controller);
  const hitElems = uniqueValues([
    ...[...triggerText.matchAll(/\bAnimElem\s*=?\s*(-?\d+)/gi)].map((match) => Number(match[1])),
    ...[...triggerText.matchAll(/\banimelem\s*=\s*(-?\d+)/gi)].map((match) => Number(match[1])),
  ].filter((value) => Number.isFinite(value) && value > 0));
  return {
    attr: p.attr || "",
    hitflag: p.hitflag || "",
    guardflag: p.guardflag || "",
    damage: p.damage || "",
    numhits: firstNumber(p.numhits),
    pausetime: p.pausetime || "",
    groundType: p["ground.type"] || "",
    airType: p["air.type"] || "",
    groundVelocity: p["ground.velocity"] || "",
    airVelocity: p["air.velocity"] || "",
    groundHittime: firstNumber(p["ground.hittime"]),
    airHittime: firstNumber(p["air.hittime"]),
    guardHittime: firstNumber(p["guard.hittime"]),
    fall: /\b1\b/.test(String(p.fall || "")),
    fallRecover: p["fall.recover"] || "",
    juggle: firstNumber(p.juggle),
    priority: p.priority || "",
    p1statenoRaw: p.p1stateno || "",
    p2statenoRaw: p.p2stateno || "",
    p1stateno: firstNumber(p.p1stateno),
    p2stateno: firstNumber(p.p2stateno),
    triggerText,
      hitElems,
      triggerTimes: hitDefTriggerTimes(triggerText),
    };
}

function parseCancelController(controller) {
  const p = controller.params;
  const triggerText = controllerTriggerText(controller);
  const value = p.value || "";
  return {
    target: firstNumber(value),
    targetExpr: value,
    triggers: triggerText,
    moveHit: /\bMoveHit\b/i.test(triggerText),
    moveContact: /\bMoveContact\b/i.test(triggerText),
    moveGuarded: /\bMoveGuarded\b/i.test(triggerText),
    ctrl: /\bctrl\b/i.test(triggerText),
    powerGate: powerGateValuesFromText(triggerText),
    animElem: [...triggerText.matchAll(/\bAnimElem\s*=?\s*(-?\d+)/gi)].map((match) => Number(match[1])),
  };
}

function statedefAnimFromBody(body) {
  const match = String(body || "").match(/^\s*anim\s*=\s*(-?\d+)\b/im);
  return match ? Number(match[1]) : null;
}

function controllerNumberParam(controller, key) {
  const value = String(controller?.params?.[key] ?? "");
  const number = firstNumber(value);
  return Number.isFinite(number) ? number : null;
}

function inferStateMovement(controllers) {
  const velSets = (controllers || []).filter((controller) => /^VelSet$/i.test(controller.type));
  const xValues = velSets.map((controller) => controllerNumberParam(controller, "x")).filter(Number.isFinite);
  const yValues = velSets.map((controller) => controllerNumberParam(controller, "y")).filter(Number.isFinite);
  const stateTypeSets = (controllers || []).filter((controller) => /^StateTypeSet$/i.test(controller.type));
  const hasAirTypeSet = stateTypeSets.some((controller) => /\bA\b/i.test(String(controller.params?.statetype || "")));
  const maxPositiveX = xValues.length ? Math.max(0, ...xValues.filter((value) => value > 0)) : 0;
  const minY = yValues.length ? Math.min(...yValues) : 0;
  return {
    hasVelSet: velSets.length > 0,
    hasAirTypeSet,
    maxPositiveX,
    minY,
    risingDiagonal: maxPositiveX >= 5 && minY <= -5,
  };
}

function chargeShimSafeController(controller) {
  const type = String(controller?.type || "");
  return /^(PlaySnd|Explod|RemoveExplod|StopSnd|EnvShake|PalFX)$/i.test(type);
}

function compactControllerForReuse(controller) {
  if (!chargeShimSafeController(controller)) return null;
  return {
    type: String(controller.type || ""),
    heading: String(controller.heading || "[State AI Patch Reused Charge Controller]"),
    body: String(controller.body || "").trim(),
  };
}

function splitTopLevelArgs(text) {
  const args = [];
  let depth = 0;
  let start = 0;
  const source = String(text || "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  args.push(source.slice(start).trim());
  return args.filter(Boolean);
}

function expressionStateTargets(expression) {
  const raw = String(expression || "").trim();
  if (!raw) return [];
  const ifElse = raw.match(/^IfElse\s*\(([\s\S]*)\)$/i);
  if (ifElse) {
    const args = splitTopLevelArgs(ifElse[1]);
    if (args.length >= 3) {
      return uniqueValues([
        ...expressionStateTargets(args[1]),
        ...expressionStateTargets(args[2]),
      ]).map(Number);
    }
  }
  const exactNumber = raw.match(/^-?\d+$/);
  if (exactNumber) return Math.abs(Number(exactNumber[0])) >= 100 ? [Number(exactNumber[0])] : [];
  return uniqueValues([...raw.matchAll(/\b-?\d+\b/g)]
    .map((item) => Number(item[0]))
    .filter((value) => Math.abs(value) >= 100));
}

function parseStateNoRefs(triggerText) {
  const refs = [];
  const text = String(triggerText || "");
  for (const match of text.matchAll(/\bStateNo\s*=\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/gi)) {
    refs.push({ kind: "range", min: Number(match[1]), max: Number(match[2]), text: match[0] });
  }
  for (const match of text.matchAll(/\bStateNo\s*=\s*(-?\d+)/gi)) {
    refs.push({ kind: "state", state: Number(match[1]), text: match[0] });
  }
  return refs;
}

function isLikelyPositivePowerExpression(expression) {
  const expr = String(expression || "").trim();
  if (!expr || /^0(?:\.0+)?$/i.test(expr)) return false;
  const numbers = expr.match(/-?\d+(?:\.\d+)?/g)?.map(Number).filter(Number.isFinite) || [];
  if (!numbers.length) return false;
  if (/^\s*-/.test(expr)) return false;
  return numbers.some((value) => value > 0);
}

function refMatchesState(ref, state) {
  if (!ref) return false;
  if (ref.kind === "state") return ref.state === state;
  return state >= ref.min && state <= ref.max;
}

function parseCancelFlagSources(texts, knownStates = []) {
  const flags = [];
  const seen = new Set();
  const stateRegex = /\[\s*StateDef\s+(-?\d+)\s*\]([\s\S]*?)(?=\n\s*\[\s*StateDef\s+-?\d+\s*\]|\s*$)/gi;
  for (const item of texts || []) {
    const sourceFile = path.relative(workspaceDir, item.file);
    for (const stateMatch of String(item.text || "").matchAll(stateRegex)) {
      const ownerState = Number(stateMatch[1]);
      const body = stateMatch[2] || "";
      const bodyOffset = stateMatch.index + stateMatch[0].indexOf(body);
      for (const controller of parseControllers(body)) {
        const writes = parseVarWriteRefs(controller)
          .filter((ref) => ref.kind === "var" && /\b1\b/.test(String(ref.value || "")) && !/^\s*0\s*$/.test(String(ref.value || "")));
        if (!writes.length) continue;
        const line = lineNumberAt(item.text, bodyOffset + body.indexOf(controller.body));
        for (const triggerText of controllerTriggerGroups(controller)) {
          if (!/\bMoveHit\b|\bMoveContact\b/i.test(triggerText)) continue;
          const refs = parseStateNoRefs(triggerText);
          if (!refs.length) continue;
          const sources = expandStateRefsToStates(refs, knownStates);
          if (!sources.length) continue;
          const confidence = /\bMoveHit\b/i.test(triggerText) ? "high" : "medium";
          for (const write of writes) {
            const key = `${write.kind}:${write.number}:${sources.join(",")}:${sourceFile}:${line}:${normalizedControllerTriggerKey(triggerText)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            flags.push({
              kind: write.kind,
              number: write.number,
              sources,
              ownerState,
              confidence,
              contactGate: /\bMoveContact\b/i.test(triggerText),
              hitGate: /\bMoveHit\b/i.test(triggerText),
              sourceFile,
              line,
              controller: controller.heading.replace(/^\[|\]$/g, ""),
              triggerText: triggerText.slice(0, 260),
            });
          }
        }
      }
    }
  }
  return flags;
}

function parseCmdRouteEdges(commandText, comboScan) {
  const scanStates = comboScan?.states || [];
  const routeEdges = [];
  const commandTextWithoutPatches = removeAiPatchBlocks(commandText);
  const controllers = parseControllers(commandTextWithoutPatches)
    .filter((controller) => /^ChangeState$/i.test(controller.type));
  for (const controller of controllers) {
    const triggerText = controllerTriggerText(controller);
    const refs = parseStateNoRefs(triggerText);
    if (!refs.length) continue;
    const targets = expressionStateTargets(controller.params.value || "");
    if (!targets.length) continue;
    const fromStates = scanStates
      .map((item) => item.state)
      .filter((state) => refs.some((ref) => refMatchesState(ref, state)));
    const kind = /\bMoveHit\b/i.test(triggerText)
      ? "hit-confirm"
      : /\bMoveContact\b/i.test(triggerText)
        ? "contact"
        : /\bctrl\b/i.test(triggerText)
          ? "neutral/control"
          : "conditional";
    for (const from of fromStates) {
      for (const to of targets) {
        routeEdges.push({
          from,
          to,
          kind,
          source: "cmd_state_minus_1",
          controller: controller.heading.replace(/^\[|\]$/g, ""),
          valueExpr: controller.params.value || "",
          triggerRefs: refs.map((ref) => ref.text),
          triggers: triggerText.slice(0, 220),
          confidence: kind === "hit-confirm" ? "high" : kind === "contact" ? "medium" : "review",
        });
      }
    }
  }
  return routeEdges;
}

function parseCancelFlagRouteEdges(commandText, comboScan, cancelFlagSources = []) {
  const routeEdges = [];
  const flagMap = new Map();
  for (const flag of cancelFlagSources || []) {
    const key = `${flag.kind}:${flag.number}`;
    if (!flagMap.has(key)) flagMap.set(key, []);
    flagMap.get(key).push(flag);
  }
  if (!flagMap.size) return routeEdges;
  const scanByState = new Map((comboScan?.states || []).map((item) => [item.state, item]));
  const commandTextWithoutPatches = removeAiPatchBlocks(commandText);
  const controllers = parseControllers(commandTextWithoutPatches)
    .filter((controller) => /^ChangeState$/i.test(controller.type));
  const seen = new Set();
  for (const controller of controllers) {
    const triggerText = controllerTriggerText(controller);
    const targets = expressionStateTargets(controller.params.value || "");
    if (!targets.length) continue;
    const refs = varRefsInText(triggerText).filter((ref) => flagMap.has(`${ref.kind}:${ref.number}`));
    if (!refs.length) continue;
    for (const ref of refs) {
      for (const flag of flagMap.get(`${ref.kind}:${ref.number}`) || []) {
        for (const from of flag.sources || []) {
          if (!scanByState.has(Number(from))) continue;
          for (const to of targets) {
            const key = `${from}->${to}:var(${ref.number}):${controller.heading}`;
            if (seen.has(key)) continue;
            seen.add(key);
            routeEdges.push({
              from: Number(from),
              to: Number(to),
              kind: flag.hitGate ? "flag-hit-confirm" : "flag-contact",
              source: "cmd_cancel_flag",
              controller: controller.heading.replace(/^\[|\]$/g, ""),
              valueExpr: controller.params.value || "",
              triggerRefs: [`var(${ref.number})`, ...(flag.sources || []).map((state) => `StateNo ${state}`)],
              triggers: triggerText.slice(0, 220),
              confidence: flag.confidence || "medium",
              flag: { kind: ref.kind, number: ref.number },
            });
          }
        }
      }
    }
  }
  return routeEdges;
}

function mergeRouteCandidates(comboScan, extraEdges) {
  const scanByState = new Map((comboScan?.states || []).map((item) => [item.state, item]));
  const existing = comboScan?.routeCandidates || [];
  const merged = [];
  const seen = new Set();
  for (const edge of [...existing, ...(extraEdges || [])]) {
    const from = scanByState.get(edge.from);
    const to = scanByState.get(edge.to);
      const normalized = {
        ...edge,
        fromRole: edge.fromRole || from?.role || "unknown",
        toRole: edge.toRole || to?.role || "unknown",
        review: edge.review || (!to ? "target state not scanned" : !scanStateDirectChangeSafe(to) ? `target execution role: ${to.executionRole || "unsafe"}` : to.helperOnly ? "target is helper-only" : ""),
      };
    const key = `${normalized.source || "state"}:${normalized.from}->${normalized.to}:${normalized.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }
  const edgeScore = (edge) => {
    let score = 0;
    if (edge.kind === "hit-confirm") score += 50;
    if (edge.kind === "contact") score += 40;
    if (/normal|low starter|launcher|special|super/i.test(`${edge.fromRole} ${edge.toRole}`)) score += 25;
    if (edge.source === "cmd_state_minus_1") score += 8;
    if (edge.review) score -= 20;
    if (/utility|unknown/i.test(`${edge.fromRole} ${edge.toRole}`)) score -= 8;
    return score;
  };
  comboScan.routeCandidates = merged
    .sort((a, b) => (edgeScore(b) - edgeScore(a)) || (a.from - b.from) || (a.to - b.to))
    .slice(0, 260);
  return comboScan;
}

function inferComboRole(state, hitDefs, powerCost) {
  const hasHit = hitDefs.length > 0;
  const noDamageThrowAttempt = hitDefs.some(hitDefIsNoDamageThrowAttempt);
  if (noDamageThrowAttempt) return "throw attempt";
  const launches = hitDefs.some((hit) => hit.fall || /Up|Diagup/i.test(`${hit.groundType} ${hit.airType}`) || /,\s*-\d+/.test(`${hit.airVelocity} ${hit.groundVelocity}`));
  const low = hitDefs.some((hit) => /^C/i.test(hit.attr) || /L/i.test(hit.hitflag));
  if (state >= 2000 || powerCost?.cost >= 1000) return "super";
  if (state >= 1000 || powerCost?.cost >= 500) return launches ? "special launcher" : "special";
  if (state >= 600 && state <= 699) return "air normal";
  if (launches) return "launcher";
  if (state >= 400 && state <= 499 && low) return "low starter";
  if (state >= 200 && state <= 699 && hasHit) return "normal";
  return hasHit ? "attack" : "utility";
}

function hitDefNumberList(value) {
  return String(value || "").match(/-?\d+(?:\.\d+)?/g)?.map(Number).filter(Number.isFinite) || [];
}

function hitDefVelocityPairs(value) {
  const numbers = hitDefNumberList(value);
  if (!numbers.length) return [];
  const pairs = [];
  for (let i = 0; i < numbers.length; i += 2) {
    pairs.push({ x: numbers[i], y: numbers[i + 1] ?? null });
  }
  return pairs;
}

function hitDefHorizontalVelocities(hit) {
  return [
    ...hitDefVelocityPairs(hit?.groundVelocity),
    ...hitDefVelocityPairs(hit?.airVelocity),
  ].map((pair) => pair.x).filter(Number.isFinite);
}

function hitDefDamageValue(hit) {
  return Math.max(0, ...hitDefNumberList(hit?.damage));
}

function hitDefIsThrowLike(hit) {
  return /\b(?:AT|NT|throw|grab)\b/i.test(`${hit?.attr || ""} ${hit?.hitflag || ""} ${hit?.guardflag || ""}`);
}

function hitDefIsNoDamageThrowAttempt(hit) {
  return hitDefIsThrowLike(hit)
    && hitDefDamageValue(hit) <= 0
    && Number(hit?.numhits || 0) <= 0
    && (
      /\d/.test(String(hit?.p1statenoRaw || ""))
      || /\d/.test(String(hit?.p2statenoRaw || ""))
    );
}

function stateIsNoDamageThrowAttempt(info) {
  return !!(info?.throwAttemptNoDamage || (info?.hitDefs || []).some(hitDefIsNoDamageThrowAttempt));
}

function hitDefMaxAbsXVelocity(hit) {
  return Math.max(0, ...hitDefHorizontalVelocities(hit).map((value) => Math.abs(value)));
}

function hitDefMinYVelocity(hit) {
  const ys = [
    ...hitDefVelocityPairs(hit?.groundVelocity),
    ...hitDefVelocityPairs(hit?.airVelocity),
  ].map((pair) => pair.y).filter(Number.isFinite);
  return ys.length ? Math.min(...ys) : 0;
}

function hitDefIsAirOnly(hit) {
  const text = `${hit?.hitflag || ""} ${hit?.triggerText || ""} ${hit?.attr || ""}`;
  return /\bhitflag\s*=\s*A\b/i.test(text)
    || /\bP2StateType\s*=\s*A\b/i.test(text)
    || /\bp2statetype\s*=\s*A\b/i.test(text)
    || /\bAF\b/i.test(String(hit?.hitflag || ""));
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function inferDetailedRoleFeatures(state, hitDefs, powerCost, actions = [], reach = [], movement = {}) {
  const tags = new Set();
  const reasons = [];
  const stateNum = Number(state);
  const hasHit = hitDefs.length > 0;
  const attrText = hitDefs.map((hit) => hit.attr || "").join(" ");
  const guardText = hitDefs.map((hit) => `${hit.guardflag || ""} ${hit.hitflag || ""}`).join(" ");
  const typeText = hitDefs.map((hit) => `${hit.groundType || ""} ${hit.airType || ""}`).join(" ");
  const maxDamage = Math.max(0, ...hitDefs.map(hitDefDamageValue));
  const noDamageThrowAttempt = hitDefs.some(hitDefIsNoDamageThrowAttempt);
  const maxAbsX = Math.max(0, ...hitDefs.map(hitDefMaxAbsXVelocity));
  const minYVel = Math.min(0, ...hitDefs.map(hitDefMinYVelocity));
  const reachMax = reach.length ? Math.max(...reach.map((item) => Number(item.maxX)).filter(Number.isFinite)) : NaN;
  const reachMinY = reach.length ? Math.min(...reach.map((item) => Number(item.minY)).filter(Number.isFinite)) : NaN;
  const reachMaxY = reach.length ? Math.max(...reach.map((item) => Number(item.maxY)).filter(Number.isFinite)) : NaN;
  const low = /(^|\s)C\b/i.test(attrText) || /\bL\b/i.test(guardText) || /low|trip/i.test(typeText);
  const launches = hitDefs.some((hit) => hit.fall || /up|diagup|hitup/i.test(`${hit.groundType || ""} ${hit.airType || ""}`) || hitDefMinYVelocity(hit) <= -5);
  const air = stateNum >= 600 && stateNum <= 699 || /^A\b/i.test(attrText);
  const airOnly = hitDefs.length > 0 && hitDefs.every(hitDefIsAirOnly);
  const risingDiagonal = !!movement.risingDiagonal;
  const normal = stateNum >= 200 && stateNum <= 699 && hasHit;
  const special = stateNum >= 1000 && stateNum <= 2999 && !powerCost?.cost;
  const meter = stateNum >= 2000 || (powerCost?.cost || 0) >= 500;
  const hyper = (powerCost?.cost || 0) >= 1000 || stateNum >= 3000 || stateNum >= 6000;

  if (hasHit) {
    tags.add("hitdef");
    reasons.push("has HitDef");
  }
  if (noDamageThrowAttempt) {
    tags.add("throw");
    tags.add("throw_attempt");
    tags.add("no_damage_direct");
    reasons.push("throw attempt HitDef with numhits 0 and custom target handoff");
  }
  if (actions.length) {
    tags.add("action_mapped");
    reasons.push(`mapped AIR action ${actions.slice(0, 4).join("/")}`);
  }
  if (Number.isFinite(reachMax)) {
    tags.add(reachMax <= 55 ? "close_range" : reachMax <= 115 ? "mid_range" : "long_range");
    reasons.push(`AIR reach maxX ${Math.round(reachMax)}`);
  }
  if (low) {
    tags.add("low_starter");
    reasons.push("low/crouch hit flags");
  }
  if (/^S\b/i.test(attrText)) tags.add("standing_attack");
  if (/^C\b/i.test(attrText)) tags.add("crouch_attack");
  if (launches) {
    tags.add("launcher");
    reasons.push("launch/fall/upward velocity");
  }
  if (air) {
    tags.add("air_route");
    tags.add(stateNum >= 600 && stateNum <= 699 ? "air_normal" : "air_attack");
    reasons.push("air-state or air-normal range");
  }
  if (airOnly) {
    tags.add("air_only_target");
    reasons.push("HitDef only catches airborne target");
  }
  if (risingDiagonal) {
    tags.add("rising_diagonal");
    reasons.push(`rising diagonal movement x ${Math.round(movement.maxPositiveX || 0)} y ${Math.round(movement.minY || 0)}`);
  }
  if (airOnly && risingDiagonal) {
    tags.add("air_intercept_diagonal");
    tags.add("anti_air_special");
    reasons.push("air-only hit with diagonal rising travel");
  }
  if (normal) {
    tags.add("normal");
    if (maxDamage <= 40) tags.add("light_normal");
    else if (maxDamage <= 85) tags.add("medium_normal");
    else tags.add("strong_normal");
  }
  if (special) {
    tags.add("special");
    if (maxAbsX >= 8 || (Number.isFinite(reachMax) && reachMax > 95)) tags.add("rush_special");
    if (launches || (Number.isFinite(reachMinY) && reachMinY < -70)) tags.add("anti_air_special");
  }
  if (meter) {
    tags.add("meter");
    if (hyper) tags.add("hyper");
    if ((powerCost?.cost || 0) >= 1000) reasons.push(`meter cost ${powerCost.cost}`);
  }
  if (maxAbsX >= 7) tags.add("pushback_risk");
  if (maxAbsX >= 10) tags.add("wall_or_push_route");
  if (Number.isFinite(reachMinY) && reachMinY < -85) tags.add("vertical_coverage");
  if (Number.isFinite(reachMaxY) && reachMaxY > 35) tags.add("low_coverage");

  let family = "utility";
  if (hyper) family = "meter_cashout";
  else if (special) family = tags.has("air_intercept_diagonal") ? "air_intercept" : tags.has("anti_air_special") ? "anti_air_special" : tags.has("rush_special") ? "rush_special" : "special";
  else if (tags.has("air_normal")) family = "air_chain";
  else if (tags.has("launcher")) family = "launcher";
  else if (tags.has("low_starter")) family = "low_starter";
  else if (noDamageThrowAttempt) family = "throw_attempt";
  else if (normal) family = "normal_chain";
  else if (hasHit) family = "attack";

  return {
    tags: [...tags].sort(),
    family,
    reasons: uniqueValues(reasons),
    stats: {
      maxDamage,
      maxAbsXVelocity: maxAbsX,
      pushbackX: maxAbsX,
      minYVelocity: minYVel,
      reachMaxX: Number.isFinite(reachMax) ? reachMax : null,
      reachMinY: Number.isFinite(reachMinY) ? reachMinY : null,
      reachMaxY: Number.isFinite(reachMaxY) ? reachMaxY : null,
      airOnly,
      risingDiagonal,
      maxPositiveXVelocity: movement.maxPositiveX || 0,
    },
  };
}

function summarizeHitDef(hitDefs) {
  if (!hitDefs.length) return "";
  const hit = hitDefs[0];
  const stun = [hit.groundHittime ? `G${hit.groundHittime}` : "", hit.airHittime ? `A${hit.airHittime}` : "", hit.guardHittime ? `B${hit.guardHittime}` : ""].filter(Boolean).join("/");
  return [
    hit.attr || "attr?",
    hit.damage ? `dmg ${hit.damage}` : "",
    stun ? `stun ${stun}` : "",
    hit.fall ? "fall" : "",
    hit.airVelocity ? `airVel ${hit.airVelocity}` : "",
  ].filter(Boolean).join(" | ");
}

function parseComboScan(texts, stateActionMap, airReach, statePowerCosts, stateTraits = {}, airActions = {}) {
  const states = {};
  const cancelEdges = [];
  const stateRegex = /\[\s*StateDef\s+(-?\d+)\s*\]([\s\S]*?)(?=\n\s*\[\s*StateDef\s+-?\d+\s*\]|\s*$)/gi;
  for (const item of texts) {
    for (const match of item.text.matchAll(stateRegex)) {
      const state = Number(match[1]);
      const body = match[2];
      const controllers = parseControllers(body);
      const controllerTypes = uniqueValues(controllers.map((controller) => String(controller.type || "").trim()).filter(Boolean));
      const reusableControllers = controllers
        .map(compactControllerForReuse)
        .filter(Boolean);
      const hitDefs = controllers
        .filter((controller) => /^HitDef$/i.test(controller.type))
        .map(parseHitDefController);
      const hitElems = uniqueValues(hitDefs.flatMap((hit) => hit.hitElems || []))
        .filter((value) => Number.isFinite(value) && value > 0)
        .sort((a, b) => a - b);
      const hitTimes = uniqueValues(hitDefs.flatMap((hit) => hit.triggerTimes || []))
        .filter((value) => Number.isFinite(value) && value >= 0)
        .sort((a, b) => a - b);
      const cancels = controllers
        .filter((controller) => /^ChangeState$/i.test(controller.type))
        .map(parseCancelController);
      const statedefAnim = statedefAnimFromBody(body);
      const actions = stateActionMap[state]?.actions?.map((entry) => entry.action) || [];
      const reach = actions.map((action) => airReach[action] ? ({ action, ...airReach[action] }) : null).filter(Boolean);
      const powerCost = statePowerCosts[state];
      const role = inferComboRole(state, hitDefs, powerCost);
      const movement = inferStateMovement(controllers);
      const roleFeatures = inferDetailedRoleFeatures(state, hitDefs, powerCost, actions, reach, movement);
      const traits = stateTraits[state] || {};
      const throwAttemptNoDamage = hitDefs.some(hitDefIsNoDamageThrowAttempt);
      const timing = stateTimingSummary({
        actions,
        hitElems,
        lastHitElem: hitElems.length ? hitElems[hitElems.length - 1] : null,
        hitTimes,
        lastHitTime: hitTimes.length ? hitTimes[hitTimes.length - 1] : null,
      }, airActions);
      const stateSignals = {
        hasProjectileController: controllerTypes.some((type) => /^Projectile$/i.test(type)),
        hasHelperController: controllerTypes.some((type) => /^Helper$/i.test(type)),
        hasTargetBind: controllerTypes.some((type) => /^TargetBind$/i.test(type)),
        hasTargetState: controllerTypes.some((type) => /^TargetState$/i.test(type)) || traits.hasTargetState,
        hasHitOverride: controllerTypes.some((type) => /^HitOverride$/i.test(type)),
        hasNotHitBy: controllerTypes.some((type) => /^NotHitBy$/i.test(type)),
        hasAfterImage: controllerTypes.some((type) => /^AfterImage$/i.test(type)),
        hasPalFx: controllerTypes.some((type) => /^PalFX$/i.test(type)),
        hasAssertSpecial: controllerTypes.some((type) => /^AssertSpecial$/i.test(type)),
        hasVarMutation: controllerTypes.some((type) => /^(VarSet|VarAdd|ParentVarSet|ParentVarAdd|VarRandom)$/i.test(type)),
        hasExplod: controllerTypes.some((type) => /^Explod$/i.test(type)),
      };
      if (hitDefs.length || cancels.length || actions.length || powerCost) {
        states[state] = {
          state,
          role,
          roleFamily: roleFeatures.family,
          roleTags: roleFeatures.tags,
          roleReasons: roleFeatures.reasons,
          roleStats: roleFeatures.stats,
          actions,
          statedefAnim,
          reach,
          hitDefs,
          hitElems,
          lastHitElem: hitElems.length ? hitElems[hitElems.length - 1] : null,
          hitTimes,
          lastHitTime: hitTimes.length ? hitTimes[hitTimes.length - 1] : null,
          multiHit: hitDefs.length > 1 || hitElems.length > 1,
          throwAttemptNoDamage,
          hitSummary: summarizeHitDef(hitDefs),
          cancels: cancels.slice(0, 8),
          timing,
          powerCost: powerCost || null,
          controllerTypes,
          reusableControllers,
          stateSignals,
          movement,
          helperOnly: !!traits.helperOnly,
          helperOnlyReason: traits.helperOnly ? [
            traits.hasRootRedirect ? "Root redirect" : "",
            traits.hasParentRedirect ? "Parent redirect" : "",
            traits.hasDestroySelf ? "DestroySelf" : "",
            traits.hasParentVarSet ? "ParentVarSet" : "",
          ].filter(Boolean).join(", ") : "",
          executionRole: traits.executionRole || "root_attack",
          executionRoleReason: traits.executionRoleReason || "root/player state",
          directChangeSafe: traits.directChangeSafe !== false,
          comboUnsafe: !!traits.comboUnsafe,
          comboUnsafeReason: traits.comboUnsafeReason || "",
          powerGain: !!traits.powerGain,
          powerGainSignals: traits.powerGainSignals || [],
          missingActions: traits.missingActions || [],
          visualMissingActions: traits.visualMissingActions || [],
          source: path.relative(workspaceDir, item.file),
        };
      }
      for (const cancel of cancels) {
        if (cancel.target === null || Math.abs(cancel.target) < 100) continue;
        cancelEdges.push({
          from: state,
          to: cancel.target,
          kind: cancel.moveHit ? "hit-confirm" : cancel.moveContact ? "contact" : cancel.ctrl ? "neutral/control" : "conditional",
          triggers: cancel.triggers.slice(0, 180),
          confidence: cancel.moveHit || cancel.moveContact ? "high" : "review",
        });
      }
    }
  }

  const routeCandidates = cancelEdges
    .filter((edge) => edge.kind === "hit-confirm" || edge.kind === "contact")
    .slice(0, 80)
    .map((edge) => {
      const from = states[edge.from];
      const to = states[edge.to];
      return {
        ...edge,
        fromRole: from?.role || "unknown",
        toRole: to?.role || "unknown",
        review: !to ? "target state not scanned" : "",
      };
    });

  return {
    states: Object.values(states).sort((a, b) => a.state - b.state),
    cancelEdges,
    routeCandidates,
  };
}

function parseHelperLinks(texts) {
  const links = [];
  const stateRegex = /\[\s*StateDef\s+(-?\d+)\s*\]([\s\S]*?)(?=\n\s*\[\s*StateDef\s+-?\d+\s*\]|\s*$)/gi;
  for (const item of texts) {
    for (const match of item.text.matchAll(stateRegex)) {
      const ownerState = Number(match[1]);
      const body = match[2];
      for (const controller of parseControllers(body).filter((entry) => /^Helper$/i.test(entry.type))) {
        const helperState = firstNumber(controller.params.stateno);
        if (helperState === null || Math.abs(helperState) < 100) continue;
        links.push({
          ownerState,
          helperState,
          helperId: firstNumber(controller.params.id),
          trigger: controllerTriggerText(controller).slice(0, 180),
          source: path.relative(workspaceDir, item.file),
        });
      }
    }
  }
  return links;
}

function controllerTriggerSummary(controller) {
  return controllerTriggerText(controller).slice(0, 220);
}

function pushGraphEdge(edges, edge) {
  if (edge.to !== null && edge.to !== undefined && Math.abs(Number(edge.to)) < 100) return;
  edges.push({
    from: edge.from,
    to: edge.to,
    edgeType: edge.edgeType,
    trigger: edge.trigger || "",
    sourceFile: edge.sourceFile,
    line: edge.line,
    confidence: edge.confidence || "review",
    safety: edge.safety || "needs-review",
    note: edge.note || "",
  });
}

function edgeSafety(edge, stateTraits = {}, stateSet = new Set()) {
  const target = Number(edge.to);
  if (!Number.isFinite(target)) return { safety: "needs-review", note: "dynamic target" };
  const traits = stateTraits[target] || stateTraits[String(target)];
  if (traits?.helperOnly && !["Helper", "TargetState", "HitOverride", "Projectile", "Explod"].includes(edge.edgeType)) {
    return { safety: "helper-only", note: "target uses Root/Parent/DestroySelf/ParentVarSet" };
  }
  if (!stateSet.has(target)) return { safety: "missing", note: "target StateDef not found" };
  if (target >= 5000 && target <= 5999) return { safety: "common/gethit", note: "common or get-hit state range" };
  if (["ChangeState", "SelfState"].includes(edge.edgeType)) return { safety: "player-safe", note: "" };
  if (edge.edgeType === "Helper") return { safety: "helper-spawn", note: "" };
  return { safety: "review", note: "" };
}

function parseStateDependencyGraph(texts, commandText, comboScan, stateTraits = {}, allStates = []) {
  const edges = [];
  const stateSet = new Set(allStates);
  const add = (edge) => {
    const safety = edgeSafety(edge, stateTraits, stateSet);
    pushGraphEdge(edges, { ...edge, ...safety, note: edge.note || safety.note });
  };
  const stateRegex = /\[\s*StateDef\s+(-?\d+)\s*\]([\s\S]*?)(?=\n\s*\[\s*StateDef\s+-?\d+\s*\]|\s*$)/gi;

  for (const item of texts) {
    for (const match of item.text.matchAll(stateRegex)) {
      const from = Number(match[1]);
      const body = match[2];
      const bodyOffset = match.index + match[0].indexOf(body);
      const controllers = parseControllers(body);
      for (const controller of controllers) {
        const type = String(controller.type || "");
        const lowerType = type.toLowerCase();
        const trigger = controllerTriggerSummary(controller);
        const sourceFile = path.relative(workspaceDir, item.file);
        const line = lineNumberAt(item.text, bodyOffset + body.indexOf(controller.body));

        if (/^(changestate|selfstate|targetstate|hitoverride)$/i.test(type)) {
          const param = lowerType === "hitoverride" ? controller.params.stateno : controller.params.value;
          const targets = expressionStateTargets(param || "");
          for (const to of targets) {
            add({
              from,
              to,
              edgeType: lowerType === "changestate" ? "ChangeState" : lowerType === "selfstate" ? "SelfState" : lowerType === "targetstate" ? "TargetState" : "HitOverride",
              trigger,
              sourceFile,
              line,
              confidence: targets.length === 1 ? "high" : "medium",
            });
          }
        }

        if (/^Helper$/i.test(type)) {
          const to = firstNumber(controller.params.stateno);
          add({
            from,
            to,
            edgeType: "Helper",
            trigger,
            sourceFile,
            line,
            confidence: "high",
            note: controller.params.id ? `id ${controller.params.id}` : "",
          });
        }

        if (/^(Projectile|Explod|ModifyExplod|DestroySelf)$/i.test(type)) {
          pushGraphEdge(edges, {
            from,
            to: null,
            edgeType: type,
            trigger,
            sourceFile,
            line,
            confidence: "medium",
            safety: lowerType === "destroyself" ? "helper-exit" : "effect",
            note: controller.params.id ? `id ${controller.params.id}` : "",
          });
        }

        for (const p2State of expressionStateTargets(controller.params.p2stateno || "")) {
          add({
            from,
            to: p2State,
            edgeType: "HitDef p2stateno",
            trigger,
            sourceFile,
            line,
            confidence: "medium",
          });
        }
      }
    }
  }

  for (const edge of comboScan?.cmdRouteEdges || []) {
    add({
      from: edge.from,
      to: edge.to,
      edgeType: "CMD ChangeState",
      trigger: edge.triggers,
      sourceFile: "cmd",
      line: null,
      confidence: edge.confidence || "medium",
      note: edge.controller || "",
    });
  }

  const summary = {
    totalEdges: edges.length,
    helperOnlyTargets: edges.filter((edge) => edge.safety === "helper-only").length,
    missingTargets: edges.filter((edge) => edge.safety === "missing").length,
    playerSafeEdges: edges.filter((edge) => edge.safety === "player-safe").length,
    helperEdges: edges.filter((edge) => edge.edgeType === "Helper").length,
    dynamicEdges: edges.filter((edge) => edge.to === null || edge.to === undefined).length,
  };

  return {
    summary,
    edges: edges
      .sort((a, b) => {
        const riskOrder = { "helper-only": 0, missing: 1, "needs-review": 2, review: 3, "player-safe": 4 };
        return (riskOrder[a.safety] ?? 5) - (riskOrder[b.safety] ?? 5)
          || Number(a.from) - Number(b.from)
          || Number(a.to || 0) - Number(b.to || 0);
      })
      .slice(0, 600),
  };
}

function classifyVarOwner(ref) {
  const blob = `${ref.comments.join(" ")} ${ref.readContexts.join(" ")} ${ref.writeContexts.join(" ")} ${ref.resetContexts.join(" ")}`.toLowerCase();
  if (/\b(parent|root|helper|projectile|explod|destroyself)\b/.test(blob)) return { owner: "helper/projectile", reusable: "no", risk: "high" };
  if (
    (ref.kind === "var" && ref.number === 20)
    || /\b(power|max|custom combo|juggle|damage|defence|defense|super|mode|guard sound|guard spark|combo style|roundstate|life)\b/.test(blob)
  ) {
    return { owner: "gameplay/core", reusable: "no", risk: "high" };
  }
  if (/\b(ai|ailevel|cpu|boss rush|parry memory|guard memory|router|threat|distance|chance|scalar)\b/.test(blob)) {
    return { owner: "AI", reusable: "yes-if-replacing-old-ai", risk: "review" };
  }
  if (ref.writes > 0 && ref.reads > 0) return { owner: "state-machine", reusable: "no", risk: "review" };
  if (ref.writes > 0) return { owner: "writer-only", reusable: "review", risk: "review" };
  return { owner: "unknown", reusable: "review", risk: "review" };
}

function recordVarUse(map, kind, number, usage, context) {
  if (!Number.isInteger(number)) return;
  const key = `${kind}:${number}`;
  if (!map.has(key)) {
    map.set(key, {
      kind,
      number,
      reads: 0,
      writes: 0,
      resets: 0,
      readContexts: [],
      writeContexts: [],
      resetContexts: [],
      comments: [],
      files: new Set(),
      states: new Set(),
    });
  }
  const ref = map.get(key);
  ref.files.add(context.sourceFile);
  if (context.state !== null && context.state !== undefined) ref.states.add(context.state);
  const line = context.line ? `${context.sourceFile}:${context.line}` : context.sourceFile;
  const text = context.detail ? `${line} ${context.detail}` : line;
  if (usage === "read") {
    ref.reads += 1;
    if (ref.readContexts.length < 8) ref.readContexts.push(text);
  } else if (usage === "write") {
    ref.writes += 1;
    if (ref.writeContexts.length < 8) ref.writeContexts.push(text);
  } else if (usage === "reset") {
    ref.resets += 1;
    if (ref.resetContexts.length < 8) ref.resetContexts.push(text);
  } else if (usage === "comment") {
    if (ref.comments.length < 8) ref.comments.push(context.detail || "");
  }
}

function parseVarOwnershipMap(texts) {
  const refs = new Map();
  const allVarRefRegex = /\b(f?var)\s*\(\s*(\d+)\s*\)/gi;
  const writeControllerTypes = /^(VarSet|VarAdd|VarRandom|ParentVarSet)$/i;
  const stateRegex = /\[\s*StateDef\s+(-?\d+)\s*\]([\s\S]*?)(?=\n\s*\[\s*StateDef\s+-?\d+\s*\]|\s*$)/gi;

  for (const item of texts) {
    const sourceFile = path.relative(workspaceDir, item.file);
    const lines = item.text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const comment = line.match(/^\s*;\s*(?:AI_PATCH_)?(f?var)\s*\(\s*(\d+)\s*\)\s*-?\s*(.+)$/i)
        || line.match(/^\s*;\s*(?:AI_PATCH_)?(f?var)\s+([A-Za-z0-9_]+)\s*=\s*f?var\((\d+)\)\s*(.*)$/i);
      if (comment) {
        const kind = comment[1].toLowerCase() === "fvar" ? "fvar" : "var";
        const number = Number(comment[2].match(/^\d+$/) ? comment[2] : comment[3]);
        const detail = comment[3] && comment[2].match(/^\d+$/) ? comment[3] : `${comment[2]} ${comment[4] || ""}`.trim();
        recordVarUse(refs, kind, number, "comment", { sourceFile, line: index + 1, detail });
      }
    });

    for (const stateMatch of item.text.matchAll(stateRegex)) {
      const state = Number(stateMatch[1]);
      const body = stateMatch[2];
      const bodyOffset = stateMatch.index + stateMatch[0].indexOf(body);
      for (const controller of parseControllers(body)) {
        const type = String(controller.type || "");
        const controllerLine = lineNumberAt(item.text, bodyOffset + body.indexOf(controller.body));
        if (writeControllerTypes.test(type)) {
          const kind = /^ParentVarSet$/i.test(type) ? "var" : String(controller.params.v || "").toLowerCase().startsWith("f") ? "fvar" : "var";
          const number = firstNumber(controller.params.v);
          const value = controller.params.value || "";
          const numericValue = firstNumber(value);
          const usage = numericValue === 0 ? "reset" : "write";
          recordVarUse(refs, kind, number, usage, { sourceFile, state, line: controllerLine, detail: type });
        }

        const searchable = `${controller.body}\n${Object.values(controller.params || {}).join("\n")}`;
        for (const match of searchable.matchAll(allVarRefRegex)) {
          const kind = match[1].toLowerCase() === "fvar" ? "fvar" : "var";
          const number = Number(match[2]);
          recordVarUse(refs, kind, number, "read", { sourceFile, state, line: controllerLine, detail: type });
        }
      }

      for (const assign of body.matchAll(/\b(f?var)\s*\(\s*(\d+)\s*\)\s*:=/gi)) {
        const kind = assign[1].toLowerCase() === "fvar" ? "fvar" : "var";
        const number = Number(assign[2]);
        recordVarUse(refs, kind, number, "write", {
          sourceFile,
          state,
          line: lineNumberAt(item.text, bodyOffset + assign.index),
          detail: "trigger assignment :=",
        });
      }
    }
  }

  const entries = [...refs.values()].map((ref) => {
    const classification = classifyVarOwner(ref);
    return {
      kind: ref.kind,
      number: ref.number,
      owner: classification.owner,
      reusable: classification.reusable,
      risk: classification.risk,
      reads: ref.reads,
      writes: ref.writes,
      resets: ref.resets,
      files: [...ref.files].slice(0, 8),
      states: [...ref.states].sort((a, b) => a - b).slice(0, 20),
      comments: ref.comments,
      readContexts: ref.readContexts,
      writeContexts: ref.writeContexts,
      resetContexts: ref.resetContexts,
    };
  }).sort((a, b) => a.kind.localeCompare(b.kind) || a.number - b.number);

  const summary = {
    total: entries.length,
    aiOwned: entries.filter((item) => item.owner === "AI").length,
    reusable: entries.filter((item) => item.reusable === "yes-if-replacing-old-ai").length,
    highRisk: entries.filter((item) => item.risk === "high").length,
    unknown: entries.filter((item) => item.owner === "unknown").length,
  };

  return { summary, entries };
}

function varRefKey(ref) {
  return `${ref.kind}:${ref.number}`;
}

function varToken(kind, number) {
  return `${kind}(${number})`;
}

function varDisplayName(ref) {
  return varToken(ref.kind, ref.number);
}

function brainVarId(item, kind) {
  return `${kind}:${item.id}`;
}

function graphEdgesForState(profile, state) {
  return (profile.stateDependencyGraph?.edges || []).filter((edge) => Number(edge.from) === Number(state) || Number(edge.to) === Number(state));
}

function variableTouchedByGraphBlockers(profile, ref) {
  const states = Array.isArray(ref.states) ? ref.states : [];
  const blockers = [];
  for (const state of states) {
    for (const edge of graphEdgesForState(profile, state)) {
      if (["helper-only", "missing", "needs-review"].includes(edge.safety)) {
        blockers.push({
          state,
          edgeType: edge.edgeType,
          to: edge.to,
          safety: edge.safety,
          sourceFile: edge.sourceFile,
          line: edge.line,
        });
      }
    }
  }
  return blockers.slice(0, 8);
}

function normalizeApprovedVarPool(pool) {
  const entries = Array.isArray(pool)
    ? pool
    : [
        ...(Array.isArray(pool?.vars) ? pool.vars.map((item) => ({ ...item, kind: "var" })) : []),
        ...(Array.isArray(pool?.fvars) ? pool.fvars.map((item) => ({ ...item, kind: "fvar" })) : []),
        ...(Array.isArray(pool?.entries) ? pool.entries : []),
      ];
  return entries
    .map((item) => {
      const kind = String(item?.kind || "").toLowerCase();
      const number = Number(item?.number ?? item?.slot);
      if (!["var", "fvar"].includes(kind) || !Number.isInteger(number)) return null;
      return {
        kind,
        number,
        approvedFor: item?.approvedFor || item?.id || "",
        risk: item?.risk || "review",
        source: item?.source || "manual",
        reason: item?.reason || "approved by user in Full Rewrite Preview",
      };
    })
    .filter(Boolean);
}

function approvedPoolMap(pool) {
  return new Map(normalizeApprovedVarPool(pool).map((item) => [varRefKey(item), item]));
}

function buildVarRewritePlan(profile, brain, plan, cleanupPreview = null, approvedVarPool = null) {
  const ownershipEntries = profile.varOwnershipMap?.entries || [];
  const ownership = new Map(ownershipEntries.map((item) => [varRefKey(item), item]));
  const approvedMap = approvedPoolMap(approvedVarPool);
  const approvedEntries = [...approvedMap.values()];
  const usedByKind = {
    var: new Set(profile.vars?.usedActive || profile.vars?.used || []),
    fvar: new Set(profile.fvars?.usedActive || profile.fvars?.used || []),
  };
  const freeByKind = {
    var: [...(profile.vars?.free || [])],
    fvar: [...(profile.fvars?.free || [])],
  };
  const softFreeByKind = {
    var: [...(profile.vars?.softFree || profile.vars?.free || [])],
    fvar: [...(profile.fvars?.softFree || profile.fvars?.free || [])],
  };
  const highRisk = ownershipEntries.filter((item) => item.risk === "high");
  const unknown = ownershipEntries.filter((item) => item.owner === "unknown");
  const reusableExisting = ownershipEntries.filter((item) => item.owner === "AI" && item.reusable === "yes-if-replacing-old-ai");
  const releaseEntries = cleanupPreview?.releasePlan?.entries || [];
  const releaseMap = new Map(releaseEntries.map((item) => [varRefKey(item), item]));
  const reusableAfterQuarantine = releaseEntries.filter((item) => item.reusableNow);
  const allocated = { var: new Set(), fvar: new Set() };
  const resolvedItems = {
    var: plan?.resolved?.variables || [],
    fvar: plan?.resolved?.fvariables || [],
  };
  const brainItems = {
    var: brain?.variables || [],
    fvar: brain?.fvariables || [],
  };
  const rows = [];
  const replacements = {};
  const lockedVars = highRisk.map((item) => ({
    kind: item.kind,
    number: item.number,
    owner: item.owner,
    risk: item.risk,
    files: item.files || [],
    states: item.states || [],
    reason: "gameplay/helper/core variable; do not rewrite automatically",
  }));

  for (const kind of ["var", "fvar"]) {
    const byId = new Map(resolvedItems[kind].map((item) => [item.id, item]));
    for (const item of brainItems[kind]) {
      const resolved = byId.get(item.id);
      const placeholder = `${kind}.${item.id}`;
      const row = {
        id: item.id,
        kind,
        preferred: Number(item.preferred),
        current: resolved?.number ?? null,
        mappedTo: resolved?.number ?? null,
        source: resolved?.status === "resolved" ? resolved.strategy : "unresolved",
        status: resolved?.status === "resolved" ? "ready" : "blocked",
        risk: "safe",
        filesTouched: [],
        statesTouched: [],
        blockers: [],
        reason: resolved?.status === "resolved" ? "already resolved by current scan" : (resolved?.reason || "unresolved brain variable"),
      };

      if (resolved?.number !== null && resolved?.number !== undefined) {
        allocated[kind].add(resolved.number);
        const owned = ownership.get(`${kind}:${resolved.number}`);
        row.filesTouched = owned?.files || [];
        row.statesTouched = owned?.states || [];
        if (owned?.risk === "high") {
          row.status = "blocked";
          row.risk = "high";
          row.reason = "resolved slot is classified as gameplay/core/helper; unsafe for full rewrite";
        }
        rows.push(row);
        replacements[placeholder] = resolved.number;
        continue;
      }

      const free = freeByKind[kind].find((num) => !allocated[kind].has(num));
      if (free !== undefined) {
        allocated[kind].add(free);
        row.mappedTo = free;
        row.source = "free_slot";
        row.status = "ready";
        row.reason = "new free slot available";
        rows.push(row);
        replacements[placeholder] = free;
        continue;
      }

      const documentedOnly = softFreeByKind[kind].find((num) => !allocated[kind].has(num));
      if (documentedOnly !== undefined) {
        allocated[kind].add(documentedOnly);
        row.mappedTo = documentedOnly;
        row.source = "documented_only_soft_free";
        row.status = "ready";
        row.risk = "review";
        row.reason = "slot appears only in comments/documentation; safe to use with warning";
        rows.push(row);
        replacements[placeholder] = documentedOnly;
        continue;
      }

      const reusable = reusableAfterQuarantine.find((entry) => entry.kind === kind && !allocated[kind].has(entry.number))
        || reusableExisting.find((entry) => entry.kind === kind && !allocated[kind].has(entry.number) && releaseMap.get(varRefKey(entry))?.reusableNow);
      if (reusable) {
        const owned = ownership.get(varRefKey(reusable)) || reusable;
        const graphBlockers = variableTouchedByGraphBlockers(profile, owned);
        row.mappedTo = reusable.number;
        row.source = "old_ai_after_quarantine";
        row.status = graphBlockers.length ? "review" : "migrate";
        row.risk = graphBlockers.length ? "review" : "safe";
        row.filesTouched = owned.files || [];
        row.statesTouched = owned.states || [];
        row.blockers = graphBlockers;
        row.reason = graphBlockers.length
          ? "AI-owned slot has state graph edges that need review before reuse"
          : "AI-owned slot can be reused after old AI quarantine and rescan";
        allocated[kind].add(reusable.number);
        rows.push(row);
        replacements[placeholder] = reusable.number;
        continue;
      }

      const reviewCandidate = unknown
        .filter((entry) => entry.kind === kind && !allocated[kind].has(entry.number))
        .find((entry) => !usedByKind[kind].has(entry.number) || entry.writes <= 1);
      if (reviewCandidate) {
        const approved = approvedMap.get(varRefKey(reviewCandidate));
        row.mappedTo = approved ? reviewCandidate.number : null;
        row.reviewCandidate = reviewCandidate.number;
        row.approved = !!approved;
        row.source = approved ? "manual_approved_pool" : "manual_review_candidate";
        row.status = approved ? "review" : "blocked";
        row.risk = "review";
        row.filesTouched = reviewCandidate.files || [];
        row.statesTouched = reviewCandidate.states || [];
        row.reason = approved
          ? `approved pool allows ${varToken(kind, reviewCandidate.number)} for ${item.id}; verify Preview Diff before Apply`
          : `only unknown/review slots remain; possible candidate ${varToken(kind, reviewCandidate.number)} needs explicit approval`;
        allocated[kind].add(reviewCandidate.number);
        rows.push(row);
        if (approved) replacements[placeholder] = reviewCandidate.number;
        continue;
      }

      row.status = "blocked";
      row.risk = "high";
      row.reason = "no free slot or safe AI-owned slot available";
      rows.push(row);
    }
  }

  const blocked = rows.filter((item) => item.status === "blocked");
  const review = rows.filter((item) => item.status === "review");
  const migrate = rows.filter((item) => item.status === "migrate");
  const ready = rows.filter((item) => item.status === "ready");
  const filesTouched = uniqueValues(rows.flatMap((item) => item.filesTouched || []));
  const statesTouched = uniqueValues(rows.flatMap((item) => item.statesTouched || [])).sort((a, b) => Number(a) - Number(b));
  const graphBlockers = rows.flatMap((item) => item.blockers || []);
  const summary = {
    brainVars: rows.filter((item) => item.kind === "var").length,
    brainFVars: rows.filter((item) => item.kind === "fvar").length,
    ready: ready.length,
    migrate: migrate.length,
    review: review.length,
    blocked: blocked.length,
    freeVars: profile.vars?.free?.length || 0,
    freeFVars: profile.fvars?.free?.length || 0,
    softFreeVars: profile.vars?.softFree?.length || profile.vars?.free?.length || 0,
    softFreeFVars: profile.fvars?.softFree?.length || profile.fvars?.free?.length || 0,
    documentedOnlyVars: profile.vars?.documentedOnly?.length || 0,
    documentedOnlyFVars: profile.fvars?.documentedOnly?.length || 0,
    reusableAiVars: reusableExisting.filter((item) => item.kind === "var").length,
    reusableAiFVars: reusableExisting.filter((item) => item.kind === "fvar").length,
    releaseAfterQuarantine: cleanupPreview?.releasePlan?.summary?.reusableAfterQuarantine || 0,
    highRiskVars: highRisk.length,
    unknownVars: unknown.length,
    approvedVars: approvedEntries.filter((item) => item.kind === "var").length,
    approvedFVars: approvedEntries.filter((item) => item.kind === "fvar").length,
    graphBlockers: graphBlockers.length,
    filesTouched: filesTouched.length,
    statesTouched: statesTouched.length,
  };
  const decision = blocked.length
    ? "blocked"
    : review.length
      ? "needs manual approval"
      : migrate.length
        ? "migrate after quarantine"
        : "ready";
  const nextActions = [];
  if (blocked.length) nextActions.push("Resolve blocked mappings or free AI-owned variables before patching.");
  if (migrate.length) nextActions.push("Run old AI quarantine, then scan/resolve/preview again before applying.");
  if (review.length) nextActions.push("Manually approve review variables only after checking their cross-file owners.");
  if (!blocked.length && !review.length && !migrate.length) nextActions.push("Normal Preview Diff and Apply path can be used.");

  return {
    ok: true,
    decision,
    summary,
    rows,
    replacements,
    approvedVarPool: approvedEntries,
    lockedVars,
    filesTouched,
    statesTouched,
    graphBlockers,
    nextActions,
  };
}

function mergedReach(reachLists) {
  const all = reachLists.flat().filter(Boolean);
  if (!all.length) return [];
  return [{
    action: "effective",
    minX: Math.min(...all.map((item) => item.minX)),
    maxX: Math.max(...all.map((item) => item.maxX)),
    minY: Math.min(...all.map((item) => item.minY)),
    maxY: Math.max(...all.map((item) => item.maxY)),
    clsn1Count: all.reduce((sum, item) => sum + Number(item.clsn1Count || 0), 0),
  }];
}

function applyHelperEffectiveReach(comboScan, helperLinks) {
  const scanByState = new Map((comboScan?.states || []).map((item) => [item.state, item]));
  const linksByOwner = new Map();
  for (const link of helperLinks || []) {
    if (!linksByOwner.has(link.ownerState)) linksByOwner.set(link.ownerState, []);
    linksByOwner.get(link.ownerState).push(link);
  }

  for (const [ownerState, links] of linksByOwner.entries()) {
    const owner = scanByState.get(ownerState);
    if (!owner) continue;
    const helperScans = links.map((link) => scanByState.get(link.helperState)).filter(Boolean);
    const helperReach = helperScans.flatMap((scan) => scan.reach || []);
    const helperHitScans = helperScans.filter((scan) => scan.hitDefs?.length || scan.hitSummary);
    owner.helperLinks = links;
    owner.helperStates = links.map((link) => link.helperState);
    owner.helperReach = helperReach;
    owner.helperTravel = estimateHelperTravel(owner, helperScans, links);
    owner.effectiveReach = mergedReach([owner.reach || [], helperReach]);
    owner.hasEffectiveHit = !!(owner.hitDefs?.length || owner.hitSummary || helperHitScans.length);
    if (!owner.hitSummary && helperHitScans.length) {
      owner.effectiveHitSummary = helperHitScans.map((scan) => `${scan.state}: ${scan.hitSummary || "HitDef"}`).join("; ");
    }
  }

  comboScan.helperLinks = helperLinks || [];
  annotateAttackStateRanges(comboScan);
  annotateMeterReliability(comboScan);
  return comboScan;
}

function estimateHelperTravel(owner, helperScans, links) {
  const helperReach = helperScans.flatMap((scan) => scan.reach || []);
  const ownerReach = owner?.reach || [];
  const ownerMax = ownerReach.length ? Math.max(...ownerReach.map((item) => Number(item.maxX)).filter(Number.isFinite)) : null;
  const helperMax = helperReach.length ? Math.max(...helperReach.map((item) => Number(item.maxX)).filter(Number.isFinite)) : null;
  const helperMin = helperReach.length ? Math.min(...helperReach.map((item) => Number(item.minX)).filter(Number.isFinite)) : null;
  const startupValues = helperScans.map((scan) => finiteNumberOrNull(scan.timing?.startup)).filter((value) => value !== null);
  const activeEndValues = helperScans.map((scan) => finiteNumberOrNull(scan.timing?.activeEnd)).filter((value) => value !== null);
  const spawnFrames = links.flatMap((link) => helperSpawnFrameEstimates(link.trigger)).filter((value) => value !== null);
  const spawnFrame = spawnFrames.length ? Math.min(...spawnFrames) : null;
  const helperStartup = startupValues.length ? Math.min(...startupValues) : null;
  const helperActiveEnd = activeEndValues.length ? Math.max(...activeEndValues) : null;
  const estimate = {
    ownerState: owner?.state ?? null,
    helperStates: links.map((link) => link.helperState),
    helperIds: uniqueValues(links.map((link) => link.helperId).filter((value) => value !== null && value !== undefined)),
    maxX: Number.isFinite(helperMax) ? helperMax : null,
    minX: Number.isFinite(helperMin) ? helperMin : null,
    ownerMaxX: Number.isFinite(ownerMax) ? ownerMax : null,
    spawnFrame,
    helperStartup,
    startup: spawnFrame !== null && helperStartup !== null
      ? spawnFrame + helperStartup
      : spawnFrame !== null
        ? spawnFrame
        : helperStartup,
    activeEnd: spawnFrame !== null && helperActiveEnd !== null
      ? spawnFrame + helperActiveEnd
      : helperActiveEnd,
  };
  const travelDistance = Number.isFinite(helperMax) && Number.isFinite(ownerMax)
    ? Math.max(0, helperMax - ownerMax)
    : Number.isFinite(helperMax)
      ? Math.max(0, helperMax)
      : null;
  estimate.travelDistance = travelDistance;
  estimate.kind = travelDistance !== null && travelDistance > 140
    ? "travel_projectile"
    : helperScans.some((scan) => scan.hitDefs?.length || scan.hasEffectiveHit)
      ? "helper_hit"
      : "helper_setup";
  return estimate;
}

function helperSpawnFrameEstimates(triggerText) {
  const frames = [];
  const text = String(triggerText || "");
  for (const match of text.matchAll(/\bTime\s*=\s*(\d+)/gi)) frames.push(Number(match[1]));
  for (const match of text.matchAll(/\bAnimElem\s*=?\s*(\d+)/gi)) frames.push(Number(match[1]));
  return frames.filter(Number.isFinite);
}

function inferAttackDelivery(info) {
  const helperStates = info?.helperStates || [];
  const signal = info?.stateSignals || {};
  const reachMax = scanStateReachMaxX(info, NaN);
  const reachMin = (() => {
    const reach = info?.effectiveReach?.length ? info.effectiveReach : info?.reach || [];
    const values = reach.map((item) => Number(item.minX)).filter(Number.isFinite);
    return values.length ? Math.min(...values) : NaN;
  })();
  if (signal.hasProjectileController || info?.helperTravel?.kind === "travel_projectile") return "projectile";
  if (helperStates.length && reachMax > 135) return "projectile";
  if (helperStates.length) return "helper_trap";
  if (reachMax > 135) return "long_melee";
  if (Number.isFinite(reachMin) && reachMin < -20) return "crossup_melee";
  return "melee";
}

function scanWindowFromInfo(info) {
  if (!info) return null;
  const reach = info.effectiveReach?.length ? info.effectiveReach : info.reach || [];
  const maxXValues = reach.map((item) => Number(item.maxX)).filter(Number.isFinite);
  const minXValues = reach.map((item) => Number(item.minX)).filter(Number.isFinite);
  const minYValues = reach.map((item) => Number(item.minY)).filter(Number.isFinite);
  const maxYValues = reach.map((item) => Number(item.maxY)).filter(Number.isFinite);
  if (!maxXValues.length || !minYValues.length || !maxYValues.length) return null;
  const minX = minXValues.length ? Math.max(-80, Math.min(20, Math.min(...minXValues))) : -20;
  const maxX = Math.max(25, Math.min(220, Math.max(...maxXValues)));
  const minY = Math.max(-180, Math.min(40, Math.min(...minYValues)));
  const maxY = Math.max(Math.max(-180, Math.min(80, Math.max(...maxYValues))), 10);
  return {
    xMin: Math.round(minX),
    xMax: Math.round(maxX),
    yMin: Math.round(minY),
    yMax: Math.round(maxY),
    startup: finiteNumberOrNull(info.timing?.startup),
    activeEnd: finiteNumberOrNull(info.timing?.activeEnd),
    source: info.effectiveReach?.length ? "effective_helper_or_owner_reach" : "state_air_or_hitdef_reach",
  };
}

function annotateAttackStateRanges(comboScan) {
  for (const info of comboScan?.states || []) {
    const reachMax = scanStateReachMaxX(info, NaN);
    info.reachMaxX = Number.isFinite(reachMax) ? reachMax : null;
    info.rangeClass = classifyMeterRangeClass(reachMax);
    info.delivery = inferAttackDelivery(info);
    info.scanWindow = scanWindowFromInfo(info);
  }
  return comboScan;
}

function meterStateKind(info) {
  const state = Number(info?.state);
  const cost = Number(info?.powerCost?.cost) || 0;
  return state >= 2000 || cost >= 1000 ? "super" : cost >= 500 ? "ex" : "meter";
}

function totalHitDefDamage(info) {
  const hits = info?.hitDefs || [];
  if (!hits.length) return null;
  const total = hits.reduce((sum, hit) => sum + hitDefDamageValue(hit), 0);
  return total > 0 ? Math.round(total) : null;
}

function highCostFinisherPolicy(info) {
  const cost = Number(info?.powerCost?.cost) || 0;
  if (cost < 3000) return null;
  const classification = meterReliabilityClass(info) || info?.meterReliability?.classification || "";
  if (["self_buff", "install"].includes(classification)) return null;
  const startup = Math.max(1, Number(info?.timing?.startup ?? info?.scanWindow?.startup ?? 6) || 6);
  const minHitTime = Math.max(8, Math.min(24, startup + 4));
  const damage = totalHitDefDamage(info);
  return {
    kind: "high_cost_finisher",
    cost,
    startup,
    minHitTime,
    estimatedDamage: damage,
    killLifeMax: damage ? Math.max(80, Math.min(420, Math.round(damage * 1.15))) : null,
    requiredConfirm: "hard_hitstun_or_kill_confirm",
  };
}

function isHighCostFinisherState(profile, state) {
  return !!highCostFinisherPolicy(stateScanInfo(profile, Number(state)));
}

function highCostHardHitstunExpr(policy) {
  return `(!EnemyNear,Ctrl && EnemyNear,MoveType = H && EnemyNear,GetHitVar(HitTime) >= ${policy.minHitTime})`;
}

function highCostLethalPunishExpr(policy) {
  if (!policy?.killLifeMax) return "";
  return `(EnemyNear,Life <= ${policy.killLifeMax} && !EnemyNear,Ctrl && EnemyNear,MoveType = A && EnemyNear,StateNo != [120,155] && P2StateNo != [120,155] && !InGuardDist)`;
}

function highCostConfirmExpr(policy) {
  const hardHitstun = highCostHardHitstunExpr(policy);
  const lethalPunish = highCostLethalPunishExpr(policy);
  return lethalPunish ? `(${hardHitstun} || ${lethalPunish})` : hardHitstun;
}

function highCostHasHardHitstunGate(text, policy) {
  const source = String(text || "");
  const hitTimes = [...source.matchAll(/EnemyNear\s*,\s*GetHitVar\s*\(\s*HitTime\s*\)\s*>=\s*(\d+)/gi)]
    .map((match) => Number(match[1]));
  return /!\s*EnemyNear\s*,\s*Ctrl/i.test(source)
    && /\bEnemyNear\s*,\s*MoveType\s*=\s*H\b/i.test(source)
    && hitTimes.some((value) => value >= Number(policy?.minHitTime || 0));
}

function highCostHasLethalPunishGate(text, policy) {
  const source = String(text || "");
  if (!policy?.killLifeMax) return false;
  const lifeLimits = [...source.matchAll(/EnemyNear\s*,\s*Life\s*<=\s*(\d+)/gi)]
    .map((match) => Number(match[1]));
  return lifeLimits.some((value) => value <= Number(policy.killLifeMax))
    && /!\s*EnemyNear\s*,\s*Ctrl/i.test(source)
    && /\bEnemyNear\s*,\s*MoveType\s*=\s*A\b/i.test(source)
    && /EnemyNear\s*,\s*StateNo\s*!=\s*\[\s*120\s*,\s*155\s*\]/i.test(source)
    && /P2StateNo\s*!=\s*\[\s*120\s*,\s*155\s*\]/i.test(source)
    && /!\s*InGuardDist/i.test(source);
}

function highCostHasRequiredConfirmGate(text, policy) {
  const source = String(text || "");
  return /\bAI_PATCH_HIGH_COST_FINISHER\b/i.test(source)
    || highCostHasHardHitstunGate(source, policy)
    || highCostHasLethalPunishGate(source, policy);
}

function highCostFinisherTriggerLines(profile, state) {
  const info = stateScanInfo(profile, Number(state));
  const policy = highCostFinisherPolicy(info);
  if (!policy) return [];
  const lethalPunish = highCostLethalPunishExpr(policy);
  return [
    `; AI_PATCH_HIGH_COST_FINISHER ${state}: 3000-power hard hitstun / lethal punish confirm gate`,
    lethalPunish ? `; AI_PATCH_LETHAL_PUNISH ${state}: EnemyNear,Life <= ${policy.killLifeMax}, no guard, punish recovery` : "",
    `triggerAll = ${highCostConfirmExpr(policy)}`,
  ].filter(Boolean);
}

function classifyMeterReliability(info) {
  const cost = Number(info?.powerCost?.cost) || 0;
  if (!cost) return null;

  const timing = info?.timing || {};
  const reach = info?.effectiveReach?.length ? info.effectiveReach : info?.reach || [];
  const maxX = scanStateReachMaxX(info, NaN);
  const minY = scanStateReachMinY(info, NaN);
  const maxY = scanStateReachMaxY(info, NaN);
  const startup = finiteNumberOrNull(timing.startup ?? info?.helperTravel?.startup);
  const recovery = finiteNumberOrNull(timing.recovery);
  const roleText = `${info?.role || ""} ${info?.roleFamily || ""} ${(info?.roleTags || []).join(" ")} ${info?.hitSummary || ""} ${info?.effectiveHitSummary || ""}`.toLowerCase();
  const signal = info?.stateSignals || {};
  const hasHit = !!(info?.hitDefs?.length || info?.hitSummary || info?.hasEffectiveHit);
  const hasHelperHit = !!(info?.helperStates?.length && info?.hasEffectiveHit);
  const hasProjectile = signal.hasProjectileController || info?.delivery === "projectile" || info?.helperTravel?.kind === "travel_projectile";
  const hasGrab = /\b(at|throw|grab)\b/i.test((info?.hitDefs || []).map((hit) => `${hit.attr || ""} ${hit.hitflag || ""} ${hit.guardflag || ""}`).join(" "))
    || signal.hasTargetBind
    || signal.hasTargetState
    || /\bthrow|grab|capture|bind\b/.test(roleText);
  const hasInstallSignal = signal.hasNotHitBy || signal.hasAfterImage || signal.hasPalFx || signal.hasAssertSpecial || signal.hasHitOverride;
  const hasBuffSignal = signal.hasVarMutation && !hasHit && !hasHelperHit;
  const noDirectHit = !hasHit && !hasHelperHit;

  let classification = "unsafe_raw";
  const reasons = [];
  const warnings = [];
  let confidence = 0.45;

  if (hasProjectile) {
    classification = "projectile";
    confidence = 0.72;
    reasons.push("projectile/helper travel signal");
  }
  if (hasGrab) {
    classification = "grab";
    confidence = Math.max(confidence, 0.76);
    reasons.push("throw/grab/custom target signal");
  }
  if (hasInstallSignal && noDirectHit) {
    classification = "install";
    confidence = Math.max(confidence, 0.66);
    reasons.push("install/invulnerability/visual mode signal");
  }
  if (hasBuffSignal || (/heal|recover|power|charge|buff|mode|install|aura|factor|safe/.test(roleText) && noDirectHit)) {
    classification = hasInstallSignal ? "install" : "self_buff";
    confidence = Math.max(confidence, 0.62);
    reasons.push("state mutates vars or looks like self utility without hit");
  }
  const utilityOnlyInstall = hasInstallSignal && noDirectHit;
  if (!hasProjectile && !hasGrab && !hasBuffSignal && !utilityOnlyInstall && (hasHit || hasHelperHit)) {
    if (Number.isFinite(maxX) && maxX <= 125) {
      classification = "close_confirm";
      confidence = 0.78;
      reasons.push(`${hasHelperHit && !hasHit ? "helper/effective " : ""}close/mid hitbox maxX ${Math.round(maxX)}`);
    } else if (Number.isFinite(maxX)) {
      classification = "projectile";
      confidence = 0.68;
      reasons.push(`${hasHelperHit && !hasHit ? "helper/effective " : ""}long effective reach maxX ${Math.round(maxX)}`);
    }
  }

  if (!hasHit && !hasHelperHit && !hasBuffSignal && !hasInstallSignal) {
    classification = "unsafe_raw";
    warnings.push("no direct/effective HitDef found");
  }
  if (startup !== null) {
    reasons.push(`startup ${startup}`);
    if (startup > 12 && classification === "close_confirm") warnings.push("slow startup close-range meter");
    if (startup > 18 && classification !== "projectile" && classification !== "install") confidence -= 0.08;
  } else {
    warnings.push("startup unknown");
    confidence -= 0.08;
  }
  if (recovery !== null && recovery > 30 && classification !== "install") {
    warnings.push(`long recovery ${recovery}`);
    confidence -= 0.05;
  }
  if (classification === "close_confirm" && (!Number.isFinite(maxX) || maxX > 125)) {
    warnings.push("close confirm range is uncertain");
    confidence -= 0.08;
  }
  if (classification === "projectile" && info?.helperTravel?.travelDistance !== null && info?.helperTravel?.travelDistance !== undefined) {
    reasons.push(`helper travel ${Math.round(info.helperTravel.travelDistance)}`);
  }
  if (Number.isFinite(minY) || Number.isFinite(maxY)) {
    reasons.push(`y ${Number.isFinite(minY) ? Math.round(minY) : "?"}..${Number.isFinite(maxY) ? Math.round(maxY) : "?"}`);
  }

  confidence = Math.max(0.1, Math.min(0.95, confidence));
  return {
    kind: meterStateKind(info),
    classification,
    confidence: Number(confidence.toFixed(2)),
    recommendedUse: meterRecommendedUse(classification),
    highCostFinisher: cost >= 3000 && !["self_buff", "install"].includes(classification) ? {
      minHitTime: Math.max(8, Math.min(24, (startup || 6) + 4)),
      estimatedDamage: totalHitDefDamage(info),
      requiredConfirm: "hard_hitstun_or_kill_confirm",
    } : null,
    timing,
    range: {
      maxX: Number.isFinite(maxX) ? Math.round(maxX) : null,
      minY: Number.isFinite(minY) ? Math.round(minY) : null,
      maxY: Number.isFinite(maxY) ? Math.round(maxY) : null,
      reachCount: reach.length,
    },
    delivery: info?.delivery || "unknown",
    helperTravel: info?.helperTravel || null,
    reasons: uniqueValues(reasons),
    warnings: uniqueValues(warnings),
  };
}

function meterRecommendedUse(classification) {
  if (classification === "close_confirm") return "hit_confirm_only";
  if (classification === "projectile") return "spacing_or_punish";
  if (classification === "grab") return "point_blank_punish_only";
  if (classification === "self_buff") return "knockdown_or_far_safe_only";
  if (classification === "install") return "safe_neutral_or_knockdown_setup";
  return "do_not_raw";
}

function annotateMeterReliability(comboScan) {
  for (const info of comboScan?.states || []) {
    if (info?.powerCost?.cost) {
      info.meterReliability = classifyMeterReliability(info);
    }
  }
  return comboScan;
}

function normalizeMoveText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseMovelistHints(text) {
  const hints = [];
  const lines = String(text || "").split(/\r?\n/);
  let section = "";
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (!raw || /^\|?-{4,}/.test(raw)) continue;
    const sectionMatch = raw.match(/^(.+?)\s*Moves?\s*:?\s*$/i);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const nameMatch = raw.match(/^([^:]{2,80}):\s*$/);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    const inputLines = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j += 1) {
      const next = lines[j].trim();
      if (!next || /^-{4,}|\|/.test(next) || /^[^:]{2,80}:\s*$/.test(next)) break;
      inputLines.push(next);
    }
    hints.push({
      name,
      normalizedName: normalizeMoveText(name),
      section,
      input: inputLines.join(" | "),
    });
  }
  return hints;
}

function movelistHintForCommand(commandName, hints) {
  const normalized = normalizeMoveText(commandName);
  if (!normalized) return null;
  return (hints || []).find((hint) => hint.normalizedName === normalized)
    || (normalized.length >= 4
      ? (hints || []).find((hint) => hint.normalizedName.length >= 4 && (normalized.includes(hint.normalizedName) || hint.normalizedName.includes(normalized)))
      : null)
    || null;
}

function stateTimingSummary(info, airActions = {}) {
  const actions = info?.actions || [];
  const actionDetails = actions.map((action) => airActions[action]).filter(Boolean);
  const frameCount = actionDetails.length ? Math.max(...actionDetails.map((item) => item.frameCount || 0)) : null;
  const totalTime = actionDetails.length ? Math.max(...actionDetails.map((item) => item.totalTime || 0)) : null;
  const firstHitElem = (info?.hitElems || []).length ? Math.min(...info.hitElems) : null;
  const lastHitElem = info?.lastHitElem || null;
  const firstHitTime = (info?.hitTimes || []).length ? Math.min(...info.hitTimes) : null;
  const lastHitTime = info?.lastHitTime || null;
  const firstClsnFrame = (() => {
    const frames = actionDetails.flatMap((action) => action.frames || []);
    const hitFrames = frames.filter((frame) => frame.boxes?.Clsn1?.length);
    return hitFrames.length ? Math.min(...hitFrames.map((frame) => frame.frameIndex + 1)) : null;
  })();
  return {
    actions,
    frameCount,
    totalTime,
    startup: firstHitElem || firstHitTime || firstClsnFrame,
    activeEnd: lastHitElem || lastHitTime || firstClsnFrame,
    recovery: (totalTime || frameCount) && (lastHitElem || lastHitTime || firstClsnFrame) ? Math.max(0, (totalTime || frameCount) - (lastHitElem || lastHitTime || firstClsnFrame)) : null,
    source: firstHitElem ? "hitdef_animelem" : firstHitTime !== null ? "hitdef_time" : firstClsnFrame ? "air_clsn1_frame" : "unknown",
    firstHitTime,
    lastHitTime,
  };
}

function buildInferredMovelist(commandText, movelistText, comboScan, airActions = {}) {
  const { commandDefs, entries } = parseCmdMoveEntries(commandText);
  const scanByState = new Map((comboScan?.states || []).map((item) => [item.state, item]));
  const hints = parseMovelistHints(movelistText);
  const rows = [];
  const seen = new Set();
  for (const entry of entries) {
    const info = scanByState.get(entry.state);
    if (!info || info.helperOnly || info.directChangeSafe === false) continue;
    const definitions = entry.definitions?.length ? entry.definitions : commandDefs.filter((def) => def.name === entry.commandName);
    const inputs = uniqueValues(definitions.map((def) => def.input).filter(Boolean));
    const times = uniqueValues(definitions.map((def) => def.time).filter((value) => value !== null && value !== undefined));
    const hint = movelistHintForCommand(entry.commandName, hints);
    const timing = stateTimingSummary(info, airActions);
    const helperOwners = (info.helperLinks || []).map((link) => ({
      ownerState: link.ownerState,
      helperState: link.helperState,
      helperId: link.helperId,
      trigger: link.trigger,
    }));
    const key = `${entry.commandName}:${entry.state}:${inputs.join("|")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const gateParts = [
      entry.gate.ctrl ? "Ctrl" : "",
      entry.gate.moveHit ? "MoveHit" : "",
      entry.gate.moveContact ? "MoveContact" : "",
      entry.gate.moveGuarded ? "MoveGuarded" : "",
      entry.gate.power.length ? `Power>=${Math.max(...entry.gate.power)}` : "",
      entry.gate.stateRefs.length ? `StateNo ${entry.gate.stateRefs.map((ref) => ref.text).join("/")}` : "",
    ].filter(Boolean);
    rows.push({
      moveName: hint?.name || entry.commandName,
      commandName: entry.commandName,
      input: inputs.join(" | ") || hint?.input || "",
      commandTime: times.length ? Math.max(...times) : null,
      state: entry.state,
      role: info.role || "",
      roleFamily: info.roleFamily || "",
      roleTags: info.roleTags || [],
      hitSummary: info.hitSummary || info.effectiveHitSummary || (info.hasEffectiveHit ? "helper HitDef" : ""),
      powerCost: info.powerCost || null,
      reach: info.effectiveReach?.length ? info.effectiveReach : info.reach || [],
      rangeClass: info.rangeClass || "",
      delivery: info.delivery || "",
      timing,
      meterReliability: info.meterReliability || null,
      cancels: (info.cancels || []).map((cancel) => ({
        target: cancel.target,
        targetExpr: cancel.targetExpr,
        moveHit: cancel.moveHit,
        moveContact: cancel.moveContact,
        triggers: cancel.triggers,
      })),
      helperOwners,
      source: {
        controller: entry.controller,
        trigger: entry.trigger,
        movelistHint: hint ? hint.section || "Movelist.txt" : "",
      },
      gate: gateParts,
      evidence: [
        `CMD command "${entry.commandName}" maps to ChangeState ${entry.state}`,
        inputs.length ? `input ${inputs.slice(0, 2).join(" / ")}` : "",
        info.hitDefs?.length ? "state has direct HitDef" : "",
        info.hasEffectiveHit && !info.hitDefs?.length ? "state has helper/effective hit" : "",
        info.helperStates?.length ? `helper hit owner ${info.helperStates.slice(0, 3).join("/")}` : "",
        timing.startup ? `startup ${timing.startup} (${timing.source})` : "",
        info.meterReliability ? `meter reliability ${info.meterReliability.classification}/${info.meterReliability.recommendedUse}` : "",
        info.cancels?.some((cancel) => cancel.moveHit || cancel.moveContact) ? "has MoveHit/MoveContact cancel" : "",
      ].filter(Boolean).join("; "),
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    source: {
      commandDefinitions: commandDefs.length,
      cmdMappings: entries.length,
      movelistHints: hints.length,
    },
    moves: rows.sort((a, b) => (a.state - b.state) || a.moveName.localeCompare(b.moveName)),
  };
}

function renderInferredMovelistText(profile) {
  const inferred = profile?.inferredMovelist || {};
  const moves = inferred.moves || [];
  const lines = [
    "; AI_PATCH_INFERRED_MOVELIST_BEGIN",
    `; Character: ${profile?.name || ""}`,
    `; Generated: ${new Date().toISOString()}`,
    "; Source: parsed CMD [Command]/[Statedef -1], existing Movelist.txt hints, CNS/ST HitDef, helper links, AIR Clsn1/AnimElem timing.",
    "; This block is generated for scanner/resolver/generator use. Edit manually only if a move name or role is wrong.",
    "",
  ];
  if (!moves.length) lines.push("; No command-to-attack moves inferred.");
  for (const move of moves) {
    const reach = move.reach?.length ? move.reach.map((item) => `A${item.action}:X${item.minX}..${item.maxX},Y${item.minY}..${item.maxY}`).join(" | ") : "no AIR reach";
    const timing = [
      move.timing?.startup ? `startup ${move.timing.startup}` : "",
      move.timing?.activeEnd ? `activeEnd ${move.timing.activeEnd}` : "",
      move.timing?.recovery !== null && move.timing?.recovery !== undefined ? `recovery ${move.timing.recovery}` : "",
    ].filter(Boolean).join(", ") || "timing unknown";
    lines.push(`[Move] ${move.moveName}`);
    lines.push(`command = "${move.commandName}"`);
    lines.push(`input = ${move.input || "-"}`);
    lines.push(`state = ${move.state}`);
    lines.push(`role = ${move.roleFamily || move.role || "-"}`);
    lines.push(`tags = ${(move.roleTags || []).join(", ") || "-"}`);
    lines.push(`hit = ${move.hitSummary || "-"}`);
    lines.push(`timing = ${timing}`);
    if (move.meterReliability) {
      lines.push(`meter_reliability = ${move.meterReliability.classification}, confidence ${move.meterReliability.confidence}, use ${move.meterReliability.recommendedUse}`);
      lines.push(`meter_reasons = ${(move.meterReliability.reasons || []).join("; ") || "-"}`);
      lines.push(`meter_warnings = ${(move.meterReliability.warnings || []).join("; ") || "-"}`);
    }
    lines.push(`reach = ${reach}`);
    lines.push(`gate = ${(move.gate || []).join(", ") || "-"}`);
    lines.push(`cancel = ${(move.cancels || []).filter((cancel) => cancel.moveHit || cancel.moveContact).map((cancel) => `${cancel.moveHit ? "MoveHit" : "MoveContact"}->${cancel.targetExpr || cancel.target}`).join(", ") || "-"}`);
    lines.push(`helper = ${(move.helperOwners || []).map((item) => `${item.ownerState}->${item.helperState}`).join(", ") || "-"}`);
    lines.push(`evidence = ${move.evidence || "-"}`);
    lines.push("");
  }
  lines.push("; AI_PATCH_INFERRED_MOVELIST_END");
  return lines.join("\n");
}

function upsertInferredMovelistBlock(existingText, blockText) {
  const text = String(existingText || "").replace(/\s*; AI_PATCH_INFERRED_MOVELIST_BEGIN[\s\S]*?; AI_PATCH_INFERRED_MOVELIST_END\s*/g, "").trimEnd();
  return `${text}${text ? "\n\n" : ""}${blockText.trim()}\n`;
}

function inferStateGroups(states) {
  const set = new Set(states);
  const has = (n) => set.has(n);
  return {
    guard: states.filter((n) => n >= 120 && n <= 155),
    parry: [760, 761, 762].filter(has),
    roll: [710, 715].filter(has),
    run: [100, 101, 102, 105, 106].filter(has),
    backDash: [715, 105].filter(has),
    charge: [730].filter(has),
    zeroCounter: [750].filter(has),
    normals: states.filter((n) => n >= 200 && n <= 699),
    specials: states.filter((n) => n >= 1000 && n <= 1999),
    supers: states.filter((n) => (n >= 2000 && n <= 4999) || (n >= 6000 && n <= 6999)),
  };
}

function resolveParryReadiness(states) {
  const has = (state) => states.includes(state);
  const pick = (candidates) => candidates.find(has) ?? null;
  return {
    stand: pick([6080, 1300, 760]),
    crouch: pick([6081, 1310, 761]),
    air: pick([6082, 1320, 762]),
  };
}

function buildMeterCandidates(comboScan, statePowerCosts) {
  const scanByState = new Map((comboScan?.states || []).map((item) => [item.state, item]));
  return Object.entries(statePowerCosts || {})
    .map(([stateText, cost]) => {
      const state = Number(stateText);
      const scan = scanByState.get(state);
      const reach = scan?.effectiveReach?.length ? scan.effectiveReach : scan?.reach || [];
      const reachMaxX = reach.length
        ? Math.max(...reach.map((item) => Number(item.maxX)).filter(Number.isFinite))
        : null;
      return {
        state,
        cost: cost.cost,
        bucket: cost.bucket,
        source: cost.source,
        role: scan?.role || (state >= 2000 ? "super" : state >= 1000 ? "special" : "meter"),
        hasHitDef: !!(scan?.hitDefs?.length || scan?.hitSummary || scan?.hasEffectiveHit),
        actions: scan?.actions || [],
        reach,
        reachMaxX,
        rangeClass: classifyMeterRangeClass(reachMaxX),
        closeOnly: Number.isFinite(reachMaxX) && reachMaxX <= 50,
        helperStates: scan?.helperStates || [],
        delivery: scan?.delivery || "unknown",
        timing: scan?.timing || null,
        scanWindow: scan?.scanWindow || scanWindowFromInfo(scan) || null,
        helperTravel: scan?.helperTravel || null,
        meterReliability: scan?.meterReliability || null,
        highCostFinisher: highCostFinisherPolicy(scan),
      };
    })
    .sort((a, b) => (a.cost - b.cost) || (a.state - b.state));
}

function buildComboHealth(comboScan, statePowerCosts) {
  const states = comboScan?.states || [];
  const routeCandidates = comboScan?.routeCandidates || [];
  const hasRole = (pattern) => states.some((item) => pattern.test(item.role || ""));
  const countRole = (pattern) => states.filter((item) => pattern.test(item.role || "")).length;
  const hasMeter = (minCost) => Object.values(statePowerCosts || {}).some((item) => item.cost >= minCost);
  const meterCount = (minCost) => Object.values(statePowerCosts || {}).filter((item) => item.cost >= minCost).length;
  const hasSpecialEdge = routeCandidates.some((edge) => /normal|low starter|launcher/i.test(edge.fromRole || "") && /special/i.test(edge.toRole || ""));
  const hasSuperEdge = routeCandidates.some((edge) => /special|normal|launcher/i.test(edge.fromRole || "") && /super/i.test(edge.toRole || ""));
  const normalChainEdges = routeCandidates.filter((edge) => /normal|low starter/i.test(edge.fromRole || "") && /normal|low starter|launcher/i.test(edge.toRole || ""));
  const healthItem = (id, ok, weak, detail) => ({
    id,
    status: ok ? "ok" : weak ? "weak" : "missing",
    detail,
  });
  const starterCount = countRole(/low starter|normal/);
  const specialCount = countRole(/special/);
  const airCount = countRole(/air normal/);
  const launcherCount = countRole(/launcher/);
  return [
    healthItem("Starter", starterCount > 0, false, starterCount ? `${starterCount} normal/low starter candidate(s)` : "no normal or low starter HitDef scanned"),
    healthItem("Normal chain", normalChainEdges.length > 0, hasRole(/normal|low starter/), normalChainEdges.length ? `${normalChainEdges.length} confirmed normal-chain edge(s)` : `${routeCandidates.length} total edge(s); no normal-chain edge confirmed`),
    healthItem("Special bridge", hasSpecialEdge, specialCount > 0, hasSpecialEdge ? "confirmed edge to special" : specialCount ? `${specialCount} special candidate(s), but no confirmed starter -> special edge` : "no special candidate with HitDef scanned"),
    healthItem("Super cashout", hasSuperEdge, hasMeter(1000), hasSuperEdge ? "confirmed edge to super" : hasMeter(1000) ? `${meterCount(1000)} meter state(s), but no confirmed route into super` : "no 1000+ power state scanned"),
    healthItem("Air follow-up", airCount > 0 && launcherCount > 0, airCount > 0 || launcherCount > 0, airCount && launcherCount ? `${airCount} air normal(s) and ${launcherCount} launcher(s) scanned` : airCount ? `${airCount} air normal(s), but no launcher route evidence` : launcherCount ? `${launcherCount} launcher(s), but no air normal follow-up evidence` : "no air route evidence"),
  ];
}

function buildPatchReadiness(profile, statePowerCosts, comboScan) {
  const cmdText = profile.absoluteFiles?.cmdText || "";
  const runtimeBridge = /AI_PATCH_BEGIN:\s*(?:boxer_bl:cmd_runtime_bridge_early|rockai_bl:rock_measurement_core)/i.test(cmdText)
    || /\bvar\(59\)\s*=\s*AILevel\b/i.test(cmdText);
  const parry = resolveParryReadiness(profile.states.all);
  const meterCandidates = buildMeterCandidates(comboScan, statePowerCosts);
  const superCandidates = meterCandidates.filter((item) => item.cost >= 1000);
  const auditProfile = {
    ...profile,
    states: { ...(profile.states || {}), powerCosts: statePowerCosts },
    comboScan,
  };
  const oldAiMeterRisks = scanOldAiMeterRangeRisks(auditProfile);
  const oldAiRepeatFarmRisks = scanOldAiRepeatFarmRisks(auditProfile);
  return {
    runtimeBridge,
    aiVariable: runtimeBridge ? "AILevel bridge detected" : (/\bAILevel\b/i.test(cmdText) ? "AILevel used by original AI" : "not detected"),
    parry,
    superCandidateCount: superCandidates.length,
    exCandidateCount: meterCandidates.filter((item) => item.cost === 500).length,
    comboHealth: buildComboHealth(comboScan, statePowerCosts),
    meterCandidates,
    oldAiMeterRisks,
    oldAiRepeatFarmRisks,
  };
}

function scanOldAiMeterPriorityAnchors(profile) {
  const cmdText = profile?.absoluteFiles?.cmdText || "";
  if (!cmdText) return [];
  const patchRanges = findPatchRanges(cmdText);
  const anchors = [];
  const seen = new Set();
  for (const controller of parseControllerBlocksWithOffsets(cmdText)) {
    if (!/^changestate$/i.test(controller.type || "")) continue;
    if (patchRanges.some((range) => controller.start >= range.start && controller.start < range.end)) continue;
    if (!looksLikeAiControlledCommandBlock(controller)) continue;
    const targets = expressionStateTargets(controller.params.value || "")
      .map(Number)
      .filter((state) => Number.isFinite(state) && (statePowerCost(profile, state)?.cost || 0) >= 1000);
    if (!targets.length) continue;
    const key = `${controller.heading}:${controller.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push({
      heading: controller.heading,
      state: targets[0],
      line: controller.line,
      anchor: controller.heading,
    });
  }
  return anchors.sort((a, b) => Number(a.line) - Number(b.line));
}

function oldAiMeterPriorityAnchor(profile) {
  const scanned = scanOldAiMeterPriorityAnchors(profile);
  const riskAnchors = (profile?.patchReadiness?.oldAiMeterRisks || [])
    .filter((risk) => risk?.heading && Number.isFinite(Number(risk.line)))
    .map((risk) => ({
      heading: risk.heading,
      state: risk.state,
      line: Number(risk.line),
      anchor: risk.heading,
    }));
  const first = [...riskAnchors, ...scanned]
    .sort((a, b) => Number(a.line) - Number(b.line))[0] || null;
  if (!first) return null;
  return {
    heading: first.heading,
    state: first.state,
    line: Number(first.line),
    anchor: first.heading,
    reason: `before old AI meter state ${first.state} at original line ${first.line}`,
  };
}

function shouldPrioritizeBeforeOldAiMeter(moduleId, content = "") {
  const id = String(moduleId || "");
  const source = String(content || "");
  if (/resolver_generated_combo_pool|meter_cashout|combo_meter|ground_route|wolverine_.*route|rock_ground_route|boss|cashout/i.test(id)) return true;
  if (/AI_PATCH_HIGH_COST_FINISHER|AI_PATCH_METER_POLICY|Power\s*>=\s*(?:1000|2000|3000)|value\s*=\s*(?:3\d{3}|[2-9]\d{3})/i.test(source)) return true;
  return false;
}

function withOldAiMeterPriority(operation, profile) {
  if (!operation || operation.fileRole !== "cmd") return operation;
  if (!shouldPrioritizeBeforeOldAiMeter(operation.moduleId, operation.content)) return operation;
  const anchor = oldAiMeterPriorityAnchor(profile);
  if (!anchor?.anchor) return operation;
  return {
    ...operation,
    priorityInsertBefore: [anchor.anchor],
    priorityInsertReason: anchor.reason,
  };
}

function parseP2DistanceBounds(triggerText, axis) {
  const text = String(triggerText || "");
  const axisPattern = String(axis || "X").toUpperCase() === "Y" ? "[Yy]" : "[Xx]";
  const distName = `P2(?:Body)?Dist\\s+${axisPattern}`;
  let lower = -Infinity;
  let upper = Infinity;
  let found = false;

  const rangeRegex = new RegExp(`\\b${distName}\\s*=\\s*\\[\\s*(-?\\d+)\\s*,\\s*(-?\\d+)\\s*\\]`, "gi");
  for (const match of text.matchAll(rangeRegex)) {
    const min = Number(match[1]);
    const max = Number(match[2]);
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
    lower = Math.max(lower, Math.min(min, max));
    upper = Math.min(upper, Math.max(min, max));
    found = true;
  }

  const compareRegex = new RegExp(`\\b${distName}\\s*(<=|>=|<|>|=)\\s*(-?\\d+)\\b(?!\\s*,)`, "gi");
  for (const match of text.matchAll(compareRegex)) {
    const op = match[1];
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    found = true;
    if (op === "<=") upper = Math.min(upper, value);
    else if (op === "<") upper = Math.min(upper, value - 1);
    else if (op === ">=") lower = Math.max(lower, value);
    else if (op === ">") lower = Math.max(lower, value + 1);
    else {
      lower = Math.max(lower, value);
      upper = Math.min(upper, value);
    }
  }

  if (!found) return null;
  return {
    min: Number.isFinite(lower) ? lower : null,
    max: Number.isFinite(upper) ? upper : null,
    hasLower: Number.isFinite(lower),
    hasUpper: Number.isFinite(upper),
  };
}

function aiOnlyOldMeterGuardLines(profile, state) {
  const cost = statePowerCost(profile, Number(state))?.cost || 0;
  return stateWindowGuardLines(profile, Number(state), { cost })
    .map((line) => {
      const trimmed = String(line || "").trim();
      if (!trimmed) return "";
      if (trimmed.startsWith(";")) return trimmed;
      const match = trimmed.match(/^triggerAll\s*=\s*(.+)$/i);
      if (!match) return trimmed;
      const expr = match[1].replace(/\s*;\s*AI_PATCH_STATE_WINDOW.*$/i, "").trim();
      if (expr === "0") return `triggerAll = !AILevel ; AI_PATCH_OLD_AI_METER_WINDOW ${state} unsafe_raw`;
      return `triggerAll = !AILevel || (${expr}) ; AI_PATCH_OLD_AI_METER_WINDOW ${state}`;
    })
    .filter(Boolean);
}

function oldAiMeterRiskReasons(profile, controller, state) {
  const info = stateScanInfo(profile, Number(state));
  const cost = statePowerCost(profile, Number(state))?.cost || 0;
  if (!isMeterStateForWindowGuard(profile, Number(state))) return [];
  const classification = meterReliabilityClass(info) || "";
  if (isUtilityReliabilityClass(classification)) return [];

  const triggerText = controllerTriggerText(controller);
  const xBounds = parseP2DistanceBounds(triggerText, "X");
  const yBounds = parseP2DistanceBounds(triggerText, "Y");
  const window = stateScanWindow(profile, Number(state));
  const tolerance = classification === "projectile" ? 24 : 6;
  const reasons = [];

  if (classification === "unsafe_raw") reasons.push("meter state is classified unsafe_raw");
  if (window) {
    if (!xBounds?.hasUpper) {
      reasons.push(`old AI has no upper P2BodyDist X gate; scan xMax is ${window.xMax}`);
    } else if (xBounds.max > window.xMax + tolerance) {
      reasons.push(`old AI X max ${xBounds.max} exceeds scanned xMax ${window.xMax}`);
    }
    if (!yBounds?.hasUpper && Math.abs(Number(window.yMin)) < 170) {
      reasons.push(`old AI has no P2 Y gate; scan y window is ${window.yMin}..${window.yMax}`);
    }
  } else if (cost >= 1000 && classification !== "projectile") {
    reasons.push("meter state has no scanned x/y hit window");
  }
  if (classification === "close_confirm" && !/\bMoveHit\b|\bMoveContact\b/i.test(triggerText)) {
    reasons.push("close_confirm meter is callable without MoveHit/MoveContact confirm");
  }
  const highCost = highCostFinisherPolicy(info);
  if (highCost) {
    if (!highCostHasRequiredConfirmGate(triggerText, highCost)) {
      const lethalText = highCost.killLifeMax
        ? ` or lethal punish gate (EnemyNear,Life <= ${highCost.killLifeMax}, !EnemyNear,Ctrl, EnemyNear,MoveType=A, no guard)`
        : "";
      reasons.push(`3000-power finisher needs hard hitstun gate (!EnemyNear,Ctrl, EnemyNear,MoveType=H, GetHitVar(HitTime)>=${highCost.minHitTime})${lethalText}`);
    }
  }
  if (classification === "grab" && xBounds?.hasUpper && xBounds.max > 45) {
    reasons.push(`grab/point-blank meter has old AI X max ${xBounds.max}`);
  }
  const pushbackSources = blockRouteSourceStates(profile, controller.body || "")
    .filter((source) => source !== Number(state))
    .filter((source) => routeSpacingCompatibility(profile, source, Number(state)).risk === "high");
  if (pushbackSources.length) {
    reasons.push(`cancel flag can route pushback source ${pushbackSources.slice(0, 8).join("/")} into meter state ${state}`);
  }
  return uniqueValues(reasons);
}

function hasPositiveAiLevelGate(controller) {
  const body = `${controller?.heading || ""}\n${controller?.body || ""}`;
  const stripped = body.split(/\r?\n/).map((line) => stripInlineComment(line)).join("\n");
  if (/\bvar\(\s*59\s*\)/i.test(stripped)) return true;
  for (const match of stripped.matchAll(/\bAILevel\b/gi)) {
    const before = stripped.slice(Math.max(0, match.index - 3), match.index);
    if (!/!\s*$/i.test(before)) return true;
  }
  return false;
}

function oldAiRepeatFarmGuardLines(profile, state) {
  const info = stateScanInfo(profile, Number(state));
  const minHitTime = Math.max(4, Math.min(10, Number(info?.timing?.startup || 4) + 2));
  return [
    `; AI_PATCH_OLD_AI_REPEAT_FARM ${state}: old AI normal/power-gain state is hit-confirm only under patched AI`,
    `triggerAll = !AILevel || MoveHit || MoveContact || (!EnemyNear,Ctrl && EnemyNear,MoveType = H && EnemyNear,GetHitVar(HitTime) >= ${minHitTime}) ; AI_PATCH_OLD_AI_REPEAT_FARM ${state}`,
    `triggerAll = !AILevel || StateNo != ${state} ; AI_PATCH_OLD_AI_REPEAT_FARM ${state}`,
    `triggerAll = !AILevel || PrevStateNo != ${state} || MoveHit || MoveContact ; AI_PATCH_OLD_AI_REPEAT_FARM ${state}`,
  ];
}

function scanOldAiRepeatFarmRisks(profile) {
  const cmdText = profile?.absoluteFiles?.cmdText || "";
  if (!cmdText) return [];
  const stripped = removeAiPatchBlocks(cmdText);
  const risks = [];
  const seen = new Set();
  for (const controller of parseControllerBlocksWithOffsets(stripped)) {
    if (!/^changestate$/i.test(controller.type || "")) continue;
    if (/AI_PATCH_OLD_AI_REPEAT_FARM|AI_PATCH_BEGIN|AI_PATCH_END/i.test(controller.body)) continue;
    if (!hasPositiveAiLevelGate(controller)) continue;
    const valueExpr = controller.params.value || "";
    const targets = expressionStateTargets(valueExpr)
      .map(Number)
      .filter((state) => isRepeatFarmRiskState(profile, state));
    for (const state of uniqueValues(targets)) {
      const triggerText = controllerTriggerText(controller);
      const hasConfirmGate = /\bMoveHit\b|\bMoveContact\b|EnemyNear\s*,\s*GetHitVar\s*\(\s*HitTime\s*\)|EnemyNear\s*,\s*MoveType\s*=\s*H/i.test(triggerText);
      const hasNeutralCtrlGate = /\bctrl\b/i.test(triggerText) || /\bCtrl\b/i.test(triggerText);
      if (hasConfirmGate && !hasNeutralCtrlGate) continue;
      const key = `${controller.heading}:${state}:${controller.line}:${normalizedControllerTriggerKey(triggerText)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const info = stateScanInfo(profile, state);
      risks.push({
        state,
        heading: controller.heading,
        line: controller.line,
        valueExpr,
        triggerText,
        triggerKey: normalizedControllerTriggerKey(triggerText),
        reason: `old AI can call power-gain normal/root attack state ${state}${hasNeutralCtrlGate ? " from neutral/control" : ""}; patched AI should use hit-confirm only to avoid power-farm loops`,
        role: info?.role || "",
        roleFamily: info?.roleFamily || "",
        powerGainSignals: info?.powerGainSignals || [],
        guardLines: oldAiRepeatFarmGuardLines(profile, state),
      });
    }
  }
  return risks;
}

function normalizedControllerTriggerKey(controllerOrText) {
  const text = typeof controllerOrText === "string" ? controllerOrText : controllerTriggerText(controllerOrText);
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function looksLikeAiControlledCommandBlock(controller) {
  const body = `${controller?.heading || ""}\n${controller?.body || ""}`;
  if (/\bAILevel\b|\bvar\(\s*59\s*\)|\bIsHelper\b|\bEnemyNear\b|\bRandom\b|\bP2BodyDist\b|\bP2Dist\b|\bMoveHit\b|\bMoveContact\b/i.test(body)) return true;
  if (/\bcommand\s*=\s*"/i.test(body) && !/\bAILevel\b|\bvar\(\s*59\s*\)|\bRandom\b/i.test(body)) return false;
  return /\bvar\(\s*\d+\s*\)\b/i.test(body);
}

function scanOldAiMeterRangeRisks(profile) {
  const cmdText = profile?.absoluteFiles?.cmdText || "";
  if (!cmdText) return [];
  const stripped = removeAiPatchBlocks(cmdText);
  const risks = [];
  const seen = new Set();
  for (const controller of parseControllerBlocksWithOffsets(stripped)) {
    if (!/^changestate$/i.test(controller.type || "")) continue;
    if (/AI_PATCH_BEGIN|AI_PATCH_END/i.test(controller.body)) continue;
    if (!looksLikeAiControlledCommandBlock(controller)) continue;
    const valueExpr = controller.params.value || "";
    const targets = expressionStateTargets(valueExpr)
      .map(Number)
      .filter((state) => Number.isFinite(state) && isMeterStateForWindowGuard(profile, state));
    for (const state of uniqueValues(targets)) {
      const reasons = oldAiMeterRiskReasons(profile, controller, state);
      if (!reasons.length) continue;
      const key = `${controller.heading}:${state}:${controller.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const info = stateScanInfo(profile, state);
      const cost = statePowerCost(profile, state)?.cost || 0;
      const triggerText = controllerTriggerText(controller);
      const guardLines = uniqueValues([
        ...aiOnlyOldMeterGuardLines(profile, state),
        ...blockRouteSourceStates(profile, controller.body || "")
          .filter((source) => source !== Number(state))
          .flatMap((source) => routeSpacingGuardLines(profile, source, Number(state))),
      ]);
      if (/AI_PATCH_OLD_AI_METER_WINDOW/i.test(controller.body) && !guardLines.some((line) => !controller.body.includes(line))) continue;
      risks.push({
        state,
        cost,
        classification: meterReliabilityClass(info) || "",
        rangeClass: meterStateRangeClass(profile, state),
        delivery: info?.delivery || "unknown",
        scanWindow: stateScanWindow(profile, state),
        triggerWindow: {
          x: parseP2DistanceBounds(triggerText, "X"),
          y: parseP2DistanceBounds(triggerText, "Y"),
        },
        heading: controller.heading,
        line: controller.line,
        valueExpr,
        triggerText,
        triggerKey: normalizedControllerTriggerKey(triggerText),
        reason: reasons.join("; "),
        reasons,
        guardLines,
      });
    }
  }
  return risks;
}

function parseAirActions(text) {
  const actions = {};
  const actionRegex = /\[Begin Action\s+(-?\d+)\]([\s\S]*?)(?=\n\s*\[Begin Action\s+-?\d+\]|\s*$)/gi;
  for (const actionMatch of text.matchAll(actionRegex)) {
    const action = Number(actionMatch[1]);
    const body = actionMatch[2];
    const bodyStart = actionMatch.index + actionMatch[0].indexOf(body);
    const lines = body.split(/\r?\n/);
    const newline = detectNewline(text);
    const lineStarts = [];
    let cursor = bodyStart;
    for (const line of lines) {
      lineStarts.push(cursor);
      cursor += line.length + newline.length;
    }

    const frames = [];
    const pending = { Clsn1: [], Clsn2: [] };
    let currentType = null;
    let frameIndex = -1;

    lines.forEach((line, lineIndex) => {
      const typeMatch = line.match(/^\s*Clsn([12])\s*:\s*\d+/i);
      if (typeMatch) {
        currentType = `Clsn${typeMatch[1]}`;
        pending[currentType] = [];
        return;
      }

      const boxMatch = line.match(/^\s*Clsn([12])\[(\d+)\]\s*=\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/i);
      if (boxMatch) {
        const type = `Clsn${boxMatch[1]}`;
        currentType = type;
        pending[type].push({
          type,
          boxIndex: Number(boxMatch[2]),
          coords: [Number(boxMatch[3]), Number(boxMatch[4]), Number(boxMatch[5]), Number(boxMatch[6])],
          lineIndex,
          lineStart: lineStarts[lineIndex],
          lineText: line,
        });
        return;
      }

      const spriteMatch = line.match(/^\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/);
      if (spriteMatch) {
        frameIndex += 1;
        frames.push({
          frameIndex,
          sprite: {
            group: Number(spriteMatch[1]),
            image: Number(spriteMatch[2]),
            x: Number(spriteMatch[3]),
            y: Number(spriteMatch[4]),
            time: Number(spriteMatch[5]),
          },
          boxes: {
            Clsn1: pending.Clsn1.map((box) => ({ ...box })),
            Clsn2: pending.Clsn2.map((box) => ({ ...box })),
          },
        });
      }
    });

    const clsn1Boxes = frames.flatMap((frame) => frame.boxes.Clsn1);
    const clsn2Boxes = frames.flatMap((frame) => frame.boxes.Clsn2);
    const clsn1Reach = clsn1Boxes.reduce((acc, box) => ({
      minX: Math.min(acc.minX, box.coords[0], box.coords[2]),
      maxX: Math.max(acc.maxX, box.coords[0], box.coords[2]),
      minY: Math.min(acc.minY, box.coords[1], box.coords[3]),
      maxY: Math.max(acc.maxY, box.coords[1], box.coords[3]),
    }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });

    actions[action] = {
      action,
      frameCount: frames.length,
      totalTime: frames.reduce((sum, frame) => sum + Math.max(1, Number(frame.sprite?.time) || 1), 0),
      clsn1Count: clsn1Boxes.length,
      clsn2Count: clsn2Boxes.length,
      reach: clsn1Boxes.length ? clsn1Reach : null,
      frames,
    };
  }
  return actions;
}

function parseAirReach(text) {
  const actions = {};
  const actionRegex = /\[Begin Action\s+(-?\d+)\]([\s\S]*?)(?=\n\s*\[Begin Action\s+-?\d+\]|\s*$)/gi;
  for (const match of text.matchAll(actionRegex)) {
    const action = Number(match[1]);
    const body = match[2];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let clsn1Count = 0;
    for (const box of body.matchAll(/Clsn1\[\d+\]\s*=\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/gi)) {
      const xs = [Number(box[1]), Number(box[3])];
      const ys = [Number(box[2]), Number(box[4])];
      minX = Math.min(minX, ...xs);
      maxX = Math.max(maxX, ...xs);
      minY = Math.min(minY, ...ys);
      maxY = Math.max(maxY, ...ys);
      clsn1Count += 1;
    }
    if (clsn1Count) actions[action] = { minX, maxX, minY, maxY, clsn1Count };
  }
  return actions;
}

function resolveRelative(baseDir, maybeRelative) {
  if (!maybeRelative) return null;
  const cleaned = maybeRelative.replace(/^"|"$/g, "").trim();
  return path.isAbsolute(cleaned) ? cleaned : path.join(baseDir, cleaned);
}

async function scanCharacter(characterPath) {
  const absCharacterPath = path.resolve(characterPath);
  if (!await pathExists(absCharacterPath)) {
    throw new Error(`Character path does not exist: ${absCharacterPath}`);
  }

  const allFiles = await listFilesRecursive(absCharacterPath);
  const defFile = allFiles.find((file) => path.extname(file).toLowerCase() === ".def");
  if (!defFile) throw new Error("No .def file found in character folder");

  const defText = await readText(defFile);
  const def = parseDef(defText);
  const filePaths = { def: defFile, cmd: null, air: null, cns: [], st: [] };

  filePaths.cmd = resolveRelative(absCharacterPath, def.files.cmd);
  filePaths.air = resolveRelative(absCharacterPath, def.files.anim || def.files.air);

  for (const [key, value] of Object.entries(def.files)) {
    if (key === "cns" || key === "st" || /^st\d+$/.test(key)) {
      const resolved = resolveRelative(absCharacterPath, value);
      if (resolved) filePaths[key === "cns" ? "cns" : "st"].push(resolved);
    }
  }

  const candidateTextFiles = [
    filePaths.cmd,
    filePaths.air,
    ...filePaths.cns,
    ...filePaths.st,
  ].filter(Boolean);

  const existingTextFiles = [];
  for (const file of candidateTextFiles) {
    if (await pathExists(file) && textExts.has(path.extname(file).toLowerCase())) {
      existingTextFiles.push(file);
    }
  }

  const texts = [];
  for (const file of existingTextFiles) {
    texts.push({ file, text: await readText(file) });
  }
  const combined = texts.map((item) => item.text).join("\n");

  const varSlots = classifyVariableSlots(combined, "var", 59);
  const fvarSlots = classifyVariableSlots(combined, "fvar", 39);
  const usedVars = varSlots.used;
  const usedFVars = fvarSlots.used;
  const commandText = filePaths.cmd && await pathExists(filePaths.cmd) ? await readText(filePaths.cmd) : "";
  const commands = parseCommands(commandText);
  const movelistPath = allFiles.find((file) => path.basename(file).toLowerCase() === "movelist.txt") || path.join(absCharacterPath, "Movelist.txt");
  const movelistText = await pathExists(movelistPath) ? await readText(movelistPath) : "";
  const states = [...new Set(texts.flatMap((item) => parseStates(item.text)))].sort((a, b) => a - b);
  const stateGroups = inferStateGroups(states);
  const statePowerCosts = {};
  for (const item of texts.filter((textItem) => [".cmd", ".cns", ".st"].includes(path.extname(textItem.file).toLowerCase()))) {
    Object.assign(statePowerCosts, parseStatePowerCosts(item.text));
  }
  const inferredPowerCosts = {
    1430: 500,
    2000: 1000,
    2050: 1000,
    2900: 1000,
    2910: 1000,
    3000: 1000,
    3005: 1000,
    3050: 2000,
    3100: 2000,
    3101: 2000,
    3115: 2000,
    4000: 3000,
    4001: 3000,
    4002: 3000,
    4011: 3000,
    4015: 3000,
    4020: 3000,
  };
  for (const [state, cost] of Object.entries(inferredPowerCosts)) {
    if (states.includes(Number(state)) && !statePowerCosts[state]) {
      statePowerCosts[state] = { cost, bucket: classifyPowerCost(cost), source: "brain_convention" };
    }
  }
  let airReach = {};
  let airActions = {};
  if (filePaths.air && await pathExists(filePaths.air)) {
    const airText = await readText(filePaths.air);
    airReach = parseAirReach(airText);
    airActions = parseAirActions(airText);
  }
  const stateTexts = texts.filter((item) => [".cns", ".st"].includes(path.extname(item.file).toLowerCase()));
  const stateTraits = parseStateTraits(stateTexts, airActions);
  const stateActionMap = parseStateActionMap(stateTexts);

  const varComments = {};
  const fvarComments = {};
  for (const item of texts) {
    Object.assign(varComments, parseVarComments(item.text, "var"));
    Object.assign(fvarComments, parseVarComments(item.text, "fvar"));
  }
  const comboScan = parseComboScan(stateTexts, stateActionMap, airReach, statePowerCosts, stateTraits, airActions);
  const helperLinks = parseHelperLinks(stateTexts);
  applyHelperEffectiveReach(comboScan, helperLinks);
  const inferredMovelist = buildInferredMovelist(commandText, movelistText, comboScan, airActions);
  const cancelFlagSources = parseCancelFlagSources(stateTexts, states);
  const cmdRouteEdges = parseCmdRouteEdges(commandText, comboScan);
  const cancelFlagRouteEdges = parseCancelFlagRouteEdges(commandText, comboScan, cancelFlagSources);
  comboScan.cancelFlagSources = cancelFlagSources;
  comboScan.cmdRouteEdges = [...cmdRouteEdges, ...cancelFlagRouteEdges];
  mergeRouteCandidates(comboScan, comboScan.cmdRouteEdges);
  const dependencyTexts = texts.filter((item) => [".cmd", ".cns", ".st"].includes(path.extname(item.file).toLowerCase()));
  const stateDependencyGraph = parseStateDependencyGraph(stateTexts, commandText, comboScan, stateTraits, states);
  const varOwnershipMap = parseVarOwnershipMap(dependencyTexts);
  const patchReadiness = buildPatchReadiness({
    states: { all: states },
    absoluteFiles: { cmdText: commandText },
  }, statePowerCosts, comboScan);

  const freeVars = varSlots.free;
  const freeFVars = fvarSlots.free;

  return {
    name: def.info.displayname || def.info.name || path.basename(absCharacterPath),
    characterPath: absCharacterPath,
    files: {
      def: path.relative(absCharacterPath, filePaths.def),
      cmd: filePaths.cmd ? path.relative(absCharacterPath, filePaths.cmd) : null,
      air: filePaths.air ? path.relative(absCharacterPath, filePaths.air) : null,
      movelist: await pathExists(movelistPath) ? path.relative(absCharacterPath, movelistPath) : null,
      cns: filePaths.cns.map((file) => path.relative(absCharacterPath, file)),
      st: filePaths.st.map((file) => path.relative(absCharacterPath, file)),
    },
    absoluteFiles: {
      def: filePaths.def,
      cmd: filePaths.cmd,
      cmdText: commandText,
      air: filePaths.air,
      movelist: movelistPath,
      cns: filePaths.cns,
      st: filePaths.st,
    },
    vars: { ...varSlots, comments: varComments },
    fvars: { ...fvarSlots, comments: fvarComments },
    commands: { available: commands, count: commands.length },
    patchMappings: {
      var: parsePatchMappings(combined, "var"),
      fvar: parsePatchMappings(combined, "fvar"),
    },
    states: { all: states, groups: stateGroups, powerCosts: statePowerCosts },
    stateTraits,
    patchReadiness,
    comboScan,
    inferredMovelist,
    stateDependencyGraph,
    varOwnershipMap,
    airReach,
    stateActionMap,
    airActions,
  };
}

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const data = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].replace(/^"|"$/g, "");
    if (value === ">" || value === "|") {
      const folded = [];
      let j = i + 1;
      while (j < lines.length && !/^[A-Za-z0-9_-]+:\s*/.test(lines[j])) {
        if (lines[j].trim()) folded.push(lines[j].trim());
        j += 1;
      }
      data[key] = value === ">" ? folded.join(" ") : folded.join("\n");
      i = j - 1;
    } else {
      data[key] = value;
    }
  }
  return data;
}

function parseSimpleYamlList(block, rootKey) {
  const lines = block.split(/\r?\n/);
  const rootIndex = lines.findIndex((line) => line.trim() === `${rootKey}:`);
  if (rootIndex < 0) return [];
  const items = [];
  let current = null;
  for (const rawLine of lines.slice(rootIndex + 1)) {
    if (/^[A-Za-z0-9_-]+:\s*$/.test(rawLine.trim()) && !rawLine.startsWith(" ")) break;
    const line = rawLine.replace(/\t/g, "  ");
    const itemMatch = line.match(/^\s*-\s+id:\s*(.+?)\s*$/);
    if (itemMatch) {
      if (current) items.push(current);
      current = { id: itemMatch[1].trim() };
      continue;
    }
    if (!current) continue;
    const kv = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2];
    if (/^-?\d+$/.test(value)) value = Number(value);
    current[key] = value;
  }
  if (current) items.push(current);
  return items;
}

function parseCommandAliases(block) {
  const items = parseSimpleYamlList(block, "commands");
  return items.map((item) => ({
    ...item,
    preferred: String(item.preferred || "")
      .split(",")
      .map((value) => value.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean),
  }));
}

function parseScalar(value) {
  const trimmed = String(value || "").trim();
  const unquoted = trimmed.replace(/^["']|["']$/g, "");
  if (/^-?\d+$/.test(unquoted)) return Number(unquoted);
  if (/^(true|false)$/i.test(unquoted)) return /^true$/i.test(unquoted);
  return unquoted;
}

function parseSimpleYamlObject(block) {
  const out = {};
  let currentKey = null;
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const root = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (root) {
      currentKey = root[1];
      out[currentKey] = root[2] ? parseScalar(root[2]) : [];
      continue;
    }

    const item = line.match(/^\s+-\s+(.*?)\s*$/);
    if (item && currentKey) {
      if (!Array.isArray(out[currentKey])) out[currentKey] = [];
      out[currentKey].push(parseScalar(item[1]));
    }
  }
  return out;
}

function parseRoutePreviewBlocks(block) {
  const previews = [];
  const lines = block.split(/\r?\n/);
  const rootIndex = lines.findIndex((line) => line.trim() === "route_preview:");
  if (rootIndex < 0) return previews;

  let current = null;
  let currentListKey = null;
  for (const rawLine of lines.slice(rootIndex + 1)) {
    const line = rawLine.replace(/\t/g, "  ");
    if (/^[A-Za-z0-9_-]+:\s*$/.test(line.trim()) && !line.startsWith(" ")) break;

    const newPreview = line.match(/^\s*-\s+id:\s*(.*?)\s*$/);
    if (newPreview) {
      if (current) previews.push(current);
      current = { id: parseScalar(newPreview[1]) };
      currentListKey = null;
      continue;
    }
    if (!current) continue;

    const kv = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (kv) {
      currentListKey = null;
      if (kv[2]) current[kv[1]] = parseScalar(kv[2]);
      else {
        current[kv[1]] = [];
        currentListKey = kv[1];
      }
      continue;
    }

    const listItem = line.match(/^\s+-\s+(.*?)\s*$/);
    if (listItem && currentListKey) current[currentListKey].push(parseScalar(listItem[1]));
  }

  if (current) previews.push(current);
  return previews;
}

function parseRemoveBlocks(block) {
  const rules = [];
  const lines = block.split(/\r?\n/);
  const rootIndex = lines.findIndex((line) => line.trim() === "remove_blocks:");
  if (rootIndex < 0) return rules;

  let current = null;
  let currentListKey = null;
  for (const rawLine of lines.slice(rootIndex + 1)) {
    const line = rawLine.replace(/\t/g, "  ");
    const newRule = line.match(/^\s*-\s+file:\s*(.*?)\s*$/);
    if (newRule) {
      if (current) rules.push(current);
      current = { file: parseScalar(newRule[1]), match_any: [] };
      currentListKey = null;
      continue;
    }
    if (!current) continue;

    const kv = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (kv) {
      currentListKey = null;
      if (kv[2]) current[kv[1]] = parseScalar(kv[2]);
      else {
        current[kv[1]] = [];
        currentListKey = kv[1];
      }
      continue;
    }

    const listItem = line.match(/^\s+-\s+(.*?)\s*$/);
    if (listItem && currentListKey) current[currentListKey].push(parseScalar(listItem[1]));
  }

  if (current) rules.push(current);
  return rules;
}

function indentationOf(line) {
  return (String(line || "").match(/^\s*/) || [""])[0].length;
}

function parseInlineList(value) {
  const text = String(value || "").trim();
  if (!text.startsWith("[") || !text.endsWith("]")) return null;
  return text.slice(1, -1)
    .split(",")
    .map((item) => parseScalar(item.trim()))
    .filter((item) => item !== "");
}

function parseLiteFitMetadata(blocks) {
  const modulePolicy = [];
  const fallbackTriggers = {};
  const bossProfiles = {};
  const sourceScan = {};
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.replace(/\t/g, "  "));
    let section = null;
    let current = null;
    let currentListKey = null;
    let fallbackGroup = null;
    let bossProfile = null;
    let sourceSubsection = null;

    for (const rawLine of lines) {
      const line = rawLine;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const indent = indentationOf(line);

      if (indent === 0) {
        section = null;
        current = null;
        currentListKey = null;
        fallbackGroup = null;
        bossProfile = null;
        sourceSubsection = null;
        if (trimmed === "lite_fit:") section = "lite_fit";
        else if (trimmed === "fallback_triggers:") section = "fallback_triggers";
        else if (trimmed === "boss_profiles:") section = "boss_profiles";
        else if (trimmed === "source_scan:") section = "source_scan";
        continue;
      }

      if (section === "lite_fit") {
        if (indent === 2 && trimmed === "module_policy:") {
          current = null;
          currentListKey = null;
          continue;
        }
        const newPolicy = line.match(/^\s{4}-\s+id:\s*(.*?)\s*$/);
        if (newPolicy) {
          current = { id: parseScalar(newPolicy[1]), optionalVars: [], minVars: [], fallback: {} };
          modulePolicy.push(current);
          currentListKey = null;
          continue;
        }
        if (!current) continue;
        const kv = line.match(/^\s{6}([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
        if (kv) {
          const key = kv[1];
          const inlineList = parseInlineList(kv[2]);
          if (key === "min_vars") current.minVars = inlineList || [];
          else if (key === "optional_vars") current.optionalVars = inlineList || [];
          else if (key === "fallback") current.fallback = {};
          else if (kv[2]) current[key] = parseScalar(kv[2]);
          currentListKey = (!kv[2] && ["min_vars", "optional_vars"].includes(key)) ? key : null;
          continue;
        }
        const nested = line.match(/^\s{8}([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
        if (nested && current) {
          if (!current.fallback) current.fallback = {};
          current.fallback[nested[1]] = parseScalar(nested[2]);
          currentListKey = null;
          continue;
        }
        const listItem = line.match(/^\s{8}-\s+(.*?)\s*$/);
        if (listItem && current && currentListKey) {
          const key = currentListKey === "min_vars" ? "minVars" : "optionalVars";
          current[key].push(parseScalar(listItem[1]));
        }
        continue;
      }

      if (section === "fallback_triggers") {
        const group = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*$/);
        if (group) {
          fallbackGroup = group[1];
          fallbackTriggers[fallbackGroup] = {};
          continue;
        }
        const kv = line.match(/^\s{4}([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
        if (kv && fallbackGroup) fallbackTriggers[fallbackGroup][kv[1]] = parseScalar(kv[2]);
        continue;
      }

      if (section === "boss_profiles") {
        const group = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*$/);
        if (group) {
          bossProfile = group[1];
          bossProfiles[bossProfile] = {};
          continue;
        }
        const kv = line.match(/^\s{4}([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
        if (kv && bossProfile) bossProfiles[bossProfile][kv[1]] = parseScalar(kv[2]);
        continue;
      }

      if (section === "source_scan") {
        const subsection = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
        if (subsection) {
          if (subsection[2]) {
            sourceScan[subsection[1]] = parseScalar(subsection[2]);
            sourceSubsection = null;
          } else {
            sourceSubsection = subsection[1];
            sourceScan[sourceSubsection] = {};
          }
          continue;
        }
        const kv = line.match(/^\s{4}([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
        if (kv && sourceSubsection) {
          const inlineList = parseInlineList(kv[2]);
          sourceScan[sourceSubsection][kv[1]] = inlineList || parseScalar(kv[2]);
        }
      }
    }
  }
  return { modulePolicy, fallbackTriggers, bossProfiles, sourceScan };
}

function extractFencedBlocks(text, lang) {
  const blocks = [];
  const regex = new RegExp("```" + lang + "\\r?\\n([\\s\\S]*?)\\r?\\n```", "g");
  for (const match of text.matchAll(regex)) blocks.push(match[1]);
  return blocks;
}

function parseBrain(text, brainPath = null) {
  const frontmatter = parseFrontmatter(text);
  const yamlBlocks = extractFencedBlocks(text, "yaml");
  const variables = [];
  const fvariables = [];
  const states = [];
  const ranges = [];
  const commands = [];
  for (const block of yamlBlocks) {
    variables.push(...parseSimpleYamlList(block, "variables"));
    fvariables.push(...parseSimpleYamlList(block, "fvariables"));
    states.push(...parseSimpleYamlList(block, "states"));
    ranges.push(...parseSimpleYamlList(block, "ranges"));
    commands.push(...parseCommandAliases(block));
  }

  const modules = [];
  const liteFit = parseLiteFitMetadata(yamlBlocks);
  const headings = [...text.matchAll(/^## Module:\s*(.+?)\s*$/gm)].map((match) => ({
    id: match[1].trim(),
    index: match.index,
    end: match.index + match[0].length,
  }));
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    const next = headings[i + 1]?.index ?? text.length;
    const id = heading.id;
    const body = text.slice(heading.end, next);
    const templateBlocks = extractFencedBlocks(body, "mugen-template");
    const yaml = extractFencedBlocks(body, "yaml");
    modules.push({
      id,
      risk: (body.match(/risk:\s*(\w+)/) || [null, "unknown"])[1],
      templates: templateBlocks,
      yaml,
      routePreview: yaml.flatMap(parseRoutePreviewBlocks),
      removeRules: yaml.flatMap(parseRemoveBlocks),
    });
  }

  return {
    path: brainPath,
    frontmatter,
    variables,
    fvariables,
    states,
    ranges,
    commands,
    modules,
    liteFit,
  };
}

function findCompatibleVar(item, profile, kind) {
  const comments = kind === "fvar" ? profile.fvars.comments : profile.vars.comments;
  const purpose = String(item.purpose || item.id || "").toLowerCase();
  for (const [num, comment] of Object.entries(comments)) {
    const lower = String(comment).toLowerCase();
    if (lower.includes(item.id.toLowerCase()) || purpose.split(/\W+/).some((token) => token.length > 4 && lower.includes(token))) {
      return Number(num);
    }
  }
  return null;
}

function findExistingPatchMapping(item, profile, kind) {
  const direct = profile.patchMappings?.[kind]?.[item.id];
  if (direct !== undefined) return Number(direct);
  const comments = kind === "fvar" ? profile.fvars.comments : profile.vars.comments;
  const expected = `AI_PATCH_${kind.toUpperCase()} ${String(item.id || "").toLowerCase()}`;
  for (const [num, comment] of Object.entries(comments)) {
    if (String(comment).toLowerCase() === expected) return Number(num);
  }
  return null;
}

function resolveNumberItem(item, profile, kind, allocated = new Set(), approvedPool = null) {
  const slots = kind === "fvar" ? profile.fvars : profile.vars;
  const approvedMap = approvedPoolMap(approvedPool);
  const baseUsed = slots.usedActive || slots.used || [];
  const used = [...new Set([...baseUsed, ...allocated])];
  const baseFree = slots.softFree || slots.free || [];
  const free = baseFree.filter((value) => !allocated.has(value));
  const preferred = Number(item.preferred);
  const conflict = item.conflict || "auto_remap";
  const existingPatch = findExistingPatchMapping(item, profile, kind);
  if (existingPatch !== null) {
    allocated.add(existingPatch);
    return { id: item.id, actual: `${kind}(${existingPatch})`, number: existingPatch, preferred, strategy: "existing_patch_mapping", status: "resolved" };
  }
  const compatible = conflict === "reuse_compatible" ? findCompatibleVar(item, profile, kind) : null;
  if (compatible !== null) {
    allocated.add(compatible);
    return { id: item.id, actual: `${kind}(${compatible})`, number: compatible, preferred, strategy: "reuse_compatible", status: "resolved" };
  }
  if (!used.includes(preferred)) {
    allocated.add(preferred);
    return { id: item.id, actual: `${kind}(${preferred})`, number: preferred, preferred, strategy: "preferred_free", status: "resolved" };
  }
  const approvedForItem = [...approvedMap.values()]
    .filter((entry) => entry.kind === kind && !allocated.has(entry.number))
    .find((entry) => !entry.approvedFor || entry.approvedFor === item.id);
  if (approvedForItem) {
    allocated.add(approvedForItem.number);
    return {
      id: item.id,
      actual: `${kind}(${approvedForItem.number})`,
      number: approvedForItem.number,
      preferred,
      strategy: "manual_approved_pool",
      status: "resolved",
      warning: "manual approved variable; verify ownership before apply",
    };
  }
  if (conflict === "manual_choose") {
    return { id: item.id, actual: null, number: null, preferred, strategy: "manual_choose", status: "conflict", options: free.slice(0, 12) };
  }
  if (conflict === "abort_patch") {
    return { id: item.id, actual: null, number: null, preferred, strategy: "abort_patch", status: "conflict" };
  }
  const chosen = free[0];
  if (chosen === undefined) {
    return { id: item.id, actual: null, number: null, preferred, strategy: "auto_remap", status: "conflict", reason: "no free slots" };
  }
  allocated.add(chosen);
  return { id: item.id, actual: `${kind}(${chosen})`, number: chosen, preferred, strategy: "auto_remap", status: "resolved" };
}

function compatibleStateCandidates(item) {
  const id = String(item.id || "").toLowerCase();
  const purpose = String(item.purpose || "").toLowerCase();
  if (id === "power_charge" || /power charge/.test(purpose)) return [730];
  if (id === "parry_stand" || id === "stand_parry" || /standing parry/.test(purpose)) return [6080, 1300, 760];
  if (id === "parry_crouch" || id === "crouch_parry" || /crouch(?:ing)? parry/.test(purpose)) return [6081, 1310, 761];
  if (id === "parry_air" || id === "air_parry" || /air parry|aerial parry/.test(purpose)) return [6082, 1320, 762];
  if (id === "max_mode" || /max mode|custom combo/.test(purpose)) return [770, 900, 905];
  if (id === "roll_forward" || /forward roll|roll-through/.test(purpose)) return [710, 100, 105, 700];
  if (id === "roll_back" || /back roll|spacing reset|back dash/.test(purpose)) return [715, 105, 100, 700];
  return [];
}

function detectNativePowerCharge(profile) {
  const states = profile.comboScan?.states || [];
  const byState = new Map(states.map((info) => [Number(info.state), info]));
  const routeEdges = profile.comboScan?.routeCandidates || [];
  const hasControllerType = (controllers, pattern) => (controllers || [])
    .some((controller) => pattern.test(String(controller.type || "")));
  const visibleChargeEvidence = (controllers) => hasControllerType(controllers, /^(PlaySnd|Explod|PalFX|EnvShake)$/i);
  const cleanupEvidence = (controllers) => hasControllerType(controllers, /^(StopSnd|RemoveExplod)$/i);
  const chooseStartState = (holdState) => {
    const candidates = routeEdges
      .filter((edge) => Number(edge.to) === Number(holdState))
      .map((edge) => byState.get(Number(edge.from)))
      .filter((info) => info && !scanStateHasHit(info) && !info.helperOnly)
      .map((info) => {
        let score = 0;
        if (Number(info.state) === Number(holdState) - 1) score += 160;
        if (visibleChargeEvidence(info.reusableControllers)) score += 120;
        if (Number(info.state) >= 10000 && Number(info.state) <= 11999) score += 40;
        if (info.powerGain || (info.powerGainSignals || []).length) score -= 40;
        return { info, score };
      })
      .sort((a, b) => b.score - a.score || Number(a.info.state) - Number(b.info.state));
    if (candidates[0]?.info) return candidates[0].info.state;
    const previous = byState.get(Number(holdState) - 1);
    if (previous && !scanStateHasHit(previous) && !previous.helperOnly) return previous.state;
    return null;
  };
  const scoreCandidate = (item) => {
    let score = 0;
    if (visibleChargeEvidence(item.startControllers)) score += 80;
    if (visibleChargeEvidence(item.holdControllers)) score += 160;
    if (cleanupEvidence(item.endControllers)) score += 120;
    if (visibleChargeEvidence(item.fullPowerControllers)) score += 160;
    if (Number(item.startState) === Number(item.holdState) - 1) score += 50;
    if (Number(item.endState) === Number(item.holdState) + 1) score += 70;
    if (Number(item.fullPowerState) === Number(item.holdState) + 2) score += 70;
    if (Number(item.holdState) >= 10000 && Number(item.holdState) <= 11999) score += 40;
    if (Number(item.endState) === 0) score -= 220;
    if (!visibleChargeEvidence(item.startControllers) && !visibleChargeEvidence(item.holdControllers)) score -= 120;
    return score;
  };
  const candidates = states
    .filter((info) => info.powerGain || (info.powerGainSignals || []).length)
    .filter((info) => !scanStateHasHit(info))
    .filter((info) => !info.helperOnly)
    .map((info) => {
      const endCancel = (info.cancels || []).find((cancel) => {
        const target = Number(cancel.target);
        const targetInfo = byState.get(target);
        return Number.isFinite(target)
          && target !== Number(info.state)
          && targetInfo
          && !scanStateHasHit(targetInfo)
          && !targetInfo.powerGain;
      });
      const fullPowerCancel = (info.cancels || []).find((cancel) => {
        const target = Number(cancel.target);
        const targetInfo = byState.get(target);
        return Number.isFinite(target)
          && target !== Number(info.state)
          && targetInfo
          && /Power\s*>=/i.test(String(cancel.triggers || ""));
      });
      return {
        holdState: Number(info.state),
        holdAnim: Number(info.statedefAnim || info.actions?.[0]),
        startState: chooseStartState(info.state),
        endState: Number(endCancel?.target),
        endAnim: Number(byState.get(Number(endCancel?.target))?.statedefAnim || byState.get(Number(endCancel?.target))?.actions?.[0]),
        fullPowerState: Number(fullPowerCancel?.target),
        startControllers: [],
        holdControllers: info.reusableControllers || [],
        endControllers: byState.get(Number(endCancel?.target))?.reusableControllers || [],
        fullPowerControllers: byState.get(Number(fullPowerCancel?.target))?.reusableControllers || [],
        source: info.source || "",
      };
    })
    .filter((item) => Number.isFinite(item.holdAnim) && Number.isFinite(item.endState) && Number.isFinite(item.endAnim))
    .map((item) => {
      const startInfo = byState.get(Number(item.startState));
      return {
        ...item,
        startAnim: Number(startInfo?.statedefAnim || startInfo?.actions?.[0]),
        startControllers: startInfo?.reusableControllers || [],
      };
    })
    .map((item) => ({ ...item, score: scoreCandidate(item) }))
    .filter((item) => item.score >= 180)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aPreferred = Number(a.endState) === Number(a.holdState) + 1 ? 0 : 1;
      const bPreferred = Number(b.endState) === Number(b.holdState) + 1 ? 0 : 1;
      if (aPreferred !== bPreferred) return aPreferred - bPreferred;
      return Number(a.holdState) - Number(b.holdState);
    });
  return candidates[0] || null;
}

function needsPowerChargeShim(profile, plan = null) {
  const wantsPowerCharge = !plan || (plan.resolved?.states || []).some((item) => item.id === "power_charge");
  if (!wantsPowerCharge) return false;
  return !profile.states.all.includes(730) && !!detectNativePowerCharge(profile);
}

function statePowerCost(profile, state) {
  return profile.states.powerCosts?.[state] || profile.states.powerCosts?.[String(state)] || null;
}

function stateScanInfo(profile, state) {
  return profile.comboScan?.states?.find((item) => item.state === state) || null;
}

function stateTraitInfo(profile, state) {
  return profile.stateTraits?.[state] || profile.stateTraits?.[String(state)] || null;
}

function statePatchRisk(profile, state) {
  const traits = stateTraitInfo(profile, state);
  const info = stateScanInfo(profile, state);
  const reasons = [
    traits?.comboUnsafeReason || "",
    info?.comboUnsafeReason || "",
  ].filter(Boolean);
  return {
    risky: !!(traits?.comboUnsafe || info?.comboUnsafe || info?.helperOnly || traits?.helperOnly),
    reason: uniqueValues(reasons.join(", ").split(/\s*,\s*/).filter(Boolean)).join(", "),
  };
}

function attackStateHasHit(profile, state) {
  const info = stateScanInfo(profile, state);
  return !!(info && scanStateDirectChangeSafe(info) && !info.helperOnly && !stateIsNoDamageThrowAttempt(info) && (info.hitDefs?.length || info.hitSummary || info.hasEffectiveHit));
}

function unsafeDirectStateTarget(profile, state) {
  const traits = stateTraitInfo(profile, state);
  const info = stateScanInfo(profile, state);
  return !!(
    traits?.directChangeSafe === false
    || info?.directChangeSafe === false
    || (traits?.executionRole && traits.executionRole !== "root_attack")
    || (info?.executionRole && info.executionRole !== "root_attack")
    || traits?.helperOnly
    || info?.helperOnly
    || stateIsNoDamageThrowAttempt(info) && !/throw|grab/.test(`${info?.role || ""} ${info?.roleFamily || ""} ${(info?.roleTags || []).join(" ")}`.toLowerCase())
    || traits?.visualMissingActions?.length
    || info?.visualMissingActions?.length
  );
}

function safeStateAliasCandidate(profile, state) {
  if (!profile.states.all.includes(Number(state))) return false;
  return !unsafeDirectStateTarget(profile, Number(state));
}

function chooseStateByPowerBucket(profile, buckets, options = {}) {
  const candidates = profile.states.all
    .filter((state) => state >= (options.minState ?? 1000) && state <= (options.maxState ?? 4999))
    .map((state) => ({ state, cost: statePowerCost(profile, state), info: stateScanInfo(profile, state) }))
    .filter((item) => item.cost && buckets.includes(String(item.cost.bucket)))
    .filter((item) => scanStateDirectChangeSafe(item.info) && !item.info?.helperOnly)
    .filter((item) => options.requireHit === false || item.info?.hitDefs?.length || item.info?.role === "super")
    .filter((item) => !item.cost?.cost || meterUsableAsAttack(item.info))
    .sort((a, b) => {
      const preferredOrder = options.preferredOrder || [];
      const ai = preferredOrder.indexOf(a.state);
      const bi = preferredOrder.indexOf(b.state);
      if (ai >= 0 || bi >= 0) return (ai >= 0 ? ai : 999) - (bi >= 0 ? bi : 999);
      return a.state - b.state;
    });
  return candidates[0]?.state ?? null;
}

function isCombatStateAlias(item) {
  const id = String(item.id || "").toLowerCase();
  const purpose = String(item.purpose || "").toLowerCase();
  return /special|super|hyper|projectile|anti_air|rush|cashout|launcher|pressure|light|medium|strong|low/.test(`${id} ${purpose}`);
}

function stateReachInfo(info) {
  const reach = info?.effectiveReach?.length ? info.effectiveReach : info?.reach || [];
  if (!reach.length) return null;
  return {
    reach,
    maxX: Math.max(...reach.map((item) => Number(item.maxX || 0))),
    minY: Math.min(...reach.map((item) => Number(item.minY || 0))),
    maxY: Math.max(...reach.map((item) => Number(item.maxY || 0))),
  };
}

function routeEvidenceForState(profile, state) {
  const edges = profile.comboScan?.routeCandidates || [];
  const inbound = edges.filter((edge) => Number(edge.to) === Number(state));
  const outbound = edges.filter((edge) => Number(edge.from) === Number(state));
  return { inbound, outbound };
}

function aliasRoleHints(item) {
  const key = `${String(item.id || "")} ${String(item.purpose || "")}`.toLowerCase();
  const hints = [];
  const add = (...values) => hints.push(...values);
  if (/air_drill|drill/.test(key)) add("special", "rush_special", "air_attack", "air_route");
  if (/tornado|anti_air|anti-air/.test(key)) add("anti_air_special", "launcher", "vertical_coverage");
  if (/barrage|slash|rush|pressure/.test(key)) add("rush_special", "special", "mid_range");
  if (/fatal.*air|air.*fatal/.test(key)) add("hyper", "meter", "air_route");
  if (/fatal|weapon|speedy|secret|hyper|super|cashout/.test(key)) add("hyper", "meter");
  if (/heal|healing|install|buff|mode/.test(key)) add("meter", "self_buff", "install");
  if (/launcher/.test(key)) add("launcher", "vertical_coverage");
  if (/low|crouch|sweep|trip/.test(key)) add("low_starter", "low_coverage");
  if (/stand|standing/.test(key)) add("standing_attack");
  if (/crouch|low|sweep|trip/.test(key)) add("crouch_attack");
  if (/air_light|air_medium|air_kick|air_strong|air_finish|jump/.test(key)) add("air_normal", "air_route");
  if (/light/.test(key)) add("light_normal");
  if (/medium/.test(key)) add("medium_normal");
  if (/strong|heavy|finish/.test(key)) add("strong_normal");
  if (/throw|grab/.test(key)) add("throw");
  if (/projectile/.test(key)) add("projectile", "long_range");
  if (/close/.test(key)) add("close_range");
  return uniqueValues(hints);
}

function stateAliasScoreReasons(profile, state, item) {
  const reasons = [];
  const info = stateScanInfo(profile, state);
  const cost = statePowerCost(profile, state);
  const hints = aliasRoleHints(item);
  const tags = new Set(info?.roleTags || []);
  const roleText = `${info?.role || ""} ${info?.roleFamily || ""}`;
  const reach = stateReachInfo(info);
  const routeEvidence = routeEvidenceForState(profile, state);
  let score = 0;

  if (!profile.states.all.includes(state)) return { score: -9999, reasons: ["state missing"] };
  if (unsafeDirectStateTarget(profile, state)) return { score: -9999, reasons: ["unsafe direct ChangeState target"] };
  if (info) {
    score += 20;
    reasons.push(`scanned as ${info.roleFamily || info.role || "state"}`);
  }
  if (stateIsNoDamageThrowAttempt(info)) {
    const idText = `${String(item.id || "")} ${String(item.purpose || "")}`.toLowerCase();
    if (/throw|grab/.test(idText)) {
      score += 34;
      reasons.push("throw attempt no-damage handoff; point-blank punish only");
    } else {
      score -= 180;
      reasons.push("penalty: throw attempt has no direct damage/combo hit");
    }
  }
  if (scanStateHasHit(info)) {
    score += 35;
    reasons.push("has HitDef/effective hit");
  }
  if (cost?.cost) {
    const reliability = meterReliability(info);
    const classification = reliability?.classification || "unscored";
    const idText = `${String(item.id || "")} ${String(item.purpose || "")}`.toLowerCase();
    const attackAlias = /super|hyper|cashout|fatal|weapon|speedy|secret|projectile|rush|barrage|slash|drill|tornado|anti_air|pressure|close/.test(idText);
    const utilityAlias = /heal|healing|install|buff|mode|charge|safe/.test(idText);
    if (classification !== "unscored") reasons.push(`meter reliability ${classification}/${reliability.recommendedUse}`);
    if (classification === "close_confirm") score += utilityAlias ? -70 : attackAlias ? 28 : 8;
    else if (classification === "projectile") score += utilityAlias ? -40 : /projectile|screen|zone|punish/.test(idText) ? 34 : 10;
    else if (classification === "grab") score += utilityAlias ? -45 : /throw|grab/.test(idText) ? 26 : -18;
    else if (classification === "self_buff" || classification === "install") {
      score += utilityAlias ? 95 : -95;
      if (!utilityAlias) reasons.push(`penalty: ${classification} cannot satisfy attack cashout alias`);
    } else if (classification === "unsafe_raw") {
      score -= 140;
      reasons.push("penalty: unsafe_raw meter state");
    }
  }
  if (reach) {
    score += 18;
    reasons.push(`reach maxX ${Math.round(reach.maxX)}`);
  }
  if (info?.hasEffectiveHit && info?.helperStates?.length) {
    score += 8;
    reasons.push(`helper hit support ${info.helperStates.slice(0, 3).join("/")}`);
  }
  const matchedHints = hints.filter((hint) => tags.has(hint) || roleText.includes(hint.replace(/_/g, " ")));
  if (matchedHints.length) {
    score += matchedHints.length * 18;
    reasons.push(`role match ${matchedHints.slice(0, 4).join("/")}`);
  }
  if (hints.includes("standing_attack") && (tags.has("crouch_attack") || tags.has("low_starter"))) {
    score -= 30;
    reasons.push("penalty: standing alias matched crouch/low state");
  }
  if (hints.includes("low_starter") && !tags.has("low_starter")) {
    score -= 18;
    reasons.push("penalty: low alias lacks low-starter tag");
  }
  score += Math.min(30, routeEvidence.inbound.length * 10 + routeEvidence.outbound.length * 6);
  if (routeEvidence.inbound.length || routeEvidence.outbound.length) {
    reasons.push(`route evidence in:${routeEvidence.inbound.length} out:${routeEvidence.outbound.length}`);
  }
  if (routeEvidence.inbound.some((edge) => edge.confidence === "high")) {
    score += 12;
    reasons.push("high-confidence inbound cancel");
  }

  const id = String(item.id || "").toLowerCase();
  if (/super|hyper|cashout|level3|fatal|weapon|speedy|secret/.test(id)) {
    if (state >= 2000) {
      score += 30;
      reasons.push("meter-range state id");
    }
    if ((cost?.cost || 0) >= 1000) {
      score += 24;
      reasons.push(`power cost ${cost.cost}`);
    }
    if (/air/.test(id) && tags.has("air_route")) score += 16;
    if (/close/.test(id) && reach?.maxX <= 95) score += 10;
  } else if (/special|barrage|slash|drill|tornado|anti_air|pressure/.test(id)) {
    if (state >= 1000 && state <= 2999) score += 26;
    if (!cost || cost.cost < 1000) score += 8;
  } else if (/light|medium|strong|low|launcher|air_/.test(id)) {
    if (state >= 200 && state <= 699) score += 28;
    if (/air_/.test(id) && state >= 600 && state <= 699) score += 22;
    if (/launcher/.test(id) && tags.has("launcher")) score += 22;
    if (/low/.test(id) && tags.has("low_starter")) score += 18;
  }

  const preferred = Number(item.preferred);
  if (state === preferred) {
    score += 8;
    reasons.push("preferred state exists");
  }
  return { score, reasons: uniqueValues(reasons).slice(0, 8) };
}

function combatStateScore(profile, state, item) {
  return stateAliasScoreReasons(profile, state, item).score;
}

function bestCombatState(profile, item, candidates) {
  const unique = [...new Set((candidates || []).filter((state) => Number.isInteger(Number(state))).map(Number))];
  const scored = unique
    .map((state) => ({ state, ...stateAliasScoreReasons(profile, state, item) }))
    .filter((entry) => entry.score > -9999)
    .sort((a, b) => (b.score - a.score) || (a.state - b.state));
  return scored[0] || null;
}

function statesByRoleHint(profile, item) {
  const hints = new Set(aliasRoleHints(item));
  const idText = `${String(item.id || "")} ${String(item.purpose || "")}`.toLowerCase();
  const utilityAlias = /heal|healing|install|buff|mode|charge|safe/.test(idText);
  const all = (profile.comboScan?.states || [])
    .filter((info) => scanStateAllowGuardedCombo(info) && (scanStateHasHit(info) || statePowerCost(profile, Number(info.state))?.cost))
    .filter((info) => {
      if (!statePowerCost(profile, Number(info.state))?.cost) return true;
      return utilityAlias ? !meterUnsafeRaw(info) : meterUsableAsAttack(info);
    })
    .filter((info) => {
      if (!hints.size) return true;
      const tags = new Set(info.roleTags || []);
      const roleText = `${info.role || ""} ${info.roleFamily || ""}`;
      return [...hints].some((hint) => tags.has(hint) || roleText.includes(hint.replace(/_/g, " ")));
    })
    .map((info) => Number(info.state));
  return all;
}

function inferCompatibleAttackState(item, profile) {
  const id = String(item.id || "").toLowerCase();
  const hintedStates = statesByRoleHint(profile, item);
  if (hintedStates.length) {
    return bestCombatState(profile, item, hintedStates)?.state ?? null;
  }
  if (id === "close_super") {
    const states = profile.states.all.filter((state) => state >= 2000 && state <= 4999);
    return bestCombatState(profile, item, [2000, 3000, 3100, 3300, 3050, 3150, ...states])?.state ?? null;
  }
  if (id === "projectile_super_start" || id === "projectile_super_fire") {
    const states = profile.states.all.filter((state) => state >= 2000 && state <= 4999);
    return bestCombatState(profile, item, [3000, 3100, 3300, 3050, 3150, 2000, ...states])?.state ?? null;
  }
  if (id === "ex_anti_air") {
    const states = profile.states.all.filter((state) => state >= 1000 && state <= 1999);
    return bestCombatState(profile, item, [1430, 1065, 1075, 1005, 1030, 1130, ...states])?.state ?? null;
  }
  if (id === "ex_projectile") {
    const states = profile.states.all.filter((state) => state >= 1000 && state <= 1999);
    return bestCombatState(profile, item, [1030, 1005, 1075, 1065, 1130, 1430, ...states])?.state ?? null;
  }
  if (id === "rush_special" || id === "ducking_special" || id === "anti_air_special" || id === "close_pressure") {
    const states = profile.states.all.filter((state) => state >= 1000 && state <= 2999);
    return bestCombatState(profile, item, [1100, 1000, 1200, 1400, 1030, 1130, ...states])?.state ?? null;
  }
  return null;
}

function resolveState(item, profile) {
  const preferred = Number(item.preferred);
  const exists = profile.states.all.includes(preferred);
  const conflict = item.conflict || "manual_choose";
  const id = String(item.id || "").toLowerCase();
  if (id === "power_charge" && preferred === 730 && !exists && detectNativePowerCharge(profile)) {
    return {
      id: item.id,
      actual: 730,
      preferred,
      strategy: "generated_power_charge_shim",
      status: "resolved",
      score: 90,
      reason: "native power-charge sequence detected; patcher will add compatibility StateDef 730/731",
      roleHints: aliasRoleHints(item),
    };
  }
  if (exists && !unsafeDirectStateTarget(profile, preferred) && !isCombatStateAlias(item)) {
    return { id: item.id, actual: preferred, preferred, strategy: "preferred_exists", status: "resolved" };
  }
  const unsafePreferred = exists && unsafeDirectStateTarget(profile, preferred);
  if (conflict === "reuse_compatible") {
    if (exists && !unsafePreferred) {
      const scored = stateAliasScoreReasons(profile, preferred, item);
      return {
        id: item.id,
        actual: preferred,
        preferred,
        strategy: "preferred_exists",
        status: "resolved",
        score: scored.score,
        reason: scored.reasons.join("; "),
        roleHints: aliasRoleHints(item),
      };
    }
    const compatible = compatibleStateCandidates(item).find((state) => safeStateAliasCandidate(profile, state));
    if (compatible !== undefined) {
      const risk = statePatchRisk(profile, preferred);
      const scored = stateAliasScoreReasons(profile, Number(compatible), item);
      return {
        id: item.id,
        actual: compatible,
        preferred,
        strategy: risk.risky ? "reuse_safe_compatible_state" : "reuse_compatible_state",
        status: "resolved",
        score: scored.score,
        reason: scored.reasons.join("; "),
        roleHints: aliasRoleHints(item),
        warning: risk.risky ? `preferred ${preferred} skipped: ${risk.reason || "patch risk"}` : undefined,
      };
    }
    return {
      id: item.id,
      actual: null,
      preferred,
      strategy: "reuse_compatible_state",
      status: "needs_review",
      reason: `preferred state ${preferred} does not exist and no compatible state was detected`,
      roleHints: aliasRoleHints(item),
      options: profile.states.all.filter((state) => state >= 0).slice(0, 80),
    };
  }
  if (exists && !unsafePreferred) {
    const scored = stateAliasScoreReasons(profile, preferred, item);
    return {
      id: item.id,
      actual: preferred,
      preferred,
      strategy: isCombatStateAlias(item) ? "preferred_combat_state_exists" : "preferred_exists",
      status: "resolved",
      score: scored.score,
      reason: scored.reasons.join("; "),
      roleHints: aliasRoleHints(item),
    };
  }
  const inferred = inferCompatibleAttackState(item, profile);
  if (inferred !== null) {
    const scored = stateAliasScoreReasons(profile, Number(inferred), item);
    return {
      id: item.id,
      actual: inferred,
      preferred,
      strategy: unsafePreferred ? "scan_inferred_helper_safe_target" : "scan_inferred_compatible",
      status: "resolved",
      score: scored.score,
      reason: scored.reasons.join("; "),
      roleHints: aliasRoleHints(item),
    };
  }
  return {
    id: item.id,
    actual: null,
    preferred,
    strategy: conflict,
    status: "needs_review",
    reason: unsafePreferred
      ? `preferred state ${preferred} appears helper-only and is unsafe for direct ChangeState`
      : `preferred state ${preferred} does not exist and no scanner-compatible target was detected`,
    roleHints: aliasRoleHints(item),
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function deriveRange(item, profile) {
  const preferred = Number(item.preferred);
  const min = Number.isFinite(Number(item.min)) ? Number(item.min) : preferred;
  const max = Number.isFinite(Number(item.max)) ? Number(item.max) : preferred;
  let actual = preferred;
  let confidence = "low";
  let source = "preferred fallback";

  const reachValues = Object.values(profile.airReach || {}).map((reach) => Math.max(Math.abs(reach.minX), Math.abs(reach.maxX)));
  if (reachValues.length) {
    const maxReach = Math.max(...reachValues);
    if (/low|crouch|medium|launcher|confirm|threat|guard/.test(item.id)) {
      actual = clamp(Math.round(maxReach + 16), min, max);
      confidence = "medium";
      source = "max Clsn1 reach + buffer";
    }
  }

  return { id: item.id, actual, preferred, min, max, confidence, source, strategy: item.conflict || "auto_derive", status: "resolved" };
}

function resolveCommand(item, profile) {
  const available = profile.commands?.available || [];
  const availableSet = new Set(available);
  const preferred = Array.isArray(item.preferred) ? item.preferred : [item.preferred].filter(Boolean);
  const actual = preferred.find((name) => availableSet.has(name) || isBuiltInCommand(name));
  if (actual) {
    return {
      id: item.id,
      actual,
      preferred: preferred.join(", "),
      strategy: isBuiltInCommand(actual) ? "reuse_builtin_command" : "reuse_existing_command",
      status: "resolved",
    };
  }
  const fallback = item.fallback || item.default || null;
  if (fallback && (availableSet.has(fallback) || isBuiltInCommand(fallback))) {
    return {
      id: item.id,
      actual: fallback,
      preferred: preferred.join(", "),
      strategy: isBuiltInCommand(fallback) ? "fallback_builtin_command" : "fallback_existing_command",
      status: "resolved",
    };
  }
  return {
    id: item.id,
    actual: null,
    preferred: preferred.join(", "),
    strategy: item.conflict || "manual_choose",
    status: "conflict",
    reason: preferred.length ? `missing command: ${preferred.join(", ")}` : "missing command alias candidates",
  };
}

function stateAliasFallbackCost(id) {
  const key = String(id || "").toLowerCase();
  if (/^ex_|_ex|ex_/.test(key)) return 500;
  if (/level3|lvl3|3/.test(key)) return 3000;
  if (/max|level2|lvl2/.test(key)) return 2000;
  if (/super|cashout|rush_super|close_super/.test(key)) return 1000;
  return 0;
}

function stateScanWindow(profile, state) {
  const info = stateScanInfo(profile, Number(state));
  if (!info) return null;
  const base = info.scanWindow || scanWindowFromInfo(info);
  if (!base) return null;
  return {
    xMin: base.xMin,
    xMax: base.xMax,
    yMin: base.yMin,
    yMax: base.yMax,
    startup: finiteNumberOrNull(base.startup ?? info.timing?.startup),
    className: meterReliabilityClass(info) || "",
    use: scannedMeterRecommendedUse(info) || "",
  };
}

function stateScanWindowFallbackForAlias(id) {
  const key = String(id || "").toLowerCase();
  if (/grab|throw|level3/.test(key)) return { xMin: -8, xMax: 35, yMin: -30, yMax: 30, startup: null, className: "grab", use: "point_blank_punish_only" };
  if (/projectile/.test(key)) return { xMin: 45, xMax: 160, yMin: -120, yMax: 45, startup: null, className: "projectile", use: "spacing_or_punish" };
  if (/super|cashout|ex_|rush|anti_air/.test(key)) return { xMin: -20, xMax: 90, yMin: -120, yMax: 45, startup: null, className: "close_confirm", use: "hit_confirm_only" };
  return { xMin: -20, xMax: 95, yMin: -120, yMax: 45, startup: null, className: "", use: "" };
}

function buildReplacementMap(resolved, profile = null) {
  const map = {};
  for (const item of resolved.variables) if (item.actual) {
    map[`var.${item.id}`] = item.actual;
    map[`var.${item.id}:number`] = String(item.number);
  }
  for (const item of resolved.fvariables) if (item.actual) {
    map[`fvar.${item.id}`] = item.actual;
    map[`fvar.${item.id}:number`] = String(item.number);
  }
  for (const item of resolved.states) if (item.actual !== null && item.actual !== undefined) {
    map[`state.${item.id}`] = String(item.actual);
    map[`state.${item.id}:number`] = String(item.actual);
    const cost = statePowerCost(profile, Number(item.actual))?.cost || stateAliasFallbackCost(item.id);
    map[`state.${item.id}:cost`] = String(cost);
    const window = stateScanWindow(profile, Number(item.actual)) || stateScanWindowFallbackForAlias(item.id);
    map[`state.${item.id}:x_min`] = String(Math.round(window.xMin));
    map[`state.${item.id}:x_max`] = String(Math.round(window.xMax));
    map[`state.${item.id}:y_min`] = String(Math.round(window.yMin));
    map[`state.${item.id}:y_max`] = String(Math.round(window.yMax));
    map[`state.${item.id}:startup`] = window.startup === null || window.startup === undefined ? "" : String(window.startup);
    map[`state.${item.id}:class`] = window.className || "";
    map[`state.${item.id}:use`] = window.use || "";
  }
  for (const item of resolved.ranges) if (item.actual !== null && item.actual !== undefined) {
    map[`range.${item.id}`] = String(item.actual);
    map[`range.${item.id}:number`] = String(item.actual);
  }
  for (const item of resolved.commands || []) if (item.actual) {
    map[`command.${item.id}`] = item.actual;
  }
  return map;
}

function renderTemplate(template, replacementMap) {
  return template.replace(/\$\{([a-z]+)\.([A-Za-z0-9_]+)(?::([A-Za-z0-9_]+))?\}/g, (full, group, id, suffix) => {
    const key = `${group}.${id}${suffix ? `:${suffix}` : ""}`;
    return Object.prototype.hasOwnProperty.call(replacementMap, key) ? replacementMap[key] : full;
  });
}

function optionalMissingStateAliases(plan) {
  return new Set((plan?.resolved?.states || [])
    .filter((item) => item.actual === null || item.actual === undefined)
    .filter((item) => /grab|rush_super_max|close_super_max|max/.test(String(item.id || "").toLowerCase()))
    .map((item) => item.id));
}

function optionalPlaceholderIds(placeholders, plan) {
  const optionalStates = optionalMissingStateAliases(plan);
  return (placeholders || [])
    .map((placeholder) => String(placeholder).match(/^\$\{state\.([A-Za-z0-9_]+)(?::number)?\}$/)?.[1])
    .filter((id) => id && optionalStates.has(id));
}

function extractCommandRefs(text) {
  const refs = [];
  for (const match of String(text || "").matchAll(/(?:^|[^\w.])command\s*=\s*"([^"\r\n]+)"/gim)) {
    refs.push(match[1].trim());
  }
  return [...new Set(refs)];
}

function validateCommandRefs(text, profile) {
  const available = new Set(profile.commands?.available || []);
  return extractCommandRefs(text)
    .filter((name) => !available.has(name) && !isBuiltInCommand(name))
    .map((name) => `command:${name}`);
}

function validateCommandRefsAgainstSet(text, availableCommands) {
  const available = new Set(availableCommands || []);
  return extractCommandRefs(text)
    .filter((name) => !available.has(name) && !isBuiltInCommand(name))
    .map((name) => `command:${name}`);
}

function parseModuleTarget(module, replacementMap) {
  for (const yaml of module.yaml) {
    const rendered = renderTemplate(yaml, replacementMap);
    const target = parseSimpleYamlObject(rendered);
    if (target.file || target.insert_before || target.insert_after || target.insert_after_module || target.fallback_insert_before) {
      return target;
    }
  }
  return null;
}

function renderRoutePreview(routePreview, replacementMap) {
  return (routePreview || []).map((entry) => {
    const rendered = {};
    for (const [key, value] of Object.entries(entry)) {
      if (Array.isArray(value)) rendered[key] = value.map((item) => renderTemplate(String(item), replacementMap));
      else if (typeof value === "string") rendered[key] = renderTemplate(value, replacementMap);
      else rendered[key] = value;
    }
    return rendered;
  });
}

function resolvedLookup(plan, kind) {
  const source = kind === "fvar" ? plan.resolved.fvariables : plan.resolved.variables;
  return new Map((source || []).map((item) => [item.id, item]));
}

function variableResolved(plan, id) {
  const varItem = resolvedLookup(plan, "var").get(id);
  const fvarItem = resolvedLookup(plan, "fvar").get(id);
  return !!((varItem && varItem.status === "resolved" && varItem.actual) || (fvarItem && fvarItem.status === "resolved" && fvarItem.actual));
}

function classifyLiteFitModule(policy, plan, module) {
  if (!policy) {
    const unresolved = module.unresolvedPlaceholders || [];
    return {
      moduleId: module.id,
      tier: "unclassified",
      mode: unresolved.length ? "blocked" : "full",
      missingRequired: [],
      missingOptional: [],
      fallbackMode: null,
      fallbackTrigger: null,
      reason: unresolved.length ? "module has unresolved placeholders" : "module resolved fully",
    };
  }
  const minVars = policy.minVars || [];
  const optionalVars = policy.optionalVars || [];
  const missingRequired = minVars.filter((id) => !variableResolved(plan, id));
  const missingOptional = optionalVars.filter((id) => !variableResolved(plan, id));
  const tier = policy.tier || "optional";
  const fallbackMode = policy.fallback?.mode || null;
  const fallbackTrigger = policy.fallback?.trigger || null;
  const unresolved = module.unresolvedPlaceholders || [];
  if (missingRequired.length && /core|boss_core|core_defense/.test(tier) && !fallbackMode) {
    return {
      moduleId: module.id,
      tier,
      mode: "blocked",
      missingRequired,
      missingOptional,
      fallbackMode,
      fallbackTrigger,
      reason: "core module is missing required variables and has no fallback",
    };
  }
  if (missingRequired.length && fallbackMode) {
    return {
      moduleId: module.id,
      tier,
      mode: fallbackMode === "skip_module" || fallbackMode === "report_only" || fallbackMode === "skip_when_no_route_var" ? "skip" : "fallback",
      missingRequired,
      missingOptional,
      fallbackMode,
      fallbackTrigger,
      reason: `missing required variables; use ${fallbackMode}`,
    };
  }
  if (unresolved.length && fallbackMode) {
    return {
      moduleId: module.id,
      tier,
      mode: fallbackMode === "skip_module" || fallbackMode === "report_only" || fallbackMode === "skip_when_no_route_var" ? "skip" : "fallback",
      missingRequired,
      missingOptional,
      fallbackMode,
      fallbackTrigger,
      reason: `unresolved placeholders; use ${fallbackMode}`,
    };
  }
  if (missingOptional.length) {
    return {
      moduleId: module.id,
      tier,
      mode: "lite",
      missingRequired,
      missingOptional,
      fallbackMode,
      fallbackTrigger,
      reason: "optional variables missing; apply module with lite/review note",
    };
  }
  return {
    moduleId: module.id,
    tier,
    mode: unresolved.length ? "blocked" : "full",
    missingRequired,
    missingOptional,
    fallbackMode,
    fallbackTrigger,
    reason: unresolved.length ? "module has unresolved placeholders" : "all declared variables resolved",
  };
}

function buildLiteFitPlan(brain, plan, modules) {
  const policies = new Map((brain.liteFit?.modulePolicy || []).map((item) => [item.id, item]));
  const modulesOut = (modules || []).map((module) => classifyLiteFitModule(policies.get(module.id), plan, module));
  for (const item of modulesOut) {
    if (item.moduleId === "variable_comments" && item.mode === "blocked") {
      item.mode = "skip";
      item.tier = item.tier || "support";
      item.reason = "mapping comments are skipped in Lite Fit when variables are unresolved";
    }
  }
  const requiredByActiveModules = new Set();
  for (const item of modulesOut) {
    if (["skip", "fallback", "blocked"].includes(item.mode)) continue;
    for (const name of item.missingRequired || []) requiredByActiveModules.add(name);
    for (const name of item.missingOptional || []) requiredByActiveModules.add(name);
  }
  const fallbackRequired = new Set();
  for (const item of modulesOut) {
    if (item.mode !== "fallback") continue;
    for (const name of item.missingRequired || []) fallbackRequired.add(name);
  }
  const hardBlocked = modulesOut.filter((item) => item.mode === "blocked" && /core|boss_core|core_defense/.test(item.tier || "") && !item.fallbackMode);
  for (const item of modulesOut) {
    if (item.mode === "blocked" && !hardBlocked.includes(item)) {
      item.mode = "skip";
      item.reason = `Lite Fit skipped unresolved non-critical module: ${item.reason}`;
    }
  }
  const summary = {
    full: modulesOut.filter((item) => item.mode === "full").length,
    lite: modulesOut.filter((item) => item.mode === "lite").length,
    fallback: modulesOut.filter((item) => item.mode === "fallback").length,
    skip: modulesOut.filter((item) => item.mode === "skip").length,
    blocked: hardBlocked.length,
  };
  const decision = hardBlocked.length ? "blocked" : summary.fallback || summary.lite || summary.skip ? "lite-fit" : "full";
  return {
    decision,
    summary,
    modules: modulesOut,
    requiredByActiveModules: [...requiredByActiveModules],
    fallbackRequired: [...fallbackRequired],
    bossProfiles: brain.liteFit?.bossProfiles || {},
    fallbackTriggers: brain.liteFit?.fallbackTriggers || {},
    sourceScan: brain.liteFit?.sourceScan || {},
  };
}

function buildResolverReport(profile, brain, resolved, liteFit, styleAdapter = null) {
  const roleCounts = {};
  const meterReliabilityCounts = {};
  for (const info of profile.comboScan?.states || []) {
    const key = info.roleFamily || info.role || "unknown";
    roleCounts[key] = (roleCounts[key] || 0) + 1;
    if (info.meterReliability?.classification) {
      const meterKey = info.meterReliability.classification;
      meterReliabilityCounts[meterKey] = (meterReliabilityCounts[meterKey] || 0) + 1;
    }
  }
  const stateMappings = (resolved.states || []).map((item) => {
    const info = item.actual !== null && item.actual !== undefined ? stateScanInfo(profile, Number(item.actual)) : null;
    return {
      id: item.id,
      preferred: item.preferred,
      actual: item.actual,
      status: item.status,
      strategy: item.strategy,
      score: item.score ?? null,
      reason: item.reason || item.warning || item.reason,
      roleHints: item.roleHints || [],
      scannedRole: info?.role || null,
      roleFamily: info?.roleFamily || null,
      roleTags: info?.roleTags || [],
      meterReliability: info?.meterReliability || null,
      safety: info ? {
        directChangeSafe: scanStateDirectChangeSafe(info),
        helperOnly: !!info.helperOnly,
        comboUnsafe: !!info.comboUnsafe,
        reason: info.comboUnsafeReason || info.helperOnlyReason || info.executionRoleReason || "",
      } : null,
    };
  });
  const safe = stateMappings.filter((item) => item.status === "resolved" && item.safety?.directChangeSafe !== false && !item.safety?.helperOnly);
  const review = stateMappings.filter((item) => item.status !== "resolved" || item.safety?.comboUnsafe || item.safety?.helperOnly);
  const scanInferred = stateMappings.filter((item) => /scan_inferred/.test(item.strategy || ""));
  return {
    brainId: getBrainId(brain.frontmatter),
    roleCounts,
    meterReliabilityCounts,
    meterReliability: (profile.patchReadiness?.meterCandidates || [])
      .filter((item) => item.meterReliability)
      .map((item) => ({
        state: item.state,
        cost: item.cost,
        classification: item.meterReliability.classification,
        confidence: item.meterReliability.confidence,
        recommendedUse: item.meterReliability.recommendedUse,
        warnings: item.meterReliability.warnings || [],
      })),
    oldAiMeterRisks: (profile.patchReadiness?.oldAiMeterRisks || []).map((item) => ({
      state: item.state,
      cost: item.cost,
      classification: item.classification,
      rangeClass: item.rangeClass,
      delivery: item.delivery,
      scanWindow: item.scanWindow,
      triggerWindow: item.triggerWindow,
      heading: item.heading,
      line: item.line,
      reason: item.reason,
    })),
    oldAiRepeatFarmRisks: (profile.patchReadiness?.oldAiRepeatFarmRisks || []).map((item) => ({
      state: item.state,
      heading: item.heading,
      line: item.line,
      valueExpr: item.valueExpr,
      role: item.role,
      roleFamily: item.roleFamily,
      powerGainSignals: item.powerGainSignals || [],
      reason: item.reason,
    })),
    routeCandidates: profile.comboScan?.routeCandidates?.length || 0,
    scanInferredCount: scanInferred.length,
    safeStateMappings: safe.length,
    reviewStateMappings: review.length,
    stateMappings,
    styleAdapter,
    safeLite: liteFit ? {
      decision: liteFit.decision,
      summary: liteFit.summary,
      modules: liteFit.modules.map((item) => ({
        moduleId: item.moduleId,
        tier: item.tier,
        mode: item.mode,
        missingRequired: item.missingRequired || [],
        missingOptional: item.missingOptional || [],
        fallbackMode: item.fallbackMode || null,
        reason: item.reason || "",
      })),
    } : null,
    recommendations: [
      review.length ? "Review unresolved or unsafe state aliases before full apply." : "",
      liteFit?.decision === "lite-fit" ? "Safe Lite path is available; skipped/fallback modules include reasons." : "",
      profile.patchReadiness?.oldAiMeterRisks?.length ? "Old AI meter range guard will be patched because original AI can call scanned close/mid meter outside its hit window." : "",
      profile.patchReadiness?.oldAiRepeatFarmRisks?.length ? "Old AI normal/power-gain route guard will be patched because original AI can loop power-gain attacks under patched AI." : "",
      profile.comboScan?.routeCandidates?.length ? "Resolver-generated combo pool can use scanned route candidates." : "No route candidates found; generated AI will be limited to safe neutral/punish actions.",
    ].filter(Boolean),
  };
}

function resolveBrain(profile, brain, options = {}) {
  const allocatedVars = new Set();
  const allocatedFVars = new Set();
  const approvedVarPool = options.approvedVarPool || null;
  const resolved = {
    variables: brain.variables.map((item) => resolveNumberItem(item, profile, "var", allocatedVars, approvedVarPool)),
    fvariables: brain.fvariables.map((item) => resolveNumberItem(item, profile, "fvar", allocatedFVars, approvedVarPool)),
    states: brain.states.map((item) => resolveState(item, profile)),
    ranges: brain.ranges.map((item) => deriveRange(item, profile)),
    commands: (brain.commands || []).map((item) => resolveCommand(item, profile)),
  };
  const replacementMap = buildReplacementMap(resolved, profile);
  const modules = brain.modules.map((module) => ({
    id: module.id,
    risk: module.risk,
    target: parseModuleTarget(module, replacementMap),
    routePreview: renderRoutePreview(module.routePreview, replacementMap),
    removeRules: module.removeRules.map((rule) => ({
      ...rule,
      match_any: Array.isArray(rule.match_any) ? rule.match_any.map((item) => renderTemplate(item, replacementMap)) : [],
    })),
    templates: module.templates.map((template) => renderTemplate(template, replacementMap)),
    unresolvedPlaceholders: module.templates.flatMap((template) => {
      const rendered = renderTemplate(template, replacementMap);
      return [
        ...[...rendered.matchAll(/\$\{[^}]+\}/g)].map((m) => m[0]),
        ...validateCommandRefs(rendered, profile),
      ];
    }),
  }));
  const conflicts = [
    ...resolved.variables,
    ...resolved.fvariables,
    ...resolved.states,
    ...resolved.ranges,
    ...resolved.commands,
  ].filter((item) => item.status === "conflict" || item.status === "needs_review" || item.status === "warning");
  const liteFit = buildLiteFitPlan(brain, { resolved }, modules);
  const styleAdapter = buildStyleAdapter(profile, brain);

  return {
    brain: brain.frontmatter,
    resolved,
    replacementMap,
    conflicts,
    modules,
    liteFit,
    styleAdapter,
    resolverReport: buildResolverReport(profile, brain, resolved, liteFit, styleAdapter),
    approvedVarPool: normalizeApprovedVarPool(approvedVarPool),
  };
}

function getBrainId(brainMeta) {
  return brainMeta?.brain_id || brainMeta?.brainId || "brain";
}

function uniqueValues(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];
}

function normalizeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectNewline(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeContentNewline(content, newline) {
  return String(content || "").replace(/\r?\n/g, newline).trim() + newline;
}

function extractMarkerId(content) {
  const match = String(content || "").match(/AI_PATCH_BEGIN:\s*([^\r\n]+)/);
  return match ? match[1].trim() : null;
}

function ensureControllerTrigger1(content) {
  return String(content || "").split(/(?=^\s*\[State\b)/gim).map((block) => {
    if (!/^\s*\[State\b/im.test(block)) return block;
    if (!/^\s*type\s*=\s*[A-Za-z]/im.test(block)) return block;
    if (/^\s*trigger1\s*=/im.test(block)) return block;
    if (!/^\s*triggerAll\s*=/im.test(block)) return block;
    const insertAt = block.search(/^\s*(value|ignorehitpause|persistent|ctrl)\s*=/im);
    if (insertAt >= 0) return `${block.slice(0, insertAt)}trigger1 = 1\n${block.slice(insertAt)}`;
    return `${block.trimEnd()}\ntrigger1 = 1\n`;
  }).join("");
}

function ensureMarkedContent(moduleId, content, brainId) {
  const markerId = extractMarkerId(content) || `${brainId}:${moduleId}:v1`;
  const safeContent = ensureControllerTrigger1(content);
  if (extractMarkerId(content)) return { markerId, content: safeContent };
  return {
    markerId,
    content: `; AI_PATCH_BEGIN: ${markerId}\n${safeContent.trim()}\n; AI_PATCH_END: ${markerId}`,
  };
}

function findSystemFile(profile) {
  const candidates = uniqueValues([
    ...(profile.absoluteFiles?.cns || []),
    ...(profile.absoluteFiles?.st || []),
  ]);
  return candidates.find((file) => /system/i.test(path.basename(file))) || candidates[0] || null;
}

function resolveTargetFile(profile, fileRole) {
  const role = String(fileRole || "").toLowerCase();
  if (role === "cmd") return profile.absoluteFiles?.cmd || null;
  if (role === "air") return profile.absoluteFiles?.air || null;
  if (role === "def") return profile.absoluteFiles?.def || null;
  if (role === "system") return findSystemFile(profile);
  if (role === "cns") return profile.absoluteFiles?.cns?.[0] || profile.absoluteFiles?.st?.[0] || null;
  if (role === "st" || role === "specials") return profile.absoluteFiles?.st?.[0] || profile.absoluteFiles?.cns?.[0] || null;
  return null;
}

function resolvedStateNumber(plan, aliases) {
  const wanted = Array.isArray(aliases) ? aliases : [aliases];
  for (const alias of wanted) {
    const item = (plan.resolved.states || []).find((entry) => entry.id === alias);
    if (item?.actual !== null && item?.actual !== undefined) return Number(item.actual);
  }
  return null;
}

function resolvedRangeNumber(plan, aliases, fallback) {
  const wanted = Array.isArray(aliases) ? aliases : [aliases];
  for (const alias of wanted) {
    const item = (plan.resolved.ranges || []).find((entry) => entry.id === alias);
    if (item?.actual !== null && item?.actual !== undefined) return Number(item.actual);
  }
  return fallback;
}

function fallbackAiTrigger(lite, liteFit = null) {
  const raw = String(lite?.fallbackTrigger || "AILevel && NumEnemy && RoundState = 2").trim();
  const aliases = liteFit?.fallbackTriggers || {};
  const expanded = aliases[raw]?.trigger || raw;
  return String(expanded || "AILevel && NumEnemy && RoundState = 2").replace(/\bAILevel\b/g, "AILevel");
}

function bareTriggerAliasIssues(content, knownAliases = {}) {
  const aliases = new Set(Object.keys(knownAliases || {}));
  const issues = [];
  const triggerLine = /^\s*trigger(?:all|\d+)\s*=\s*(.+)$/gim;
  for (const match of String(content || "").matchAll(triggerLine)) {
    const expr = match[1].trim();
    const firstToken = (expr.match(/^([A-Za-z_][A-Za-z0-9_]*)\b/) || [null, ""])[1];
    if (!firstToken || !aliases.has(firstToken)) continue;
    issues.push({
      id: firstToken,
      preferred: firstToken,
      actual: null,
      strategy: "fallback_trigger_alias_audit",
      status: "conflict",
      reason: `fallback trigger alias was not expanded: ${firstToken}`,
    });
  }
  return issues;
}

function validateBareTriggerAliasesForOperation(operation, plan, profile = null) {
  return bareTriggerAliasIssues(operation?.content || "", plan?.liteFit?.fallbackTriggers || {})
    .map((issue) => ({
      ...issue,
      moduleId: operation?.moduleId,
      filePath: operation?.filePath,
      relativePath: operation?.filePath && profile?.characterPath ? path.relative(profile.characterPath, operation.filePath) : undefined,
    }));
}

function fallbackChangeStateBlock({ title, value, trigger, extra = [], random = 120, powerCost = 0 }) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "";
  const cost = Number(powerCost) || 0;
  return [
    `[State -1, ${title}]`,
    "type = ChangeState",
    `value = ${value}`,
    `triggerAll = ${trigger}`,
    cost > 0 ? `triggerAll = Power >= ${cost}` : "",
    ...extra.map((line) => String(line || "").trim().startsWith(";") ? String(line || "").trim() : `triggerAll = ${line}`),
    `trigger1 = Ctrl && Random < ${random}`,
    "",
  ].filter((line) => line !== "").join("\n");
}

function fallbackHitOverrideBlock({ title, stateNo, attr, trigger, slot = 0, time = 8, forceAir = false, random = 180 }) {
  if (stateNo === null || stateNo === undefined || Number.isNaN(Number(stateNo))) return "";
  return [
    `[State -1, ${title}]`,
    "type = HitOverride",
    `triggerAll = ${trigger}`,
    `trigger1 = Ctrl && Random < ${random}`,
    `attr = ${attr}`,
    `stateNo = ${stateNo}`,
    forceAir ? "forceAir = 1" : "",
    `slot = ${slot}`,
    `time = ${time}`,
    "",
  ].filter(Boolean).join("\n");
}

function generateFallbackTemplate(profile, plan, lite) {
  const mode = lite?.fallbackMode;
  if (!mode || ["skip_module", "report_only", "skip_when_no_route_var"].includes(mode)) return null;
  const trigger = fallbackAiTrigger(lite, plan.liteFit);
  const closeX = resolvedRangeNumber(plan, ["close_super_x", "close_threat_x", "medium_to_special_max_x"], 85);
  const mediumX = resolvedRangeNumber(plan, ["medium_to_special_max_x", "ground_confirm_x"], 96);
  const standParry = resolvedStateNumber(plan, ["stand_parry", "parry_stand"]);
  const crouchParry = resolvedStateNumber(plan, ["crouch_parry", "parry_crouch"]);
  const airParry = resolvedStateNumber(plan, ["air_parry", "parry_air"]);
  const rollForward = resolvedStateNumber(plan, "roll_forward");
  const rollBack = resolvedStateNumber(plan, "roll_back");
  const rushSpecial = resolvedStateNumber(plan, ["rush_special", "close_pressure", "projectile_light"]);
  const projectileSpecial = resolvedStateNumber(plan, ["projectile_light", "ex_projectile", "rush_special"]);
  const antiAir = resolvedStateNumber(plan, ["anti_air_special", "ex_anti_air"]);
  const closeSuper = resolvedStateNumber(plan, ["close_super", "rush_super", "level3_super"]);
  const powerCharge = resolvedStateNumber(plan, "power_charge");
  const costFor = (state) => statePowerCost(profile, Number(state))?.cost || 0;
  const closeSuperInfo = stateScanInfo(profile, Number(closeSuper));
  const closeSuperX = Math.max(35, Math.min(closeX, scanStateReachMaxX(closeSuperInfo, closeX)));
  const closeSuperYMin = scanStateReachMinY(closeSuperInfo, -120);
  const closeSuperYMax = Math.max(scanStateReachMaxY(closeSuperInfo, 45), 10);
  const closeSuperRangeClass = meterStateRangeClass(profile, closeSuper);
  const closeSuperNeedsScanRange = closeSuperRangeClass === "close" || closeSuperRangeClass === "mid";
  const lines = [
    `; Lite Fit fallback generated for ${lite.moduleId}`,
    `; fallback_mode = ${mode}`,
    `; reason = ${lite.reason || ""}`,
  ];

  if (/parry|guard|defensive|hitoverride|inline_trigger/.test(mode)) {
    lines.push(
      fallbackHitOverrideBlock({
        title: `AI Lite ${lite.moduleId} Stand Parry`,
        stateNo: standParry,
        attr: "SA, AA, AP",
        trigger: `${trigger} && StateType != A && MoveType != H && (InGuardDist || EnemyNear,MoveType = A || Enemy,NumProj > 0) && !(EnemyNear,StateType = C && EnemyNear,MoveType = A)`,
        random: 145,
      }),
      fallbackHitOverrideBlock({
        title: `AI Lite ${lite.moduleId} Crouch Parry`,
        stateNo: crouchParry,
        attr: "C, NA, SA, HA",
        trigger: `${trigger} && StateType != A && MoveType != H && (InGuardDist || EnemyNear,MoveType = A || Enemy,NumProj > 0) && (EnemyNear,StateType = C || EnemyNear,StateNo = [400,500])`,
        random: 190,
      }),
      fallbackHitOverrideBlock({
        title: `AI Lite ${lite.moduleId} Air Parry`,
        stateNo: airParry,
        attr: "SA, AA, AP",
        trigger: `${trigger} && StateType = A && MoveType != H && (InGuardDist || EnemyNear,MoveType = A || Enemy,NumProj > 0)`,
        forceAir: true,
        time: 7,
        random: 135,
      }),
      fallbackChangeStateBlock({
        title: `AI Lite ${lite.moduleId} Roll Reset`,
        value: rollBack,
        trigger: `${trigger} && StateType != A && MoveType != H`,
        extra: ["Ctrl", "InGuardDist || Enemy,NumProj > 0", "BackEdgeBodyDist > 50"],
        random: 80,
      })
    );
  }

  if (/inline_trigger/.test(mode)) {
    const projectileThreat = "(Enemy,NumProj > 0 || EnemyNear,NumProj > 0 || EnemyNear,HitDefAttr = SCA,NP || EnemyNear,HitDefAttr = SCA,SP || EnemyNear,HitDefAttr = SCA,HP)";
    lines.push(
      fallbackChangeStateBlock({
        title: `AI Lite ${lite.moduleId} Inline Projectile Roll`,
        value: rollForward,
        trigger: `${trigger} && StateType != A && MoveType != H`,
        extra: ["Ctrl", projectileThreat, "P2BodyDist X = [35,145]", "FrontEdgeBodyDist > 60"],
        random: 120,
      }),
      fallbackChangeStateBlock({
        title: `AI Lite ${lite.moduleId} Inline Close Reset`,
        value: rollBack,
        trigger: `${trigger} && StateType != A && MoveType != H`,
        extra: ["Ctrl", "EnemyNear,MoveType = A", "P2BodyDist X < 45", "BackEdgeBodyDist > 60"],
        random: 90,
      })
    );
  }

  if (/ground_route|hit_confirm|meter_bridge|boss|pressure/.test(mode)) {
    lines.push(
      fallbackChangeStateBlock({
        title: `AI Lite ${lite.moduleId} Ground Route`,
        value: rushSpecial,
        trigger: `${trigger} && StateType != A && MoveType != H`,
        powerCost: costFor(rushSpecial),
        extra: [`P2BodyDist X < ${mediumX}`, "EnemyNear,StateType != L", "MoveHit || MoveContact"],
        random: 150,
      }),
      fallbackChangeStateBlock({
        title: `AI Lite ${lite.moduleId} Anti Air Route`,
        value: antiAir,
        trigger: `${trigger} && StateType != A && MoveType != H`,
        powerCost: costFor(antiAir),
        extra: [`P2BodyDist X < ${mediumX}`, "EnemyNear,StateType = A || EnemyNear,MoveType = H"],
        random: 105,
      })
    );
  }

  if (/super_cashout|meter|boss|cashout/.test(mode)) {
    lines.push(fallbackChangeStateBlock({
      title: `AI Lite ${lite.moduleId} Super Cashout`,
      value: closeSuper,
      trigger: `${trigger} && StateType != A && MoveType != H`,
      powerCost: Math.max(1000, costFor(closeSuper)),
      extra: [
        `P2BodyDist X < ${closeSuperX}`,
        closeSuperNeedsScanRange ? `P2BodyDist Y = [${closeSuperYMin},${closeSuperYMax}]` : "",
        "EnemyNear,StateType != L",
        closeSuperNeedsScanRange
          ? "MoveHit || MoveContact || EnemyNear,Ctrl = 0 || EnemyNear,MoveType = H"
          : "MoveHit || MoveContact || EnemyNear,Life < 250",
        closeSuperNeedsScanRange ? "EnemyNear,MoveType != A || MoveHit || MoveContact" : "",
      ].filter(Boolean),
      random: 130,
    }));
  }

  if (/spacing|charge|stateless_measurement/.test(mode)) {
    lines.push(
      fallbackChangeStateBlock({
        title: `AI Lite ${lite.moduleId} Knockdown Charge`,
        value: powerCharge,
        trigger: `${trigger} && StateType != A && MoveType != H`,
        extra: ["Ctrl", "EnemyNear,StateType = L", "P2BodyDist X > 100", "Power < PowerMax"],
        random: 120,
      }),
      fallbackChangeStateBlock({
        title: `AI Lite ${lite.moduleId} Roll Forward Space`,
        value: rollForward,
        trigger: `${trigger} && StateType != A && MoveType != H`,
        extra: ["Ctrl", "Enemy,NumProj > 0 || P2BodyDist X > 120", "FrontEdgeBodyDist > 50"],
        random: 85,
      })
    );
  }

  if (/anti_projectile|projectile_roll_or_jump/.test(mode)) {
    const projectileX = resolvedRangeNumber(plan, ["projectile_x", "projectile_special_max_x", "medium_x"], 150);
    const projectileMin = resolvedRangeNumber(plan, ["projectile_special_min_x", "close_x"], 45);
    const projectileMax = resolvedRangeNumber(plan, ["projectile_special_max_x", "projectile_x"], 170);
    const projectileThreat = "(Enemy,NumProj > 0 || EnemyNear,NumProj > 0 || EnemyNear,HitDefAttr = SCA,NP || EnemyNear,HitDefAttr = SCA,SP || EnemyNear,HitDefAttr = SCA,HP)";
    lines.push(
      fallbackChangeStateBlock({
        title: `AI Lite ${lite.moduleId} Roll Through Projectile`,
        value: rollForward,
        trigger: `${trigger} && StateType != A && MoveType != H`,
        extra: [
          "Ctrl || StateNo = [100,101]",
          projectileThreat,
          `P2BodyDist X = [20,${projectileX}]`,
          "FrontEdgeBodyDist > 60",
        ],
        random: 170,
      }),
      fallbackChangeStateBlock({
        title: `AI Lite ${lite.moduleId} Back Roll Projectile Reset`,
        value: rollBack,
        trigger: `${trigger} && StateType != A && MoveType != H`,
        extra: [
          "Ctrl || StateNo = [100,101]",
          projectileThreat,
          "P2BodyDist X < 70",
          "BackEdgeBodyDist > 60",
        ],
        random: 110,
      }),
      fallbackChangeStateBlock({
        title: `AI Lite ${lite.moduleId} Projectile Counter`,
        value: projectileSpecial,
        trigger: `${trigger} && StateType != A && MoveType != H`,
        powerCost: costFor(projectileSpecial),
        extra: [
          "Ctrl",
          projectileThreat,
          `P2BodyDist X = [${projectileMin},${projectileMax}]`,
          "EnemyNear,StateType != L",
          "!NumHelper",
        ],
        random: 120,
      })
    );
  }

  if (/air_followup/.test(mode)) {
    const airLight = resolvedStateNumber(plan, ["air_light", "jump_light", "air_punch_light"]);
    const airMedium = resolvedStateNumber(plan, ["air_medium", "jump_medium", "air_punch_medium"]);
    const airStrong = resolvedStateNumber(plan, ["air_strong", "jump_strong", "air_kick_strong"]);
    const airX = resolvedRangeNumber(plan, ["air_confirm_x", "air_x", "jump_attack_x"], 70);
    const airYLow = resolvedRangeNumber(plan, ["air_confirm_y_low", "air_y_low"], -95);
    const airYHigh = resolvedRangeNumber(plan, ["air_confirm_y_high", "air_y_high"], 40);
    const airWindow = [
      "Ctrl || MoveHit || MoveContact",
      "EnemyNear,StateType = A || EnemyNear,MoveType = H",
      `P2BodyDist X = [-10,${airX}]`,
      `P2BodyDist Y = [${airYLow},${airYHigh}]`,
      "!InGuardDist || EnemyNear,MoveType = H || Facing = EnemyNear,Facing",
    ];
    lines.push(
      fallbackChangeStateBlock({
        title: `AI Lite ${lite.moduleId} Air Strong Followup`,
        value: airStrong,
        trigger: `${trigger} && StateType = A && MoveType != H`,
        extra: airWindow,
        random: 145,
      }),
      fallbackChangeStateBlock({
        title: `AI Lite ${lite.moduleId} Air Medium Followup`,
        value: airMedium,
        trigger: `${trigger} && StateType = A && MoveType != H`,
        extra: airWindow,
        random: 115,
      }),
      fallbackChangeStateBlock({
        title: `AI Lite ${lite.moduleId} Air Light Followup`,
        value: airLight,
        trigger: `${trigger} && StateType = A && MoveType != H`,
        extra: airWindow,
        random: 95,
      })
    );
  }

  const content = lines.filter((line) => String(line || "").trim()).join("\n").trim();
  if (!/\[State -1,/i.test(content)) return null;
  return content;
}

function scanStateHasHit(info) {
  return !!(!stateIsNoDamageThrowAttempt(info) && (info?.hitDefs?.length || info?.hitSummary || info?.hasEffectiveHit));
}

function scanStateDirectChangeSafe(info) {
  return !!info && info.directChangeSafe !== false && (!info.executionRole || info.executionRole === "root_attack");
}

function scanStateAutoComboSafe(info) {
  return !!info && scanStateDirectChangeSafe(info) && !info.helperOnly && !info.comboUnsafe && !stateIsNoDamageThrowAttempt(info);
}

function scanStateAllowGuardedCombo(info) {
  return !!info && scanStateDirectChangeSafe(info) && !info.helperOnly && !stateIsNoDamageThrowAttempt(info);
}

function meterReliability(info) {
  return info?.meterReliability || null;
}

function meterReliabilityClass(info) {
  return meterReliability(info)?.classification || null;
}

function scannedMeterRecommendedUse(info) {
  return meterReliability(info)?.recommendedUse || null;
}

function meterUsableAsAttack(info) {
  const classification = meterReliabilityClass(info);
  if (!classification) return true;
  return ["close_confirm", "projectile", "grab"].includes(classification);
}

function meterUsableAsComboEnder(info) {
  const classification = meterReliabilityClass(info);
  if (!classification) return true;
  return ["close_confirm", "projectile"].includes(classification);
}

function meterUtilityOnly(info) {
  const classification = meterReliabilityClass(info);
  return ["self_buff", "install"].includes(classification);
}

function meterUnsafeRaw(info) {
  return meterReliabilityClass(info) === "unsafe_raw";
}

function scanStateReachMaxX(info, fallback = 90) {
  const reach = info?.effectiveReach?.length ? info.effectiveReach : info?.reach || [];
  const values = reach.map((item) => Number(item.maxX)).filter(Number.isFinite);
  if (!values.length) return fallback;
  return Math.max(35, Math.min(220, Math.max(...values)));
}

function scanStateReachMinY(info, fallback = -120) {
  const reach = info?.effectiveReach?.length ? info.effectiveReach : info?.reach || [];
  const values = reach.map((item) => Number(item.minY)).filter(Number.isFinite);
  if (!values.length) return fallback;
  return Math.max(-180, Math.min(40, Math.min(...values)));
}

function scanStateReachMaxY(info, fallback = 45) {
  const reach = info?.effectiveReach?.length ? info.effectiveReach : info?.reach || [];
  const values = reach.map((item) => Number(item.maxY)).filter(Number.isFinite);
  if (!values.length) return fallback;
  return Math.max(-180, Math.min(80, Math.max(...values)));
}

function classifyMeterRangeClass(reachMaxX) {
  if (!Number.isFinite(Number(reachMaxX))) return "unknown";
  if (Number(reachMaxX) <= 50) return "close";
  if (Number(reachMaxX) <= 100) return "mid";
  return "long";
}

function meterStateRangeClass(profile, state) {
  const info = stateScanInfo(profile, Number(state));
  return info?.rangeClass || classifyMeterRangeClass(scanStateReachMaxX(info, NaN));
}

function isDiagonalAirInterceptStateInfo(info) {
  const tags = new Set((info?.roleTags || []).map((tag) => String(tag || "").toLowerCase()));
  return tags.has("air_intercept_diagonal")
    || (tags.has("air_only_target") && tags.has("rising_diagonal"))
    || !!(info?.roleStats?.airOnly && info?.roleStats?.risingDiagonal);
}

function isDiagonalAirInterceptState(profile, state) {
  return isDiagonalAirInterceptStateInfo(stateScanInfo(profile, Number(state)));
}

function diagonalAirInterceptWindow(profile, state) {
  const info = stateScanInfo(profile, Number(state));
  const maxX = Math.max(45, Math.min(135, scanStateReachMaxX(info, 90)));
  const minY = Math.max(-170, Math.min(-35, scanStateReachMinY(info, -130)));
  const maxY = Math.min(15, Math.max(-65, scanStateReachMaxY(info, -12)));
  return {
    xMin: -12,
    xMax: maxX,
    yMin: minY,
    yMax: maxY,
  };
}

function diagonalAirInterceptTriggerLines(profile, state, options = {}) {
  const window = diagonalAirInterceptWindow(profile, state);
  const prefix = options.withTriggerAll === false ? "" : "triggerAll = ";
  return [
    `; AI_PATCH_DIAGONAL_AIR_INTERCEPT ${state}: air-only rising diagonal route`,
    `${prefix}P2BodyDist X = [${Math.round(window.xMin)},${Math.round(window.xMax)}]`,
    `${prefix}P2BodyDist Y = [${Math.round(window.yMin)},${Math.round(window.yMax)}]`,
    `${prefix}EnemyNear,StateType = A || EnemyNear,MoveType = H || EnemyNear,HitFall || P2StateNo = [5030,5052]`,
    `${prefix}EnemyNear,Vel Y >= -8 || EnemyNear,MoveType = H || MoveHit || MoveContact`,
    `${prefix}!InGuardDist || MoveHit || MoveContact || EnemyNear,Ctrl = 0`,
  ];
}

function hasDiagonalAirInterceptGuard(block) {
  const source = String(block || "");
  return /\bAI_PATCH_DIAGONAL_AIR_INTERCEPT\b/i.test(source)
    || (
      /EnemyNear\s*,\s*StateType\s*=\s*A/i.test(source)
      && /P2BodyDist\s+Y\s*=\s*\[/i.test(source)
      && /P2BodyDist\s+X\s*=\s*\[/i.test(source)
      && /EnemyNear\s*,\s*Vel\s+Y|EnemyNear\s*,\s*HitFall|P2StateNo\s*=\s*\[/i.test(source)
    );
}

function isCloseOnlyMeterState(profile, state, threshold = 50) {
  const info = stateScanInfo(profile, Number(state));
  const cost = statePowerCost(profile, Number(state));
  return !!cost?.cost && scanStateReachMaxX(info, 999) <= threshold;
}

function meterConfirmTriggers(profile, state) {
  const info = stateScanInfo(profile, Number(state));
  if (isDiagonalAirInterceptStateInfo(info)) {
    return diagonalAirInterceptTriggerLines(profile, state, { withTriggerAll: false })
      .filter((line) => !String(line).trim().startsWith(";"));
  }
  const rangeClass = meterStateRangeClass(profile, state);
  const hardMax = rangeClass === "close" ? 50 : rangeClass === "mid" ? 100 : 220;
  const maxX = Math.max(35, Math.min(hardMax, scanStateReachMaxX(info, rangeClass === "long" ? 160 : 90)));
  const minY = scanStateReachMinY(info, -120);
  const scannedMaxY = scanStateReachMaxY(info, 45);
  const maxY = Math.max(scannedMaxY, 10);
  return [
    `P2BodyDist X = [-20,${maxX}]`,
    `P2BodyDist Y = [${minY},${maxY}]`,
    "MoveHit || MoveContact || EnemyNear,Ctrl = 0 || EnemyNear,MoveType = H",
    "EnemyNear,MoveType != A || MoveHit || MoveContact",
    "EnemyNear,StateType != L",
  ];
}

function isOrbAuraMeterState(profile, state) {
  const info = stateScanInfo(profile, Number(state));
  const cost = statePowerCost(profile, Number(state))?.cost || 0;
  const reachMax = scanStateReachMaxX(info, 999);
  return !!info
    && cost > 0
    && (/helper_trap|trap|aura|orb/i.test(`${info.delivery || ""} ${info.role || ""}`) || Number(state) === 3300)
    && reachMax <= 150;
}

function orbAuraMeterTriggers(profile, state) {
  const info = stateScanInfo(profile, Number(state));
  const maxX = Math.max(45, Math.min(150, scanStateReachMaxX(info, 110)));
  const minY = scanStateReachMinY(info, -175);
  const maxY = Math.max(scanStateReachMaxY(info, 30), 20);
  return [
    `P2BodyDist X = [-25,${maxX}]`,
    `P2BodyDist Y = [${minY},${maxY}]`,
    "EnemyNear,MoveType = A || EnemyNear,Ctrl = 0 || MoveHit || MoveContact || InGuardDist",
    "EnemyNear,StateType != L",
    "FrontEdgeBodyDist > 35 || BackEdgeBodyDist > 35 || MoveHit || MoveContact",
  ];
}

function meterReliabilityTriggers(profile, state) {
  const info = stateScanInfo(profile, Number(state));
  const reliability = meterReliability(info);
  const classification = reliability?.classification || "";
  if (isDiagonalAirInterceptStateInfo(info)) {
    return diagonalAirInterceptTriggerLines(profile, state, { withTriggerAll: false })
      .filter((line) => !String(line).trim().startsWith(";"));
  }
  const maxX = Math.max(25, Math.min(220, scanStateReachMaxX(info, 90)));
  const minY = scanStateReachMinY(info, -120);
  const maxY = Math.max(scanStateReachMaxY(info, 45), 10);
  const highCost = highCostFinisherTriggerLines(profile, state);
  if (highCost.length) {
    return [
      `P2BodyDist X = [-20,${Math.min(125, maxX)}]`,
      `P2BodyDist Y = [${minY},${maxY}]`,
      "EnemyNear,StateType != L",
      ...highCost.map((line) => String(line || "").trim().startsWith(";") ? line : line.replace(/^triggerAll\s*=\s*/i, "")),
    ];
  }
  if (classification === "close_confirm") {
    return [
      `P2BodyDist X = [-20,${Math.min(125, maxX)}]`,
      `P2BodyDist Y = [${minY},${maxY}]`,
      "MoveHit",
      "EnemyNear,MoveType = H || EnemyNear,GetHitVar(HitTime) >= 6",
      "EnemyNear,StateType != L",
      "EnemyNear,MoveType != A || MoveHit",
    ];
  }
  if (classification === "projectile") {
    return [
      `P2BodyDist X = [45,${Math.max(90, maxX)}]`,
      `P2BodyDist Y = [${minY},${maxY}]`,
      "EnemyNear,StateType != L",
      "MoveHit || MoveContact || EnemyNear,Ctrl = 0 || EnemyNear,MoveType = H",
      "!InGuardDist || MoveHit || MoveContact || EnemyNear,Ctrl = 0",
      "FrontEdgeBodyDist > 45 || BackEdgeBodyDist > 45 || MoveHit || MoveContact",
    ];
  }
  if (classification === "grab") {
    return [
      `P2BodyDist X = [-8,${Math.min(35, maxX)}]`,
      "P2BodyDist Y = [-20,20]",
      "EnemyNear,StateType != A",
      "EnemyNear,StateType != L",
      "EnemyNear,MoveType != H || MoveHit || MoveContact",
      "EnemyNear,Ctrl = 0 || MoveHit || MoveContact",
    ];
  }
  if (classification === "self_buff" || classification === "install") {
    return [
      "Ctrl",
      "EnemyNear,StateType = L || P2BodyDist X > 135",
      "!InGuardDist",
      "Enemy,NumProj = 0",
      "EnemyNear,MoveType != A",
    ];
  }
  if (classification === "unsafe_raw") {
    return [
      "0 ; AI_PATCH_METER_RELIABILITY_BLOCKED unsafe_raw",
    ];
  }
  return [];
}

function attackRangeTriggers(profile, state) {
  const info = stateScanInfo(profile, Number(state));
  if (isDiagonalAirInterceptStateInfo(info)) {
    return diagonalAirInterceptTriggerLines(profile, state, { withTriggerAll: false })
      .filter((line) => !String(line).trim().startsWith(";"));
  }
  const rangeClass = meterStateRangeClass(profile, state);
  const delivery = info?.delivery || "unknown";
  const maxX = Math.max(35, Math.min(rangeClass === "close" ? 50 : rangeClass === "mid" ? 100 : 220, scanStateReachMaxX(info, rangeClass === "long" ? 160 : 90)));
  const minY = scanStateReachMinY(info, -120);
  const maxY = Math.max(scanStateReachMaxY(info, 45), 10);
  if (rangeClass === "close" || rangeClass === "mid") {
    return [
      `P2BodyDist X = [-20,${maxX}]`,
      `P2BodyDist Y = [${minY},${maxY}]`,
      "MoveHit || MoveContact || EnemyNear,Ctrl = 0 || EnemyNear,MoveType = H",
      "EnemyNear,MoveType != A || MoveHit || MoveContact",
      targetWakeupOrNotLiedownTrigger(),
    ];
  }
  if (delivery === "projectile") {
    return [
      `P2BodyDist X = [45,${maxX}]`,
      `P2BodyDist Y = [${minY},${maxY}]`,
      targetWakeupOrNotLiedownTrigger(),
      "EnemyNear,MoveType != A || MoveHit || MoveContact || EnemyNear,Ctrl = 0",
      "!InGuardDist || MoveHit || MoveContact || EnemyNear,Ctrl = 0",
    ];
  }
  return [
    `P2BodyDist X = [-20,${maxX}]`,
    `P2BodyDist Y = [${minY},${maxY}]`,
    targetWakeupOrNotLiedownTrigger(),
    "MoveHit || MoveContact || EnemyNear,Ctrl = 0",
    "EnemyNear,MoveType != A || MoveHit || MoveContact",
  ];
}

function statePushbackX(info) {
  const stat = Number(info?.roleStats?.pushbackX ?? info?.roleStats?.maxAbsXVelocity);
  if (Number.isFinite(stat)) return Math.max(0, stat);
  return Math.max(0, ...(info?.hitDefs || []).map(hitDefMaxAbsXVelocity));
}

function statePushbackRiskClass(info) {
  const push = statePushbackX(info);
  if (push >= 10) return "high";
  if (push >= 7) return "medium";
  return "low";
}

function estimatedPostHitDistanceMax(sourceInfo, targetInfo) {
  const sourceReach = scanStateReachMaxX(sourceInfo, 70);
  const push = statePushbackX(sourceInfo);
  const sourceStartup = Number(sourceInfo?.timing?.startup || 4) || 4;
  const targetStartup = Number(targetInfo?.timing?.startup || targetInfo?.scanWindow?.startup || 6) || 6;
  const travelFrames = Math.max(2, Math.min(12, Math.round((sourceStartup + targetStartup) / 2)));
  return Math.max(0, Math.round(sourceReach + push * travelFrames));
}

function routeSpacingCompatibility(profile, fromState, toState) {
  const fromInfo = stateScanInfo(profile, Number(fromState));
  const toInfo = stateScanInfo(profile, Number(toState));
  if (!fromInfo || !toInfo) return { risk: "unknown", guardLines: [], review: "" };
  const push = statePushbackX(fromInfo);
  const targetReach = scanStateReachMaxX(toInfo, 90);
  const targetClass = meterStateRangeClass(profile, toState);
  const targetDelivery = toInfo?.delivery || "unknown";
  const projected = estimatedPostHitDistanceMax(fromInfo, toInfo);
  const projectedCap = Math.max(30, Math.min(220, targetReach - Math.max(0, push * 2)));
  const targetIsCloseOrMid = targetClass === "close" || targetClass === "mid" || Number(toState) >= 1000;
  if (push < 7 || targetDelivery === "projectile") {
    return {
      risk: "low",
      push,
      projected,
      targetReach,
      guardLines: [],
      review: "",
    };
  }
  const highRisk = targetIsCloseOrMid && projected > targetReach + 18;
  const risk = highRisk ? "high" : "medium";
  const cap = Math.max(25, Math.min(targetReach, projectedCap, risk === "high" ? 70 : 95));
  return {
    risk,
    push,
    projected,
    targetReach,
    guardLines: [
      `; AI_PATCH_PUSHBACK_COMPAT ${fromState}->${toState} source push ${Math.round(push)} projected ${projected} target reach ${Math.round(targetReach)}`,
      `P2BodyDist X <= ${Math.round(cap)} || EnemyNear,StateType = A || EnemyNear,MoveType = H`,
      "Abs(EnemyNear,Vel X) <= 3 || EnemyNear,StateType = A || EnemyNear,MoveType = H || MoveHit",
      risk === "high" ? "EnemyNear,GetHitVar(HitTime) >= 8 || EnemyNear,StateType = A || EnemyNear,Ctrl = 0" : "",
    ].filter(Boolean),
    review: risk === "high" ? `pushback source ${fromState} can push target outside ${toState} reach` : "",
  };
}

function routeSpacingGuardLines(profile, fromState, toState) {
  return routeSpacingCompatibility(profile, fromState, toState).guardLines || [];
}

function targetWakeupOrNotLiedownTrigger() {
  return "EnemyNear,StateType != L || (EnemyNear,Anim = 5120 && EnemyNear,AnimTime = [-11,-8]) || (EnemyNear,StateNo = [5110,5119] && EnemyNear,Time >= 8)";
}

function isLauncherOrLungeState(profile, state) {
  const info = stateScanInfo(profile, Number(state));
  if (!info) return false;
  const role = String(info.role || "");
  const reachX = scanStateReachMaxX(info, 90);
  const hasVerticalHit = (info.hitDefs || []).some((hit) => /-\d/.test(`${hit.airVelocity || ""} ${hit.groundVelocity || ""}`));
  return Number(state) >= 1000 && Number(state) <= 1999 && (/launcher/i.test(role) || hasVerticalHit || reachX <= 90);
}

function specialReliabilityTriggers(profile, state) {
  if (!isLauncherOrLungeState(profile, state)) return [];
  return [
    "EnemyNear,GetHitVar(HitTime) >= 8 || EnemyNear,StateType = A || (EnemyNear,Anim = 5120 && EnemyNear,AnimTime = [-11,-8]) || (EnemyNear,StateNo = [5110,5119] && EnemyNear,Time >= 8)",
    targetWakeupOrNotLiedownTrigger(),
  ];
}

function stateRouteScore(profile, state) {
  const info = stateScanInfo(profile, Number(state));
  const cost = statePowerCost(profile, Number(state));
  let score = 0;
  if (info) score += 20;
  if (scanStateHasHit(info)) score += 45;
  if (!scanStateDirectChangeSafe(info)) score -= 140;
  if (info?.helperOnly) score -= 80;
  if (info?.helperStates?.length) score += 8;
  if ((info?.effectiveReach?.length || info?.reach?.length)) score += 14;
  if (/launcher/i.test(info?.role || "")) score += 8;
  if (/special/i.test(info?.role || "")) score += 12;
  if (/super/i.test(info?.role || "")) score += 12;
  if (cost?.cost === 500) score += 8;
  if (cost?.cost === 1000) score += 10;
  if (cost?.cost >= 2000) score += 6;
  if (cost?.cost) {
    const classification = meterReliabilityClass(info);
    if (classification === "close_confirm") score += 24;
    else if (classification === "projectile") score += 14;
    else if (classification === "grab") score -= 8;
    else if (classification === "self_buff" || classification === "install") score -= 90;
    else if (classification === "unsafe_raw") score -= 160;
  }
  return score;
}

function closeInvalidThrowFallbackCandidate(profile, throwState = null) {
  const states = (profile.comboScan?.states || [])
    .filter((info) => scanStateAutoComboSafe(info) && scanStateHasHit(info))
    .filter((info) => Number(info.state) >= 200 && Number(info.state) <= 699)
    .filter((info) => !stateIsNoDamageThrowAttempt(info))
    .filter((info) => scanStateReachMaxX(info, 0) >= 24)
    .filter((info) => scanStateReachMaxX(info, 999) <= 90)
    .map((info) => {
      const tags = new Set(info.roleTags || []);
      const startup = Number(info?.timing?.startup || 8);
      const reach = scanStateReachMaxX(info, 50);
      let score = stateRouteScore(profile, Number(info.state));
      if (tags.has("light_normal")) score += 28;
      if (tags.has("medium_normal")) score += 18;
      if (tags.has("low_starter")) score += 12;
      if (startup && startup <= 5) score += 18;
      else if (startup && startup <= 8) score += 10;
      score -= Math.max(0, reach - 65) / 4;
      if (Number(info.state) === Number(throwState)) score -= 999;
      return { info, score };
    })
    .sort((a, b) => (b.score - a.score) || (Number(a.info.state) - Number(b.info.state)));
  return states[0]?.info || null;
}

function inferredMoves(profile) {
  return profile?.inferredMovelist?.moves || [];
}

function moveStateInfo(profile, move) {
  return stateScanInfo(profile, Number(move?.state));
}

function scoreMoveForStyle(profile, move, spec) {
  const info = moveStateInfo(profile, move);
  if (!move || !info || !scanStateAllowGuardedCombo(info) || !scanStateHasHit(info)) return -9999;
  const text = normalizeMoveText(`${move.moveName || ""} ${move.commandName || ""}`);
  const roleText = `${move.role || ""} ${move.roleFamily || ""} ${(move.roleTags || []).join(" ")} ${info.role || ""} ${info.roleFamily || ""} ${(info.roleTags || []).join(" ")}`.toLowerCase();
  const cost = statePowerCost(profile, Number(move.state))?.cost || 0;
  let score = stateRouteScore(profile, move.state);
  const reasons = [];
  for (const keyword of spec.keywords || []) {
    const normalized = normalizeMoveText(keyword);
    if (normalized && text.includes(normalized)) {
      score += 90;
      reasons.push(`name matches ${keyword}`);
    }
  }
  for (const tag of spec.tags || []) {
    if (roleText.includes(String(tag).toLowerCase())) {
      score += 28;
      reasons.push(`role matches ${tag}`);
    }
  }
  if (spec.stateRange && Number(move.state) >= spec.stateRange[0] && Number(move.state) <= spec.stateRange[1]) score += 24;
  if (spec.cost === "free" && cost === 0) score += 22;
  if (spec.cost === 500 && cost === 500) score += 22;
  if (spec.cost === 1000 && cost === 1000) score += 28;
  if (spec.cost === 2000 && cost === 2000) score += 24;
  if (spec.cost === 3000 && cost >= 3000) score += 24;
  if (cost > 0) {
    const classification = meterReliabilityClass(info);
    if (classification === "close_confirm") score += spec.meterAttack !== false ? 30 : 0;
    else if (classification === "projectile") score += spec.preferProjectile ? 34 : 10;
    else if (classification === "grab") score += spec.preferGrab ? 28 : -20;
    else if (classification === "self_buff" || classification === "install") score += spec.utilityMeter ? 30 : -120;
    else if (classification === "unsafe_raw") score -= 180;
  }
  if (Array.isArray(spec.preferredStates) && spec.preferredStates.includes(Number(move.state))) {
    score += 45;
    reasons.push(`preferred state ${move.state}`);
  }
  if (spec.preferFast && move.timing?.startup && Number(move.timing.startup) <= 6) score += 12;
  if (spec.preferVertical && /vertical|launcher|anti_air/i.test(roleText)) score += 18;
  if (spec.preferReach) score += Math.min(18, scanStateReachMaxX(info, 0) / 10);
  if (spec.preferCrouch) {
    if (/crouch_attack/.test(roleText)) {
      score += 42;
      reasons.push("role matches crouch_attack");
    } else {
      score -= 38;
      reasons.push("penalty: crouch-low alias matched non-crouch state");
    }
  }
  if (spec.preferLowStarter) {
    if (/low_starter|low starter/.test(roleText)) {
      score += 26;
      reasons.push("role matches low_starter");
    } else {
      score -= 28;
      reasons.push("penalty: low alias lacks low_starter");
    }
  }
  if (spec.avoidCost && cost > 0) score -= 25;
  return { score, reasons };
}

function pickStyleMove(profile, spec, usedCounts = new Map()) {
  const candidates = inferredMoves(profile)
    .map((move) => {
      const scored = scoreMoveForStyle(profile, move, spec);
      const state = Number(move.state);
      const reuseCount = usedCounts.get(state) || 0;
      const reuseLimit = spec.reuseLimit ?? 1;
      return {
        move,
        score: scored.score - Math.max(0, reuseCount - reuseLimit + 1) * 35,
        reasons: scored.reasons || [],
      };
    })
    .filter((item) => item.score > -1000)
    .filter((item) => (usedCounts.get(Number(item.move.state)) || 0) < (spec.hardReuseLimit ?? 4))
    .sort((a, b) => (b.score - a.score) || (a.move.state - b.move.state));
  const picked = candidates[0];
  if (!picked) return null;
  usedCounts.set(Number(picked.move.state), (usedCounts.get(Number(picked.move.state)) || 0) + 1);
  return {
    alias: spec.alias,
    state: Number(picked.move.state),
    moveName: picked.move.moveName,
    commandName: picked.move.commandName,
    input: picked.move.input,
    confidence: picked.score >= 150 ? "high" : picked.score >= 105 ? "medium" : "low",
    score: Math.round(picked.score),
    reuseLimit: spec.reuseLimit ?? 1,
    hardReuseLimit: spec.hardReuseLimit ?? 4,
    role: picked.move.roleFamily || picked.move.role || "",
    tags: picked.move.roleTags || [],
    reason: [
      ...picked.reasons,
      `CMD "${picked.move.commandName}" -> state ${picked.move.state}`,
      picked.move.evidence || "",
    ].filter(Boolean).join("; "),
  };
}

function buildWolverineStyleAdapter(profile, brain) {
  const brainId = getBrainId(brain?.frontmatter || brain);
  if (!/wolverine/i.test(`${brainId} ${brain?.frontmatter?.name || ""}`)) return null;
  const usedCounts = new Map();
  const specs = [
    {
      alias: "crouch_low_poke",
      keywords: ["crouch light kick", "crouch light punch", "crouching light", "low kick", "low punch"],
      tags: ["low_starter", "crouch_attack", "light_normal", "normal"],
      stateRange: [400, 499],
      cost: "free",
      reuseLimit: 2,
      hardReuseLimit: 3,
      preferFast: true,
      preferCrouch: true,
      preferLowStarter: true,
    },
    {
      alias: "low_chain",
      keywords: ["crouch medium kick", "crouch medium punch", "crouching medium", "low medium", "sweep"],
      tags: ["low_starter", "crouch_attack", "medium_normal", "normal"],
      stateRange: [400, 499],
      cost: "free",
      reuseLimit: 2,
      hardReuseLimit: 3,
      preferCrouch: true,
      preferLowStarter: true,
    },
    {
      alias: "rush_poke",
      keywords: ["stand light kick", "stand light punch", "crouch light kick", "crouch light punch"],
      tags: ["normal", "light_normal", "low_starter", "standing_attack", "crouch_attack"],
      stateRange: [200, 499],
      cost: "free",
      reuseLimit: 2,
      hardReuseLimit: 3,
      preferFast: true,
    },
    {
      alias: "launcher",
      keywords: ["strong kick", "strong punch", "sky kick"],
      tags: ["launcher", "vertical_coverage", "anti_air_special"],
      stateRange: [200, 1099],
      cost: "free",
      reuseLimit: 1,
      hardReuseLimit: 2,
      preferVertical: true,
    },
    {
      alias: "slash",
      keywords: ["hammer fist", "hammer"],
      tags: ["rush_special", "special", "mid_range", "anti_air_special"],
      stateRange: [1000, 1999],
      cost: "free",
      preferredStates: [1050],
      reuseLimit: 3,
      hardReuseLimit: 4,
      preferReach: true,
    },
    {
      alias: "drill",
      keywords: ["molotov", "drill"],
      tags: ["special", "rush_special", "helper_trap"],
      stateRange: [1000, 1999],
      cost: "free",
      preferredStates: [1000],
      reuseLimit: 2,
      hardReuseLimit: 3,
    },
    {
      alias: "tornado",
      keywords: ["sky kick", "twirling drill", "tornado"],
      tags: ["anti_air_special", "launcher", "vertical_coverage"],
      stateRange: [1000, 1999],
      cost: "free",
      preferredStates: [1060, 1070],
      reuseLimit: 2,
      hardReuseLimit: 3,
      preferVertical: true,
    },
    {
      alias: "air_followup",
      keywords: ["air", "jump"],
      tags: ["air_chain", "air_normal", "strong_normal", "medium_normal"],
      stateRange: [600, 699],
      cost: "free",
      reuseLimit: 2,
      hardReuseLimit: 3,
      preferFast: true,
    },
    {
      alias: "hyper_rush",
      keywords: ["ichi ni san kyaku", "hammer buster", "speedy", "barrage"],
      tags: ["meter_cashout", "hyper", "meter", "mid_range"],
      stateRange: [2000, 6999],
      cost: 1000,
      preferredStates: [3070, 3050],
      reuseLimit: 2,
      hardReuseLimit: 3,
      preferReach: true,
      meterAttack: true,
    },
    {
      alias: "hyper_heavy",
      keywords: ["hyper drill", "ichi ni san kyaku max", "hammer buster max"],
      tags: ["meter_cashout", "hyper", "meter"],
      stateRange: [2000, 6999],
      cost: 2000,
      preferredStates: [3075, 3055, 3100],
      reuseLimit: 1,
      hardReuseLimit: 2,
      meterAttack: true,
    },
  ];
  const mappings = specs.map((spec) => pickStyleMove(profile, spec, usedCounts)).filter(Boolean);
  const byAlias = Object.fromEntries(mappings.map((item) => [item.alias, item]));
  const required = ["rush_poke", "launcher", "slash", "drill", "tornado", "hyper_rush"];
  const coverage = required.filter((alias) => byAlias[alias]).length / required.length;
  return {
    id: "mvc_wolverine_style_adapter",
    sourceBrain: brainId,
    targetCharacter: profile?.name || "",
    mode: coverage >= 0.75 ? "active" : "partial",
    coverage,
    reusePolicy: {
      maxSameStateHard: 4,
      cooldownVar: /wolverine/i.test(brainId) ? 55 : null,
      antiLoop: ["StateNo != target", "PrevStateNo != target", "Time >= 2"],
    },
    mappings,
    aliases: byAlias,
    recommendations: [
      coverage < 0.75 ? "Style adapter is partial; add manual move aliases for missing Wolverine roles." : "",
      !byAlias.air_followup ? "No air follow-up mapped; generator will keep air route separate from ground routes." : "",
    ].filter(Boolean),
  };
}

function buildStyleAdapter(profile, brain) {
  return buildWolverineStyleAdapter(profile, brain);
}

function pickGeneratedMeterStates(profile, max = 4) {
  const candidates = (profile.patchReadiness?.meterCandidates || buildMeterCandidates(profile.comboScan, profile.states?.powerCosts || {}))
    .filter((item) => item.cost > 0)
    .filter((item) => item.hasHitDef)
    .filter((item) => {
      const info = stateScanInfo(profile, Number(item.state));
      return scanStateAutoComboSafe(info) && Number(item.state) >= 1000 && meterUsableAsAttack(info) && !meterUnsafeRaw(info);
    })
    .map((item) => ({ ...item, score: stateRouteScore(profile, item.state) }));
  const roleGroups = [
    (item) => Number(item.state) === 3300,
    (item) => String(item.bucket) === "500",
    (item) => String(item.bucket) === "1000",
    (item) => String(item.bucket) === "2000",
    (item) => String(item.bucket) === "3000" || String(item.bucket) === "3000+",
  ];
  const selected = [];
  for (const group of roleGroups) {
    const best = candidates
      .filter(group)
      .filter((item) => !selected.some((picked) => picked.state === item.state))
      .sort((a, b) => (b.score - a.score) || (a.cost - b.cost) || (a.state - b.state))[0];
    if (best) selected.push(best);
    if (selected.length >= max) break;
  }
  for (const item of candidates.sort((a, b) => (b.score - a.score) || (a.cost - b.cost) || (a.state - b.state))) {
    if (selected.length >= max) break;
    if (!selected.some((picked) => picked.state === item.state)) selected.push(item);
  }
  return selected.slice(0, max);
}

function pickGeneratedFreeSpecialStates(profile, max = 4) {
  const candidates = (profile.comboScan?.states || [])
    .filter((item) => Number(item.state) >= 1000 && Number(item.state) <= 1999)
    .filter((item) => !statePowerCost(profile, Number(item.state))?.cost)
    .filter((item) => scanStateAutoComboSafe(item) && scanStateHasHit(item))
    .filter((item) => /special|launcher|attack/i.test(item.role || ""))
    .map((item) => ({ ...item, score: stateRouteScore(profile, item.state) }))
    .sort((a, b) => (b.score - a.score) || (a.state - b.state));
  const selected = [];
  for (const preferred of [1100, 1000, 1160, 1200]) {
    const found = candidates.find((item) => Number(item.state) === preferred);
    if (found && !selected.some((item) => item.state === found.state)) selected.push(found);
    if (selected.length >= max) return selected;
  }
  for (const item of candidates) {
    if (selected.length >= max) break;
    if (!selected.some((picked) => picked.state === item.state)) selected.push(item);
  }
  return selected;
}

function pickGeneratedAirPokeStates(profile, max = 3) {
  return (profile.comboScan?.states || [])
    .filter((item) => Number(item.state) >= 600 && Number(item.state) <= 699)
    .filter((item) => scanStateAutoComboSafe(item) && scanStateHasHit(item))
    .map((item) => ({ ...item, score: stateRouteScore(profile, item.state) + scanStateReachMaxX(item, 60) / 10 }))
    .sort((a, b) => (b.score - a.score) || (a.state - b.state))
    .slice(0, max);
}

function generatedRouteEdges(route) {
  if (Array.isArray(route?.edges) && route.edges.length) return route.edges;
  return route?.edge ? [route.edge] : [];
}

function generatedRoutePath(edges) {
  const list = Array.isArray(edges) ? edges.filter(Boolean) : [];
  if (!list.length) return [];
  const path = [String(list[0].from)];
  for (const edge of list) path.push(String(edge.to));
  return path;
}

function findNativeChainEdges(edges, chain = [310, 330, 500, 360]) {
  const byTransition = new Map();
  for (const edge of edges || []) {
    byTransition.set(`${Number(edge.from)}->${Number(edge.to)}`, edge);
  }
  const found = [];
  for (let i = 0; i < chain.length - 1; i += 1) {
    const edge = byTransition.get(`${chain[i]}->${chain[i + 1]}`);
    if (!edge) break;
    found.push(edge);
  }
  return found.length >= 2 ? found : [];
}

function findBestNativeChains(edges, max = 2) {
  const candidates = [
    { id: "character_native_chain_310", label: "Character Native Chain 310", chain: [310, 330, 500, 360] },
    { id: "character_native_chain_350", label: "Character Native Chain 350", chain: [350, 370, 380] },
  ];
  return candidates
    .map((item) => ({ ...item, edges: findNativeChainEdges(edges, item.chain) }))
    .filter((item) => item.edges.length >= 2)
    .slice(0, max);
}

function routeEdge(profile, from, to, options = {}) {
  const fromInfo = stateScanInfo(profile, Number(from));
  const toInfo = stateScanInfo(profile, Number(to));
  if (!scanStateAllowGuardedCombo(fromInfo) || !scanStateAllowGuardedCombo(toInfo)) return null;
  if (!scanStateHasHit(toInfo) && !statePowerCost(profile, Number(to))?.cost) return null;
  if (statePowerCost(profile, Number(to))?.cost && !meterUsableAsComboEnder(toInfo)) return null;
  const spacing = routeSpacingCompatibility(profile, from, to);
  return {
    from: Number(from),
    to: Number(to),
    kind: options.kind || "hit-confirm",
    confidence: options.confidence || "synthetic",
    source: options.source || "resolver_synthetic_route",
    controller: options.controller || "Resolver synthetic boss route",
    triggers: options.triggers || "MoveHit, scanner range, power gate",
    fromRole: fromInfo?.role || "unknown",
    toRole: toInfo?.role || "unknown",
    review: options.review || spacing.review || "",
    synthetic: true,
    triggerHints: options.triggerHints || [],
    spacingCompatibility: spacing,
  };
}

function routeCost(profile, edges) {
  return (edges || []).reduce((sum, edge) => sum + (statePowerCost(profile, Number(edge.to))?.cost || 0), 0);
}

function uniqueRouteMeterStates(profile, edges) {
  return uniqueValues((edges || [])
    .map((edge) => Number(edge.to))
    .filter((state) => (statePowerCost(profile, state)?.cost || 0) > 0));
}

function routeMeterReliabilityOk(profile, edges) {
  return uniqueRouteMeterStates(profile, edges)
    .every((state) => meterUsableAsComboEnder(stateScanInfo(profile, state)));
}

function firstExistingState(profile, states, predicate = null) {
  for (const state of states) {
    const info = stateScanInfo(profile, Number(state));
    if (info && scanStateAutoComboSafe(info) && scanStateHasHit(info) && (!predicate || predicate(info, Number(state)))) return Number(state);
  }
  return null;
}

function firstExistingGuardedState(profile, states, predicate = null) {
  for (const state of states) {
    const info = stateScanInfo(profile, Number(state));
    if (info && scanStateAllowGuardedCombo(info) && scanStateHasHit(info) && (!predicate || predicate(info, Number(state)))) return Number(state);
  }
  return null;
}

function rankedStates(profile, predicate) {
  return (profile.comboScan?.states || [])
    .filter((info) => scanStateAutoComboSafe(info) && scanStateHasHit(info))
    .filter((info) => predicate(info, Number(info.state)))
    .map((info) => ({ state: Number(info.state), info, score: stateRouteScore(profile, info.state) }))
    .sort((a, b) => (b.score - a.score) || (a.state - b.state));
}

function bestFreeSpecial(profile, preferred = []) {
  return firstExistingState(profile, preferred, (info, state) => state >= 1000 && state <= 1999 && !statePowerCost(profile, state)?.cost)
    ?? rankedStates(profile, (info, state) => state >= 1000 && state <= 1999 && !statePowerCost(profile, state)?.cost && /special|launcher|attack/i.test(info.role || ""))[0]?.state
    ?? null;
}

function bestExSpecial(profile, preferred = []) {
  return firstExistingState(profile, preferred, (info, state) => state >= 1000 && state <= 1999 && (statePowerCost(profile, state)?.cost || 0) === 500)
    ?? rankedStates(profile, (info, state) => state >= 1000 && state <= 1999 && (statePowerCost(profile, state)?.cost || 0) === 500 && /special|launcher|attack/i.test(info.role || ""))[0]?.state
    ?? null;
}

function bestMeterEnder(profile, preferred = [], options = {}) {
  const minCost = options.minCost ?? 1000;
  const maxCost = options.maxCost ?? 3000;
  const range = options.range || null;
  const rangeOk = (info) => !range || range.includes(info?.rangeClass || "unknown");
  return firstExistingState(profile, preferred, (info, state) => {
    const cost = statePowerCost(profile, state)?.cost || 0;
    return state >= 2000 && cost >= minCost && cost <= maxCost && rangeOk(info) && meterUsableAsComboEnder(info);
  })
    ?? rankedStates(profile, (info, state) => {
      const cost = statePowerCost(profile, state)?.cost || 0;
      return state >= 2000 && cost >= minCost && cost <= maxCost && rangeOk(info) && meterUsableAsComboEnder(info);
    })[0]?.state
    ?? null;
}

function buildSyntheticRoute(profile, config) {
  const path = (config.path || []).filter((state) => state !== null && state !== undefined);
  if (path.length < 2) return null;
  const edges = [];
  for (let i = 0; i < path.length - 1; i += 1) {
    const edge = routeEdge(profile, path[i], path[i + 1], {
      controller: config.label,
      triggers: config.triggerText,
      triggerHints: config.edgeTriggerHints?.[i] || [],
      confidence: config.confidence || "synthetic",
    });
    if (!edge) return null;
    edges.push(edge);
  }
  const totalCost = routeCost(profile, edges);
  const maxPower = 3000;
  if (totalCost > maxPower) return null;
  return {
    id: config.id,
    label: config.label,
    tags: config.tags,
    edges,
    edge: edges[0],
    triggerHints: config.triggerHints || [],
    edgeTriggerHints: config.edgeTriggerHints || [],
    random: config.random || 86,
    synthetic: true,
    routeCost: totalCost,
    routeSource: config.routeSource || "scan_report_synthetic_boss_route",
    styleAdapter: config.styleAdapter || null,
  };
}

function hitVelocityNumbers(value) {
  return String(value || "").match(/-?\d+(?:\.\d+)?/g)?.map(Number).filter(Number.isFinite) || [];
}

function stateHasWallBounceLikeHit(info) {
  return (info?.hitDefs || []).some((hit) => {
    const velocities = [
      ...hitVelocityNumbers(hit.groundVelocity),
      ...hitVelocityNumbers(hit.airVelocity),
    ];
    const maxHorizontal = Math.max(0, ...velocities.filter((_, index) => index % 2 === 0).map((value) => Math.abs(value)));
    return hit.fall && maxHorizontal >= 10;
  });
}

function bestWallBounceFollowup(profile) {
  const source = [1030, 1000]
    .map((state) => Number(state))
    .find((state) => {
      const info = stateScanInfo(profile, state);
      return info && !info.helperOnly && state >= 1000 && state <= 1999 && scanStateHasHit(info) && stateHasWallBounceLikeHit(info);
    }) || null;
  const target = firstExistingState(profile, [1100, 1130, 1050, 1055], (info, state) => (
    state >= 1000
    && state <= 1999
    && scanStateHasHit(info)
    && /launcher|special/i.test(info.role || "")
  ));
  if (!source || !target || source === target) return null;
  return buildSyntheticRoute(profile, {
    id: "synthetic_wall_bounce_followup",
    label: "Synthetic Wall Bounce Followup",
    tags: ["Juggle Combo", "Corner Combo", "Character Native Chain"],
    path: [source, target],
    triggerText: "Wall-bounce style final hit into close launcher follow-up",
    triggerHints: [
      "EnemyNear,HitFall || EnemyNear,StateNo = [5020,5049] || EnemyNear,Vel X != 0",
      "EnemyNear,GetHitVar(HitTime) >= 8 || MoveHit",
      "P2BodyDist Y = [-150,35]",
    ],
    confidence: "high",
    random: 96,
  });
}

function styleState(styleAdapter, alias) {
  const state = styleAdapter?.aliases?.[alias]?.state;
  return state !== null && state !== undefined ? Number(state) : null;
}

function styleMoveLabel(styleAdapter, alias) {
  const item = styleAdapter?.aliases?.[alias];
  return item ? `${item.moveName || item.commandName || alias}(${item.state})` : alias;
}

function synthesizeWolverineStyleRoutes(profile, styleAdapter) {
  if (!styleAdapter || styleAdapter.mode === "partial" && styleAdapter.coverage < 0.5) return [];
  const routes = [];
  const addRoute = (route) => {
    if (!route) return;
    const key = generatedRoutePath(generatedRouteEdges(route)).join("->");
    if (!key || routes.some((item) => generatedRoutePath(generatedRouteEdges(item)).join("->") === key)) return;
    routes.push(route);
  };
  const crouchLow = styleState(styleAdapter, "crouch_low_poke");
  const lowChain = styleState(styleAdapter, "low_chain");
  const rush = styleState(styleAdapter, "rush_poke");
  const launcher = styleState(styleAdapter, "launcher");
  const slash = styleState(styleAdapter, "slash");
  const drill = styleState(styleAdapter, "drill");
  const tornado = styleState(styleAdapter, "tornado");
  const hyper = styleState(styleAdapter, "hyper_rush");
  const heavyHyper = styleState(styleAdapter, "hyper_heavy") || hyper;
  const adapterSummary = ["crouch_low_poke", "low_chain", "rush_poke", "launcher", "slash", "drill", "tornado", "hyper_rush"]
    .map((alias) => `${alias}=${styleMoveLabel(styleAdapter, alias)}`)
    .join(", ");

  addRoute(buildSyntheticRoute(profile, {
    id: "style_crouch_low_confirm_special_cashout",
    label: "Style Crouch Low Confirm Special Cashout",
    tags: ["Crouch Low Confirm", "Rushdown Combo", "Low Starter", "Super Combo"],
    path: [crouchLow, lowChain || rush, slash || drill || tornado, hyper],
    triggerText: `Crouch-low style adapter route: ${adapterSummary}`,
    triggerHints: [
      "Ctrl || MoveHit || MoveContact",
      "P2BodyDist X <= 90",
      "EnemyNear,StateType != A",
      "EnemyNear,StateType != L",
    ],
    edgeTriggerHints: [
      ["MoveHit || MoveContact", "EnemyNear,GetHitVar(HitTime) >= 3 || MoveContact"],
      ["MoveHit || MoveContact", "P2BodyDist X <= 95"],
      ["MoveHit || MoveContact", "EnemyNear,Life < 450 || Life <= 400 || EnemyNear,MoveType = H"],
    ],
    confidence: "style-adapter",
    random: 132,
    routeSource: "style_crouch_low_confirm_adapter",
    styleAdapter: { id: styleAdapter.id, aliases: ["crouch_low_poke", "low_chain", "slash", "hyper_rush"] },
  }));

  addRoute(buildSyntheticRoute(profile, {
    id: "style_crouch_low_confirm_special",
    label: "Style Crouch Low Confirm Special",
    tags: ["Crouch Low Confirm", "Rushdown Combo", "Low Starter", "Special Combo"],
    path: [crouchLow, lowChain || rush, drill || slash || tornado],
    triggerText: `Crouch-low no-meter style route: ${adapterSummary}`,
    triggerHints: [
      "Ctrl || MoveHit || MoveContact",
      "P2BodyDist X <= 90",
      "EnemyNear,StateType != A",
      "EnemyNear,StateType != L",
    ],
    edgeTriggerHints: [
      ["MoveHit || MoveContact", "EnemyNear,GetHitVar(HitTime) >= 3 || MoveContact"],
      ["MoveHit || MoveContact", "P2BodyDist X <= 95"],
    ],
    confidence: "style-adapter",
    random: 142,
    routeSource: "style_crouch_low_confirm_adapter",
    styleAdapter: { id: styleAdapter.id, aliases: ["crouch_low_poke", "low_chain", "drill"] },
  }));

  addRoute(buildSyntheticRoute(profile, {
    id: "wolverine_style_rush_launcher_slash_hyper",
    label: "Wolverine Style Rush Launcher Slash Hyper",
    tags: ["Wolverine Style", "Rushdown Combo", "Launcher Combo", "Super Combo"],
    path: [rush, launcher, slash || tornado || drill, hyper],
    triggerText: `Style adapter route: ${adapterSummary}`,
    triggerHints: ["MoveHit || MoveContact", "P2BodyDist X <= 115", "EnemyNear,StateType != L"],
    edgeTriggerHints: [
      ["MoveHit || MoveContact", "EnemyNear,GetHitVar(HitTime) >= 3 || MoveContact"],
      ["MoveHit", "EnemyNear,StateType = A || EnemyNear,MoveType = H || EnemyNear,GetHitVar(HitTime) >= 8"],
      ["MoveHit || MoveContact", "EnemyNear,Life < 450 || Life <= 400 || EnemyNear,MoveType = H"],
    ],
    confidence: "style-adapter",
    random: 118,
    routeSource: "wolverine_style_adapter",
    styleAdapter: { id: styleAdapter.id, aliases: ["rush_poke", "launcher", "slash", "hyper_rush"] },
  }));

  addRoute(buildSyntheticRoute(profile, {
    id: "wolverine_style_drill_tornado_cashout",
    label: "Wolverine Style Drill Tornado Cashout",
    tags: ["Wolverine Style", "Pressure Combo", "Anti-Air Combo", "Super Combo"],
    path: [rush, drill || slash, tornado || launcher, heavyHyper],
    triggerText: `Style adapter drill/tornado route: ${adapterSummary}`,
    triggerHints: ["MoveHit || MoveContact", "P2BodyDist X <= 125", "EnemyNear,StateType != L"],
    edgeTriggerHints: [
      ["MoveHit || MoveContact", "EnemyNear,Ctrl = 0 || EnemyNear,MoveType = H"],
      ["MoveHit || EnemyNear,StateType = A", "P2BodyDist Y = [-135,45]"],
      ["MoveHit || MoveContact", "EnemyNear,Life < 380 || Life <= 350 || EnemyNear,MoveType = H"],
    ],
    confidence: "style-adapter",
    random: 96,
    routeSource: "wolverine_style_adapter",
    styleAdapter: { id: styleAdapter.id, aliases: ["rush_poke", "drill", "tornado", "hyper_heavy"] },
  }));

  return routes;
}

function synthesizeBossComboRoutes(profile, styleAdapter = null) {
  const routes = [];
  const addRoute = (route) => {
    if (!route) return;
    const key = generatedRoutePath(generatedRouteEdges(route)).join("->");
    if (!key || routes.some((item) => generatedRoutePath(generatedRouteEdges(item)).join("->") === key)) return;
    routes.push(route);
  };

  for (const route of synthesizeWolverineStyleRoutes(profile, styleAdapter)) addRoute(route);

  const normal200 = firstExistingState(profile, [200], (info, state) => state >= 200 && state <= 499);
  const normal230 = firstExistingState(profile, [230], (info, state) => state >= 200 && state <= 499);
  const normal430 = firstExistingState(profile, [430], (info, state) => state >= 200 && state <= 499);
  const normal440 = firstExistingState(profile, [440], (info, state) => state >= 200 && state <= 499);
  const air600 = firstExistingState(profile, [600], (info, state) => state >= 600 && state <= 699);

  const closeSpecial = bestFreeSpecial(profile, [1000, 1005, 1060, 1065]);
  const lightSpecial = bestExSpecial(profile, [1055, 1005]) || bestFreeSpecial(profile, [1050, 1000]);
  const heavySpecial = bestExSpecial(profile, [1065, 1055, 1005]) || bestFreeSpecial(profile, [1060, 1050, 1000]);
  const midSpecial = bestFreeSpecial(profile, [1050, 1060, 1000]);
  const level1Close = bestMeterEnder(profile, [3050, 3000, 3005, 3070], { minCost: 1000, maxCost: 1000, range: ["close", "mid", "long"] });
  const level1Mid = bestMeterEnder(profile, [3070, 3050, 3000, 3005], { minCost: 1000, maxCost: 1000, range: ["mid", "close", "long"] });
  const level2Mid = bestMeterEnder(profile, [3075, 3050, 3055], { minCost: 2000, maxCost: 2000, range: ["mid", "close", "long"] });

  addRoute(buildSyntheticRoute(profile, {
    id: "synthetic_mid_kick_shiden",
    label: "Synthetic Mid Kick Shiden",
    tags: ["Heavy Confirm Combo", "Pressure Combo", "Character Native Chain"],
    path: [normal430, normal230, firstExistingGuardedState(profile, [1030, 1000], (info, state) => state >= 1000 && state <= 1999)],
    triggerText: "Scanned mid kick confirm into standing kick then Shiden-style special",
    triggerHints: ["MoveHit || MoveContact", "P2BodyDist X <= 115", "EnemyNear,StateType != A"],
    confidence: "high",
    random: 112,
  }));

  addRoute(bestWallBounceFollowup(profile));

  addRoute(buildSyntheticRoute(profile, {
    id: "synthetic_light_repeat_special_meter",
    label: "Synthetic Light Repeat Special Meter",
    tags: ["Light Confirm Combo", "Pressure Combo", "Super Combo"],
    path: [normal200, normal200, lightSpecial || midSpecial, level1Close || level1Mid],
    triggerText: "Repeated normal hit-confirm into scanned special/EX and meter ender",
    triggerHints: ["EnemyNear,GetHitVar(HitTime) >= 3 || MoveContact", "P2BodyDist X <= 100"],
    random: 92,
  }));

  addRoute(buildSyntheticRoute(profile, {
    id: "synthetic_heavy_special_level2",
    label: "Synthetic Heavy Special Level2",
    tags: ["Heavy Confirm Combo", "Punish Combo", "Max Damage Combo"],
    path: [normal230 || normal430, normal430 || normal440, heavySpecial || closeSpecial, level2Mid || level1Mid],
    triggerText: "Heavy normal hit-confirm into close special/EX and higher-cost ender",
    triggerHints: ["EnemyNear,MoveType = H || MoveHit", "P2BodyDist X <= 120"],
    random: 78,
  }));

  addRoute(buildSyntheticRoute(profile, {
    id: "synthetic_mid_confirm_cashout",
    label: "Synthetic Mid Confirm Cashout",
    tags: ["Counter Combo", "Desperation Combo", "Super Combo"],
    path: [normal430 || normal230 || normal200, normal440 || normal430 || normal200, midSpecial || closeSpecial, level1Mid || level1Close],
    triggerText: "Mid normal confirm into free special and scanned meter ender",
    triggerHints: ["MoveHit || EnemyNear,Ctrl = 0", "EnemyNear,StateType != A"],
    random: 84,
  }));

  // Air-normal to ground-special routes need a landing bridge. The current generated
  // pool is State -1 ground-safe, so do not synthesize those until scan can prove
  // the character has a valid air-to-ground cancel path.

  return routes;
}

function pickGeneratedComboArchetypes(profile, meterStates, freeSpecialStates, max = 10, styleAdapter = null) {
  const usableTargets = new Set([
    ...meterStates.map((item) => Number(item.state)),
    ...freeSpecialStates.map((item) => Number(item.state)),
  ]);
  const edgeScore = (edge) => {
    let score = 0;
    if (edge.confidence === "high") score += 35;
    if (edge.kind === "hit-confirm") score += 28;
    if (edge.kind === "contact") score += 18;
    if (/normal|low starter|launcher/i.test(edge.fromRole || "")) score += 16;
    if (/special|super/i.test(edge.toRole || "")) score += 20;
    if (usableTargets.has(Number(edge.to))) score += 22;
    if (/utility|unknown/i.test(`${edge.fromRole || ""} ${edge.toRole || ""}`)) score -= 35;
    if (edge.review) score -= 30;
    const spacing = routeSpacingCompatibility(profile, edge.from, edge.to);
    if (spacing.risk === "high") score -= 35;
    else if (spacing.risk === "medium") score -= 12;
    if (spacing.risk !== "low" && spacing.risk !== "unknown") {
      score += Math.min(12, Math.max(0, spacing.targetReach - 45) / 8);
    }
    return score;
  };
  const edges = (profile.comboScan?.routeCandidates || [])
    .filter((edge) => Number(edge.from) >= 100 && Number(edge.to) >= 100)
    .filter((edge) => !/utility|unknown/i.test(`${edge.fromRole || ""} ${edge.toRole || ""}`))
    .filter((edge) => {
      const fromInfo = stateScanInfo(profile, Number(edge.from));
      const toInfo = stateScanInfo(profile, Number(edge.to));
      return scanStateAllowGuardedCombo(fromInfo) && scanStateAllowGuardedCombo(toInfo) && (scanStateHasHit(toInfo) || usableTargets.has(Number(edge.to)));
    })
    .map((edge) => ({ ...edge, score: edgeScore(edge) }))
    .filter((edge) => edge.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.from - b.from) || (a.to - b.to));
  const firstEdge = (predicate) => edges.find(predicate);
  const nativeChains = findBestNativeChains(edges);
  const archetypes = [
    ...nativeChains.map((chain) => ({
      id: chain.id,
      label: chain.label,
      tags: ["Character Native Chain", "Corner Combo", "Juggle Combo", "Pressure Combo"],
      edges: chain.edges,
      edge: chain.edges[0],
      triggerHints: ["MoveContact", "P2BodyDist X <= 170", "FrontEdgeBodyDist < 120 || BackEdgeBodyDist < 120 || MoveContact"],
      random: 120,
    })),
    ...synthesizeBossComboRoutes(profile, styleAdapter),
    {
      id: "light_confirm",
      label: "Light Confirm Combo",
      tags: ["Light Confirm", "Pressure Combo"],
      edge: firstEdge((edge) => Number(edge.from) >= 400 && Number(edge.from) <= 499 && /low starter|normal|launcher|attack/i.test(edge.fromRole || ""))
        || firstEdge((edge) => Number(edge.from) >= 400 && Number(edge.from) <= 499),
      triggerHints: ["MoveHit", "P2BodyDist X <= 90", "EnemyNear,StateType != A"],
      random: 118,
    },
    {
      id: "heavy_punish",
      label: "Heavy Confirm / Punish Combo",
      tags: ["Heavy Confirm", "Punish Combo", "Counter Combo"],
      edge: firstEdge((edge) => /launcher|normal/i.test(edge.fromRole || "") && Number(edge.from) >= 200 && Number(edge.from) <= 399)
        || firstEdge((edge) => /launcher/i.test(edge.fromRole || "")),
      triggerHints: ["MoveHit || EnemyNear,MoveType = H", "P2BodyDist X <= 120"],
      random: 104,
    },
    {
      id: "anti_air_air",
      label: "Anti-Air / Air Combo",
      tags: ["Anti-Air Combo", "Air Combo"],
      edge: firstEdge((edge) => /air normal/i.test(`${edge.fromRole || ""} ${edge.toRole || ""}`))
        || firstEdge((edge) => /launcher/i.test(edge.fromRole || "")),
      triggerHints: ["EnemyNear,StateType = A || EnemyNear,Vel Y < -1", "P2BodyDist Y = [-120,45]"],
      random: 108,
    },
    {
      id: "character_native_chain",
      label: "Character Native Chain",
      tags: ["Character Native Chain", "Corner Combo", "Juggle Combo", "Pressure Combo"],
      edges: nativeChains[0]?.edges || [],
      edge: firstEdge((edge) => Number(edge.from) === 310 && Number(edge.to) === 330)
        || firstEdge((edge) => Number(edge.from) === 330 && Number(edge.to) === 500)
        || firstEdge((edge) => Number(edge.from) === 500 && Number(edge.to) === 360)
        || firstEdge((edge) => /Plasma Combo|native|ranbu/i.test(`${edge.controller || ""} ${edge.triggers || ""}`))
        || firstEdge((edge) => /launcher|special/i.test(`${edge.fromRole || ""} ${edge.toRole || ""}`)),
      triggerHints: ["MoveContact", "P2BodyDist X <= 160", "FrontEdgeBodyDist < 110 || BackEdgeBodyDist < 110 || MoveContact"],
      random: 112,
    },
    {
      id: "super_desperation",
      label: "Super / Desperation Combo",
      tags: ["Super Combo", "Max Damage Combo", "Desperation Combo"],
      edge: firstEdge((edge) => usableTargets.has(Number(edge.to)) && statePowerCost(profile, Number(edge.to))?.cost)
        || firstEdge((edge) => /special|launcher|normal/i.test(edge.fromRole || "")),
      triggerHints: ["Life <= 350 || EnemyNear,Life <= 420 || MoveHit"],
      random: 74,
    },
  ];
  const selected = [];
  const usedEdges = new Set();
  const usedGeneratedRoutes = new Set();
  const usedMeterStates = new Set();
  for (const archetype of archetypes) {
    if (selected.length >= max) break;
    let edge = archetype.edge;
    let routeEdges = generatedRouteEdges(archetype);
    const routeKey = generatedRoutePath(routeEdges).join("->");
    if (!routeKey || usedGeneratedRoutes.has(routeKey)) continue;
    const routeMeters = uniqueRouteMeterStates(profile, routeEdges);
    if (!routeMeterReliabilityOk(profile, routeEdges)) continue;
    if (routeMeters.some((state) => !usedMeterStates.has(state)) && usedMeterStates.size + routeMeters.filter((state) => !usedMeterStates.has(state)).length > 4) continue;
    if (routeEdges.length > 1 && routeEdges.every((item) => usedEdges.has(`${item.from}->${item.to}`))) continue;
    if (routeEdges.length <= 1 && edge && usedEdges.has(`${edge.from}->${edge.to}`)) {
      edge = edges.find((candidate) => !usedEdges.has(`${candidate.from}->${candidate.to}`));
      routeEdges = edge ? [edge] : [];
    }
    if (!routeEdges.length) continue;
    for (const item of routeEdges) usedEdges.add(`${item.from}->${item.to}`);
    for (const state of routeMeters) usedMeterStates.add(state);
    usedGeneratedRoutes.add(routeKey);
    selected.push({
      ...archetype,
      edge: routeEdges[0],
      edges: routeEdges,
      edgeTriggerHints: archetype.edgeTriggerHints || [],
      routeSource: archetype.routeSource,
      styleAdapter: archetype.styleAdapter || null,
    });
  }
  return selected;
}

function generatedChangeStateBlock({ title, value, baseTrigger, sourceState = null, powerCost = 0, maxX = 90, random = 90, extra = [] }) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "";
  const cost = Number(powerCost) || 0;
  return [
    `[State -1, ${title}]`,
    "type = ChangeState",
    `value = ${value}`,
    `triggerAll = ${baseTrigger}`,
    `triggerAll = StateNo != ${value}`,
    `triggerAll = PrevStateNo != ${value}`,
    "triggerAll = Time >= 2 || MoveHit || MoveContact",
    "triggerAll = EnemyNear,StateNo != [800,899] || MoveHit || MoveContact || P2BodyDist X > 70",
    "triggerAll = P2StateNo != [800,899] || MoveHit || MoveContact || P2BodyDist X > 70",
    "triggerAll = P2BodyDist X > 18 || MoveHit || MoveContact || EnemyNear,MoveType = H",
    cost > 0 ? `triggerAll = Power >= ${cost}` : "",
    sourceState !== null && sourceState !== undefined ? `triggerAll = StateNo = ${sourceState}` : "",
    `triggerAll = P2BodyDist X = [-20,${Math.max(35, Math.min(240, Number(maxX) || 90))}]`,
    "triggerAll = EnemyNear,StateType != L",
    "triggerAll = !(NumTarget && Target,StateNo = [5100,5199] && Target,Time > 30)",
    ...extra.map((line) => String(line || "").trim().startsWith(";") ? String(line || "").trim() : `triggerAll = ${line}`),
    `trigger1 = Random < ${random}`,
    "",
  ].filter((line) => line !== "").join("\n");
}

function multiHitSourceGuard(profile, sourceState) {
  if (sourceState === null || sourceState === undefined || Number.isNaN(Number(sourceState))) return null;
  const info = stateScanInfo(profile, Number(sourceState));
  return multiHitCompletionGuard(info);
}

function multiHitCompletionGuard(info) {
  if (!info?.multiHit) return null;
  if (Number.isFinite(Number(info.lastHitElem)) && Number(info.lastHitElem) > 1) {
    return `AnimElemTime(${Number(info.lastHitElem)}) >= 0`;
  }
  if (Number.isFinite(Number(info.lastHitTime)) && Number(info.lastHitTime) > 1) {
    return `Time >= ${Number(info.lastHitTime)}`;
  }
  const activeEnd = Number(info?.timing?.activeEnd);
  if (Number.isFinite(activeEnd) && activeEnd > 1 && /hitdef_time/i.test(String(info?.timing?.source || ""))) {
    return `Time >= ${activeEnd}`;
  }
  return null;
}

function multiHitCompletionLabel(info) {
  if (Number.isFinite(Number(info?.lastHitElem)) && Number(info.lastHitElem) > 1) return `${info.state}:elem${Number(info.lastHitElem)}`;
  if (Number.isFinite(Number(info?.lastHitTime)) && Number(info.lastHitTime) > 1) return `${info.state}:time${Number(info.lastHitTime)}`;
  if (Number.isFinite(Number(info?.timing?.activeEnd)) && /hitdef_time/i.test(String(info?.timing?.source || ""))) {
    return `${info.state}:time${Number(info.timing.activeEnd)}`;
  }
  return `${info?.state || "?"}:unknown`;
}

function bossRouteTriggers({ cost = 0, role = "", reachMax = 90 }) {
  const lines = [
    "EnemyNear,MoveType = H || MoveHit || MoveContact || EnemyNear,Ctrl = 0",
  ];
  if (cost >= 3000) {
    lines.push("MoveHit || EnemyNear,Life < 260 || Life <= 300");
    lines.push(`P2BodyDist X <= ${Math.max(45, Math.min(90, reachMax))}`);
  } else if (cost >= 1000) {
    lines.push("MoveHit || MoveContact || EnemyNear,Life < 420 || Life <= 350");
  } else if (/special|launcher/i.test(role)) {
    lines.push("MoveHit || MoveContact || EnemyNear,MoveType = H");
  }
  lines.push("FrontEdgeBodyDist < 120 || BackEdgeBodyDist < 120 || P2BodyDist X <= 120 || EnemyNear,StateType = A");
  return lines;
}

function meterRouteTriggers(profile, item, reachMax) {
  const cost = Number(item?.cost) || 0;
  const rangeClass = meterStateRangeClass(profile, item?.state);
  const reliabilityTriggers = meterReliabilityTriggers(profile, item?.state);
  if (reliabilityTriggers.length) return reliabilityTriggers;
  if (isOrbAuraMeterState(profile, item?.state)) {
    return orbAuraMeterTriggers(profile, item.state);
  }
  if (rangeClass === "close" || rangeClass === "mid") {
    return attackRangeTriggers(profile, item.state);
  }
  return [
    ...bossRouteTriggers({ cost, role: item?.role || "", reachMax }),
    "EnemyNear,StateType != L",
    "EnemyNear,MoveType != A || MoveHit || MoveContact || EnemyNear,Ctrl = 0",
  ];
}

function specialRouteTriggers(profile, item, reachMax) {
  const info = stateScanInfo(profile, Number(item?.state));
  const reliability = specialReliabilityTriggers(profile, item?.state);
  if (info?.rangeClass === "close" || info?.rangeClass === "mid" || info?.delivery === "projectile") {
    return [
      ...attackRangeTriggers(profile, item.state),
      ...reliability,
    ];
  }
  return [
    ...bossRouteTriggers({ cost: 0, role: item?.role || "", reachMax }),
    ...reliability,
  ];
}

function operationTransitionKeys(operation) {
  const keys = new Set();
  const text = String(operation?.content || "");
  const blocks = text.split(/(?=^\s*\[State\b)/gim);
  for (const block of blocks) {
    if (!/^\s*type\s*=\s*ChangeState\b/im.test(block)) continue;
    const valueMatch = block.match(/^\s*value\s*=\s*(.+?)\s*(?:;.*)?$/im);
    if (!valueMatch) continue;
    const targets = expressionStateTargets(valueMatch[1]);
    if (!targets.length) continue;
    const sources = [];
    for (const match of block.matchAll(/\bStateNo\s*=\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/gim)) {
      sources.push({ min: Number(match[1]), max: Number(match[2]) });
    }
    for (const match of block.matchAll(/\bStateNo\s*=\s*(-?\d+)\b/gim)) {
      sources.push({ min: Number(match[1]), max: Number(match[1]) });
    }
    for (const target of targets) {
      if (!sources.length) keys.add(`any->${target}`);
      for (const source of sources) keys.add(`${source.min}-${source.max}->${target}`);
    }
  }
  return keys;
}

function transitionOverlapsExisting(edge, existingKeys) {
  if (!edge || !existingKeys?.size) return false;
  const from = Number(edge.from);
  const to = Number(edge.to);
  if (existingKeys.has(`${from}-${from}->${to}`) || existingKeys.has(`any->${to}`)) return true;
  for (const key of existingKeys) {
    const match = key.match(/^(-?\d+)-(-?\d+)->(-?\d+)$/);
    if (!match) continue;
    const min = Number(match[1]);
    const max = Number(match[2]);
    const target = Number(match[3]);
    if (target === to && from >= min && from <= max) return true;
  }
  return false;
}

function dedupeGeneratedRoutesAgainstOperations(routes, operations) {
  const existingKeys = new Set();
  for (const operation of operations || []) {
    if (operation.moduleId === "resolver_generated_combo_pool") continue;
    for (const key of operationTransitionKeys(operation)) existingKeys.add(key);
  }
  return (routes || [])
    .map((route) => {
      const originalEdges = generatedRouteEdges(route);
      const edges = route.synthetic && originalEdges.length > 1
        ? originalEdges
        : originalEdges.filter((edge) => !transitionOverlapsExisting(edge, existingKeys));
      return { ...route, edge: edges[0], edges };
    })
    .filter((route) => generatedRouteEdges(route).length);
}

function generateResolverComboPool(profile, brainId, existingOperations = [], styleAdapter = null) {
  const meterStates = pickGeneratedMeterStates(profile, 4);
  const freeSpecialStates = pickGeneratedFreeSpecialStates(profile, 4);
  const airPokeStates = pickGeneratedAirPokeStates(profile, 3);
  const comboRoutes = dedupeGeneratedRoutesAgainstOperations(
    pickGeneratedComboArchetypes(profile, meterStates, freeSpecialStates, 10, styleAdapter),
    existingOperations,
  );
  if (!meterStates.length && !freeSpecialStates.length && !comboRoutes.length && !airPokeStates.length) return null;

  const base = "AILevel && NumEnemy && RoundState = 2 && StateType != A && MoveType != H";
  const lines = [
    "; Resolver-generated combo pool from current character scan report.",
    "; Limits: max 4 meter states, max 4 free specials, max 3 air pokes, max 10 scanner-selected combo archetype routes.",
    "; Each ChangeState is an independent gated transition, not a forced full chain.",
  ];

  for (const route of comboRoutes) {
    const edges = generatedRouteEdges(route);
    edges.forEach((edge, index) => {
      const fromInfo = stateScanInfo(profile, Number(edge.from));
      const toInfo = stateScanInfo(profile, Number(edge.to));
      const guardedRisk = [fromInfo?.comboUnsafeReason, toInfo?.comboUnsafeReason].filter(Boolean).join("; ");
      const cost = statePowerCost(profile, Number(edge.to))?.cost || 0;
      const targetRangeClass = meterStateRangeClass(profile, edge.to);
      const scanRangeTarget = (cost > 0 || Number(edge.to) >= 1000) && (targetRangeClass === "close" || targetRangeClass === "mid" || toInfo?.delivery === "projectile");
      const stepLabel = edges.length > 1 ? ` Step ${index + 1}` : "";
      lines.push(generatedChangeStateBlock({
        title: `AI Resolver ${route.label}${stepLabel} ${edge.from} To ${edge.to}`,
        value: edge.to,
        baseTrigger: base,
        sourceState: edge.from,
        powerCost: cost,
        maxX: scanStateReachMaxX(toInfo, 95),
        random: edge.confidence === "high" ? route.random : Math.max(42, route.random - 24),
        extra: [
          edge.kind === "contact" ? "MoveContact" : "MoveHit",
          multiHitSourceGuard(profile, edge.from),
          ...routeSpacingGuardLines(profile, edge.from, edge.to),
          ...(edge.triggerHints || []),
          ...(scanRangeTarget ? attackRangeTriggers(profile, edge.to) : []),
          ...specialReliabilityTriggers(profile, edge.to),
          "EnemyNear,MoveType = H || MoveHit || MoveContact",
          guardedRisk ? "!(NumTarget && Target,StateNo = [5100,5199])" : "",
          guardedRisk ? "EnemyNear,Ctrl = 0 || MoveHit || MoveContact" : "",
          ...route.triggerHints,
        ].filter(Boolean),
      }));
    });
  }

  for (const item of freeSpecialStates) {
    const reachMax = scanStateReachMaxX(item, 95);
    lines.push(generatedChangeStateBlock({
      title: `AI Resolver Free Special ${item.state}`,
      value: item.state,
      baseTrigger: base,
      powerCost: 0,
      maxX: reachMax,
      random: 72,
      extra: [
        "StateNo = [200,699]",
        "MoveHit || MoveContact",
        ...specialRouteTriggers(profile, item, reachMax),
      ],
    }));
  }

  for (const item of airPokeStates) {
    const reachMax = scanStateReachMaxX(item, 65);
    const minY = scanStateReachMinY(item, -95);
    const maxY = Math.max(scanStateReachMaxY(item, 45), 10);
    lines.push(generatedChangeStateBlock({
      title: `AI Resolver Air Poke ${item.state}`,
      value: item.state,
      baseTrigger: "AILevel && NumEnemy && RoundState = 2 && StateType = A && MoveType != H",
      powerCost: 0,
      maxX: reachMax,
      random: 118,
      extra: [
        "Ctrl || MoveHit || MoveContact",
        `P2BodyDist X = [-12,${Math.max(35, Math.min(120, reachMax))}]`,
        `P2BodyDist Y = [${minY},${maxY}]`,
        "EnemyNear,StateType = A || EnemyNear,MoveType = H || P2BodyDist Y = [-95,35]",
        "EnemyNear,StateType != L",
        "!InGuardDist || MoveHit || MoveContact || EnemyNear,Ctrl = 0",
      ],
    }));
  }

  for (const item of meterStates) {
    const cost = Number(item.cost) || 0;
    const info = stateScanInfo(profile, Number(item.state));
    const reachMax = scanStateReachMaxX(info, cost >= 3000 ? 70 : 120);
    const rangeClass = meterStateRangeClass(profile, item.state);
    const scanRangeMeter = rangeClass === "close" || rangeClass === "mid";
    lines.push(generatedChangeStateBlock({
      title: `AI Resolver Meter State ${item.state}`,
      value: item.state,
      baseTrigger: base,
      powerCost: cost,
      maxX: reachMax,
      random: cost >= 3000 ? 42 : cost >= 2000 ? 52 : 66,
      extra: [
        "Ctrl || StateNo = [200,1999]",
        scanRangeMeter ? "Ctrl || MoveHit || MoveContact || EnemyNear,Ctrl = 0 || EnemyNear,MoveType = H" : "Ctrl || MoveHit || MoveContact",
        ...meterRouteTriggers(profile, item, reachMax),
      ],
    }));
  }

  const content = lines.filter((line) => String(line || "").trim()).join("\n").trim();
  if (!/\[State -1,/i.test(content)) return null;
  return {
    content,
    routePreview: [
      {
        id: "resolver_generated_combo_archetypes",
        type: "generated_combo_archetypes",
        source: "scan_report_route_candidates",
        chain: comboRoutes.flatMap((route) => generatedRoutePath(generatedRouteEdges(route))),
        condition: ["scanner_confirmed_edge", "movehit_or_movecontact", "range_and_power_gate", "boss_archetype_tags"],
        policy: ["max_10_combo_archetype_routes", "transition_level_patch_only"],
        archetypes: comboRoutes.map((route) => `${route.label}: ${generatedRoutePath(generatedRouteEdges(route)).join("->")} [${route.tags.join(", ")}]${route.routeSource ? ` source=${route.routeSource}` : ""}`),
        styleAdapter: styleAdapter ? {
          id: styleAdapter.id,
          mode: styleAdapter.mode,
          coverage: styleAdapter.coverage,
          mappings: styleAdapter.mappings.map((item) => `${item.alias}=${item.state}:${item.moveName}:${item.confidence}`),
        } : null,
      },
      {
        id: "resolver_generated_air_poke_pool",
        type: "air_poke_options",
        source: "scan_report_air_normal_candidates",
        chain: airPokeStates.map((item) => String(item.state)),
        condition: ["air_state_only", "range_y_window", "anti_punish_jump_coverage"],
        policy: ["max_3_air_pokes", "do_not_force_air_to_ground_special"],
      },
      {
        id: "resolver_generated_free_special_pool",
        type: "special_options",
        source: "scan_report_free_special_candidates",
        chain: freeSpecialStates.map((item) => String(item.state)),
        condition: ["no_power_cost", "state_has_hitdef_or_helper_hit", "normal_contact_bridge"],
        policy: ["max_4_free_special_states"],
      },
      {
        id: "resolver_generated_meter_pool",
        type: "meter_options",
        source: "scan_report_meter_candidates",
        chain: meterStates.map((item) => String(item.state)),
        condition: ["power_gate_equals_scanned_cost", "hit_confirm_or_finish_window"],
        policy: ["max_4_meter_states", "do_not_add_costs_together"],
      },
    ],
    summary: {
      meterStates: meterStates.map((item) => item.state),
      freeSpecialStates: freeSpecialStates.map((item) => item.state),
      airPokeStates: airPokeStates.map((item) => item.state),
      comboRoutes: comboRoutes.map((route) => ({
        id: route.id,
        label: route.label,
        tags: route.tags,
        edge: generatedRoutePath(generatedRouteEdges(route)).join("->"),
        source: route.routeSource || "scan_report",
        styleAdapter: route.styleAdapter || null,
      })),
      styleAdapter: styleAdapter ? {
        id: styleAdapter.id,
        mode: styleAdapter.mode,
        coverage: styleAdapter.coverage,
        mappings: styleAdapter.mappings,
      } : null,
    },
    markerId: `${brainId}:resolver_generated_combo_pool:v1`,
  };
}

function needsTargetStuckWatchdog(profile) {
  return !!profile;
}

function generateTargetStuckWatchdog(profile) {
  if (!needsTargetStuckWatchdog(profile)) return null;
  const lines = [
    "; Resolver safety watchdog for scanner-detected custom target / visual-helper risk.",
    "; It releases long-lived custom throw/get-hit states only after a conservative timeout.",
    "; This prevents missing-target custom states from freezing the patched character without interrupting normal throws early.",
    "[State -2, AI Patch Self NoTarget Custom State Escape Ground]",
    "type = SelfState",
    "triggerAll = AILevel && RoundState = 2",
    "triggerAll = Alive",
    "triggerAll = StateNo = [800,999]",
    "triggerAll = StateType != A",
    "triggerAll = Time > 180",
    "triggerAll = !NumTarget",
    "triggerAll = MoveType != A",
    "trigger1 = 1",
    "value = 0",
    "ctrl = 1",
    "ignorehitpause = 1",
    "",
    "[State -2, AI Patch Self NoTarget Custom State Escape Air]",
    "type = SelfState",
    "triggerAll = AILevel && RoundState = 2",
    "triggerAll = Alive",
    "triggerAll = StateNo = [800,999]",
    "triggerAll = StateType = A",
    "triggerAll = Time > 180",
    "triggerAll = !NumTarget",
    "triggerAll = MoveType != A",
    "trigger1 = 1",
    "value = 50",
    "ctrl = 1",
    "ignorehitpause = 1",
    "",
    "[State -2, AI Patch Self Custom Throw Escape Ground]",
    "type = SelfState",
    "triggerAll = AILevel && RoundState = 2",
    "triggerAll = Alive",
    "triggerAll = StateNo = [800,999]",
    "triggerAll = MoveType = H",
    "triggerAll = Time > 150",
    "triggerAll = StateType != A",
    "trigger1 = 1",
    "value = 5120",
    "ctrl = 0",
    "ignorehitpause = 1",
    "",
    "[State -2, AI Patch Self Custom Throw Escape Air]",
    "type = SelfState",
    "triggerAll = AILevel && RoundState = 2",
    "triggerAll = Alive",
    "triggerAll = StateNo = [800,999]",
    "triggerAll = MoveType = H",
    "triggerAll = Time > 150",
    "triggerAll = StateType = A",
    "trigger1 = 1",
    "value = 5050",
    "ctrl = 0",
    "ignorehitpause = 1",
    "",
    "[State -2, AI Patch Self Custom Throw Escape Dead]",
    "type = SelfState",
    "triggerAll = AILevel && RoundState = 2",
    "triggerAll = !Alive",
    "triggerAll = StateNo = [800,999]",
    "triggerAll = MoveType = H",
    "triggerAll = Time > 150",
    "trigger1 = 1",
    "value = 5150",
    "ctrl = 0",
    "ignorehitpause = 1",
    "",
    "[State -2, AI Patch Self Custom State 825 Escape Air]",
    "type = SelfState",
    "triggerAll = AILevel && RoundState = 2",
    "triggerAll = Alive",
    "triggerAll = StateNo = 825",
    "triggerAll = Time > 150",
    "triggerAll = !NumTarget || MoveType = H",
    "triggerAll = StateType = A",
    "trigger1 = 1",
    "value = 5050",
    "ctrl = 0",
    "ignorehitpause = 1",
    "",
    "[State -2, AI Patch Self Custom State 825 Escape Hit]",
    "type = SelfState",
    "triggerAll = AILevel && RoundState = 2",
    "triggerAll = Alive",
    "triggerAll = StateNo = 825",
    "triggerAll = Time > 150",
    "triggerAll = !NumTarget || MoveType = H",
    "triggerAll = StateType != A",
    "triggerAll = MoveType = H",
    "trigger1 = 1",
    "value = 5120",
    "ctrl = 0",
    "ignorehitpause = 1",
    "",
    "[State -2, AI Patch Self Custom State 825 Escape Neutral]",
    "type = SelfState",
    "triggerAll = AILevel && RoundState = 2",
    "triggerAll = Alive",
    "triggerAll = StateNo = 825",
    "triggerAll = Time > 150",
    "triggerAll = !NumTarget",
    "triggerAll = StateType != A",
    "triggerAll = MoveType != H",
    "trigger1 = 1",
    "value = 0",
    "ctrl = 1",
    "ignorehitpause = 1",
    "",
    "[State -2, AI Patch Target Custom Throw Release]",
    "type = TargetState",
    "triggerAll = AILevel && NumTarget && RoundState = 2",
    "triggerAll = Target,Alive",
    "triggerAll = Target,StateNo = [800,999]",
    "triggerAll = Target,MoveType = H",
    "triggerAll = Target,Time > 150",
    "trigger1 = 1",
    "value = 5120",
    "ignorehitpause = 1",
    "",
    "[State -2, AI Patch Target Stuck Release 5160]",
    "type = TargetState",
    "triggerAll = AILevel && NumTarget && RoundState = 2",
    "triggerAll = Target,Alive",
    "triggerAll = Target,StateNo = 5160",
    "triggerAll = Target,Time > 90",
    "triggerAll = Target,StateType = L || Target,MoveType = H",
    "trigger1 = 1",
    "value = 5120",
    "ignorehitpause = 1",
    "",
    "[State -2, AI Patch Target Stuck Release Common Lie]",
    "type = TargetState",
    "triggerAll = AILevel && NumTarget && RoundState = 2",
    "triggerAll = Target,Alive",
    "triggerAll = Target,StateNo = [5100,5199]",
    "triggerAll = Target,Time > 150",
    "triggerAll = Target,StateType = L || Target,MoveType = H",
    "trigger1 = 1",
    "value = 5120",
    "ignorehitpause = 1",
  ].join("\n");
  return lines;
}

function addUnsafeStateGuards(content, profile) {
  const text = String(content || "");
  const blocks = text.split(/(?=^\s*\[State\b)/gim);
  return blocks.map((block) => {
    if (!/^\s*type\s*=\s*ChangeState\b/im.test(block)) return block;
    const valueMatch = block.match(/^\s*value\s*=\s*(.+?)\s*(?:;.*)?$/im);
    if (!valueMatch) return block;
    const targets = expressionStateTargets(valueMatch[1]);
    const riskyTargets = targets
      .map((state) => ({ state, risk: statePatchRisk(profile, Number(state)) }))
      .filter((item) => item.risk.risky);
    if (!riskyTargets.length) return block;
    const guardLines = [
      "triggerAll = !(NumTarget && Target,StateNo = [5100,5199] && Target,Time > 20)",
      "triggerAll = EnemyNear,StateType != L",
    ];
    const missing = guardLines.filter((line) => !block.includes(line));
    if (!missing.length) return block;
    const triggerIndex = block.search(/^\s*trigger1\s*=/im);
    const note = `; AI_PATCH_SAFE_GUARD: ${riskyTargets.map((item) => `${item.state} ${item.risk.reason || "risky target"}`).join("; ")}`;
    const insertion = `${note}\n${missing.join("\n")}\n`;
    if (triggerIndex >= 0) return `${block.slice(0, triggerIndex)}${insertion}${block.slice(triggerIndex)}`;
    return `${block.trimEnd()}\n${insertion}`;
  }).join("");
}

function sourceStatesForBlock(block) {
  const states = new Set();
  for (const match of String(block || "").matchAll(/\bStateNo\s*=\s*(-?\d+)\b/gim)) {
    states.add(Number(match[1]));
  }
  for (const match of String(block || "").matchAll(/\bStateNo\s*=\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/gim)) {
    const min = Number(match[1]);
    const max = Number(match[2]);
    if (max - min <= 40) {
      for (let state = min; state <= max; state += 1) states.add(state);
    }
  }
  return [...states];
}

function multiHitCancelGuardStates(profile) {
  return (profile.comboScan?.states || [])
    .filter((info) => multiHitCompletionGuard(info))
    .filter((info) => !info?.helperOnly && info?.directChangeSafe !== false)
    .filter((info) => {
      const state = Number(info.state);
      const cost = statePowerCost(profile, state)?.cost || 0;
      const role = `${info.role || ""} ${info.roleFamily || ""} ${(info.roleTags || []).join(" ")}`;
      return cost > 0 || state >= 1000 || /special|super|meter|hyper|launcher|rush|anti_air/i.test(role);
    });
}

function multiHitActiveGuardStates(profile) {
  return (profile.comboScan?.states || [])
    .filter((info) => multiHitCompletionGuard(info))
    .filter((info) => !info?.helperOnly)
    .filter((info) => {
      const state = Number(info.state);
      const cost = statePowerCost(profile, state)?.cost || 0;
      const role = `${info.role || ""} ${info.roleFamily || ""} ${(info.roleTags || []).join(" ")}`;
      return cost > 0 || state >= 1000 || /special|super|meter|hyper|launcher|rush|anti_air/i.test(role);
    });
}

function addMultiHitCancelGuards(content, profile) {
  const globalSources = multiHitCancelGuardStates(profile);
  return String(content || "").split(/(?=^\s*\[State\b)/gim).map((block) => {
    if (!/^\s*type\s*=\s*ChangeState\b/im.test(block)) return block;
    if (!/\bMoveHit\b|\bMoveContact\b/i.test(block)) return block;
    if (/!\s*AILevel/i.test(block)) return block;
    const explicitSources = sourceStatesForBlock(block)
      .map((state) => stateScanInfo(profile, state))
      .filter((info) => multiHitCompletionGuard(info));
    const sourceMap = new Map(explicitSources.map((info) => [Number(info.state), info]));
    if (!explicitSources.length) {
      for (const info of globalSources) sourceMap.set(Number(info.state), info);
    }
    const sources = [...sourceMap.values()];
    if (!sources.length) return block;
    const guardParts = sources.map((info) => `(StateNo != ${info.state} || ${multiHitCompletionGuard(info)})`);
    const guardLine = `triggerAll = ${guardParts.join(" && ")}`;
    if (block.includes(guardLine)) return block;
    const triggerIndex = block.search(/^\s*trigger1\s*=/im);
    const noteLabel = explicitSources.length ? "source state" : "active source state";
    const note = `; AI_PATCH_MULTI_HIT_GUARD: wait for ${noteLabel} final hit ${sources.map(multiHitCompletionLabel).join(", ")}`;
    const insertion = `${note}\n${guardLine}\n`;
    if (triggerIndex >= 0) return `${block.slice(0, triggerIndex)}${insertion}${block.slice(triggerIndex)}`;
    return `${block.trimEnd()}\n${insertion}`;
  }).join("");
}

function isEvasiveOrSetupTarget(profile, state) {
  const value = Number(state);
  if (!Number.isFinite(value)) return false;
  if ((value >= 700 && value <= 799) || [100, 105, 106].includes(value)) return true;
  const info = stateScanInfo(profile, value);
  const roleText = `${info?.role || ""} ${info?.roleFamily || ""} ${(info?.roleTags || []).join(" ")} ${meterReliabilityClass(info) || ""}`;
  const noAttack = !(info?.hitDefs || []).length && !info?.stateSignals?.hasProjectileController && !info?.stateSignals?.hasHelperController;
  return noAttack && /roll|dodge|evade|backdash|forward|movement|install|self_buff|setup|guard|parry/i.test(roleText);
}

function addMultiHitEvasiveNoInterruptGuards(content, profile) {
  const guardLines = multiHitEvasiveNoInterruptGuardLines(profile);
  if (!guardLines.length) return String(content || "");
  return String(content || "").split(/(?=^\s*\[State\b)/gim).map((block) => {
    if (!/^\s*type\s*=\s*ChangeState\b/im.test(block)) return block;
    if (/AI_PATCH_MULTI_HIT_NO_EVADE/i.test(block)) return block;
    const valueMatch = block.match(/^\s*value\s*=\s*(-?\d+)\b/im);
    if (!valueMatch) return block;
    const target = Number(valueMatch[1]);
    if (!isEvasiveOrSetupTarget(profile, target)) return block;
    if (/!\s*AILevel/i.test(block) && !/AI_PATCH_BEGIN/i.test(block)) return block;
    const lines = block.split(/\r?\n/);
    const insertIndex = Math.max(
      lines.findIndex((line) => /^\s*value\s*=/i.test(line)),
      lines.findIndex((line) => /^\s*type\s*=\s*ChangeState\b/i.test(line)),
    ) + 1;
    lines.splice(insertIndex > 0 ? insertIndex : Math.min(3, lines.length), 0, ...guardLines);
    return lines.join("\n");
  }).join("");
}

function multiHitEvasiveNoInterruptGuardLines(profile) {
  const sources = multiHitActiveGuardStates(profile);
  if (!sources.length) return [];
  const guardParts = sources.map((info) => `(StateNo != ${info.state} || ${multiHitCompletionGuard(info)})`);
  return [
    `; AI_PATCH_MULTI_HIT_NO_EVADE: do not interrupt active multi-hit before final hit ${sources.map(multiHitCompletionLabel).join(", ")}`,
    `triggerAll = ${guardParts.join(" && ")}`,
  ];
}

function addMultiHitTargetNoInterruptGuards(content, profile) {
  const multiHitTargets = (profile.comboScan?.states || [])
    .filter((info) => multiHitCompletionGuard(info))
    .filter((info) => (statePowerCost(profile, Number(info.state))?.cost || 0) > 0 || Number(info.state) >= 2000);
  if (!multiHitTargets.length) return String(content || "");
  return String(content || "").split(/(?=^\s*\[State\b)/gim).map((block) => {
    if (!/^\s*type\s*=\s*ChangeState\b/im.test(block)) return block;
    if (!/\bMoveHit\b|\bMoveContact\b/i.test(block)) return block;
    if (/!\s*AILevel/i.test(block)) return block;
    const refs = multiHitTargets.filter((info) => new RegExp(`\\bStateNo\\s*=\\s*(?:${info.state}(?!\\d)|\\[\\s*[^\\]]*${info.state}[^\\]]*\\])`, "i").test(block));
    if (!refs.length) return block;
    const guardLine = `triggerAll = ${refs.map((info) => `(StateNo != ${info.state} || ${multiHitCompletionGuard(info)})`).join(" && ")}`;
    if (block.includes(guardLine)) return block;
    const triggerIndex = block.search(/^\s*trigger1\s*=/im);
    const note = `; AI_PATCH_MULTI_HIT_NO_INTERRUPT: do not cancel before final hit ${refs.map(multiHitCompletionLabel).join(", ")}`;
    const insertion = `${note}\n${guardLine}\n`;
    if (triggerIndex >= 0) return `${block.slice(0, triggerIndex)}${insertion}${block.slice(triggerIndex)}`;
    return `${block.trimEnd()}\n${insertion}`;
  }).join("");
}

function addHitConfirmSourceGates(content) {
  return String(content || "").split(/(?=^\s*\[State\b)/gim).map((block) => {
    if (!/^\s*type\s*=\s*ChangeState\b/im.test(block)) return block;
    if (!/^\s*triggerAll\s*=.*\bCtrl\b.*\bMoveHit\b.*\bMoveContact\b.*\bStateNo\s*=/im.test(block)) return block;
    return block.split(/\r?\n/).map((line) => {
      const match = line.match(/^(\s*)triggerAll\s*=\s*(.+)$/i);
      if (!match) return line;
      const expr = match[2].trim();
      if (!/\bCtrl\b/i.test(expr) || !/\bMoveHit\b/i.test(expr) || !/\bMoveContact\b/i.test(expr) || !/\bStateNo\s*=/i.test(expr)) return line;
      if (/Enemy|P2BodyDist|Power|Life|Random|AnimElemTime/i.test(expr)) return line;
      const stateParts = [...expr.matchAll(/\bStateNo\s*=\s*(?:\[\s*-?\d+\s*,\s*-?\d+\s*\]|-?\d+)/gi)]
        .map((item) => item[0].trim());
      if (!stateParts.length) return line;
      const indent = match[1] || "";
      return [
        `${indent}; AI_PATCH_HITCONFIRM_SOURCE_GATE: MoveHit/MoveContact must come from allowed source state.`,
        `${indent}triggerAll = Ctrl || ${stateParts.join(" || ")}`,
        `${indent}triggerAll = Ctrl || MoveHit || MoveContact`,
      ].join("\n");
    }).join("\n");
  }).join("");
}

function assignmentRouteVarsForBlock(block, targetState = null) {
  const vars = [];
  for (const match of String(block || "").matchAll(/\bvar\s*\(\s*(\d+)\s*\)\s*:=\s*(-?\d+)\b/gi)) {
    if (targetState !== null && Number(match[2]) !== Number(targetState)) continue;
    vars.push(Number(match[1]));
  }
  return uniqueValues(vars.filter(Number.isFinite));
}

function assignmentCooldownsForBlock(block, targetState = null) {
  const cooldowns = [];
  for (const match of String(block || "").matchAll(/\bvar\s*\(\s*(\d+)\s*\)\s*:=\s*(-?\d+)\b/gi)) {
    const number = Number(match[1]);
    const value = Number(match[2]);
    if (!Number.isFinite(number) || !Number.isFinite(value)) continue;
    if (targetState !== null && value === Number(targetState)) continue;
    if (value > 0 && value <= 180) cooldowns.push({ number, value });
  }
  const seen = new Set();
  return cooldowns.filter((item) => {
    if (seen.has(item.number)) return false;
    seen.add(item.number);
    return true;
  });
}

function addInvalidThrowFallbacks(content, profile) {
  const source = String(content || "");
  const blocks = source.split(/(?=^\s*\[State\b)/gim);
  return blocks.map((block) => {
    if (!/:=\s*-?\d+\b|^\s*type\s*=\s*ChangeState\b/im.test(block)) return block;
    const throwTargets = blockTargetStates(block)
      .filter((state) => stateIsNoDamageThrowAttempt(stateScanInfo(profile, state)));
    if (!throwTargets.length) return block;
    const throwState = throwTargets[0];
    if (noDamageThrowAttemptHasFallback(source, throwState)) return block;
    const fallback = closeInvalidThrowFallbackCandidate(profile, throwState);
    if (!fallback) return block;
    const fallbackState = Number(fallback.state);
    const routeVars = assignmentRouteVarsForBlock(block, throwState);
    const cooldowns = assignmentCooldownsForBlock(block, throwState);
    const xMax = Math.max(28, Math.min(70, scanStateReachMaxX(fallback, 45)));
    const yMin = scanStateReachMinY(fallback, -35);
    const yMax = Math.max(12, Math.min(40, scanStateReachMaxY(fallback, 20)));
    const common = [
      `; AI_PATCH_INVALID_THROW_FALLBACK ${throwState}: close-range invalid throw -> scanned hit state ${fallbackState}`,
      "triggerAll = AILevel && NumEnemy && RoundState = 2",
      "triggerAll = StateType != A && MoveType != H",
      "triggerAll = Ctrl || MoveHit || MoveContact || StateNo = [20,101]",
      `triggerAll = P2BodyDist X = [-8,${xMax}]`,
      `triggerAll = P2BodyDist Y = [${yMin},${yMax}]`,
      "triggerAll = EnemyNear,StateType != A && EnemyNear,StateType != L",
      "triggerAll = !(EnemyNear,Ctrl = 0 || EnemyNear,MoveType = A || P2StateNo = [120,155])",
      "triggerAll = P2StateNo != [800,899]",
    ];
    const fallbackBlock = routeVars.length ? [
      "",
      `[State -1, AI Patch Invalid Throw Fallback ${throwState} To ${fallbackState}]`,
      "type = Null",
      ...common,
      ...routeVars.map((routeVar) => `triggerAll = !var(${routeVar})`),
      ...cooldowns.map((item) => `triggerAll = !var(${item.number})`),
      "trigger1 = Random < 120",
      ...routeVars.map((routeVar) => `trigger1 = 1 || (var(${routeVar}) := ${fallbackState})`),
      ...cooldowns.map((item) => `trigger1 = 1 || (var(${item.number}) := ${item.value})`),
      "",
    ].join("\n") : [
      "",
      `[State -1, AI Patch Invalid Throw Fallback ${throwState} To ${fallbackState}]`,
      "type = ChangeState",
      `value = ${fallbackState}`,
      ...common,
      `triggerAll = StateNo != ${fallbackState}`,
      "trigger1 = Random < 120",
      "",
    ].join("\n");
    return `${block}${fallbackBlock}`;
  }).join("");
}

function hardenGeneratedPatchContent(content, profile) {
  return addInvalidThrowFallbacks(
    addScannedStateSafetyGuards(
      addMeterPowerGates(
        addMultiHitEvasiveNoInterruptGuards(
          addMultiHitTargetNoInterruptGuards(
            addMultiHitCancelGuards(
              addHitConfirmSourceGates(
                addUnsafeStateGuards(content, profile),
              ),
              profile,
            ),
            profile,
          ),
          profile,
        ),
        profile,
      ),
      profile,
    ),
    profile,
  );
}

function generatePowerChargeShim(profile) {
  const native = detectNativePowerCharge(profile);
  if (!native) return null;
  const holdAnim = Number(native.holdAnim);
  const endAnim = Number(native.endAnim);
  if (!Number.isFinite(holdAnim) || !Number.isFinite(endAnim)) return null;
  const available = new Set(profile.commands?.available || []);
  const holdCommands = ["hold_a", "hold_y", "hold_b", "hold_c", "hold_x"].filter((command) => available.has(command));
  const playerHoldExpr = holdCommands.length
    ? holdCommands.map((command) => `command = "${command}"`).join(" || ")
    : "0";
  const renderControllers = (controllers, options = {}) => (controllers || [])
    .map((controller) => renderReusedChargeController(controller, options))
    .filter(Boolean);
  const startControllers = renderControllers(native.startControllers, { state: 730, phase: "start", fullPowerOnly: false });
  const holdControllers = renderControllers(native.holdControllers, { state: 730, phase: "hold", fullPowerOnly: false });
  const endControllers = renderControllers(native.endControllers, { state: 731, phase: "end", fullPowerOnly: false });
  const fullPowerControllers = renderControllers(native.fullPowerControllers, { state: 731, phase: "full", fullPowerOnly: true });
  const chargePowerValue = "2 + ifElse(time < 60, 0, (time - 60) / 12)";
  return [
    "; Compatibility power-charge shim generated from native charge sequence.",
    `; Native hold state ${native.holdState}, end state ${native.endState}.`,
    "; AI_PATCH_CHARGE_RATE_POLICY: Roxy/Rose-style ramp, not native per-tick burst gain.",
    "[StateDef 730]",
    "type = S",
    "physics = S",
    "moveType = I",
    `anim = ${holdAnim}`,
    "velSet = 0,0",
    "ctrl = 0",
    "",
    ...startControllers,
    ...holdControllers,
    "[State 730, PowerAdd]",
    "type = PowerAdd",
    "triggerAll = Power < const(data.power) && Power < PowerMax",
    `trigger1 = !AILevel && (${playerHoldExpr})`,
    "trigger2 = AILevel",
    `value = ${chargePowerValue}`,
    "",
    "[State 730, End]",
    "type = ChangeState",
    "trigger1 = Power >= const(data.power) || Power >= PowerMax || RoundState != 2",
    `trigger2 = !AILevel && !(${playerHoldExpr})`,
    "trigger3 = AILevel && (InGuardDist || P2BodyDist X <= 120 || EnemyNear,MoveType = A || Enemy,NumProj > 0)",
    "value = 731",
    "ctrl = 1",
    "",
    "[StateDef 731]",
    "type = S",
    "physics = S",
    "moveType = I",
    `anim = ${endAnim}`,
    "velSet = 0,0",
    "ctrl = 1",
    "",
    ...endControllers,
    ...fullPowerControllers,
    "[State 731, End]",
    "type = ChangeState",
    "trigger1 = AnimTime = 0",
    "value = 0",
    "ctrl = 1",
  ].join("\n");
}

function renderReusedChargeController(controller, options = {}) {
  const body = String(controller?.body || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const type = String(controller?.type || "");
  if (!body || !chargeShimSafeController(controller)) return null;
  let renderedBody = body
    .replace(/\bNumExplod\s*\(\s*11110\s*\)/gi, "NumExplod(730)")
    .replace(/^\s*ID\s*=\s*11110\s*$/gim, "ID = 730");
  if (options.phase === "hold" && /^Explod$/i.test(type)) {
    renderedBody = addChargeHoldExplodRefresh(renderedBody);
  }
  if (options.fullPowerOnly) {
    renderedBody = renderedBody.replace(/^(\s*trigger1\s*=\s*)/im, `triggerAll = Power >= const(data.power) || Power >= PowerMax\n$1`);
  }
  const state = Number(options.state) || 730;
  return [
    `[State ${state}, AI Patch Reused ${type}]`,
    renderedBody,
    "",
  ].join("\n");
}

function controllerParamExpression(body, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*([^\\r\\n;]+)`, "im");
  return String(body || "").match(pattern)?.[1]?.trim() || "";
}

function addChargeHoldExplodRefresh(body) {
  const text = String(body || "");
  if (/AI_PATCH_CHARGE_EFFECT_REFRESH/i.test(text)) return text;
  if (!/^\s*trigger\d+\s*=\s*time\s*=\s*0\s*$/im.test(text)) return text;
  const idExpr = controllerParamExpression(text, "ID");
  const animExpr = controllerParamExpression(text, "anim");
  const explodKey = idExpr || animExpr;
  if (!explodKey || /[^A-Za-z0-9_().,+\-*/\s]/.test(explodKey)) return text;
  const triggerNumbers = [...text.matchAll(/^\s*trigger(\d+)\s*=/gim)].map((match) => Number(match[1])).filter(Number.isFinite);
  const nextTrigger = triggerNumbers.length ? Math.max(...triggerNumbers) + 1 : 2;
  return `${text}\n; AI_PATCH_CHARGE_EFFECT_REFRESH: keep short non-looping hold explods alive while charge continues.\ntrigger${nextTrigger} = time > 0 && !NumExplod(${explodKey})`;
}

function normalizeResolverMode(value) {
  const mode = String(value || "supplemental").toLowerCase();
  return ["supplemental", "assist", "aggressive"].includes(mode) ? mode : "supplemental";
}

function buildPatchOperations(profile, plan, selectedModules = null, options = {}) {
  const selected = selectedModules?.length ? new Set(selectedModules) : null;
  const resolverMode = normalizeResolverMode(options.resolverMode);
  const brainId = getBrainId(plan.brain);
  const operations = [];
  const skipped = [];
  const liteByModule = new Map((plan.liteFit?.modules || []).map((item) => [item.moduleId, item]));

  const mappingLines = [
    ...plan.resolved.variables
      .filter((item) => item.actual)
      .map((item) => `; AI_PATCH_VAR ${item.id} = ${item.actual}`),
    ...plan.resolved.fvariables
      .filter((item) => item.actual)
      .map((item) => `; AI_PATCH_FVAR ${item.id} = ${item.actual}`),
    ...(plan.approvedVarPool || [])
      .map((item) => `; AI_PATCH_VAR_APPROVED ${item.kind}.${item.approvedFor || "any"} = ${item.kind}(${item.number}) ; ${item.reason || "manual approval"}`),
  ];
  const mappingFilePath = resolveTargetFile(profile, "cmd") || findSystemFile(profile);
  const hasApprovedPool = (plan.approvedVarPool || []).length > 0;
  if ((!selected || selected.has("variable_comments") || hasApprovedPool) && mappingFilePath && mappingLines.length) {
    operations.push({
      id: "variable_comments:0",
      moduleId: "variable_comments",
      risk: "low",
      fileRole: "cmd",
      filePath: mappingFilePath,
      mode: "upsert-marker",
      markerId: `${brainId}:variable_comments:v1`,
      content: `; AI_PATCH_BEGIN: ${brainId}:variable_comments:v1\n${mappingLines.join("\n")}\n; AI_PATCH_END: ${brainId}:variable_comments:v1`,
      insertBefore: ["[Command]", "[Statedef -1]", "[State -1"],
      insertAfter: [],
      fallbackInsertBefore: [],
      insertAfterModule: null,
      removeRules: [],
      unresolvedPlaceholders: validateCommandRefs(mappingLines.join("\n"), profile),
    });
  }

  const fallbackFilePath = resolveTargetFile(profile, "cmd");
  const powerChargeShim = needsPowerChargeShim(profile, { resolved: plan.resolved }) ? generatePowerChargeShim(profile) : null;
  const powerChargeShimPath = powerChargeShim ? (findSystemFile(profile) || resolveTargetFile(profile, "cns") || fallbackFilePath) : null;
  if (powerChargeShim && powerChargeShimPath && (!selected || selected.has("power_charge_shim") || selected.has("knockdown_reset_charge"))) {
    const markerId = `${brainId}:power_charge_shim:v1`;
    operations.push({
      id: "power_charge_shim:0",
      moduleId: "power_charge_shim",
      risk: "low",
      fileRole: "system",
      filePath: powerChargeShimPath,
      mode: "upsert-marker",
      markerId,
      content: `; AI_PATCH_BEGIN: ${markerId}\n${powerChargeShim}\n; AI_PATCH_END: ${markerId}`,
      insertBefore: ["[Statedef -1]", "[StateDef -1]", "[State -1]"],
      insertAfter: [],
      fallbackInsertBefore: [],
      insertAfterModule: null,
      routePreview: [{
        id: "power_charge_shim",
        type: "state_compatibility",
        source: "native_power_charge_scan",
        chain: ["730 hold", "731 end"],
        condition: ["missing preferred 730", "native PowerAdd charge detected", "Roxy/Rose charge-rate policy"],
        policy: ["reuse native hold/end animations", "refresh short hold charge effects", "use standard ramped charge gain", "AI exits on threat/full power"],
      }],
      removeRules: [],
      unresolvedPlaceholders: [],
      optionalMissingStateAliases: [],
      generatedFallback: true,
    });
  }
  for (const lite of plan.liteFit?.modules || []) {
    if (lite.mode !== "fallback") continue;
    if (selected && !selected.has(lite.moduleId)) continue;
    const content = generateFallbackTemplate(profile, plan, lite);
    if (!content || !fallbackFilePath) {
      skipped.push({ moduleId: lite.moduleId, reason: `Lite Fit fallback has no safe generated template for ${lite.fallbackMode}`, liteFit: lite });
      continue;
    }
    const gatedContent = hardenGeneratedPatchContent(content, profile);
    const markerId = `${brainId}:fallback:${lite.moduleId}:v1`;
    operations.push(withOldAiMeterPriority({
      id: `fallback:${lite.moduleId}:0`,
      moduleId: lite.moduleId,
      risk: "low",
      fileRole: "cmd",
      filePath: fallbackFilePath,
      mode: "upsert-marker",
      markerId,
      content: `; AI_PATCH_BEGIN: ${markerId}\n${gatedContent}\n; AI_PATCH_END: ${markerId}`,
      insertBefore: ["[State -1"],
      insertAfter: ["[Statedef -1]"],
      fallbackInsertBefore: [],
      insertAfterModule: null,
      routePreview: [],
      removeRules: [],
      unresolvedPlaceholders: validateCommandRefs(gatedContent, profile),
      optionalMissingStateAliases: [],
      generatedFallback: true,
      fallbackMode: lite.fallbackMode,
    }, profile));
  }

  for (const module of plan.modules) {
    if (selected && !selected.has(module.id)) continue;
    if (module.id === "variable_comments") continue;
    const lite = liteByModule.get(module.id);
    if (lite && ["skip", "fallback", "blocked"].includes(lite.mode)) {
      skipped.push({
        moduleId: module.id,
        reason: `Lite Fit ${lite.mode}: ${lite.reason}`,
        liteFit: lite,
      });
      continue;
    }
    const target = module.target || {};
    const filePath = resolveTargetFile(profile, target.file);
    if (!filePath) {
      skipped.push({ moduleId: module.id, reason: `No target file resolved for role '${target.file || "unknown"}'` });
      continue;
    }

    module.templates.forEach((template, index) => {
      const guardedTemplate = hardenGeneratedPatchContent(template, profile);
      const marked = ensureMarkedContent(module.id, guardedTemplate, brainId);
      operations.push(withOldAiMeterPriority({
        id: `${module.id}:${index}`,
        moduleId: module.id,
        risk: module.risk,
        fileRole: target.file,
        filePath,
        mode: "upsert-marker",
        markerId: marked.markerId,
        content: marked.content,
        insertBefore: normalizeArray(target.insert_before),
        insertAfter: normalizeArray(target.insert_after),
        fallbackInsertBefore: normalizeArray(target.fallback_insert_before),
        insertAfterModule: target.insert_after_module || null,
        routePreview: module.routePreview || [],
        removeRules: module.removeRules || [],
        unresolvedPlaceholders: [
          ...[...marked.content.matchAll(/\$\{[^}]+\}/g)].map((match) => match[0]),
          ...validateCommandRefs(marked.content, profile),
        ],
        optionalMissingStateAliases: optionalPlaceholderIds([
          ...[...marked.content.matchAll(/\$\{[^}]+\}/g)].map((match) => match[0]),
        ], plan),
      }, profile));
    });
  }

  const resolverPool = resolverMode === "assist"
    ? generateResolverComboPool(profile, brainId, operations, plan.styleAdapter)
    : generateResolverComboPool(profile, brainId, resolverMode === "aggressive" ? [] : operations, plan.styleAdapter);
  if (resolverPool && fallbackFilePath && resolverMode !== "off" && (!selected || selected.has("resolver_generated_combo_pool"))) {
    const guardedResolverContent = hardenGeneratedPatchContent(resolverPool.content, profile);
    operations.push(withOldAiMeterPriority({
      id: "resolver_generated_combo_pool:0",
      moduleId: "resolver_generated_combo_pool",
      risk: "medium",
      fileRole: "cmd",
      filePath: fallbackFilePath,
      mode: "upsert-marker",
      markerId: resolverPool.markerId,
      content: `; AI_PATCH_BEGIN: ${resolverPool.markerId}\n${guardedResolverContent}\n; AI_PATCH_END: ${resolverPool.markerId}`,
      insertBefore: resolverMode === "aggressive"
        ? ["[State -1, AI Power Charge]", "[State -1, Crouching Light Punch]", "[State -1"]
        : ["[State -1, AI Power Charge]", "[State -1"],
      insertAfter: ["[Statedef -1]"],
      fallbackInsertBefore: [],
      insertAfterModule: resolverMode === "aggressive" ? null : "meter_cashout_safe",
      routePreview: resolverPool.routePreview,
      removeRules: [],
      unresolvedPlaceholders: validateCommandRefs(guardedResolverContent, profile),
      optionalMissingStateAliases: [],
      generatedFallback: true,
      resolverMode,
      generatedResolverPool: resolverPool.summary,
    }, profile));
  }

  const watchdogContent = addMeterPowerGates(generateTargetStuckWatchdog(profile), profile);
  const systemFilePath = findSystemFile(profile) || fallbackFilePath;
  const shouldIncludeWatchdog = watchdogContent && systemFilePath && (!selected || operations.length || selected.has("resolver_target_stuck_watchdog"));
  if (shouldIncludeWatchdog) {
    const markerId = `${brainId}:resolver_target_stuck_watchdog:v1`;
    operations.push({
      id: "resolver_target_stuck_watchdog:0",
      moduleId: "resolver_target_stuck_watchdog",
      risk: "medium",
      fileRole: "system",
      filePath: systemFilePath,
      mode: "upsert-marker",
      markerId,
      content: `; AI_PATCH_BEGIN: ${markerId}\n${watchdogContent}\n; AI_PATCH_END: ${markerId}`,
      insertBefore: ["[Statedef -1]", "[State -1]"],
      insertAfter: [],
      fallbackInsertBefore: [],
      insertAfterModule: null,
      routePreview: [{
        id: "resolver_target_stuck_watchdog",
        type: "safety_watchdog",
        source: "scan_report_combo_unsafe_states",
        chain: ["Self 800-999 -> 5120/5050 after timeout", "Target 800-999/5160/5100-5199 -> 5120 after timeout"],
        condition: ["AILevel", "custom throw/get-hit state", "Time > 150 for custom 800-999"],
        policy: ["watchdog_only", "late_timeout_only", "no_damage_defense_or_heal_change"],
      }],
      removeRules: [],
      unresolvedPlaceholders: validateCommandRefs(watchdogContent, profile),
      optionalMissingStateAliases: [],
      generatedFallback: true,
      resolverMode,
    });
  }

  const dynamicRouteVars = dynamicRouteVarsFromOperations(operations);
  const dynamicRouteGuardContent = addMeterPowerGates(generateDynamicMeterRouteWindowGuard(profile, dynamicRouteVars), profile);
  if (dynamicRouteGuardContent && fallbackFilePath && (!selected || operations.length || selected.has("resolver_dynamic_meter_route_window_guard"))) {
    const markerId = `${brainId}:resolver_dynamic_meter_route_window_guard:v1`;
    operations.push({
      id: "resolver_dynamic_meter_route_window_guard:0",
      moduleId: "resolver_dynamic_meter_route_window_guard",
      risk: "medium",
      fileRole: "cmd",
      filePath: fallbackFilePath,
      mode: "upsert-marker",
      markerId,
      content: `; AI_PATCH_BEGIN: ${markerId}\n${dynamicRouteGuardContent}\n; AI_PATCH_END: ${markerId}`,
      insertBefore: ["[State -1"],
      insertAfter: ["[Statedef -1]"],
      fallbackInsertBefore: [],
      insertAfterModule: null,
      routePreview: [{
        id: "resolver_dynamic_meter_route_window_guard",
        type: "dynamic_route_safety",
        source: "scan_report_meter_candidates",
        chain: dynamicRouteVars.map((routeVar) => `var(${routeVar}) meter window clear`),
        condition: ["route_var_points_to_meter_state", "scanned_x_y_confirm_window_failed"],
        policy: ["clear_route_var_before_dynamic_executor", "prevents_stale_far_meter_call"],
      }],
      removeRules: [],
      unresolvedPlaceholders: validateCommandRefs(dynamicRouteGuardContent, profile),
      optionalMissingStateAliases: [],
      generatedFallback: true,
      resolverMode,
    });
  }

  const oldAiMeterRisks = profile.patchReadiness?.oldAiMeterRisks || [];
  if (oldAiMeterRisks.length && fallbackFilePath && (!selected || operations.length || selected.has("old_ai_meter_range_guard"))) {
    operations.push({
      id: "old_ai_meter_range_guard:0",
      moduleId: "old_ai_meter_range_guard",
      risk: "medium",
      fileRole: "cmd",
      filePath: fallbackFilePath,
      mode: "patch-old-ai-meter-guards",
      markerId: `${brainId}:old_ai_meter_range_guard:v1`,
      content: oldAiMeterRisks.map((risk) => `${risk.heading} state ${risk.state}: ${risk.reason}`).join("\n"),
      patches: oldAiMeterRisks,
      insertBefore: [],
      insertAfter: [],
      fallbackInsertBefore: [],
      insertAfterModule: null,
      routePreview: [{
        id: "old_ai_meter_range_guard",
        type: "old_ai_safety_audit",
        source: "scan_report_original_cmd",
        chain: oldAiMeterRisks.map((risk) => `${risk.heading} -> ${risk.state}`),
        condition: ["old_ai_meter_trigger_window_exceeds_scanned_state_window"],
        policy: ["insert_ai_only_triggerall_guards_into_original_blocks", "player_manual_input_remains_available"],
      }],
      removeRules: [],
      unresolvedPlaceholders: [],
      optionalMissingStateAliases: [],
      generatedFallback: true,
      resolverMode,
    });
  }

  const oldAiRepeatFarmRisks = profile.patchReadiness?.oldAiRepeatFarmRisks || [];
  if (oldAiRepeatFarmRisks.length && fallbackFilePath && (!selected || operations.length || selected.has("old_ai_repeat_farm_guard"))) {
    operations.push({
      id: "old_ai_repeat_farm_guard:0",
      moduleId: "old_ai_repeat_farm_guard",
      risk: "medium",
      fileRole: "cmd",
      filePath: fallbackFilePath,
      mode: "patch-old-ai-meter-guards",
      markerId: `${brainId}:old_ai_repeat_farm_guard:v1`,
      content: oldAiRepeatFarmRisks.map((risk) => `${risk.heading} state ${risk.state}: ${risk.reason}`).join("\n"),
      patches: oldAiRepeatFarmRisks,
      insertBefore: [],
      insertAfter: [],
      fallbackInsertBefore: [],
      insertAfterModule: null,
      routePreview: [{
        id: "old_ai_repeat_farm_guard",
        type: "old_ai_repeat_farm_audit",
        source: "scan_report_original_cmd",
        chain: oldAiRepeatFarmRisks.map((risk) => `${risk.heading} -> ${risk.state}`),
        condition: ["old_ai_can_call_power_gain_normal_from_neutral_or_control"],
        policy: ["convert_old_ai_power_gain_normals_to_hit_confirm_only", "prevents_state_power_farm_loops"],
      }],
      removeRules: [],
      unresolvedPlaceholders: [],
      optionalMissingStateAliases: [],
      generatedFallback: true,
      resolverMode,
    });
  }

  return { operations, skipped };
}

function markerBlockRegex(markerId) {
  const escaped = escapeRegExp(markerId);
  return new RegExp(`^[^\\r\\n]*AI_PATCH_BEGIN:\\s*${escaped}[^\\r\\n]*(?:\\r?\\n[\\s\\S]*?)?^[^\\r\\n]*AI_PATCH_END:\\s*${escaped}[^\\r\\n]*(?:\\r?\\n)?`, "m");
}

function lineBoundsForIndex(text, index) {
  const start = text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const next = text.indexOf("\n", index);
  const end = next >= 0 ? next + 1 : text.length;
  return { start, end };
}

function insertAt(text, index, content, newline, before = true) {
  const insertion = normalizeContentNewline(content, newline);
  const padded = insertion.endsWith(newline + newline) ? insertion : insertion + newline;
  const insertIndex = before ? lineBoundsForIndex(text, index).start : lineBoundsForIndex(text, index).end;
  return text.slice(0, insertIndex) + padded + text.slice(insertIndex);
}

function findAnchor(text, anchors) {
  const patchRanges = findPatchRanges(text);
  for (const anchor of anchors) {
    let fromIndex = 0;
    while (fromIndex < text.length) {
      const index = text.indexOf(anchor, fromIndex);
      if (index < 0) break;
      if (!patchRanges.some((range) => index >= range.start && index < range.end)) {
        return { anchor, index };
      }
      fromIndex = index + anchor.length;
    }
  }
  return null;
}

function findPatchRanges(text) {
  const ranges = [];
  const stack = [];
  const markerLine = /^.*AI_PATCH_(BEGIN|END):.*$/gm;
  for (const match of text.matchAll(markerLine)) {
    const line = lineBoundsForIndex(text, match.index);
    if (match[1] === "BEGIN") {
      stack.push(line.start);
    } else {
      const start = stack.pop();
      if (start !== undefined) ranges.push({ start, end: line.end });
    }
  }
  return ranges;
}

function controllerTargetsState(controller, state) {
  const targets = expressionStateTargets(controller?.params?.value || "");
  return targets.some((target) => Number(target) === Number(state));
}

function findOldAiMeterPatchController(text, patch) {
  const patchRanges = findPatchRanges(text);
  return parseControllerBlocksWithOffsets(text).find((controller) => {
    if (!/^changestate$/i.test(controller.type || "")) return false;
    if (patchRanges.some((range) => controller.start >= range.start && controller.start < range.end)) return false;
    if (patch.heading && controller.heading !== patch.heading) return false;
    if (!controllerTargetsState(controller, patch.state)) return false;
    if (!looksLikeAiControlledCommandBlock(controller)) return false;
    if (patch.triggerKey && normalizedControllerTriggerKey(controller) !== patch.triggerKey) return false;
    return true;
  });
}

function insertOldAiMeterGuardIntoBlock(blockText, guardLines, newline) {
  const lines = String(blockText || "").split(/\r?\n/);
  const cleanGuards = uniqueValues((guardLines || []).map((line) => {
    const trimmed = String(line || "").trim();
    if (!trimmed) return "";
    if (trimmed.startsWith(";") || /^\s*trigger(?:all|\d+)?\s*=/i.test(trimmed)) return trimmed;
    return `triggerAll = ${trimmed}`;
  }).filter(Boolean));
  if (!cleanGuards.length) return blockText;
  const existing = lines.join("\n");
  const missing = cleanGuards.filter((line) => !existing.includes(line));
  if (!missing.length) return blockText;
  const valueIndex = lines.findIndex((line) => /^\s*value\s*=/i.test(line));
  const typeIndex = lines.findIndex((line) => /^\s*type\s*=\s*ChangeState\b/i.test(line));
  const insertIndex = valueIndex >= 0 ? valueIndex + 1 : typeIndex >= 0 ? typeIndex + 1 : Math.min(2, lines.length);
  lines.splice(insertIndex, 0, ...missing);
  return lines.join(newline);
}

function applyOldAiMeterGuardPatches(text, operation) {
  const newline = detectNewline(text);
  let nextText = String(text || "");
  const applied = [];
  for (const patch of operation.patches || []) {
    while (true) {
      const controller = findOldAiMeterPatchController(nextText, patch);
      if (!controller) break;
      const before = nextText.slice(controller.start, controller.end);
      const after = insertOldAiMeterGuardIntoBlock(before, patch.guardLines, newline);
      if (after === before) break;
      nextText = nextText.slice(0, controller.start) + after + nextText.slice(controller.end);
      applied.push({
        state: patch.state,
        heading: controller.heading,
        line: controller.line,
        reason: patch.reason,
      });
    }
  }
  return {
    text: nextText,
    result: {
      ...operation,
      status: applied.length ? "patched-old-ai-meter-guards" : "old-ai-meter-guards-already-current",
      anchorUsed: null,
      appliedOldAiMeterGuards: applied,
    },
  };
}

function applyOperationToText(text, operation) {
  if (operation.mode === "patch-old-ai-meter-guards") {
    return applyOldAiMeterGuardPatches(text, operation);
  }

  const newline = detectNewline(text);
  const content = normalizeContentNewline(operation.content, newline);
  const existing = text.match(markerBlockRegex(operation.markerId));
  if (existing?.index !== undefined) {
    if (operation.priorityInsertBefore?.length) {
      const withoutExisting = text.slice(0, existing.index) + text.slice(existing.index + existing[0].length);
      const priorityAnchor = findAnchor(withoutExisting, operation.priorityInsertBefore);
      if (priorityAnchor && existing.index > priorityAnchor.index) {
        return {
          text: insertAt(withoutExisting, priorityAnchor.index, content, newline, true),
          result: { ...operation, status: "relocated-before-old-ai-meter", anchorUsed: priorityAnchor.anchor },
        };
      }
    }
    const statedefMinusOne = findAnchor(text, ["[Statedef -1]"]);
    if (path.extname(operation.filePath || "").toLowerCase() === ".cmd" && statedefMinusOne && existing.index < statedefMinusOne.index) {
      const withoutExisting = text.slice(0, existing.index) + text.slice(existing.index + existing[0].length);
      const newAnchor = findAnchor(withoutExisting, ["[Statedef -1]"]);
      const insertIndex = newAnchor ? lineBoundsForIndex(withoutExisting, newAnchor.index).end : withoutExisting.length;
      return {
        text: insertAt(withoutExisting, insertIndex, content, newline, false),
        result: { ...operation, status: "moved-after-statedef-minus-one", anchorUsed: "[Statedef -1]" },
      };
    }
    return {
      text: text.slice(0, existing.index) + content + text.slice(existing.index + existing[0].length),
      result: { ...operation, status: "replaced-marker", anchorUsed: null },
    };
  }

  if (operation.priorityInsertBefore?.length) {
    const priorityAnchor = findAnchor(text, operation.priorityInsertBefore);
    if (priorityAnchor) {
      return {
        text: insertAt(text, priorityAnchor.index, operation.content, newline, true),
        result: { ...operation, status: "inserted-before-old-ai-meter", anchorUsed: priorityAnchor.anchor },
      };
    }
  }

  if (operation.insertAfterModule) {
    const brainPrefix = operation.markerId.split(":").slice(0, 1).join(":");
    const afterMarker = `${brainPrefix}:${operation.insertAfterModule}:v1`;
    const afterMatch = text.match(new RegExp(`^[^\\r\\n]*AI_PATCH_END:\\s*${escapeRegExp(afterMarker)}[^\\r\\n]*`, "m"));
    if (afterMatch?.index !== undefined) {
      return {
        text: insertAt(text, afterMatch.index, operation.content, newline, false),
        result: { ...operation, status: "inserted-after-module", anchorUsed: afterMarker },
      };
    }
  }

  const beforeAnchor = findAnchor(text, operation.insertBefore);
  if (beforeAnchor) {
    return {
      text: insertAt(text, beforeAnchor.index, operation.content, newline, true),
      result: { ...operation, status: "inserted-before-anchor", anchorUsed: beforeAnchor.anchor },
    };
  }

  const afterAnchor = findAnchor(text, operation.insertAfter);
  if (afterAnchor) {
    return {
      text: insertAt(text, afterAnchor.index, operation.content, newline, false),
      result: { ...operation, status: "inserted-after-anchor", anchorUsed: afterAnchor.anchor },
    };
  }

  const fallbackAnchor = findAnchor(text, operation.fallbackInsertBefore);
  if (fallbackAnchor) {
    return {
      text: insertAt(text, fallbackAnchor.index, operation.content, newline, true),
      result: { ...operation, status: "inserted-before-fallback-anchor", anchorUsed: fallbackAnchor.anchor },
    };
  }

  const appended = text.endsWith(newline) ? text + newline + content : text + newline + newline + content;
  return {
    text: appended,
    result: { ...operation, status: "appended", anchorUsed: null },
  };
}

function extractRouteTargetsFromContent(content) {
  const targets = [];
  const text = String(content || "");
  const trimExtraClosers = (value) => {
    let output = String(value || "").trim();
    const count = (pattern) => (output.match(pattern) || []).length;
    while (output.endsWith(")") && count(/\)/g) > count(/\(/g)) {
      output = output.slice(0, -1).trim();
    }
    return output;
  };
  for (const match of text.matchAll(/^\s*value\s*=\s*(.+)$/gim)) {
    const raw = trimExtraClosers(match[1].split(";")[0]);
    if (!raw) continue;
    targets.push(raw);
  }
  for (const line of text.split(/\r?\n/)) {
    const assignIndex = line.indexOf(":=");
    if (assignIndex < 0) continue;
    const raw = trimExtraClosers(line.slice(assignIndex + 2).split(";")[0]);
    if (!raw) continue;
    targets.push(raw);
  }
  return [...new Set(targets)].filter((target) => {
    const numeric = String(target).trim().match(/^-?\d+$/);
    return !numeric || Math.abs(Number(numeric[0])) >= 100;
  });
}

function compactOperation(operation) {
  const { content, ...rest } = operation;
  return {
    ...rest,
    contentLines: String(content || "").split(/\r?\n/).length,
      contentPreview: String(content || "").split(/\r?\n/).slice(0, 260).join("\n"),
    routeTargets: extractRouteTargetsFromContent(content),
  };
}

function validateCommandGraphAfterPatch(profile, patchedTexts) {
  const cmdPath = profile.absoluteFiles?.cmd;
  const cmdText = cmdPath && patchedTexts.has(cmdPath) ? patchedTexts.get(cmdPath) : null;
  const availableCommands = cmdText ? parseCommands(cmdText) : profile.commands?.available || [];
  const issues = [];
  const filesToAudit = uniqueValues([
    profile.absoluteFiles?.cmd,
    ...(profile.absoluteFiles?.cns || []),
    ...(profile.absoluteFiles?.st || []),
  ]);

  for (const filePath of filesToAudit) {
    const text = patchedTexts.get(filePath) || null;
    if (!text) continue;
    const missing = validateCommandRefsAgainstSet(text, availableCommands);
    for (const placeholder of missing) {
      const id = placeholder.slice("command:".length);
      if (!issues.some((item) => item.id === id && item.filePath === filePath)) {
        issues.push({
          id,
          preferred: id,
          actual: null,
          strategy: "post_patch_command_audit",
          status: "conflict",
          reason: `command does not exist after patch: ${id}`,
          filePath,
          relativePath: path.relative(profile.characterPath, filePath),
        });
      }
    }
  }
  return issues;
}

function validateMeterGatesForOperations(profile, operations) {
  const issues = [];
  for (const operation of operations || []) {
    const text = String(operation.content || "");
    const lines = text.split(/\r?\n/);
    let current = [];
    const flush = () => {
      if (!current.length) return;
      const block = current.join("\n");
      current = [];
      if (!/^\s*type\s*=\s*ChangeState\b/im.test(block)) return;
      const valueMatch = block.match(/^\s*value\s*=\s*(-?\d+)\s*(?:;.*)?$/im);
      if (!valueMatch) return;
      const state = Number(valueMatch[1]);
      const cost = statePowerCost(profile, state)?.cost || 0;
      if (cost < 500) return;
      const gates = powerGateValuesFromText(block);
      const hasSafeGate = gates.some((gate) => gate >= cost);
      if (!hasSafeGate) {
        issues.push({
          id: `${operation.moduleId || "module"}:${state}`,
          preferred: state,
          actual: null,
          strategy: "meter_gate_audit",
          status: "conflict",
          reason: `meter state ${state} costs ${cost}, but patched ChangeState has no Power >= ${cost} gate`,
          moduleId: operation.moduleId,
          markerId: operation.markerId,
          filePath: operation.filePath,
          relativePath: operation.filePath ? path.relative(profile.characterPath, operation.filePath) : "",
        });
      }
    };
    for (const line of lines) {
      if (/^\s*\[State\b/i.test(line)) flush();
      current.push(line);
    }
    flush();
  }
  return issues;
}

function chargePowerAddBlocks(text) {
  return String(text || "")
    .split(/(?=^\s*\[State\b)/gim)
    .filter((block) => /^\s*\[State\s+730\b/i.test(block) && /^\s*type\s*=\s*PowerAdd\b/im.test(block));
}

function chargePowerValueExpression(block) {
  return String(block || "").match(/^\s*value\s*=\s*([^\r\n;]+)/im)?.[1]?.trim() || "";
}

function chargePowerRateLooksStandard(expression) {
  const expr = String(expression || "");
  return /ifelse\s*\(\s*time\s*<\s*60/i.test(expr)
    && /\(\s*time\s*-\s*60\s*\)\s*\/\s*12/i.test(expr)
    && /^2\s*\+/i.test(expr.trim());
}

function chargeHoldExplodBlocks(text) {
  return String(text || "")
    .split(/(?=^\s*\[State\b)/gim)
    .filter((block) => /^\s*\[State\s+730\b/i.test(block) && /^\s*type\s*=\s*Explod\b/im.test(block));
}

function chargeHoldExplodLooksPersistent(block) {
  const text = String(block || "");
  if (/AI_PATCH_CHARGE_EFFECT_REFRESH/i.test(text)) return true;
  if (/!\s*NumExplod\s*\(/i.test(text) && /^\s*trigger\d+\s*=.*time\s*>\s*0/im.test(text)) return true;
  if (/^\s*removetime\s*=\s*-1\s*$/im.test(text)) return true;
  if (/^\s*trigger\d+\s*=.*AnimElem\s*=/im.test(text) && /!\s*NumExplod\s*\(/i.test(text)) return true;
  return !/^\s*trigger\d+\s*=\s*time\s*=\s*0\s*$/im.test(text);
}

function validatePowerChargeShimRateForOperations(profile, operations) {
  const issues = [];
  for (const operation of operations || []) {
    const text = String(operation.content || "");
    const isChargeShim = operation.moduleId === "power_charge_shim"
      || /\bAI_PATCH_CHARGE_RATE_POLICY\b/i.test(text)
      || /\bpower_charge_shim\b/i.test(String(operation.markerId || ""));
    if (!isChargeShim) continue;
    const blocks = chargePowerAddBlocks(text);
    if (!blocks.length) {
      issues.push({
        id: `${operation.moduleId || "module"}:730:charge-rate`,
        preferred: "730",
        actual: null,
        strategy: "charge_rate_policy_audit",
        status: "conflict",
        reason: "generated power charge shim must include State 730 PowerAdd with Roxy/Rose ramp rate",
        moduleId: operation.moduleId,
        markerId: operation.markerId,
        filePath: operation.filePath,
        relativePath: operation.filePath ? path.relative(profile.characterPath, operation.filePath) : "",
      });
      continue;
    }
    for (const block of blocks) {
      const value = chargePowerValueExpression(block);
      if (chargePowerRateLooksStandard(value)) continue;
      issues.push({
        id: `${operation.moduleId || "module"}:730:charge-rate`,
        preferred: "2 + ifElse(time < 60, 0, (time - 60) / 12)",
        actual: value || null,
        strategy: "charge_rate_policy_audit",
        status: "conflict",
        reason: `generated power charge shim uses non-standard gain "${value || "missing"}"; use Roxy/Rose ramp to avoid over-fast AI charge`,
        moduleId: operation.moduleId,
        markerId: operation.markerId,
        filePath: operation.filePath,
        relativePath: operation.filePath ? path.relative(profile.characterPath, operation.filePath) : "",
      });
    }
    for (const block of chargeHoldExplodBlocks(text)) {
      if (chargeHoldExplodLooksPersistent(block)) continue;
      issues.push({
        id: `${operation.moduleId || "module"}:730:charge-effect-refresh`,
        preferred: "time > 0 && !NumExplod(ID)",
        actual: "single time = 0 Explod",
        strategy: "charge_effect_lifetime_audit",
        status: "conflict",
        reason: "generated power charge shim reuses a short hold Explod only at time = 0; add refresh so charge effect stays visible while state 730 continues",
        moduleId: operation.moduleId,
        markerId: operation.markerId,
        filePath: operation.filePath,
        relativePath: operation.filePath ? path.relative(profile.characterPath, operation.filePath) : "",
      });
    }
  }
  return issues;
}

function validateHighCostFinisherGatesForOperations(profile, operations) {
  const issues = [];
  for (const operation of operations || []) {
    if (operation.mode === "patch-old-ai-meter-guards") continue;
    const text = String(operation.content || "");
    const lines = text.split(/\r?\n/);
    let current = [];
    const flush = () => {
      if (!current.length) return;
      const block = current.join("\n");
      current = [];
      if (!/^\s*type\s*=\s*ChangeState\b/im.test(block)) return;
      const valueMatch = block.match(/^\s*value\s*=\s*(-?\d+)\s*(?:;.*)?$/im);
      if (!valueMatch) return;
      const state = Number(valueMatch[1]);
      const policy = highCostFinisherPolicy(stateScanInfo(profile, state));
      if (!policy) return;
      if (highCostHasRequiredConfirmGate(block, policy)) return;
      const lethalText = policy.killLifeMax
        ? ` or lethal punish confirm (EnemyNear,Life<=${policy.killLifeMax}, !EnemyNear,Ctrl, EnemyNear,MoveType=A, no guard)`
        : "";
      issues.push({
        id: `${operation.moduleId || "module"}:${state}:high-cost-finisher`,
        preferred: state,
        actual: null,
        strategy: "high_cost_finisher_audit",
        status: "conflict",
        reason: `high-cost finisher ${state} costs ${policy.cost}; patched ChangeState must require hard hitstun confirm (!EnemyNear,Ctrl, EnemyNear,MoveType=H, GetHitVar(HitTime)>=${policy.minHitTime})${lethalText}`,
        moduleId: operation.moduleId,
        markerId: operation.markerId,
        filePath: operation.filePath,
        relativePath: operation.filePath ? path.relative(profile.characterPath, operation.filePath) : "",
      });
    };
    for (const line of lines) {
      if (/^\s*\[State\b/i.test(line)) flush();
      current.push(line);
    }
    flush();
  }
  return issues;
}

function blockTargetStates(block) {
  const states = [];
  const valueMatch = String(block || "").match(/^\s*value\s*=\s*(.+?)\s*(?:;.*)?$/im);
  if (valueMatch) states.push(...expressionStateTargets(valueMatch[1]));
  for (const match of String(block || "").matchAll(/:=\s*(-?\d+)\b/g)) {
    states.push(Number(match[1]));
  }
  return uniqueValues(states.filter((state) => Number.isFinite(Number(state))).map(Number));
}

function hasTightThrowAttemptRange(block) {
  const source = String(block || "");
  const xBounds = parseP2DistanceBounds(source, "X");
  const yBounds = parseP2DistanceBounds(source, "Y");
  return !!(xBounds?.hasUpper && Number(xBounds.max) <= 40 && yBounds?.hasUpper && Number(yBounds.max) <= 20);
}

function hasThrowAttemptPunishGate(block) {
  const source = String(block || "");
  return /(?:!\s*EnemyNear\s*,\s*Ctrl|EnemyNear\s*,\s*Ctrl\s*=\s*0|EnemyNear\s*,\s*MoveType\s*=\s*A|P2StateNo\s*=\s*\[\s*120\s*,\s*155\s*\])/i.test(source)
    && /EnemyNear\s*,\s*StateType\s*!=\s*A/i.test(source)
    && /EnemyNear\s*,\s*StateType\s*!=\s*L/i.test(source)
    && /EnemyNear\s*,\s*MoveType\s*!=\s*H/i.test(source)
    && /P2StateNo\s*!=\s*\[\s*800\s*,\s*899\s*\]/i.test(source);
}

function noDamageThrowAttemptHasSafeGate(block) {
  const source = String(block || "");
  return /\bAI_PATCH_THROW_ATTEMPT_GUARD\b/i.test(source)
    || (hasTightThrowAttemptRange(source) && hasThrowAttemptPunishGate(source));
}

function noDamageThrowAttemptHasFallback(content, state) {
  const source = String(content || "");
  return new RegExp(`AI_PATCH_INVALID_THROW_FALLBACK\\s+${escapeRegExp(String(state))}\\b`, "i").test(source);
}

function validateNoDamageThrowAttemptGatesForOperations(profile, operations) {
  const issues = [];
  for (const operation of operations || []) {
    const content = String(operation.content || "");
    const blocks = content.split(/(?=^\s*\[State\b)/gim);
    for (const block of blocks) {
      if (!/\b(?:ChangeState|:=)\b/i.test(block)) continue;
      const targets = blockTargetStates(block)
        .filter((state) => stateIsNoDamageThrowAttempt(stateScanInfo(profile, state)));
      if (!targets.length) continue;
      for (const state of targets) {
        const hasSafeGate = noDamageThrowAttemptHasSafeGate(block);
        const hasFallback = noDamageThrowAttemptHasFallback(content, state);
        if (hasSafeGate && hasFallback) continue;
        issues.push({
          id: `${operation.moduleId || "module"}:${state}:throw-attempt-no-damage`,
          preferred: state,
          actual: null,
          strategy: "throw_attempt_audit",
          status: "conflict",
          reason: `state ${state} scans as a no-damage throw attempt; route must be point-blank punish/guard gated and include close-range invalid-throw fallback`,
          moduleId: operation.moduleId,
          markerId: operation.markerId,
          filePath: operation.filePath,
          relativePath: operation.filePath ? path.relative(profile.characterPath, operation.filePath) : "",
        });
      }
    }
  }
  return issues;
}

function validateMultiHitEvasiveNoInterruptForOperations(profile, operations) {
  const guardLines = multiHitEvasiveNoInterruptGuardLines(profile);
  if (!guardLines.length) return [];
  const guardLine = guardLines.find((line) => /^\s*triggerAll\s*=/i.test(line));
  if (!guardLine) return [];
  const sources = multiHitActiveGuardStates(profile);
  if (!sources.length) return [];
  const issues = [];
  for (const operation of operations || []) {
    const content = String(operation.content || "");
    const blocks = content.split(/(?=^\s*\[State\b)/gim);
    for (const block of blocks) {
      if (!/^\s*type\s*=\s*ChangeState\b/im.test(block)) continue;
      const valueMatch = block.match(/^\s*value\s*=\s*(-?\d+)\b/im);
      if (!valueMatch) continue;
      const target = Number(valueMatch[1]);
      if (!isEvasiveOrSetupTarget(profile, target)) continue;
      if (/!\s*AILevel/i.test(block) && !/AI_PATCH_BEGIN/i.test(block)) continue;
      if (/AI_PATCH_MULTI_HIT_NO_EVADE/i.test(block) && block.includes(guardLine)) continue;
      issues.push({
        id: `${operation.moduleId || "module"}:${target}:multi-hit-no-evade`,
        preferred: target,
        actual: null,
        strategy: "multi_hit_no_evade_audit",
        status: "conflict",
        reason: `evasive/setup state ${target} can interrupt active multi-hit states (${sources.map(multiHitCompletionLabel).join(", ")}); generated route must include AI_PATCH_MULTI_HIT_NO_EVADE guard`,
        moduleId: operation.moduleId,
        markerId: operation.markerId,
        filePath: operation.filePath,
        relativePath: operation.filePath ? path.relative(profile.characterPath, operation.filePath) : "",
      });
    }
  }
  return issues;
}

function validateDiagonalAirInterceptForOperations(profile, operations) {
  const issues = [];
  for (const operation of operations || []) {
    const content = String(operation.content || "");
    const blocks = content.split(/(?=^\s*\[State\b)/gim);
    for (const block of blocks) {
      if (!/^\s*type\s*=\s*ChangeState\b/im.test(block)) continue;
      const valueMatch = block.match(/^\s*value\s*=\s*(-?\d+)\b/im);
      if (!valueMatch) continue;
      const state = Number(valueMatch[1]);
      if (!isDiagonalAirInterceptState(profile, state)) continue;
      if (hasDiagonalAirInterceptGuard(block)) continue;
      issues.push({
        id: `${operation.moduleId || "module"}:${state}:diagonal-air-intercept`,
        preferred: state,
        actual: null,
        strategy: "diagonal_air_intercept_audit",
        status: "conflict",
        reason: `state ${state} is an air-only rising diagonal route; patched ChangeState must include AI_PATCH_DIAGONAL_AIR_INTERCEPT air/Y/velocity guard`,
        moduleId: operation.moduleId,
        markerId: operation.markerId,
        filePath: operation.filePath,
        relativePath: operation.filePath ? path.relative(profile.characterPath, operation.filePath) : "",
      });
    }
  }
  return issues;
}

function validateDynamicMeterTargetsForOperations(profile, operations) {
  const issues = [];
  for (const operation of operations || []) {
    const text = String(operation.content || "");
    const lines = text.split(/\r?\n/);
    let current = [];
    const flush = () => {
      if (!current.length) return;
      const block = current.join("\n");
      current = [];
      const dynamicValue = block.match(/^\s*value\s*=\s*(.+)$/im)?.[1] || "";
      const dynamicAssigns = [...block.matchAll(/:=\s*(IfElse\s*\(.+?\)|[^\r\n]+)/gim)].map((match) => match[1]);
      const expressions = [dynamicValue, ...dynamicAssigns].filter((expr) => /IfElse\s*\(/i.test(expr));
      if (!expressions.length) return;
      const meterTargets = expressions
        .flatMap((expr) => expressionStateTargets(expr))
        .map(Number)
        .filter((state) => Number.isFinite(state) && isMeterStateForWindowGuard(profile, state));
      if (!meterTargets.length) return;
      issues.push({
        id: `${operation.moduleId || "module"}:dynamic-meter-target`,
        preferred: [...new Set(meterTargets)].join(","),
        actual: null,
        strategy: "dynamic_meter_target_audit",
        status: "conflict",
        reason: `dynamic IfElse route contains meter state(s) ${[...new Set(meterTargets)].join(", ")}; split into fixed-state blocks so scan x/y guards can be applied`,
        moduleId: operation.moduleId,
        markerId: operation.markerId,
        filePath: operation.filePath,
        relativePath: operation.filePath ? path.relative(profile.characterPath, operation.filePath) : "",
      });
    };
    for (const line of lines) {
      if (/^\s*\[State\b/i.test(line)) flush();
      current.push(line);
    }
    flush();
  }
  return issues;
}

function validatePushbackCompatibilityForOperations(profile, operations) {
  const issues = [];
  for (const operation of operations || []) {
    const content = String(operation.content || "");
    const blocks = content.split(/(?=^\s*\[State\b)/gim);
    for (const block of blocks) {
      if (!/^\s*type\s*=\s*ChangeState\b/im.test(block)) continue;
      const valueMatch = block.match(/^\s*value\s*=\s*(-?\d+)\s*(?:;.*)?$/im);
      if (!valueMatch) continue;
      const target = Number(valueMatch[1]);
      if (!Number.isFinite(target) || Math.abs(target) < 100) continue;
      const sources = blockRouteSourceStates(profile, block).filter((state) => state !== target);
      for (const source of sources) {
        const spacing = routeSpacingCompatibility(profile, source, target);
        if (spacing.risk !== "high") continue;
        if (/AI_PATCH_PUSHBACK_COMPAT/im.test(block)) continue;
        issues.push({
          id: `${operation.moduleId || "module"}:${source}->${target}:pushback-compat`,
          preferred: `${source}->${target}`,
          actual: null,
          strategy: "pushback_spacing_audit",
          status: "conflict",
          reason: `source state ${source} pushes target too far for state ${target}; route needs AI_PATCH_PUSHBACK_COMPAT guard or a longer-range follow-up`,
          moduleId: operation.moduleId,
          markerId: operation.markerId,
          filePath: operation.filePath,
          relativePath: operation.filePath ? path.relative(profile.characterPath, operation.filePath) : "",
        });
      }
    }
  }
  return issues;
}

function addMeterPowerGates(text, profile) {
  const source = String(text || "");
  const lines = source.split(/\r?\n/);
  const blocks = [];
  let current = [];
  const flush = () => {
    if (current.length) blocks.push(current);
    current = [];
  };
  for (const line of lines) {
    if (/^\s*\[State\b/i.test(line)) flush();
    current.push(line);
  }
  flush();

  let changed = false;
  const patched = blocks.map((blockLines) => {
    const block = blockLines.join("\n");
    if (!/^\s*type\s*=\s*ChangeState\b/im.test(block)) return blockLines;
    const valueMatch = block.match(/^\s*value\s*=\s*(-?\d+)\s*(?:;.*)?$/im);
    if (!valueMatch) return blockLines;
    const state = Number(valueMatch[1]);
    const cost = statePowerCost(profile, state)?.cost || 0;
    if (cost < 500) return blockLines;
    const gates = powerGateValuesFromText(block);
    if (gates.some((gate) => gate >= cost)) return blockLines;

    const valueIndex = blockLines.findIndex((line) => /^\s*value\s*=/i.test(line));
    const insertIndex = valueIndex >= 0 ? valueIndex + 1 : Math.min(2, blockLines.length);
    changed = true;
    return [
      ...blockLines.slice(0, insertIndex),
      `triggerAll = Power >= ${cost} ; AI_PATCH_AUTO_POWER_GATE`,
      ...blockLines.slice(insertIndex),
    ];
  });

  return changed ? patched.map((block) => block.join("\n")).join("\n") : source;
}

function isMeterStateForWindowGuard(profile, state) {
  const cost = statePowerCost(profile, Number(state))?.cost || 0;
  const info = stateScanInfo(profile, Number(state));
  return cost >= 500 || !!meterReliabilityClass(info) || isDiagonalAirInterceptStateInfo(info);
}

function stateHasPowerGain(profile, state) {
  const traits = stateTraitInfo(profile, Number(state));
  const info = stateScanInfo(profile, Number(state));
  return !!(traits?.powerGain || info?.powerGain);
}

function isRepeatFarmRiskState(profile, state) {
  const numeric = Number(state);
  if (!Number.isFinite(numeric)) return false;
  const info = stateScanInfo(profile, numeric);
  if (!info || !scanStateDirectChangeSafe(info) || !scanStateHasHit(info)) return false;
  if (numeric >= 200 && numeric <= 699 && stateHasPowerGain(profile, numeric)) return true;
  const timing = info.timing || {};
  const shortRootAttack = (timing.totalTime || timing.frameCount || 0) > 0 && (timing.totalTime || timing.frameCount || 0) <= 45;
  return shortRootAttack && stateHasPowerGain(profile, numeric) && !statePowerCost(profile, numeric)?.cost;
}

function repeatFarmRiskStates(profile) {
  return (profile.comboScan?.states || [])
    .filter((info) => isRepeatFarmRiskState(profile, Number(info.state)))
    .map((info) => Number(info.state))
    .sort((a, b) => a - b);
}

function isUtilityReliabilityClass(classification) {
  return ["self_buff", "install", "unsafe_raw"].includes(String(classification || ""));
}

function isStrictPointBlankReliabilityClass(classification) {
  return String(classification || "") === "grab";
}

function stateWindowGuardLines(profile, state, options = {}) {
  const info = stateScanInfo(profile, Number(state));
  const window = stateScanWindow(profile, Number(state));
  const classification = meterReliabilityClass(info);
  if (classification === "unsafe_raw") {
    return ["triggerAll = 0 ; AI_PATCH_STATE_WINDOW_BLOCK unsafe_raw"];
  }
  if (!window && !classification) return [];
  if (isUtilityReliabilityClass(classification)) {
    return [
      `; AI_PATCH_STATE_WINDOW ${state} ${classification || "utility"} setup-only`,
      "triggerAll = Ctrl",
      "triggerAll = EnemyNear,StateType = L || P2BodyDist X > 135",
      "triggerAll = !InGuardDist",
      "triggerAll = Enemy,NumProj = 0",
      "triggerAll = EnemyNear,MoveType != A",
    ];
  }
  if (isDiagonalAirInterceptStateInfo(info)) {
    return diagonalAirInterceptTriggerLines(profile, state);
  }
  const maxX = Math.round(Math.max(25, Math.min(220, window?.xMax ?? scanStateReachMaxX(info, 90))));
  const minY = Math.round(window?.yMin ?? scanStateReachMinY(info, -120));
  const maxY = Math.round(Math.max(window?.yMax ?? scanStateReachMaxY(info, 45), 10));
  const minX = isStrictPointBlankReliabilityClass(classification)
    ? -8
    : Math.round(Math.max(-30, Math.min(0, window?.xMin ?? -20)));
  const xHi = isStrictPointBlankReliabilityClass(classification) ? Math.min(35, maxX) : maxX;
  const lines = [
    `; AI_PATCH_STATE_WINDOW ${state} ${classification || "attack"} scanned target x/y`,
    `triggerAll = P2BodyDist X = [${minX},${xHi}]`,
    `triggerAll = P2BodyDist Y = [${minY},${maxY}]`,
    "triggerAll = EnemyNear,StateType != L",
  ];
  const highCostLines = highCostFinisherTriggerLines(profile, state);
  if (highCostLines.length) {
    lines.push(...highCostLines);
    return lines;
  }
  if (classification === "close_confirm") {
    lines.push("triggerAll = MoveHit || MoveContact || EnemyNear,MoveType = H");
    lines.push("triggerAll = EnemyNear,MoveType != A || MoveHit || MoveContact");
  } else if (classification === "projectile") {
    lines.push("triggerAll = !InGuardDist || MoveHit || MoveContact || EnemyNear,Ctrl = 0");
    lines.push("triggerAll = EnemyNear,MoveType != A || MoveHit || MoveContact || EnemyNear,Ctrl = 0");
  } else if (classification === "grab") {
    lines.push("triggerAll = EnemyNear,StateType != A");
    lines.push("triggerAll = EnemyNear,Ctrl = 0 || MoveHit || MoveContact");
    lines.push("triggerAll = EnemyNear,MoveType != H || MoveHit || MoveContact");
  } else if (options.cost > 0) {
    lines.push("triggerAll = MoveHit || MoveContact || EnemyNear,MoveType = H || EnemyNear,Ctrl = 0");
  }
  return lines;
}

function addScannedStateWindowGuards(text, profile) {
  const source = String(text || "");
  const lines = source.split(/\r?\n/);
  const blocks = [];
  let current = [];
  const flush = () => {
    if (current.length) blocks.push(current);
    current = [];
  };
  for (const line of lines) {
    if (/^\s*\[State\b/i.test(line)) flush();
    current.push(line);
  }
  flush();

  let changed = false;
  const patched = blocks.map((blockLines) => {
    const block = blockLines.join("\n");
    if (!/^\s*type\s*=\s*ChangeState\b/im.test(block)) return blockLines;
    const valueMatch = block.match(/^\s*value\s*=\s*(-?\d+)\s*(?:;.*)?$/im);
    if (!valueMatch) return blockLines;
    const state = Number(valueMatch[1]);
    if (!isMeterStateForWindowGuard(profile, state)) return blockLines;
    if (/AI_PATCH_STATE_WINDOW_BLOCK/im.test(block)) return blockLines;
    const info = stateScanInfo(profile, state);
    const cost = statePowerCost(profile, state)?.cost || 0;
    const guardLines = stateWindowGuardLines(profile, state, { cost });
    if (!guardLines.length) return blockLines;

    const next = [];
    let inserted = false;
    for (const line of blockLines) {
      if (/^\s*trigger(?:all|\d+)?\s*=\s*P2BodyDist\s+[XY]\b/i.test(line)) {
        changed = true;
        continue;
      }
      next.push(line);
      if (!inserted && /^\s*triggerAll\s*=\s*Power\s*>=/i.test(line)) {
        next.push(...guardLines);
        inserted = true;
        changed = true;
      }
    }
    if (!inserted) {
      const valueIndex = next.findIndex((line) => /^\s*value\s*=/i.test(line));
      const insertIndex = valueIndex >= 0 ? valueIndex + 1 : Math.min(3, next.length);
      next.splice(insertIndex, 0, ...guardLines);
      changed = true;
    }
    return next;
  });

  return changed ? patched.map((block) => block.join("\n")).join("\n") : source;
}

function assignmentStateTargets(block) {
  const targets = [];
  for (const match of String(block || "").matchAll(/:=\s*(-?\d+)\b/gim)) {
    targets.push(Number(match[1]));
  }
  for (const match of String(block || "").matchAll(/:=\s*IfElse\s*\(([^;\r\n]+)/gim)) {
    targets.push(...expressionStateTargets(match[1]));
  }
  return [...new Set(targets.filter(Number.isFinite))];
}

function addRepeatFarmRouteGuards(text, profile) {
  const source = String(text || "");
  const riskStates = repeatFarmRiskStates(profile);
  if (!riskStates.length) return source;
  const lines = source.split(/\r?\n/);
  const blocks = [];
  let current = [];
  const flush = () => {
    if (current.length) blocks.push(current);
    current = [];
  };
  for (const line of lines) {
    if (/^\s*\[State\b/i.test(line)) flush();
    current.push(line);
  }
  flush();

  let changed = false;
  const patched = blocks.map((blockLines) => {
    const block = blockLines.join("\n");
    if (!/:=/im.test(block)) return blockLines;
    if (/AI_PATCH_ROUTE_CONFIRM_ONLY_GUARD/im.test(block)) return blockLines;
    const targets = assignmentStateTargets(block).filter((state) => isRepeatFarmRiskState(profile, state));
    if (!targets.length) return blockLines;
    const minHitTime = Math.max(4, Math.min(10, ...targets.map((state) => {
      const info = stateScanInfo(profile, Number(state));
      return Number(info?.timing?.startup || 4) + 2;
    })));
    const next = [...blockLines];
    const assignIndex = next.findIndex((line) => /:=/i.test(line));
    const insertIndex = assignIndex >= 0 ? assignIndex : Math.min(3, next.length);
    next.splice(
      insertIndex,
      0,
      `; AI_PATCH_ROUTE_CONFIRM_ONLY_GUARD: power-gain normal route state(s) ${targets.join(", ")} are hit-confirm only`,
      "triggerAll = MoveHit || MoveContact || EnemyNear,MoveType = H",
      `triggerAll = !EnemyNear,Ctrl || EnemyNear,GetHitVar(HitTime) >= ${minHitTime}`,
      "triggerAll = !(Ctrl && !MoveHit && !MoveContact && EnemyNear,Ctrl)",
    );
    changed = true;
    return next;
  });

  return changed ? patched.map((block) => block.join("\n")).join("\n") : source;
}

function blockSourceStates(block) {
  const states = [];
  const text = String(block || "");
  for (const match of text.matchAll(/\bStateNo\s*=\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/gim)) {
    const min = Number(match[1]);
    const max = Number(match[2]);
    if (Number.isFinite(min) && Number.isFinite(max) && max - min <= 12) {
      for (let state = min; state <= max; state += 1) states.push(state);
    }
  }
  for (const match of text.matchAll(/\bStateNo\s*=\s*(-?\d+)\b/gim)) states.push(Number(match[1]));
  return uniqueValues(states.filter((state) => Number.isFinite(state) && Math.abs(state) >= 100));
}

function cancelFlagSourceStatesForBlock(profile, block) {
  const refs = varRefsInText(block).filter((ref) => ref.kind === "var");
  if (!refs.length) return [];
  const states = [];
  for (const ref of refs) {
    for (const flag of profile?.comboScan?.cancelFlagSources || []) {
      if (flag.kind !== ref.kind || Number(flag.number) !== Number(ref.number)) continue;
      states.push(...(flag.sources || []));
    }
  }
  return uniqueValues(states.map(Number).filter((state) => Number.isFinite(state) && Math.abs(state) >= 100));
}

function blockRouteSourceStates(profile, block) {
  return uniqueValues([...blockSourceStates(block), ...cancelFlagSourceStatesForBlock(profile, block)]);
}

function addPushbackCompatibilityGuards(text, profile) {
  const source = String(text || "");
  const lines = source.split(/\r?\n/);
  const blocks = [];
  let current = [];
  const flush = () => {
    if (current.length) blocks.push(current);
    current = [];
  };
  for (const line of lines) {
    if (/^\s*\[State\b/i.test(line)) flush();
    current.push(line);
  }
  flush();

  let changed = false;
  const patched = blocks.map((blockLines) => {
    const block = blockLines.join("\n");
    if (!/^\s*type\s*=\s*ChangeState\b/im.test(block)) return blockLines;
    if (/AI_PATCH_PUSHBACK_COMPAT/im.test(block)) return blockLines;
    const valueMatch = block.match(/^\s*value\s*=\s*(-?\d+)\s*(?:;.*)?$/im);
    if (!valueMatch) return blockLines;
    const target = Number(valueMatch[1]);
    if (!Number.isFinite(target) || Math.abs(target) < 100) return blockLines;
    const sources = blockRouteSourceStates(profile, block).filter((state) => state !== target);
    if (!sources.length) return blockLines;
    const guardLines = uniqueValues(sources.flatMap((sourceState) => routeSpacingGuardLines(profile, sourceState, target)));
    if (!guardLines.length) return blockLines;
    const next = [...blockLines];
    const triggerIndex = next.findIndex((line) => /^\s*trigger(?:all|\d+)?\s*=/i.test(line));
    const insertIndex = triggerIndex >= 0 ? triggerIndex + 1 : Math.min(3, next.length);
    next.splice(insertIndex, 0, ...guardLines.map((line) => String(line || "").trim().startsWith(";") ? line : `triggerAll = ${line}`));
    changed = true;
    return next;
  });

  return changed ? patched.map((block) => block.join("\n")).join("\n") : source;
}

function addScannedRouteAssignmentGuards(text, profile) {
  const source = String(text || "");
  const lines = source.split(/\r?\n/);
  const blocks = [];
  let current = [];
  const flush = () => {
    if (current.length) blocks.push(current);
    current = [];
  };
  for (const line of lines) {
    if (/^\s*\[State\b/i.test(line)) flush();
    current.push(line);
  }
  flush();

  let changed = false;
  const patched = blocks.map((blockLines) => {
    const block = blockLines.join("\n");
    if (!/:=\s*-?\d+\b/im.test(block)) return blockLines;
    if (/AI_PATCH_STATE_WINDOW/im.test(block)) return blockLines;
    const targets = assignmentStateTargets(block).filter((state) => isMeterStateForWindowGuard(profile, state));
    if (targets.length !== 1) return blockLines;
    const state = targets[0];
    const cost = statePowerCost(profile, state)?.cost || 0;
    const guardLines = stateWindowGuardLines(profile, state, { cost });
    if (!guardLines.length) return blockLines;
    const next = [];
    let inserted = false;
    for (const line of blockLines) {
      if (/^\s*trigger(?:all|\d+)?\s*=\s*P2BodyDist\s+[XY]\b/i.test(line)) {
        changed = true;
        continue;
      }
      next.push(line);
      if (!inserted && (/^\s*triggerAll\s*=\s*Power\s*>=/i.test(line) || /^\s*triggerAll\s*=\s*MoveHit\b/i.test(line))) {
        next.push(...guardLines);
        inserted = true;
        changed = true;
      }
    }
    if (!inserted) {
      const assignIndex = next.findIndex((line) => /:=\s*-?\d+\b/i.test(line));
      const insertIndex = assignIndex >= 0 ? assignIndex : Math.min(3, next.length);
      next.splice(insertIndex, 0, ...guardLines);
      changed = true;
    }
    return next;
  });

  return changed ? patched.map((block) => block.join("\n")).join("\n") : source;
}

function addScannedStateSafetyGuards(text, profile) {
  return addPushbackCompatibilityGuards(
    addRepeatFarmRouteGuards(
      addScannedRouteAssignmentGuards(addScannedStateWindowGuards(text, profile), profile),
      profile,
    ),
    profile,
  );
}

function dynamicRouteVarsFromOperations(operations) {
  const vars = new Set();
  for (const operation of operations || []) {
    const text = String(operation.content || "");
    for (const match of text.matchAll(/^\s*value\s*=\s*var\(\s*(\d+)\s*\)\s*(?:;.*)?$/gim)) {
      vars.add(Number(match[1]));
    }
  }
  return [...vars].filter(Number.isFinite).sort((a, b) => a - b);
}

function generateDynamicMeterRouteWindowGuard(profile, routeVars) {
  const vars = uniqueValues(routeVars || []).filter(Number.isFinite);
  if (!vars.length) return "";
  const candidates = (profile.patchReadiness?.meterCandidates || [])
    .filter((item) => isMeterStateForWindowGuard(profile, Number(item.state)))
    .filter((item) => stateWindowGuardLines(profile, Number(item.state), { cost: item.cost }).length);
  if (!candidates.length) return "";

  const lines = [
    "; Runtime guard for dynamic route vars. If a route var points to a scanned meter state",
    "; but the current opponent x/y/confirm no longer matches that state, clear the route before executor ChangeState.",
  ];
  for (const routeVar of vars) {
    for (const item of candidates) {
      const state = Number(item.state);
      const guardLines = stateWindowGuardLines(profile, state, { cost: item.cost })
        .filter((line) => !String(line || "").trim().startsWith(";"))
        .map((line) => String(line).replace(/^triggerAll\s*=\s*/i, "").replace(/\s*;\s*AI_PATCH_STATE_WINDOW.*$/i, "").trim())
        .filter((expr) => expr && expr !== "0");
      const guardExpr = guardLines.map((expr) => `(${expr})`).join(" && ");
      if (!guardLines.length) {
        lines.push(
          "",
          `[State -1, AI Patch Dynamic Route Block Unsafe ${routeVar} ${state}]`,
          "type = VarSet",
          "triggerAll = AILevel && RoundState = 2",
          `triggerAll = var(${routeVar}) = ${state}`,
          "trigger1 = 1",
          `var(${routeVar}) = 0`,
          "ignoreHitPause = 1",
        );
        continue;
      }
      lines.push(
        "",
        `[State -1, AI Patch Dynamic Route Window Guard ${routeVar} ${state}]`,
        "type = VarSet",
        "triggerAll = AILevel && RoundState = 2 && NumEnemy",
        `triggerAll = var(${routeVar}) = ${state}`,
        `trigger1 = !(${guardExpr})`,
        `var(${routeVar}) = 0`,
        "ignoreHitPause = 1",
      );
    }
  }
  return lines.join("\n");
}

function isAsciiCommandName(name) {
  return /^[\x20-\x7E]+$/.test(String(name || ""));
}

function asciiCommandAlias(index, existing) {
  let alias = `cmd_${String(index + 1).padStart(3, "0")}`;
  let suffix = 2;
  while (existing.has(alias) || isBuiltInCommand(alias)) {
    alias = `cmd_${String(index + 1).padStart(3, "0")}_${suffix}`;
    suffix += 1;
  }
  existing.add(alias);
  return alias;
}

function replaceCommandNameDefinitions(text, aliasMap) {
  return text.replace(/^(\s*name\s*=\s*)("?)([^"\r\n;]+)("?)(.*)$/gim, (full, prefix, openQuote, name, closeQuote, rest) => {
    const trimmed = name.trim();
    const alias = aliasMap.get(trimmed);
    if (!alias) return full;
    const leading = name.match(/^\s*/)?.[0] || "";
    const trailing = name.match(/\s*$/)?.[0] || "";
    return `${prefix}${openQuote || "\""}${leading}${alias}${trailing}${closeQuote || "\""}${rest}`;
  });
}

function replaceCommandReferences(text, aliasMap) {
  return text.replace(/((?:^|[^\w.])command\s*=\s*")([^"\r\n]+)(")/gim, (full, prefix, name, suffix) => {
    const alias = aliasMap.get(name.trim());
    return alias ? `${prefix}${alias}${suffix}` : full;
  });
}

async function buildCommandAsciiPreview(reqBody) {
  const characterPath = reqBody?.characterPath;
  if (!characterPath) throw new Error("characterPath is required");
  const profile = reqBody?.profile || await scanCharacter(characterPath);
  const filesToPatch = uniqueValues([
    profile.absoluteFiles?.cmd,
    ...(profile.absoluteFiles?.cns || []),
    ...(profile.absoluteFiles?.st || []),
  ]);
  if (!profile.absoluteFiles?.cmd) throw new Error("No CMD file found for character");

  const existingAscii = new Set((profile.commands?.available || []).filter(isAsciiCommandName));
  const nonAsciiCommands = (profile.commands?.available || [])
    .filter((name) => !isAsciiCommandName(name))
    .sort((a, b) => a.localeCompare(b));
  const aliasMap = new Map();
  nonAsciiCommands.forEach((name, index) => aliasMap.set(name, asciiCommandAlias(index, existingAscii)));

  const files = [];
  const patchedTexts = {};
  for (const filePath of filesToPatch) {
    if (!filePath || !await pathExists(filePath)) continue;
    const { text, encoding } = await readTextWithEncoding(filePath);
    let patchedText = text;
    if (filePath === profile.absoluteFiles.cmd) patchedText = replaceCommandNameDefinitions(patchedText, aliasMap);
    patchedText = replaceCommandReferences(patchedText, aliasMap);
    const changed = patchedText !== text;
    if (changed) patchedTexts[filePath] = patchedText;
    files.push({
      filePath,
      relativePath: path.relative(profile.characterPath, filePath),
      encoding,
      changed,
      originalLength: text.length,
      newLength: patchedText.length,
      replacements: [...aliasMap.entries()].filter(([name]) => text.includes(name)).map(([from, to]) => ({ from, to })),
    });
  }

  const cmdTextAfter = patchedTexts[profile.absoluteFiles.cmd] || await readText(profile.absoluteFiles.cmd);
  const commandsAfter = parseCommands(cmdTextAfter);
  const commandIssues = [];
  const patchedMap = new Map(Object.entries(patchedTexts));
  for (const file of files) {
    const text = patchedMap.get(file.filePath) || await readText(file.filePath);
    for (const placeholder of validateCommandRefsAgainstSet(text, commandsAfter)) {
      commandIssues.push({
        id: placeholder.slice("command:".length),
        relativePath: file.relativePath,
        reason: `command does not exist after ASCII alias patch: ${placeholder.slice("command:".length)}`,
      });
    }
  }

  return {
    profile,
    aliases: [...aliasMap.entries()].map(([from, to]) => ({ from, to })),
    files,
    commandIssues,
    patchedTexts,
    diffText: files
      .filter((file) => file.changed)
      .map((file) => `--- ${file.relativePath}\n+++ ${file.relativePath}\n@@ command ASCII alias summary @@\nencoding: ${file.encoding}\nreplacements: ${file.replacements.length}`)
      .join("\n\n"),
  };
}

function summarizeDiffForFile(filePath, originalText, patchedText, operationResults, characterPath) {
  const insertedMarkers = operationResults.map((operation) => `${operation.status}: ${operation.markerId}`).join("\n");
  const relativePath = path.relative(characterPath, filePath);
  return [
    `--- ${relativePath}`,
    `+++ ${relativePath}`,
    `@@ marker patch summary @@`,
    `original bytes: ${Buffer.byteLength(originalText, "utf8")}`,
    `patched bytes: ${Buffer.byteLength(patchedText, "utf8")}`,
    insertedMarkers,
  ].filter(Boolean).join("\n");
}

function conflictsForOperations(plan, operations) {
  const conflictIds = new Set((plan.conflicts || []).map((item) => item.id));
  const liteModules = plan.liteFit?.modules || [];
  const skippedLiteModules = new Set(liteModules
    .filter((item) => ["skip", "fallback", "blocked"].includes(item.mode))
    .map((item) => item.moduleId));
  const activeModuleIds = new Set((operations || []).map((operation) => operation.moduleId));
  const activeIds = new Set();
  const collectPlaceholders = (items) => {
    for (const text of items || []) {
      for (const match of String(text || "").matchAll(/\$\{(?:var|fvar|state|range|command)\.([A-Za-z0-9_]+)(?::number)?\}/g)) {
        activeIds.add(match[1]);
      }
    }
  };
  collectPlaceholders(operations.flatMap((operation) => operation.unresolvedPlaceholders || []));
  for (const module of plan.modules || []) {
    if (activeModuleIds.has(module.id) && !skippedLiteModules.has(module.id)) {
      collectPlaceholders(module.unresolvedPlaceholders || []);
    }
  }
  for (const id of plan.liteFit?.requiredByActiveModules || []) activeIds.add(id);
  const optionalStates = optionalMissingStateAliases(plan);
  const unresolvedIds = new Set();
  const commandConflicts = [];
  for (const operation of operations) {
    for (const placeholder of operation.unresolvedPlaceholders || []) {
      if (String(placeholder).startsWith("command:")) {
        const id = String(placeholder).slice("command:".length);
        if (!commandConflicts.some((item) => item.id === id)) {
          commandConflicts.push({
            id,
            preferred: id,
            actual: null,
            strategy: "missing_command_blocker",
            status: "conflict",
            reason: `command does not exist: ${id}`,
          });
        }
        continue;
      }
      const match = placeholder.match(/^\$\{[a-z]+\.([A-Za-z0-9_]+)(?::number)?\}$/);
      if (match && optionalStates.has(match[1])) continue;
      if (match && conflictIds.has(match[1])) unresolvedIds.add(match[1]);
    }
  }
  return [
    ...(plan.conflicts || []).filter((item) => unresolvedIds.has(item.id) || activeIds.has(item.id)),
    ...commandConflicts,
  ];
}

function lineNumberAt(text, index) {
  return text.slice(0, Math.max(0, index)).split(/\r?\n/).length;
}

function countLines(text) {
  if (!text) return 1;
  return String(text).split(/\r?\n/).length;
}

function candidateSnippet(text, start, end) {
  return text.slice(start, end).split(/\r?\n/).slice(0, 4).join("\n").trim();
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function roleFilesForCleanup(profile) {
  return uniqueValues([
    profile.absoluteFiles?.cmd,
    ...(profile.absoluteFiles?.cns || []),
    ...(profile.absoluteFiles?.st || []),
  ].filter(Boolean));
}

function findMarkedAiCandidates(text, filePath, profile) {
  const candidates = [];
  const regex = /^.*AI_PATCH_BEGIN:\s*([^\r\n]+)[^\r\n]*(?:\r?\n[\s\S]*?)?^.*AI_PATCH_END:\s*\1[^\r\n]*(?:\r?\n)?/gm;
  for (const match of text.matchAll(regex)) {
    const markerId = match[1].trim();
    const startLine = lineNumberAt(text, match.index);
    candidates.push({
      kind: "marker",
      markerId,
      title: markerId,
      filePath,
      relativePath: path.relative(profile.characterPath, filePath),
      startLine,
      endLine: startLine + countLines(match[0]) - 1,
      bytes: Buffer.byteLength(match[0], "utf8"),
      autoRemovable: true,
      reason: "Marker-protected AI_PATCH block",
      snippet: candidateSnippet(text, match.index, match.index + match[0].length),
    });
  }
  return candidates;
}

function findHeuristicAiCandidates(text, filePath, profile) {
  const candidates = [];
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".cmd") {
    const headings = [...text.matchAll(/^[^\S\r\n]*\[State\s+-1\s*,[^\r\n]*\]\s*$/gim)].map((match) => ({
      index: match.index,
      end: match.index + match[0].length,
      heading: match[0],
    }));
    for (let i = 0; i < headings.length; i += 1) {
      const start = headings[i].index;
      const end = headings[i + 1]?.index ?? text.length;
      const block = text.slice(start, end);
      if (/AI_PATCH_(BEGIN|END|QUARANTINE)/i.test(block)) continue;
      const title = (block.match(/^\s*\[([^\]]+)\]/m) || [null, "CMD AI block"])[1];
      const titleHasAi = /\b(?:AI|CPU|Parry|Guard|Router|Combo|Rush|Boss|Zero|Counter|Charge|Dodge|Roll)\b/i.test(title);
      const bodyHasAi = /\b(?:AILevel|var\(59\)|fvar\(32\)|Random|P2BodyDist|EnemyNear|InGuardDist|NumProj|MoveHit|MoveContact|HitOverride)\b/i.test(block);
      if (!titleHasAi && !bodyHasAi) continue;
      const hasController = /^\s*type\s*=\s*(?:ChangeState|HitOverride|VarSet|VarAdd|Null|Helper|PowerAdd)\b/im.test(block);
      const hasAttackPayload = /^\s*type\s*=\s*(?:HitDef|Projectile|Explod|PlaySnd)\b/im.test(block);
      const hasAiGate = /\b(?:var\(59\)|AILevel|Random|fvar\(32\))\b/i.test(block);
      const confidenceScore = [
        titleHasAi,
        bodyHasAi,
        hasController,
        hasAiGate,
        !hasAttackPayload,
      ].filter(Boolean).length;
      const quarantineEligible = titleHasAi && /\bAI\b/i.test(title) && hasController && !hasAttackPayload;
      const startLine = lineNumberAt(text, start);
      const markerId = `old_ai:${stableHash(`${path.relative(profile.characterPath, filePath)}:${startLine}:${title}:${candidateSnippet(text, start, start + block.length)}`)}`;
      candidates.push({
        kind: "cmd_ai_state",
        markerId,
        title,
        filePath,
        relativePath: path.relative(profile.characterPath, filePath),
        startLine,
        endLine: startLine + countLines(block) - 1,
        startIndex: start,
        endIndex: start + block.length,
        bytes: Buffer.byteLength(block, "utf8"),
        autoRemovable: false,
        quarantineEligible,
        confidence: quarantineEligible ? "safe_quarantine" : "review",
        reason: quarantineEligible
          ? "High-confidence State -1 AI controller. Safe to quarantine by adding triggerAll = 0."
          : "Heuristic CMD AI block. Review before quarantine/delete.",
        snippet: candidateSnippet(text, start, start + block.length),
      });
    }
  }

  const varComment = /^;.*\b(?:AI|CPU|guard|parry|combo|router|rush|boss)\b.*\b(?:var|fvar)\s*\(\d+\).*$/gim;
  for (const match of text.matchAll(varComment)) {
    if (/AI_PATCH_/i.test(match[0])) continue;
    const startLine = lineNumberAt(text, match.index);
    candidates.push({
      kind: "var_comment",
      title: match[0].trim().slice(0, 96),
      filePath,
      relativePath: path.relative(profile.characterPath, filePath),
      startLine,
      endLine: startLine,
      bytes: Buffer.byteLength(match[0], "utf8"),
      autoRemovable: false,
      quarantineEligible: false,
      confidence: "review",
      reason: "AI-looking variable comment. Review before deleting.",
      snippet: match[0].trim(),
    });
  }

  return candidates;
}

function variableRefsInText(text) {
  const refs = [];
  for (const match of String(text || "").matchAll(/\b(f?var)\s*\(\s*(\d+)\s*\)/gi)) {
    refs.push({ kind: match[1].toLowerCase() === "fvar" ? "fvar" : "var", number: Number(match[2]) });
  }
  return refs;
}

function buildOldAiVarReleasePlan(candidates, profile) {
  const quarantineBlocks = (candidates || []).filter((item) => item.quarantineEligible && item.kind === "cmd_ai_state");
  const refs = new Map();
  const ownership = new Map((profile.varOwnershipMap?.entries || []).map((item) => [`${item.kind}:${item.number}`, item]));
  for (const candidate of quarantineBlocks) {
    for (const ref of variableRefsInText(candidate.snippet || "")) {
      const key = `${ref.kind}:${ref.number}`;
      if (!refs.has(key)) refs.set(key, { ...ref, blocks: [], owner: ownership.get(key)?.owner || "unknown", risk: ownership.get(key)?.risk || "review" });
      refs.get(key).blocks.push(candidate.title);
    }
  }
  const entries = [...refs.values()].map((item) => {
    const owned = ownership.get(`${item.kind}:${item.number}`);
    const safe = owned?.owner === "AI" && owned?.reusable === "yes-if-replacing-old-ai";
    return {
      kind: item.kind,
      number: item.number,
      owner: owned?.owner || item.owner,
      risk: owned?.risk || item.risk,
      reusableNow: !!safe,
      candidateBlocks: uniqueValues(item.blocks).slice(0, 8),
      note: safe ? "Reusable after quarantine and rescan if no active reads remain" : "Do not reuse automatically; owner is not AI-only",
    };
  }).sort((a, b) => a.kind.localeCompare(b.kind) || a.number - b.number);
  return {
    summary: {
      candidateBlocks: quarantineBlocks.length,
      referencedVars: entries.length,
      reusableAfterQuarantine: entries.filter((item) => item.reusableNow).length,
      highRiskReferenced: entries.filter((item) => item.risk === "high").length,
    },
    entries,
  };
}

async function previewAiCleanup(reqBody) {
  const characterPath = reqBody?.characterPath;
  if (!characterPath) throw new Error("characterPath is required");
  const profile = reqBody?.profile || await scanCharacter(characterPath);
  const candidates = [];

  for (const filePath of roleFilesForCleanup(profile)) {
    if (!await pathExists(filePath)) continue;
    const text = await readText(filePath);
    candidates.push(...findMarkedAiCandidates(text, filePath, profile));
    candidates.push(...findHeuristicAiCandidates(text, filePath, profile));
  }

  const safeRemovableCount = candidates.filter((item) => item.autoRemovable).length;
  const quarantineEligibleCount = candidates.filter((item) => item.quarantineEligible).length;
  const releasePlan = buildOldAiVarReleasePlan(candidates, profile);
  return {
    ok: true,
    profile: {
      name: profile.name,
      characterPath: profile.characterPath,
    },
    candidates,
    safeRemovableCount,
    quarantineEligibleCount,
    previewOnlyCount: candidates.length - safeRemovableCount,
    releasePlan,
  };
}

async function previewFullAiVariableRewrite(reqBody) {
  const characterPath = reqBody?.characterPath;
  if (!characterPath) throw new Error("characterPath is required");
  const profile = reqBody?.profile || await scanCharacter(characterPath);
  const brain = reqBody?.brain || await loadBrainByName(reqBody?.brainName);
  const plan = reqBody?.plan || resolveBrain(profile, brain, { approvedVarPool: reqBody?.approvedVarPool });
  let cleanupPreview = reqBody?.cleanupPreview || null;
  if (reqBody?.includeCleanupPreview && !cleanupPreview) {
    cleanupPreview = await previewAiCleanup({ characterPath, profile });
  }
  const rewritePlan = buildVarRewritePlan(profile, brain, plan, cleanupPreview, reqBody?.approvedVarPool);
  return {
    ok: true,
    profile: {
      name: profile.name,
      characterPath: profile.characterPath,
    },
    brain: brain.frontmatter,
    rewritePlan,
    cleanupPreview: cleanupPreview ? {
      quarantineEligibleCount: cleanupPreview.quarantineEligibleCount,
      safeRemovableCount: cleanupPreview.safeRemovableCount,
      releasePlan: cleanupPreview.releasePlan,
    } : null,
  };
}

function quarantineBlock(text, candidate) {
  const block = text.slice(candidate.startIndex, candidate.endIndex);
  if (/AI_PATCH_QUARANTINE_BEGIN/i.test(block) || /AI_PATCH_DISABLED_OLD_AI/i.test(block)) {
    return { text, changed: false };
  }
  const newline = detectNewline(text);
  const heading = block.match(/^[^\S\r\n]*\[State[^\]]*\][^\r\n]*(?:\r?\n)?/i);
  if (!heading) return { text, changed: false };
  const marker = candidate.markerId || `old_ai:${stableHash(block)}`;
  const guard = [
    `; AI_PATCH_QUARANTINE_BEGIN: ${marker}`,
    `triggerAll = 0 ; AI_PATCH_DISABLED_OLD_AI`,
    `; AI_PATCH_QUARANTINE_END: ${marker}`,
  ].join(newline) + newline;
  const patchedBlock = block.slice(0, heading[0].length) + guard + block.slice(heading[0].length);
  return {
    text: text.slice(0, candidate.startIndex) + patchedBlock + text.slice(candidate.endIndex),
    changed: true,
  };
}

async function backupAndApplyAiQuarantine(preview) {
  const candidates = preview.candidates.filter((item) => item.quarantineEligible && item.kind === "cmd_ai_state");
  if (!candidates.length) throw new Error("No high-confidence old AI blocks are available for quarantine");

  const profile = await scanCharacter(preview.profile.characterPath);
  const backupId = `${backupIdForProfile(profile)}_ai_quarantine`;
  const backupRoot = path.join(dataDir, "backups", backupId);
  const byFile = new Map();
  for (const item of candidates) {
    if (!byFile.has(item.filePath)) byFile.set(item.filePath, []);
    byFile.get(item.filePath).push(item);
  }

  await fs.mkdir(backupRoot, { recursive: true });
  const filesChanged = [];
  for (const [filePath, items] of byFile.entries()) {
    if (!await pathExists(filePath)) continue;
    const originalText = await readText(filePath);
    let patchedText = originalText;
    const sorted = [...items].sort((a, b) => b.startIndex - a.startIndex);
    const quarantined = [];
    for (const item of sorted) {
      const applied = quarantineBlock(patchedText, item);
      patchedText = applied.text;
      if (applied.changed) quarantined.push(item.markerId);
    }
    if (patchedText === originalText) continue;
    if (!quarantined.length) continue;

    const relativePath = path.relative(profile.characterPath, filePath);
    const backupPath = path.join(backupRoot, relativePath);
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(filePath, backupPath);
    await writeTextPreservingEncoding(filePath, patchedText);
    filesChanged.push({ filePath, relativePath, quarantinedMarkers: quarantined.reverse() });
  }

  const report = {
    backupId,
    backupRoot,
    characterPath: profile.characterPath,
    filesChanged,
    quarantinedCount: filesChanged.reduce((sum, file) => sum + file.quarantinedMarkers.length, 0),
    createdAt: new Date().toISOString(),
  };
  if (!report.quarantinedCount) {
    throw new Error("No AI blocks were changed. Re-run old AI preview; candidate offsets may be stale or already quarantined.");
  }
  const reportPath = path.join(dataDir, "reports", `${backupId}_quarantine_report.json`);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  return { ...report, reportPath };
}

async function backupAndApplyAiCleanup(preview) {
  const removable = preview.candidates.filter((item) => item.autoRemovable && item.kind === "marker");
  if (!removable.length) throw new Error("No marker-protected AI blocks are available for automatic cleanup");

  const profile = await scanCharacter(preview.profile.characterPath);
  const backupId = `${backupIdForProfile(profile)}_ai_cleanup`;
  const backupRoot = path.join(dataDir, "backups", backupId);
  const byFile = new Map();
  for (const item of removable) {
    if (!byFile.has(item.filePath)) byFile.set(item.filePath, []);
    byFile.get(item.filePath).push(item);
  }

  await fs.mkdir(backupRoot, { recursive: true });
  const filesChanged = [];
  for (const [filePath, items] of byFile.entries()) {
    if (!await pathExists(filePath)) continue;
    const originalText = await readText(filePath);
    let patchedText = originalText;
    for (const item of items) {
      patchedText = patchedText.replace(markerBlockRegex(item.markerId), "");
    }
    if (patchedText === originalText) continue;

    const relativePath = path.relative(profile.characterPath, filePath);
    const backupPath = path.join(backupRoot, relativePath);
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(filePath, backupPath);
    await writeTextPreservingEncoding(filePath, patchedText);
    filesChanged.push({
      filePath,
      relativePath,
      removedMarkers: items.map((item) => item.markerId),
    });
  }

  const report = {
    backupId,
    backupRoot,
    characterPath: profile.characterPath,
    filesChanged,
    removedCount: filesChanged.reduce((sum, file) => sum + file.removedMarkers.length, 0),
    createdAt: new Date().toISOString(),
  };
  const reportPath = path.join(dataDir, "reports", `${backupId}_cleanup_report.json`);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  return { ...report, reportPath };
}

async function buildPatchPreview(reqBody) {
  const characterPath = reqBody?.characterPath;
  if (!characterPath) throw new Error("characterPath is required");

  const profile = reqBody?.profile || await scanCharacter(characterPath);
  const brain = reqBody?.brain || await loadBrainByName(reqBody?.brainName);
  const plan = resolveBrain(profile, brain, { approvedVarPool: reqBody?.approvedVarPool });
  const selectedModules = Array.isArray(reqBody?.selectedModules) ? reqBody.selectedModules : null;
  const { operations, skipped } = buildPatchOperations(profile, plan, selectedModules, { resolverMode: reqBody?.resolverMode });
  const blockingConflicts = conflictsForOperations(plan, operations);
  blockingConflicts.push(...validateMeterGatesForOperations(profile, operations));
  blockingConflicts.push(...validatePowerChargeShimRateForOperations(profile, operations));
  blockingConflicts.push(...validateHighCostFinisherGatesForOperations(profile, operations));
  blockingConflicts.push(...validateNoDamageThrowAttemptGatesForOperations(profile, operations));
  blockingConflicts.push(...validateMultiHitEvasiveNoInterruptForOperations(profile, operations));
  blockingConflicts.push(...validateDiagonalAirInterceptForOperations(profile, operations));
  blockingConflicts.push(...validateDynamicMeterTargetsForOperations(profile, operations));
  blockingConflicts.push(...validatePushbackCompatibilityForOperations(profile, operations));
  for (const operation of operations) {
    blockingConflicts.push(...validateBareTriggerAliasesForOperation(operation, plan, profile));
  }

  const originalTexts = new Map();
  const patchedTexts = new Map();
  const fileOperations = new Map();

  for (const operation of operations) {
    if (!await pathExists(operation.filePath)) {
      skipped.push({ moduleId: operation.moduleId, reason: `Target file does not exist: ${operation.filePath}` });
      continue;
    }
    if (!originalTexts.has(operation.filePath)) {
      const text = await readText(operation.filePath);
      originalTexts.set(operation.filePath, text);
      patchedTexts.set(operation.filePath, text);
      fileOperations.set(operation.filePath, []);
    }

    const applied = applyOperationToText(patchedTexts.get(operation.filePath), operation);
    patchedTexts.set(operation.filePath, applied.text);
    fileOperations.get(operation.filePath).push(compactOperation(applied.result));
  }

  const files = [];
  const diffParts = [];
  for (const [filePath, originalText] of originalTexts.entries()) {
    const patchedText = patchedTexts.get(filePath);
    const operationResults = fileOperations.get(filePath);
    const changed = originalText !== patchedText;
    files.push({
      filePath,
      relativePath: path.relative(profile.characterPath, filePath),
      originalLength: originalText.length,
      newLength: patchedText.length,
      changed,
      operations: operationResults,
    });
    if (changed) diffParts.push(summarizeDiffForFile(filePath, originalText, patchedText, operationResults, profile.characterPath));
  }

  blockingConflicts.push(...validateCommandGraphAfterPatch(profile, patchedTexts));

  return {
    profile,
    plan,
    operations: operations.map(compactOperation),
    skipped,
    blockingConflicts,
    files,
    diffText: diffParts.join("\n\n"),
    patchedTexts: Object.fromEntries([...patchedTexts.entries()]),
  };
}

function timestampId() {
  const now = new Date();
  return now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
}

function safeBackupName(value) {
  const cleaned = String(value || "character")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "character";
}

function backupIdForProfile(profile) {
  return `${timestampId()}_${safeBackupName(profile?.name || path.basename(profile?.characterPath || ""))}`;
}

async function backupAndApplyPreview(preview) {
  const backupId = backupIdForProfile(preview.profile);
  const backupRoot = path.join(dataDir, "backups", backupId);
  const changedFiles = preview.files.filter((file) => file.changed);
  await fs.mkdir(backupRoot, { recursive: true });

  for (const file of changedFiles) {
    const backupPath = path.join(backupRoot, file.relativePath);
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(file.filePath, backupPath);
  }

  for (const file of changedFiles) {
    await writeTextPreservingEncoding(file.filePath, preview.patchedTexts[file.filePath]);
  }

  const report = {
    backupId,
    backupRoot,
    characterPath: preview.profile.characterPath,
    filesChanged: changedFiles.map((file) => ({
      filePath: file.filePath,
      relativePath: file.relativePath,
      operations: file.operations,
    })),
    skipped: preview.skipped,
    conflicts: preview.plan.conflicts,
    createdAt: new Date().toISOString(),
  };
  const reportPath = path.join(dataDir, "reports", `${backupId}_patch_report.json`);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  return { ...report, reportPath };
}

async function backupAndApplyCommandAsciiPreview(preview) {
  const changedFiles = preview.files.filter((file) => file.changed);
  if (!changedFiles.length) {
    return { ok: true, backupId: null, filesChanged: [], reportPath: null, skipped: "No non-ASCII command aliases needed" };
  }
  if (preview.commandIssues?.length) {
    throw new Error(`ASCII command alias preview still has ${preview.commandIssues.length} command issue(s).`);
  }

  const backupId = `${backupIdForProfile(preview.profile)}_command_ascii`;
  const backupRoot = path.join(dataDir, "backups", backupId);
  await fs.mkdir(backupRoot, { recursive: true });

  for (const file of changedFiles) {
    const backupPath = path.join(backupRoot, file.relativePath);
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(file.filePath, backupPath);
  }

  for (const file of changedFiles) {
    await writeTextPreservingEncoding(file.filePath, preview.patchedTexts[file.filePath]);
  }

  const report = {
    backupId,
    backupRoot,
    characterPath: preview.profile.characterPath,
    aliasCount: preview.aliases.length,
    aliases: preview.aliases,
    filesChanged: changedFiles.map((file) => ({
      filePath: file.filePath,
      relativePath: file.relativePath,
      encoding: file.encoding,
      replacements: file.replacements,
    })),
    createdAt: new Date().toISOString(),
  };
  const reportPath = path.join(dataDir, "reports", `${backupId}_command_ascii_report.json`);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  return { ...report, reportPath };
}

async function writeInferredMovelist(reqBody) {
  const characterPath = reqBody?.characterPath;
  if (!characterPath) throw new Error("characterPath is required");
  const profile = reqBody?.profile || await scanCharacter(characterPath);
  const movelistPath = profile.absoluteFiles?.movelist || path.join(profile.characterPath, "Movelist.txt");
  const existingText = await pathExists(movelistPath) ? await readText(movelistPath) : "";
  const blockText = renderInferredMovelistText(profile);
  const nextText = upsertInferredMovelistBlock(existingText, blockText);
  const changed = existingText !== nextText;
  if (!changed) {
    return {
      ok: true,
      backupId: null,
      characterPath: profile.characterPath,
      movelistPath,
      moveCount: profile.inferredMovelist?.moves?.length || 0,
      changed: false,
      skipped: "Movelist.txt already has the current inferred block",
    };
  }

  const backupId = `${backupIdForProfile(profile)}_movelist`;
  const backupRoot = path.join(dataDir, "backups", backupId);
  const relativePath = path.relative(profile.characterPath, movelistPath) || "Movelist.txt";
  const backupPath = path.join(backupRoot, relativePath);
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  if (await pathExists(movelistPath)) await fs.copyFile(movelistPath, backupPath);
  await writeTextPreservingEncoding(movelistPath, nextText, "utf8");

  const report = {
    ok: true,
    backupId,
    backupRoot,
    characterPath: profile.characterPath,
    movelistPath,
    relativePath,
    moveCount: profile.inferredMovelist?.moves?.length || 0,
    source: profile.inferredMovelist?.source || {},
    changed,
    createdAt: new Date().toISOString(),
  };
  const reportPath = path.join(dataDir, "reports", `${backupId}_report.json`);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  return { ...report, reportPath };
}

function parseInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer`);
  return number;
}

function normalizeAirPatchRequest(body) {
  const patch = body?.patch || body?.airPatch || {};
  const normalized = {
    actionId: parseInteger(patch.actionId ?? patch.action, "actionId"),
    frameIndex: parseInteger(patch.frameIndex, "frameIndex"),
    clsnType: String(patch.clsnType || "Clsn1"),
    boxIndex: parseInteger(patch.boxIndex ?? 0, "boxIndex"),
    intent: String(patch.intent || "manual_air_patch"),
    delta: {
      x1: parseInteger(patch.delta?.x1 ?? 0, "delta.x1"),
      y1: parseInteger(patch.delta?.y1 ?? 0, "delta.y1"),
      x2: parseInteger(patch.delta?.x2 ?? 0, "delta.x2"),
      y2: parseInteger(patch.delta?.y2 ?? 0, "delta.y2"),
    },
    expectedBefore: patch.expectedBefore ? String(patch.expectedBefore).trim() : null,
  };
  if (!["Clsn1", "Clsn2"].includes(normalized.clsnType)) throw new Error("clsnType must be Clsn1 or Clsn2");
  if (!Object.values(normalized.delta).some((value) => value !== 0)) throw new Error("At least one delta value must be non-zero");
  return normalized;
}

function replaceLineAt(text, startIndex, oldLine, newLine) {
  const endIndex = startIndex + oldLine.length;
  return text.slice(0, startIndex) + newLine + text.slice(endIndex);
}

function applyAirPatchToText(text, patch) {
  const actions = parseAirActions(text);
  const action = actions[patch.actionId];
  if (!action) throw new Error(`AIR action ${patch.actionId} not found`);

  const frame = action.frames.find((item) => item.frameIndex === patch.frameIndex);
  if (!frame) throw new Error(`Frame ${patch.frameIndex} not found in action ${patch.actionId}`);

  const boxes = frame.boxes[patch.clsnType] || [];
  const box = boxes.find((item) => item.boxIndex === patch.boxIndex);
  if (!box) throw new Error(`${patch.clsnType}[${patch.boxIndex}] not found on action ${patch.actionId} frame ${patch.frameIndex}. Choose a frame with an explicit box.`);
  if (patch.expectedBefore && box.lineText.trim() !== patch.expectedBefore) {
    throw new Error(`AIR line changed since preview. Expected '${patch.expectedBefore}' but found '${box.lineText.trim()}'. Re-run AIR Preview before applying.`);
  }

  const coords = [
    box.coords[0] + patch.delta.x1,
    box.coords[1] + patch.delta.y1,
    box.coords[2] + patch.delta.x2,
    box.coords[3] + patch.delta.y2,
  ];
  const indent = box.lineText.match(/^\s*/)?.[0] || "";
  const newLine = `${indent}${patch.clsnType}[${box.boxIndex}] = ${coords.join(", ")}`;
  return {
    text: replaceLineAt(text, box.lineStart, box.lineText, newLine),
    change: {
      actionId: patch.actionId,
      frameIndex: patch.frameIndex,
      clsnType: patch.clsnType,
      boxIndex: patch.boxIndex,
      intent: patch.intent,
      before: box.lineText.trim(),
      after: newLine.trim(),
      oldCoords: box.coords,
      newCoords: coords,
    },
  };
}

async function buildAirPreview(reqBody) {
  const characterPath = reqBody?.characterPath;
  if (!characterPath) throw new Error("characterPath is required");
  const profile = reqBody?.profile || await scanCharacter(characterPath);
  const airFile = profile.absoluteFiles?.air;
  if (!airFile) throw new Error("No AIR file found for character");
  const patch = normalizeAirPatchRequest(reqBody);
  const originalText = await readText(airFile);
  const applied = applyAirPatchToText(originalText, patch);
  const changed = originalText !== applied.text;
  return {
    profile,
    patch,
    file: {
      filePath: airFile,
      relativePath: path.relative(profile.characterPath, airFile),
      changed,
      originalLength: originalText.length,
      newLength: applied.text.length,
      change: applied.change,
    },
    diffText: [
      `--- ${path.relative(profile.characterPath, airFile)}`,
      `+++ ${path.relative(profile.characterPath, airFile)}`,
      `@@ AIR ${patch.intent} action ${patch.actionId} frame ${patch.frameIndex} ${patch.clsnType}[${patch.boxIndex}] @@`,
      `- ${applied.change.before}`,
      `+ ${applied.change.after}`,
    ].join("\n"),
    patchedText: applied.text,
  };
}

async function backupAndApplyAirPreview(preview) {
  if (!preview.file.changed) {
    return { ok: true, backupId: null, filesChanged: [], reportPath: null, skipped: "No AIR change" };
  }
  const backupId = backupIdForProfile(preview.profile);
  const backupRoot = path.join(dataDir, "backups", backupId);
  const backupPath = path.join(backupRoot, preview.file.relativePath);
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.copyFile(preview.file.filePath, backupPath);
  await writeTextPreservingEncoding(preview.file.filePath, preview.patchedText);

  const report = {
    backupId,
    backupRoot,
    characterPath: preview.profile.characterPath,
    filesChanged: [{
      filePath: preview.file.filePath,
      relativePath: preview.file.relativePath,
      change: preview.file.change,
    }],
    airPatch: preview.patch,
    createdAt: new Date().toISOString(),
  };
  const reportPath = path.join(dataDir, "reports", `${backupId}_air_patch_report.json`);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  return { ...report, reportPath };
}

async function loadBrainByName(name = "Brain_Boxer_BL.md") {
  const safeName = path.basename(name);
  const brainPath = path.join(rootDir, "brains", safeName);
  if (!await pathExists(brainPath)) throw new Error(`Brain not found: ${safeName}`);
  return parseBrain(await readText(brainPath), brainPath);
}

async function listBrains() {
  const brainsDir = path.join(rootDir, "brains");
  const files = await fs.readdir(brainsDir, { withFileTypes: true });
  const brains = [];
  for (const file of files) {
    if (!file.isFile() || !/^Brain_.*\.md$/i.test(file.name)) continue;
    const brainPath = path.join(brainsDir, file.name);
    const text = await readText(brainPath);
    const frontmatter = parseFrontmatter(text);
    const stat = await fs.stat(brainPath);
    brains.push({
      fileName: file.name,
      brainId: frontmatter.brain_id || "",
      name: frontmatter.name || file.name,
      version: frontmatter.version || "",
      sourceReference: frontmatter.source_reference || "",
      description: frontmatter.description || "",
      updatedAt: stat.mtime.toISOString(),
    });
  }
  return brains.sort((a, b) => a.name.localeCompare(b.name));
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, name: "ikemen-ai-patcher-helper", rootDir, dataDir, workspaceDir });
});

app.get("/api/brains", async (_req, res) => {
  try {
    res.json({ brains: await listBrains() });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/scan", async (req, res) => {
  try {
    const characterPath = req.body?.characterPath;
    if (!characterPath) throw new Error("characterPath is required");
    res.json(await scanCharacter(characterPath));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/write-inferred-movelist", async (req, res) => {
  try {
    res.json(await writeInferredMovelist(req.body));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/load-brain", async (req, res) => {
  try {
    res.json(await loadBrainByName(req.body?.brainName));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/parse-brain", async (req, res) => {
  try {
    const rawText = req.body?.text;
    const text = typeof rawText === "string" ? rawText : Array.isArray(rawText) ? rawText.join("\n") : String(rawText || "");
    if (!text.trim()) throw new Error("Brain text is required");
    const fileName = path.basename(req.body?.fileName || "selected-brain.md");
    res.json(parseBrain(text, fileName));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/resolve-plan", async (req, res) => {
  try {
    const characterPath = req.body?.characterPath;
    if (!characterPath) throw new Error("characterPath is required");
    const profile = req.body?.profile || await scanCharacter(characterPath);
    const brain = req.body?.brain || await loadBrainByName(req.body?.brainName);
    res.json(resolveBrain(profile, brain, { approvedVarPool: req.body?.approvedVarPool }));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/preview-diff", async (req, res) => {
  try {
    const preview = await buildPatchPreview(req.body);
    const { patchedTexts, ...publicPreview } = preview;
    res.json(publicPreview);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/apply-patch", async (req, res) => {
  try {
    const preview = await buildPatchPreview(req.body);
    if (preview.blockingConflicts.length && !req.body?.allowConflicts) {
      res.status(409).json({
        error: "Patch has unresolved placeholders caused by conflicts. Resolve or pass allowConflicts=true.",
        conflicts: preview.blockingConflicts,
        plan: preview.plan,
        modules: preview.plan.modules.map((module) => ({
          id: module.id,
          unresolvedPlaceholders: module.unresolvedPlaceholders || [],
        })).filter((module) => module.unresolvedPlaceholders.length),
        operations: preview.operations.filter((operation) => operation.unresolvedPlaceholders?.length),
      });
      return;
    }
    const report = await backupAndApplyPreview(preview);
    const { patchedTexts, ...publicPreview } = preview;
    res.json({ ok: true, report, preview: publicPreview });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/command-ascii-preview", async (req, res) => {
  try {
    const preview = await buildCommandAsciiPreview(req.body);
    const { patchedTexts, ...publicPreview } = preview;
    res.json(publicPreview);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/command-ascii-apply", async (req, res) => {
  try {
    const preview = await buildCommandAsciiPreview(req.body);
    const report = await backupAndApplyCommandAsciiPreview(preview);
    const { patchedTexts, ...publicPreview } = preview;
    res.json({ ok: true, report, preview: publicPreview });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/preview-ai-cleanup", async (req, res) => {
  try {
    res.json(await previewAiCleanup(req.body));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/preview-full-ai-rewrite", async (req, res) => {
  try {
    res.json(await previewFullAiVariableRewrite(req.body));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/apply-ai-cleanup", async (req, res) => {
  try {
    const preview = await previewAiCleanup(req.body);
    const report = await backupAndApplyAiCleanup(preview);
    res.json({ ok: true, report });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/apply-ai-quarantine", async (req, res) => {
  try {
    const preview = await previewAiCleanup(req.body);
    const report = await backupAndApplyAiQuarantine(preview);
    res.json({ ok: true, report });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/air-scan", async (req, res) => {
  try {
    const characterPath = req.body?.characterPath;
    if (!characterPath) throw new Error("characterPath is required");
    const profile = req.body?.profile || await scanCharacter(characterPath);
    res.json({
      name: profile.name,
      characterPath: profile.characterPath,
      airFile: profile.files.air,
      stateActionMap: profile.stateActionMap,
      airActions: profile.airActions,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/air-preview", async (req, res) => {
  try {
    const preview = await buildAirPreview(req.body);
    const { patchedText, ...publicPreview } = preview;
    res.json(publicPreview);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/air-apply", async (req, res) => {
  try {
    const preview = await buildAirPreview(req.body);
    const report = await backupAndApplyAirPreview(preview);
    const { patchedText, ...publicPreview } = preview;
    res.json({ ok: true, report, preview: publicPreview });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

export function startServer({ port = Number(process.env.PORT || 8787), host = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      console.log(`AI Patcher helper listening on http://${host}:${actualPort}`);
      resolve({ server, port: actualPort, host, url: `http://${host}:${actualPort}` });
    });
    server.on("error", reject);
  });
}

export { app, rootDir, dataDir, workspaceDir };

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
