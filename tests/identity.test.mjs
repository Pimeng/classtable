import assert from "node:assert/strict"
import {
  stripInstancePrefix,
  getGroupMemberMap,
  resolveMember,
  resolveUserName,
  resolveAvatarUrl,
  buildAtSegment,
  buildMentionMessage,
  isBotSelfOrAll,
  isOfficialBot,
  userIdCandidates,
} from "../utils/identity.js"

/**
 * 这些断言把两种适配器的 id 形态固定下来，改兼容层时直接 `node tests/identity.test.mjs` 跑一遍。
 */

const OPENID = "036A18653B0C823134BC4B6682B207C4"

/* ---------- ICQQ / OneBot ---------- */
const icqqMember = { card: "小明的群名片", nickname: "小明", avatar: "" }
const icqq = {
  self_id: "12345",
  group_id: "98765",
  bot: {
    uin: "12345",
    gml: new Map([["98765", new Map([[67890, icqqMember]])]]),
    fl: new Map(),
  },
}

assert.equal(isOfficialBot(icqq), false, "ICQQ 不应被识别为官方 bot")
assert.equal(getGroupMemberMap(icqq), icqq.bot.gml.get("98765"), "裸群号应能取到 gml")
assert.equal(resolveMember(icqq, "67890"), icqqMember, "ICQQ: 数字 key 应命中")
assert.equal(resolveMember(icqq, 67890), icqqMember, "ICQQ: 数字入参应命中")
assert.equal(resolveUserName(icqq, "67890"), "小明的群名片", "ICQQ: 昵称应取群名片")
assert.equal(
  resolveAvatarUrl(icqq, "67890", null, 100),
  "https://q1.qlogo.cn/g?b=qq&nk=67890&s=100",
  "ICQQ: 无 avatar 时应回退 qlogo"
)
icqqMember.avatar = "https://q1.qlogo.cn/g?b=qq&nk=67890&s=640"
assert.equal(resolveAvatarUrl(icqq, "67890"), icqqMember.avatar, "ICQQ: 有 avatar 时优先用它")
icqqMember.avatar = ""

/* ---------- QQ 官方机器人 ---------- */
const qqbotGroupKey = "1903614108:GROUPOPENID"
const qqbotMemberKey = `1903614108:${OPENID}`
const qqbotMember = { user_name: "阳光小助手", member_role: "member", user_id: qqbotMemberKey }
const qqbot = {
  self_id: "1903614108",
  group_id: qqbotGroupKey,
  // 发言人不是被 @ 的人，走 gml 分支
  sender: { user_id: "1903614108:OTHEROPENID", nickname: "别人" },
  bot: {
    uin: "1903614108",
    info: { appid: "1903614108" },
    gml: new Map([[qqbotGroupKey, new Map([[qqbotMemberKey, qqbotMember]])]]),
    fl: new Map(),
  },
}

assert.equal(isOfficialBot(qqbot), true, "官方 bot 应被识别")
assert.equal(getGroupMemberMap(qqbot), qqbot.bot.gml.get(qqbotGroupKey), "带前缀群号应能取到 gml")
assert.equal(resolveMember(qqbot, qqbotMemberKey), qqbotMember, "官方 bot: 带前缀 key 应命中")
assert.equal(resolveMember(qqbot, OPENID), qqbotMember, "官方 bot: 裸 openid 也应命中")
assert.equal(resolveUserName(qqbot, qqbotMemberKey), "阳光小助手", "官方 bot: 昵称应取 user_name")
assert.equal(
  resolveAvatarUrl(qqbot, qqbotMemberKey, null, 100),
  `https://q.qlogo.cn/qqapp/1903614108/${OPENID}/100`,
  "官方 bot: 头像应走 qqapp 直链"
)
assert.equal(
  resolveAvatarUrl(qqbot, OPENID, null, 640),
  `https://q.qlogo.cn/qqapp/1903614108/${OPENID}/640`,
  "官方 bot: 640 尺寸应保留"
)
assert.equal(
  resolveAvatarUrl(qqbot, OPENID, null, 999),
  `https://q.qlogo.cn/qqapp/1903614108/${OPENID}/100`,
  "官方 bot: 非法尺寸应回退 100"
)
assert.equal(stripInstancePrefix("1903614108", qqbotMemberKey), OPENID, "应剥掉实例前缀")
assert.equal(stripInstancePrefix("1903614108", OPENID), OPENID, "无前缀应原样返回")

/* @ 判定 */
assert.equal(isBotSelfOrAll(qqbot, "1903614108"), true, "@机器人自己应被跳过")
assert.equal(isBotSelfOrAll(qqbot, qqbotMemberKey), false, "@群友不应被跳过")
assert.equal(isBotSelfOrAll(qqbot, "all"), true, "@全体成员应被跳过")
assert.equal(isBotSelfOrAll(icqq, "12345"), true, "ICQQ: @机器人自己应被跳过")
assert.equal(isBotSelfOrAll(icqq, "67890"), false, "ICQQ: @群友不应被跳过")

