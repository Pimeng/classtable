/**
 * 身份 / 展示信息兼容层
 *
 * 同一份课表要同时跑在两种完全不同的适配器上，两者的用户标识不是一回事：
 *
 *   ICQQ / OneBot（Miao-Yunzai 默认）
 *     user_id = QQ 号（"123456"），e.bot.gml 的成员 key 是 Number
 *     头像     = member.avatar，兜底 https://q1.qlogo.cn/g?b=qq&nk={QQ号}&s=100
 *
 *   QQ 官方机器人（Elia-Yunzai 的 QQBot-Plugin / TRSS-QQBot）
 *     user_id = `{self_id}{sep}{member_openid}`，gml 的成员 key 是同款带前缀字符串
 *     头像     = https://q.qlogo.cn/qqapp/{appid}/{member_openid}/{size}（0/100/640，无需任何接口）
 *     @        = 群消息纯文本不渲染 <@id>，只能发 markdown 的 <qqbot-at-user id="..." />
 *                （适配器看到 at 段会自动升级成 markdown，插件侧照常传 segment 即可）
 *
 * 所以这里统一按「多候选 key 回退 + 按适配器分流头像」来处理，
 * 调用方不需要再关心自己跑在哪种后端上。
 */

/** QQBot 适配器的实例前缀分隔符：非 Windows 是 ":"，Windows 是 U+F03A（显示为一个空白） */
const INSTANCE_SEPARATORS = [":", "\uf03a"]

/** 官方 bot 头像允许的尺寸，其余取值一律回退到 100 */
const QQAPP_AVATAR_SIZES = [0, 100, 640]

