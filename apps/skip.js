import plugin from "../../../lib/plugins/plugin.js"
import {
  getSkipClassCacheKey
} from "../utils/cache.js"
import { isInClassTime, findConsecutiveClasses, parseTimeString } from "../utils/time.js"
import {
  hasUserSchedule,
  loadUserScheduleData,
  normalizeScheduleData,
  calculateWeekByStartDate
} from "../utils/scheduleStorage.js"

export class classtableSkip extends plugin {
  constructor() {
    super({
      name: 'classtable:翘课',
      dsc: '翘课/取消翘课功能',
      event: 'message',
      priority: 10,
      rule: [
        {
          reg: '^什么.*课(，)?翘了(！)?$',
          fnc: 'skipClass'
        },
        {
          reg: '^#?clsskip$',
          fnc: 'skipClass'
        },
        {
          reg: '^翘了！$',
          fnc: 'skipClass'
        },
        {
          reg: '^哎不翘了(还是)?$',
          fnc: 'cancelSkipClass'
        },
        {
          reg: '^#?clscancel$',
          fnc: 'cancelSkipClass'
        }
      ]
    })
  }

  async skipClass(e) {
    try {
      const userId = e.user_id

      // 获取用户当前课程信息
      if (!hasUserSchedule(userId)) {
        await e.reply("你还没有导入课表，不知道你要翘什么课哦")
        return
      }

      const scheduleData = loadUserScheduleData(userId, { useCache: true })
      if (!scheduleData) {
        await e.reply("你还没有导入课表，不知道你要翘什么课哦")
        return
      }
      const { schedule, startDate } = normalizeScheduleData(scheduleData)

      // 获取当前时间
      const currentTime = new Date()
      const currentDay = currentTime.getDay() === 0 ? 7 : currentTime.getDay()
      const currentHour = currentTime.getHours()
      const currentMinute = currentTime.getMinutes()

      // 获取当前周次
      const currentWeek = calculateWeekByStartDate(currentTime, startDate)

      // 查找当前课程或下一节课（最近1小时内有课程）
      let currentClass = null
      let isNextClass = false

      // 首先查找当前正在进行的课程
      if (schedule[currentWeek] && schedule[currentWeek][currentDay]) {
        const todayClasses = []
        for (const [node, classes] of Object.entries(schedule[currentWeek][currentDay])) {
          for (const cls of classes) {
            todayClasses.push({
              ...cls,
              node: parseInt(node)
            })
          }
        }

        // 按节点排序
        todayClasses.sort((a, b) => a.node - b.node)

        // 查找当前正在上的课程
        for (let i = 0; i < todayClasses.length; i++) {
          const cls = todayClasses[i]
          if (isInClassTime(cls.startTime, cls.endTime, currentHour, currentMinute)) {
            // 找到了当前正在上的课程，检查是否有连续的相同课程
            const consecutiveResult = findConsecutiveClasses(todayClasses, i)
            currentClass = {
              ...consecutiveResult.finalClass,
              startTime: consecutiveResult.startTime,
              endTime: consecutiveResult.finalEndTime
            }
            break
          }
        }
      }

      // 如果没有当前课程，查找最近1小时内的下一节课
      if (!currentClass) {
        const oneHourLater = new Date(currentTime.getTime() + 12 * 60 * 60 * 1000)

        if (schedule[currentWeek] && schedule[currentWeek][currentDay]) {
          const todayClasses = []
          for (const [node, classes] of Object.entries(schedule[currentWeek][currentDay])) {
            for (const cls of classes) {
              const [startHour, startMinute] = cls.startTime.split(':').map(Number)
              todayClasses.push({
                ...cls,
                node: parseInt(node),
                startHour,
                startMinute,
                startMinutes: startHour * 60 + startMinute
              })
            }
          }

          todayClasses.sort((a, b) => a.node - b.node)

          // 查找最近1小时内的课程
          for (let i = 0; i < todayClasses.length; i++) {
            const cls = todayClasses[i]
            const { hour: startHour, minute: startMinute } = parseTimeString(cls.startTime)
            const classTime = new Date(currentTime)
            classTime.setHours(startHour, startMinute, 0, 0)

            // 如果课程开始时间在当前时间和1小时后之间
            if (classTime > currentTime && classTime <= oneHourLater) {
              // 找到了下一节课，检查是否有连续的相同课程
              const consecutiveResult = findConsecutiveClasses(todayClasses, i)
              currentClass = {
                ...consecutiveResult.finalClass,
                startTime: consecutiveResult.startTime,
                endTime: consecutiveResult.finalEndTime
              }
              isNextClass = true
              break
            }
          }
        }
      }

      if (!currentClass) {
        return await e.reply("没课翘不了（")
      }

      // 计算课程结束时间
      const { hour: endHour, minute: endMinute } = parseTimeString(currentClass.endTime)
      const endTime = new Date()
      endTime.setHours(endHour, endMinute, 0, 0)

      // 如果结束时间已过，不执行
      if (endTime <= currentTime) {
        return
      }      
      const expireTime = Math.floor((endTime - currentTime) / 1000)
      const skipKey = getSkipClassCacheKey(userId)

      const hasSkip = await redis.get(skipKey)
      if (hasSkip) {
        await e.reply("你已经翘过了")
        return
      }

      await redis.set(skipKey, "1", { EX: expireTime })

      const classType = isNextClass ? "下一节课" : "当前课程"
      await e.reply(`已标记翘课${classType}《${currentClass.courseName}》！翘课状态将持续到${currentClass.endTime}qwq`)

    } catch (error) {
      logger.error(`[ClassTable] 翘课功能失败: ${error}`)
      await e.reply("翘课失败，请稍后再试")
    }
  }

  async cancelSkipClass(e) {
    try {
      const userId = e.user_id
      const skipKey = getSkipClassCacheKey(userId)
      const skipStatus = await redis.get(skipKey)
      if (!skipStatus) {
        await e.reply("你还没发起翘课哦")
        return
      }
      await redis.del(skipKey)
      await e.reply("已为你取消翘课状态~")
    } catch (error) {
      logger.error(`[ClassTable] 取消翘课功能失败: ${error}`)
      await e.reply("取消翘课失败，请稍后再试")
    }
  }
}
