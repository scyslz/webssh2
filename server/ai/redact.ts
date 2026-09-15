/**
 * 出网前的脱敏闸门 —— 纯函数、规则驱动、不依赖模型。
 *
 * 设计取向：**宁可多抹，不可漏抹**。误抹的代价是诊断质量略降（用户能在面板里
 * 看到被抹掉的位置，见 AiPanel 的「实际发送内容」），漏抹的代价是凭据外泄。
 * 所以规则整体偏保守，且占位符保留结构（`<redacted:credential:19B>`），
 * 让模型仍能判断「这里有个 19 字节的凭据」，而不是看到一团 `***`。
 */
export interface RedactionCounts {
  privateKey: number;
  jwt: number;
  scheme: number;
  credential: number;
  highEntropy: number;
  privateIp: number;
}

export interface RedactResult {
  text: string;
  counts: RedactionCounts;
  total: number;
}

export interface RedactOptions {
  /**
   * 是否抹掉内网地址，**默认关闭**。
   *
   * 这偏离了最初的方案（原计划默认抹）。理由是内网 IP 属于诊断的关键信息 ——
   * 「连不上 10.0.3.17:6379」这类结论一旦抹掉就没法排查了，而它并不是凭据。
   * 需要严格合规的部署可以打开，代价是排查类回答的质量下降。
   */
  redactPrivateIp?: boolean;
}

const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{2,}/g;
const SCHEME_RE = /\b(Bearer|Basic|Token|ApiKey)\s+([A-Za-z0-9._~+/=-]{8,})/gi;
/**
 * key=value / key: value 形式的凭据。
 *
 * 三个细节都是踩出来的：
 * - `(?<![<:\w])` 防止在**已生成的占位符**里二次匹配 —— 占位符形如
 *   `<redacted:token:24B>`，其中 `token:` 看着就像一对键值，会把占位符自己抹花。
 * - `(?!Bearer|Basic|Token|ApiKey)` 避免把 `Authorization: Bearer ...` 里的
 *   scheme 当成凭据值（那条由 SCHEME_RE 处理，这里只该跳过）。
 * - 分隔符单独成组，替换时保留用户原本写的是 `:` 还是 `=`。
 */
const CREDENTIAL_RE =
  /(?<![<:\w])((?:[A-Za-z0-9_.-]*(?:password|passwd|passphrase|authorization|credential|secret|token|apikey|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*))(\s*["']?\s*[:=]\s*)("?)(?![<[])(?!(?:Bearer|Basic|Token|ApiKey)\b)([^\s"',;]{4,})\3/gi;
const HIGH_ENTROPY_RE =
  /(?=[A-Za-z0-9+/=_-]{40,})(?=[A-Za-z0-9+/=_-]*[A-Z])(?=[A-Za-z0-9+/=_-]*[a-z])(?=[A-Za-z0-9+/=_-]*[0-9])[A-Za-z0-9+/=_-]{40,}/g;
const PRIVATE_IP_RE =
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g;

const byteLength = (value: string) => Buffer.byteLength(value, 'utf8');

export function redactText(input: string, options: RedactOptions = {}): RedactResult {
  const counts: RedactionCounts = {
    privateKey: 0,
    jwt: 0,
    scheme: 0,
    credential: 0,
    highEntropy: 0,
    privateIp: 0,
  };
  let text = input;

  // 1) 私钥整块：必须最先处理，否则块内的 base64 会被后面的规则切碎
  text = text.replace(PRIVATE_KEY_RE, () => {
    counts.privateKey += 1;
    return '<redacted:private-key>';
  });

  // 2) JWT：三段 base64url，肉眼最容易误认为普通字符串
  text = text.replace(JWT_RE, (match) => {
    counts.jwt += 1;
    return `<redacted:jwt:${byteLength(match)}B>`;
  });

  // 3) Authorization 头这类 scheme + 值，保留 scheme 让上下文可读
  text = text.replace(SCHEME_RE, (_match, scheme: string, value: string) => {
    counts.scheme += 1;
    return `${scheme} <redacted:token:${byteLength(value)}B>`;
  });

  // 4) key=value / key: value 形式的凭据（保留键名与原本的分隔符写法）
  text = text.replace(CREDENTIAL_RE, (_match, key: string, separator: string, quote: string, value: string) => {
    counts.credential += 1;
    const placeholder = `<redacted:credential:${byteLength(value)}B>`;
    const mark = quote || '';
    return `${key}${separator}${mark}${placeholder}${mark}`;
  });

  // 5) 高熵长串兜底：要求同时含大小写与数字，避开 git SHA / 容器 ID 这类纯十六进制
  text = text.replace(HIGH_ENTROPY_RE, (match) => {
    counts.highEntropy += 1;
    return `<redacted:token:${byteLength(match)}B>`;
  });

  if (options.redactPrivateIp) {
    text = text.replace(PRIVATE_IP_RE, (match) => {
      counts.privateIp += 1;
      return `<redacted:private-ip:${match.length}B>`;
    });
  }

  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return { text, counts, total };
}
