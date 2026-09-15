import type { RiskLevel } from './grade.ts';

/**
 * 从模型的自由文本里把结构化命令草稿抠出来。
 *
 * 前提是「模型的输出格式不可靠」：它可能加 ```json 围栏、前面写一段解释、
 * 后面补一句「以上」、字段名换成 cmd / commands、risk 写中文。
 * 所以这里**不做严格 schema 校验**，而是尽量宽容地找；找不到就返回 null，
 * 由调用方降级成只读展示 —— 绝对不能把半截 JSON 或一段散文当成命令递给用户。
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

const MAX_COMMAND_CHARS = 4000;

/** 中文全角标点几乎不可能出现在真命令里，出现即说明模型把散文填进了 command */
const PROSE_PUNCTUATION = /[。；，、：？！“”‘’（）]/;

function stripFences(text: string): string {
  return text.replace(/```[a-zA-Z]*\s*\n?/g, '\n').replace(/```/g, '\n');
}

/** 扫描出所有顶层平衡的 {...}，跳过字符串字面量里的花括号 */
function extractJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let quote: '"' | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"') { quote = ch; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth <= 0 && start !== -1) {
        out.push(text.slice(start, i + 1));
        start = -1;
        depth = 0;
      }
      continue;
    }
  }
  return out;
}

const firstString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** 字段名可能被模型改名，按优先级取第一个存在的 */
function pickString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = firstString(source[key]);
    if (value && value.trim()) return value;
  }
  return null;
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

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(/[\n;]/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/** 清掉模型爱加的装饰：围栏、行首 $ 提示符、外层引号 */
function cleanCommand(raw: string): string {
  let text = raw.replace(/```[a-zA-Z]*/g, '').replace(/```/g, '').trim();
  text = text.replace(/^(\$|#)\s+/gm, '');
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/** 校验并产出最终草稿；任何一条不过就返回 null */
function finalize(
  rawCommand: string,
  explain: string,
  selfRisk: RiskLevel | null,
  prerequisites: string[],
): ParsedDraft | null {
  const command = cleanCommand(rawCommand);
  if (!command) return null;
  if (command.length > MAX_COMMAND_CHARS) return null;
  // 含全角标点基本就是把解释塞进了 command，认定解析失败
  if (PROSE_PUNCTUATION.test(command)) return null;
  // 明显不是命令的散文（不含任何字母数字）
  if (!/[a-zA-Z0-9]/.test(command)) return null;
  return { command, explain: explain.trim(), selfRisk, prerequisites };
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
    return finalize(parts.join('\n'), '', null, []);
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

  const explain = pickString(source, ['explain', 'explanation', 'reason', 'analysis', 'note', 'description']) || '';
  const selfRisk = normalizeRisk(source.risk ?? source.risk_level ?? source.level ?? source.severity);
  const prerequisites = normalizeList(source.prerequisites ?? source.requires ?? source.preconditions ?? source.requirements);

  return finalize(rawCommand, explain, selfRisk, prerequisites);
}

/** 解析成功返回草稿，失败返回 null（调用方必须走降级路径） */
export function parseDraft(raw: string): ParsedDraft | null {
  if (!raw || !raw.trim()) return null;
  const text = stripFences(raw);

  // 先试整体解析，再退化为逐个顶层对象扫描
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
