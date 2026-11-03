# 实施记录（dsh-profile-vault）

写于 2026-11-03，10:15–11:25 之间经过 3 轮「改文件 → 重启 DSH」循环。

**真机验证结论（2026-11-03 15:22，第 3 次重启后）**：写入、读取、授权全链路通。
- `profile_remember` 写 `自检临时 · 生日 = 1990-01-01` → `已记录 … 现算：36 岁；下次生日 2027-01-01（届时 37 岁）`，落盘 `people/per_01M6G3YE7VNN83SKBG8HHE2ADN.json`。
- `profile_get` 弹授权卡 → 选「仅本次」得 `decision:"once"`；再调选「允许本会话」→ `grants.json` 落一条 `{subject:{type:'person',key:'name:自检临时'},tier:'normal',scope:'session',expiresAt:+24h}`，`useCount/lastUsedAt/revokedAt` 齐全。
- `profile_get` 带 `asOf: '2027-01-01'` → 返回 `现算：37 岁；下次 2027-01-01（就是今天，届时 37 岁）`，说明按 asOf 现算正确。

之后又修了两处**渲染**问题（已改文件，等下次重启生效）：
1. `change:'unchanged'` 时 `added` 为空，`renderRemember` 拼出「生日 = 」空值。→ 结果里新增 `value`（当前值），渲染回退到它，文案改为「没有变化」。
2. `asOf` 是 UTC ISO，`slice(0,10)` 把 `2027-01-01` 显示成 `2026-12-31`。→ `viewPerson` 新增 `asOfText`（本地日历日），渲染优先用它。

## 1. 文件清单

| 文件 | 职责 |
| --- | --- |
| `index.js` | Host 插件入口：5 个工具、2 条 HTTP 路由、`session/disposed` 撤权、4 行提示词规则（`system-prompt/assemble`） |
| `client.js` | 设置页「个人资料」面板（零依赖，`React.createElement`，无构建） |
| `lib/ops.js` | 读写核心：建人、追加观测、取代旧值、删观测/条目/人、vault 级写串行 |
| `lib/store.js` | 一人一文件、原子写（tmp→fsync→rename）、按文件串行、损坏文件隔离到 trash |
| `lib/grants.js` | 授权闸门：会话授权、并发去重、TTL、撤销、使用计数 |
| `lib/read.js` | 展示层：掩码、现算年龄/下次生日、新鲜度警告、历史 |
| `lib/routes.js` | 设置页数据通道 `/profile-vault/{query,write}` |
| `lib/registry.js` | 内置条目表（键/类型/基数/稳定性/敏感层级）与派生值拒收 |
| `lib/values.js` | 值规整、掩码、尾号、凭证/身份识别 |
| `lib/names.js` | 姓名规范化、别名匹配、重名判定 |
| `lib/time.js` | 日期解析、闰日、年龄、下次发生、新鲜度 |
| `lib/ids.js` | ULID 生成（`per_` / `obs_` / `grant_`） |
| `test/vault.test.mjs` | 15 个：规范化、年龄、闰日、新鲜度、掩码、登记表、追加-取代、自定义条目不分叉、并发写、授权、路由 |
| `test/tools.test.mjs` | 7 个：工具层（参数、拒收、授权弹卡、confirm、输出字段、unchanged 回显、输出 schema 保持宽松） |
| `test/client.smoke.test.mjs` | 1 个：设置页冒烟（假 React + 假 fetch，点选一个人并渲染掩码值） |

`npm test` 一次跑完 23 个。

## 2. 实现中与设计稿的偏差

1. **写入不加授权卡**（设计 D9）：`profile_remember` 不收授权，但拦凭证、拒收派生值、身份类给警告。删除要授权。
2. **面板写入不走授权**：面板是用户本人在看自己的资料；它和工具用同一套 `vault.*` 校验，只是 `source.kind='panel'`，并在审计里记 `actor:'panel'`。
3. **敏感三档落地**（D12）：`credential` 拒收；`identity` 可存、写入警告、读出掩码、完整值需 `tier=sensitive` 授权 + `revealSensitive`；`valueMode:"last4"` 只存 `****1234`。
4. **明文存储**：按用户拍板（m00327「明文形式。开工」）不加密，`vault.json` 记 `encrypted:false`，面板顶部常驻提示。
5. **子会话一律不允许**：没有 answerer 时 `consent_unavailable`，由父会话查完转述。

## 3. 关键实现细节

- **授权闸门在工具执行边界**：`profile_get`/`profile_list`/`profile_forget` 先 `consent.authorize()`，不通过就直接返回，`store.ensure()` 都没机会跑。
- **授权键**：`${sessionId}|${subject.type}:${subject.key}:${tier}`；主体是 `id:<personId>` 或 `name:<normalized>` 或 `index`。同一 `(会话,主体,tier)` 的并发请求共用一个 Promise（只弹一次卡）。
- **会话结束撤权**：`ctx.on('session/disposed', ...)` → `consent.revokeSession(sessionId)`。
- **写串行**：`lib/ops.js` 顶层的 `withVaultLock` 把 6 个写方法包起来（`locked()`）。原因：每个写操作是「读快照 → 改 → 写回」，store 的 per-file 锁只保证写入原子，不保证快照不旧；工具调用和面板点击同时发生会互相覆盖。
- **单值追加-取代**：新值不覆盖旧值，旧观测标 `supersededAt`/`supersededBy`；相同值不重复写（`change:'unchanged'`）；`supersededKept=20` 之后修剪最旧的被取代观测。
- **派生值不落盘**：`年龄/生肖/星座` 在登记表里标 `derived_entry` 拒收；年龄、下次生日由 `viewEntry` 用 `asOf` 现算，附 `approximate`、`leap-day` 警告。
- **乐观并发**：面板写带 `baseRev`，`guardRevision` 比对 `person.rev`，不一致返回 `conflict`（HTTP 409）+ 当前 `rev`。
- **HTTP 守卫**：每条请求先 `connection.requestRejection(req)`（未带凭证的本地请求实测 401），再查 `POST` + `application/json` + 体 ≤256KB。

