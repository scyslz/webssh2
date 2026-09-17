/**
 * 模型自由文本 → 结构化数据的公共原语。
 *
 * 存在理由：`draft`（单条命令）和 `agent`（每一步）都要从模型的自由文本里抠 JSON，
 * 而模型的输出格式**不可靠** —— 会加 ```json 围栏、前面写一段解释、字段名换成
 * cmd/steps、风险写中文。两套各自演化的宽容解析器迟早分叉，所以抠取逻辑只留这一份。
 *
 * 这里的原则是**尽量找，找不到就认失败**：宽容指的是容忍装饰，不是容忍残缺。
 * 半截 JSON 或一段散文绝不能被当成命令递下去 —— 那是把散文当命令执行。
 */

const MAX_COMMAND_CHARS = 4000;

/** 中文全角标点几乎不可能出现在真命令里，出现即说明模型把散文填进了 command */
const PROSE_PUNCTUATION = /[。；，、：？！“”‘’（）]/;

/** 去掉 ```json 之类围栏，保留内部内容 */
export function stripFences(text: string): string {
  return text.replace(/```[a-zA-Z]*\s*\n?/g, '\n').replace(/```/g, '\n');
}

/** 扫描出所有顶层平衡的 `{...}`，跳过字符串字面量里的花括号 */
export function extractJsonObjects(text: string): string[] {
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

/**
 * 宽松地拿一个 JSON 值：先试整体解析，失败再逐个顶层对象试。
 * 返回第一个解析成功的值；一个都不行返回 null。
 */
export function parseJsonLoose(raw: string): unknown | null {
  if (!raw || !raw.trim()) return null;

  try {
    return JSON.parse(raw.trim());
  } catch {
    // 落到扫描分支
  }

  for (const candidate of extractJsonObjects(stripFences(raw))) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

/** 字段名可能被模型改名，按优先级取第一个存在的非空字符串 */
export function pickString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

/** 优先数组，其次按行/分号切分的字符串 */
export function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(/[\n;]/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/** 清掉模型爱加的装饰：残留围栏、行首 `$`/`#` 提示符、外层引号 */
export function cleanCommand(raw: string): string {
  let text = raw.replace(/```[a-zA-Z]*/g, '').replace(/```/g, '').trim();
  text = text.replace(/^(\$|#)\s+/gm, '');
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/** 清洗 + 判断是否像一条命令；不像则返回 null（调用方必须走降级路径） */
export function sanitizeCommand(raw: string): string | null {
  const command = cleanCommand(raw);
  if (!command) return null;
  if (command.length > MAX_COMMAND_CHARS) return null;
  // 含全角标点基本就是把解释塞进了 command
  if (PROSE_PUNCTUATION.test(command)) return null;
  // 不含任何字母数字说明是散文
  if (!/[a-zA-Z0-9]/.test(command)) return null;
  return command;
}

export { MAX_COMMAND_CHARS };
