import plugin from "../../../lib/plugins/plugin.js"
import { getSkipClassCacheKey } from "../utils/cache.js"
import { findNextClass } from "../utils/renderNextClass.js"
import { parseTimeString } from "../utils/time.js"
import config from "../utils/config.js"
import {
  buildMentionMessage,
  isBotSelfOrAll,
  resolveMember,
  resolveUserName,
  userIdCandidates
} from "../utils/identity.js"
import {
  loadUserScheduleData,
  normalizeScheduleData,
  calculateWeekByStartDate,
  resolveStoredUserId
} from "../utils/scheduleStorage.js"

/**
 * 排查用留痕：只在有人被 @ 时触发，不会刷屏。
 * 默认关闭（config.AT_REMIND_DEBUG）——不同适配器的 @ 形态差异很大，出问题时要能看到走到了哪一步。
 */
function traceAt(e, userId, detail) {
  if (!config.AT_REMIND_DEBUG) return
  const group = e.group_id ?? ""
  const sender = e.sender?.user_id ?? e.user_id ?? ""
  logger.mark(`[ClassTable][@检查] 群=${group} 发送=${sender} at=${userId} → ${detail}`)
}

function pad2(value) {
  return String(value).padStart(2, "0")
}

/**
 * QQ 官方 bot 的 @ **不会**出现在 message 段里：
 * 整条消息只有 @ 时，适配器给出的 `e.message` 直接是空数组（实测 `"segments": []`），
 * 既没有 at 段也没有 text，被 @ 的人只在适配器透传的原始事件里（events.js 里 `raw: event`）。
 */
function collectMentionTargets(e) {
  const targets = []

  const mentions = e?.raw?.mentions ?? e?.mentions
  if (Array.isArray(mentions)) {
    for (const mention of mentions) {
      if (!mention || typeof mention !== "object") continue
      // @ 的是机器人自己，不用查课表
      if (mention.is_you === true || mention.is_you === "true") continue
      const id = mention.user_openid ?? mention.openid ?? mention.member_openid ?? mention.id ?? mention.user_id
      if (id) targets.push(String(id))
    }
  }

  // 兜底：官方 API 的正文里会留 <@!openid> 占位符
  for (const match of String(e?.raw_message || "").matchAll(/<@!?([A-Za-z0-9_-]{8,64})>/g)) {
    targets.push(match[1])
  }

  return targets
}

export class classtableCheck extends plugin {
  constructor() {
    super({
      name: 'classtable:@检查',
      dsc: '@用户检查上课状态',
      event: 'message',
      priority: 10,
      rule: [
        {
          reg: '',
          fnc: 'checkAtUserClassStatus',
          log: false
        }
      ]
    })
  }

  /**
   * 检查@用户是否正在上课
   * @param {Object} e
   */
  async checkAtUserClassStatus(e) {
    if (!e.isGroup) return false
    if (!config.AT_REMIND) return false

    const atMessages = (Array.isArray(e.message) ? e.message : []).filter(m => m.type === 'at')
    const targets = []

    for (const atMsg of atMessages) {
      // ICQQ 的 at 段是 QQ 号；官方 bot 的 at 段同样叫 qq，但适配器已经把实例前缀剥掉了
      const atUserId = atMsg.qq ?? atMsg.user_id ?? atMsg.id
      // @全体成员 / @机器人自己 不可能是「有课表的群友」，直接跳过
      if (isBotSelfOrAll(e, atUserId)) {
        if (!atUserId) {
          traceAt(e, "(空)", `at 段没有可用 id，原始段=${JSON.stringify(atMsg)}`)
        }
        continue
      }
      targets.push(String(atUserId))
    }

    for (const mentionId of collectMentionTargets(e)) {
      if (isBotSelfOrAll(e, mentionId)) continue
      if (!targets.includes(mentionId)) targets.push(mentionId)
    }

    if (targets.length === 0) {
      // 空消息 = 大概率是「只发了一个 @」，把信封原样留下，否则这类消息完全无迹可寻
      if (!Array.isArray(e.message) || e.message.length === 0) {
        traceAt(
          e,
          "(空消息)",
          `raw_message=${JSON.stringify(e.raw_message)} mentions=${JSON.stringify(e?.raw?.mentions ?? e?.mentions)} rawKeys=${JSON.stringify(Object.keys(e?.raw || {}))}`
        )
      }
      return false
    }

    for (const target of targets) {
      await this.checkUserInClassAndReply(e, target)
    }
    return false
  }