## 4. 踩到并修掉的坑（值得记下来）

1. **`output.schema` 会被宿主在调用时校验，而且校验发生在写入之后**：两次真机报错——
   `"value.person" is not a declared property`（schema 用了 `additionalProperties:false`）、
   `"value.added" must be a number`（`added` 实际是观测数组，我按数字声明了类型）。
   两次都是**数据已经落盘**、只是返回值被判死。修法（最终形态）：`resultSchema()` 只保留字段名、**不声明任何类型**，并额外允许未知字段；`test/tools.test.mjs` 里断言「每个字段的 schema 是空对象 `{}`」，防止以后又手贱加类型。工具参数 schema 仍然严格关闭。
   教训：宿主对 return value 的校验是硬失败，值描述错一个字就是一次「工具坏了」；工具是给人用的，宁可放宽。
2. **可空字段别写 `type:'object'`**：首次写入 `previous`/`computed` 是 `null`，类型校验不认。
3. **`node --test test/` 在受限沙箱里 spawn EPERM**：test runner 对每个文件起子进程，沙箱不允许命名管道。改成直接跑文件，`npm test` 就是串行跑三个文件。
4. **`??` 会把 `immutable: null` 吃掉**：`STALE_DAYS[stability] ?? STALE_DAYS.slow` 让「不随时间变」的生日按 365 天判成 stale。改成 `hasOwnProperty` 判断。
5. **设置页槽位组件要传函数本体**：`slots.register(props, () => h(Panel))` 会多一层包装；直接传 `Panel`，冒烟测试才点得进去。
6. **`<style>` 必须带归属标记**：`data-plugin="dsh-profile-vault"`，否则会被宿主的模块系统认领并在热重载时删掉。
7. **别用 PowerShell 的 `Set-Content` 批量改中文源码**：它按控制台代码页读写，把测试文件里的中文全变成 `�`（17 处 + 7 处），只能逐行重写救回来。改文件用编辑工具，或用 Node 读写并显式指定 `utf8`。
8. **宿主插件与工具都只在启动时加载**：改 `index.js` 后必须重启 DSH；HMR 只对 Client 侧生效。所以一次改完再重启，别边改边试。

## 5. 重启后的验收清单

1. 重启 DSH（Host 插件与工具表都是启动时加载的，改完 `index.js` 必须重启）。
2. 打开设置 → 左侧「个人资料」（在「表情包」下面）。应看到：提示条「资料以明文保存在本机……」、左栏「人物 1/1 自检临时」。
3. 点「自检临时」→ 右栏显示「生日 1990-01-01」，无 stale 警告（生日是 immutable），有「36 岁」和「下次生日」。
4. 顺手删掉这条自检数据：「删除这个人」→ 输入姓名 `自检临时` → 确认。它是我装完插件做真机自检留下的，删了才干净。
5. 新建一个人、加一条条目、改一次值，确认：旧值进历史、`显示历史` 能看到、刷新后仍在。
6. 让 AI 调 `profile_list`（不带姓名）→ 应弹出授权卡（三档：允许本会话 / 仅本次 / 拒绝）；选「允许本会话」后同一会话再查不再弹；底部「AI 读取授权」里能看到这条授权并可撤销。
7. 查身份证号：默认显示 `110***********1234`；「显示敏感值」应触发一次敏感授权（工具侧则是 `revealSensitive: true`）。

## 6. 遗留 / 待确认

- vault 里现有 1 条真机自检数据（`people/per_01M6G3YE7VNN83SKBG8HHE2ADN.json`，「自检临时」，生日 1990-01-01）。沙箱不允许我越界写 `~/.dsh`，要删只能在面板里删，或让我调 `profile_forget`（会弹一次授权卡）。
- `grants.json` 里有 1 条对应授权（`subject.key = name:自检临时`，session scope，24h 到期）。删人后这条授权仍在，到期或 `session/disposed` 时自动失效；也可以在面板「AI 读取授权」里手动撤销。
- `lib/read.js` 的 `describeValue` 目前没被 `index.js` 用（render 里手写了行），留着给以后复用。
- 5 个工具都声明 `isConcurrencySafe: () => true`；正确性由 vault 级写串行兜底，不是靠运行时串行。
- `settings.section` 的组件 props 只用到无参形式；如果以后要拿 `close`，从 props 里取即可。
- 授权卡超时 5 分钟（`consentTimeoutMs=300000`，工具 `timeoutMs` 再 +30s）；按 `ASK_ABORTED` 走 `consent_unavailable`。