/** 兜底头像：内联 SVG 灰底人形，避免取不到头像时在 HTML 里出现裂图 */
const FALLBACK_AVATAR = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
    '<rect width="100" height="100" rx="16" fill="#d9d9d9"/>' +
    '<circle cx="50" cy="37" r="17" fill="#ffffff"/>' +
    '<path d="M15 91c0-19 15-29 35-29s35 10 35 29z" fill="#ffffff"/>' +
  '</svg>'
)}`

/**
 * 取当前 bot 实例标识（ICQQ 下是 QQ 号，官方 bot 下是 AppID/uin）
 * @param {Object} e Event
 * @returns {string}
 */
export function getSelfId(e) {
  const value = e?.self_id ?? e?.bot?.uin ?? e?.bot?.info?.id
  return value === undefined || value === null ? "" : String(value)
}

/**
 * 剥掉适配器加的实例前缀
 * `1903614108:036A1865...` → `036A1865...`；ICQQ 的裸 QQ 号原样返回
 * @param {string} selfId 实例标识
 * @param {string} value 原始 id
 * @returns {string}
 */
export function stripInstancePrefix(selfId, value) {
  const id = String(value ?? "")
  const owner = String(selfId ?? "")
  if (!owner) return id
  for (const sep of INSTANCE_SEPARATORS) {
    const prefix = `${owner}${sep}`
    if (id.startsWith(prefix)) return id.slice(prefix.length)
  }
  return id
}

/**
 * 官方 bot 的 AppID；ICQQ / OneBot 下返回空串
 * @param {Object} e Event
 * @returns {string}
 */
export function getOfficialBotAppId(e) {
  const value = e?.bot?.info?.appid ?? e?.bot?.sdk?.config?.appid ?? ""
  return String(value ?? "").trim()
}

/**
 * 是否跑在 QQ 官方机器人适配器上
 * @param {Object} e Event
 * @returns {boolean}
 */
export function isOfficialBot(e) {
  return /^\d{1,20}$/.test(getOfficialBotAppId(e))
}

/**
 * 取当前群的成员 Map（gml），兼容裸群号与带实例前缀的群号
 * @param {Object} e Event
 * @returns {Map|null}
 */
export function getGroupMemberMap(e) {
  const groupId = e?.group_id
  if (groupId === undefined || groupId === null || groupId === "") return null

  const gml = e?.bot?.gml
  if (!gml || typeof gml.get !== "function") return null

  const selfId = getSelfId(e)
  const plainGroupId = stripInstancePrefix(selfId, groupId)
  const keys = new Set([groupId, String(groupId)])
  if (selfId) {
    for (const sep of INSTANCE_SEPARATORS) {
      keys.add(`${selfId}${sep}${plainGroupId}`)
      keys.add(`${selfId}${sep}${groupId}`)
    }
  }

  for (const key of keys) {
    try {
      const map = gml.get(key)
      if (map) return map
    } catch (error) {
      // gml 可能不是 Map（换了适配器），忽略这一种写法继续试
    }
  }
  return null
}

/**
 * 同一个人可能出现的 id 写法，按「运行时原样 → 裸 id → 带实例前缀」排序
 *
 * 课表数据是**按 id 落盘**的（`data/users/{id}.json`），而不同适配器 / 不同版本
 * 落盘的写法不一样：官方 bot 适配器现在写 `1903614108:{openid}`，
 * 但本机历史数据里存在裸 openid（`{openid}.json`）。所以查课表要按候选逐个试。
 *
 * @param {Object} e Event
 * @param {string} userId 目标用户 id
 * @returns {Array<string>}
 */
export function userIdCandidates(e, userId) {
  const raw = String(userId ?? "").trim()
  if (!raw) return []

  const selfId = getSelfId(e)
  const plain = stripInstancePrefix(selfId, raw)
  const ids = [raw]
  if (plain && plain !== raw) ids.push(plain)
  if (selfId && plain) {
    for (const sep of INSTANCE_SEPARATORS) {
      const prefixed = `${selfId}${sep}${plain}`
      if (!ids.includes(prefixed)) ids.push(prefixed)
    }
  }
  return ids
}

/**
 * 成员在各级缓存（Map）里可能出现的 key
 * 就是 userIdCandidates 再加上 ICQQ 用的 Number 写法
 * @param {Object} e Event
 * @param {string} userId 目标用户 id
 * @returns {Array<string|number>}
 */
export function memberKeyCandidates(e, userId) {
  const keys = []
  for (const id of userIdCandidates(e, userId)) {
    keys.push(id)
    if (/^\d+$/.test(id)) keys.push(Number(id))
  }
  return [...new Set(keys)]
}

/**
 * 查成员资料：群成员缓存 → 好友缓存 → （@ 的就是发言人本人时）事件 sender
 * @param {Object} e Event
 * @param {string} userId 目标用户 id
 * @returns {Object|null}
 */
export function resolveMember(e, userId) {
  const keys = memberKeyCandidates(e, userId)
  if (keys.length === 0) return null

  const selfId = getSelfId(e)
  const targetPlain = stripInstancePrefix(selfId, userId)
  const senderPlain = stripInstancePrefix(selfId, e?.sender?.user_id)

  const maps = []
  const groupMembers = getGroupMemberMap(e)
  if (groupMembers) maps.push(groupMembers)
  if (e?.bot?.fl && typeof e.bot.fl.get === "function") maps.push(e.bot.fl)
  // @ 的对象正好是发消息的人时，sender 本身就是最准的资料（官方 bot 的 gml 未必收录了他）
  if (senderPlain && targetPlain && senderPlain === targetPlain && e?.sender) maps.unshift(e.sender)

  for (const map of maps) {
    if (!map) continue
    if (typeof map.get !== "function") return map
    for (const key of keys) {
      try {
        const info = map.get(key)
        if (info) return info
      } catch (error) {
        // 某个 key 在该 Map 上取不到就继续试下一个
      }
    }
  }
  return null
}

function pickName(info) {
  if (!info || typeof info !== "object") return ""
  for (const value of [info.card, info.nickname, info.user_name, info.name]) {
    const name = String(value ?? "").trim()
    if (name) return name
  }
  return ""
}

/**
 * 取显示昵称：群名片 → 昵称 → user_name（官方 bot 1.3.0 只有 user_name）
 * @param {Object} e Event
 * @param {string} userId 目标用户 id
 * @param {{fallback?: string, member?: Object}} [options]
 * @returns {string}
 */
export function resolveUserName(e, userId, options = {}) {
  const name = pickName(options.member ?? resolveMember(e, userId))
  if (name) return name

  const plain = stripInstancePrefix(getSelfId(e), userId)
  if (options.fallback) return options.fallback
  return plain ? `用户${plain}` : "未知用户"
}

/**
 * 取头像直链
 *
 * 官方 bot 走 `q.qlogo.cn/qqapp/{appid}/{openid}/{size}`，这条链不需要任何接口，
 * 也不受群成员接口白名单（错误码 11253）影响；ICQQ 走 QQ 号 qlogo。
 *
 * @param {Object} e Event
 * @param {string} userId 目标用户 id
 * @param {Object|null} [member] 已查到的成员资料，避免重复查缓存
 * @param {number} [size] 期望尺寸，官方 bot 只认 0/100/640
 * @returns {string} 头像直链，取不到时返回内联占位图
 */
export function resolveAvatarUrl(e, userId, member = null, size = 100) {
  const info = member ?? resolveMember(e, userId)
  const own = String(info?.avatar ?? "").trim()

  const selfId = getSelfId(e)
  const plain = stripInstancePrefix(selfId, userId)
  const appId = getOfficialBotAppId(e)

  if (/^\d{1,20}$/.test(appId)) {
    // 官方 bot：openid 不是 QQ 号，只有 qqapp 这一条路
    if (/^[A-Za-z0-9_-]{1,128}$/.test(plain) && !plain.startsWith("qg_")) {
      const qqbotSize = QQAPP_AVATAR_SIZES.includes(size) ? size : 100
      return `https://q.qlogo.cn/qqapp/${appId}/${plain}/${qqbotSize}`
    }
    return own || FALLBACK_AVATAR
  }

  if (own) return own
  if (/^\d+$/.test(plain)) return `https://q1.qlogo.cn/g?b=qq&nk=${plain}&s=${size}`
  return FALLBACK_AVATAR
}

