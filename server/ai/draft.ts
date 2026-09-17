import type { RiskLevel } from './grade.ts';
import {
  extractJsonObjects,
  normalizeList,
  pickString,
  sanitizeCommand,
  stripFences,
} from './model-text.ts';

/**
 * 从模型的自由文本里把结构化命令草稿抠出来。
 *
 * 抠取与清洗的原语在 `model-text.ts`（与 agent 共用）。这里只负责
 * 「草稿」这一种形状的语义，以及**找不到就必须失败**这条约束 ——
 * 调用方拿到 null 时必须降级成只读展示，绝不能把散文当命令递给用户。
 */

export interface ParsedDraft {
  /** 一条命令，可能多行 */
  command: string;
  explain: string;
  /** 模型自评，仅作提示；终判以 grade.ts 为准 */
  selfRisk: RiskLevel | null;
  /** 模型声明的前置条件 */
  prerequisites: string[];
}

function normalizeRisk(value: unknown): RiskLevel | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;
  if (/^(safe|low|readonly|read-only|只读|低|安全)$/.test(text)) return 'safe';
  if (/^(caution|medium|moderate|warn|warning|谨慎|中|需谨慎|注意)$/.test(text)) return 'caution';
  if (/^(dangerous|high|critical|destructive|危险|高|高风险|严重)$/.test(text)) return 'dangerous';
  return null;
}

/** 从一个元素里抠出命令文本：字符串直接用，对象取命令字段 */
function extractCommandText(item: unknown): string | null {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    return pickString(item as Record<string, unknown>, ['command', 'cmd', 'shell', 'bash', 'script']);
  }
  return null;
}

function toDraft(value: unknown): ParsedDraft | null {
  // 模型可能直接给一个数组。**必须把所有元素合并**再判分 ——
  // 只取第一个会静默丢掉后面的命令，用户就看不到自己将被执行的全部内容。
  if (Array.isArray(value)) {
    const parts = value.map(extractCommandText).filter((v): v is string => Boolean(v && v.trim()));
    if (!parts.length) return null;
    const command = sanitizeCommand(parts.join('\n'));
    return command ? { command, explain: '', selfRisk: null, prerequisites: [] } : null;
  }

  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;

  let rawCommand = pickString(source, ['command', 'cmd', 'shell', 'bash', 'script']);
  if (!rawCommand) {
    // 也接受 { commands: ["…", "…"] } 这种多命令形式
    const list = normalizeList(source.commands ?? source.steps);
    if (list.length) rawCommand = list.join('\n');
  }
  if (!rawCommand) return null;

  const command = sanitizeCommand(rawCommand);
  if (!command) return null;

  return {
    command,
    explain: pickString(source, ['explain', 'explanation', 'reason', 'analysis', 'note', 'description']) || '',
    selfRisk: normalizeRisk(source.risk ?? source.risk_level ?? source.level ?? source.severity),
    prerequisites: normalizeList(source.prerequisites ?? source.requires ?? source.preconditions ?? source.requirements),
  };
}

/** 解析成功返回草稿，失败返回 null（调用方必须走降级路径） */
export function parseDraft(raw: string): ParsedDraft | null {
  if (!raw || !raw.trim()) return null;
  const text = stripFences(raw);

  // 候选顺序：先整体，再逐个顶层对象。
  // 注意**不能**只认第一个能解析成 JSON 的候选 —— 它可能解析成功但不是草稿形状，
  // 而后面某个候选才是。所以逐个过 toDraft，谁先产出草稿就用谁。
  const candidates: string[] = [];
  try {
    JSON.parse(raw.trim());
    candidates.push(raw.trim());
  } catch {
    // 忽略：下面用扫描兜底
  }
  candidates.push(...extractJsonObjects(text));

  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    const draft = toDraft(value);
    if (draft) return draft;
  }
  return null;
}
