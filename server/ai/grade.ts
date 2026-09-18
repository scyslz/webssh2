/**
 * 命令判分器 —— AI 提议的命令在落到用户眼前之前，必须由这里重判一次。
 *
 * 为什么是纯函数、为什么必须在服务端：
 * 1. AI 输出本来就先到服务端，前端绕不过去，判分不可被绕过；
 * 2. 纯函数能被穷举测试，规则改动能立刻验证；
 * 3. **不信任模型自评的 risk 字段**。模型说 safe 只是提示，最终等级一律以这里的
 *    规则表为准 —— 让模型给自己的输出打分，等于没有打分。
 *
 * 规则刻意偏保守，但不追求「全部危险都判 dangerous」：一个见什么都报警的判分器
 * 会被用户无视，那才是真的失效。所以按「不可逆 / 影响面超出本机业务」判 dangerous，
 * 「删除、改权限、停服务」这类可恢复或局部影响判 caution。
 */

export type RiskLevel = 'safe' | 'caution' | 'dangerous';

export const RISK_RANK: Record<RiskLevel, number> = { safe: 0, caution: 1, dangerous: 2 };

export const RISK_LABEL: Record<RiskLevel, string> = {
  safe: '只读',
  caution: '需谨慎',
  dangerous: '高风险',
};

export interface GradeHit {
  rule: string;
  label: string;
  level: RiskLevel;
  /**
   * 这条命中属于「常规运维」（启停服务、装包、容器/代码删除、改权限、用户/进程改动…）。
   * 常规运维即使判 caution 也不进复核/审批 —— 真正要拦的是 dangerous。
   * 未标的（find -delete、xargs rm、sed -i 这类「批量/就地」）保留复核。
   */
  routine?: boolean;
}

export interface GradeSegment {
  raw: string;
  binary: string | null;
  elevated: boolean;
  level: RiskLevel;
  hits: string[];
  /**
   * 这一段属于「只读」（命中内置只读表）**或**在用户配置的允许名单里。
   * 它参与的是**风险等级**判断，不是「能不能自动跑」。
   */
  whitelisted: boolean;
  /** 这一段的二进制**明确出现在用户配置的允许名单里** */
  allowlisted: boolean;
}

export interface GradeResult {
  /** 所有片段里的最高等级 */
  level: RiskLevel;
  hits: GradeHit[];
  /** 人话摘要，直接可以显示在面板上 */
  reasons: string[];
  segments: GradeSegment[];
  /**
   * 每个片段都够「只读」。
   *
   * 注意：这**不等于**用户授权的允许名单 —— 内置只读表覆盖了 ps / ls / cat 等一大批
   * 命令，所以几乎所有 safe 命令都会是 true。把它当成「没查出危险操作」来用，
   * 不要当成「用户同意无人值守」。
   */
  allWhitelisted: boolean;
  /** 每个片段的二进制都在用户配置的允许名单里 —— 这才是用户显式授权的自动执行 */
  allAllowlisted: boolean;
  /** 会话登录用户是否为 root */
  rootSession: boolean;
  /**
   * 所有命中都是「常规运维」（见 GradeHit.routine），或压根没命中。
   * 为 true 时表示这次调用没有触及需要人工/模型复核的风险面。
   */
  routineOnly: boolean;
  /**
   * 是否允许无人值守自动执行（Agent 模式只对这类放开）。
   *
   * 三个条件缺一不可，且**必须包含用户的显式授权**：风险为 safe、每个命令都在
   * 允许名单里、且不是 root 会话。默认允许名单为空 → 默认什么都不自动跑，
   * 与「禁止 AI 默认自动执行」一致。
   */
  autoRunnable: boolean;
}

/**
 * 纯只读命令：不产生任何副作用。
 * 刻意**不收**能写文件的工具（sed/awk/tee/find/xargs/curl/wget/dd/nc），
 * 哪怕它们多数时候是只读的 —— 白名单给的是自动执行权，不能有歧义。
 */