  /**
   * 检查用户是否正在上课并回复
   * @param {Object} e
   * @param {string} userId - 被检查的用户ID
   */
  async checkUserInClassAndReply(e, userId) {
    try {
      // 课表是按 id 落盘的，而同一个人的 id 写法在不同适配器/历史数据里可能是
      // `{self_id}:{openid}` 或裸 openid（本机数据里两种都存在），所以按候选逐个试。
      // 用命中的那个 id 去读课表和读写缓存，保证同一个人只对应一份数据。
      const candidates = userIdCandidates(e, userId)
      const storedUserId = resolveStoredUserId(userId, candidates)
      if (!storedUserId) {
        traceAt(e, userId, `找不到课表文件（试过 ${JSON.stringify(candidates)}）`)
        return
      }

      const currentTime = new Date()
      const currentDay = currentTime.getDay() === 0 ? 7 : currentTime.getDay()
      const currentHour = currentTime.getHours()
      const currentMinute = currentTime.getMinutes()

      const scheduleData = loadUserScheduleData(storedUserId, { useCache: true })
      if (!scheduleData) {
        traceAt(e, userId, "课表内容读不出来")
        return
      }
      const { schedule, startDate } = normalizeScheduleData(scheduleData)
      const currentWeek = calculateWeekByStartDate(currentTime, startDate)

      // 查找当前正在上的课程
      const nextClassInfo = findNextClass(schedule, currentWeek, currentDay, currentHour, currentMinute)

      // 检查是否已经提醒过了
      const remindKey = `classtable:isreminded:${storedUserId}`
      if (await redis.get(remindKey)) {
        traceAt(e, userId, `storedUserId=${storedUserId} 本周本节已提醒过，跳过`)
        return // 已经提醒过，跳过
      }

      if (nextClassInfo && nextClassInfo.status === 'ongoing') {
        const skipKey = getSkipClassCacheKey(storedUserId)
        let isSkippingClass = false
        try {
          isSkippingClass = !!(await redis.get(skipKey))
        } catch (error) {
          logger.error(`[ClassTable] 检查翘课状态失败: ${error}`)
        }
        if (!isSkippingClass) {
          // 昵称走兼容层：ICQQ 是 card/nickname，官方 bot 是 user_name；
          // gml 的 key 在两种后端下形态不同（Number vs `{self_id}:{openid}`），由兼容层多候选回退
          const member = resolveMember(e, userId)
          const userName = resolveUserName(e, userId, { member })

          const text = ` 正在上《${nextClassInfo.courseName}》课哦，预计于${nextClassInfo.endTime}下课，请耐心等待一下吧~`
          // 真 @ 而不是纯文本 "@昵称"：
          //   ICQQ      → [at 段, 正文]，客户端渲染成原生 @，对方能收到提醒
          //   官方 bot  → 普通群消息不渲染 <@id>，改成 markdown 段 + <qqbot-at-user id="openid" />
          const message = buildMentionMessage(e, userId, userName, text)
          // quote=true 对 ICQQ 是引用回复；官方 bot 适配器不看这个参数，
          // 它按事件里的 message_id 自己判定被动回复（被动窗口内发送才不会被拒）
          await e.reply(message, true)
          traceAt(
            e,
            userId,
            `已提醒 storedUserId=${storedUserId} 第${currentWeek}周 周${currentDay} 《${nextClassInfo.courseName}》${nextClassInfo.startTime}-${nextClassInfo.endTime}`
          )

          // 计算当前时间和下课时间差（确保使用整数秒）
          try {
            const { hour: endHour, minute: endMinute } = parseTimeString(nextClassInfo.endTime)
            const endDate = new Date(currentTime)
            endDate.setHours(endHour, endMinute, 0, 0)

            const timeLeftMs = endDate - currentTime
            if (Number.isFinite(timeLeftMs) && timeLeftMs > 0) {
              const ttlSeconds = Math.max(1, Math.ceil(timeLeftMs / 1000))
              // cd（确保传给 redis 的是整数秒）
              await redis.set(remindKey, '1', { EX: ttlSeconds })
            } else {
              logger.warn(`[ClassTable] 下课时间无效或已过: endTime=${nextClassInfo.endTime}`)
            }
          } catch (err) {
            logger.error(`[ClassTable] 计算下课剩余时间失败: ${err}`)
          }
        } else {
          traceAt(e, userId, `正在翘课中，跳过（storedUserId=${storedUserId}）`)
        }
      } else {
        traceAt(
          e,
          userId,
          `storedUserId=${storedUserId} 第${currentWeek}周 周${currentDay} ${pad2(currentHour)}:${pad2(currentMinute)} 当前没在上课（status=${nextClassInfo?.status || "none"}），不提醒`
        )
      }
    } catch (error) {
      logger.error(`[ClassTable] 检查用户上课状态失败: ${error}`)
    }
  }
}
