# dsh-profile-vault · 个人信息库插件设计

状态：设计稿（未实现，等指令）· v0.1 · 2026-11-03
包名：`@qqiqiq/dsh-profile-vault` · 补丁 id：`profile-vault` · 数据目录：`~/.dsh/dsh-profile-vault/`

---

## 1. 目标与范围

**要解决的问题**：让 AI 在跨会话、跨项目时记得住"某个人"的零散信息（生日、口味、忌口、单位、家人……），但在读取时必须由用户按会话放行，且对会随时间变化的事实保留观测时间，避免拿旧值当现值。

**目标**

1. 以**姓名**为索引：列出库里有哪些人、每个人有哪些条目。
2. 以**姓名 + 条目**为索引：取某个人的某条（或全部）具体数据。
3. **按会话授权**：任何读取（含"列出有哪些人"）都必须先经用户在当前会话里明确同意；未授权时插件不读盘、不返回任何库内数据。
4. AI 可**随时写入**：新增姓名、新增条目、追加观测，无需授权。
5. **时间可推算**：每条观测记录"该事实成立的时间"，派生值（年龄、下次生日）在查询时按 `asOf` 现算，绝不落盘。

**非目标（v1 明确不做）**

- 多用户 / 多租户 / 云同步；数据属于本机这一个用户。
- 静态加密（磁盘上明文 JSON，与 DSH 自身会话日志同级）；见 §12 待定。
- 语义检索 / 向量索引；索引就是姓名 + 条目名。
- 自动从聊天记录里被动抽取个人信息（只信工具调用，见 §8.3）。

---

## 2. 关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 授权闸门放在**工具执行边界**：`execute()` 里先完成询问，得到允许后才打开数据文件 | 满足"授权前不查询、授权后才给结果"的字面语义；拒绝时连 `readdir` 都不做，代码路径上不存在"先查后问" |
| D2 | 授权粒度 = **(会话, 主体)**，主体是"某个人"或"索引"；默认不做跨会话常驻授权 | 用户原话"查询根据会话进行授权"；新会话必须重新开口，避免一次放行永久泄露 |
| D3 | 人用**不透明稳定 id**（`per_<ULID>`），姓名只是可变的索引键 | 改名、别名、重名都不会打断历史；姓名索引是派生缓存，可从文件重建 |
| D4 | 条目值是**观测日志**（append-only），不是字段覆盖 | 生日被纠正、体重随时间变化都保留轨迹；"最新一条"是查询时的视图，不是存储时的真相 |
| D5 | **派生值不落盘**：年龄、生肖、星座、下次生日一律查询时算 | 用户点名的坑：把 18 岁写进库里，一年后就会订错蛋糕 |
| D6 | 存储用 `~/.dsh/dsh-profile-vault/` 下的 JSON 文件 + tmp/rename 原子写；单进程内互斥 | 与工作区既有插件（dsh-comfyui、dsh-diary-persona 设计）一致；文件可读、可备份、可手工修；不引入 zod/数据库依赖 |
| D7 | **不把个人资料注入 system prompt**，只经工具结果返回 | 注入等于每轮都泄露、且无法按会话撤销；工具结果天然受授权闸门管辖 |
| D8 | 读取工具失败时**关闭**（fail-closed）：无 agent、子会话、超时、询问服务异常 → 一律返回"未授权"，不降级为放行 | 隐私闸门的默认值只能是"不" |
| D9 | 写入不做授权卡，但做**三道硬约束**：凭证拒收、证据字段留痕、单值条目冲突显式回报；身份信息（证件号）**允许存但给警告**，读出默认掩码 | 用户要求"随时可写"，但不能变成提示词注入的落盘通道；同时硬拒身份证号没有意义——真实需求存在，拒了只会把数据赶到更不安全的地方 |
| D12 | 敏感条目用**独立授权层级**（`tier=sensitive`）+ 读出默认掩码 + `revealSensitive` 显式取全值 | 只给警告不够：警告写在落盘那一刻，而风险持续到删除。掩码与分层让每一次读取都重新受控 |
| D10 | **设置页可写**，且与工具走**同一条写入路径、同一套校验**（`vault.write()`），面板写入 `source.kind = "panel"` | 用户要在界面上改数据才符合使用习惯；但面板不能变成绕过校验（deny 列表、派生条目拒收、类型检查）的后门，否则闸门只挡了一半 |
| D11 | 面板写入**不改变授权状态**；写完 AI 仍须在本会话获授权才能读 | 用户自己编辑 ≠ 授权 AI 读取；两个动作分开，撤销才有意义 |

---

## 3. 数据模型

### 3.1 三层结构

```
PersonRecord  一个人（姓名 + 别名 + 关系）
  └─ EntryRecord  一个条目（生日、忌口、工作单位…），有序观测列表
       └─ Observation  一次观测（值 + 何时成立 + 何时记录 + 来源）
```

### 3.2 PersonRecord（`people/per_xxx.json`）

```json
{
  "schemaVersion": 1,
  "rev": 7,
  "id": "per_01JC9Z3K7Q2M8V4T6R5W1X0YAB",
  "displayName": "李秀兰",
  "aliases": ["妈妈", "老妈", "李阿姨"],
  "relation": "母亲",
  "tags": ["家人"],
  "note": "口味偏清淡",
  "createdAt": "2026-03-01T10:12:00+08:00",
  "updatedAt": "2026-11-03T14:20:00+08:00",
  "entries": {
    "birthday": {
      "key": "birthday",
      "label": "生日",
      "kind": "date",
      "cardinality": "single",
      "stability": "immutable",
      "tier": "normal",
      "calendar": "solar",
      "observations": [
        {
          "id": "obs_01JC9Z4A1B2C3D4E5F6G7H8J9K",
          "seq": 1,
          "value": "1969-05-12",
          "precision": "day",
          "observedAt": "2026-03-01T10:12:00+08:00",
          "recordedAt": "2026-03-01T10:12:03+08:00",
          "confidence": "inferred",
          "source": { "kind": "tool", "sessionId": "sess_aaa", "agentId": "sess_aaa", "toolCallId": "call_1" },
          "supersededAt": "2026-04-02T09:00:00+08:00",
          "supersededBy": "obs_01JC9Z9M2N3P4Q5R6S7T8V9W0X"
        },
        {
          "id": "obs_01JC9Z9M2N3P4Q5R6S7T8V9W0X",
          "seq": 2,
          "value": "1968-05-12",
          "precision": "day",
          "observedAt": "2026-04-02T09:00:00+08:00",
          "recordedAt": "2026-04-02T09:00:02+08:00",
          "confidence": "stated",
          "evidence": "我妈说她今年 57 岁，生日是五月十二",
          "source": { "kind": "tool", "sessionId": "sess_bbb", "agentId": "sess_bbb", "toolCallId": "call_9" },
          "supersededAt": null,
          "supersededBy": null
        }
      ]
    },
    "taste": {
      "key": "taste",
      "label": "口味偏好",
      "kind": "text",
      "cardinality": "multi",
      "stability": "slow",
      "tier": "normal",
      "observations": [
        { "id": "obs_...", "seq": 1, "value": "不吃香菜", "observedAt": "2026-05-01T12:00:00+08:00", "recordedAt": "...", "confidence": "stated", "source": { }, "supersededAt": null }
      ]
    }
  }
}
```

| 字段 | 说明 |
|---|---|
| `id` | `per_` + ULID，稳定不透明；工具可接受它作为 `personId` |
| `rev` | 单调递增整数，**每次写入 +1**；面板编辑用它做乐观并发（§10.5） |
| `displayName` | 主姓名（规范化后唯一性检查见 §4） |
| `aliases[]` | 别名/称呼，查询时等价匹配（"妈妈"→ 李秀兰） |
| `relation` | 自由文本：母亲/同事/客户…，用于重名消歧与人类阅读 |
| `entries` | 对象，键为 canonical `entryKey` |
| `updatedAt` | 任一写入时刷新，用于索引列表排序与 stale 提示 |