const READONLY_BINARIES = new Set([
  'ls', 'dir', 'vdir', 'pwd', 'whoami', 'id', 'groups', 'who', 'w', 'last', 'lastlog',
  'date', 'uptime', 'uname', 'hostname', 'hostnamectl', 'arch', 'nproc', 'getconf',
  'cat', 'tac', 'head', 'tail', 'wc', 'nl', 'grep', 'egrep', 'fgrep', 'zgrep',
  'sort', 'uniq', 'cut', 'tr', 'paste', 'join', 'comm', 'diff', 'cmp',
  'df', 'du', 'free', 'ps', 'top', 'htop', 'atop', 'vmstat', 'iostat', 'mpstat', 'sar', 'pidstat',
  'ss', 'netstat', 'ping', 'ping6', 'traceroute', 'tracepath', 'dig', 'nslookup', 'host',
  'journalctl', 'dmesg', 'lsblk', 'blkid', 'lscpu', 'lsmem', 'lsusb', 'lspci', 'dmidecode',
  'env', 'printenv', 'lsof', 'stat', 'file', 'which', 'whereis', 'type', 'getent',
  'echo', 'true', 'false', 'readlink', 'realpath', 'dirname', 'basename',
  'md5sum', 'sha1sum', 'sha256sum', 'cksum', 'tree', 'findmnt', 'locale',
  'timedatectl', 'localectl', 'loginctl', 'ulimit', 'umask', 'pwd',
]);

/** 只读子命令：这些二进制的**部分**子命令是只读的（按第二个词判定） */
const READONLY_SUBCOMMANDS: Record<string, string[]> = {
  docker: ['ps', 'images', 'logs', 'inspect', 'stats', 'version', 'info', 'top', 'df', 'events', 'port', 'history', 'diff', 'search'],
  podman: ['ps', 'images', 'logs', 'inspect', 'stats', 'version', 'info', 'top', 'diff', 'search'],
  crictl: ['ps', 'images', 'inspect', 'logs', 'stats', 'version', 'info'],
  kubectl: ['get', 'describe', 'logs', 'top', 'version', 'api-resources', 'api-versions', 'explain', 'cluster-info'],
  systemctl: ['status', 'show', 'cat', 'list-units', 'list-unit-files', 'list-sockets', 'list-timers', 'list-dependencies', 'is-active', 'is-enabled', 'is-failed', 'get-default'],
  git: ['status', 'log', 'diff', 'show', 'describe', 'rev-parse', 'blame', 'shortlog', 'ls-files'],
};

/** 两级子命令，例如 docker container ls */
const READONLY_SUBCOMMAND_GROUPS: Record<string, string[]> = {
  container: ['ls', 'ps', 'inspect', 'logs', 'stats', 'top', 'diff', 'port'],
  image: ['ls', 'inspect', 'history'],
  volume: ['ls', 'inspect'],
  network: ['ls', 'inspect'],
  system: ['df', 'info', 'events'],
  node: ['ls', 'describe'],
  pod: ['ls', 'describe'],
  deploy: ['ls', 'describe', 'rollout'],
  svc: ['ls', 'describe'],
};

interface Rule {
  id: string;
  label: string;
  level: RiskLevel;
  test: (normalized: string) => boolean;
  /** 常规运维：命中后不触发复核/审批（见 GradeHit.routine） */
  routine?: boolean;
}

/** 重定向到这些设备是「丢弃输出」，不是危险写入：/dev/null、标准流、tty、fd */
const HARMLESS_REDIRECT_TARGETS = /^\/dev\/(null|stdin|stdout|stderr|tty|fd\/\d+)$/;

/**
 * 命令里是否有「写入关键系统路径」的重定向。
 *
 * 只看 `>` / `>>` 的目标，且要排除 `2>/dev/null`、`&>/dev/null` 这类丢弃输出的写法 ——
 * 它们极其常见，早先的 `/>>?\s*\/(dev)\//` 把 `last -n 15 2>/dev/null` 误判成
 * 「写入关键系统文件」，把一条纯只读命令拦成 high risk。
 */
