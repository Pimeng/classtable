import plugin from "../../../lib/plugins/plugin.js"
import { getSkipClassCacheKey } from "../utils/cache.js"
import { findNextClass } from "../utils/renderNextClass.js"
import { parseTimeString } from "../utils/time.js"
import config from "../utils/config.js"
import {
  hasUserSchedule,
  loadUserScheduleData,
  normalizeScheduleData,
  calculateWeekByStartDate
} from "../utils/scheduleStorage.js"

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
    const atMessages = e.message.filter(m => m.type === 'at')
    if (atMessages.length === 0) {
      return false
    }
    for (const atMsg of atMessages) {
      const atUserId = atMsg.qq
      await this.checkUserInClassAndReply(e, atUserId)
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
      if (!hasUserSchedule(userId)) return

      const currentTime = new Date()
      const currentDay = currentTime.getDay() === 0 ? 7 : currentTime.getDay()
      const currentHour = currentTime.getHours()
      const currentMinute = currentTime.getMinutes()

      const scheduleData = loadUserScheduleData(userId, { useCache: true })
      if (!scheduleData) return
      const { schedule, startDate } = normalizeScheduleData(scheduleData)
      const currentWeek = calculateWeekByStartDate(currentTime, startDate)

      // 查找当前正在上的课程
      const nextClassInfo = findNextClass(schedule, currentWeek, currentDay, currentHour, currentMinute)

      // 检查是否已经提醒过了
      const remindKey = `classtable:isreminded:${userId}`
      if (await redis.get(remindKey)) {
        return // 已经提醒过，跳过
      }

      if (nextClassInfo && nextClassInfo.status === 'ongoing') {
        const skipKey = getSkipClassCacheKey(userId)
        let isSkippingClass = false
        try {
          isSkippingClass = !!(await redis.get(skipKey))
        } catch (error) {
          logger.error(`[ClassTable] 检查翘课状态失败: ${error}`)
        }
        if (!isSkippingClass) {
          let userName = `用户${userId}`
          try {
            const memberInfo = e.bot.gml.get(e.group_id)
            const member = memberInfo.get(Number(userId))
            userName = member?.card || member?.nickname || `用户${userId}`
          } catch (err) {
            userName = `用户${userId}`
          }

          const message = ` ${userName} 正在上《${nextClassInfo.courseName}》课哦，预计于${nextClassInfo.endTime}下课，请耐心等待一下吧~`
          await e.reply(message, true)
          
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
        }
      }
    } catch (error) {
      logger.error(`[ClassTable] 检查用户上课状态失败: ${error}`)
    }
  }
}