/**
 * 构造 at 段
 *
 * ICQQ 认 `{ type: "at", qq }` 这个形状。
 * 官方 bot 的普通群消息不渲染 `<@id>`，适配器只会把它降级成可见文本「@昵称」，
 * 真 @ 请用 buildMentionMessage（走 markdown）。
 *
 * @param {string} userId 目标用户 id（ICQQ 传 QQ 号，官方 bot 传带前缀的 openid 或裸 openid）
 * @param {string} [name] 可见昵称，取不到时适配器会自行回退
 * @returns {Object|null}
 */
export function buildAtSegment(userId, name = "") {
  const qq = String(userId ?? "").trim()
  if (!qq) return null
  const at = { type: "at", qq }
  const label = String(name ?? "").trim()
  if (label) at.name = label
  return at
}

/**
 * 构造「@某人 + 正文」，按适配器分流
 *
 *   ICQQ / OneBot → `[at 段, 正文]`，客户端渲染成原生 @
 *   QQ 官方机器人 → markdown 段，正文里用 `<qqbot-at-user id="openid" />`
 *
 * 为什么官方 bot 不能只传 at 段：
 * QQBot 适配器在默认的 `sendMode: auto` 下，只有消息里出现 markdown / button / keyboard
 * 段才会走 markdown 构建器；纯 at 段会被 makeMsg 降级成可见文本「@昵称」（没有提醒效果），
 * 真 @ 只认 markdown 里的 `<qqbot-at-user>`。所以这里显式带一个 markdown 段。
 *
 * 已知降级：若该账号把 `markdown` 配成 `legacy`，适配器会整条退回普通消息，
 * 标签被剥掉、只剩可见文本——消息仍然送达，只是没有真 @。
 * 若平台直接拒收 markdown（无权限 / 审核），适配器会自己剥成纯文本重发，不会整条失败。
 *
 * @param {Object} e Event
 * @param {string} userId 目标用户 id
 * @param {string} userName 目标昵称，作为无 markdown 时的可见兜底
 * @param {string} text 正文（不含 @ 部分）
 * @returns {Array|string} 可直接交给 e.reply 的消息体
 */
export function buildMentionMessage(e, userId, userName, text) {
  const body = String(text ?? "")

  if (isOfficialBot(e)) {
    const openid = stripInstancePrefix(getSelfId(e), userId)
    if (/^[A-Za-z0-9_-]{1,128}$/.test(openid) && !openid.startsWith("qg_")) {
      return [{ type: "markdown", data: { content: `<qqbot-at-user id="${openid}" />${body}` } }]
    }
  }

  const atSegment = buildAtSegment(userId, userName)
  return atSegment ? [atSegment, body] : `${userName}${body}`
}


/**
 * 判断某个 at 目标是不是机器人自己或 @全体成员
 * 这两种都不该当作「被查询课表的群友」
 * @param {Object} e Event
 * @param {string} targetId at 段里的 qq
 * @returns {boolean}
 */
export function isBotSelfOrAll(e, targetId) {
  const raw = String(targetId ?? "").trim()
  if (!raw) return true
  if (raw === "all" || raw === "everyone") return true

  const selfId = getSelfId(e)
  if (!selfId) return false

  // @机器人自己时，适配器写的是裸 self_id；带实例前缀的是 member_openid，那一定不是机器人
  return stripInstancePrefix(selfId, raw) === selfId
}