function writesCriticalPath(segment: string): boolean {
  const re = />>?\s*([^\s|;&]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment))) {
    const target = m[1].replace(/^['"]|['"]$/g, '');
    if (HARMLESS_REDIRECT_TARGETS.test(target)) continue;
    if (/^\/(etc|boot|dev|proc|sys|var\/lib)(\/|$)/.test(target)) return true;
  }
  return false;
}

const has = (re: RegExp): Rule['test'] => (normalized) => re.test(normalized);

/** rm 的选项：判断是否同时带 r 和 f */
function rmFlags(segment: string): { recursive: boolean; force: boolean } {
  const tail = (segment.match(/\brm\b([\s\S]*)/) || ['', ''])[1];
  const flags = tail.match(/--?[A-Za-z][A-Za-z-]*/g) || [];
  return {
    recursive: flags.some((f) => /^--recursive$/i.test(f) || /^-[A-Za-z]*[rR]/.test(f)),
    force: flags.some((f) => /^--force$/i.test(f) || /^-[A-Za-z]*[fF]/.test(f)),
  };
}

/** 目标路径是不是「删了就不是修一下能回来」 */
function isCriticalPath(target: string): boolean {
  const t = target.replace(/\/+$/, '') || '/';
  if (t === '/' || t === '*' || t === '.' || t === '..') return true;
  if (/^\/?\*+$/.test(t)) return true;                 // * 或 /*
  if (/^\.\/\*+$/.test(t)) return true;                // ./*
  const lower = t.toLowerCase();
  if (lower === '~' || lower === '$home' || lower === '${home}') return true;
  // 系统级顶层目录（含其子路径）
  return /^\/(etc|usr|var|boot|opt|srv|root|bin|sbin|lib|lib64|home)(\/|$)/.test(t);
}

/**
 * 定位段内的 `rm` 并看它删的是什么。
 * 不能复用 analyzeSegment 的结果 —— 那是「段首可执行名」，
 * 在 `find . -exec rm {} \;` 里段首是 find，拿 find 的参数去判 rm 的目标会误报。
 */
function rmHitsCriticalTarget(segment: string): boolean {
  const tokens = tokenize(segment);
  const rmIndex = tokens.findIndex((t) => baseName(t) === 'rm');
  if (rmIndex === -1) return false;
  return tokens.slice(rmIndex + 1).filter((t) => !t.startsWith('-')).some(isCriticalPath);
}

const ELEVATE_HIT: GradeHit = { rule: 'elevate', label: '提权执行', level: 'caution' };

/** 段的实际二进制名（去掉 sudo/env 等前缀）。让规则只认「段首就是该命令」 */
const segmentBinary = (s: string): string | null => analyzeSegment(s).binary;

/**
 * 「常规运维」规则 id。命中的命令即使判 caution，也不触发模型复核 / 人工审批。
 *
 * 用户明确归类为不危险的：服务与容器启停重启、包管理安装/更新、容器/代码类删除、
 * 权限/用户/进程改动。真正的风险面是 dangerous（删根、写盘、格式化、清防火墙、关机…），
 * 那些不在此列，仍会拦。
 *
 * 刻意**不**放进来（保留复核）：find -delete、xargs rm、sed -i、log-destroy、
 * critical 类 —— 它们是「批量/就地」操作，风险随目标变化大，值得再过一道模型。
 */
const ROUTINE_RULE_IDS = new Set([
  'service-state',        // systemctl/service stop|restart|reload
  'package-remove',       // 卸载软件包
  'docker-destructive',   // docker rm/rmi/prune/down
  'k8s-destructive',      // kubectl delete/scale/apply…
  'git-destructive',      // git reset --hard / clean -f / push -f
  'chmod-777',
  'chown-recursive',
  'user-delete',
  'user-mutate',
  'passwd-change',
  'mount-mutate',
  'crontab-edit',
  'sysctl-mutate',
  'swap-off',
  'dd-generic',           // dd 非写盘（写盘的 dd-device 是 dangerous，不在列）
]);

/** 片段级规则表。test 收到的是**已转小写、空白已折叠**的片段。 */
const SEGMENT_RULES: Rule[] = [
  // ---- 删除 ----
  // 必须看**段首二进制**，不能用 `\brm\b` 全片段匹配 —— 否则 `docker rm`、`git rm`
  // 里出现的 `rm` 会被当成文件删除命令误报。
  { id: 'rm-any', label: '删除文件', level: 'caution',
    test: (s) => segmentBinary(s) === 'rm' },
  { id: 'rm-recursive', label: '递归删除', level: 'caution',
    test: (s) => segmentBinary(s) === 'rm' && rmFlags(s).recursive },
  { id: 'rm-critical-target', label: '删除目标落在系统目录或根目录', level: 'dangerous',
    test: (s) => segmentBinary(s) === 'rm' && rmHitsCriticalTarget(s) },
  { id: 'rm-no-preserve-root', label: '关闭了根目录保护', level: 'dangerous',
    test: has(/--no-preserve-root/) },

  // ---- 磁盘 ----
  { id: 'dd-device', label: '向块设备直写（dd of=/dev/…）', level: 'dangerous',
    test: (s) => /\bdd\b/.test(s) && /of=\s*\/dev\//.test(s) },
  { id: 'dd-generic', label: 'dd 裸写磁盘', level: 'caution', test: has(/\bdd\b/) },
  { id: 'mkfs', label: '格式化文件系统', level: 'dangerous',
    test: has(/\b(mkfs(\.[a-z0-9]+)?|mkswap|wipefs|shred)\b/) },
  { id: 'partition-table', label: '改动分区表', level: 'dangerous',
    test: has(/\b(fdisk|sfdisk|gdisk|sgdisk|parted|cfdisk)\b/) },
  { id: 'lvm-raid', label: '移除 LVM / RAID 卷', level: 'dangerous',
    test: has(/\b(pvremove|vgremove|lvremove|mdadm)\b/) },
  { id: 'raw-device-redirect', label: '重定向写入块设备', level: 'dangerous',
    test: has(/>>?\s*\/dev\/(sd|hd|vd|nvme|mmcblk|xvd|disk)/) },

  // ---- 权限 / 提权 ----
  { id: 'chmod-recursive-777', label: '递归放开全部权限', level: 'dangerous',
    test: (s) => /\bchmod\b/.test(s) && /-r\b/i.test(s) && /(777|a\+rwx)/.test(s) },
  { id: 'chmod-777', label: '放开全部权限', level: 'caution',
    test: (s) => /\bchmod\b/.test(s) && /(777|a\+rwx)/.test(s) },
  { id: 'chown-recursive', label: '递归改属主', level: 'caution',
    test: (s) => /\bchown\b/.test(s) && /-r\b/i.test(s) },

  // ---- 服务 / 网络 ----
  { id: 'service-state', label: '停止或重启服务', level: 'caution',
    test: has(/\b(systemctl|service)\b[^|;&]*\s(stop|disable|mask|restart|kill|reload)\b/) },
  { id: 'firewall-flush', label: '清空防火墙规则（可能直接断连）', level: 'dangerous',
    test: has(/\b(iptables|ip6tables)\b[^|;&]*\s(-f|-x)\b/) },
  { id: 'nft-flush', label: '清空 nftables 规则', level: 'dangerous',
    test: has(/\bnft\b[^|;&]*\bflush\b/) },
  { id: 'kill-init', label: '杀 init 或全量杀进程', level: 'dangerous',
    test: has(/\bkill(all)?\b[^|;&]*\s-9\s+(-1|1)\b/) },
  { id: 'power', label: '关机或重启', level: 'dangerous',
    test: (s) => /\b(shutdown|reboot|halt|poweroff)\b/.test(s) || /\b(te)?init\s+[06]\b/.test(s) },

  // ---- 账户 ----
  { id: 'user-delete', label: '删除用户或用户组', level: 'caution',
    test: has(/\b(userdel|groupdel|deluser|delgroup)\b/) },
  { id: 'user-mutate', label: '新增用户或改授权', level: 'caution',
    test: has(/\b(useradd|adduser|usermod|groupadd|groupmod|visudo)\b/) },
  { id: 'passwd-change', label: '修改密码', level: 'caution', test: has(/\bpasswd\b/) },

  // ---- 关键文件 ----
  { id: 'critical-file-write', label: '写入关键系统文件', level: 'dangerous',
    test: (s) => writesCriticalPath(s) },
  { id: 'critical-file-edit', label: '就地修改关键系统文件', level: 'dangerous',
    test: has(/\b(sed|tee|truncate|cp|mv|dd|install)\b[^|;&]*\/(etc\/(fstab|passwd|shadow|sudoers|hosts|resolv\.conf)|boot\/)/) },
  { id: 'credential-read', label: '读取凭据文件', level: 'caution',
    test: has(/\b(cat|less|more|head|tail|grep|awk|strings)\b[^|;&]*(\/etc\/shadow|\.ssh\/(id_|authorized_keys)|\.aws\/credentials|\.kube\/config)/) },

  // ---- 包 / 日志 / 其他 ----
  { id: 'package-remove', label: '卸载软件包', level: 'caution',
    test: has(/\b(apt|apt-get|yum|dnf|pacman|zypper|apk|brew)\b[^|;&]*\b(remove|purge|autoremove|erase|uninstall)\b/) },
  { id: 'log-destroy', label: '清空历史或日志', level: 'caution',
    test: has(/\b(history\s+-c|truncate\b[^|;&]*\.?log)\b/) },
  { id: 'swap-off', label: '关闭 swap', level: 'caution', test: has(/\bswapoff\b/) },
  { id: 'mount-mutate', label: '挂载或卸载文件系统', level: 'caution',
    test: has(/\bmount\b\s+\S|\bumount\b/) },
  { id: 'crontab-edit', label: '改动定时任务', level: 'caution',
    test: has(/\bcrontab\b[^|;&]*\s-[er]\b/) },
  { id: 'find-destructive', label: '批量删除或就地改权限', level: 'caution',
    test: has(/\bfind\b[^|;&]*(-delete|-exec\s+(rm|chmod|chown|truncate)|\s-ok\s+rm)/) },
  { id: 'xargs-destructive', label: '把结果交给删除或覆盖命令', level: 'caution',
    test: has(/\bxargs\b[^|;&]*\b(rm|mv|cp|dd|truncate|sh|bash)\b/) },
  { id: 'inplace-sed', label: '就地修改文件（sed -i）', level: 'caution',
    test: has(/\bsed\b[^|;&]*(\s-i\b|\s--in-place\b)/) },
  { id: 'docker-destructive', label: '删除容器 / 卷 / 镜像', level: 'caution',
    test: has(/\b(docker|podman)\b[^|;&]*\b(rm|rmi|prune|kill|down|volume\s+rm|network\s+rm|system\s+prune)\b/) },
  { id: 'k8s-destructive', label: '改动集群资源', level: 'caution',
    test: has(/\bkubectl\b[^|;&]*\b(delete|drain|cordon|scale|apply|patch|replace|edit|rollout\s+undo)\b/) },
  { id: 'git-destructive', label: '丢弃改动或强推', level: 'caution',
    test: has(/\bgit\b[^|;&]*(reset\s+--hard|clean\s+-[a-z]*f|push\s+(-\w*f\w*|--force)|checkout\s+--\s|branch\s+-D|restore\b|tag\s+-d)/) },
  { id: 'sysctl-mutate', label: '改动内核运行参数', level: 'caution',
    test: has(/\b(sysctl\s+-w|modprobe\s+-r|rmmod|insmod)\b/) },
];

/** 整条命令级别的规则：跨片段，必须先于拆段判断 */
const WHOLE_RULES: Rule[] = [
  { id: 'pipe-to-shell', label: '把内容直接管道进 shell 执行', level: 'dangerous',
    test: has(/\|\s*(sudo\s+|doas\s+)?(\/[\w./-]*\/)?(ba|z|k|d|fi|c)?sh\b/) },
  { id: 'download-exec', label: '下载并直接执行', level: 'dangerous',
    test: has(/\b(curl|wget|fetch)\b[^|;&]*\|\s*(sudo\s+)?\S*(sh|bash|python3?|perl|ruby)\b/) },
  { id: 'fork-bomb', label: '疑似 fork 炸弹', level: 'dangerous',
    test: has(/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/) },
];

/**
 * 拆成独立命令片段：尊重引号，按 `;` `&&` `||` `|` `&` 与换行切。
 *
 * `&` 不能像以前那样一律当分隔符：`2>&1`、`>&2`、`&>` 都是**重定向**语法，
 * 拆开会把 `cmd 2>&1` 切成 `cmd 2>` 和 `1`，判分片段彻底错位。规则：
 *  - `&&` → 分隔符（逻辑与）
 *  - `&>` 或以 `&` 结尾的重定向（前一个非空白字符是 `>` 或 `&`）→ 留在片段里
 *  - 单独的 `&` → 后台分隔符，切断
 */
export function splitSegments(input: string): string[] {
  const text = input.replace(/\r/g, '').replace(/\\\n/g, ' ');
  const out: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;

  const lastMeaningful = () => {
    for (let k = buf.length - 1; k >= 0; k -= 1) {
      if (!/\s/.test(buf[k])) return buf[k];
    }
    return '';
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      buf += ch;
      if (ch === '\\' && quote === '"' && i + 1 < text.length) {
        buf += text[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '\\' && i + 1 < text.length) { buf += ch + text[i + 1]; i += 1; continue; }
    if (ch === '\n' || ch === ';') { out.push(buf); buf = ''; continue; }
    if (ch === '&') {
      const next = text[i + 1];
      // `&&` 逻辑与 → 分隔
      if (next === '&') { out.push(buf); buf = ''; i += 1; continue; }
      // 重定向：`&>`、`>&`、`2>&1` 里的 `&` 前一个有效字符是 `>` 或 `&`
      const prev = lastMeaningful();
      if (next === '>' || prev === '>' || prev === '&') { buf += ch; continue; }
      // 单独 `&` = 后台执行 → 分隔
      out.push(buf); buf = '';
      continue;
    }
    if (ch === '|') {
      out.push(buf);
      buf = '';
      if (text[i + 1] === '|') i += 1;
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

const ELEVATORS = new Set(['sudo', 'doas', 'su']);
/** 只是包了一层，不改变被执行的程序本身 */
const WRAPPERS = new Set(['command', 'builtin', 'nohup', 'time', 'stdbuf', 'ionice', 'nice', 'setsid', 'exec']);

/** 按空白切词，引号内的空白不切、引号本身不保留 */
export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < segment.length) { i += 1; continue; }
      if (ch === quote) { quote = null; continue; }
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (buf) { tokens.push(buf); buf = ''; }
      continue;
    }
    buf += ch;
  }
  if (buf) tokens.push(buf);
  return tokens;
}

const baseName = (token: string) => token.split('/').pop()!.toLowerCase();

export interface SegmentAnalysis {
  binary: string | null;
  argv: string[];
  elevated: boolean;
}

/** 剥掉 sudo / env / 环境变量赋值，找出真正被执行的程序 */
export function analyzeSegment(segment: string): SegmentAnalysis {
  const tokens = tokenize(segment);
  const isAssignment = (token: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
  let elevated = false;
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];
    if (isAssignment(token)) { i += 1; continue; }
    const name = baseName(token);

    if (name === 'env') {
      i += 1;
      while (i < tokens.length && isAssignment(tokens[i])) i += 1;
      continue;
    }
    if (name === 'sudo' || name === 'doas') {
      elevated = true;
      i += 1;
      // 跳过提权命令自己的选项；带值的连值一起跳
      while (i < tokens.length && tokens[i].startsWith('-')) {
        const opt = tokens[i];
        i += 1;
        if (/^-(u|g|p|C|h|r|t|U|D|R)$/.test(opt)) i += 1;
      }
      continue;
    }
    if (name === 'su') {
      elevated = true;
      i += 1;
      while (i < tokens.length && tokens[i].startsWith('-')) {
        const opt = tokens[i];
        i += 1;
        if (opt === '-c') {
          /**
           * `su -c 'cmd'` 里的 cmd 会被真正执行，必须像 `bash -c` 一样递归判分，
           * 否则 `su -c "rm -rf /"` 只会命中「提权」这一条，内层危险命令整个漏报。
           * 把内层命令塞进 argv，由 extractInnerCommand 提取。
           */
          const inner = tokens[i];
          return { binary: name, argv: inner ? [inner] : [], elevated };
        }
      }
      // 没有 -c：剩下的第一个词是用户名，之后是登录 shell —— 不递归
      if (i < tokens.length && !isAssignment(tokens[i])) i += 1;
      continue;
    }
    if (WRAPPERS.has(name)) { i += 1; continue; }
    if (token.startsWith('-')) { i += 1; continue; }

    return { binary: name, argv: tokens.slice(i + 1), elevated };
  }
  return { binary: null, argv: [], elevated };
}

/** 会「再执行一层字符串」的东西。`bash -c "rm -rf /"` 里的内容是真会跑的，
 *  必须递归判分，否则就是漏报。 */
const SHELL_BINARIES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'busybox', 'fish']);