/* 群成员缓存缺失时回退到 sender（官方 bot 的 gml 未必收录发言人） */
const lonely = {
  self_id: "1903614108",
  group_id: qqbotGroupKey,
  sender: { user_id: qqbotMemberKey, nickname: "阳光小助手" },
  bot: { uin: "1903614108", info: { appid: "1903614108" }, gml: new Map(), fl: new Map() },
}
assert.equal(resolveUserName(lonely, qqbotMemberKey), "阳光小助手", "应回退到 sender 昵称")

/* @ 的对象就是发言人本人时，sender 优先于 gml（与 QQBot 适配器 atDisplayName 的查找顺序一致） */
const selfAt = {
  self_id: "1903614108",
  group_id: qqbotGroupKey,
  sender: { user_id: qqbotMemberKey, nickname: "发言时的昵称" },
  bot: {
    uin: "1903614108",
    info: { appid: "1903614108" },
    gml: new Map([[qqbotGroupKey, new Map([[qqbotMemberKey, qqbotMember]])]]),
    fl: new Map(),
  },
}
assert.equal(resolveUserName(selfAt, qqbotMemberKey), "发言时的昵称", "@ 发言人本人时应取 sender")

/* 被 @ 的是别人时仍然取 gml，不能被 sender 覆盖 */
assert.equal(resolveUserName(qqbot, qqbotMemberKey), "阳光小助手", "被 @ 的是别人时应取 gml")

/* 完全取不到时不应抛异常，也不应产出裂图 */
const bare = { self_id: "1", group_id: "2", bot: { uin: "1", gml: new Map(), fl: new Map() } }
assert.equal(resolveMember(bare, "999"), null)
assert.equal(resolveUserName(bare, "999"), "用户999")
assert.equal(
  resolveAvatarUrl(bare, "999"),
  "https://q1.qlogo.cn/g?b=qq&nk=999&s=100",
  "非官方 bot + 纯数字 id 应按 QQ 号拼 qlogo"
)
assert.ok(
  resolveAvatarUrl(bare, OPENID).startsWith("data:image/svg+xml"),
  "非数字 id 且没装官方 bot 时应给内联占位图"
)
assert.equal(typeof resolveAvatarUrl({ group_id: "1" }, "1"), "string", "e.bot 缺失也不能抛")

/* at 段形状：两种适配器都读 { type, qq } */
assert.deepEqual(buildAtSegment("67890"), { type: "at", qq: "67890" })
assert.deepEqual(buildAtSegment(qqbotMemberKey, "阳光小助手"), {
  type: "at",
  qq: qqbotMemberKey,
  name: "阳光小助手",
})
assert.equal(buildAtSegment(""), null)

/* 落盘用的 id 候选：运行时带前缀 → 裸 openid 也要能回退（本机历史数据就是裸 openid） */
// Windows 上 QQBot 适配器的前缀分隔符不是 ":"，候选里会多一个不可见的 U+F03A 变体，
// 断言时按语义过滤掉，单独校验它确实存在
const withoutAltSep = (ids) => ids.filter((id) => !id.includes("\uf03a"))

assert.deepEqual(
  withoutAltSep(userIdCandidates(qqbot, qqbotMemberKey)),
  [qqbotMemberKey, OPENID],
  "带前缀 id 应同时给出裸 openid 作为候选"
)
assert.deepEqual(
  withoutAltSep(userIdCandidates(qqbot, OPENID)),
  [OPENID, qqbotMemberKey],
  "裸 openid 应同时给出带前缀写法作为候选"
)
assert.ok(
  userIdCandidates(qqbot, qqbotMemberKey).includes(`1903614108\uf03a${OPENID}`),
  "Windows 分隔符变体也要给出，否则 Windows 上的 QQBot 适配器查不到"
)
assert.equal(userIdCandidates(icqq, "67890")[0], "67890", "ICQQ: 原样 id 必须排在第一位")
assert.deepEqual(userIdCandidates(null, "abc"), ["abc"], "没有 e 时不能抛，原样返回")
assert.deepEqual(userIdCandidates(qqbot, ""), [], "空 id 返回空数组")

/* @ + 正文 的适配器分流 */
const officialMention = buildMentionMessage(qqbot, qqbotMemberKey, "阳光小助手", " 正在上《高数》课哦~")
assert.ok(Array.isArray(officialMention), "官方 bot 应返回消息段数组")
assert.equal(officialMention.length, 1, "官方 bot 应合成单条 markdown，避免拆成两条")
assert.equal(officialMention[0].type, "markdown")
assert.equal(
  officialMention[0].data.content,
  `<qqbot-at-user id="${OPENID}" /> 正在上《高数》课哦~`,
  "官方 bot 的 markdown 里要用裸 openid，且不能带实例前缀"
)
assert.ok(!officialMention[0].data.content.includes("1903614108:"), "openid 不能残留实例前缀")

const icqqMention = buildMentionMessage(icqq, "67890", "小明的群名片", " 正在上《高数》课哦~")
assert.deepEqual(icqqMention, [
  { type: "at", qq: "67890", name: "小明的群名片" },
  " 正在上《高数》课哦~",
])

/* openid 不可用时不能拼出畸形 mention，退回 at 段 */
const weird = buildMentionMessage(
  { ...qqbot, sender: undefined },
  "1903614108:not a valid openid!",
  "某人",
  " 正文"
)
assert.equal(weird[0].type, "at", "openid 非法时应退回 at 段")

console.log("identity.js: 全部断言通过")
