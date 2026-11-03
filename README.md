# dsh-profile-vault

给 DSH 用的个人信息库：以姓名为主索引存人，以「姓名 + 条目」取具体数据；**读取必须先经当前会话的用户授权**，被拒绝时连数据目录都不会打开。设置里多一个「个人资料」页，可以像通讯录一样浏览、修改、删除，敏感信息默认只给掩码。

## 安装

从插件市场装：设置 → 插件市场，搜 `profile` 或 `QqiqiQ/dsh-profile-vault`，点安装。

命令行也等价（走 Release 里的预构建包）：

```powershell
dsh plugin --profile web add "https://github.com/QqiqiQ/dsh-profile-vault/releases/latest/download/dsh-profile-vault.tgz"
```

改源码想立刻生效，就把 checkout 目录直接装进 profile（DSH 读 `dsh.bundle.patch` 插入 `profile-vault` 这一项）：

```powershell
dsh plugin --profile web add "D:/path/to/dsh-profile-vault"
```

装完**重启 DSH**：插件在安装那一刻加载进内存，改文件不会热更新。重启后打开设置 → 左侧导航「个人资料」（在「表情包」下面）。

数据落在 `~/.dsh/dsh-profile-vault/`（Windows 是 `C:\Users\<你>\.dsh\dsh-profile-vault\`）。**v1 不加密**，页面顶部会常驻提示。

## AI 侧的工具

| 工具 | 作用 | 需要授权 |
| --- | --- | --- |
| `profile_remember` | 给某人加条目 / 加值 / 改关系 / 加别名；人不存在时可顺手建 | 否（但会拦密码类、拒收年龄这类派生值） |
| `profile_list` | 看资料库里有哪些人 | 是（按索引授权；只回姓名与条目数） |
| `profile_get` | 取某人的条目值，可指定 `entry`、`asOf`、`includeHistory` | 是（按人授权；敏感条目另需敏感授权） |
| `profile_forget` | 删条目 / 删单条观测 / 删整个人（要 `confirm: true` 或重输姓名） | 否 |
| `profile_grants` | 列出现在有哪些会话授权、撤销 | 否 |

授权卡是三档：**允许本会话**（24 小时或会话结束失效，可随时在设置页撤销）、**仅本次**、**拒绝**。拒绝、超时、没有可问的人（比如子会话）都按失败关闭处理，不会读到任何数据。

## 时间语义（为什么生日不会被记成旧年龄）

条目里存的不是「年龄」，而是「生日」这个事实，外加每次观测的时间：

- `observedAt`：这个值是什么时候为真的（AI 填，用户可说「上个月量的」）。
- `recordedAt`：插件写入的时刻（自动）。
- 返回时带 `ageDays` / `warnings`：`身高`、`体重`、`当前项目` 超过 90 天、`手机号`、`住址` 这类超过 365 天会提示「先向本人确认」。`生日`、`血型` 这类不随时间变的不提示。

`profile_get` 支持 `asOf`：给个过去的日期就能复原「那天他几岁」。年龄、生肖、星座、下次生日都是查询时现算的，不落盘，所以订十九岁蛋糕不会拿到十八岁的记录。

## 隐私

- 三档：普通条目正常；**身份类**（身份证、护照、银行卡、手机号、住址、健康、过敏）允许存，但写入时给警告，读出默认掩码（`110***********1234`），要看完整值必须 `tier=sensitive` 单独授权；**凭证类**（密码、API key、CVV、私钥）直接拒收。
- 授权按 `(会话, 主体, 敏感层级)` 记，**不跨会话**；会话结束（`session/disposed`）时该会话的授权全部作废。
- 审计日志 `audit/YYYY-MM.jsonl` 只记「谁在什么时候读了/写了哪个人哪个条目」，不记值。
- 不把资料塞进系统提示词，只在你明确问到时经工具结果返回。

## 设置页

左栏是人，右栏是这个人的条目卡：

- 改姓名、关系、别名；加条目（支持内置条目名，也支持自定义名字）；改值（会作为新观测追加，旧值留作历史）。
- 多值条目（邮箱、手机号、爱好…）把所有值分行列出，每行可单独「改」（原地改写，不新增记录）或「删」；编辑表单就在按钮旁边展开，不在页面顶部。
- 每条都能看历史、删单条观测（3 秒内可撤销）、删条目。
- 删整个人要把姓名原样再输一遍。
- 底部「AI 读取授权」列出当前有效的授权，可逐条撤销。
- 并发改了同一个人会报「版本冲突」并刷新，不会互相覆盖。

## 开发

```powershell
cd dsh-profile-vault
npm test                     # 29 个测试：规范化/年龄/闰日/掩码/追加/多值改写/并发/授权/路由 + 工具层 + 设置页冒烟
node --check index.js
```

`node --test test/` 在受限沙箱下会因 spawn EPERM 失败，直接跑文件即可（`npm test` 就是这么配的）。

## 结构

```
index.js        Host 插件：5 个工具、2 条路由、会话结束撤权、4 行提示词规则
client.js       设置页（零依赖，React.createElement，无构建）
lib/ops.js      读写核心（追加-取代、上限、自定义条目、乐观并发）
lib/store.js    原子写 + 按文件串行 + 损坏隔离
lib/grants.js   授权闸门（会话授权、去重、TTL、撤销）
lib/read.js     展示层（掩码、现算年龄、新鲜度警告）
lib/routes.js   设置页的 POST /profile-vault/{query,write}
lib/registry.js 内置条目表（键、类型、基数、稳定性、敏感层级）
lib/time.js     日期解析、闰日、年龄、下次发生
lib/values.js   值规整、掩码、凭证/身份识别
lib/names.js    姓名规范化与别名匹配
test/           不依赖宿主的测试（库、工具层、设置页冒烟）
```

DESIGN.md 是完整设计（决策、数据模型、授权状态机、验收清单）；IMPLEMENTATION.md 是实施记录（文件职责、与设计的偏差、踩过的坑、重启后的验收步骤）。