/** 取出要递归判分的内层命令；取不到返回 null */
export function extractInnerCommand(analysis: SegmentAnalysis): string | null {
  const { binary, argv } = analysis;
  if (!binary) return null;
  if (binary === 'eval') return argv[0]?.trim() || null;
  // su -c 'cmd'：analyzeSegment 已把内层命令放进 argv[0]
  if (binary === 'su') return argv[0]?.trim() || null;
  if (!SHELL_BINARIES.has(binary)) return null;
  // -c / -lc / -ec 这类组合短选项都算
  const index = argv.findIndex((t) => /^-[A-Za-z]*c[A-Za-z]*$/.test(t));
  if (index === -1) return null;
  return argv[index + 1]?.trim() || null;
}

/**
 * 无子命令时也视为只读的二进制。
 *
 * `systemctl --failed` / `systemctl --no-pager` 这类只带选项、不带子命令的调用，
 * 默认动作是列出/查询单元，属纯只读；但 `isWhitelisted` 按「第一个 positional
 * 子命令」判定，选项被过滤后 positional 为空，会误判成非只读 → root 下被拦。
 */
const READONLY_WHEN_NO_SUBCOMMAND = new Set(['systemctl']);

function isWhitelisted(analysis: SegmentAnalysis, extra: string[]): boolean {
  const { binary, argv } = analysis;
  if (!binary) return false;
  if (extra.includes(binary)) return true;
  if (READONLY_BINARIES.has(binary)) return true;

  const subs = READONLY_SUBCOMMANDS[binary];
  if (!subs) return false;
  // 选项、重定向（`2>/dev/null`、`>/tmp/x`）都不是子命令，不能当 positional 用 ——
  // 否则 `systemctl --failed 2>/dev/null` 会把 `2>/dev/null` 当成子命令判非只读。
  const positional = argv.filter((t) => !t.startsWith('-') && !t.includes('>'));
  const first = positional[0];
  if (!first) return READONLY_WHEN_NO_SUBCOMMAND.has(binary);
  if (subs.includes(first)) return true;

  const group = READONLY_SUBCOMMAND_GROUPS[first];
  const second = positional[1];
  return Boolean(group && second && group.includes(second));
}