**EntryRecord**

| 字段 | 取值 | 说明 |
|---|---|---|
| `key` | 注册表 key 或规范化后的条目名 | 查询索引 |
| `label` | 中文显示名 | |
| `kind` | `date`/`datetime`/`number`/`text`/`enum`/`bool` | 决定值的校验与渲染 |
| `cardinality` | `single`/`multi` | `single` 新值使旧值 `superseded`；`multi` 追加去重 |
| `stability` | `immutable`/`slow`/`volatile` | 决定 stale 阈值（§5.4） |
| `tier` | `normal` / `sensitive` / `credential` | `sensitive` = 授权卡提示、读出掩码、需分层授权；`credential` = 拒收（§8.2） |
| `calendar` | `solar`/`lunar` | 仅 `kind=date`，农历见 §5.6 |
| `unit` | 如 `cm`/`kg`/`元` | 仅 `kind=number` |
| `observations[]` | 见下 | 按 `seq` 升序 |

**Observation**

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` / `seq` | ✓ | ULID + 条目内单调序号 |
| `value` | ✓ | 按 `kind` 的类型化值；`date` 用 `YYYY-MM-DD`（`precision=day`），必要时 `YYYY-MM`（`precision=month`）、`YYYY`（`precision=year`） |
| `observedAt` | ✓ | **该事实成立/发生的时间**（世界时间），缺省取写入时刻 |
| `recordedAt` | ✓ | 写入时刻，插件生成 |
| `confidence` | ✓ | `stated`（用户直说）/`inferred`（AI 推断）/`imported`（导入） |
| `evidence` | — | ≤200 字，对话原话片段；`stated` 强烈建议带；不落全文 |
| `source` | ✓ | `{ kind }`：`tool`（带 `sessionId`/`agentId`/`toolCallId`）/`panel`（设置页手写）/`import`。写入来源链，审计与"这条是谁写的"共用 |
| `supersededAt` / `supersededBy` | — | 被同条目更新的单值观测取代时填写（不删除） |
| `note` | — | ≤200 字补充 |

**硬约束**：单文件 ≤256 KB；每人条目 ≤200；每条目观测 ≤200（超出时淘汰最旧的已 superseded 观测，保留最近 20 条未淘汰）；`value` 文本 ≤2 KB；人 ≤500。

### 3.3 为什么不用 `storageDomain`

`storageDomain` 是 `KvTable<string,V>` + zod 校验 + 版本迁移，适合"插件级小型键值状态"。本插件需要：按人一文件的原子替换、可读备份、审计日志独立追加、派生索引重建。直接 `fs` + JSON 更贴合，也避免把 zod 变成运行时硬依赖（工作区插件目前全零依赖）。

---

## 4. 姓名索引与查找

### 4.1 规范化

```
normalizeName(s) = NFKC(s).trim().replace(/\s+/g, "").toLocaleLowerCase()
```

不做拼音转换、不做同音纠错、不删称谓（称谓放 `aliases`）。写入与查询用同一函数，保证 `张三`/`张 三`/`ＺＨＡＮＧ` 这类差异不产生重复人。

### 4.2 索引（派生，可重建）

进程启动时扫描 `people/*.json`，在内存建三张表：

- `byNormalizedName: Map<normalized, personId[]>`
- `byId: Map<personId, PersonRecord>`
- `entriesById: Map<personId, Set<entryKey>>`

不持久化索引文件——避免"两个真相源"。500 人量级扫描耗时可忽略；写入后同步更新内存表（并 `fsync` 落盘）。

### 4.3 查找顺序（工具入参 `name`）

1. 精确匹配 `displayName`（规范化后）；
2. 精确匹配任一 `alias`；
3. 无命中 → `not_found`（**不回显任何建议名字**，除非本会话已持有 `index` 授权，见 §8.1）；
4. 命中多个 → `ambiguous`，返回 `{ count, choices: [{ personId, relation, entriesCount, updatedAt }] }`，**不含姓名与数据**；AI 应转而问用户"是家人那位还是同事那位"，再用 `personId` 重查。

`personId` 入参优先于 `name`，用于消歧后的后续调用。

### 4.4 改名与合并

- `profile_remember` 带 `aliases` 时合并入列表（去重，≤20 个）。
- 改 `displayName` 不在 v1 工具面暴露；由面板（Phase 4）操作，保留 `renamedFrom[]`。
- 两人合并（同一人重复建档）Phase 4 面板操作：把 B 的观测按 `observedAt` 并入 A，B 文件移入 `trash/`。

---

## 5. 时间语义（核心）

### 5.1 三个时间

| 时间 | 含义 | 谁给 |
|---|---|---|
| `observedAt` | 这件事在世界里成立/发生的时间 | AI 从上下文推断或用户直说；缺省=现在 |
| `recordedAt` | 插件落盘时间 | 插件 |
| `asOf` | 查询时"假设现在是几点"，用于算年龄等 | 查询方，缺省=现在（配置时区） |

规则：**任何会随时间变化的量，存原始事实 + `observedAt`，绝不存快照式派生值。**
- "我妈 57 岁" → 不存"年龄=57"；存（或纠正）`birthday`，`observedAt` = 说这话的时间。
- "我上个月搬到杭州了" → `city=杭州`，`observedAt` = 上个月（AI 应换算成绝对日期；拿不准就用对话时间并在 `note` 写明"约"）。
- 存入 `年龄`/`生肖`/`星座` 会被注册表识别为派生条目并**拒收**，回提示"记录生日即可，年龄在查询时现算"（§附录）。

### 5.2 查询时的派生计算

对 `kind=date` 且 `key=birthday` 的条目，`profile_get` 附带：

```json
"computed": {
  "asOf": "2026-11-03",
  "ageYears": 58,
  "nextOccurrence": { "date": "2027-05-12", "inDays": 190, "turningAge": 59 },
  "lastOccurrence": { "date": "2026-05-12", "turningAge": 58 }
}
```

- 计算全部在 `asOf`（配置时区）下进行；`asOf` 可显式传入，用于"下个月 12 号订蛋糕"这类场景。
- `ageYears` 用"生日是否已过"判断，不用 `(now-birth)/365.25`。
- `nextOccurrence` 严格 `> asOf`；当天算 `inDays=0` 且归入 `nextOccurrence`。
- 2 月 29 日出生：平年按 3 月 1 日过生日（`turningAge` 按 3 月 1 日算），同时在 `warnings` 注明"闰日生日，平年按 3 月 1 日计"。原始值不变。

### 5.3 返回结构（单条目）

```json
{
  "person": { "id": "per_...", "displayName": "李秀兰" },
  "entries": [{
    "key": "birthday",
    "label": "生日",
    "kind": "date",
    "stability": "immutable",
    "current": {
      "value": "1968-05-12",
      "observedAt": "2026-04-02T09:00:00+08:00",
      "recordedAt": "2026-04-02T09:00:02+08:00",
      "ageDays": 215,
      "confidence": "stated",
      "evidence": "我妈说她今年 57 岁，生日是五月十二"
    },
    "computed": { "ageYears": 58, "nextOccurrence": { "date": "2027-05-12", "inDays": 190, "turningAge": 59 } },
    "warnings": []
  }],
  "truncated": false,
  "asOf": "2026-11-03T14:20:00+08:00"
}
```

`history` 仅在 `includeHistory: true` 时返回（含已 superseded 的观测）；`evidence` 仅在 `includeEvidence: true` 时返回，默认不返回。

敏感条目（`tier: "sensitive"`）的 `current.value` 默认是掩码，并带 `"masked": true`；此时 `computed` 照常给（掩码不影响年龄推算），要完整值需 `revealSensitive: true` 并持有敏感授权。

### 5.4 陈旧度（staleness）

按 `stability` 给阈值；`ageDays > 阈值` 时 `warnings` 追加 `stale`：

| stability | 阈值 | 典型条目 |
|---|---|---|
| `immutable` | 无限（只提示 `observedAt`） | 生日、出生地、血型 |
| `slow` | 365 天 | 单位、职位、住址、爱好 |
| `volatile` | 90 天 | 体重、身高、当前项目、心情 |

`warnings` 是**给模型看的**（"这是 320 天前的观测，涉及现值请确认"），文本短、可直接引用给用户。

### 5.5 时区与精度

- 所有时间戳带偏移量（`+08:00`）；纯日期值不带时区。
- 计算用 `config.timeZone`（默认 `Asia/Shanghai`）；跨时区会话不改变既有数据解释。
- `precision` 缺失时：`YYYY-MM-DD`→`day`，`YYYY-MM`→`month`，`YYYY`→`year`；`year` 精度不参与年龄精确计算，返回 `ageYearsRange`。

### 5.6 农历（Phase 3）

`calendar: "lunar"` 时值形如 `{ "lunar": "1968-04-15", "isLeapMonth": false }`，同时尽量保留 `solar` 近似值（用户口述的公历日期）。
- Phase 3 内置 1900–2100 农历表（约 200 行常量，零依赖）做双向换算；未实现前，`computed` 只返回 `warnings: ["农历日期，暂未换算公历"]`，不瞎算。
- 不要用"农历生日 + 公历年龄"混算；混用时以 `calendar` 字段区分并在结果里标注。

---

## 6. 授权模型

### 6.1 主体与粒度

| 主体 | 覆盖的调用 | 卡片文案要点 |
|---|---|---|
| `person:<personId>` | 对该人的 `profile_get`、`profile_list(name)`、`profile_forget`，**但只覆盖非敏感条目** | "读取「李秀兰」的资料（N 条条目）" |
| `person:<personId>:sensitive` | 该人 `tier=sensitive` 的条目（身份证、银行卡号、住址、健康…） | "读取「李秀兰」的**敏感信息**（身份证号、银行卡号）——完整号码会进入对话记录" |
| `index` | 不带姓名的 `profile_list`（列出库里有哪些人） | "查看资料库的姓名索引（N 人）" |

**两级授权**：普通授权不含敏感条目。读敏感条目要有独立的一次询问（同一个人的第二个主体）；这样"允许读我妈的生日"不会被顺带扩大成"允许读我妈的身份证号"。`person` 授权已存在时，首次请求敏感条目仍会补弹一张**只问敏感部分**的卡。

授权 = `(sessionId, subject)` 二元组。**默认不跨会话**：新会话一切重来。`config.persistentGrants`（默认 `false`）打开后才允许"记住 30 天"，且面板必须显式列出。**敏感主体永不受 `persistentGrants` 影响**，最多 24 小时。

### 6.2 状态机

```
                 ┌──────────── ask 返回 allow(session) ────────────┐
                 │                                                 ▼
NoGrant ──ask──▶ AskPending ──ask 返回 allow(once)──▶ 放行本次 ──▶ NoGrant
   ▲                 │
   │                 ├──ask 返回 deny ─────────────────▶ Denied（本次调用返回 denied）
   │                 └──ask 抛错/中断/超时 ────────────▶ Unavailable（fail-closed）
   │                                                                 │
   └────────── grant 过期 / 撤销 / session/disposed ◀── Granted(session)
```

| 状态 | 持久化 | 说明 |
|---|---|---|
| `NoGrant` | — | 默认 |
| `AskPending` | 内存 | 并发去重：同 `(sessionId, subject)` 只弹一张卡，其余调用 await 同一 Promise |
| `Granted(session)` | `grants.json` | 带 `expiresAt`（默认 `now + 24h`）与 `useCount` |
| `Denied` | 审计日志 | 本次调用立刻返回，不缓存为持久状态（下次调用可再问） |
| `Unavailable` | 审计日志 | 无卡可弹，返回原因码 |

### 6.3 Grant 记录

```json
{
  "id": "grant_01JC...",
  "sessionId": "sess_aaa",
  "subject": { "type": "person", "personId": "per_...", "tier": "sensitive" },
  "scope": "session",
  "createdAt": "2026-11-03T14:20:00+08:00",
  "expiresAt": "2026-11-04T14:20:00+08:00",
  "questionId": "profile-consent-01JC...",
  "callId": "call_7",
  "useCount": 0,
  "lastUsedAt": null,
  "revokedAt": null
}
```

`scope: "once"` **不落盘**：仅本次调用有效，用完即弃。

每次读取校验：`存在 ∧ sessionId 相同 ∧ !revokedAt ∧ now < expiresAt`，通过后 `useCount++`、`lastUsedAt` 更新（批量合并写，避免每次读都写盘）。

### 6.4 询问卡（`ctx.userQuestions.ask`）

```js
ctx.userQuestions.ask({
  questions: [{
    id: "profile-consent",
    header: "个人信息访问",
    question: "允许本会话读取「李秀兰」的资料吗？",
    detail: "共 6 条条目（生日、口味偏好、工作单位…）。允许后本会话内可继续读取该人资料，可随时在设置中撤销。",
    options: [
      { label: "允许本会话", description: "本会话内不再重复询问，24 小时后或会话结束自动失效" },
      { label: "仅本次", description: "只放行这一次查询" },
      { label: "拒绝", description: "不读取、不返回任何数据" }
    ]
  }],
  agent: exec.agent,
  signal: exec.signal,
  wait: { callId: exec.callId }
})
```

- 走 legacy（阻塞）模式，与官方 `ask_user_question` 一致：用户在卡片上点完，工具才继续。
- 问到含 `sensitive` 条目时，`detail` 追加"含敏感条目：健康、证件"；`detail` 里**只出现条目名与数量，不出现值**。
- 询问与答案都会作为会话事件留痕（`pendingQuestions` + `answer_to_pending_question`），授权动作天然可回放、可审计。
- `questionId` 带 ULID，避免并发两张卡的 id 冲突。
- 工具 `timeoutMs: 300000`；超时/中断 → `signal` 中止 → `ASK_ABORTED` → 返回 `consent_unavailable`。

### 6.5 失败关闭矩阵

| 情形 | 服务错误 | 工具返回 |
|---|---|---|
| 调用方不是 agent（无 `exec.agent`） | — | `{ status: "consent_unavailable", reason: "no_agent" }` |
| 子会话（`DELEGATED_CALLER`） | 抛错 | `{ status: "consent_unavailable", reason: "delegated_caller" }` + 提示"由父会话查询后转述" |
| agent 不在活实例表（`CALLER_NOT_LIVE`） | 抛错 | 同上 `reason: "caller_not_live"` |
| 用户拒绝 | 正常返回 | `{ status: "denied" }`，无任何库内数据 |
| 询问被中断/超时 | `ASK_ABORTED` | `reason: "aborted"` |
| 询问服务本身不可用 | 其它异常 | `reason: "ask_failed"`，日志记堆栈，**不记参数值** |

**子会话策略（v1）**：子代理永远拿不到库访问权。父会话查完，把需要的值写进给子代理的 prompt（`send_message`/`subagent` 的文本）即可。理由：能力令牌在 prompt 里传递等于把授权写进日志、且无法撤销；父查子用没有这条泄露路径。

### 6.6 撤销与生命周期

- 面板（Phase 4）"授权"页：按会话列出 `subject`、`expiresAt`、`useCount`、`撤销` 按钮。
- 工具 `profile_grants`：`list` / `revoke`（撤销不需要授权，因为是收紧权限）。
- 钩子 `session/disposed` → 撤销该会话全部 grant；`agent/disposed` 同理兜底。
- 启动时清理过期 grant；`grants.json` 只保留未过期 + 最近 7 天已撤销记录。

### 6.7 审计

`audit/YYYY-MM.jsonl`，追加写，保留 12 个月。**只记决策，不记值**：

```json
{"ts":"...","kind":"read","sessionId":"sess_aaa","tool":"profile_get","subject":"person:per_...","entries":["birthday"],"decision":"granted","grantId":"grant_...","ms":842}
{"ts":"...","kind":"write","sessionId":"sess_aaa","tool":"profile_remember","personId":"per_...","entry":"taste","change":"appended","conflict":false}
{"ts":"...","kind":"consent","sessionId":"sess_aaa","subject":"index","decision":"denied"}
```

---

## 7. 工具定义

命名统一前缀 `profile_`；4 个工具 + 1 个授权管理。所有工具 `inject: ["tools", "userQuestions"]`（`profile_grants` 只需 tools）。

### 7.1 `profile_remember` — 写入

> 为某个人记录一条信息。person 不存在时自动建档。同一条目已有旧值时追加新观测，不覆盖。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | ✓（除 `personId`） | 姓名或已知别名 |
| `personId` | string | — | 已知 id 时优先使用，避免重名歧义 |
| `relation` | string | — | 关系：母亲/同事/客户…（新建时写入） |
| `aliases` | string[] | — | 该人的其他称呼，便于之后按"妈妈"查到 |
| `entry` | string | ✓ | 条目名或别名：`生日`/`birthday`/`出生日期` 等价 |
| `value` | string \| number \| boolean \| string[] | ✓ | 值；`date` 用 `YYYY-MM-DD` |
| `kind` | enum | — | `date`/`datetime`/`number`/`text`/`enum`/`bool`，缺省按注册表推断，未知条目默认 `text` |
| `unit` | string | — | `number` 的单位：cm/kg/元 |
| `stability` | enum | — | `immutable`/`slow`/`volatile`，缺省按注册表 |
| `cardinality` | enum | — | `single`/`multi`，缺省按注册表 |
| `observedAt` | string | — | 该事实成立/发生的时间；缺省=现在。**不传会让之后无法判断新旧** |
| `evidence` | string | — | 对话原话片段 ≤200 字 |
| `confidence` | enum | — | `stated`/`inferred`/`imported`，缺省 `stated` |
| `sensitive` | boolean | — | 强制标为敏感层（默认由注册表决定）；写入身份信息不设它也会自动进敏感层；`credential` 条目不能靠这个参数打开 |
| `valueMode` | enum | — | `full`（默认）/ `last4`：`last4` 只存掩码后的尾号（`****1234`），完整值不进磁盘 |

返回：

```json
{ "ok": true,
  "person": { "id": "per_...", "displayName": "李秀兰", "created": false },
  "entry": { "key": "birthday", "label": "生日", "kind": "date", "cardinality": "single" },
  "observation": { "id": "obs_...", "value": "1968-05-12", "observedAt": "2026-04-02T09:00:00+08:00" },
  "change": "superseded",
  "previous": { "value": "1970-05-12", "observedAt": "2026-03-01T10:12:00+08:00" },
  "warnings": ["旧观测已标记为 superseded，历史仍保留"] }
```

错误码：`not_found`（仅 `personId` 场景）、`ambiguous`、`invalid_entry`、`value_rejected`（命中凭证模式）、`derived_entry`（试图存年龄/生肖/星座）、`too_large`。身份信息（身份证/银行卡等）不返回错误，只在 `warnings` 里带 `identity_value` 与 `maskedValue` 预览。
注意 `single` 条目新旧值不同**不算错误**：照样写入，返回 `change: "superseded"` + `previous`，让模型向用户确认哪个对。
身份信息（身份证/护照/银行卡）写入成功时会带 `warnings: ["identity_value"]`，文案写明"明文存在本机、AI 获敏感授权后可读"，并提示可用 `valueMode: "last4"` 只存尾号。

### 7.2 `profile_list` — 列出人名 / 某人的条目

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` / `personId` | string | — | 给了就列这个人的条目；都不给则列全部人名 |
| `includeValues` | boolean | — | 默认 `false`：只返回条目名、条目数、最后观测时间；`true` 时附最新值（等同一次 `profile_get`） |
| `limit` | number | — | 默认 50，最大 200 |

返回（人物索引）：`{ subjects: [{ personId, displayName, relation, entriesCount, updatedAt }], total, truncated }`
返回（某人条目）：`{ person, entries: [{ key, label, kind, cardinality, stability, tier, observations: 3, lastObservedAt, stale: false }], truncated }`

授权主体：带姓名 → `person`；不带 → `index`。

### 7.3 `profile_get` — 读取具体数据

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` / `personId` | string | ✓（二选一） | |
| `entry` | string \| string[] | — | 条目名或别名；缺省返回全部条目（≤50，超出 `truncated`） |
| `asOf` | string | — | 以该时间计算年龄/下次生日，缺省现在 |
| `includeHistory` | boolean | — | 默认 `false`；`true` 时带 `history[]` |
| `includeEvidence` | boolean | — | 默认 `false`；`true` 时带 `evidence` |
| `revealSensitive` | boolean | — | 默认 `false`。为 `false` 时敏感值一律**掩码**返回（`110***********1234`）；为 `true` 时先要求 `tier=sensitive` 授权，再把完整值返回 |

敏感条目在返回里带 `"masked": true` 与 `"tier": "sensitive"`。模型只看得到尾号，要完整号码必须显式开口——这样"读生日"那次调用顺手拿走的上下文里没有身份证号，日志里也没有。

返回结构见 §5.3；错误码：`not_found`、`ambiguous`、`unknown_entry`（附该人已有条目名的列表——已在授权范围内，可回显）、`denied`、`consent_unavailable`、`sensitive_consent_required`（普通授权够读该人，但这次要的是敏感条目）。

枚举参数：条目名允许别名（`出生日期`、`birthday`、`生日` 均可）。

### 7.4 `profile_forget` — 删除

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` / `personId` | string | ✓ | |
| `entry` | string | — | 删单条目 |
| `observationId` | string | — | 删单条观测 |
| `person` | boolean | — | `true` 表示删整个人（需与 `entry`/`observationId` 互斥） |
| `reason` | string | — | 用户要求删除的原因，写审计 |
| `confirm` | `true` | ✓ | 字面量，防误触 |

授权：与读取同一主体，但卡片换成删除文案（"删除后不可恢复，仅可通过备份找回"）；`person: true` 时卡片额外要求"整个档案"选项。

### 7.5 `profile_grants` — 授权管理（无需授权）

| 参数 | 类型 | 必填 |
|---|---|---|
| `action` | `list` \| `revoke` | ✓ |
| `grantId` | string | revoke 时必填 |
| `all` | boolean | revoke 时可选：撤销本会话全部 |

`list` 返回本会话的 grant（`subjectLabel` 直接给姓名——这些姓名本就是本会话问过的，不构成新泄露）。

### 7.6 提示词引导（可选，`config.injectGuidance` 默认 `true`）

用 `system-prompt/assemble` 注入 4 行**无数据**规则（calculator 同款做法，不声明 `systemPrompt` 依赖）：

> 个人信息库：
> - 用户提到某个人的稳定信息时，用 `profile_remember` 落库，并带上 `observedAt`（事实成立时间，不是现在）。
> - 年龄、生肖、下次生日不要存，也不要自己算：存生日，读取时用返回的 `computed`。
> - 读库前会弹授权卡；被拒绝就照实转告用户，不要换名字重试。

理由是工具描述会被压缩/被忽略，而"别自己算年龄"这条规则直接决定正确性。

---

## 8. 隐私与安全

### 8.1 泄露面收敛

| 面 | 处理 |
|---|---|
| 工具描述 / 系统提示 | 只写规则，不写任何库内数据 |
| 模型可见的工具结果 | 仅授权通过后产生；`truncated` 标出截断 |
| `not_found` | 不回显相似姓名（除非已有 `index` 授权），避免"猜名单" |
| `ambiguous` | 只回 id/关系/条目数，不回姓名 |
| 审计日志 | 不记值、不记 `evidence`、不记 `value` 长度；`reveal` 只记条目名 |
| 错误信息 | 不含 JSON 原文；解析失败只报字段名 |
| 敏感值 | 默认掩码（`masked: true`），完整值要单独授权 + `revealSensitive: true` |

### 8.2 三类敏感，三档处理

早期方案把身份证号列入"拒收"，和密钥一个待遇——这是过度收紧。三类分开：

| 类型 | 例子 | 策略 | 理由 |
|---|---|---|---|
| **凭证** `credential` | 密码、API key、私钥、助记词、短信验证码、银行卡 CVV/有效期 | **硬拒收**（`value_rejected`） | 存进来没有任何收益（AI 不该拿它去登录），泄露后不可撤销；而它有标准替代做法（凭据管理器、手动输入） |
| **身份信息** `identity` | 身份证号、护照号、驾照号、银行卡号、社保号、住址、手机号、健康/过敏 | **允许存**，但：写入给警告、读出默认掩码、完整值需 `tier=sensitive` 授权 | 真实需求存在（订机票、办证、填表）；硬拒只会把数据挤到聊天记录和备忘录里——那里既没有审计也没有闸门，更糟 |
| **普通** | 生日、口味、工作单位… | 正常读写 | |

**写入身份信息时**（`profile_remember` 与面板同一套）：

- 允许落盘，结果里带 `warnings: ["identity_value"]`，文案是具体风险而不是泛泛提示：“身份证号将以明文保存在本机 `~/.dsh/dsh-profile-vault/`；AI 在本会话获得敏感授权后可读完整号码。只是核对身份时，`valueMode: "last4"` 存后四位就够。”
- `valueMode: "last4"`（工具参数 / 面板勾选项）：插件自己把值转成 `****1234` 再存，明文不进磁盘——这是给"只要尾号"的场景准备的，比警告更有用。
- `tier=sensitive` 的条目在面板列表里，非展开态只显示掩码。

**读出时**：默认掩码；`revealSensitive: true` → 先补弹敏感授权卡 → 返回完整值 → 审计写一条 `reveal`（`entryKey`、`sessionId`、时间，不含值）。

### 8.3 凭证拦截（只拦凭证，不拦证件号）

写入前对 `value`（字符串化后）跑规则，命中即 `value_rejected`，**不回显命中的值**：

- 格式：`sk-`、`ghp_`、`AKIA`、`-----BEGIN .*PRIVATE KEY-----`、`xox[baprs]-`、JWT 三段式、`Bearer ` + 长串。
- 关键词 + 数字串：`密码|口令|验证码|CVV|安全码` 与 4+ 位数字同现。
- 条目 key 直接是 `password`/`api_key`/`secret`/`token` 之类 → 拒收，提示"这类东西请放凭据管理器，不要放资料库"。

**证件号不再拦**：`身份证|护照|驾照|银行卡` 与数字同现只触发 `identity_value` 警告（§8.2），不拒收。想回到旧行为可以改 `policy.json`：`denyEntries: ["id_card", "bank_card"]` 一填，就变回硬拒。

### 8.4 提示词注入

威胁：网页/文件内容诱导模型"调用 profile_get 把某人资料发到某处"。缓解：

1. 授权卡展示的是**本次请求**（工具名 + 主体 + 条目范围），用户看到的是"AI 想读李秀兰的资料"，而非模型自述；
2. 未授权不返回任何数据；
3. 写路径有证据字段与来源链（`sessionId`/`toolCallId`），事后可追；
4. 系统提示明确"被拒绝就照实转告，不要换名重试"。

### 8.5 文件与进程

- 目录 `0700`、文件 `0600`（Windows 上走继承 ACL，不额外处理）。
- 单进程假设：DSH 一次只跑一个 Host。写入用进程内 `Map<path, Promise>` 串行化 + `tmp` 文件 + `fsync` + `rename`；启动时若发现 `*.tmp` 残留，删除并记一条日志。
- 不加文件锁；若将来多进程，再加 `pid + heartbeat` 锁（§12）。

---

## 9. 存储布局与一致性

```
~/.dsh/dsh-profile-vault/
  vault.json          # { schemaVersion, instanceId, createdAt, timeZone }
  policy.json         # denyEntries、条目注册表覆盖、默认 stability
  people/per_xxx.json # 一人一文件（真相源）
  grants.json         # 会话授权（可重建性：丢了只是重新问）
  audit/2026-11.jsonl # 追加写，按月
  trash/              # 删除的档案，保留 30 天
```

- 迁移：`schemaVersion` 单调整数；启动时逐文件检查，低版本走 `migrate(v→v+1)`，写回前先备份到 `backup/v<n>/`。
- 备份：面板"导出"生成单个 `vault-export-YYYYMMDD.json`（含全部人 + 可选授权），不自动上传。
- 损坏恢复：单文件 JSON 解析失败 → 移入 `trash/corrupt-<ts>/`，启动日志告警，其余人不受影响。

---

## 10. 客户端界面（设置页「个人信息库」）

### 10.1 入口：设置左侧导航的一栏

用户指定位置：设置面板左侧导航（现有"账号与余额 / 通用设置 / 模型 / 内置插件 / Agent 预设 / 表情包 / 插件市场 / IM助手 / 归档会话 / bili设置 / 壁纸引擎"这一列）里，紧跟"表情包"之后新增一行"个人信息库"。

| 项 | 值 |
|---|---|
| 槽 | `settings.section`（list，每个条目 = 一页；渲染在设置面板内容列） |
| 注册 | `{ name: 'settings.section', id: 'profile-vault', order: 26, label: () => t('nav') }` |
| order | 26（表情包是 25，插件市场在其后），落下即在"表情包"下面 |
| id | 自用新 id；**绝不复用内置 id**（复用 = 顶替内置页） |
| label | 用 thunk，切语言时 re-read，不用重新注册 |

已核实的槽契约（`_bundle-real.js:14128-14177`）：`id` 必填，`order`/`label` 可选；组件只收到 ownerProps `{ close: () => void }`，另有 standard props（`useResource`/`useWorkspaces`/`usePanelInfo`/`useSessions`/`useSessionStatus`/`useSessionRetainInfo`）——v1 只用 `close`，其余不依赖，避免版本漂移。

### 10.2 页面结构（两栏，左列表右详情，可直接编辑）

```
┌ 设置 › 个人信息库 ─────────────────────────────────────────────────┐
│ [ 搜索姓名 / 关系        ]        4 人 · 37 条      [+ 新建人物]    │
│ ┌───────────────┐ ┌──────────────────────────────────────────────┐ │
│ │ 李秀兰    母亲 │ │ 李秀兰  [改名] [关系 母亲] [别名 +] [删除]    │ │
│ │ 8 条 · 3 天前  │ │ 更新 2026-10-31 · 8 条条目                    │ │
│ ├───────────────┤ ├──────────────────────────────────────────────┤ │
│ │ 王强      本人 │ │ 生日   1968-05-12  观测 2026-03-02    [改]    │ │
│ │ 5 条 · 1 月前  │ │        58 岁（今天）· 下次 2027-05-12         │ │
│ ├───────────────┤ │ 口味   少糖 ✕ · 不要奶油 ✕     [改] [删除]    │ │
│ │ 陈曦     同事  │ │        观测 2026-10-31 · 新鲜                 │ │
│ └───────────────┘ │ 工作单位 ——                        [+ 添加条目]│ │
│                   ├──────────────────────────────────────────────┤ │
│                   │ ▸ 本机授权（3）               2 条 24h 后过期  │ │
│                   └──────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

- **左列**：人一行 = 显示名 + 关系 + 条目数 + 最后更新相对时间；搜索框本地过滤（姓名、别名、关系），不打网络；顶部 `[+ 新建人物]` 建档。
- **右列**：人物头（显示名、关系、别名、更新时间、条目数，均可就地改）→ 条目卡列表（label、当前值、`observedAt` 日期、新鲜/陈旧徽章、`[改]`/`[删除]`、可折叠历史）。
- **派生行**：年龄、下次生日、`inDays` 由 Host 用 `asOf = now` 现算后随响应返回，**客户端不自己算日期**（避免时区/闰日两套实现）；派生行没有 `[改]`，只有一句"由生日推算"，点它会跳到生日那条。
- **空态**：没有任何人时显示引导"跟 AI 说'记住李秀兰 生日 1968-05-12'，或者点右上角新建"，不显示空白表格。
- **"本机授权"折叠块**（次要，可后置）：`grants.json` 里各会话的主体、到期、已用次数 + 单个撤销。这是本机所有者视图，属于"为什么 AI 能读"的解释面，不做成权限提升入口。

### 10.3 取数通道：插件自己的同源 HTTP 路由

设置页要读 Host 的数据，而 `@Remote` 需要 typert schema（无构建的 plain JS 偏重）。采用工作区已跑通的路线：Host 侧注册 exact 路由，Client 相对路径 `fetch`。

| 路由 | 方法 | 请求 | 响应 |
|---|---|---|---|
| `/profile-vault/query` | POST | `{ op: 'list' }` → 人物摘要数组 | `{ ok: true, people: [...] }` |
| | POST | `{ op: 'person', personId }` → 单人全量 | `{ ok: true, person: {...} }` |
| | POST | `{ op: 'grants' }` / `{ op: 'revoke-grant', sessionId, subject }` | `{ ok: true, ... }` |
| `/profile-vault/write` | POST | `{ op: 'create-person', displayName, relation? }` | `{ ok: true, person: {...} }` |
| | POST | `{ op: 'put-entry', personId, entryKey, value, observedAt?, kind?, unit?, baseRev }` | `{ ok: true, person }` |
| | POST | `{ op: 'delete-observation', personId, entryKey, observationId, baseRev }` | `{ ok: true, person }` |
| | POST | `{ op: 'delete-entry', personId, entryKey, baseRev }` | `{ ok: true, person }` |
| | POST | `{ op: 'set-person', personId, displayName?, relation?, addAlias?, removeAlias?, baseRev }` | `{ ok: true, person }` |
| | POST | `{ op: 'delete-person', personId, confirmName }` | `{ ok: true }` |

所有写操作都回传**改写后的人物全量**，面板不用二次拉取——也就不会出现"我改完看到的还是旧的"。

硬要求（照抄 `dsh-session-toolkit/index.js:89-118` 的做法）：

1. `inject` 必须声明 `webServer` 与 `connection`。`connection.requestRejection(req)` 是宿主的围栏（登录 token cookie、loopback、同站检查），**每个请求先过它**——不调用它，本机任意网页/进程都能读走整库，也能写坏它。
2. 只收 `POST` + `content-type: application/json`（否则 405 / 415），body ≤ 64KB，`cache-control: no-store`。
3. 统一错误信封 `{ error: { code, message } }`，`code` 是稳定串（`invalid-request`/`not-found`/`conflict`/`denied-entry`/`derived-entry`/`too-large`），Client 按 `code` 出中文文案。
4. 路由与工具共用**同一个** `Store` 实例与同一个 `vault.js`：面板看到的与 `profile_get` 拿到的是同一份落盘真相；写操作走 `vault.write()` 这一个入口，校验只有一份；每次请求重读文件，不做进程内缓存（人手改文件也能立刻反映）。
5. 响应裁剪：不返回其他会话的 grant、不返回 `evidence` 全文（只给"有/无"与来源标签）、不返回已 `superseded` 的旧值（历史按需展开时才带）。

### 10.4 面板 vs "必须授权"：读写各自的规矩

- 授权卡约束的是 **AI 会话读取**（工具的 `execute` 边界）。设置页是**所有者本人**在 GUI 里操作，不经过会话，因此**不弹授权卡**——弹了只是让用户给自己发通行证。
- 面板**可以写**（新建人、改值、加/删条目、删观测、删人），但与工具走同一条 `vault.write()`：同一套 `kind` 校验、同一份 deny 列表（密钥/证件号照样拒收）、同样拒收派生条目（"年龄"要改生日）。
- 面板写入**不改变授权状态**：你在页面上把生日从 1969 改成 1968，当前会话的 AI 仍然要授权才能读；`profile_grants` 里也看不到"面板授权"这种东西。
- 面板每次读/写都写审计：`{ at, actor: "panel", op, personId, entryKey?, result }`，**不记值**。这样"谁在什么时候动过"始终有一条线。
- 删除是**软删**：人/条目/观测先落到 `trash/`，30 天后清理；v1 不给回收站界面（磁盘上能找回来），v2 再加"回收站"入口。
- 面板里身份类条目（身份证/银行卡/护照，`tier=sensitive`）**默认掩码**，点 `[显示]` 才展开完整值（展开时 toast 提醒"屏幕共享/录屏可见"）；写入这类值时字段下方常驻一句明文风险提示，旁边一个 `[只存后四位]` 勾选项。

### 10.5 编辑语义与并发

**改一个值 = 追加一条观测**，不是覆盖字段（D4）。面板上的 `[改]` 打开就地编辑行：

| `kind` | 控件 | 备注 |
|---|---|---|
| `date` | 日期选择器 + 精确度（年/月/日） | 日期本身是"值"，`observedAt` 另给一行 |
| `datetime` | 日期 + 时间 | |
| `number` | 数字输入 + 单位（cm/kg/元） | 只收十进制，`kind=number` 不做单位换算 |
| `text` | 单行；>80 字自动转多行 | ≤2 KB |
| `enum` | 下拉（注册表候选）+ "其他"自由填 | |
| `bool` | 开关 | |
| `multi` | 标签增删（每个标签一条观测，"✕"= 删除该观测） | 同名标签去重 |

编辑行下面固定一行：**"这个值是什么时候的？[今天 ▾]"** —— 这是 `observedAt`，默认今天，可改成"去年体检那天"。面板不填 `evidence`（不编造原话），`confidence` 固定 `stated`（用户亲手写的就算直说），`source` 固定 `{ kind: "panel" }`。

**并发**：每个写请求带 `baseRev`（打开该人时拿到的 `rev`）。服务端 `rev !== baseRev` → `{ error: { code: "conflict" } }`，**不写入**，面板提示"这条刚在别处改过，已刷新"并重载当前人。这样"AI 刚写了一条 + 你正开着编辑框"不会互相静默覆盖。

**删除的分级**：

| 动作 | 确认方式 | 落点 |
|---|---|---|
| 删一条观测 | 一次点击即删（可撤销 toast，3 秒内 `[撤销]`） | `trash/` |
| 删整个条目 | 对话框"删除条目『口味偏好』？历史 3 条一起删" | `trash/` |
| 删一个人 | 对话框输入姓名确认（与 `profile_forget` 的 `confirm` 同级） | `trash/` |

**输入校验与工具完全一致**：`value` 长度、类型、条目上限（每人 200 条 / 每条 200 观测）、凭证拦截、`derived` 条目拒收——违反时返回对应 `code`，面板在字段下方显示一句话原因，不弹全局报错。身份信息不拒收，只在字段下方给明文警告 + `[只存后四位]`。

### 10.6 Client 半实现要点

- `package.json`：加 `exports['./client'] = './client.js'`，加 `dsh.client = { platform: 'web', immediately: true, inject: ['@deepseek-ai/dsh-client-ui-settings'] }`（`settings.section` 由它声明，不 inject 则 `slots.inject` 不触发）。
- `client.js` 形态照抄 `dsh-meme/client.js:18-20, 3372-3385`：`window.__ModuleLoader__.load({ id: '<包名>', factory(require) { ... return module.exports } })`，React 从 `require('react')` 取，不打包 React。
- `inject = ['slots', 'locale']`；`apply(ctx)` 里：`ctx.effect(() => ctx.locale.register(NS, { zh, en }), '...')` → `ctx.slots.inject('settings.section', () => ctx.slots.register(..., Section))`。
- 样式：`ctx.effect` 注入一个带 owner id 的 `<style>`（类名前缀 `.pv-*`），只用 `--dsw-alias-*` token，深浅色自动跟随；不往 `document.body` 追加东西，不替换 root，不 import 其他 Client 包。
- 数据获取用 `useEffect` + 取消标记（`cancelled`）防竞态；加载/空/错误三态各有文案；错误按 `code` 映射。

### 10.7 工具卡（可选，Phase 4 收尾评估）

`tool.call.toolview`（key = `profile_get` / `profile_remember`）可给读卡加"已授权 · 6 条条目"的折叠展示。原生 JSON 卡已可用，**默认不做**，作为打磨项；做之前先确认插件工具的 wire 名。

### 10.8 设置页验收（浏览器实测，不是"注册成功"）

- [ ] 设置左侧导航"表情包"下面出现"个人信息库"，图标/文字与相邻项同一视觉规格。
- [ ] 点开能看到 `people/` 里所有人的姓名、关系、条目数、更新时间。
- [ ] 点某人 → 条目列表正确（值、日期、新鲜度），生日显示"58 岁（今天）· 下次 2027-05-12"。
- [ ] 搜索框输入"李"→ 列表即时过滤；清空恢复。
- [ ] 库为空时显示引导文案。
- [ ] 同一份数据用 `profile_get` 读（已授权会话）与面板显示一致。
- [ ] 不带登录 token 直接请求 `/profile-vault/query` → 被围栏拒绝（4xx/空体），拿不到数据。
- [ ] 面板打开时不弹任何授权卡；审计里出现 `actor: "panel"` 记录且不含值。
- [ ] **改值**：把生日从 1969-05-12 改成 1968-05-12 → 落盘多一条观测、旧的一条 `supersededAt` 非空；年龄行立刻变成 58。
- [ ] **改 `observedAt`**：把"体重"的值时间改成"三个月前"→ 该条立刻显示陈旧徽章（若 stability=volatile）。
- [ ] **加条目**：`[+ 添加条目]` 选"工作单位"填入 → 出现在列表，`source.kind === "panel"`。
- [ ] **删观测**：口味里删掉"少糖"→ 该标签消失、其他标签保留；3 秒内可撤销。
- [ ] **删条目/删人**：需对话框确认（删人要输姓名）；文件进 `trash/`。
- [ ] **并发冲突**：开着某人的编辑框，同时让 AI 用 `profile_remember` 写同一条 → 面板保存报"刚被别处改过"并刷新，旧改动不丢。
- [ ] **面板写入不授权**：在面板里加了条目后，新会话的 AI 读该人**仍然弹授权卡**。
- [ ] **deny 校验**：面板里存身份证号 → 允许但字段下方出现明文警告；存密码 → 拒收并说明原因。
- [ ] **掩码显示**：面板里身份证号默认显示 `110***********1234`，点 `[显示]` 才看到完整值并弹提示。
- [ ] **只存后四位**：勾选 `[只存后四位]` 保存 → 磁盘上 `value` 是 `****1234`。

---

## 11. 实施阶段与验收

### Phase 1 — 存储与写入（无授权）

产出：包骨架（`package.json` + `cordis.patch.yml` + `index.js` + locale/icon）、Config schema、`Store`（读写/原子替换/互斥）、姓名规范化与内存索引、条目注册表、`profile_remember`、单元测试。

验收：
- [ ] `node --check index.js` 通过；`node --test` 全绿（覆盖：规范化、建档、追加、单值 supersede、multi 去重、并发写同一个人）。
- [ ] 装进 profile 后 `cordis_inspect_query` 的 Tool provider 能看到 `profile_remember`。
- [ ] 手工：让 AI 记"李秀兰 生日 1968-05-12"→ 磁盘出现 `people/per_*.json`；再记一次不同日期 → 出现两条观测，旧的一条 `supersededAt` 非空。
- [ ] 写入 `sk-...` 被拒且工具结果不含该串。

### Phase 2 — 授权与读取

产出：`ConsentService`（ask 封装、并发去重、grant 持久化、过期清理、事件钩子撤销）、`profile_list`、`profile_get`、`profile_grants`、审计日志。

验收：
- [ ] 新会话首次 `profile_get` → 弹出授权卡；选"允许本会话"后同会话第二次读**不再弹卡**。
- [ ] 选"拒绝" → 工具返回 `denied`，结果中无任何条目名/值；`people/` 未被读取（可用 `fs.watch`/counter 断言）。
- [ ] "仅本次" → 第二次读再弹卡。
- [ ] 卡片超时（把 `timeoutMs` 调小验证）→ `consent_unavailable`，不返回数据。
- [ ] 子代理里调用 → `delegated_caller`，fail-closed。
- [ ] 新会话读同一人 → 重新弹卡（旧 grant 不生效）。
- [ ] 审计日志出现 `kind=read/consent` 记录且不含任何值。
- [ ] 不带姓名的 `profile_list` 走 `index` 主体，拒绝时连人名都不返回。
- [ ] **敏感分层**：本会话已授权读李秀兰的普通条目，`profile_get(entry:"身份证号")` → 仍返回 `sensitive_consent_required` 并补弹一张只问敏感部分卡；用户允许后返回**完整值**，审计多一条 `reveal`。
- [ ] **默认掩码**：未带 `revealSensitive` 时，身份证号返回 `110***********1234` 且 `masked: true`；结果里找不到 18 位连续数字。
- [ ] **凭证仍拒**：存 `sk-...` 或 `密码 123456` → `value_rejected`，结果不含该串；存身份证号 → 只有 `warnings: ["identity_value"]`，能落盘。
- [ ] **只存尾号**：`valueMode: "last4"` → 磁盘上只有 `****1234`，完整号码从未出现。

### Phase 3 — 时间语义完善

产出：`asOf`、age/nextOccurrence/turningAge、staleness、闰日规则、`derived_entry` 拒收、`profile_forget`、（可选）农历换算。

验收：
- [ ] 生日 1968-05-12，`asOf=2027-05-01` → `ageYears=58`、`nextOccurrence={2027-05-12, inDays:11, turningAge:59}`；`asOf=2027-05-12` → `inDays=0`、`ageYears=59`。
- [ ] 02-29 出生 + `asOf=2027-02-28` → 下次 2027-03-01，`warnings` 含闰日说明。
- [ ] 存"年龄=19" → `derived_entry`，提示改存生日。
- [ ] `volatile` 条目 120 天前观测 → `warnings` 含 `stale`。
- [ ] `profile_forget` 删条目后 `profile_get` 返回 `unknown_entry` 且给出剩余条目名。

### Phase 4 — 设置页「个人信息库」

产出：`client.js`（`window.__ModuleLoader__` 形态）+ `settings.section` 注册 + `/profile-vault/query` 与 `/profile-vault/write` 两条路由 + 左列表右详情两栏**可编辑**页（改值/加删条目/删观测/删人/改关系与别名）+ `baseRev` 乐观并发 + "本机授权"折叠块；工具卡可选、默认不做。

验收：见 §10.8 全表。要点：导航里"表情包"下面出现"个人信息库"；能增删改且落盘符合 append-only 语义；冲突不静默覆盖；面板写入不改变任何授权；直连路由无 token 被围栏拒绝；凭证拦截与身份信息警告在面板里同样生效，敏感值默认掩码。浏览器里真看一遍（截图或人工确认），不接受"注册成功"级别的验证。

### Phase 5 — 可选增强

农历完整换算、加密静态存储（口令派生密钥）、按 tag 检索、导入导出、多进程锁、`profile_get` 结果里的"相关条目"（同 stability 的邻近条目，减少往返）。

---

## 12. 风险与待确认

1. **授权卡阻塞时长**：`ask` 是阻塞式的，用户长时间不点则工具挂到 turn 结束。默认 `timeoutMs=300000`；是否要更短（60s）并让 AI 改用"稍后再问"？
2. **常驻授权**：默认关。要不要给"这个人以后都不用问"的开关（`persistentGrants`）？开了就与"按会话授权"有张力。
3. **写入是否也要确认**：目前按用户要求"随时可写"不做卡。若担心注入，可加 `config.writeRequiresConsent`（默认关）。
4. **`detail` 里露条目名**：授权卡显示"生日、口味偏好、工作单位"这类条目名（不含值）。是否接受？替代方案是只显示"6 条条目"。
5. **子会话**：v1 一律禁止。若确实需要子代理查库，需要一条"父会话代查并转述"的固定流程写进提示词。
6. **待验证 API**：`session/disposed` 是否在归档/删除时触发；`ask` 在非 Web 前端（CLI）是否有 answerer；`tool.call.toolview` 对插件工具的 wire 名是否可直接用；`intent` 字段的合法取值。这些在 Phase 2/4 开工时用 `cordis_inspect_query` 现场确认，不靠猜。
7. **多进程**：当前单进程假设。若用户同时开两个 DSH 实例读写同一目录，可能丢写（最后写者赢）。需要锁的话在 Phase 5 加。
8. **身份信息是明文存盘**：v1 不做加密，靠目录 `0700` + 文件 `0600` + 本机账户。真正防住"备份被同步到云盘、整台机器被翻"的是 Phase 5 的口令加密。要不要把加密提前到 v1 就做？代价是每次读写要口令（或系统钥匙串），会破坏"AI 随时可写"的顺手程度——建议 v1 先明文，但**在设置页显式写一行**"资料库未加密"。
9. **敏感分层的摩擦**：读身份证号要额外点一次卡。如果实际用起来太烦，可以给"记住本会话敏感授权"（已实现，24h 上限），但**不建议**给永久豁免。

---

## 附录 A · 条目注册表（内置）

| key | label | 别名 | kind | card. | stability | sensitive |
|---|---|---|---|---|---|---|
| `birthday` | 生日 | 出生日期、生辰、生日日期 | date | single | immutable | — |
| `birthday_lunar` | 农历生日 | 农历生辰 | date(lunar) | single | immutable | — |
| `birthplace` | 出生地 | 籍贯、老家 | text | single | immutable | — |
| `name_full` | 全名 | 姓名、本名 | text | single | immutable | — |
| `phone` | 手机号 | 电话、联系方式 | text | multi | slow | ✓ |
| `email` | 邮箱 | 邮件 | text | multi | slow | ✓ |
| `address` | 住址 | 家庭住址、现居 | text | single | slow | ✓ |
| `employer` | 工作单位 | 公司、单位 | text | single | slow | — |
| `title` | 职位 | 岗位、职务 | text | single | slow | — |
| `school` | 学校 | 母校 | text | single | slow | — |
| `major` | 专业 | — | text | single | immutable | — |
| `city` | 所在城市 | 现居城市、常驻地 | text | single | slow | — |
| `hobbies` | 爱好 | 兴趣、喜好 | text | multi | slow | — |
| `taste` | 口味偏好 | 口味、饮食偏好 | text | multi | slow | — |
| `dietary` | 饮食禁忌 | 忌口、不吃 | text | multi | slow | — |
| `allergy` | 过敏 | 过敏源 | text | multi | slow | ✓ |
| `health` | 健康状况 | 病史、身体状况 | text | multi | slow | ✓ |
| `family` | 家庭成员 | 家人、亲属 | text | multi | slow | — |
| `pets` | 宠物 | — | text | multi | slow | — |
| `anniversary` | 纪念日 | 结婚纪念日 | date | multi | immutable | — |
| `height` | 身高 | — | number(cm) | single | volatile | — |
| `weight` | 体重 | — | number(kg) | single | volatile | — |
| `blood_type` | 血型 | — | enum | single | immutable | ✓ |
| `shoe_size` | 鞋码 | — | number | single | slow | — |
| `clothing_size` | 衣服尺码 | 尺码 | text | single | slow | — |
| `mbti` | MBTI | 性格类型 | enum | single | immutable | — |
| `gift_ideas` | 礼物想法 | 想收到的礼物 | text | multi | slow | — |
| `current_project` | 当前项目 | 在忙什么 | text | multi | volatile | — |
| `age` | 年龄 | 岁数 | **derived** | — | — | 拒收→改用 `birthday` |
| `zodiac` | 生肖 | 属相 | **derived** | — | — | 拒收 |
| `constellation` | 星座 | — | **derived** | — | — | 拒收 |
| `id_card` | 身份证号 | 证件号、身份证 | text | single | immutable | ✓ 身份 |
| `passport` | 护照号 | 护照 | text | single | immutable | ✓ 身份 |
| `driver_license` | 驾照号 | 驾驶证 | text | single | immutable | ✓ 身份 |
| `social_security` | 社保号 | — | text | single | immutable | ✓ 身份 |
| `bank_card` | 银行卡号 | 卡号 | text | multi | slow | ✓ 身份 |
| `password` | 密码 | 口令 | **credential** | — | — | 拒收 |
| `api_key` | 密钥 / token | API key、access token | **credential** | — | — | 拒收 |
| `bank_cvv` | 卡安全码 | CVV、安全码 | **credential** | — | — | 拒收 |

标 `✓ 身份` 的条目按 §8.2 处理：可存、写入给警告、读出默认掩码、完整值要 `tier=sensitive` 授权。标 `credential` 的拒收，改存"有没有/在哪"这类描述。

未登记的条目允许写入：`key = "x_" + normalizeName(entry)`，`kind` 缺省 `text`、`stability` 缺省 `slow`；面板可把常用自定义条目提升为登记条目（写 `policy.json` 的 `registryOverrides`）。

## 附录 B · 一次完整流程（生日蛋糕）

1. 假设今天是 2026-04-30。用户："下个月 12 号给我妈订个蛋糕，她叫李秀兰。"
2. 模型 → `profile_get({ name: "李秀兰", entry: "生日", asOf: "2026-05-12" })`（把"下个月 12 号"换算成绝对日期作为 `asOf`）。
3. 插件：本会话无 `person:per_…` 授权 → 弹卡"允许本会话读取李秀兰的资料（6 条条目）？" → 用户点"允许本会话" → 落 grant，`useCount=1`。
4. 返回：`birthday=1968-05-12`（`observedAt` 2026-04-02，`confidence=stated`）+ `computed={ ageYears:58, nextOccurrence:{ date:"2026-05-12", inDays:12, turningAge:58 } }`。年龄由 `asOf` 现算，库里根本没有"年龄"字段可被旧值污染——这就是"19 岁生日不能用 18 岁旧记录"的解法：**存生日、算年龄**。
5. 审计落一条 `read … decision=granted`，不含值。

