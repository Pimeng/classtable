# ClassTable Plugin

Miao-Yunzai 机器人课程表插件，支持 WakeUp 课程表导入。

## 如何安装？

方法1. Git安装

```bash
git clone --depth=1 https://github.com/Pimeng/classtable.git ./plugins/classtable
```

> 或者使用镜像
> ```bash
> git clone --depth=1 https://ghproxy.net/https://github.com/Pimeng/classtable.git ./plugins/classtable
> ```

克隆完毕后重启 Yunzai 就可以使用了

> 对的没有依赖，放到插件目录就能用（

方法2. 压缩包安装

直接下载压缩包然后解压到插件目录 `./plugins/classtable`（注意重命名为 `classtable`）
在右上方有个绿色的 `Code` 按钮，点击，然后选择 `Download ZIP`

## 功能特性

- 支持查看今日课表
- 支持群聊和私聊使用
- 支持导出课表

## 支持的应用

- Wakeup 课程表（已恢复，接着干来）

> [!CAUTION]
> 傻逼 Wakeup 课程表，你很有意思吗？为了不让别人用你的分享口令导入到其他的工具，你还做了这种傻逼的真实设备校验，你觉得非你不可了，就他妈加这么多广告，深色模式你也他妈的是会员专属，咋的你的AI是付费的啊？是100USD/1K Token吗？还有啊，天天弹窗要我强制更新，不更新就不给我用，你是全家死光光了吗？

- 拾光课程表：https://github.com/XingHeYuZhuan/shiguangschedule

## 使用方法

### 导入课表

#### Wakeup

1. 打开 WakeUp 课程表 APP
2. 点击右上角分享按钮
3. 复制完整的分享口令消息
4. 将分享口令消息发送给机器人（群聊或私聊）
5. 机器人会自动识别并导入课表

#### 拾光课程表

文件导出之后发给Bot即可（

## 适配器兼容

插件同时支持两类后端，用户标识与头像来源完全不同，`utils/identity.js` 负责抹平差异：

| | ICQQ / OneBot（Miao-Yunzai 默认） | QQ 官方机器人（QQBot-Plugin / TRSS） |
| --- | --- | --- |
| 用户 ID | QQ 号，如 `123456` | `{self_id}:{member_openid}` |
| 昵称 | `member.card` → `member.nickname` | `member.user_name` |
| 头像 | `member.avatar`，兜底 `q1.qlogo.cn/g?b=qq&nk={QQ号}&s=100` | `q.qlogo.cn/qqapp/{appid}/{openid}/{size}` |
| @ 提醒 | 原生 at 段 | markdown 的 `<qqbot-at-user id="openid" />` |

几点说明：

- 官方 bot 的头像是直链拼接，**不需要调用任何接口**，也不受群成员接口白名单（错误码 `11253`）影响，尺寸只支持 `0 / 100 / 640`。
- 官方 bot 的群消息纯文本不渲染 `<@id>`，只传 at 段会被适配器降级成可见文本「@昵称」。因此 `@上课提醒` 在官方 bot 下改走 markdown；若平台拒收 markdown，适配器会自动剥成纯文本重发，不会整条失败。
- 昵称只来源于收到过的消息（适配器的事件缓存 `gml`），没在群里发过言的成员查不到昵称，会退化成 `用户{openid}`、头像用占位图。



### 文件导入的适配器差异

`#导入课表` 之后发 JSON 文件，取下载地址的字段各适配器不统一，`apps/import.js` 依次尝试：

1. file 段里的公网直链（`file` / `url` / `data.url`）——部分适配器（如 QQ 官方 bot）直接给地址，不需要换链；
2. `e.file.fid`（Miao 核心从 OneBot 的 file 段提取），以及段里的 `fid` / `file_id` / `fileId` / `id`，交给 `getFileUrl()` 换直链。

此外不需要先发 `#导入课表`：文件名匹配 `classtable-*`、`shiguang*`，或名字里含「课表」/`schedule` 的 `.json` 会自动导入。

> 上下文等待（`setContext`）的 key **必须等于处理函数的函数名**：loader 是按 `plugin[fnc](context[fnc])` 调用的，且传入的是当时那条旧事件，当前消息要读 `this.e`（参见 `apps/export.js` 的 `confirmExportSchedule`）。

#### 拾光导出的真实 schema

拾光 App 导出的课程**不存具体时分**，`customStartTime` / `customEndTime` 在 `isCustomTime` 为 `false` 时是 `null`：

```json
{
  "courses": [{ "name": "…", "day": 1, "startSection": 13, "endSection": 13, "weeks": [7],
                "isCustomTime": false, "customStartTime": null, "customEndTime": null, "position": "…" }],
  "timeSlots": [{ "number": 13, "startTime": "21:10", "endTime": "21:55" }],
  "config": { "semesterStartDate": "2026-08-31", "semesterTotalWeeks": 20 }
}
```

时间必须靠 `startSection` / `endSection` 回 `timeSlots` 里按 `number` 查。导入顺序为：自定时间 → 节次查表 → `course.startTime/endTime` 兜底。注意 `detectScheduleFormat` 与 `convertShiguangToInternal` 必须对同一份数据用同一套假设，否则会出现「识别为拾光却一门课都解析不出」。
### @上课提醒的适配器差异

@提醒的触发依赖「本条消息里 @ 了谁」，两种后端给出的形态完全不同：

| | ICQQ / OneBot | QQ 官方 bot |
|---|---|---|
| 被 @ 的人 | `e.message` 里的 `{ type: "at", qq }` 段 | **不在 `message` 段里** |
| `qq` 的形态 | QQ 号 | `member_openid`（适配器已剥掉 `{self_id}{sep}` 前缀） |
| 只发一个 @ 时 | 仍是一个 `at` 段 | **`e.message` 是空数组** |
| 真正的来源 | `e.message` | `e.raw.mentions`（`qq-official-bot` 的 `payload.mentions`） |

官方 bot 的 `<@!openid>` 由 SDK 的 `parseMessage` 还原成 `at` 段，但适配器的
`buildMiaoEvent` 只映射 `e.message`，而 QQ 官方在「整条消息只有一个 @」时不会给出可解析的正文，
于是 `message` 直接是空的——这正是官方机 @ 正在上课的人没有反应的原因。

所以 `apps/check.js` 按三条路依次取被 @ 的人，取到即用：

1. `e.message` 里的 `at` 段（ICQQ / OneBot）；
2. `e.raw.mentions`（官方 bot 的原始事件，适配器里 `raw: event`，会一直传到插件）；
3. `e.raw_message` 里的 `<@!openid>` 占位符兜底。

`is_you` 为真的 mention 表示 @ 的是机器人自己，直接跳过；`all` / `everyone` 同样跳过。

#### CD 行为

`classtable:isreminded:{storedUserId}` 是**按「一节课」**记的，不是固定冷却：

- TTL = 距该节课 `endTime` 的剩余秒数，下课那一刻自动失效，下一节重新提醒；
- key 里**只有用户 id**，不含群号——同一节课跨群共享一次提醒；
- 只有真的回复出去之后才写 key，前面任何一步提前 return（没课表 / 当前没在上课 / 正在翘课）都不占 CD；
- 连堂会合并（`utils/time.js`，同名课间隔 ≤30 分钟），CD 覆盖到最后一节下课。