export interface GradeOptions {
  /** 用户自定义白名单（在默认只读白名单之外追加） */
  whitelist?: string[];
  /** 会话登录用户；root 类账号禁止自动执行 */
  sessionUser?: string;
  /** 显式声明是否 root 会话 */
  isRoot?: boolean;
}

const ROOT_USERS = new Set(['root', 'admin', 'administrator']);

/** 递归判分的最大深度，防止 `bash -c "bash -c ..."` 这种东西把栈吃穿 */
const MAX_NEST_DEPTH = 2;

export function gradeCommand(command: string, options: GradeOptions = {}): GradeResult {
  return gradeInternal(command, options, 0);
}

function gradeInternal(command: string, options: GradeOptions, depth: number): GradeResult {
  const extra = (options.whitelist || []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const rootSession = options.isRoot ?? ROOT_USERS.has((options.sessionUser || '').toLowerCase());

  const whole = command.replace(/\s+/g, ' ').trim().toLowerCase();
  const hits: GradeHit[] = [];
  const seen = new Set<string>();
  const record = (hit: GradeHit) => {
    if (seen.has(hit.rule)) return;
    seen.add(hit.rule);
    hits.push(ROUTINE_RULE_IDS.has(hit.rule) ? { ...hit, routine: true } : hit);
  };

  for (const rule of WHOLE_RULES) {
    if (whole && rule.test(whole)) record({ rule: rule.id, label: rule.label, level: rule.level });
  }

  const segments: GradeSegment[] = splitSegments(command).map((raw) => {
    const normalized = raw.replace(/\s+/g, ' ').trim().toLowerCase();
    const analysis = analyzeSegment(raw);
    const segmentHits: string[] = [];
    let level: RiskLevel = 'safe';

    for (const rule of SEGMENT_RULES) {
      if (!rule.test(normalized)) continue;
      segmentHits.push(rule.id);
      if (RISK_RANK[rule.level] > RISK_RANK[level]) level = rule.level;
      record({ rule: rule.id, label: rule.label, level: rule.level });
    }

    // 提权是结构信息（靠分词判定），不是文本模式，所以不放进规则表
    if (analysis.elevated) {
      segmentHits.push(ELEVATE_HIT.rule);
      if (RISK_RANK[ELEVATE_HIT.level] > RISK_RANK[level]) level = ELEVATE_HIT.level;
      record(ELEVATE_HIT);
    }

    // `bash -c "…"` / `eval "…"` 的内层字符串会被真正执行 → 递归判分后并入本段
    if (depth < MAX_NEST_DEPTH) {
      const inner = extractInnerCommand(analysis);
      if (inner) {
        const nested = gradeInternal(inner, options, depth + 1);
        for (const hit of nested.hits) {
          record(hit);
          if (!segmentHits.includes(hit.rule)) segmentHits.push(hit.rule);
        }
        if (RISK_RANK[nested.level] > RISK_RANK[level]) level = nested.level;
      }
    }

    return {
      raw,
      binary: analysis.binary,
      elevated: analysis.elevated,
      level,
      hits: segmentHits,
      whitelisted: !analysis.elevated && isWhitelisted(analysis, extra),
      // 提权的命令一律不算用户授权（sudo 出来的效果远超名单里的字面命令）
      allowlisted: !analysis.elevated && Boolean(analysis.binary) && extra.includes(analysis.binary as string),
    };
  });

  let level: RiskLevel = 'safe';
  for (const hit of hits) {
    if (RISK_RANK[hit.level] > RISK_RANK[level]) level = hit.level;
  }

  const allWhitelisted = segments.length > 0 && segments.every((s) => s.whitelisted);
  const allAllowlisted = segments.length > 0 && segments.every((s) => s.allowlisted);
  const autoRunnable = level === 'safe' && allAllowlisted && !rootSession;
  // 没有任何 dangerous 命中，且所有命中都是常规运维 → 不必复核/审批
  const routineOnly = hits.every((h) => h.level !== 'dangerous' && h.routine === true);

  return {
    level,
    hits,
    reasons: hits.map((h) => h.label),
    segments,
    allWhitelisted,
    allAllowlisted,
    rootSession,
    routineOnly,
    autoRunnable,
  };
}
